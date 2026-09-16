// UI language (stream T8). No imports — the store and the i18n module both depend on this file (no import cycle).

export type UiLocale = 'en' | 'ko';

/** 'ko' for any Korean browser language tag (ko, ko-KR), else 'en'. */
export function detectUiLocale(lang?: string | null): UiLocale {
  return (lang ?? '').toLowerCase().startsWith('ko') ? 'ko' : 'en';
}
