// r4 stream C (spec §3.2 Toolbar): 2D tools after the mode switch — [Select|Pan|Measure|Cut] │ [Layers n/N] [Paper|Dark] [m|ft-in]
// [Annot.] │ Section: [A–A ▾][⇄][‹ ›][depth ▾] · Elevation: [target ▾][ref ▾][look ⇄] │ [Export ▾]. Reads / writes the view2d store only;
// export and zoom go through the mounted pane (runtime.ts).
import { useEffect, useMemo, useState } from 'react';
import { LAYERS, rowGroupsFromEquipment, rowLetter, type ElevationTarget, type SectionDepthPreset } from '@aidc/core';
import { useApp } from '../store/appStore.ts';
import { useT } from '../i18n/index.ts';
import { Select, Seg } from '../ui/controls.tsx';
import { crossSectionThroughEquipment, cutMatchesRow, elevationTargets, NUDGE_FINE_M, NUDGE_TILE_M } from './cutTool.ts';
import { pane2D } from './runtime.ts';
import type { Tool2D } from './store.ts';

const DEPTHS: { value: string; preset: SectionDepthPreset }[] = [
  { value: 'cut', preset: 'cut' },
  { value: 'next-row', preset: 'next-row' },
  { value: 'wall', preset: 'wall' },
  { value: '1.2', preset: 1.2 },
  { value: '2.4', preset: 2.4 },
  { value: '6', preset: 6 },
];

