import type { Locale, Project } from '../model/types.ts';
import { tr } from './i18n.ts';
import { IsoScene, isoPoint, mix } from './iso.ts';
import { ENVELOPE, INK, INK_SOFT, LINE_LIGHT, SYSTEM_COLOR, categoryPlanStyle } from './palette.ts';
import { hallOutline, type HallScene } from './scene.ts';
import { drawLegend, drawPhaseMatrix, phaseMatrix } from './sheet.ts';
import { line, text, type Pt } from './svg.ts';

/**
 * 400-series sheet: the systems of ONE hall as exploded layers stacked diagonally down the page — ceiling plenum
 * (return-air paths), overhead (trays / busways / liquid loops), floor (ghost racks, containment, CRAH / CDU /
 * network racks by system) and underfloor (supply plenum, raised floor only) — each in 30°/30° axonometric with
 * the envelope ghosted, dashed connectors between corresponding corners and the phase matrix top-right.
 */

type LayerId = 'plenum' | 'overhead' | 'floor' | 'underfloor';

interface Layer {
  id: LayerId;
  label: string;
  zFrom: number;
  zTo: number;
}

const GHOST_RACK = '#e3e6e9';
const S30 = 0.5;
const C30 = Math.cos(Math.PI / 6);

function layersFor(scene: HallScene, locale: Locale): Layer[] {
  const hall = scene.hall;
  const rackH = Math.max(2.3, ...scene.racks.map((r) => r.item.dims.h), ...scene.mech.map((m) => m.item.dims.h));
  const ceiling = Math.max(hall.clearHeight, rackH + 0.6);
  const layers: Layer[] = [];
  const hasPlenum = hall.ceilingPlenumHeight > 0 || scene.containments.some((c) => c.ductedToPlenum);
  if (hasPlenum) layers.push({ id: 'plenum', label: tr(locale, 'layerPlenum'), zFrom: ceiling, zTo: ceiling + Math.max(0.8, hall.ceilingPlenumHeight) });
  layers.push({ id: 'overhead', label: tr(locale, 'layerOverhead'), zFrom: rackH, zTo: ceiling });
  layers.push({ id: 'floor', label: tr(locale, 'layerFloor'), zFrom: 0, zTo: rackH });
  if (hall.raisedFloorHeight > 0) layers.push({ id: 'underfloor', label: tr(locale, 'layerUnderfloor'), zFrom: -hall.raisedFloorHeight, zTo: 0 });
  return layers;
}

function envelope(sc: IsoScene, scene: HallScene, h: number): void {
  const hall = scene.hall;
  const W = hall.width;
  const D = hall.depth;
  const outline = hallOutline(hall);
  // far walls first (behind everything)
  sc.add(1e9, '');
  sc.flat(outline, 0, { fill: ENVELOPE, fillOpacity: 0.22, stroke: INK_SOFT, sw: 0.3 }, 1e6);
  const P = (x: number, y: number, z: number) => isoPoint(sc.frame, x, y, z);
  const wallX: Pt[] = [P(W, 0, 0), P(W, D, 0), P(W, D, h), P(W, 0, h)];
  const wallY: Pt[] = [P(0, D, 0), P(W, D, 0), P(W, D, h), P(0, D, h)];
  const wallSvg = (pts: Pt[]) => `<polygon points="${pts.map((p) => `${p[0].toFixed(3)},${p[1].toFixed(3)}`).join(' ')}" fill="${ENVELOPE}" fill-opacity="0.18" stroke="${ENVELOPE}" stroke-width="0.2"/>`;
  sc.add(1e6 + 1, wallSvg(wallX));
  sc.add(1e6 + 1, wallSvg(wallY));
  // near vertical edges (thin) so the box reads as a volume
  for (const [x, y] of [
    [0, 0],
    [W, 0],
    [0, D],
  ] as const) {
    const a = P(x, y, 0);
    const b = P(x, y, h);
    sc.add(-1e6, line(a[0], a[1], b[0], b[1], { stroke: LINE_LIGHT, sw: 0.15, dash: '0.8 0.6' }));
  }
}

