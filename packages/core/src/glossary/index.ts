import type { GlossaryTerm, Locale } from '../model/types.ts';
import { GLOSSARY_TERMS } from './terms.ts';

/**
 * Terminology glossary (stream S4, PROPOSAL-v2 §3.8): ~150 terms (SU/RCU/HAC/CAC/CIN/CUB/TCS/FWS/ATD/RPP/EDP/
 * Max-Q/EDPP/BESS/oversubscription/rail-optimized/DDC/VOQ/PXN/DCQCN/busbw/MDA/IDF/MMR …) with EN/KO short and
 * long descriptions, related terms, aliases and sources. Rendered by apps/web/src/ui/Term.tsx, the help drawer and
 * the docs generator.
 */
export const GLOSSARY: GlossaryTerm[] = GLOSSARY_TERMS;
export { GLOSSARY_TERMS };

export type GlossaryDomain = NonNullable<GlossaryTerm['domain']>;
export const GLOSSARY_DOMAINS: GlossaryDomain[] = ['general', 'layout', 'network', 'optics', 'cooling', 'power', 'workload', 'ops'];

let idIndex: Map<string, GlossaryTerm> | null = null;
let aliasIndex: Map<string, GlossaryTerm> | null = null;

const norm = (s: string) => s.trim().toLowerCase().replace(/[\s_]+/g, '-');

function buildIndexes() {
  idIndex = new Map();
  aliasIndex = new Map();
  for (const t of GLOSSARY) {
    idIndex.set(t.id, t);
    const keys = new Set<string>([t.id, t.term.en, t.term.ko, ...(t.aliases ?? [])]);
    // also index the bare acronym inside "Name (ACR)" patterns, e.g. "Scalable Unit (SU)" → "su"
    for (const label of [t.term.en, t.term.ko]) {
      const m = /\(([^()]+)\)/.exec(label);
      if (m) m[1].split(/\s*\/\s*/).forEach((k) => keys.add(k));
      label.split(/\s*\/\s*/).forEach((k) => keys.add(k.replace(/\s*\(.*\)\s*/g, '')));
    }
    for (const k of keys) {
      const nk = norm(k);
      if (nk && !aliasIndex.has(nk)) aliasIndex.set(nk, t);
    }
  }
}

export function findTerm(id: string): GlossaryTerm | undefined {
  if (!idIndex) buildIndexes();
  return idIndex!.get(id);
}

/** Case-insensitive lookup by id, English/Korean term, acronym in parentheses or declared alias. */
export function findTermByAlias(alias: string): GlossaryTerm | undefined {
  if (!aliasIndex) buildIndexes();
  return aliasIndex!.get(norm(alias));
}

/** Localised label for a term id (falls back to the id itself). */
export function termLabel(id: string, locale: Locale = 'en'): string {
  return findTerm(id)?.term[locale] ?? id;
}

/** Localised one-line explanation for a term id (empty string when unknown). */
export function termShort(id: string, locale: Locale = 'en'): string {
  return findTerm(id)?.short[locale] ?? '';
}

/** Terms of one domain, in glossary order. */
export function termsByDomain(domain: GlossaryDomain): GlossaryTerm[] {
  return GLOSSARY.filter((t) => (t.domain ?? 'general') === domain);
}

/** Simple substring search over term / short / aliases in one locale (for the help drawer search box). */
export function searchTerms(query: string, locale: Locale = 'en'): GlossaryTerm[] {
  const q = query.trim().toLowerCase();
  if (!q) return GLOSSARY;
  return GLOSSARY.filter((t) =>
    t.id.includes(q)
    || t.term[locale].toLowerCase().includes(q)
    || t.term.en.toLowerCase().includes(q)
    || t.short[locale].toLowerCase().includes(q)
    || (t.aliases ?? []).some((a) => a.toLowerCase().includes(q)),
  );
}
