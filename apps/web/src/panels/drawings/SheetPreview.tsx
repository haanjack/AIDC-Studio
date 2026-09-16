// r4 stream D — sheet preview: toolbar (identity · navigation · zoom modes · actions), pan / zoom surface (fit page from
// sheet.paper by default, fit width, 100 % at 96 dpi, manual), wheel zoom at the cursor, drag / middle-drag / Space-drag
// pan, double-click fit ↔ 100 %, minimap above 1.5 × fit, and a print portal mounted only while printing.
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { DrawingSheet, DrawingSheetMeta } from '@aidc/core';
import { useT } from '../../i18n/index.ts';
import { Icon } from '../../ui/icons.tsx';
import { A1P, fitPage, paperBadge, paperPx, screenScale, viewForMode, zoomAt, type Paper, type View, type ZoomMode } from './model.ts';

export interface PreviewHandle {
  fitPage(): void;
  fitWidth(): void;
  actual(): void;
  zoomBy(factor: number): void;
  focus(): void;
}

export interface ZipAction {
  label: string;
  title: string;
  busy: boolean;
  disabled: boolean;
  onClick(): void;
}

export interface SheetPreviewProps {
  meta: DrawingSheetMeta | undefined;
  /** built sheet (current generation) or the previous generation's build (`stale`) */
  sheet: DrawingSheet | undefined;
  stale: boolean;
  error?: string;
  zoomMode: ZoomMode;
  /** persist = an explicit choice (buttons / keys); gestures switch to manual without persisting */
  onZoomMode(mode: ZoomMode, persist: boolean): void;
  index: number;
  total: number;
  onStep(delta: number): void;
  /** stacked layout: actions collapse into a ⋯ menu */
  compact: boolean;
  leading?: ReactNode;
  kindLabel?: string;
  /** undefined = hidden (view2d store action not available or the sheet kind has no model view) */
  onOpen2D?: () => void;
  onSvg(): void;
  zip: ZipAction;
  status?: ReactNode;
}

const PRINT_CSS = (p: Paper) => `
@page { size: ${p.w}mm ${p.h}mm; margin: 0; }
.aidc-print-sheet { display: none; }
@media print {
  html, body { height: auto !important; overflow: visible !important; background: #fff !important; }
  body > *:not(.aidc-print-sheet) { display: none !important; }
  .aidc-print-sheet { display: block !important; position: absolute; left: 0; top: 0; width: ${p.w}mm; height: ${p.h}mm; background: #fff; }
  .aidc-print-sheet svg { display: block; width: ${p.w}mm !important; height: ${p.h}mm !important; }
}`;

