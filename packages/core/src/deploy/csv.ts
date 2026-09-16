// CSV helper shared by the HTML + CSV deliverables (stream T7, DECISIONS-v2-2 F5).
// RFC 4180 quoting (fields with comma, quote, CR/LF or surrounding whitespace are double-quoted, quotes doubled).
// `toCsv` keeps the contract output ('\n' line ends, no BOM); files written for people use `csvFile`, which adds a
// UTF-8 BOM so Excel opens Korean text correctly and uses CRLF line ends (RFC 4180 §2.1).

function cell(v: unknown): string {
  if (v === undefined || v === null) return '';
  const s = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Rows → CSV text (header line + one line per row, CRLF-free `\n` line ends, trailing newline).
 * `columns` fixes the column order; absent = union of row keys in first-seen order.
 */
export function toCsv(rows: Record<string, unknown>[], columns?: string[]): string {
  const cols = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const lines = [cols.map(cell).join(',')];
  for (const r of rows) lines.push(cols.map((c) => cell(r[c])).join(','));
  return lines.join('\n') + '\n';
}

/** UTF-8 byte-order mark prepended to CSV files meant for spreadsheets. */
export const CSV_BOM = '﻿';

/** CSV file content for download / zip: BOM + CRLF line ends + fixed column order. */
export function csvFile(rows: Record<string, unknown>[], columns: string[]): string {
  const lines = [columns.map(cell).join(',')];
  for (const r of rows) lines.push(columns.map((c) => cell(r[c])).join(','));
  return CSV_BOM + lines.join('\r\n') + '\r\n';
}

/** Existing `\n`-terminated CSV text → file content (BOM + CRLF record separators; quoted line breaks untouched). */
export function asCsvFile(csv: string): string {
  const src = csv.startsWith(CSV_BOM) ? csv.slice(1) : csv;
  let out = '';
  let quoted = false;
  for (const ch of src) {
    if (ch === '"') quoted = !quoted;
    out += ch === '\n' && !quoted ? '\r\n' : ch;
  }
  return CSV_BOM + out;
}

/** Parse RFC 4180 text back into rows of fields (used by tests and the QA scripts; strips a leading BOM). */
export function parseCsv(text: string): string[][] {
  const src = text.startsWith(CSV_BOM) ? text.slice(1) : text;
  const out: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field); out.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); out.push(row); }
  return out;
}