function ghostFootprints(sc: IsoScene, scene: HallScene): void {
  for (const it of scene.racks) {
    const r = it.rect;
    sc.flat([{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.d }, { x: r.x, y: r.y + r.d }], 0, { fill: GHOST_RACK, fillOpacity: 0.7, stroke: LINE_LIGHT, sw: 0.08 }, 1e5);
  }
}

function drawFloorLayer(sc: IsoScene, scene: HallScene, layer: Layer, locale: Locale): void {
  // containment: floor outline + roof + chimney to the ceiling when ducted
  for (const c of scene.containments) {
    const { x, y, w, d } = c.rect;
    const col = c.kind === 'hot-aisle' ? SYSTEM_COLOR['return-air'] : SYSTEM_COLOR['supply-air'];
    const poly = [{ x, y }, { x: x + w, y }, { x: x + w, y: y + d }, { x, y: y + d }];
    sc.flat(poly, 0.01, { fill: col, fillOpacity: 0.12, stroke: col, sw: 0.3, dash: '1.2 0.6' }, 1e4);
    if (c.roof) sc.flat(poly, c.height, { fill: col, fillOpacity: 0.25, stroke: col, sw: 0.2 }, -0.5);
    if (c.ductedToPlenum && layer.zTo > c.height) sc.box(x, y, c.height, w, d, layer.zTo - c.height, col, { opacity: 0.35, sw: 0.15 });
  }
  // racks and mechanical units
  for (const it of scene.items) {
    const r = it.rect;
    const h = it.item.dims.h;
    const cat = it.item.category;
    let fill = GHOST_RACK;
    let opacity = 0.8;
    if (it.system) {
      fill = SYSTEM_COLOR[it.system];
      opacity = 0.9;
    } else if (cat === 'crah' || cat === 'fan-wall') {
      fill = SYSTEM_COLOR['supply-air'];
      opacity = 0.95;
    } else if (cat === 'cdu') {
      fill = SYSTEM_COLOR['cdu-supply'];
      opacity = 0.95;
    } else if (cat === 'storage-rack') fill = categoryPlanStyle('storage-rack').fill;
    else if (cat === 'cpu-rack') fill = categoryPlanStyle('cpu-rack').fill;
    else if (cat === 'rpp' || cat === 'ups' || cat === 'busway-tapoff' || cat === 'battery') fill = SYSTEM_COLOR['busway-a'];
    else if (cat === 'column') fill = ENVELOPE;
    sc.box(r.x, r.y, 0, r.w, r.d, Math.min(h, layer.zTo), fill, { opacity, stroke: it.system || cat === 'crah' || cat === 'cdu' ? undefined : LINE_LIGHT, sw: 0.1 });
    // supply-air arrows out of every CRAH front
    if (cat === 'crah' || cat === 'fan-wall') {
      const f = it.front;
      const cx = it.e.position.x;
      const cy = it.e.position.y;
      const half = it.item.dims.d / 2;
      sc.arrow([{ x: cx + f.x * half, y: cy + f.y * half, z: 0.45 }, { x: cx + f.x * (half + 3), y: cy + f.y * (half + 3), z: 0.45 }], SYSTEM_COLOR['supply-air'], 0.6, { opacity: 0.9, depthBias: -50 });
    }
  }
  // pod labels above the pods
  for (const p of scene.pods) {
    if (!(p.rect.w > 0)) continue;
    sc.label(p.rect.x, p.rect.y, layer.zTo + 0.4, `${p.name}`, { size: 2.4, weight: 700, fill: INK });
  }
  void locale;
}

