/**
 * Anonimizacion reversible hacia el LLM (portado de migrator-ai/privacy).
 *
 * Tokenizacion determinista: el mismo valor produce siempre el mismo token, de modo que el LLM puede
 * razonar con coherencia sin ver el dato original. El mapeo token->original se queda SIEMPRE en local.
 * Politicas: OFF | SECRETS_ONLY | STANDARD | STRICT (fail-closed si queda PII residual).
 */

export type AnonymizationPolicy = 'OFF' | 'SECRETS_ONLY' | 'STANDARD' | 'STRICT';

export interface Detector {
  category: string;
  pattern: RegExp;
  /** Grupo de captura a reemplazar (0 = toda la coincidencia). */
  group: number;
}

export const SECRETS_ONLY: Detector[] = [
  { category: 'PRIVATE_KEY', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, group: 0 },
  { category: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, group: 0 },
  { category: 'AWS_KEY', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, group: 0 },
  { category: 'BEARER', pattern: /\bBearer\s+([A-Za-z0-9._~+/-]{16,}=*)/gi, group: 1 },
  { category: 'URL_CREDENTIALS', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:([^/\s@]+)@/gi, group: 1 },
  {
    category: 'SECRET_ASSIGNMENT',
    pattern: /\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)\b\s*[:=]\s*["']?([^\s"';&,]{4,})/gi,
    group: 1,
  },
];

export const STANDARD: Detector[] = [
  ...SECRETS_ONLY,
  { category: 'JDBC', pattern: /\bjdbc:[^\s"']+/g, group: 0 },
  { category: 'NODEREF', pattern: /\b(?:workspace|store|archive|version):\/\/[^\s"']+/g, group: 0 },
  { category: 'URL', pattern: /\bhttps?:\/\/[^\s"']+/g, group: 0 },
  { category: 'EMAIL', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, group: 0 },
  { category: 'UUID', pattern: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, group: 0 },
  { category: 'IP', pattern: /\b\d{1,3}(?:\.\d{1,3}){3}\b/g, group: 0 },
];

export function detectorsFor(policy: AnonymizationPolicy): Detector[] {
  switch (policy) {
    case 'STANDARD':
    case 'STRICT':
      return STANDARD;
    case 'SECRETS_ONLY':
      return SECRETS_ONLY;
    case 'OFF':
    default:
      return [];
  }
}

export class Anonymizer {
  private readonly knownValues: string[] = [];
  private readonly originalToToken = new Map<string, string>();
  private readonly tokenToOriginal = new Map<string, string>();
  private readonly counters = new Map<string, number>();
  private readonly detectors: Detector[];

  constructor(knownSensitiveValues: string[] = [], detectors: Detector[] = STANDARD) {
    this.detectors = detectors;
    for (const value of knownSensitiveValues) {
      if (value && value.trim().length >= 3 && !this.knownValues.includes(value)) {
        this.knownValues.push(value);
      }
    }
  }

  anonymize(text: string | undefined): string | undefined {
    if (!text) return text;
    let result = text;
    for (const known of this.knownValues) {
      if (result.includes(known)) {
        result = result.split(known).join(this.tokenFor('KNOWN', known));
      }
    }
    for (const detector of this.detectors) {
      result = this.replaceGroup(result, detector);
    }
    return result;
  }

  deAnonymize(text: string | undefined): string | undefined {
    if (text === undefined) return text;
    let result = text;
    for (const [token, original] of this.tokenToOriginal) {
      result = result.split(token).join(original);
    }
    return result;
  }

  mapping(): Record<string, string> {
    return Object.fromEntries(this.tokenToOriginal);
  }

  private replaceGroup(text: string, detector: Detector): string {
    // Reset del lastIndex para regex globales reutilizadas.
    detector.pattern.lastIndex = 0;
    return text.replace(detector.pattern, (...args) => {
      const match = args[0] as string;
      if (detector.group === 0) {
        return this.tokenFor(detector.category, match) as string;
      }
      const captured = args[detector.group] as string | undefined;
      if (!captured) return match;
      return match.replace(captured, this.tokenFor(detector.category, captured) as string);
    });
  }

  private tokenFor(category: string, value: string): string {
    const existing = this.originalToToken.get(value);
    if (existing) return existing;
    const index = (this.counters.get(category) ?? 0) + 1;
    this.counters.set(category, index);
    const token = `<${category}_${index}>`;
    this.originalToToken.set(value, token);
    this.tokenToOriginal.set(token, value);
    return token;
  }
}

/** Escanea PII residual tras anonimizar (fail-closed). Devuelve categorias, no los valores. */
export class ResidualPiiScanner {
  constructor(private readonly detectors: Detector[] = STANDARD) {}

  scan(text: string | undefined): string[] {
    if (!text) return [];
    const categories: string[] = [];
    for (const detector of this.detectors) {
      detector.pattern.lastIndex = 0;
      if (detector.pattern.test(text)) categories.push(detector.category);
    }
    return categories;
  }

  isClean(text: string | undefined): boolean {
    return this.scan(text).length === 0;
  }
}

export function anonymizerFor(policy: AnonymizationPolicy, knownSensitiveValues: string[] = []): Anonymizer {
  return new Anonymizer(knownSensitiveValues, detectorsFor(policy));
}

export function policyFromEnv(env: NodeJS.ProcessEnv = process.env): AnonymizationPolicy {
  const value = (env.MIGRATOR_ANONYMIZATION ?? 'SECRETS_ONLY').toUpperCase();
  return (['OFF', 'SECRETS_ONLY', 'STANDARD', 'STRICT'] as const).includes(value as AnonymizationPolicy)
    ? (value as AnonymizationPolicy)
    : 'SECRETS_ONLY';
}
