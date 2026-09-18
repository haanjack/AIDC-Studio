// P6 guards (OCP-DESIGN-PROPOSAL §8.3 "wording-guard.test.ts", §6.2–6.3; DECISIONS-v2-2 §I "추가 지시"):
//  1. the retired NVIDIA blueprint abbreviation appears nowhere in the repository except README.md and the private working papers
//     (docs/research, docs/legal) and the private data folders (data/, assets/) — file names and text, any case;
//  2. no certification wording ("… Accepted / Inspired / Ready compliant", "certified", "mode", "Studio", marketplace claims) in core
//     strings, web locales or generated deliverables of the neutral reference and the vendor sample;
//  3. no organisation mark in item / template / preset ids and names, no raw internal level or pre-check keys in exports;
//  4. the notice is single-sourced and HTML deliverables carry no keyword meta or hidden mark text.
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  GLOSSARY, HELP_PAGE_IDS, LAYOUT_TEMPLATES, PROJECT_TEMPLATE_NAMES, STANDARDS_LABELS, STANDARDS_NOTICE, STANDARDS_PRESETS, STANDARDS_REGISTRY, analyzeProject,
  buildExportFiles, buildWaveBom, catalogItems, createNvidiaReferenceProject, createReferenceProject, docStrings, generateDesignDocument, pageHelpText,
  renderDesignDocumentHtml, standardsDictionary, upgradeProject, waveBomCsv, type Project,
} from '../src/index.ts';
import { termRe } from './guard-terms.ts';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));

/** Certification / endorsement wording (proposal §6.2 + P0 trademark additions). The notice itself is exempt. */
export const FORBIDDEN_WORDING =
  /OCP(®|™)?\s+(Accepted|Inspired)|OCP(®|™)?\s+Ready(®|™)?\s+(compliant|certified|approved|recognized|facility)|(OCP|Open Compute)[- ](certified|compliant|approved|endorsed)|(certified|endorsed|approved) by (the )?(OCP|Open Compute)|OCP mode|OCP Studio|OCP Marketplace|OCP\s*(인증|승인|준수)/i;
/** Raw internal keys that must never be exported or displayed (legacy level / pre-check spellings and current level keys). */
const RAW_KEYS = /\b(ocp-based|ocp-contributed-design|ocp-inspired-host|ocp-ready-v1@1\.5|ocp-ready-v2hs@1\.15|open-platform-host)\b/;
const MARK_IN_NAME = /\bOCP\b|Open Compute/i;

const withoutNotice = (s: string) =>
  [STANDARDS_NOTICE.en, STANDARDS_NOTICE.ko, STANDARDS_NOTICE.en.replace(/®/g, '&reg;'), STANDARDS_NOTICE.ko.replace(/®/g, '&reg;')].reduce((acc, n) => acc.split(n).join(''), s);

// ───────────────────────────── 1. term guard (repository-wide) ─────────────────────────────

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.venv', '__pycache__', '.godot', '.vite', '__screenshots__']);
const PRIVATE_PREFIXES = ['data/', 'assets/', 'docs/research/', 'docs/legal/'];
const TERM_ALLOWED_FILES = new Set(['README.md']);

function repoFiles(dir = REPO, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const abs = join(dir, name);
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) continue;
    const rel = relative(REPO, abs).split('\\').join('/');
    if (st.isDirectory()) {
      if (PRIVATE_PREFIXES.some((p) => `${rel}/`.startsWith(p))) continue;
      repoFiles(abs, out);
    } else out.push(rel);
  }
  return out;
}

/** A hit inside a long hash / base64 token (lock-file integrity, sha sums) is noise, not a use of the term. */
function isHashToken(text: string, index: number, len: number): boolean {
  let a = index;
  let b = index + len;
  while (a > 0 && /[A-Za-z0-9+/=_-]/.test(text[a - 1])) a--;
  while (b < text.length && /[A-Za-z0-9+/=_-]/.test(text[b])) b++;
  const token = text.slice(a, b);
  return token.length >= 40 && /\d/.test(token);
}

