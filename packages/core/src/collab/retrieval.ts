// Deterministic BM25 retrieval for the assistant (stream T8, r2-platform.md §3.4): Latin words lower-cased,
// Hangul as character bigrams (no morphological analyser), glossary alias boost. No embeddings, no network.
import { GLOSSARY } from '../glossary/index.ts';
import type { GlossaryTerm, Locale } from '../model/types.ts';
import { HELP_PAGE_IDS, PAGE_HELP_DOCS, pageHelpText, type HelpPageId } from './help.ts';

export interface RetrievalDoc {
  /** stable citation id: `term:<id>` · `help:<page>` · `page:<page>` · `analysis:<domain>` */
  id: string;
  title: string;
  text: string;
  /** additional exact-match keys (acronyms, aliases) boosted when they appear in the query */
  keys?: string[];
  /** page/domain affinity used for the active-page boost */
  domain?: string;
}

export interface ScoredDoc {
  doc: RetrievalDoc;
  score: number;
}

const HANGUL = /[가-힣]/;

/** Tokens: Latin/digit words (lower-cased, also split on '-' and '/'), Hangul runs as bigrams (single syllables kept). */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const re = /[가-힣]+|[a-z0-9][a-z0-9.+]*/gi;
  for (const m of text.toLowerCase().matchAll(re)) {
    const w = m[0];
    if (HANGUL.test(w[0])) {
      if (w.length === 1) out.push(w);
      else for (let i = 0; i < w.length - 1; i++) out.push(w.slice(i, i + 2));
    } else {
      const trimmed = w.replace(/\.+$/, '');
      if (trimmed.length > 1 || /\d/.test(trimmed)) out.push(trimmed);
    }
  }
  return out;
}

export class Bm25Index {
  private readonly tf: Map<string, number>[] = [];
  private readonly len: number[] = [];
  private readonly df = new Map<string, number>();
  private avgLen = 0;

  constructor(readonly docs: RetrievalDoc[], readonly k1 = 1.2, readonly b = 0.75) {
    let total = 0;
    for (const d of docs) {
      const toks = tokenize(`${d.title} ${d.title} ${(d.keys ?? []).join(' ')} ${d.text}`);
      const m = new Map<string, number>();
      for (const t of toks) m.set(t, (m.get(t) ?? 0) + 1);
      for (const t of m.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      this.tf.push(m);
      this.len.push(toks.length);
      total += toks.length;
    }
    this.avgLen = docs.length ? total / docs.length : 0;
  }

  search(query: string, opts: { k?: number; boostDomain?: string; minScore?: number } = {}): ScoredDoc[] {
    const qTokens = [...new Set(tokenize(query))];
    const qNorm = ` ${query.toLowerCase()} `;
    const N = this.docs.length;
    const scored: ScoredDoc[] = [];
    this.docs.forEach((doc, i) => {
      let s = 0;
      for (const q of qTokens) {
        const f = this.tf[i].get(q);
        if (!f) continue;
        const df = this.df.get(q) ?? 0;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        s += (idf * f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * this.len[i]) / (this.avgLen || 1)));
      }
      // exact alias / acronym hit (word-bounded for Latin, substring for Hangul)
      for (const key of doc.keys ?? []) {
        const k = key.toLowerCase().trim();
        if (k.length < 2) continue;
        const hit = HANGUL.test(k) ? qNorm.includes(k) : new RegExp(`(^|[^a-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(qNorm);
        if (hit) s += 6;
      }
      if (s > 0 && opts.boostDomain && doc.domain === opts.boostDomain) s *= 1.25;
      if (s > (opts.minScore ?? 0)) scored.push({ doc, score: s });
    });
    scored.sort((a, b) => b.score - a.score || a.doc.id.localeCompare(b.doc.id));
    return scored.slice(0, opts.k ?? 8);
  }
}

function termKeys(t: GlossaryTerm): string[] {
  const keys = new Set<string>([t.id, t.term.en, t.term.ko, ...(t.aliases ?? [])]);
  for (const label of [t.term.en, t.term.ko]) {
    const m = /\(([^()]+)\)/.exec(label);
    if (m) m[1].split(/\s*\/\s*/).forEach((k) => keys.add(k));
    keys.add(label.replace(/\s*\(.*\)\s*/g, ''));
  }
  return [...keys].filter(Boolean);
}

/** Map a glossary domain onto the page whose help covers it (for the active-page boost). */
const DOMAIN_PAGE: Record<string, HelpPageId> = { layout: 'layout', network: 'network', optics: 'network', cooling: 'cooling', power: 'power', workload: 'workload', ops: 'docs', general: 'overview' };

/** Glossary + page-help corpus in one locale (both languages are indexed so KO questions match EN acronyms). */
export function builtinCorpus(locale: Locale): RetrievalDoc[] {
  const other: Locale = locale === 'ko' ? 'en' : 'ko';
  const docs: RetrievalDoc[] = GLOSSARY.map((t) => ({
    id: `term:${t.id}`,
    title: `${t.term[locale]} (${t.term[other]})`,
    text: [t.short[locale], t.long?.[locale] ?? '', t.short[other]].join('\n'),
    keys: termKeys(t),
    domain: DOMAIN_PAGE[t.domain ?? 'general'],
  }));
  for (const page of HELP_PAGE_IDS) {
    docs.push({ id: `help:${page}`, title: PAGE_HELP_DOCS[page].title[locale], text: `${pageHelpText(page, locale)}\n${PAGE_HELP_DOCS[page].title[other]}`, domain: page });
  }
  return docs;
}

const indexCache = new Map<Locale, Bm25Index>();
/** Cached BM25 index over the builtin corpus for a locale. */
export function builtinIndex(locale: Locale): Bm25Index {
  let idx = indexCache.get(locale);
  if (!idx) indexCache.set(locale, (idx = new Bm25Index(builtinCorpus(locale))));
  return idx;
}
