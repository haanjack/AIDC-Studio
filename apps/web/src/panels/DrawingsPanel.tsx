import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { rackElevationFileName, type DrawingSheetMeta } from '@aidc/core';
import { libraryCache, useApp } from '../store/appStore.ts';
import { downloadBlob, downloadText } from '../app/api.ts';
import { Empty } from '../ui/controls.tsx';
import { Splitter } from '../ui/Splitter.tsx';
import { useT } from '../i18n/index.ts';
import {
  LIST_W, OPEN_IN_2D_KINDS, STORE_KEYS, duOf, filterSheets, hallOf, layoutForWidth, parseFilters, parseListW, parseZoomMode,
  prebuildOrder, readLocal, resolveSelection, stepId, writeLocal, type PanelLayout, type SheetFilters, type ZoomMode,
} from './drawings/model.ts';
import { useSheets } from './drawings/useSheets.ts';
import { SheetList } from './drawings/SheetList.tsx';
import { SheetRail } from './drawings/SheetRail.tsx';
import { SheetPicker } from './drawings/SheetPicker.tsx';
import { SheetPreview, type PreviewHandle } from './drawings/SheetPreview.tsx';

/**
 * Drawing sheets panel (r4 stream D, spec r4-2d-drawings-spec.md §3.1 / r4-ux-2d.md Part A).
 * The page body is in 'fill' mode: the panel lays out its own full-height columns, switched by the panel width
 * (≥ 960 px list | preview · 640–959 px number rail with a flyout list · < 640 px stacked picker over the preview).
 * Sheets are listed and built in workers/drawings.worker.ts (every sheet kind of this round, lazily, selected ± 2, LRU 12).
 * Selection is by sheet id; the preview opens in fit-page mode from sheet.paper so the whole A1 sheet is visible.
 */

const EMPTY: DrawingSheetMeta[] = [];

type View2dOpen = (args: Record<string, unknown>) => void;

