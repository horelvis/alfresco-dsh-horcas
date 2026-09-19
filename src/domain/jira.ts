/**
 * Export a CSV importable por el importador nativo de Jira (UTF-8, RFC 4180).
 * Portado de JiraCsvExporter: epica + issues enlazadas. No depende de Jira.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const HEADERS = ['Summary', 'Issue Type', 'Epic Name', 'Priority', 'Labels', 'Description', 'Epic Link'] as const;

export interface JiraRow {
  summary: string;
  issueType: string;
  epicName: string;
  priority: string;
  labels: string;
  description: string;
  epicLink: string;
}

export function epic(summary: string, labels: string, description: string): JiraRow {
  return { summary, issueType: 'Epic', epicName: summary, priority: 'High', labels, description, epicLink: '' };
}

export function issue(
  summary: string,
  issueType: string,
  priority: string,
  labels: string,
  description: string,
  epicLink: string,
): JiraRow {
  return { summary, issueType, epicName: '', priority, labels, description, epicLink };
}

/** Comillas y escapado RFC 4180. */
export function escapeCsv(value: string | undefined): string {
  const text = value ?? '';
  const needsQuotes = text.includes(',') || text.includes('"') || text.includes('\n') || text.includes('\r');
  return needsQuotes ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(rows: JiraRow[]): string {
  const lines = [HEADERS.join(',')];
  for (const row of rows) {
    lines.push(
      [row.summary, row.issueType, row.epicName, row.priority, row.labels, row.description, row.epicLink]
        .map(escapeCsv)
        .join(','),
    );
  }
  return lines.join('\n') + '\n';
}

export async function writeCsv(file: string, rows: JiraRow[]): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, toCsv(rows), 'utf8');
  return file;
}