function drawOverheadLayer(sc: IsoScene, scene: HallScene, layer: Layer): void {
  ghostFootprints(sc, scene);
  for (const run of scene.runs) {
    const pts = run.points.map((p) => ({ x: p.x, y: p.y, z: Math.max(0.05, p.z - layer.zFrom) }));
    const col = SYSTEM_COLOR[run.system];
    if (run.kind === 'pipe') sc.pipe(pts, run.widthM / 2, col, { opacity: 0.95 });
    else if (run.kind === 'busway') sc.run(pts, run.widthM, 0.13, col, { opacity: 0.95 });
    else sc.run(pts, run.widthM, run.kind === 'cross-tray' ? 0.12 : 0.1, col, { opacity: 0.95 });
  }
  // CDU headers: from each CDU top to the nearest row pipe start
  const pipes = scene.runs.filter((r) => r.kind === 'pipe');
  for (const m of scene.mech) {
    if (m.item.category !== 'cdu') continue;
    const cx = m.e.position.x;
    const cy = m.e.position.y;
    let best: { d: number; p: { x: number; y: number; z: number }; system: 'cdu-supply' | 'cdu-return' } | null = null;
    for (const run of pipes) {
      for (const p of run.points) {
        const d = Math.hypot(p.x - cx, p.y - cy);
        if (!best || d < best.d) best = { d, p, system: run.system as 'cdu-supply' | 'cdu-return' };
      }
    }
    if (best && best.d < 6) {
      const z = Math.max(0.05, best.p.z - layer.zFrom);
      const off = best.system === 'cdu-supply' ? -0.1 : 0.1;
      for (const sys of ['cdu-supply', 'cdu-return'] as const) {
        const o = sys === 'cdu-supply' ? -0.1 : 0.1;
        sc.pipe([{ x: cx + o, y: cy + o, z: 0.05 }, { x: cx + o, y: cy + o, z }, { x: best.p.x + o - off, y: best.p.y + o - off, z }], 0.055, SYSTEM_COLOR[sys], { opacity: 0.95 });
      }
    }
  }
}

function drawPlenumLayer(sc: IsoScene, scene: HallScene, layer: Layer): void {
  const h = layer.zTo - layer.zFrom;
  const crahs = scene.mech.filter((m) => m.item.category === 'crah' || m.item.category === 'fan-wall');
  // return openings over every hot aisle (ducted or not) and return paths to the nearest CRAH
  for (const c of scene.containments) {
    if (c.kind !== 'hot-aisle') continue;
    const { x, y, w, d } = c.rect;
    const col = SYSTEM_COLOR['return-air'];
    sc.flat([{ x, y }, { x: x + w, y }, { x: x + w, y: y + d }, { x, y: y + d }], 0.01, { fill: col, fillOpacity: 0.45, stroke: col, sw: 0.25 }, 1e4);
    const cx = x + w / 2;
    const cy = y + d / 2;
    // two nearest CRAHs (one per hall end)
    const sorted = crahs.map((k) => ({ k, dd: Math.hypot(k.e.position.x - cx, k.e.position.y - cy) })).sort((a, b) => a.dd - b.dd);
    for (const t of sorted.slice(0, Math.min(2, sorted.length))) {
      const kx = t.k.e.position.x;
      const ky = t.k.e.position.y;
      sc.arrow([{ x: cx, y: cy, z: h * 0.5 }, { x: kx, y: cy, z: h * 0.5 }, { x: kx, y: ky, z: h * 0.5 }], col, 0.55, { opacity: 0.9, dash: '1.5 0.7', depthBias: -30 });
    }
  }
  for (const k of crahs) {
    const r = k.rect;
    // This volume is the CRAH return riser through the plenum; supply air is drawn on the room/underfloor layers.
    sc.box(r.x, r.y, 0, r.w, r.d, h, SYSTEM_COLOR['return-air'], { opacity: 0.55, sw: 0.12 });
  }
  if (!scene.containments.some((c) => c.kind === 'hot-aisle')) {
    // open room: return paths from the rack rows to the CRAHs
    for (const row of scene.rows) {
      const y = row.axis === 'x' ? row.center - row.frontSign * row.depth : row.center;
      const x = row.axis === 'x' ? (row.min + row.max) / 2 : row.center - row.frontSign * row.depth;
      const near = crahs.map((k) => ({ k, dd: Math.hypot(k.e.position.x - x, k.e.position.y - y) })).sort((a, b) => a.dd - b.dd)[0];
      if (near) sc.arrow([{ x, y, z: h * 0.5 }, { x: near.k.e.position.x, y: near.k.e.position.y, z: h * 0.5 }], SYSTEM_COLOR['return-air'], 0.5, { dash: '1.5 0.7', depthBias: -30 });
    }
  }
}

