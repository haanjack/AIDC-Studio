import { StrictMode, useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createNvidiaReferenceProject, findCatalogItem, type CableRun, type Hall, type Project, type ProjectAnalysis, type SpinePlacement } from '@aidc/core';
import { DEFAULT_OVERLAYS, Viewer3D, type CameraPreset, type ColorMode, type ScalarField, type ViewerApi, type ViewerOverlays } from './index.ts';
import { useT } from '../i18n/index.ts';

/** Synthetic analytic field (hot aisles in containment, cold aisles, warm plenum) for overlay testing. */
function buildSyntheticField(project: Project, hall: Hall, cs = 0.3): ScalarField {
  const W = hall.width;
  const D = hall.depth;
  const Hc = hall.clearHeight;
  const H = Hc + hall.ceilingPlenumHeight;
  const nx = Math.ceil(W / cs);
  const ny = Math.ceil(D / cs);
  const nz = Math.ceil(H / cs);
  const N = nx * ny * nz;
  const temperature = new Float32Array(N);
  const velocity = new Float32Array(N * 3);
  const conts = project.containments.filter((c) => c.hallId === hall.id);
  const rackD = 1.2;
  for (let k = 0; k < nz; k++) {
    const z = (k + 0.5) * cs;
    for (let j = 0; j < ny; j++) {
      const y = (j + 0.5) * cs;
      for (let i = 0; i < nx; i++) {
        const x = (i + 0.5) * cs;
        const idx = i + nx * (j + ny * k);
        const endDist = Math.min(x, W - x);
        const dirX = x < W / 2 ? 1 : -1;
        let T = 21 + 1.2 * (z / Hc) + 4.5 * (1 - Math.exp(-endDist / 5));
        let vx = dirX * 1.9 * Math.exp(-Math.max(0, endDist - 1.5) / 5.5) * (z < 2.8 ? 1 : 0.15);
        let vy = 0;
        let vz = 0;
        if (z >= Hc) {
          T = 35 + 3 * Math.min(1, endDist / (W / 2));
          vx = -dirX * (0.5 + 1.4 * (1 - Math.min(1, endDist / (W / 2))));
        } else if (endDist < 2.0 && z > 3.5) {
          vz = -1.1;
          vx *= 0.2;
          T = 33 - 1.5 * ((Hc - z) / (Hc - 3.5));
        }
        for (const c of conts) {
          const { x: rx, y: ry, w: rw, d: rd } = c.rect;
          const inX = x >= rx && x <= rx + rw;
          if (inX && y >= ry && y <= ry + rd) {
            const top = c.ductedToPlenum ? Hc : c.height;
            if (z < top) {
              const u = (x - rx) / rw;
              T = 37.5 + 3.2 * Math.sin(u * Math.PI) + 1.5 * (z / top);
              vy = (ry + rd / 2 - y) * 0.8;
              vz = 0.3 + 1.1 * (z / top);
              vx = 0;
            }
          }
          // inlet zones in front of both rows: flow into the rack fronts, recirculation near row ends at the top
          for (const [y0, y1, sgn] of [
            [ry - rackD - 1.1, ry - rackD, 1],
            [ry + rd + rackD, ry + rd + rackD + 1.1, -1],
          ] as const) {
            if (inX && y >= y0 && y <= y1 && z < c.height + 0.3) {
              vy = sgn * 0.55;
              vx *= 0.4;
              const endU = Math.min(x - rx, rx + rw - x);
              if (z > c.height - 0.6) T += 5.5 * Math.exp(-endU / 1.2);
            }
          }
        }
        temperature[idx] = T;
        velocity[idx * 3] = vx;
        velocity[idx * 3 + 1] = vy;
        velocity[idx * 3 + 2] = vz;
      }
    }
  }
  return { grid: { nx, ny, nz, cellSize: cs, origin: { x: 0, y: 0, z: 0 } }, temperature, velocity };
}

