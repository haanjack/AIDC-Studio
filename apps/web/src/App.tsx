import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { findCatalogItem } from '@aidc/core';
import { useApp, type PageId } from './store/appStore.ts';
import { THERMAL_COLORMAP } from './viewer/index.ts';
import { inletValues, rackPowerValues, equipmentKW } from './app/derived.ts';
import { fmtPower } from './app/format.ts';
import { Icon, type IconName } from './ui/icons.tsx';
import { Select } from './ui/controls.tsx';
import { OverviewPanel } from './panels/OverviewPanel.tsx';
import { SitePanel } from './panels/SitePanel.tsx';
import { LayoutPanel } from './panels/LayoutPanel.tsx';
import { PowerPanel } from './panels/PowerPanel.tsx';
import { CoolingPanel } from './panels/CoolingPanel.tsx';
import { NetworkPanel } from './panels/NetworkPanel.tsx';
import { WorkloadPanel } from './panels/WorkloadPanel.tsx';
import { ArchitecturePanel } from './panels/ArchitecturePanel.tsx';
import { CostPanel } from './panels/CostPanel.tsx';
import { SchedulePanel } from './panels/SchedulePanel.tsx';
import { DocsPanel } from './panels/DocsPanel.tsx';
import { CatalogPanel } from './panels/CatalogPanel.tsx';
import { DrawingsPanel } from './panels/DrawingsPanel.tsx';
import { HelpButton, HelpDrawer } from './ui/HelpDrawer.tsx';
// neutralization N3: About dialog (version · MIT · third-party notices · trademarks · asset credits)
import { AboutButton, AboutDialog } from './ui/AboutDialog.tsx';
// v2 2차 contract slots (render nothing until T5 / T8 fill them)
import { PanelCollapseButton, PanelCollapseHandle } from './ui/PanelCollapse.tsx';
import { UiLocaleSelect } from './i18n/UiLocaleSelect.tsx';
import { AssistantButton, AssistantDrawer } from './ui/AssistantDrawer.tsx';
import type { Locale } from '@aidc/core';
// T8: UI i18n (namespace 'shell') + collaboration topbar (lock badge · versions · copy link)
import { useT } from './i18n/index.ts';
import { CollabOverlays, CollabTopbar, ReadOnlyBanner, ReadOnlyFieldset, useReadOnly } from './ui/Collab.tsx';
import { HallDialogs, HallTopbarControls } from './ui/HallMenu.tsx';
// v2-2 project management: project dropdown (<New…> · [Delete] · Recently deleted…) + dialogs
import { ProjectDialogs, ProjectTopbar } from './ui/ProjectMenu.tsx';
// r4 contract: the viewport panes (3D today; Plan · Section · Elevation · Split next) and their toolbar live in apps/web/src/viewport
import { ViewportPanes } from './viewport/ViewportPanes.tsx';
import { ViewportToolbar } from './viewport/ViewportToolbar.tsx';

/** r4: 'scroll' = the panel body scrolls (today); 'fill' = the page lays out its own full-height columns (Drawings, stream D). */
type PageBodyMode = 'scroll' | 'fill';

// label/title/sub are i18n keys (apps/web/src/i18n/locales/*/shell.ts)
const PAGES: { id: PageId; label: string; icon: IconName; title: string; sub: string; bodyMode: PageBodyMode; render: () => ReactNode }[] = (
  [
    ['overview', () => <OverviewPanel />], ['workload', () => <WorkloadPanel />], ['architecture', () => <ArchitecturePanel />], ['site', () => <SitePanel />],
    ['layout', () => <LayoutPanel />], ['power', () => <PowerPanel />], ['network', () => <NetworkPanel />], ['cooling', () => <CoolingPanel />],
    ['cost', () => <CostPanel />], ['schedule', () => <SchedulePanel />], ['drawings', () => <DrawingsPanel />], ['docs', () => <DocsPanel />],
    ['catalog', () => <CatalogPanel />],
  ] as [PageId, () => ReactNode][]
).map(([id, render]) => ({ id, label: `shell.nav.${id}`, icon: id as IconName, title: `shell.page.${id}.title`, sub: `shell.page.${id}.sub`, bodyMode: (id === 'drawings' ? 'fill' : 'scroll') as PageBodyMode, render }));

const LOCALES: { value: Locale; label: string }[] = [{ value: 'en', label: 'EN' }, { value: 'ko', label: 'KO' }];
const NAV_STAGE_START = new Set<PageId>(['workload', 'cost', 'catalog']);