export function DrawingsPanel() {
  const project = useApp((s) => s.project);
  const analysis = useApp((s) => s.analysis);
  const notify = useApp((s) => s.notify);
  const setPanelWide = useApp((s) => s.setPanelWide);
  // C → D hand-off (spec §4.2): useApp.getState().view2d.open({ mode, hallId, frame | cutId | elevation }) — feature-detected
  const view2dOpen = useApp((s) => {
    const v = (s as unknown as { view2d?: { open?: unknown } }).view2d;
    return typeof v?.open === 'function' ? (v.open as View2dOpen) : undefined;
  });
  const t = useT();
  const sheets = useSheets(project, analysis, libraryCache);
  const all = sheets.sheets ?? EMPTY;

  // ── layout ──
  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1200);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const layout: PanelLayout = layoutForWidth(width);
  const [listW, setListW] = useState(() => parseListW(readLocal(STORE_KEYS.listW)));
  const [listCollapsed, setListCollapsedState] = useState(() => readLocal(STORE_KEYS.listCollapsed) === '1');
  const setListCollapsed = (v: boolean) => {
    setListCollapsedState(v);
    writeLocal(STORE_KEYS.listCollapsed, v ? '1' : '0');
  };
  const [flyout, setFlyout] = useState(false);
  useEffect(() => setFlyout(false), [layout]);
  const listMax = Math.max(LIST_W.min, Math.min(LIST_W.max, width - 420));

  // ── filters ──
  const [filters, setFilters] = useState<SheetFilters>(() => parseFilters(readLocal(STORE_KEYS.filters)));
  const onFilters = useCallback((patch: Partial<SheetFilters>) => {
    setFilters((f) => {
      const n = { ...f, ...patch };
      writeLocal(STORE_KEYS.filters, JSON.stringify(n));
      return n;
    });
  }, []);
  // remembered hall / DU values that this project does not have are ignored (not cleared: another project may have them)
  const eff = useMemo<SheetFilters>(() => {
    if (!all.length) return filters;
    const hall = filters.hall !== 'all' && !all.some((m) => hallOf(m) === filters.hall) ? 'all' : filters.hall;
    const du = filters.du !== 'all' && !all.some((m) => duOf(m) === filters.du && (hall === 'all' || hallOf(m) === hall)) ? 'all' : filters.du;
    return hall === filters.hall && du === filters.du ? filters : { ...filters, hall, du };
  }, [all, filters]);
  const filtered = useMemo(() => filterSheets(all, eff), [all, eff]);
  const order = useMemo(() => filtered.map((m) => m.id), [filtered]);

  // ── selection by id ──
  const [selectedId, setSelectedIdState] = useState<string | null>(() => readLocal(STORE_KEYS.sel));
  const select = useCallback((id: string | null) => {
    setSelectedIdState(id);
    writeLocal(STORE_KEYS.sel, id);
  }, []);
  const prevAll = useRef<DrawingSheetMeta[]>(EMPTY);
  const prevFiltered = useRef<DrawingSheetMeta[]>(EMPTY);
  // backlog T2 #7: a search that hides the selected sheet moves the selection to a hit, but the sheet selected before the search is
  // remembered and comes back when the search is cleared — unless the user picked another sheet meanwhile
  const preSearch = useRef<string | null>(null);
  const searching = eff.q.trim().length > 0;
  const wasSearching = useRef(searching);
  const pick = useCallback((id: string | null) => {
    preSearch.current = null;
    select(id);
  }, [select]);
  useEffect(() => {
    if (!sheets.sheets) return;
    if (searching && !wasSearching.current) preSearch.current = selectedId;
    if (!searching && wasSearching.current) {
      const back = preSearch.current;
      preSearch.current = null;
      wasSearching.current = false;
      if (back && back !== selectedId && filtered.some((m) => m.id === back)) {
        select(back);
        prevAll.current = all;
        prevFiltered.current = filtered;
        return;
      }
    }
    wasSearching.current = searching;
    // a search with no hit keeps the selection (clearing the search shows it again)
    if (filtered.length) {
      const res = resolveSelection(prevFiltered.current.length ? prevFiltered.current : all, filtered, selectedId);
      if (res.id !== selectedId) {
        const was = selectedId ? prevAll.current.find((m) => m.id === selectedId) : undefined;
        const vanished = !!was && !all.some((m) => m.id === selectedId);
        const now = all.find((m) => m.id === res.id);
        if (vanished && now) notify(t('drawings.toast.selectionMoved', { from: was!.number, to: now.number }), 'info');
        select(res.id);
      }
    }
    prevAll.current = all;
    prevFiltered.current = filtered;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, filtered]);
  const meta = selectedId ? all.find((m) => m.id === selectedId) : undefined;
  const index = selectedId ? order.indexOf(selectedId) : -1;
  const step = useCallback((d: number) => {
    const id = stepId(order, selectedId, d);
    if (id) pick(id);
  }, [order, selectedId, pick]);

  // ── lazy build: selected ± 2 ──
  const wantRef = useRef(sheets.want);
  wantRef.current = sheets.want;
  useEffect(() => {
    if (sheets.sheets && selectedId && all.some((m) => m.id === selectedId)) wantRef.current(prebuildOrder(order, selectedId));
  }, [sheets.key, sheets.sheets, selectedId, order, all]);
  const built = selectedId ? sheets.get(selectedId) : undefined;
  const staleSheet = !built && selectedId ? sheets.getStale(selectedId) : undefined;
  const sheet = built ?? staleSheet;

  // ── zoom mode (remembered) ──
  const [zoomMode, setZoomMode] = useState<ZoomMode>(() => parseZoomMode(readLocal(STORE_KEYS.zoomMode)));
  const onZoomMode = useCallback((m: ZoomMode, persist: boolean) => {
    setZoomMode(m);
    if (persist) writeLocal(STORE_KEYS.zoomMode, m);
  }, []);
  const preview = useRef<PreviewHandle>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // ── actions ──
  const onSvg = () => {
    if (!built) return;
    downloadText(built.svg, `${project.id}-${rackElevationFileName(built).replace(/\//g, '_')}`, 'image/svg+xml');
  };
  const [zipProgress, setZipProgress] = useState<{ done: number; total: number } | null>(null);
  const onZip = () => {
    if (zipProgress) {
      sheets.cancelZip();
      setZipProgress(null);
      return;
    }
    if (!order.length) return;
    setZipProgress({ done: 0, total: order.length });
    sheets
      .zip(order, project.id, project.name, (done, total) => setZipProgress({ done, total }))
      .then(({ blob, files }) => {
        downloadBlob(blob, `${project.id}-drawings${filtered.length < all.length ? '-filtered' : ''}.zip`);
        notify(t('drawings.toast.zipExported', { n: files }), 'ok');
      })
      .catch((e: Error) => {
        if (e.message !== 'cancelled') notify(t('drawings.toast.zipFailed', { msg: e.message }), 'error');
      })
      .finally(() => setZipProgress(null));
  };
  const onOpen2D = view2dOpen && meta && OPEN_IN_2D_KINDS.has(meta.kind)
    ? () => {
        const vp = built?.viewports?.[0];
        const args: Record<string, unknown> = vp
          ? { mode: vp.space, hallId: vp.hallId, ...(vp.worldRect ? { frame: vp.worldRect } : {}), ...(vp.cutId ? { cutId: vp.cutId } : {}), ...(vp.cut ? { cut: vp.cut } : {}), ...(vp.elevation ? { elevation: vp.elevation } : {}) }
          : { mode: meta.kind === 'section' ? 'section' : meta.kind === 'elevation' ? 'elevation' : 'plan', hallId: meta.hallId ?? project.halls[0]?.id };
        if (useApp.getState().panelWide) setPanelWide(false);
        view2dOpen(args);
      }
    : undefined;

  const kindLabel = useCallback((m: DrawingSheetMeta) => t(m.group && m.group.zone !== 'type' ? 'drawings.kind.rack-row' : `drawings.kind.${m.kind}`), [t]);
  const hallName = useCallback((id: string) => project.halls.find((h) => h.id === id)?.name ?? id, [project.halls]);
  const onToggleRef = useRef<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  onToggleRef.current = expanded;
  const onToggle = useCallback((key: string, open: boolean) => setExpanded((e) => ({ ...e, [key]: open })), []);

  // ── keys (Drawings scope, spec §3.3): capture phase so fly keys / global handlers never see a handled key ──
  const keyState = useRef({ layout, listCollapsed, flyout, step, order, select, pick });
  keyState.current = { layout, listCollapsed, flyout, step, order, select, pick };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const root = rootRef.current;
      if (!root || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      const inRoot = !!target && root.contains(target);
      const onBody = !target || target === document.body;
      if (!inRoot && !(onBody && useApp.getState().page === 'drawings')) return;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
      const inTree = !!target?.closest('.dwg-tree');
      const inPreview = !!target?.closest('.dwg-viewport');
      const k = keyState.current;
      switch (e.code) {
        case 'BracketLeft':
        case 'PageUp':
          k.step(-1);
          break;
        case 'BracketRight':
        case 'PageDown':
          k.step(1);
          break;
        case 'Home':
        case 'End':
          if (inTree || !(inPreview || onBody) || !k.order.length) return;
          k.pick(e.code === 'Home' ? k.order[0] : k.order[k.order.length - 1]);
          break;
        case 'Digit0':
        case 'Numpad0':
          preview.current?.fitPage();
          break;
        case 'Digit9':
        case 'Numpad9':
          preview.current?.fitWidth();
          break;
        case 'Digit1':
        case 'Numpad1':
          preview.current?.actual();
          break;
        case 'Equal':
        case 'NumpadAdd':
          preview.current?.zoomBy(1.25);
          break;
        case 'Minus':
        case 'NumpadSubtract':
          preview.current?.zoomBy(1 / 1.25);
          break;
        case 'Slash':
          if (e.shiftKey) return; // Shift+/ = shortcut sheet (HelpDrawer)
          if (k.layout === 'rail' || (k.layout === 'two-col' && k.listCollapsed)) {
            if (k.layout === 'two-col') setListCollapsed(false);
            else setFlyout(true);
            setTimeout(() => searchRef.current?.focus(), 0);
          } else searchRef.current?.focus();
          break;
        case 'KeyF':
          // toggle the list (two columns) only from the preview and when nothing is selected in the 3D store ('f' = focus selection)
          if (k.layout !== 'two-col' || !inPreview || e.shiftKey || useApp.getState().selection.length) return;
          setListCollapsed(!k.listCollapsed);
          break;
        case 'Escape':
          if (!k.flyout) return; // fall through to the global Escape
          setFlyout(false);
          break;
        default:
          return;
      }
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const listEl = (autoFocus: boolean, onPicked?: () => void) => (
    <SheetList
      all={all}
      filtered={filtered}
      filters={eff}
      onFilters={onFilters}
      selectedId={selectedId}
      onSelect={(id) => {
        pick(id);
        onPicked?.();
      }}
      expanded={expanded}
      onToggle={onToggle}
      hallName={hallName}
      kindLabel={kindLabel}
      searchRef={searchRef}
      onEscape={onPicked}
      autoFocus={autoFocus}
    />
  );

  const buildMs = selectedId ? sheets.buildMs(selectedId) : undefined;
  const status = (
    <span>
      {sheets.listing && sheets.sheets ? `${t('drawings.status.updating')} · ` : ''}
      {t('drawings.status.line', { n: all.length, lang: t(project.locale === 'ko' ? 'drawings.lang.ko' : 'drawings.lang.en'), list: sheets.listMs.toFixed(0), build: buildMs !== undefined ? buildMs.toFixed(0) : '—' })}
      {layout !== 'stacked' ? ` · ${t('drawings.status.hint')}` : ''}
    </span>
  );

  let body;
  if (sheets.listError && !sheets.sheets) body = <Empty>{t('drawings.listError', { msg: sheets.listError })}</Empty>;
  else if (!sheets.sheets) body = <div className="dwg-listing hint">{t('drawings.listing')}</div>;
  else if (!all.length) body = <Empty>{t('drawings.empty')}</Empty>;
  else
    body = (
      <SheetPreview
        ref={preview}
        meta={meta}
        sheet={sheet}
        stale={!built && !!staleSheet}
        error={selectedId ? sheets.buildError(selectedId) : undefined}
        zoomMode={zoomMode}
        onZoomMode={onZoomMode}
        index={index}
        total={order.length}
        onStep={step}
        compact={layout === 'stacked'}
        kindLabel={meta ? kindLabel(meta) : undefined}
        leading={layout === 'two-col' && !listCollapsed ? (
          <button className="btn ghost sm" data-collapse-list onClick={() => setListCollapsed(true)} title={t('drawings.list.collapse')} aria-label={t('drawings.list.collapse')}>⇤</button>
        ) : undefined}
        onOpen2D={onOpen2D}
        onSvg={onSvg}
        zip={{
          label: zipProgress ? t('drawings.zip.progress', { done: zipProgress.done, total: zipProgress.total }) : t('drawings.zip.label', { n: order.length }),
          title: zipProgress ? t('drawings.zip.cancelTitle') : t(filtered.length < all.length ? 'drawings.zip.titleFiltered' : 'drawings.zip.title', { n: order.length }),
          busy: !!zipProgress,
          disabled: !order.length,
          onClick: onZip,
        }}
        status={status}
      />
    );

  return (
    <div ref={rootRef} className="dwg-root" data-layout={layout} data-keyscope="drawings" data-drawings-root>
      {layout === 'stacked' && sheets.sheets && all.length > 0 && (
        <SheetPicker all={all} filtered={filtered} filters={eff} onFilters={onFilters} selectedId={selectedId} onSelect={pick} onStep={step} hallName={hallName} searchRef={searchRef} />
      )}
      {layout === 'two-col' && !listCollapsed && (
        <>
          <div className="dwg-list" style={{ width: Math.min(listW, listMax) }} data-drawings-list>
            {listEl(false)}
          </div>
          <Splitter value={Math.min(listW, listMax)} min={LIST_W.min} max={listMax} defaultValue={LIST_W.default} onChange={setListW} onCommit={(v) => writeLocal(STORE_KEYS.listW, String(Math.round(v)))} ariaLabel={t('drawings.list.resize')} />
        </>
      )}
      {(layout === 'rail' || (layout === 'two-col' && listCollapsed)) && (
        <SheetRail
          filtered={filtered}
          selectedId={selectedId}
          onSelect={pick}
          flyoutOpen={flyout}
          onFlyout={setFlyout}
          flyout={listEl(true, () => setFlyout(false))}
          onExpandList={layout === 'two-col' ? () => setListCollapsed(false) : undefined}
        />
      )}
      <div className="dwg-main">{body}</div>
    </div>
  );
}
