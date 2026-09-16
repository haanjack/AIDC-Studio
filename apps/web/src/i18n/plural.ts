/**
 * Stream T4 (#9): English plural forms for counted UI strings. Pure (no store import) so it can be unit-tested.
 *
 * A key `x` with a count parameter (`n` or `count`) resolves to `x_one` when the count is exactly 1 and the English
 * dictionary has `x_one`; every other count keeps `x`, which holds the plural wording. Korean has no plural inflection, so
 * the lookup is English-only and Korean strings never change.
 */
export type PluralParams = Record<string, string | number> | undefined;

/** Numeric value of a count parameter (`fmtInt` output such as "1,234" is accepted). */
export function countOf(params: PluralParams): number | undefined {
  if (!params) return undefined;
  const raw = 'n' in params ? params.n : 'count' in params ? params.count : undefined;
  if (raw === undefined) return undefined;
  const v = typeof raw === 'number' ? raw : Number(String(raw).replace(/[,\s ]/g, ''));
  return Number.isFinite(v) ? v : undefined;
}

/** Dictionary key to use for `key` in `locale` given the params (`has` = does the English dictionary contain a key). */
export function pluralKey(locale: string, key: string, params: PluralParams, has: (k: string) => boolean): string {
  if (locale !== 'en') return key;
  const n = countOf(params);
  if (n === 1 && has(`${key}_one`)) return `${key}_one`;
  return key;
}

/** Plain helper for code that builds English text directly: `plural(1, 'node', 'nodes')` → "node". */
export function plural(n: number, one: string, other: string): string {
  return n === 1 ? one : other;
}