export const SheetPreview = forwardRef<PreviewHandle, SheetPreviewProps>(function SheetPreview(props, ref) {
  const { meta, sheet, stale, error, zoomMode, onZoomMode, index, total, onStep, compact, leading, kindLabel, onOpen2D, onSvg, zip, status } = props;
  const t = useT();
  const paper: Paper = sheet?.paper ?? meta?.paper ?? A1P;
  const px = paperPx(paper);
  const viewport = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ W: 800, H: 600 });
  useLayoutEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const measure = () => setSize((s) => (s.W === el.clientWidth && s.H === el.clientHeight ? s : { W: Math.max(120, el.clientWidth), H: Math.max(120, el.clientHeight) }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const { W, H } = size;

  // manual view (page / width are derived from the paper and the viewport size on every render)
  const [manual, setManual] = useState<View | null>(null);
  const v: View = zoomMode === 'manual' && manual ? manual : viewForMode(zoomMode === 'manual' ? 'page' : zoomMode, paper, W, H);
  const last = useRef<{ view: View; paper: Paper; W: number; H: number } | null>(null);
  // manual mode keeps zoom and the relative centre across sheets and viewport resizes
  useLayoutEffect(() => {
    if (zoomMode === 'manual' && manual && last.current) setManual(viewForMode('manual', paper, W, H, last.current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta?.id, paper.w, paper.h, W, H]);
  useLayoutEffect(() => {
    last.current = { view: v, paper, W, H };
  });

  const vRef = useRef(v);
  vRef.current = v;
  const setView = (nv: View) => {
    setManual(nv);
    if (zoomMode !== 'manual') onZoomMode('manual', false);
  };
  const fit = fitPage(paper, W, H);

  useImperativeHandle(ref, () => ({
    fitPage: () => onZoomMode('page', true),
    fitWidth: () => onZoomMode('width', true),
    actual: () => {
      setManual(zoomAt(vRef.current, 1, W / 2, H / 2));
      onZoomMode('manual', true);
    },
    zoomBy: (f) => setView(zoomAt(vRef.current, vRef.current.z * f, W / 2, H / 2)),
    focus: () => viewport.current?.focus(),
  }));

  // gesture feedback: will-change while zooming / panning, removed 150 ms later so the SVG re-rasterises crisply
  const [gesture, setGesture] = useState(false);
  const gestureTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pulseGesture = () => {
    setGesture(true);
    clearTimeout(gestureTimer.current);
    gestureTimer.current = setTimeout(() => setGesture(false), 150);
  };

  // wheel zoom at the cursor (native non-passive listener so preventDefault stops page / browser zoom on ctrl+wheel)
  const wheelState = useRef({ zoomMode, onZoomMode });
  wheelState.current = { zoomMode, onZoomMode };
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      const k = Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0022));
      const cur = vRef.current;
      setManual(zoomAt(cur, cur.z * k, e.clientX - r.left, e.clientY - r.top));
      if (wheelState.current.zoomMode !== 'manual') wheelState.current.onZoomMode('manual', false);
      pulseGesture();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // pan: left drag, middle drag, Space + drag
  const drag = useRef<{ id: number; x: number; y: number; v: View } | null>(null);
  const [panning, setPanning] = useState(false);
  const [space, setSpace] = useState(false);

  // print portal (mounted only while printing; unmounted on afterprint so SVG ids never collide with the preview)
  const [printing, setPrinting] = useState(false);
  useEffect(() => {
    if (!printing) return;
    const done = () => setPrinting(false);
    window.addEventListener('afterprint', done);
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => window.print()));
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('afterprint', done);
    };
  }, [printing]);

  // minimap (blob image of the same SVG: a separate document, so its ids never collide)
  const showMinimap = !!sheet && v.z > fit.z * 1.5;
  const blobUrl = useMemo(() => (showMinimap && sheet ? URL.createObjectURL(new Blob([sheet.svg], { type: 'image/svg+xml' })) : null), [showMinimap, sheet]);
  useEffect(() => () => { if (blobUrl) URL.revokeObjectURL(blobUrl); }, [blobUrl]);
  const MM = 150;
  const mk = Math.min(MM / px.w, MM / px.h);
  const mini = { w: px.w * mk, h: px.h * mk };
  const miniRect = { x: (-v.x / v.z) * mk, y: (-v.y / v.z) * mk, w: (W / v.z) * mk, h: (H / v.z) * mk };
  const miniDrag = useRef(false);
  const panToMini = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const sx = (e.clientX - r.left) / mk; // sheet px
    const sy = (e.clientY - r.top) / mk;
    setView({ z: v.z, x: W / 2 - sx * v.z, y: H / 2 - sy * v.z });
  };

  const is100 = zoomMode === 'manual' && Math.abs(v.z - 1) < 0.005;
  const onScreen = screenScale(meta?.scale ?? sheet?.scale, v.z);
  const building = !!meta && (!sheet || stale) && !error;

  const actions = (
    <>
      {onOpen2D && <button className="btn sm" data-open-2d onClick={onOpen2D} title={t('drawings.preview.open2dTitle')}><Icon name="layers" size={13} />{t('drawings.preview.open2d')}</button>}
      <button className="btn sm" onClick={onSvg} disabled={!sheet || stale} title={t('drawings.preview.svgTitle')}><Icon name="download" size={13} />SVG</button>
      <button className={`btn sm${zip.busy ? ' active' : ''}`} data-zip onClick={zip.onClick} disabled={zip.disabled} title={zip.title}><Icon name="download" size={13} />{zip.label}</button>
      <button className="btn sm primary" onClick={() => setPrinting(true)} disabled={!sheet || stale} title={t('drawings.preview.printTitle')}><Icon name="docs" size={13} />{t('drawings.preview.print')}</button>
    </>
  );

  return (
    <div className="dwg-preview" data-zoom-mode={zoomMode}>
      <div className="dwg-toolbar">
        <div className="dwg-tb-row dwg-ident">
          {leading}
          {meta ? (
            <>
              <span className="num mono">{meta.number}</span>
              <span className="ttl" title={`${meta.title}${kindLabel ? ` · ${kindLabel}` : ''}`}>{meta.title}</span>
              <span className="badge mono" title={t('drawings.preview.paperTitle', { w: paper.w, h: paper.h })}>{sheet?.scale || meta.scale} · {paperBadge(paper)} · {Math.round(paper.w)}×{Math.round(paper.h)} mm</span>
              {building && <span className="dwg-building" role="status">{t('drawings.preview.building')}</span>}
            </>
          ) : (
            <span className="ttl secondary">{t('drawings.preview.none')}</span>
          )}
        </div>
        <div className="dwg-tb-row">
          <div className="dwg-nav">
            <button className="btn sm" onClick={() => onStep(-1)} disabled={total < 2} title={t('drawings.nav.prevKeys')} aria-label={t('drawings.nav.prev')}>◀</button>
            <span className="mono secondary dwg-pos">{index >= 0 ? index + 1 : '—'} / {total}</span>
            <button className="btn sm" onClick={() => onStep(1)} disabled={total < 2} title={t('drawings.nav.nextKeys')} aria-label={t('drawings.nav.next')}>▶</button>
          </div>
          <div className="seg dwg-zoom-modes" role="radiogroup" aria-label={t('drawings.zoom.aria')}>
            <button role="radio" aria-checked={zoomMode === 'page'} className={zoomMode === 'page' ? 'on' : ''} onClick={() => onZoomMode('page', true)} title={t('drawings.zoom.pageTitle')}>{t('drawings.zoom.page')}</button>
            <button role="radio" aria-checked={zoomMode === 'width'} className={zoomMode === 'width' ? 'on' : ''} onClick={() => onZoomMode('width', true)} title={t('drawings.zoom.widthTitle')}>{t('drawings.zoom.width')}</button>
            <button role="radio" aria-checked={is100} className={is100 ? 'on' : ''} onClick={() => { setManual(zoomAt(v, 1, W / 2, H / 2)); onZoomMode('manual', true); }} title={t('drawings.zoom.actualTitle')}>100%</button>
          </div>
          <div className="dwg-zoom">
            <button className="btn sm" onClick={() => setView(zoomAt(v, v.z / 1.25, W / 2, H / 2))} title={t('drawings.zoom.out')} aria-label={t('drawings.zoom.out')}>−</button>
            <span className="mono secondary dwg-pct" title={onScreen ? t('drawings.zoom.onScreen', { scale: onScreen }) : undefined}>{Math.round(v.z * 100)}%</span>
            <button className="btn sm" onClick={() => setView(zoomAt(v, v.z * 1.25, W / 2, H / 2))} title={t('drawings.zoom.in')} aria-label={t('drawings.zoom.in')}>+</button>
          </div>
          <span className="grow" />
          {compact ? (
            <details className="dwg-more">
              <summary className="btn sm" aria-label={t('drawings.preview.more')} title={t('drawings.preview.more')}>⋯</summary>
              <div className="dwg-more-menu glass">{actions}</div>
            </details>
          ) : (
            <div className="dwg-actions">{actions}</div>
          )}
        </div>
      </div>
      <div
        ref={viewport}
        className="dwg-viewport"
        tabIndex={0}
        data-panning={panning ? '' : undefined}
        data-space={space ? '' : undefined}
        aria-label={meta ? `${meta.number} ${meta.title}` : undefined}
        onKeyDown={(e) => {
          if (e.code === 'Space' && !e.repeat) {
            e.preventDefault();
            setSpace(true);
          }
        }}
        onKeyUp={(e) => { if (e.code === 'Space') setSpace(false); }}
        onBlur={() => setSpace(false)}
        onPointerDown={(e) => {
          if (e.button !== 0 && e.button !== 1) return;
          if ((e.target as HTMLElement).closest('.dwg-minimap')) return;
          e.preventDefault();
          e.currentTarget.focus({ preventScroll: true });
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, v };
          setPanning(true);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d || d.id !== e.pointerId) return;
          const dx = e.clientX - d.x;
          const dy = e.clientY - d.y;
          if (Math.abs(dx) + Math.abs(dy) < 2 && zoomMode !== 'manual') return;
          setView({ z: d.v.z, x: d.v.x + dx, y: d.v.y + dy });
          pulseGesture();
        }}
        onPointerUp={(e) => {
          if (drag.current?.id === e.pointerId) drag.current = null;
          setPanning(false);
        }}
        onPointerCancel={() => {
          drag.current = null;
          setPanning(false);
        }}
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest('.dwg-minimap')) return;
          const r = e.currentTarget.getBoundingClientRect();
          if (zoomMode === 'manual' && Math.abs(v.z - fit.z) > 0.001) onZoomMode('page', false);
          else setView(zoomAt(v, 1, e.clientX - r.left, e.clientY - r.top));
        }}
      >
        {sheet && (
          <div
            className="dwg-sheet"
            data-stale={stale ? '' : undefined}
            data-gesture={gesture ? '' : undefined}
            style={{ width: px.w, height: px.h, transform: `translate(${v.x}px, ${v.y}px) scale(${v.z})` }}
            // sheets are generated locally by the core (no remote content); emptied while the print portal holds the SVG
            dangerouslySetInnerHTML={{ __html: printing ? '' : sheet.svg }}
          />
        )}
        {!sheet && meta && !error && (
          <div className="dwg-placeholder" style={{ width: px.w * v.z, height: px.h * v.z, left: v.x, top: v.y }}>{t('drawings.preview.building')}</div>
        )}
        {error && <div className="dwg-error" role="alert">{t('drawings.preview.error', { msg: error })}</div>}
        {showMinimap && blobUrl && (
          <div
            className="dwg-minimap"
            style={{ width: mini.w, height: mini.h }}
            title={t('drawings.preview.minimap')}
            onPointerDown={(e) => {
              e.stopPropagation();
              e.currentTarget.setPointerCapture(e.pointerId);
              miniDrag.current = true;
              panToMini(e);
            }}
            onPointerMove={(e) => { if (miniDrag.current) panToMini(e); }}
            onPointerUp={() => (miniDrag.current = false)}
            onPointerCancel={() => (miniDrag.current = false)}
          >
            <img src={blobUrl} alt="" draggable={false} />
            <div className="dwg-minimap-rect" style={{ left: miniRect.x, top: miniRect.y, width: miniRect.w, height: miniRect.h }} />
          </div>
        )}
      </div>
      <div className="dwg-status hint">
        {status}
        {onScreen && <span> · {t('drawings.zoom.onScreen', { scale: onScreen })}</span>}
      </div>
      {printing && sheet &&
        createPortal(
          <div className="aidc-print-sheet" aria-hidden>
            <style>{PRINT_CSS(paper)}</style>
            <div dangerouslySetInnerHTML={{ __html: sheet.svg }} />
          </div>,
          document.body,
        )}
    </div>
  );
});
