// UI string i18n (stream T8, DECISIONS-v2-2 §B). Typed TS dictionaries, no runtime library (r2-platform.md §5).
//
// Namespaces: every stream owns `locales/en/<ns>.ts` + `locales/ko/<ns>.ts` (export default a flat Record<string,string>,
// keys prefixed '<ns>.'). They are loaded eagerly with import.meta.glob and merged; a key defined twice throws in dev.
// Lookup: active UI locale → English → the key itself. `{name}` placeholders are filled from params.
// The UI language (`uiLocale` in the store, localStorage 'aidc:uiLocale') is independent of project.locale (deliverables).
// Guide: docs/research/i18n-guide.md
import { useCallback, useMemo } from 'react';
import { useApp } from '../store/appStore.ts';
import { en as enBase } from './en.ts';
import { ko as koBase } from './ko.ts';
import type { UiLocale } from './locale.ts';

export { detectUiLocale, type UiLocale } from './locale.ts';
import { pluralKey } from './plural.ts';
export { plural, pluralKey } from './plural.ts';

export type Dictionary = Record<string, string>;
export type TParams = Record<string, string | number>;

const NAMESPACE_MODULES = import.meta.glob<Dictionary>('./locales/*/*.ts', { eager: true, import: 'default' });

/** Merge namespace files into one dictionary per locale. Exported for tests; throws on a duplicate key when `strict`. */
export function mergeNamespaces(modules: Record<string, Dictionary | undefined>, strict: boolean): Record<UiLocale, Dictionary> {
  const out: Record<UiLocale, Dictionary> = { en: { ...enBase }, ko: { ...koBase } };
  const owner: Record<UiLocale, Record<string, string>> = { en: {}, ko: {} };
  for (const [path, dict] of Object.entries(modules)) {
    const m = /locales\/(en|ko)\/([^/]+)\.ts$/.exec(path);
    if (!m || !dict) continue;
    const locale = m[1] as UiLocale;
    for (const [key, value] of Object.entries(dict)) {
      if (key in out[locale]) {
        const msg = `[i18n] duplicate key '${key}' in ${path} (already defined by ${owner[locale][key] ?? 'i18n/' + locale + '.ts'})`;
        if (strict) throw new Error(msg);
        console.warn(msg);
      }
      out[locale][key] = value;
      owner[locale][key] = path;
    }
  }
  return out;
}

export const DICTIONARIES: Record<UiLocale, Dictionary> = mergeNamespaces(NAMESPACE_MODULES, import.meta.env?.DEV ?? false);

function interpolate(text: string, params?: TParams): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}

/** Pure lookup for an explicit locale (tests, non-React code). */
export function translate(locale: UiLocale, key: string, params?: TParams): string {
  // stream T4 (#9): English `<key>_one` form when the count param is 1 (Korean unchanged)
  const k = pluralKey(locale, key, params, (x) => x in DICTIONARIES.en);
  return interpolate(DICTIONARIES[locale]?.[k] ?? DICTIONARIES.en[k] ?? DICTIONARIES[locale]?.[key] ?? DICTIONARIES.en[key] ?? key, params);
}

/** true when the key exists in the English dictionary (useful for optional labels). */
export function hasKey(key: string): boolean {
  return key in DICTIONARIES.en;
}

/** The store's current UI locale (non-reactive; for formatters outside components). */
export function currentUiLocale(): UiLocale {
  return useApp.getState().uiLocale;
}

/** Lookup with the store's current UI locale (non-reactive: use `useT()` inside components). */
export function t(key: string, params?: TParams): string {
  return translate(useApp.getState().uiLocale, key, params);
}

/** Reactive translator bound to the store's UI locale (components re-render on locale change). */
export function useT(): (key: string, params?: TParams) => string {
  const locale = useApp((s) => s.uiLocale);
  return useCallback((key: string, params?: TParams) => translate(locale, key, params), [locale]);
}

// ─────────── Intl helpers (engineering values: no compact notation; units stay literal suffixes) ───────────

const INTL_TAG: Record<UiLocale, string> = { en: 'en-US', ko: 'ko-KR' };
export const intlTag = (locale: UiLocale) => INTL_TAG[locale];

/** Grouped number in the UI locale (`digits` = max fraction digits, default 0; `min` = min fraction digits). */
export function formatNumber(locale: UiLocale, value: number, digits = 0, min?: number): string {
  if (!Number.isFinite(value)) return '—';
  return new Intl.NumberFormat(INTL_TAG[locale], { maximumFractionDigits: digits, minimumFractionDigits: min ?? 0 }).format(value);
}

/** Date/time in the UI locale ('medium' date, optional short time). */
export function formatDate(locale: UiLocale, iso: string | number | Date, withTime = true): string {
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return new Intl.DateTimeFormat(INTL_TAG[locale], withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' }).format(d);
}

/** Relative time ("3 minutes ago" / "3분 전", "yesterday" / "어제"). */
export function formatRelative(locale: UiLocale, iso: string | number | Date, now: number = Date.now()): string {
  const d = iso instanceof Date ? iso.getTime() : new Date(iso).getTime();
  if (Number.isNaN(d)) return String(iso);
  const s = Math.round((d - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat(INTL_TAG[locale], { numeric: 'auto' });
  const abs = Math.abs(s);
  if (abs < 45) return rtf.format(s, 'second');
  if (abs < 45 * 60) return rtf.format(Math.round(s / 60), 'minute');
  if (abs < 22 * 3600) return rtf.format(Math.round(s / 3600), 'hour');
  if (abs < 26 * 86400) return rtf.format(Math.round(s / 86400), 'day');
  return formatDate(locale, d, false);
}

// ─────────── Engine issues (Issue.message is Korean; messageEn / suggestionEn carry English when the engine provides it) ───────────

type LocalizedIssue = { message: string; messageEn?: string; suggestion?: string; suggestionEn?: string };

/** Issue message in the UI locale: English falls back to the Korean message until the engine provides messageEn. */
export function issueMessage(locale: UiLocale, i: LocalizedIssue): string {
  return locale === 'en' ? (i.messageEn ?? i.message) : i.message;
}

/** Issue suggestion in the UI locale (undefined when the issue has none). */
export function issueSuggestion(locale: UiLocale, i: LocalizedIssue): string | undefined {
  return locale === 'en' ? (i.suggestionEn ?? i.suggestion) : i.suggestion;
}

/** Reactive issue text: `const { msg, sug } = useIssueText()` → `msg(issue)`, `sug(issue)`. */
export function useIssueText() {
  const locale = useApp((s) => s.uiLocale);
  return useMemo(() => ({ msg: (i: LocalizedIssue) => issueMessage(locale, i), sug: (i: LocalizedIssue) => issueSuggestion(locale, i) }), [locale]);
}

/** Reactive bundle: `const { t, locale, num, date, rel } = useI18n()`. */
export function useI18n() {
  const locale = useApp((s) => s.uiLocale);
  return useMemo(
    () => ({
      locale,
      t: (key: string, params?: TParams) => translate(locale, key, params),
      num: (v: number, digits = 0, min?: number) => formatNumber(locale, v, digits, min),
      date: (iso: string | number | Date, withTime = true) => formatDate(locale, iso, withTime),
      rel: (iso: string | number | Date) => formatRelative(locale, iso),
    }),
    [locale],
  );
}
