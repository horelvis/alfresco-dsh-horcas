/**
 * Master Reviewer LLM (E20): revisa artefactos (assessment, plan, coherencia, estado) y emite un
 * veredicto estructurado. NO ejecuta cambios. Los datos se anonimizan antes de salir al LLM y, si el
 * LLM falla o responde algo no parseable, el veredicto es ABSTAIN (fail-open a "no opino", nunca a "apruebo").
 *
 */
import { createHash } from 'node:crypto';
import { anonymizerFor, policyFromEnv, type AnonymizationPolicy } from './privacy.js';

export type ReviewVerdict = 'APPROVE' | 'APPROVE_WITH_CONDITIONS' | 'REJECT' | 'ABSTAIN';
export type ReviewSeverity = 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type ReviewStage = 'PLAN' | 'COHERENCE' | 'ASSESSMENT' | 'STATUS';

export interface ReviewRequest {
  stage: ReviewStage;
  project: string;
  artifacts: Record<string, string>;
  questions?: string[];
}

export interface ReviewFinding {
  id: string;
  severity: ReviewSeverity;
  title: string;
  detail: string;
  recommendation: string;
  evidenceRef?: string;
}

export interface ReviewReport {
  stage: ReviewStage;
  verdict: ReviewVerdict;
  confidence: number;
  summary: string;
  findings: ReviewFinding[];
  conditions: string[];
  model: string;
  at: string;
  inputHash: string;
}

/** Cliente LLM: recibe system+user y devuelve texto. */
export type LlmClient = (system: string, user: string) => Promise<string>;

export interface ReviewerOptions {
  client?: LlmClient;
  model?: string;
  policy?: AnonymizationPolicy;
  knownSensitiveValues?: string[];
}

const SYSTEM = `Eres el "Master Reviewer" de migraciones de Alfresco Content Services a la familia 26.x.
Revisas artefactos (assessment, plan de upgrade, estrategias, coherencia DB<->content store, informes de estado) y emites un veredicto experto. NO ejecutas cambios: solo analizas y recomiendas.

Criterios que debes vigilar:
- Ruta de upgrade soportada por el fabricante y saltos intermedios obligatorios.
- Los indices se REGENERAN, nunca se migran.
- Coherencia DB<->content store: referencias colgantes (dangling) son bloqueantes.
- Breaking changes: Java 21 + Tomcat 11, ActiveMQ con autenticacion, eventos v1 deshabilitados, ausencia de Solr (regenerar con Search Enterprise).
- Riesgos de ventana de corte (schema upgrade, auditoria elevada) y estrategia por volumen/peso.

Responde SIEMPRE y SOLO con un objeto JSON valido con este esquema exacto:
{"verdict":"APPROVE|APPROVE_WITH_CONDITIONS|REJECT|ABSTAIN",
 "confidence":0.0,
 "summary":"resumen ejecutivo",
 "findings":[{"id":"F1","severity":"INFO|LOW|MEDIUM|HIGH|CRITICAL","title":"...","detail":"...","recommendation":"...","evidenceRef":"..."}],
 "conditions":["condicion a cumplir"]}
No incluyas texto, markdown ni comentarios fuera del JSON.`;

export function buildUserPrompt(request: ReviewRequest): string {
  const parts: string[] = [`Etapa de revision: ${request.stage}`, `Proyecto: ${request.project}`, ''];
  for (const [name, content] of Object.entries(request.artifacts)) {
    parts.push(`### ${name}`, content, '');
  }
  if (request.questions?.length) {
    parts.push('Preguntas a responder:');
    for (const question of request.questions) parts.push(`- ${question}`);
  }
  return parts.join('\n');
}

function extractJson(raw: string | undefined): string {
  let text = (raw ?? '').trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

const asVerdict = (value: string): ReviewVerdict =>
  (['APPROVE', 'APPROVE_WITH_CONDITIONS', 'REJECT', 'ABSTAIN'] as const).includes(value.trim().toUpperCase() as ReviewVerdict)
    ? (value.trim().toUpperCase() as ReviewVerdict)
    : 'ABSTAIN';

const asSeverity = (value: string): ReviewSeverity =>
  (['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const).includes(value.trim().toUpperCase() as ReviewSeverity)
    ? (value.trim().toUpperCase() as ReviewSeverity)
    : 'MEDIUM';

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

export async function review(request: ReviewRequest, options: ReviewerOptions = {}): Promise<ReviewReport> {
  const model = options.model ?? process.env.MIGRATOR_AI_MODEL ?? 'llm';
  const system = SYSTEM;
  const user = buildUserPrompt(request);
  const inputHash = hash(`${system}\n${user}`);
  const at = new Date().toISOString();

  if (!options.client) {
    return { stage: request.stage, verdict: 'ABSTAIN', confidence: 0, summary: 'Sin cliente LLM configurado', findings: [], conditions: [], model, at, inputHash };
  }

  const policy = options.policy ?? policyFromEnv();
  const anonymizer = anonymizerFor(policy, options.knownSensitiveValues ?? []);
  const safeSystem = anonymizer.anonymize(system) ?? system;
  const safeUser = anonymizer.anonymize(user) ?? user;

  let raw: string;
  try {
    raw = await options.client(safeSystem, safeUser);
  } catch (error) {
    return { stage: request.stage, verdict: 'ABSTAIN', confidence: 0, summary: `LLM no disponible: ${String(error)}`, findings: [], conditions: [], model, at, inputHash };
  }

  try {
    const parsed = JSON.parse(extractJson(raw)) as {
      verdict?: string;
      confidence?: number;
      summary?: string;
      findings?: Array<{ id?: string; severity?: string; title?: string; detail?: string; recommendation?: string; evidenceRef?: string }>;
      conditions?: string[];
    };
    const findings: ReviewFinding[] = (parsed.findings ?? []).map((f) => ({
      id: f.id ?? 'F',
      severity: asSeverity(f.severity ?? ''),
      title: f.title ?? '',
      detail: f.detail ?? '',
      recommendation: f.recommendation ?? '',
      evidenceRef: f.evidenceRef,
    }));
    return {
      stage: request.stage,
      verdict: asVerdict(parsed.verdict ?? ''),
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
      summary: parsed.summary ?? '',
      findings,
      conditions: parsed.conditions ?? [],
      model,
      at,
      inputHash,
    };
  } catch {
    return { stage: request.stage, verdict: 'ABSTAIN', confidence: 0, summary: 'Respuesta del LLM no parseable', findings: [], conditions: [], model, at, inputHash };
  }
}

/** Cliente LLM compatible OpenAI (chat/completions). */
export function openAiCompatibleClient(baseUrl: string, apiKey: string, model: string, extraHeaders: Record<string, string> = {}): LlmClient {
  return async (system, user) => {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, ...extraHeaders },
      body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return body.choices?.[0]?.message?.content ?? '';
  };
}