function synthesizeAnalysis(project: Project): ProjectAnalysis {
  const runs: CableRun[] = [];
  const eq = project.equipment;
  const spines = eq.filter((e) => e.networkRole === 'scale-out-spine');
  const storage = eq.filter((e) => findCatalogItem(e.catalogId)?.category === 'storage-rack');
  const cpus = eq.filter((e) => findCatalogItem(e.catalogId)?.category === 'cpu-rack');
  const pods = [...new Set(eq.map((e) => e.podId).filter((p): p is string => !!p && !p.startsWith('pod-services')))];
  for (const pod of pods) {
    const inPod = eq.filter((e) => e.podId === pod);
    const gpus = inPod.filter((e) => findCatalogItem(e.catalogId)?.category === 'gpu-rack');
    const leaves = inPod.filter((e) => e.networkRole === 'scale-out-leaf');
    const fes = inPod.filter((e) => e.networkRole === 'frontend');
    for (const g of gpus) {
      for (const l of leaves) runs.push({ id: `so-${g.id}-${l.id}`, fabric: 'scale-out', fromId: g.id, toId: l.id, lengthM: 0, cableTypeId: 'mmf-800-sr8', count: Math.ceil(72 / Math.max(1, leaves.length)) });
      for (const f of fes) runs.push({ id: `fe-${g.id}-${f.id}`, fabric: 'frontend', fromId: g.id, toId: f.id, lengthM: 0, cableTypeId: 'mmf-400-sr4', count: 18 });
    }
    for (const l of leaves) for (const s of spines) runs.push({ id: `sp-${l.id}-${s.id}`, fabric: 'scale-out spine', fromId: l.id, toId: s.id, lengthM: 0, cableTypeId: 'smf-800-dr8', count: 12 });
    for (const f of fes) {
      for (const s of storage) runs.push({ id: `st-${f.id}-${s.id}`, fabric: 'storage', fromId: s.id, toId: f.id, lengthM: 0, cableTypeId: 'smf-400-dr4', count: 4 });
      for (const c of cpus) runs.push({ id: `cp-${f.id}-${c.id}`, fabric: 'frontend', fromId: c.id, toId: f.id, lengthM: 0, cableTypeId: 'smf-400-dr4', count: 6 });
    }
  }
  return { network: { fabrics: [], cableRuns: runs, cablesByType: [], transceiverKW: 0, commEfficiency: 1, costUSD: 0 } } as unknown as ProjectAnalysis;
}

const q = new URLSearchParams(location.search);
window.__AIDC_VIEWER_FLAGS = { postfx: q.get('nofx') !== '1', ao: q.get('noao') !== '1', nanGuard: q.get('nanguard') !== '0', aoHalfRes: q.get('aohalf') !== '0', autoFallback: q.get('fallback') !== '0', tooltip: q.get('notip') !== '1', controls: q.get('noctrl') !== '1' };
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);

function initialOverlays(): ViewerOverlays {
  const mode = (q.get('thermal') as ViewerOverlays['thermal']['mode']) ?? 'off';
  return {
    ...DEFAULT_OVERLAYS,
    containment: q.get('cont') !== '0',
    ceiling: q.get('ceiling') === '1',
    labels: q.get('labels') !== '0',
    cables: q.get('cables') === '1',
    trays: q.get('trays') !== '0',
    airflow: q.get('airflow') === '1',
    heatmapFloor: q.get('heat') === '1',
    thermal: { ...DEFAULT_OVERLAYS.thermal, mode, axis: (q.get('axis') as 'x' | 'y' | 'z') ?? 'z', position: num('pos', 1.2), opacity: num('opacity', 0.85), rangeC: [num('tmin', 20), num('tmax', 42)] },
  };
}