function drawUnderfloorLayer(sc: IsoScene, scene: HallScene, layer: Layer): void {
  const h = layer.zTo - layer.zFrom;
  ghostFootprints(sc, scene);
  const crahs = scene.mech.filter((m) => m.item.category === 'crah' || m.item.category === 'fan-wall');
  const cold = scene.containments.filter((c) => c.kind === 'cold-aisle');
  const targets = cold.length
    ? cold.map((c) => ({ x: c.rect.x + c.rect.w / 2, y: c.rect.y + c.rect.d / 2 }))
    : scene.rows.map((r) => ({ x: r.axis === 'x' ? (r.min + r.max) / 2 : r.center + r.frontSign * (r.depth / 2 + 0.6), y: r.axis === 'x' ? r.center + r.frontSign * (r.depth / 2 + 0.6) : (r.min + r.max) / 2 }));
  for (const k of crahs) {
    const r = k.rect;
    sc.box(r.x, r.y, 0, r.w, r.d, h, SYSTEM_COLOR['supply-air'], { opacity: 0.5, sw: 0.12 });
    const kx = k.e.position.x;
    const ky = k.e.position.y;
    const near = [...targets].sort((a, b) => Math.hypot(a.x - kx, a.y - ky) - Math.hypot(b.x - kx, b.y - ky)).slice(0, 2);
    for (const t of near) sc.arrow([{ x: kx, y: ky, z: h * 0.5 }, { x: t.x, y: ky, z: h * 0.5 }, { x: t.x, y: t.y, z: h * 0.5 }], SYSTEM_COLOR['supply-air'], 0.55, { opacity: 0.9, depthBias: -30 });
  }
}

export interface SystemsResult {
  svg: string;
  scale: string;
  layers: number;
}