export function View2DTools() {
  const t = useT();
  const v = useApp((s) => s.view2d);
  const hallId = useApp((s) => s.hallId);
  const project = useApp((s) => s.previewProject ?? s.project);
  const [exportOpen, setExportOpen] = useState(false);
  const space = v.mode === '3d' ? 'plan' : v.mode;
  const hallCuts = v.cuts.filter((c) => c.hallId === hallId);
  const active = hallCuts.find((c) => c.id === v.activeCutId) ?? null;
  const rows = useMemo(() => rowGroupsFromEquipment(hallId, project.equipment), [hallId, project.equipment]);
  const selection = useApp((s) => s.selection);
  const selectedEquipment = project.equipment.find((e) => e.id === selection.at(-1));
  const targets = useMemo(() => elevationTargets(rows, project.containments, hallId), [rows, project.containments, hallId]);

  const tools: { value: Tool2D; label: string; key: string }[] = [
    { value: 'select', label: t('view2d.tool.select'), key: 'V' },
    { value: 'pan', label: t('view2d.tool.pan'), key: 'H' },
    { value: 'measure', label: t('view2d.tool.measure'), key: 'M' },
    { value: 'cut', label: t('view2d.tool.cut'), key: 'C' },
  ];

  const targetLabel = (tg: ElevationTarget) => {
    if (tg.kind === 'wall') return t(`view2d.wall.${tg.wall}`);
    if (tg.kind === 'row-face') {
      const r = rows.find((x) => x.id === tg.rowId);
      return t('view2d.target.rowRef', { pod: r?.podId ?? '', row: rowLetter(tg.rowId) });
    }
    const c = project.containments.find((x) => x.id === tg.containmentId);
    return t('view2d.target.aisleRef', { pod: c?.podId ?? tg.containmentId });
  };
  const refKey = (tg: ElevationTarget) => (tg.kind === 'wall' ? `wall:${tg.wall}` : tg.kind === 'row-face' ? `row:${tg.rowId}` : `aisle:${tg.containmentId}`);
  const cur = v.elevation;
  const curKind = cur?.kind ?? 'aisle-end';
  const cutLabel = (c: (typeof hallCuts)[number]) => {
    if (c.kind === 'pod-transverse') return `${c.label} · ${t('view2d.cutType.transverse')} · ${c.refId ?? ''}`;
    if (c.kind === 'row-longitudinal') return `${c.label} · ${t('view2d.cutType.longitudinal')} · ${c.refId ?? ''}`;
    if (c.kind === 'aisle-longitudinal') return `${c.label} · ${t('view2d.cutType.aisle')}`;
    const row = rows.find((r) => cutMatchesRow(c, r));
    return row ? `${c.label} · ${row.id}` : c.label;
  };

  useEffect(() => {
    if (space !== 'section' || !selectedEquipment) return;
    const input = crossSectionThroughEquipment(selectedEquipment, rows);
    if (!input) return;
    const existing = hallCuts.find((c) => c.kind === 'pod-transverse' && c.anchorId === selectedEquipment.id);
    const cut = existing ?? v.addCut(input);
    if (v.activeCutId !== cut.id) v.set({ activeCutId: cut.id });
    // Selecting a rack in the 3D half of Split intentionally opens its DU/SU transverse cut.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [space, selectedEquipment?.id, hallId]);

  return (
    <div className="v2d-tools row" style={{ gap: 4, flexWrap: 'wrap' }} data-v2d-tools>
      <div className="glass v2d-seg" title={t('view2d.tool.hint')}>
        <Seg
          value={v.tool}
          options={tools.map((x) => ({ value: x.value, label: `${x.label}` }))}
          onChange={(tool) => v.set(tool === 'cut' && space !== 'plan' ? { tool, mode: 'plan' } : { tool })}
        />
      </div>
      <button className={`btn sm ${v.layersOpen ? 'active' : ''}`} data-v2d-layers-btn onClick={() => v.set({ layersOpen: !v.layersOpen })} title={t('view2d.layersTitle')}>
        {t('view2d.layers')} {v.layers.length}/{LAYERS.length}
      </button>
      <div className="glass v2d-seg"><Seg value={v.theme} options={[{ value: 'paper', label: t('view2d.theme.paper') }, { value: 'dark', label: t('view2d.theme.dark') }]} onChange={(theme) => v.set({ theme })} /></div>
      <div className="glass v2d-seg"><Seg value={v.units} options={[{ value: 'metric', label: t('view2d.units.metric') }, { value: 'imperial', label: t('view2d.units.imperial') }]} onChange={(units) => v.set({ units })} /></div>
      <button className={`btn sm ${v.annotations ? 'active' : ''}`} onClick={() => v.set({ annotations: !v.annotations })} title={t('view2d.annotationsTitle')}>{t('view2d.annotations')}</button>

      {(space === 'section' || (space === 'plan' && hallCuts.length > 0)) && (
        <div className="row v2d-cutpicker" style={{ gap: 4 }} data-v2d-cutpicker>
          <div className="glass" style={{ padding: 0, minWidth: 190 }}>
            <Select value={active?.id ?? ''} options={[...(active ? [] : [{ value: '', label: '—' }]), ...hallCuts.map((c) => ({ value: c.id, label: cutLabel(c) }))]} onChange={(id) => id && v.set({ activeCutId: id })} />
          </div>
          {active && (
            <label className="glass row v2d-cut-at" style={{ gap: 4, padding: '0 6px' }} title={t('view2d.cutAtTitle')}>
              <span className="mono">{active.axis}=</span>
              <input
                key={`${active.id}:${active.at}`}
                type="number"
                defaultValue={Number(active.at.toFixed(3))}
                step={0.05}
                style={{ width: 68 }}
                aria-label={t('view2d.cutAt')}
                onBlur={(e) => { const at = Number(e.target.value); if (Number.isFinite(at)) v.updateCut(active.id, { at }); }}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              />
              <span>m</span>
            </label>
          )}
          <button className="btn sm" disabled={!active} onClick={() => v.flipActive()} title={t('view2d.flipTitle')}>⇄</button>
          <button className="btn sm" disabled={!active} onClick={() => v.nudgeActive(-NUDGE_TILE_M)} title={t('view2d.nudgeTitle', { m: NUDGE_TILE_M, fine: NUDGE_FINE_M })}>‹</button>
          <button className="btn sm" disabled={!active} onClick={() => v.nudgeActive(NUDGE_TILE_M)} title={t('view2d.nudgeTitle', { m: NUDGE_TILE_M, fine: NUDGE_FINE_M })}>›</button>
          <div className="glass" style={{ padding: 0, width: 118 }} title={t('view2d.depth')}>
            <Select value={String(v.depth)} options={DEPTHS.map((d) => ({ value: d.value, label: t(`view2d.depthPreset.${d.value}`) }))} onChange={(val) => v.set({ depth: DEPTHS.find((d) => d.value === val)?.preset ?? 'next-row' })} />
          </div>
          {space === 'plan' && active && <button className="btn sm" onClick={() => v.setMode('section')}>{t('view2d.openSection', { label: active.label })}</button>}
          {active && <button className="btn ghost sm" onClick={() => v.removeCut(active.id)} title={t('view2d.deleteCut')}>✕</button>}
        </div>
      )}

      {space === 'elevation' && (
        <div className="row v2d-elevpicker" style={{ gap: 4 }} data-v2d-elevpicker>
          <div className="glass" style={{ padding: 0, width: 108 }}>
            <Select
              value={curKind}
              options={[{ value: 'wall', label: t('view2d.target.wall') }, { value: 'row-face', label: t('view2d.target.row-face') }, { value: 'aisle-end', label: t('view2d.target.aisle-end') }]}
              onChange={(kind) => {
                const first = targets.find((x) => x.kind === kind);
                if (first) v.set({ elevation: first });
              }}
            />
          </div>
          <div className="glass" style={{ padding: 0, minWidth: 120 }}>
            <Select
              value={cur ? refKey(cur) : ''}
              options={[...(cur ? [] : [{ value: '', label: '—' }]), ...targets.filter((x) => x.kind === curKind).map((x) => ({ value: refKey(x), label: targetLabel(x) }))]}
              onChange={(k) => {
                const tg = targets.find((x) => refKey(x) === k);
                if (tg) v.set({ elevation: tg });
              }}
            />
          </div>
          <button className="btn sm" disabled={!cur} onClick={() => v.flipActive()} title={t('view2d.flipTitle')}>
            {cur?.kind === 'row-face' ? t(`view2d.face.${cur.face}`) : cur?.kind === 'aisle-end' ? t('view2d.end', { n: cur.end + 1 }) : '⇄'}
          </button>
        </div>
      )}

      <div style={{ position: 'relative' }}>
        <button className={`btn sm ${exportOpen ? 'active' : ''}`} data-v2d-export onClick={() => setExportOpen((o) => !o)} aria-expanded={exportOpen}>{t('view2d.export')} ▾</button>
        {exportOpen && (
          <div className="v2d-menu glass" role="menu" onMouseLeave={() => setExportOpen(false)}>
            <button className="btn ghost sm" role="menuitem" data-v2d-export-svg onClick={() => { setExportOpen(false); void pane2D.get()?.exportSvg(); }}>{t('view2d.exportSvg')}</button>
            <button className="btn ghost sm" role="menuitem" data-v2d-export-png onClick={() => { setExportOpen(false); void pane2D.get()?.exportPng(); }}>{t('view2d.exportPng')}</button>
          </div>
        )}
      </div>
    </div>
  );
}