function Harness() {
  const t = useT();
  // ?pods=N&rpr=N&cols=N&spine=central-end|central-center|distributed|separate-room — layout-engine QA (S1)
  const [project, setProject] = useState(() => createNvidiaReferenceProject({ pods: num('pods', 4), racksPerRow: num('rpr', 12), columns: num('cols', 1), spinePlacement: (q.get('spine') as SpinePlacement | null) ?? undefined }).project);
  const hall = project.halls[0];
  const synthetic = useMemo(() => buildSyntheticField(project, hall), [project.halls, project.containments]); // eslint-disable-line react-hooks/exhaustive-deps
  const analysis = useMemo(() => synthesizeAnalysis(project), [project]);
  const [overlays, setOverlays] = useState<ViewerOverlays>(initialOverlays);
  const [colorMode, setColorMode] = useState<ColorMode>((q.get('color') as ColorMode) ?? 'realistic');
  const [preset, setPreset] = useState<CameraPreset>((q.get('preset') as CameraPreset) ?? 'iso');
  const [nonce, setNonce] = useState(0);
  const [selection, setSelection] = useState<string[]>(q.get('sel') ? [q.get('sel')!] : []);
  const [editMode, setEditMode] = useState(q.get('edit') === '1');
  const [stats, setStats] = useState(q.get('stats') === '1');
  const [api, setApi] = useState<ViewerApi | null>(null);
  const hideUi = q.get('hideui') === '1';

  const onSelect = useCallback((id: string | null, additive: boolean) => {
    (window as unknown as { __harnessLastSelect?: unknown }).__harnessLastSelect = { id, additive };
    setSelection((s) => (id === null ? [] : additive ? (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]) : [id]));
  }, []);
  const onMove = useCallback((moves: { id: string; position: { x: number; y: number } }[]) => {
    (window as unknown as { __harnessLastMove?: unknown }).__harnessLastMove = moves;
    const byId = new Map(moves.map((m) => [m.id, m.position]));
    setProject((pr) => ({ ...pr, equipment: pr.equipment.map((e) => (byId.has(e.id) ? { ...e, position: byId.get(e.id)! } : e)) }));
  }, []);

  const field = overlays.thermal.mode !== 'off' || overlays.airflow || overlays.heatmapFloor || colorMode === 'inlet-temp' ? synthetic : null;
  const set = (patch: Partial<ViewerOverlays>) => setOverlays((o) => ({ ...o, ...patch }));
  const setT = (patch: Partial<ViewerOverlays['thermal']>) => setOverlays((o) => ({ ...o, thermal: { ...o.thermal, ...patch } }));
  const axisMax = overlays.thermal.axis === 'x' ? hall.width : overlays.thermal.axis === 'y' ? hall.depth : hall.clearHeight + hall.ceilingPlenumHeight;

  const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, margin: '3px 0' };
  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <Viewer3D
        project={project}
        hallId={hall.id}
        analysis={analysis}
        field={field}
        overlays={overlays}
        colorMode={colorMode}
        selection={selection}
        onSelect={onSelect}
        editMode={editMode}
        onMoveEquipment={onMove}
        cameraPreset={preset}
        cameraNonce={nonce}
        showStats={stats}
        onReady={(a) => {
          (window as unknown as { __viewerApi?: ViewerApi }).__viewerApi = a;
          setApi(a);
        }}
      />
      {!hideUi && (
        <div style={{ position: 'absolute', top: 10, right: 10, width: 250, background: 'rgba(12,16,22,0.9)', color: '#dfe6ee', font: '12px system-ui, sans-serif', padding: 10, borderRadius: 8, border: '1px solid #26303a', maxHeight: '95vh', overflow: 'auto' }}>
          <div style={{ fontWeight: 700, color: '#9be15d', marginBottom: 6 }}>AIDC Viewer Harness</div>
          <div style={row}>
            {(['iso', 'top', 'aisle', 'hot-aisle', 'overview'] as CameraPreset[]).map((p) => (
              <button key={p} onClick={() => (setPreset(p), setNonce((n) => n + 1))} style={{ fontSize: 11 }}>
                {p}
              </button>
            ))}
          </div>
          <label style={row}>
            {t('shell.harness.color')}
            <select value={colorMode} onChange={(e) => setColorMode(e.target.value as ColorMode)}>
              {['realistic', 'category', 'power', 'inlet-temp', 'wave', 'network-role'].map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
          {(['containment', 'ceiling', 'labels', 'trays', 'cables', 'airflow', 'heatmapFloor'] as const).map((k) => (
            <label key={k} style={row}>
              <input type="checkbox" checked={overlays[k]} onChange={(e) => set({ [k]: e.target.checked } as Partial<ViewerOverlays>)} />
              {k}
            </label>
          ))}
          <label style={row}>
            {t('shell.harness.thermal')}
            <select value={overlays.thermal.mode} onChange={(e) => setT({ mode: e.target.value as ViewerOverlays['thermal']['mode'] })}>
              {['off', 'slice', 'volume', 'both'].map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
            <select value={overlays.thermal.axis} onChange={(e) => setT({ axis: e.target.value as 'x' | 'y' | 'z' })}>
              {['x', 'y', 'z'].map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
          <label style={row}>
            {t('shell.harness.position', { m: overlays.thermal.position.toFixed(1) })}
            <input type="range" min={0} max={axisMax} step={0.1} value={overlays.thermal.position} onChange={(e) => setT({ position: Number(e.target.value) })} />
          </label>
          <label style={row}>
            {t('shell.harness.opacity')}
            <input type="range" min={0.1} max={1} step={0.05} value={overlays.thermal.opacity} onChange={(e) => setT({ opacity: Number(e.target.value) })} />
          </label>
          <label style={row}>
            {t('shell.harness.range')}
            <input type="number" value={overlays.thermal.rangeC[0]} style={{ width: 48 }} onChange={(e) => setT({ rangeC: [Number(e.target.value), overlays.thermal.rangeC[1]] })} />
            <input type="number" value={overlays.thermal.rangeC[1]} style={{ width: 48 }} onChange={(e) => setT({ rangeC: [overlays.thermal.rangeC[0], Number(e.target.value)] })} />
          </label>
          <label style={row}>
            <input type="checkbox" checked={editMode} onChange={(e) => setEditMode(e.target.checked)} /> edit (drag)
          </label>
          <label style={row}>
            <input type="checkbox" checked={stats} onChange={(e) => setStats(e.target.checked)} /> stats
          </label>
          <div style={row}>
            <button onClick={() => api && selection[0] && api.focusEquipment(selection[0])}>focus sel</button>
            <button
              onClick={async () => {
                if (!api) return;
                const buf = await api.exportGlb();
                console.log('GLB bytes', buf.byteLength);
              }}
            >
              export glb
            </button>
          </div>
          <div style={{ opacity: 0.6 }}>selection: {selection.join(', ') || '-'}</div>
        </div>
      )}
    </div>
  );
}

declare global {
  interface Window {
    __harnessRoot?: ReturnType<typeof createRoot>;
  }
}
window.__harnessRoot ??= createRoot(document.getElementById('root')!);
window.__harnessRoot.render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
