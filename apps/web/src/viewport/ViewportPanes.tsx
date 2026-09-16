// r4 stream C (spec §3.2, S2): viewport panes — 3D · Plan · Section · Elevation, and Split (3D + 2D with a Splitter). Available on
// every page. Mode keys Digit1–5 are scoped to the viewport (a focused / hovered pane, data-keyscope view3d | view2d).
import { Component, useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { useApp } from '../store/appStore.ts';
import { Viewer3D } from '../viewer/index.ts';
import { usePowerScenarioResult } from '../panels/PowerPanel.tsx';
import { t as tNow } from '../i18n/index.ts';
import { Splitter } from '../ui/Splitter.tsx';
import { View2DPane } from '../view2d/View2DPane.tsx';
import { hoverViewportKeyAction, viewportKeyAction, type ViewportKeyAction } from '../view2d/keyscope.ts';
import { rowGroupsFromEquipment } from '@aidc/core';
import { crossSectionThroughEquipment, longSectionThroughRow } from '../view2d/cutTool.ts';

type ViewerProps = ComponentProps<typeof Viewer3D>;

class ViewerBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: Error) {
    return { error: e.message };
  }
  render() {
    if (this.state.error)
      return (
        <div className="empty" style={{ margin: 40 }}>
          {tNow('shell.viewport.error')}<br />
          <span className="mono">{this.state.error}</span><br />
          <button className="btn sm" style={{ marginTop: 10 }} onClick={() => this.setState({ error: null })}>{tNow('shell.viewport.retry')}</button>
        </div>
      );
    return this.props.children;
  }
}

export interface ViewportPanesProps {
  field: ViewerProps['field'];
  fieldAnchor: ViewerProps['fieldAnchor'];
  rackValues?: ViewerProps['rackValues'];
  rackValueRange?: ViewerProps['rackValueRange'];
}

function View3DPane({ field, fieldAnchor, rackValues, rackValueRange }: ViewportPanesProps) {
  const s = useApp();
  const powerScenarioResult = usePowerScenarioResult(); // T3 power plane scenario → 3D overlay
  const { project, hallId, overlays, colorMode, selection, editMode, cameraPreset, cameraNonce, analysis, previewProject } = s;
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={ref}
      className="v3d-pane"
      data-keyscope="view3d"
      tabIndex={-1}
      onPointerDown={() => ref.current?.focus({ preventScroll: true })}
      onPointerEnter={() => {
        const a = document.activeElement;
        if (!a || a === document.body || ref.current?.closest('.viewport')?.contains(a)) ref.current?.focus({ preventScroll: true });
      }}
    >
      <ViewerBoundary>
        <Viewer3D
          project={previewProject ?? project}
          hallId={hallId}
          analysis={analysis}
          field={field}
          fieldAnchor={fieldAnchor}
          airReturnMode={s.thermal.options.includePlenum !== false && s.thermal.options.coolerReturn !== 'top' ? 'plenum' : 'top'}
          overlays={overlays}
          colorMode={colorMode}
          rackValues={rackValues}
          rackValueRange={rackValueRange}
          selection={selection}
          onSelect={(id, additive) => s.select(id, additive)}
          editMode={editMode}
          onMoveEquipment={(moves) => s.update((d) => { for (const move of moves) { const e = d.equipment.find((x) => x.id === move.id); if (e) e.position = move.position; } })}
          cameraPreset={cameraPreset}
          cameraNonce={cameraNonce}
          cameraMode={s.cameraMode}
          onReady={(api) => s.setViewerApi(api)}
          powerScenario={powerScenarioResult}
          powerHighlightIds={s.powerHighlight}
        />
      </ViewerBoundary>
    </div>
  );
}

export function ViewportPanes(props: ViewportPanesProps) {
  const panelWide = useApp((s) => s.panelWide);
  const panelCollapsed = useApp((s) => s.panelCollapsed);
  const v = useApp((s) => s.view2d);
  const rootRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 1000, h: 800 });

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  });

  // Digit1–5 (viewport scope): 3D · Plan · Section · Elevation · Split — in a focused pane, or in the hovered viewport while focus
  // sits outside every key scope (QA r4 view2d: after clicking a panel button, hovering the viewport and pressing 2 did nothing)
  const hovered = useRef(false);
  useEffect(() => {
    const el = rootRef.current;
    const apply = (a: ViewportKeyAction, e: KeyboardEvent) => {
      const st = useApp.getState();
      const view = st.view2d;
      if (a.kind === 'split') view.toggleSplit();
      else {
        if (a.mode === 'section') {
          const p = st.previewProject ?? st.project;
          const rows = rowGroupsFromEquipment(st.hallId, p.equipment);
          const selected = p.equipment.find((q) => q.id === st.selection.at(-1));
          const selectedCut = selected ? crossSectionThroughEquipment(selected, rows) : null;
          const hallCuts = view.cuts.filter((c) => c.hallId === st.hallId);
          if (!hallCuts.length) {
            const made = view.addCuts([...(selectedCut ? [selectedCut] : []), ...rows.map((row) => longSectionThroughRow(row))]);
            if (selectedCut && made[0]) view.set({ activeCutId: made[0].id });
          } else if (selected && selectedCut) {
            const existing = hallCuts.find((c) => c.kind === 'pod-transverse' && c.anchorId === selected.id);
            const cut = existing ?? view.addCut(selectedCut);
            view.set({ activeCutId: cut.id });
          }
        }
        view.setMode(a.mode);
      }
      e.preventDefault();
      e.stopPropagation();
    };
    const onKey = (e: KeyboardEvent) => {
      const a = viewportKeyAction(e);
      if (a) apply(a, e);
    };
    const onWindowKey = (e: KeyboardEvent) => {
      if (!hovered.current) return;
      const a = hoverViewportKeyAction(e);
      if (a) apply(a, e);
    };
    el?.addEventListener('keydown', onKey);
    window.addEventListener('keydown', onWindowKey);
    return () => {
      el?.removeEventListener('keydown', onKey);
      window.removeEventListener('keydown', onWindowKey);
    };
  });

  // T5 (F4): a collapsed panel always shows the viewport, even on pages that open wide
  if (panelWide && !panelCollapsed) return null;

  const is2d = v.mode !== '3d';
  const split = is2d && v.split;
  const vertical = v.splitAxis === 'v' || (v.splitAxis === 'auto' && size.w < size.h * 1.2);
  const total = vertical ? size.h : size.w;
  const first = Math.round(total * v.splitRatio);

  return (
    <div ref={rootRef} className="viewport-panes" onPointerEnter={() => { hovered.current = true; }} onPointerLeave={() => { hovered.current = false; }} data-mode={v.mode} data-split={split ? (vertical ? 'v' : 'h') : undefined} style={{ flexDirection: vertical ? 'column' : 'row' }}>
      {(!is2d || split) && (
        <div className="viewport-pane" style={split ? { flex: `0 0 ${first}px` } : { flex: 1 }}>
          <View3DPane {...props} />
        </div>
      )}
      {split && (
        <Splitter
          orientation={vertical ? 'horizontal' : 'vertical'}
          value={first}
          min={total * 0.2}
          max={total * 0.8}
          defaultValue={total * 0.5}
          onChange={(px) => v.set({ splitRatio: Math.min(0.8, Math.max(0.2, px / Math.max(1, total))) })}
          ariaLabel={tNow('view2d.splitter')}
          className="viewport-splitter"
        />
      )}
      {is2d && (
        <div className="viewport-pane" style={{ flex: 1 }}>
          <View2DPane showToolbar={split} />
        </div>
      )}
    </div>
  );
}