// r4 stream D: the non-wide panel width and the wide / 3D choice are remembered per page (localStorage, try/catch)
const PANEL_W_KEY = (p: PageId) => `aidc:panelW:${p}`;
const PANEL_WIDE_KEY = (p: PageId) => `aidc:panelWide:${p}`;
function readPanelLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writePanelLocal(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage blocked: defaults next time */
  }
}
function readPanelWidth(p: PageId): number | null {
  const n = Number(readPanelLocal(PANEL_W_KEY(p)));
  return Number.isFinite(n) && n >= 380 ? n : null;
}
/** QA r4 panel: the Drawings list sits left of the sheet from 960 px of panel content (`drawings/model.ts layoutForWidth`). Its
 *  non-wide default is wide enough for two columns when the 3D viewport keeps ≥ 380 px (1440 px windows and up); else 600 px. */
const DRAWINGS_TWO_COL_PANEL_W = 964;
function defaultPanelWidth(p: PageId): number {
  if (p !== 'drawings' || typeof window === 'undefined') return 600;
  const room = window.innerWidth - 64 - DRAWINGS_TWO_COL_PANEL_W;
  return room >= 380 && DRAWINGS_TWO_COL_PANEL_W <= window.innerWidth * 0.7 ? DRAWINGS_TWO_COL_PANEL_W : 600;
}
function readPanelWide(p: PageId): boolean | null {
  const v = readPanelLocal(PANEL_WIDE_KEY(p));
  return v === '1' ? true : v === '0' ? false : null;
}

function gradientCss() {
  const { x, rgba } = THERMAL_COLORMAP;
  return `linear-gradient(to right, ${x.map((p, i) => `rgb(${Math.round(rgba[i][0] * 255)},${Math.round(rgba[i][1] * 255)},${Math.round(rgba[i][2] * 255)}) ${(p * 100).toFixed(1)}%`).join(', ')})`;
}

