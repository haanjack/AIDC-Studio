import type { PricingSettings } from '@aidc/core';
import { currentUiLocale, translate } from '../i18n/index.ts';
import type { UiLocale } from '../i18n/locale.ts';

const nf0 = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 });

export const fmtInt = (v: number | undefined | null) => (v == null || !Number.isFinite(v) ? '–' : nf0.format(v));
export const fmt1 = (v: number | undefined | null) => (v == null || !Number.isFinite(v) ? '–' : nf1.format(v));
export const fmt2 = (v: number | undefined | null) => (v == null || !Number.isFinite(v) ? '–' : nf2.format(v));
export const fmtPct = (v: number | undefined | null, digits = 0) => (v == null || !Number.isFinite(v) ? '–' : `${(v * 100).toFixed(digits)}%`);

/** kW with automatic MW switch. */
export function fmtPower(kw: number | undefined | null): string {
  if (kw == null || !Number.isFinite(kw)) return '–';
  if (Math.abs(kw) >= 1000) return `${nf2.format(kw / 1000)} MW`;
  return `${nf1.format(kw)} kW`;
}

export function fmtMoney(usd: number | undefined | null, pricing?: Pick<PricingSettings, 'currency' | 'fxKRWPerUSD'>): string {
  if (usd == null || !Number.isFinite(usd)) return '–';
  if (pricing?.currency === 'KRW') {
    const krw = usd * pricing.fxKRWPerUSD;
    // fix v2 2차 (QA i18n): 조 / 억 / 만 in the Korean UI, T / B / M / K elsewhere
    const L = currentUiLocale();
    if (L === 'ko') {
      if (Math.abs(krw) >= 1e12) return translate(L, 'ui.money.krw.t', { v: nf2.format(krw / 1e12) });
      if (Math.abs(krw) >= 1e8) return translate(L, 'ui.money.krw.e8', { v: nf1.format(krw / 1e8) });
      if (Math.abs(krw) >= 1e4) return translate(L, 'ui.money.krw.e4', { v: nf0.format(krw / 1e4) });
      return `₩${nf0.format(krw)}`;
    }
    if (Math.abs(krw) >= 1e12) return `₩${nf2.format(krw / 1e12)}T`;
    if (Math.abs(krw) >= 1e9) return `₩${nf2.format(krw / 1e9)}B`;
    if (Math.abs(krw) >= 1e6) return `₩${nf1.format(krw / 1e6)}M`;
    if (Math.abs(krw) >= 1e3) return `₩${nf1.format(krw / 1e3)}K`;
    return `₩${nf0.format(krw)}`;
  }
  if (Math.abs(usd) >= 1e9) return `$${nf2.format(usd / 1e9)}B`;
  if (Math.abs(usd) >= 1e6) return `$${nf2.format(usd / 1e6)}M`;
  if (Math.abs(usd) >= 1e3) return `$${nf1.format(usd / 1e3)}K`;
  return `$${nf0.format(usd)}`;
}

export function fmtDate(iso: string | undefined | null): string {
  if (!iso) return '–';
  return iso.slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

/** Duration in hours / days / months in the UI locale (fix v2 2차: units were hard-coded Korean). */
export function fmtDuration(days: number | undefined | null, locale: UiLocale = 'en'): string {
  if (days == null || !Number.isFinite(days)) return '–';
  if (days < 1) return translate(locale, 'ui.duration.hours', { v: nf1.format(days * 24) });
  if (days > 60) return translate(locale, 'ui.duration.months', { v: nf1.format(days / 30.44), n: nf1.format(days / 30.44) });
  return translate(locale, 'ui.duration.days', { v: nf1.format(days), n: nf1.format(days) });
}
