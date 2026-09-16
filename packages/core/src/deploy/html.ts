// Printable single-file HTML helpers for deliverables (stream T7, DECISIONS-v2-2 F5).
// Self-contained: inline CSS only (no fonts / scripts / external assets), A4 print rules, repeated table headers,
// page breaks per chapter. Positional signatures of the contract (escapeHtml / htmlTable / htmlPage) are kept;
// everything else is additive options.
import type { Locale } from '../model/types.ts';

export function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export interface HtmlTableOptions {
  caption?: string;
  className?: string;
  /** zero-based column indexes rendered right-aligned (numbers) */
  numericCols?: number[];
  /** zero-based column indexes whose cells are trusted markup (produced by T7 helpers such as `inlineMarkup`) */
  rawCols?: number[];
  /** zero-based column indexes rendered in a monospace face (ids, addresses, labels) */
  monoCols?: number[];
  /** id attribute on the table */
  id?: string;
}

/** Escaped HTML table. Cells are text unless their column is listed in `rawCols`. */
export function htmlTable(headers: string[], rows: (string | number | null | undefined)[][], opts: HtmlTableOptions = {}): string {
  const num = new Set(opts.numericCols ?? []);
  const raw = new Set(opts.rawCols ?? []);
  const mono = new Set(opts.monoCols ?? []);
  const cls = (i: number) => {
    const c = [num.has(i) ? 'num' : '', mono.has(i) ? 'mono' : ''].filter(Boolean).join(' ');
    return c ? ` class="${c}"` : '';
  };
  const cell = (v: unknown, i: number, tag: 'td' | 'th') => `<${tag}${cls(i)}>${tag === 'td' && raw.has(i) ? String(v ?? '') : escapeHtml(v)}</${tag}>`;
  return [
    `<table${opts.id ? ` id="${escapeHtml(opts.id)}"` : ''}${opts.className ? ` class="${escapeHtml(opts.className)}"` : ''}>`,
    opts.caption ? `<caption>${escapeHtml(opts.caption)}</caption>` : '',
    `<thead><tr>${headers.map((h, i) => cell(h, i, 'th')).join('')}</tr></thead>`,
    `<tbody>${rows.map((r) => `<tr>${r.map((c, i) => cell(c, i, 'td')).join('')}</tr>`).join('')}</tbody>`,
    '</table>',
  ].join('');
}

/**
 * Minimal inline markup for generator-authored strings (never user HTML): escapes everything, then renders
 * `**bold**`, `_italic_` (whole-token) and `` `code` ``. A leading `> ` becomes a note paragraph class.
 */
export function inlineMarkup(s: string): string {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])_([^_]+)_(?=$|[\s).,:;])/g, '$1<em>$2</em>');
}

/** URL-safe slug for element ids (ASCII + Hangul kept). */
export function htmlId(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9가-힣]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60) || 'x';
}

export interface HtmlTocEntry { id: string; label: string; level: 1 | 2 }

export interface HtmlPageOptions {
  /** small line under the title on the cover band */
  subtitle?: string;
  /** table of contents rendered after the cover band */
  toc?: HtmlTocEntry[];
  tocTitle?: string;
  /** landscape A4 for wide schedules (cable schedule, IP map) */
  landscape?: boolean;
  /** footer text printed on every page (e.g. project · generated date) */
  footer?: string;
  /** render the title band (default true) */
  titleBand?: boolean;
}

