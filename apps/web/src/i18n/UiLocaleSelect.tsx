// Topbar UI-language select (stream T8). Clearly separate from the deliverable-language select (project.locale).
import { useApp } from '../store/appStore.ts';
import { useT } from './index.ts';
import type { UiLocale } from './locale.ts';

const OPTIONS: { value: UiLocale; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'ko', label: '한국어' }, // i18n-allow: language endonym
];

export function UiLocaleSelect() {
  const locale = useApp((s) => s.uiLocale);
  const setUiLocale = useApp((s) => s.setUiLocale);
  const t = useT();
  return (
    <label className="topbar-lang" title={t('shell.topbar.uiLangTitle')} data-ui-locale-select>
      <span className="topbar-lang-label">UI</span>
      <select value={locale} onChange={(e) => setUiLocale(e.target.value as UiLocale)} aria-label={t('shell.topbar.uiLangTitle')}>
        {OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}