export function App() {
  const s = useApp();
  const t = useT();
  const readOnly = useReadOnly();
  const {
    project, hallId, page, panelWide, overlays, colorMode, selection, analysis, thermal, toast,
  } = s;
  const [panelWidths, setPanelWidths] = useState<Partial<Record<PageId, number>>>({});
  const panelWidth = panelWidths[page] ?? readPanelWidth(page) ?? defaultPanelWidth(page);
  const pageRef = useRef(page);
  pageRef.current = page;
  const lastWidth = useRef(0);
  const dragging = useRef(false);
  const current = PAGES.find((p) => p.id === page) ?? PAGES[0];

  useEffect(() => {
    void s.init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const st = useApp.getState();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) st.redo();
        else st.undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        st.redo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void st.save();
      } else if (e.key === 'Escape') {
        st.select(null);
        st.setEditMode(false);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && !e.defaultPrevented && st.selection.length && st.page === 'layout') {
        const ids = st.selection;
        st.update((d) => { d.equipment = d.equipment.filter((x) => !ids.includes(x.id)); });
        st.select(null);
      } else if (e.key.toLowerCase() === 'r' && st.selection.length && st.editMode) {
        const ids = st.selection;
        st.update((d) => { d.equipment.filter((x) => ids.includes(x.id)).forEach((x) => { x.rotationDeg = ((x.rotationDeg + 90) % 360) as 0 | 90 | 180 | 270; }); });
      } else if (e.key === 'f' && st.selection.length === 1) {
        st.viewerApi?.focusEquipment(st.selection[0]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!dragging.current) return;
      const w = Math.round(Math.max(380, Math.min(window.innerWidth * 0.7, e.clientX - 64)));
      lastWidth.current = w;
      setPanelWidths((m) => ({ ...m, [pageRef.current]: w }));
    };
    const up = () => {
      if (!dragging.current) return;
      dragging.current = false;
      delete document.body.dataset.panelResizing;
      if (lastWidth.current) writePanelLocal(PANEL_W_KEY(pageRef.current), String(lastWidth.current));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
  }, []);

  // r4 stream D: a remembered wide / 3D choice for the page wins over the page default (setPage applies the default)
  useLayoutEffect(() => {
    const w = readPanelWide(page);
    if (w !== null && w !== useApp.getState().panelWide) useApp.getState().setPanelWide(w);
  }, [page]);

  const rack = useMemo(() => {
    if (colorMode === 'power') return rackPowerValues(project, hallId);
    if (colorMode === 'inlet-temp') return inletValues(thermal.metrics);
    return null;
  }, [colorMode, project, hallId, thermal.metrics]);

  const field = thermal.result && thermal.result.options.hallId === hallId ? thermal.result : null;
  const summary = analysis?.summary;
  const selectedEq = selection.length === 1 ? project.equipment.find((e) => e.id === selection[0]) : undefined;
  const selectedItem = selectedEq ? findCatalogItem(selectedEq.catalogId) : undefined;

  return (
    <div className="app">
      <header className="topbar" data-readonly={readOnly ? '' : undefined}>
        <div className="brand"><div className="brand-mark">AI</div>AIDC Studio <small>{t('shell.topbar.brandSub')}</small></div>
        <ProjectTopbar />
        <HallTopbarControls />
        {/* T8: deliverable language (project.locale) and UI language (uiLocale) are separate, labelled selects */}
        <label className="topbar-lang" title={t('shell.topbar.docLangTitle')} data-doc-locale-select>
          <span className="topbar-lang-label">{t('shell.topbar.docLang')}</span>
          <div style={{ width: 62 }}><Select value={project.locale ?? 'en'} options={LOCALES} onChange={(v) => s.setLocale(v)} /></div>
        </label>
        <UiLocaleSelect />
        <button className="btn ghost sm" title={t('shell.topbar.reset')} disabled={readOnly} onClick={() => { if (window.confirm(t('shell.topbar.resetConfirm', { name: project.name }))) void s.resetProjectToTemplate('reference'); }}><Icon name="refresh" size={15} /></button>
        <button className="btn ghost sm" title={t('shell.topbar.undo')} disabled={readOnly || !s.past.length} onClick={s.undo}><Icon name="undo" size={15} /></button>
        <button className="btn ghost sm" title={t('shell.topbar.redo')} disabled={readOnly || !s.future.length} onClick={s.redo}><Icon name="redo" size={15} /></button>
        <span className="spacer" />
        {summary && (
          <button className={`pill ${summary.errors ? 'bad' : summary.warnings ? 'warn' : 'good'}`} style={{ cursor: 'pointer' }} onClick={() => s.setPage('overview')} title={t('shell.topbar.analysisMs', { ms: s.analysisMs.toFixed(0) })}>
            <span className="dot" />{summary.errors ? t('shell.topbar.errors', { n: summary.errors }) : ''}{summary.errors && summary.warnings ? ' · ' : ''}{summary.warnings ? t('shell.topbar.warnings', { n: summary.warnings }) : ''}{!summary.errors && !summary.warnings ? t('shell.topbar.validated') : ''}
          </button>
        )}
        {s.analysisError && <span className="pill bad" title={s.analysisError}><span className="dot" />{t('shell.topbar.engineWaiting')}</span>}
        {summary && <span className="pill kpi-pill"><span className="dot" style={{ background: 'var(--accent)' }} />{summary.gpus.toLocaleString()} GPU · {summary.itMW.toFixed(1)} MW IT · PUE {summary.pue.toFixed(2)}</span>}
        <span className={`pill ${s.serverOnline ? 'good' : 'warn'}`} title={s.serverOnline ? t('shell.topbar.serverConnected') : t('shell.topbar.offlineMode')}>
          <span className="dot" />{s.dirty ? t('shell.topbar.savePending') : s.savedAt ? t('shell.topbar.saved') : s.serverOnline ? t('shell.topbar.server') : t('shell.topbar.local')}
        </span>
        <CollabTopbar />
        <button className="btn sm" onClick={() => void s.save()} title={t('shell.topbar.save')}><Icon name="save" size={14} /></button>
        <AssistantButton />
        <HelpButton />
        <AboutButton />
      </header>

      {/* T5 (F4): a collapsed panel always shows the viewport, even on pages that open wide */}
      <div className={`main ${panelWide && !s.panelCollapsed ? 'wide' : ''} ${s.panelCollapsed ? 'collapsed' : ''}`}>
        <PanelCollapseHandle />
        <nav className="nav">
          {PAGES.map((p) => (
            <button key={p.id} data-stage-start={NAV_STAGE_START.has(p.id) ? '' : undefined} className={page === p.id ? 'active' : ''} onClick={() => { s.setPage(p.id); const w = readPanelWide(p.id); if (w !== null) s.setPanelWide(w); }} title={t(p.title)}>
              <Icon name={p.icon} />
              {t(p.label)}
            </button>
          ))}
        </nav>

        <section className="panel" style={panelWide ? undefined : { width: panelWidth }}>
          <div className="panel-head">
            <div style={{ minWidth: 0 }}>
              <h1>{t(current.title)}</h1>
              <div className="sub">{t(current.sub)}</div>
            </div>
            <span className="spacer" style={{ flex: 1 }} />
            <PanelCollapseButton />
            <button className="btn ghost sm" onClick={() => { writePanelLocal(PANEL_WIDE_KEY(page), panelWide ? '0' : '1'); s.setPanelWide(!panelWide); }} title={panelWide ? t('shell.panel.showViewport') : t('shell.panel.expand')}>
              <Icon name={panelWide ? 'collapse' : 'expand'} size={15} />{panelWide ? t('shell.panel.view3d') : t('shell.panel.wide')}
            </button>
          </div>
          {/* polish v2 2차: read-only while another holder has the edit lock — navigation, view toggles, downloads and the assistant stay usable */}
          <div className="panel-body" data-fill={current.bodyMode === 'fill' ? '' : undefined}>
            <ReadOnlyBanner />
            <ReadOnlyFieldset readOnly={readOnly && page !== 'drawings'}>{current.render()}</ReadOnlyFieldset>
          </div>
          <div
            className="panel-resize"
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              // no text selection while dragging (QA halls-ipmap O5): preventDefault + body[data-panel-resizing] user-select none
              e.preventDefault();
              window.getSelection()?.removeAllRanges();
              dragging.current = true;
              lastWidth.current = 0;
              document.body.dataset.panelResizing = '';
            }}
          />
        </section>

        <section className="viewport">
          <ViewportPanes field={field} fieldAnchor={undefined} rackValues={rack?.values} rackValueRange={rack?.range} />
          <ViewportToolbar />

          {(overlays.thermal.mode !== 'off' && field) || colorMode === 'inlet-temp' || colorMode === 'power' ? (
            <div className="viewport-legend glass" style={{ padding: '8px 10px', width: 240 }}>
              <div className="secondary" style={{ fontSize: 11.5, marginBottom: 4 }}>
                {colorMode === 'power' ? t('shell.legend.rackPower') : colorMode === 'inlet-temp' ? t('shell.legend.rackInlet') : t('shell.legend.airTemp')}
              </div>
              <div style={{ height: 8, borderRadius: 4, background: gradientCss() }} />
              <div className="row" style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                <span>{colorMode === 'power' || colorMode === 'inlet-temp' ? rack?.range[0] : overlays.thermal.rangeC[0]}</span>
                <span className="grow" />
                <span>{colorMode === 'power' || colorMode === 'inlet-temp' ? rack?.range[1] : overlays.thermal.rangeC[1]}</span>
              </div>
            </div>
          ) : null}

          {selectedEq && selectedItem && page !== 'layout' && (
            <div className="viewport-inspector glass" style={{ padding: 10 }}>
              <div className="row"><strong className="mono">{selectedEq.tag}</strong><span className="grow" /><button className="btn ghost sm" onClick={() => s.select(null)}>✕</button></div>
              <div className="secondary">{selectedItem.name}</div>
              <div className="hint" style={{ marginTop: 4 }}>
                {fmtPower(equipmentKW(selectedEq.catalogId, selectedEq.loadFactor ?? 1))} · ({selectedEq.position.x.toFixed(2)}, {selectedEq.position.y.toFixed(2)}) m · {selectedEq.rotationDeg}°
              </div>
              {thermal.metrics?.racks.find((r) => r.id === selectedEq.id) && (
                <div className="hint">{t('shell.inspector.inlet', { inlet: thermal.metrics.racks.find((r) => r.id === selectedEq.id)!.inletMaxC.toFixed(1), exhaust: thermal.metrics.racks.find((r) => r.id === selectedEq.id)!.exhaustC.toFixed(1) })}</div>
              )}
              <button className="btn sm" style={{ marginTop: 6 }} onClick={() => s.setPage('layout')}>{t('shell.inspector.editInLayout')}</button>
            </div>
          )}
        </section>
      </div>

      <HelpDrawer page={page} />
      <AboutDialog />
      <AssistantDrawer />
      <CollabOverlays />
      <HallDialogs />
      <ProjectDialogs />

      {toast && (
        <div className={`toast ${toast.kind}`} role="status">
          <Icon name={toast.kind === 'error' ? 'error' : toast.kind === 'ok' ? 'check' : 'info'} />
          {toast.text}
        </div>
      )}
    </div>
  );
}
