// UI i18n guard (I18N sweep B): no Hangul literal may remain in apps/web/src/**/*.{ts,tsx} outside i18n/locales.
// fix v2 2차 (QA): .ts files are scanned too — store toasts and format helpers showed Korean in the EN UI.
// User-visible Korean belongs in locales/ko/<ns>.ts behind t('<ns>.…') (docs/research/i18n-guide.md §5–6).
//
// Ignored: comments (// … and /* … */, including JSX {/* … */}), because they are never rendered.
// Allow-list (use sparingly, e.g. a language endonym such as '한국어' that is shown in its own script in every locale):
//   - a line containing `i18n-allow`             → that line is skipped
//   - a line containing `i18n-allow-next-line`   → the following line is skipped
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB_SRC = resolve(import.meta.dirname, '../../web/src');
const LOCALES = join(WEB_SRC, 'i18n', 'locales');
const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힣]/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (p === LOCALES || name === 'node_modules') continue;
      walk(p, out);
    } else if ((name.endsWith('.tsx') || name.endsWith('.ts')) && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/**
 * Blank out comments while keeping line numbers. Heuristic, not a parser: `/*` only opens a comment at the start of a
 * line or after whitespace / `{ ( , ;` (so `accept="image/*"` is not a comment), and `//` only after start or whitespace
 * (so `'http://…'` is not a comment).
 */
export function stripComments(src: string): string {
  const blanked = src.replace(/(^|[\s{(,;])\/\*[\s\S]*?\*\//g, (m, lead: string) => lead + m.slice(lead.length).replace(/[^\n]/g, ' '));
  return blanked
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');
}

export function hangulLines(src: string): { line: number; text: string }[] {
  const raw = src.split('\n');
  const code = stripComments(src).split('\n');
  const hits: { line: number; text: string }[] = [];
  code.forEach((line, i) => {
    if (!HANGUL.test(line)) return;
    if (raw[i].includes('i18n-allow') || (i > 0 && raw[i - 1].includes('i18n-allow-next-line'))) return;
    hits.push({ line: i + 1, text: raw[i].trim().slice(0, 120) });
  });
  return hits;
}

describe('UI i18n: no hard-coded Hangul in .ts / .tsx', () => {
  it('the comment stripper and allow-list behave', () => {
    const sample = [
      "const a = '한글';",
      '// 주석',
      "const b = 'x'; // 주석",
      '/* 블록',
      '   주석 */ const c = 1;',
      '{/* JSX 주석 */}',
      "const url = 'http://example.com'; const d = '값';",
      "const e = '한국어'; // i18n-allow: endonym",
      '// i18n-allow-next-line',
      "const f = '한국어';",
      '<input accept="image/*" /> <b>본문</b> {/* ok */}',
    ].join('\n');
    expect(hangulLines(sample).map((h) => h.line)).toEqual([1, 7, 11]);
  });

  it('every .ts / .tsx outside i18n/locales is free of Hangul literals', () => {
    const offenders: string[] = [];
    for (const file of walk(WEB_SRC)) {
      for (const h of hangulLines(readFileSync(file, 'utf8'))) offenders.push(`${relative(WEB_SRC, file).split(sep).join('/')}:${h.line}  ${h.text}`);
    }
    expect(offenders, `Move these strings to apps/web/src/i18n/locales/{en,ko}/<ns>.ts (or mark a deliberate exception with // i18n-allow)`).toEqual([]);
  });
});