describe('P6 term guard: the blueprint abbreviation lives in README.md only', () => {
  const files = repoFiles();

  it('scans the published tree (source, tests, tools, public docs, notices)', () => {
    for (const f of ['packages/core/src/index.ts', 'apps/web/src/App.tsx', 'apps/server/src/storage.ts', 'tools/licenses/check-publication.mjs', 'docs/PRODUCT.md', 'docs/ARCHITECTURE.md', 'NOTICE', 'TRADEMARKS.md']) {
      expect(files, f).toContain(f);
    }
    expect(files.some((f) => f.startsWith('docs/research/') || f.startsWith('data/') || f.startsWith('assets/'))).toBe(false);
  });

  it('no file or directory name carries the term', () => {
    const re = termRe('<t>', 'i');
    expect(files.filter((f) => re.test(f))).toEqual([]);
  });

  it('no text file outside README.md contains the term (any case, identifiers included)', () => {
    const re = termRe('<t>', 'gi');
    const hits: string[] = [];
    for (const rel of files) {
      if (TERM_ALLOWED_FILES.has(rel)) continue;
      const buf = readFileSync(join(REPO, rel));
      if (buf.length > 32 * 1024 * 1024 || buf.subarray(0, 8000).includes(0)) continue; // binary (GLB, PNG, HDR …)
      const text = buf.toString('utf8');
      for (const m of text.matchAll(re)) {
        if (isHashToken(text, m.index!, m[0].length)) continue;
        const line = text.slice(0, m.index!).split('\n').length;
        hits.push(`${rel}:${line}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('the built web bundle (when present) does not spell the term either — minifiers fold constant expressions', () => {
    const dir = join(REPO, 'apps/web/dist/assets');
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((n) => n.endsWith('.js') || n.endsWith('.css') || n.endsWith('.html'));
    } catch {
      return; // no build output in this checkout
    }
    const re = termRe('<t>', 'gi');
    const hits: string[] = [];
    for (const n of names) {
      const text = readFileSync(join(dir, n), 'utf8');
      for (const m of text.matchAll(re)) if (!isHashToken(text, m.index!, m[0].length)) hits.push(`${n}@${m.index}: ${text.slice(Math.max(0, m.index! - 30), m.index! + 30)}`);
    }
    expect(hits).toEqual([]);
  });

  it('README keeps at most a short nominative mention', () => {
    const re = termRe('<t>', 'gi');
    expect((readFileSync(join(REPO, 'README.md'), 'utf8').match(re) ?? []).length).toBeLessThanOrEqual(3);
  });
});

// ───────────────────────────── 2–4. wording in strings and deliverables ─────────────────────────────

async function webLocaleStrings(): Promise<{ key: string; locale: string; value: string }[]> {
  const out: { key: string; locale: string; value: string }[] = [];
  for (const locale of ['en', 'ko']) {
    const dir = join(REPO, 'apps/web/src/i18n/locales', locale);
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
      const mod = (await import(pathToFileURL(join(dir, name)).href)) as { default?: Record<string, unknown> };
      for (const [key, value] of Object.entries(mod.default ?? {})) if (typeof value === 'string') out.push({ key, locale, value });
    }
  }
  return out;
}

function flattenStrings(v: unknown, path = '', out: [string, string][] = []): [string, string][] {
  if (typeof v === 'string') out.push([path, v]);
  else if (Array.isArray(v)) v.forEach((x, i) => flattenStrings(x, `${path}[${i}]`, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) flattenStrings(x, path ? `${path}.${k}` : k, out);
  return out;
}

function coreStrings(): [string, string][] {
  const out: [string, string][] = [];
  for (const l of ['en', 'ko'] as const) {
    flattenStrings(docStrings(l), `docStrings.${l}`, out);
    for (const [k, v] of Object.entries(standardsDictionary(l))) out.push([`standardsDictionary.${l}.${k}`, v]);
    for (const page of HELP_PAGE_IDS) out.push([`help.${page}.${l}`, pageHelpText(page, l)]);
  }
  flattenStrings(STANDARDS_LABELS, 'STANDARDS_LABELS', out);
  flattenStrings(GLOSSARY, 'GLOSSARY', out);
  flattenStrings(PROJECT_TEMPLATE_NAMES, 'PROJECT_TEMPLATE_NAMES', out);
  for (const t of LAYOUT_TEMPLATES) out.push([`template.${t.id}`, `${t.name}\n${t.description}\n${t.notes ?? ''}`]);
  for (const i of catalogItems()) out.push([`catalog.${i.id}`, `${i.name}\n${i.model}\n${i.description ?? ''}\n${i.notes ?? ''}`]);
  for (const r of STANDARDS_REGISTRY) out.push([`registry.${r.id}`, `${r.title}\n${r.notes ?? ''}`]);
  return out;
}

function deliverables(project: Project, label: string): [string, string][] {
  const a = analyzeProject(project);
  const out: [string, string][] = [];
  for (const locale of ['en', 'ko'] as const) {
    out.push([`${label}.designDoc.${locale}`, generateDesignDocument(project, a, { locale })]);
    out.push([`${label}.bom.${locale}`, waveBomCsv(buildWaveBom(project, a, locale))]);
  }
  out.push([`${label}.html`, renderDesignDocumentHtml(project, a, { includeDrawings: false })]);
  for (const format of ['json', 'docs', 'deploy'] as const) {
    for (const [name, body] of Object.entries(buildExportFiles(project, a, format))) {
      out.push([`${label}.export.${format}:name`, name]);
      if (typeof body === 'string') out.push([`${label}.export.${format}:${name}`, body]);
    }
  }
  return out;
}

describe('P6 wording guard: no certification wording, marks in names or raw keys', () => {
  it('web locales (EN + KO): no forbidden wording, no raw keys, no term; the notice key is the shared notice', async () => {
    const strings = await webLocaleStrings();
    expect(strings.length).toBeGreaterThan(1000);
    const term = termRe('\\b<T>\\b', 'i');
    const bad = strings.filter((s) => FORBIDDEN_WORDING.test(withoutNotice(s.value)) || RAW_KEYS.test(s.value) || term.test(s.value)).map((s) => `${s.locale}:${s.key}`);
    expect(bad).toEqual([]);
    expect(strings.find((s) => s.locale === 'en' && s.key === 'standards.ui.about.notice')?.value).toBe(STANDARDS_NOTICE.en);
    expect(strings.find((s) => s.locale === 'ko' && s.key === 'standards.ui.about.notice')?.value).toBe(STANDARDS_NOTICE.ko);
    // the notice text appears only under its own key
    const copies = strings.filter((s) => s.key !== 'standards.ui.about.notice' && (s.value.includes(STANDARDS_NOTICE.en) || s.value.includes(STANDARDS_NOTICE.ko)));
    expect(copies.map((s) => s.key)).toEqual([]);
  });

  it('core strings (docs, help, glossary, labels, templates, catalog, registry titles): no forbidden wording or raw keys', () => {
    const bad = coreStrings().filter(([, v]) => FORBIDDEN_WORDING.test(withoutNotice(v)) || RAW_KEYS.test(v)).map(([k]) => k);
    expect(bad).toEqual([]);
  });

  it('ids and names of catalog items, templates, presets and registry entries carry no organisation mark', () => {
    const ids = [...catalogItems().map((i) => i.id), ...LAYOUT_TEMPLATES.map((t) => t.id), ...Object.keys(STANDARDS_PRESETS), ...STANDARDS_REGISTRY.map((r) => r.id)];
    expect(ids.filter((id) => /(^|[^a-z])ocp([^a-z]|$)/i.test(id))).toEqual([]);
    const names = [
      ...catalogItems().flatMap((i) => [i.name, i.model]),
      ...LAYOUT_TEMPLATES.map((t) => t.name),
      ...Object.values(PROJECT_TEMPLATE_NAMES),
      ...Object.values(STANDARDS_LABELS).flatMap((l) => (l && typeof l === 'object' && 'en' in l ? [String((l as { en: string }).en), String((l as { ko?: string }).ko ?? '')] : [])),
    ];
    expect(names.filter((n) => MARK_IN_NAME.test(n))).toEqual([]);
  });

  for (const [label, make] of [['neutral', () => createReferenceProject().project], ['nvidia-sample', () => createNvidiaReferenceProject().project]] as const) {
    it(`generated deliverables of the ${label} reference: no forbidden wording, raw keys, term or hidden mark text`, () => {
      const out = deliverables(make(), label);
      const term = termRe('<t>', 'i');
      const bad = out.filter(([, v]) => FORBIDDEN_WORDING.test(withoutNotice(v.replace(/&reg;/g, '®'))) || RAW_KEYS.test(v) || term.test(v)).map(([k]) => k);
      expect(bad).toEqual([]);
      const html = out.find(([k]) => k === `${label}.html`)![1];
      expect(html).not.toMatch(/<meta[^>]+name=["']keywords["']/i);
      expect(html).not.toMatch(/<[^>]+(display:\s*none|visibility:\s*hidden|font-size:\s*0|\bhidden\b)[^>]*>[^<]*(OCP|Open Compute)/i);
      const doc = out.find(([k]) => k === `${label}.designDoc.en`)![1];
      expect(doc.split(STANDARDS_NOTICE.en).length - 1, 'notice appears once in the EN design document').toBe(1);
    }, 240_000);
  }

  // Finish (qa-ui-wording §7 guard gap): stored live projects are read-only here and go through upgradeProject exactly as the server load
  // path does, so user-visible content (notes in the textarea / design document, exports) is covered. Skipped when data/ is absent.
  // Version snapshots are not scanned: their names / descriptions are history pending a consultant decision (OCP-BUILD-RESULTS §6).
  const storedDir = join(REPO, 'data/projects');
  const stored = existsSync(storedDir) ? readdirSync(storedDir).filter((n) => n.endsWith('.json')) : [];
  it.skipIf(stored.length === 0)('stored live projects (data/projects/*.json, when present), after upgradeProject: no forbidden wording, raw keys or term', () => {
    const term = termRe('<t>', 'i');
    for (const name of stored) {
      const project = upgradeProject(JSON.parse(readFileSync(join(storedDir, name), 'utf8')) as Project);
      const out = deliverables(project, `stored.${name}`);
      const bad = out.filter(([, v]) => FORBIDDEN_WORDING.test(withoutNotice(v.replace(/&reg;/g, '®'))) || RAW_KEYS.test(v) || term.test(v)).map(([k]) => k);
      expect(bad, name).toEqual([]);
    }
  }, 240_000);
});
