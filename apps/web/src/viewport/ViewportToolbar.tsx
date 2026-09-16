// r4 stream C (spec §3.2 Toolbar): the viewport toolbar. The mode switch [3D|Plan|Section|Elev] and [Split] always sit at the
// left. 3D mode keeps the camera / overlay controls (moved out of App.tsx unchanged). A 2D-only view shows the 2D tools here; in
// Split the 3D controls stay over the 3D pane and the 2D tools sit inside the 2D pane.
import { useEffect, useRef, useState } from 'react';
import { useApp, type CameraPreset } from '../store/appStore.ts';
import type { ColorMode } from '../viewer/index.ts';
import { Icon } from '../ui/icons.tsx';
import { Select, Seg } from '../ui/controls.tsx';
import { PowerOverlayButton } from '../panels/PowerPanel.tsx';
import { useT } from '../i18n/index.ts';
import { View2DTools } from '../view2d/View2DToolbar.tsx';
import type { ViewMode } from '../view2d/store.ts';
import { crossSectionThroughEquipment, longSectionThroughRow } from '../view2d/cutTool.ts';
import { rowGroupsFromEquipment } from '@aidc/core';

const CAMERAS: { value: CameraPreset; label: string }[] = [
  { value: 'iso', label: 'shell.camera.iso' }, { value: 'top', label: 'shell.camera.top' }, { value: 'aisle', label: 'shell.camera.aisle' },
  { value: 'hot-aisle', label: 'shell.camera.hotAisle' }, { value: 'overview', label: 'shell.camera.overview' }, { value: 'eye', label: 'shell.camera.eye' },
];

const COLOR_MODES: { value: ColorMode; label: string }[] = [
  { value: 'realistic', label: 'shell.color.realistic' }, { value: 'category', label: 'shell.color.category' }, { value: 'power', label: 'shell.color.power' },
  { value: 'inlet-temp', label: 'shell.color.inletTemp' }, { value: 'wave', label: 'shell.color.wave' }, { value: 'network-role', label: 'shell.color.networkRole' },
];

const MODES: ViewMode[] = ['3d', 'plan', 'section', 'elevation'];

export function ViewportToolbar() {
  const s = useApp();
  const t = useT();
  const { project, hallId, overlays, colorMode, editMode, cameraPreset } = s;
  const v = s.view2d;
  const is2d = v.mode !== '3d';
  const split = is2d && v.split;
  const hidden = s.panelWide && !s.panelCollapsed;
  // resolved Split axis, same rule as ViewportPanes (auto = stacked when W < 1.2 H). QA r4 view2d: in an auto-stacked Split the
  // toolbar was still clipped to the 3D share of the width and wrapped into five rows over the 3D pane.
  const rootRef = useRef<HTMLDivElement>(null);
  const [stacked, setStacked] = useState(false);
  useEffect(() => {
    const host = rootRef.current?.parentElement;
    if (!host) return;
    const update = () => setStacked(host.clientWidth < host.clientHeight * 1.2);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(host);
    return () => ro.disconnect();
  }, [hidden]);
  if (hidden) return null;
  const vertical = v.splitAxis === 'v' || (v.splitAxis === 'auto' && stacked);

  const overlayBtn = (key: 'containment' | 'ceiling' | 'labels' | 'trays' | 'cables' | 'airflow', label: string) => (
    <button className={`btn sm ${overlays[key] ? 'active' : ''}`} onClick={() => s.setOverlays({ [key]: !overlays[key] })}>{label}</button>
  );

  const setMode = (mode: ViewMode) => {
    if (mode === 'section') {
      const p = s.previewProject ?? project;
      const rows = rowGroupsFromEquipment(hallId, p.equipment);
      const selected = p.equipment.find((e) => e.id === s.selection.at(-1));
      const selectedCut = selected ? crossSectionThroughEquipment(selected, rows) : null;
      const hallCuts = v.cuts.filter((c) => c.hallId === hallId);
      if (!hallCuts.length) {
        const made = v.addCuts([...(selectedCut ? [selectedCut] : []), ...rows.map((row) => longSectionThroughRow(row))]);
        if (selectedCut && made[0]) v.set({ activeCutId: made[0].id });
      } else if (selected && selectedCut) {
        const existing = hallCuts.find((c) => c.kind === 'pod-transverse' && c.anchorId === selected.id);
        const cut = existing ?? v.addCut(selectedCut);
        v.set({ activeCutId: cut.id });
      }
    }
    v.setMode(mode);
  };

  return (
    <div ref={rootRef} className="viewport-toolbar" data-mode={v.mode} style={split && !vertical ? { right: `calc(${(1 - v.splitRatio) * 100}% + 10px)` } : undefined}>
      <div className="glass v2d-seg" data-viewport-modes title={t('view2d.modeKeys')}>
        <Seg value={v.mode} options={MODES.map((m) => ({ value: m, label: t(`view2d.mode.${m}`) }))} onChange={setMode} />
      </div>
      <button className={`btn sm ${split ? 'active' : ''}`} data-viewport-split onClick={() => v.toggleSplit()} title={t('view2d.splitTitle')}>⧉ {t('view2d.split')}</button>
      {(!is2d || split) && (
        <>
          <Seg value={cameraPreset} options={CAMERAS.map((c) => ({ ...c, label: t(c.label) }))} onChange={(val) => s.setCamera(val)} />
          <button
            className={`btn sm ${s.cameraMode === 'fly' ? 'active' : ''}`}
            data-fly-toggle
            onClick={() => s.setCameraMode(s.cameraMode === 'fly' ? 'orbit' : 'fly')}
            title={t('shell.viewport.flyTitle')}
          >
            {s.cameraMode === 'fly' ? t('shell.viewport.flying') : t('shell.viewport.fly')}
          </button>
          <div className="glass" style={{ padding: 0, width: 130 }}><Select value={colorMode} options={COLOR_MODES.map((c) => ({ ...c, label: t(c.label) }))} onChange={(val) => s.setColorMode(val)} /></div>
          <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
            {overlayBtn('containment', t('shell.overlay.containment'))}
            {overlayBtn('ceiling', t('shell.overlay.ceiling'))}
            {overlayBtn('trays', t('shell.overlay.trays'))}
            {overlayBtn('cables', t('shell.overlay.cables'))}
            {overlayBtn('airflow', t('shell.overlay.airflow'))}
            {overlayBtn('labels', t('shell.overlay.labels'))}
            <PowerOverlayButton />
            <button className={`btn sm ${overlays.thermal.mode !== 'off' ? 'active' : ''}`} onClick={() => s.setThermalOverlay({ mode: overlays.thermal.mode === 'off' ? 'slice' : 'off' })}>{t('shell.overlay.thermal')}</button>
          </div>
        </>
      )}
      {is2d && !split && <View2DTools />}
      <span style={{ flex: 1 }} />
      {(!is2d || split) && (
        <>
          <button className={`btn sm ${editMode ? 'active' : ''}`} onClick={() => s.setEditMode(!editMode)} title={t('shell.viewport.editTitle')}><Icon name="move" size={13} />{t('shell.viewport.edit')}</button>
          <button className="btn sm" disabled={!s.viewerApi} onClick={() => {
            const url = s.viewerApi?.screenshot();
            if (!url) return;
            const a = document.createElement('a');
            a.href = url;
            a.download = `${project.id}-${hallId}.png`;
            a.click();
          }} title={t('shell.viewport.screenshot')}><Icon name="camera" size={13} /></button>
        </>
      )}
    </div>
  );
}
