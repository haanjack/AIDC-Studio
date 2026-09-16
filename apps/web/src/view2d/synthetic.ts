// r4 stream C: synthetic draw list for the renderer benchmark gate (spec §3.4: 10 k racks + 5 k segments) and the web tests.
// Deterministic (no Math.random). Racks sit in rows of `perRow` at 0.6 m pitch, two rows per pod around a 1.2 m aisle; segments
// are busway / tray / pipe bars and polylines over the rows.
import { drawListHash, type DrawItem2D, type DrawList2D, type LayerId } from '@aidc/core';
import type { PrimInfo } from './scene.ts';

export interface SyntheticOptions {
  racks?: number;
  segments?: number;
  perRow?: number;
}

export function syntheticPlan(o: SyntheticOptions = {}): { list: DrawList2D; prims: Record<string, PrimInfo> } {
  const racks = o.racks ?? 10_000;
  const segments = o.segments ?? 5_000;
  const perRow = o.perRow ?? 40;
  const items: DrawItem2D[] = [];
  const prims: Record<string, PrimInfo> = {};
  const rows = Math.ceil(racks / perRow);
  const podsPerCol = 20;
  const rowY = (r: number) => {
    const pod = Math.floor(r / 2);
    const col = Math.floor(pod / podsPerCol);
    const inCol = pod % podsPerCol;
    return { y: inCol * 6.4 + (r % 2) * 2.4, x0: col * (perRow * 0.6 + 6) };
  };
  const cats = ['gpu-rack', 'gpu-rack', 'gpu-rack', 'network-rack', 'storage-rack', 'cpu-rack'];
  let n = 0;
  for (let r = 0; r < rows && n < racks; r++) {
    const { y, x0 } = rowY(r);
    for (let k = 0; k < perRow && n < racks; k++, n++) {
      const id = `rack:R${r}-${k}`;
      const cat = cats[(r + k) % cats.length];
      prims[id] = { emitter: 'rack', category: cat, tag: `DU${String(Math.floor(r / 2) + 1).padStart(2, '0')}-${r % 2 ? 'B' : 'A'}-${String(k + 1).padStart(2, '0')}`, refId: `eq-${r}-${k}`, rowId: `row-${r}` };
      items.push({ kind: 'rect', pts: [x0 + k * 0.6, y, 0.6, 1.2], role: 'cut', layer: 'racks', lodMin: 1, style: 'rack', primId: id, refId: `eq-${r}-${k}` });
    }
  }
  const segLayers: { layer: LayerId; style: string; system?: string; w: number }[] = [
    { layer: 'busway-a', style: 'busway', system: 'busway-a', w: 0.17 },
    { layer: 'busway-b', style: 'busway', system: 'busway-b', w: 0.17 },
    { layer: 'tray-t1', style: 'tray', system: 'trays', w: 0.6 },
    { layer: 'pipes', style: 'pipe', system: 'cdu-supply', w: 0.11 },
    { layer: 'pipes', style: 'pipe', system: 'cdu-return', w: 0.11 },
  ];
  for (let s = 0; s < segments; s++) {
    const r = s % Math.max(1, rows);
    const { y, x0 } = rowY(r);
    const L = segLayers[s % segLayers.length];
    const id = `${L.style}:S${s}${L.system === 'cdu-return' ? '#R' : ''}`;
    prims[id] = { emitter: L.style as PrimInfo['emitter'], system: L.system, refId: `seg-${s}`, rowId: `row-${r}` };
    const yy = y + 0.3 + ((s % 7) * 0.12);
    if (s % 10 === 9) items.push({ kind: 'polyline', pts: [x0, yy, x0 + perRow * 0.3, yy + 0.4, x0 + perRow * 0.6, yy], role: 'overhead', layer: L.layer, lodMin: 2, style: L.style, primId: id });
    else items.push({ kind: 'rect', pts: [x0, yy - L.w / 2, perRow * 0.6, L.w], role: 'overhead', layer: L.layer, lodMin: 1, style: L.style, primId: id });
  }
  let x1 = 0;
  let y1 = 0;
  for (const it of items) {
    x1 = Math.max(x1, it.pts[0] + (it.kind === 'rect' ? it.pts[2] : 0));
    y1 = Math.max(y1, it.pts[1] + (it.kind === 'rect' ? it.pts[3] : 0));
  }
  const base = { space: 'plan' as const, hallId: 'synthetic', bounds: { x: 0, y: 0, w: x1, d: y1 }, items };
  return { list: { ...base, hash: drawListHash(base) }, prims };
}