/** Print stylesheet shared by the design document and every deploy HTML deliverable. Paper colours on purpose (print). */
export function printCss(landscape = false): string {
  return `
:root{--ink:#16181b;--ink2:#4a4f57;--rule:#c9ced4;--band:#eef1f4;--accent:#1f5f99;--warn:#9a5b00;}
*{box-sizing:border-box;}
html{-webkit-text-size-adjust:100%;}
body{font:10.5pt/1.45 "Noto Sans","Noto Sans KR","Segoe UI",system-ui,-apple-system,"Malgun Gothic",sans-serif;color:var(--ink);background:#fff;margin:0;padding:20px 28px 40px;}
main{max-width:1100px;margin:0 auto;}
h1{font-size:20pt;line-height:1.2;margin:0 0 4px;}
h2{font-size:14.5pt;margin:26px 0 8px;padding-bottom:4px;border-bottom:2px solid var(--ink);}
h3{font-size:11.5pt;margin:18px 0 6px;}
h4{font-size:10.5pt;margin:14px 0 4px;color:var(--ink2);}
p{margin:6px 0;}
ul{margin:6px 0 6px 20px;padding:0;}li{margin:2px 0;}
code,.mono{font-family:"DejaVu Sans Mono",Menlo,Consolas,monospace;font-size:9pt;}
pre{font-family:"DejaVu Sans Mono",Menlo,Consolas,monospace;font-size:8.5pt;background:var(--band);padding:8px 10px;border-radius:3px;white-space:pre-wrap;word-break:break-all;}
table{border-collapse:collapse;margin:6px 0 14px;width:100%;font-size:9pt;}
th,td{border:1px solid var(--rule);padding:3px 6px;text-align:left;vertical-align:top;}
th{background:var(--band);font-weight:600;}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;}
td.mono{white-space:nowrap;}
td.nowrap,th.nowrap{white-space:nowrap;}
caption{text-align:left;font-weight:600;padding:2px 0 4px;}
.band{border-bottom:3px solid var(--ink);padding-bottom:10px;margin-bottom:14px;}
.band .sub{color:var(--ink2);font-size:10pt;}
.meta td:first-child,.meta th:first-child{width:28%;color:var(--ink2);}
nav.toc{margin:8px 0 22px;padding:10px 14px;border:1px solid var(--rule);background:#fafbfc;}
nav.toc h2{border:0;margin:0 0 6px;font-size:12pt;padding:0;}
nav.toc ul{margin:0;padding:0;list-style:none;columns:2;column-gap:28px;}
nav.toc li{break-inside:avoid;margin:1px 0;}
nav.toc li.l1{font-weight:600;margin-top:4px;}
nav.toc li.l2{margin-left:14px;font-size:9pt;color:var(--ink2);}
nav.toc a{color:inherit;text-decoration:none;}
figure{margin:10px 0 16px;break-inside:avoid;}
figure svg,figure img{display:block;max-width:100%;height:auto;border:1px solid var(--rule);background:#fff;}
figcaption{font-size:9pt;color:var(--ink2);margin-top:4px;}
.note{border-left:3px solid var(--warn);background:#fff8ec;padding:6px 10px;margin:8px 0;font-size:9.5pt;}
.muted{color:var(--ink2);}
.pill{display:inline-block;border:1px solid var(--rule);border-radius:9px;padding:0 6px;font-size:8.5pt;color:var(--ink2);}
footer.doc{margin-top:28px;border-top:1px solid var(--rule);padding-top:6px;font-size:8.5pt;color:var(--ink2);}
@page{size:A4${landscape ? ' landscape' : ''};margin:14mm 12mm 16mm;}
@media print{
  body{padding:0;font-size:9.5pt;}
  main{max-width:none;}
  section.chapter{break-before:page;}
  section.chapter:first-of-type{break-before:auto;}
  h2,h3,h4{break-after:avoid;}
  thead{display:table-header-group;}
  tr,figure{break-inside:avoid;}
  /* polish v2 2차 (QA docs #5): wide hall / rack tables fit the 186 mm A4 width — smaller type and padding, identifiers never split */
  table{font-size:7.5pt;}
  th,td{padding:2px 4px;}
  th{white-space:normal;}
  td.mono,td.num,td.nowrap{white-space:nowrap;}
  .mono,code{font-size:7.5pt;}
  nav.toc{break-after:page;}
  a{color:inherit;text-decoration:none;}
}
`;
}

/** Complete standalone HTML document (inline CSS, print-friendly). `body` is trusted markup. */
export function htmlPage(title: string, body: string, locale: Locale, opts: HtmlPageOptions = {}): string {
  const toc = opts.toc?.length
    ? `<nav class="toc"><h2>${escapeHtml(opts.tocTitle ?? (locale === 'ko' ? '목차' : 'Contents'))}</h2><ul>${opts.toc
        .map((e) => `<li class="l${e.level}"><a href="#${escapeHtml(e.id)}">${escapeHtml(e.label)}</a></li>`)
        .join('')}</ul></nav>`
    : '';
  const band = opts.titleBand === false ? '' : `<header class="band"><h1>${escapeHtml(title)}</h1>${opts.subtitle ? `<div class="sub">${escapeHtml(opts.subtitle)}</div>` : ''}</header>`;
  const footer = opts.footer ? `<footer class="doc">${escapeHtml(opts.footer)}</footer>` : '';
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>${escapeHtml(title)}</title>
<style>${printCss(!!opts.landscape)}</style>
</head>
<body>
<main>
${band}
${toc}
${body}
${footer}
</main>
</body>
</html>
`;
}
