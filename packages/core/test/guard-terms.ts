// P6 guard helpers (DECISIONS-v2-2 §I "추가 지시"): the retired NVIDIA blueprint abbreviation may appear in README.md only. Tests
// that look for it build it from character codes, so the repository-wide term guard (wording-guard.test.ts) also covers tests.
export const TERM_UPPER = String.fromCharCode(68, 83, 88);
export const TERM_LOWER = TERM_UPPER.toLowerCase();
const TERM_TITLE = TERM_UPPER[0] + TERM_LOWER.slice(1);

/** RegExp from a source with placeholders: `<T>` upper case, `<t>` lower case, `<Tt>` title case. */
export function termRe(source: string, flags = ''): RegExp {
  return new RegExp(source.replaceAll('<Tt>', TERM_TITLE).replaceAll('<T>', TERM_UPPER).replaceAll('<t>', TERM_LOWER), flags);
}
