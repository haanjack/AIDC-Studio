import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { useT } from '../i18n/index.ts';
import { Icon } from './icons.tsx';
import webPkg from '../../package.json';

/**
 * About dialog (neutralization stream N3): version, MIT licence, link to the shipped third-party notices
 * (public/THIRD_PARTY_NOTICES.txt → dist root), trademark / non-affiliation notice and asset credits read at runtime
 * from public/assets/CREDITS.json (optional; the section hides when the file is absent). Strings: 'about' namespace.
 */
export const useAbout = create<{ open: boolean; setOpen: (open: boolean) => void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

const BASE = import.meta.env.BASE_URL ?? '/';
const NOTICES_URL = `${BASE}THIRD_PARTY_NOTICES.txt`;
const CREDITS_URL = `${BASE}assets/CREDITS.json`;
const MIT_URL = 'https://opensource.org/license/mit';

/** AIDC Studio's own generated assets (CREDITS.json licence 'MIT (AIDC Studio original)') are counted, not listed. */
export const isOwnCredit = (c: AssetCredit): boolean => /AIDC Studio original/i.test(c.license ?? '');

export interface AssetCredit {
  name: string;
  author?: string;
  license?: string;
  source?: string;
  note?: string;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Accepts the CREDITS.json shapes we expect: an array, `{ assets | credits | items: [...] }`, or a `{ path: entry }` map. */
export function normalizeCredits(json: unknown): AssetCredit[] {
  if (!json || typeof json !== 'object') return [];
  const o = json as Record<string, unknown>;
  const list: [string | undefined, unknown][] = Array.isArray(json)
    ? json.map((e) => [undefined, e])
    : Array.isArray(o.assets) ? (o.assets as unknown[]).map((e) => [undefined, e])
    : Array.isArray(o.credits) ? (o.credits as unknown[]).map((e) => [undefined, e])
    : Array.isArray(o.items) ? (o.items as unknown[]).map((e) => [undefined, e])
    : Object.entries(o).filter(([k, v]) => !k.startsWith('_') && v && typeof v === 'object');
  const out: AssetCredit[] = [];
  for (const [key, raw] of list) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as Record<string, unknown>;
    const name = str(e.name) ?? str(e.title) ?? str(e.asset) ?? str(e.file) ?? str(e.path) ?? key;
    if (!name) continue;
    const src = e.source && typeof e.source === 'object' ? (e.source as Record<string, unknown>) : undefined;
    out.push({
      name,
      author: str(e.author) ?? str(e.creator) ?? str(e.authors) ?? (Array.isArray(e.authors) ? (e.authors as unknown[]).filter((a) => typeof a === 'string').join(', ') : undefined),
      license: str(e.license) ?? str(e.licence) ?? str(e.spdx),
      source: str(e.sourcePage) ?? str(e.url) ?? str(e.sourceUrl) ?? (typeof e.source === 'string' ? str(e.source) : str(src?.url)),
      note: str(e.note) ?? str(e.credit) ?? str(e.attribution),
    });
  }
  return out;
}

export function AboutButton() {
  const open = useAbout((s) => s.open);
  const setOpen = useAbout((s) => s.setOpen);
  const t = useT();
  return (
    <button className={`btn ghost sm ${open ? 'active' : ''}`} title={t('about.button')} aria-label={t('about.button')} data-about-button onClick={() => setOpen(!open)}>
      <Icon name="info" size={14} />
    </button>
  );
}

export function AboutDialog() {
  const open = useAbout((s) => s.open);
  const setOpen = useAbout((s) => s.setOpen);
  const t = useT();
  const [credits, setCredits] = useState<AssetCredit[] | null | 'loading'>('loading');

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  useEffect(() => {
    if (!open || credits !== 'loading') return;
    let alive = true;
    fetch(CREDITS_URL)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (alive) setCredits(j === null ? null : normalizeCredits(j)); })
      .catch(() => { if (alive) setCredits(null); });
    return () => { alive = false; };
  }, [open, credits]);

  if (!open) return null;
  const close = () => setOpen(false);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={t('about.title')} data-about-dialog style={{ width: 560, maxHeight: '86vh', overflowY: 'auto' }}>
        <div className="row" style={{ alignItems: 'baseline', gap: 8 }}>
          <h2>{t('about.title')}</h2>
          <span className="hint mono">{t('about.version', { version: webPkg.version })}</span>
          <span className="grow" />
          <button className="btn ghost sm" onClick={close} aria-label={t('about.close')} title={t('about.close')}>✕</button>
        </div>
        <div className="secondary">{t('about.tagline')}</div>

        <section data-about-section="license">
          <h3 style={{ fontSize: 13, margin: '6px 0 2px' }}>{t('about.license.title')}</h3>
          <div className="hint">{t('about.license.body')}</div>
          <a href={MIT_URL} target="_blank" rel="noopener noreferrer">{t('about.license.link')}</a>
        </section>

        <section data-about-section="notices">
          <h3 style={{ fontSize: 13, margin: '6px 0 2px' }}>{t('about.notices.title')}</h3>
          <div className="hint">{t('about.notices.body')}</div>
          <a href={NOTICES_URL} target="_blank" rel="noopener noreferrer" data-about-notices>{t('about.notices.link')}</a>
        </section>

        <section data-about-section="trademarks">
          <h3 style={{ fontSize: 13, margin: '6px 0 2px' }}>{t('about.trademarks.title')}</h3>
          <div className="hint">{t('about.trademarks.body')}</div>
          <div className="hint" style={{ marginTop: 4 }}>{t('about.trademarks.nonAffiliation')}</div>
        </section>

        {/* stream E (P5, proposal §6.3): non-affiliation notice for parameters cited from standards publications (trademark guidelines v1.7) */}
        <section data-about-section="standards">
          <h3 style={{ fontSize: 13, margin: '6px 0 2px' }}>{t('standards.ui.about.title')}</h3>
          <div className="hint" data-standards-notice>{t('standards.ui.about.notice')}</div>
        </section>

        {credits !== null && (
          <section data-about-section="credits">
            <h3 style={{ fontSize: 13, margin: '6px 0 2px' }}>{t('about.credits.title')}</h3>
            {credits === 'loading' ? (
              <div className="hint">{t('about.credits.loading')}</div>
            ) : credits.filter((c) => !isOwnCredit(c)).length === 0 ? (
              <div className="hint">{t('about.credits.none')}</div>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {credits.filter((c) => !isOwnCredit(c)).map((c, i) => (
                  <li key={`${c.name}-${i}`} className="hint">
                    <span className="mono">{c.name}</span>
                    {c.author && <> · {t('about.credits.author', { author: c.author })}</>}
                    {c.license && <> · {t('about.credits.license', { license: c.license })}</>}
                    {c.note && <> · {c.note}</>}
                    {c.source && /^https?:\/\//.test(c.source) && <> · <a href={c.source} target="_blank" rel="noopener noreferrer">{t('about.credits.source')}</a></>}
                  </li>
                ))}
              </ul>
            )}
            {credits !== 'loading' && credits.some(isOwnCredit) && (
              <div className="hint" style={{ marginTop: 4 }} data-about-own-assets>{t('about.credits.own', { count: credits.filter(isOwnCredit).length })}</div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
