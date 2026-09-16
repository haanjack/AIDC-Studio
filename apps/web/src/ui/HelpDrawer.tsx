import { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { GLOSSARY, GLOSSARY_DOMAINS, PAGE_HELP_DOCS, findTerm, searchTerms, type GlossaryTerm, type Locale, type PageHelpDoc } from '@aidc/core';
import { useApp, type PageId } from '../store/appStore.ts';
import { useI18n } from '../i18n/index.ts';
import { Markdown } from './markdown.tsx';

/**
 * Help drawer (S4, PROPOSAL-v2 §3.8; i18n by T8): right-side drawer opened from the topbar '?' with per-page explanations
 * (what the page computes, key inputs, key terms) plus the searchable glossary. Page help text is bilingual data in
 * core (`PAGE_HELP_DOCS`, also indexed by the assistant); chrome strings come from the 'shell' i18n namespace.
 * `openHelpTerm(id)` (used by <Term>) jumps straight to a term. State lives in a tiny local store.
 */
interface HelpState {
  open: boolean;
  tab: 'page' | 'glossary';
  termId: string | null;
  query: string;
  domain: string;
  openPage(): void;
  openTerm(id: string): void;
  close(): void;
  setTab(t: 'page' | 'glossary'): void;
  setTermId(id: string | null): void;
  setQuery(q: string): void;
  setDomain(d: string): void;
}
export const useHelp = create<HelpState>((set) => ({
  open: false,
  tab: 'page',
  termId: null,
  query: '',
  domain: 'all',
  openPage: () => set({ open: true, tab: 'page', termId: null }),
  openTerm: (id) => set({ open: true, tab: 'glossary', termId: id }),
  close: () => set({ open: false }),
  setTab: (tab) => set({ tab, termId: null }),
  setTermId: (termId) => set({ termId }),
  setQuery: (query) => set({ query, termId: null }),
  setDomain: (domain) => set({ domain, termId: null }),
}));
export const openHelpTerm = (id: string) => {
  useApp.getState().setAssistantOpen(false);
  useHelp.getState().openTerm(id);
};
export const toggleHelp = () => {
  const s = useHelp.getState();
  if (s.open) s.close();
  else {
    useApp.getState().setAssistantOpen(false);
    s.openPage();
  }
};

/** Per-page help (bilingual data from core). */
export const PAGE_HELP: Record<PageId, PageHelpDoc> = PAGE_HELP_DOCS;

export function HelpButton() {
  const open = useHelp((s) => s.open);
  const { t } = useI18n();
  return (
    <button className={`btn ghost sm ${open ? 'active' : ''}`} title={t('shell.help.button')} aria-label={t('shell.help.aria')} data-help-button onClick={toggleHelp}>
      <span style={{ fontWeight: 700, fontSize: 14, lineHeight: 1 }}>?</span>
    </button>
  );
}

export function HelpDrawer({ page }: { page: PageId }) {
  const s = useHelp();
  const { t, locale } = useI18n();
  useEffect(() => {
    if (!s.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') s.close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [s.open, s]);
  // r4 stream D: Shift+/ (?) toggles the drawer (shortcut sheet on the page topic); inner scopes that handle the key win
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Slash' || !e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      const el = e.target instanceof HTMLElement ? e.target : null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      e.preventDefault();
      toggleHelp();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  if (!s.open) return null;
  const help = PAGE_HELP[page];
  return (
    <aside className="help-drawer" role="dialog" aria-label={t('shell.help.aria')} data-help-drawer>
      <div className="help-head">
        <div className="seg" role="tablist">
          <button role="tab" aria-selected={s.tab === 'page'} className={s.tab === 'page' ? 'on' : ''} onClick={() => s.setTab('page')}>{t('shell.help.thisPage')}</button>
          <button role="tab" aria-selected={s.tab === 'glossary'} className={s.tab === 'glossary' ? 'on' : ''} onClick={() => s.setTab('glossary')}>{t('shell.help.glossary', { n: GLOSSARY.length })}</button>
        </div>
        <span className="grow" />
        <button className="btn ghost sm" onClick={s.close} aria-label={t('shell.help.close')}>✕</button>
      </div>
      <div className="help-body">
        {s.tab === 'page'
          ? <><PageHelpView help={help} locale={locale} onTerm={(id) => s.openTerm(id)} /><ShortcutBlock page={page} /></>
          : s.termId ? <TermDetail id={s.termId} onBack={() => s.setTermId(null)} onTerm={(id) => s.openTerm(id)} /> : <GlossaryList />}
      </div>
    </aside>
  );
}

/** r4 stream D: keyboard shortcut block per page scope (spec r4-2d-drawings-spec.md §3.3, Drawings scope). Keys are KeyboardEvent.code bindings shown as key caps. */
const SHORTCUTS: Partial<Record<PageId, { keys: string[]; label: string }[]>> = {
  drawings: [
    { keys: ['[', ']', 'PgUp', 'PgDn'], label: 'drawings.keys.prevNext' },
    { keys: ['Home', 'End'], label: 'drawings.keys.firstLast' },
    { keys: ['0'], label: 'drawings.keys.fitPage' },
    { keys: ['9'], label: 'drawings.keys.fitWidth' },
    { keys: ['1'], label: 'drawings.keys.actual' },
    { keys: ['=', '−'], label: 'drawings.keys.zoom' },
    { keys: ['/'], label: 'drawings.keys.search' },
    { keys: ['↑', '↓', '←', '→', 'Enter'], label: 'drawings.keys.tree' },
    { keys: ['F'], label: 'drawings.keys.collapse' },
    { keys: ['Space'], label: 'drawings.keys.pan' },
    { keys: ['Esc'], label: 'drawings.keys.escape' },
    { keys: ['?'], label: 'drawings.keys.help' },
  ],
};

function ShortcutBlock({ page }: { page: PageId }) {
  const { t } = useI18n();
  const rows = SHORTCUTS[page];
  // finish r4: the viewport (3D / 2D) keys apply on every page; texts are the view2d toolbar hints (spec §3.3 viewport + 2D pane scopes)
  const viewport = (
    <div className="help-section" data-help-shortcuts="viewport">
      <div className="section-title"><span>{t('view2d.modeKeys').split(/\s[—-]\s/)[0]}</span><span className="line" /></div>
      <table className="help-keys">
        <tbody>
          <tr><td><kbd>1</kbd><kbd>2</kbd><kbd>3</kbd><kbd>4</kbd><kbd>5</kbd></td><td>{t('view2d.modeKeys')}</td></tr>
          <tr><td><kbd>V</kbd><kbd>H</kbd><kbd>M</kbd><kbd>C</kbd></td><td>{t('view2d.tool.hint')}</td></tr>
          <tr><td><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd><kbd>Shift</kbd></td><td>{t('shell.viewport.orbitKeys')}</td></tr>
          <tr><td><kbd>Shift/Ctrl</kbd><kbd>Click</kbd><kbd>Drag</kbd><kbd>R</kbd></td><td>{t('shell.viewport.selectionKeys')}</td></tr>
        </tbody>
      </table>
    </div>
  );
  if (!rows) return viewport;
  return (
    <>
    {viewport}
    <div className="help-section" data-help-shortcuts={page}>
      <div className="section-title"><span>{t('drawings.keys.title')}</span><span className="line" /></div>
      <table className="help-keys">
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <td>{r.keys.map((k) => <kbd key={k}>{k}</kbd>)}</td>
              <td>{t(r.label)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    </>
  );
}

function PageHelpView({ help, locale, onTerm }: { help: PageHelpDoc; locale: Locale; onTerm: (id: string) => void }) {
  const { t } = useI18n();
  return (
    <div>
      <h2 className="help-title">{help.title[locale]}</h2>
      <div className="help-section">
        <div className="section-title"><span>{t('shell.help.computes')}</span><span className="line" /></div>
        <p>{help.computes[locale]}</p>
      </div>
      <div className="help-section">
        <div className="section-title"><span>{t('shell.help.inputs')}</span><span className="line" /></div>
        <ul>{help.inputs.map((x) => <li key={x.en}>{x[locale]}</li>)}</ul>
      </div>
      {help.tips && (
        <div className="help-section">
          <div className="section-title"><span>{t('shell.help.tips')}</span><span className="line" /></div>
          <ul>{help.tips.map((x) => <li key={x.en}>{x[locale]}</li>)}</ul>
        </div>
      )}
      <div className="help-section">
        <div className="section-title"><span>{t('shell.help.keyTerms')}</span><span className="line" /></div>
        <div className="help-terms">
          {help.terms.map((id) => {
            const term = findTerm(id);
            if (!term) return null;
            return (
              <button key={id} className="help-term" onClick={() => onTerm(id)}>
                <span className="help-term-ko">{term.term[locale]}</span>
                <span className="help-term-short">{term.short[locale]}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function GlossaryList() {
  const query = useHelp((s) => s.query);
  const domain = useHelp((s) => s.domain);
  const setQuery = useHelp((s) => s.setQuery);
  const setDomain = useHelp((s) => s.setDomain);
  const openTerm = useHelp((s) => s.openTerm);
  const { t, locale } = useI18n();
  const other: Locale = locale === 'ko' ? 'en' : 'ko';
  const list = useMemo(() => {
    const hits = new Map<string, GlossaryTerm>();
    for (const x of [...searchTerms(query, locale), ...searchTerms(query, other)]) hits.set(x.id, x);
    return [...hits.values()].filter((x) => domain === 'all' || (x.domain ?? 'general') === domain);
  }, [query, domain, locale, other]);
  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>
        <input type="text" placeholder={t('shell.help.search')} value={query} onChange={(e) => setQuery(e.target.value)} aria-label={t('shell.help.search')} />
      </div>
      <div className="row wrap" style={{ gap: 4, marginBottom: 10 }}>
        <button className={`btn sm ${domain === 'all' ? 'active' : ''}`} onClick={() => setDomain('all')}>{t('shell.help.all')}</button>
        {GLOSSARY_DOMAINS.map((d) => <button key={d} className={`btn sm ${domain === d ? 'active' : ''}`} onClick={() => setDomain(d)}>{t(`shell.domain.${d}`)}</button>)}
      </div>
      <div className="help-list">
        {list.map((x) => (
          <button key={x.id} className="help-term" onClick={() => openTerm(x.id)}>
            <span className="help-term-ko">{x.term[locale]} <small className="muted">{x.term[other]}</small></span>
            <span className="help-term-short">{x.short[locale]}</span>
          </button>
        ))}
        {!list.length && <div className="empty">{t('shell.help.noResults')}</div>}
      </div>
    </div>
  );
}

function TermDetail({ id, onBack, onTerm }: { id: string; onBack: () => void; onTerm: (id: string) => void }) {
  const { t, locale } = useI18n();
  const term: GlossaryTerm | undefined = findTerm(id);
  const [lang, setLang] = useState<Locale>(locale);
  useEffect(() => setLang(locale), [locale, id]);
  if (!term) return <div className="empty">{t('shell.help.unknownTerm', { id })}</div>;
  return (
    <div data-term-detail={id}>
      <div className="row" style={{ marginBottom: 8 }}>
        <button className="btn ghost sm" onClick={onBack}>{t('shell.help.back')}</button>
        <span className="grow" />
        <div className="seg"><button className={lang === 'ko' ? 'on' : ''} onClick={() => setLang('ko')}>KO</button><button className={lang === 'en' ? 'on' : ''} onClick={() => setLang('en')}>EN</button></div>
      </div>
      <h2 className="help-title">{term.term[lang]}</h2>
      <div className="muted" style={{ marginBottom: 8 }}>{lang === 'ko' ? term.term.en : term.term.ko}{term.domain ? ` · ${t(`shell.domain.${term.domain}`)}` : ''}</div>
      <p style={{ fontSize: 13.5, lineHeight: 1.6 }}>{term.short[lang]}</p>
      {term.long && <div className="md" style={{ fontSize: 13 }}><Markdown source={term.long[lang]} /></div>}
      {term.related?.length ? (
        <div className="help-section">
          <div className="section-title"><span>{t('shell.help.related')}</span><span className="line" /></div>
          <div className="row wrap" style={{ gap: 4 }}>
            {term.related.map((r) => { const rt = findTerm(r); return rt ? <button key={r} className="btn sm" onClick={() => onTerm(r)}>{rt.term[lang]}</button> : null; })}
          </div>
        </div>
      ) : null}
      {term.aliases?.length ? <div className="hint" style={{ marginTop: 8 }}>{t('shell.help.aliases', { list: term.aliases.join(', ') })}</div> : null}
      {term.sources?.length ? (
        <div className="help-section">
          <div className="section-title"><span>{t('shell.help.sources')}</span><span className="line" /></div>
          <ul className="hint">{term.sources.map((x) => <li key={x}>{x}</li>)}</ul>
        </div>
      ) : null}
    </div>
  );
}