export function drawSystems(project: Project, scene: HallScene, area: { x: number; y: number; w: number; h: number }, locale: Locale): SystemsResult {
  const L = locale;
  const hall = scene.hall;
  const W = Math.max(1, hall.width);
  const D = Math.max(1, hall.depth);
  const layers = layersFor(scene, locale);
  const out: string[] = [];

  // phase matrix + legend (top-right of the content area)
  const pm = phaseMatrix(scene, project, locale);
  const matrixW = 8 + 58 + 13 * Math.max(1, pm.waves.length);
  const mx = area.x + area.w - matrixW - 4;
  const my = area.y + 8;
  const pmDraw = drawPhaseMatrix(mx, my, pm, locale);
  out.push(pmDraw.svg);
  const legend = drawLegend(mx, my + pmDraw.height + 4, tr(L, 'legend'), [
    { color: ENVELOPE, label: tr(L, 'envelope') },
    { color: GHOST_RACK, label: tr(L, 'ghostRacks') },
    { color: SYSTEM_COLOR['supply-air'], label: `${tr(L, 'crah')} · ${tr(L, 'supplyAir')}` },
    { color: SYSTEM_COLOR['cdu-supply'], label: `${tr(L, 'cdu')} · ${tr(L, 'liquid')}` },
    { color: SYSTEM_COLOR.trays, label: `${tr(L, 'networkRack')} — ${tr(L, 'leaf')}/${tr(L, 'spine')}` },
    { color: SYSTEM_COLOR.frontend, label: `${tr(L, 'networkRack')} — ${tr(L, 'frontend')}` },
    { color: SYSTEM_COLOR['return-air'], label: tr(L, 'containment'), dash: '1.2 0.6' },
    { color: INK_SOFT, label: `${tr(L, 'level')} ↔ ${tr(L, 'level')}`, kind: 'line', dash: '1 0.8' },
  ], { colW: matrixW });
  out.push(legend.svg);
  const reservedRight = matrixW + 10;
  const reservedTop = pmDraw.height + legend.height + 14;

  // stack sizing
  const gutterL = 40;
  const gap = 10;
  const stepX = 9; // diagonal shift per layer
  const availW = area.w - gutterL - 6 - (layers.length - 1) * stepX;
  const availH = area.h - 16 - 14;
  const isoW = C30 * (W + D);
  const layerH = (l: Layer) => S30 * (W + D) + (l.zTo - l.zFrom);
  const totalHm = layers.reduce((s, l) => s + layerH(l), 0);
  let s = Math.min(availW / isoW, (availH - (layers.length - 1) * gap) / totalHm);
  // the matrix sits over the top-right; make sure the first layer's diamond top clears it
  const topLayer = layers[0];
  const topDiamondW = isoW * s;
  if (gutterL + topDiamondW > area.w - reservedRight) {
    const overlapH = reservedTop;
    s = Math.min(s, (availH - (layers.length - 1) * gap - overlapH) / totalHm);
  }
  // snap to the next standard drawing scale (1:100 … 1:1000) so the title block states a real ratio
  const STD = [50, 75, 100, 125, 150, 175, 200, 250, 300, 400, 500, 600, 750, 1000, 1250, 1500, 2000];
  const ratio = STD.find((r) => 1000 / r <= s) ?? STD[STD.length - 1];
  s = Math.min(s, 1000 / ratio);
  s = Math.max(0.5, s);
  void topLayer;

  // page origin: iso point (0,0,0) of each layer. Left-most paper x is at (0, D): ox − C30·D·s. Top is at (W, D, h).
  let y = area.y + (gutterL + topDiamondW > area.w - reservedRight ? reservedTop : 12);
  const corners: Pt[][] = [];
  layers.forEach((l, i) => {
    const h = l.zTo - l.zFrom;
    const ox = area.x + gutterL + C30 * D * s + i * stepX;
    const top = y;
    const oy = top + (S30 * (W + D) + h) * s; // paper y of (0,0,0)
    const sc = new IsoScene({ scale: s, ox, oy });
    envelope(sc, scene, h);
    if (l.id === 'floor') drawFloorLayer(sc, scene, l, locale);
    else if (l.id === 'overhead') drawOverheadLayer(sc, scene, l);
    else if (l.id === 'plenum') drawPlenumLayer(sc, scene, l);
    else drawUnderfloorLayer(sc, scene, l);
    out.push(sc.render());
    // level label (left gutter) with a leader to the (0, D, 0) corner
    const left = isoPoint(sc.frame, 0, D, 0);
    const midY = top + ((S30 * (W + D) + h) * s) / 2;
    out.push(text(area.x + 2, midY - 2, l.label.toUpperCase(), { size: 3.4, weight: 700, fill: INK, letterSpacing: 0.3 }));
    out.push(text(area.x + 2, midY + 2.6, `${l.zFrom >= 0 ? '+' : ''}${l.zFrom.toFixed(2)} … ${l.zTo >= 0 ? '+' : ''}${l.zTo.toFixed(2)} m`, { size: 2.3, fill: INK_SOFT }));
    out.push(line(area.x + 2, midY + 4.5, left[0] - 1.5, midY + 4.5, { stroke: LINE_LIGHT, sw: 0.2 }));
    out.push(line(left[0] - 1.5, midY + 4.5, left[0], left[1], { stroke: LINE_LIGHT, sw: 0.2 }));
    corners.push([isoPoint(sc.frame, 0, 0, 0), isoPoint(sc.frame, W, 0, 0), isoPoint(sc.frame, 0, D, 0), isoPoint(sc.frame, W, D, 0)]);
    y = top + (S30 * (W + D) + h) * s + gap;
  });
  // dashed connectors between corresponding corners of adjacent layers (drawn on top, light)
  for (let i = 0; i + 1 < corners.length; i++) {
    for (let k = 0; k < 4; k++) {
      const a = corners[i][k];
      const b = corners[i + 1][k];
      out.push(line(a[0], a[1], b[0], b[1], { stroke: mix(INK_SOFT, '#ffffff', 0.35), sw: 0.2, dash: '1.2 0.9' }));
    }
  }
  // caption
  out.push(text(area.x + gutterL, area.y + area.h - 6, `${hall.name} · ${W.toFixed(1)} × ${D.toFixed(1)} m · ${scene.racks.length} ${tr(L, 'racks')} · ${scene.gpuCount.toLocaleString('en-US')} ${tr(L, 'gpus')} · 1:${ratio}`, { size: 2.6, weight: 600, fill: INK }));
  return { svg: out.join(''), scale: `1:${ratio}`, layers: layers.length };
}
