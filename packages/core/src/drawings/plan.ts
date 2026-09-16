import { standardsBasisLine } from '../docs/standardsBasis.ts';
import { drawListHash } from '../scene/drawList.ts';
import { findCatalogItem } from '../catalog/catalog.ts';
import type { DrawingUnits, DrawingViewport, Hall, Locale, Project, Rect } from '../model/types.ts';
import { emptyDrawList, type DrawItem2D, type DrawList2D } from '../scene/drawList.ts';
import { primAabb, type HallPrims, type Prim } from '../scene/prims.ts';
import { annotate, CALLOUT_INK, DASH_DOT, LabelCuller, PAPER_LW, rowLetter, rowSlots, textBox, type PaperBox, type RowSlotInput, type RowSlotsResult } from './annotate.ts';
import { viewportWorldToPaper, type SheetContext } from './context.ts';
import { tr } from './i18n.ts';
import { CONTAINMENT_COLOR, GRID, INK, INK_SOFT, LINE_LIGHT, PAPER, SYSTEM_COLOR, categoryPlanStyle } from './palette.ts';
import { hallOutline, type HallScene } from './scene.ts';
import { drawLegend, pickScale } from './sheet.ts';
import { circle, esc, fitText, hatchDef, line, MIN_TEXT_MM, MONO, n, path, polygon, polyline, rect, text, textWidth, type Pt } from './svg.ts';
import { drawListToSvg } from './toSvg.ts';
import { drawingUnitsOf, fmtLength } from './units.ts';

/**
 * 100-series sheet: 2D floor & rack plan blueprint of one hall — grid bubbles, hall outline, racks with front
 * ticks and tags, containment, CRAH / CDU / network racks by category colour, keep-outs, trays / busways /
 * liquid loops, dimension chains, north arrow, scale bar and legend.
 */

export interface PlanResult {
  svg: string;
  scale: string;
  rackCount: number;
  /** r4 (B1): the plan's world → paper mapping (hall-local m → sheet mm); not serialized, the svg bytes are unchanged */
  map?: { ox: number; oy: number; mmPerM: number; hallW: number; hallD: number; region: PaperRect };
}

/**
 * r4 101 upgrade (owner: stream B1; opt-in with DrawingOptions.sheets 'plan-upgrade'). Extra `<g data-layer="…">` groups drawn over
 * the existing plan — it adds, never renames (spec §2.5.3):
 *   structural-grid     axes through aligned column keepouts (Hall.structuralGrid when set), else "planning grid 0.6 m — not structural"
 *   doors               room door swings (Keepout.door / estimate defaults)
 *   containment-doors   sliding / swing-double aisle end doors (Containment.doorType)
 *   rcu-enclosures      RCU enclosure outlines (rack meta.rcu, 2 or 4) + unoccupied-spacing / enclosure-break marks
 *   form-factor         light hatch on racks whose catalog form factor is known (EIA / ORv3); nothing when the catalog has none
 *   position-tags       A01… outside the front edge (gaps unnumbered), annotate()
 *   dimensions          per-row x-chains wall → runs / gaps → wall and aisle widths, annotate()
 *   notes               callout boundaries + bubbles to the 121 enlarged plans, a key for the new symbols
 * Every new label is culled against the existing plan's texts (no overlaps).
 */
export function drawPlanUpgrade(ctx: SheetContext, scene: HallScene, plan: PlanResult, area: { x: number; y: number; w: number; h: number }, defs: string[]): { svg: string; viewports?: DrawingViewport[] } {
  const vp = planViewports(scene, plan, area)[0];
  if (!vp || !plan.map) return { svg: '' };
  const hall = scene.hall;
  const L = ctx.locale;
  const project = ctx.project;
  const units = drawingUnitsOf(project);
  const den = Number(plan.scale.split(':')[1]) || 100;
  const hp = ctx.hallPrims(hall.id, 'hall');
  const culler = new LabelCuller();
  reserveSvgTexts(plan.svg, culler);
  const m = plan.map;
  const out: string[] = [];
  const P = (x: number, y: number) => viewportWorldToPaper(vp, x, y);

  // structural axes / planning-grid caption
  out.push(structuralGridGroup(hall, vp, culler, L, units));
  // doors, containment doors
  const doors = roomDoorSymbols(hp, hall, vp);
  if (doors.length) out.push(`<g data-layer="doors">${doors.join('')}</g>`);
  const cdoors = containmentDoorSymbols(hp, vp);
  if (cdoors.length) out.push(`<g data-layer="containment-doors">${cdoors.join('')}</g>`);
  // RCU enclosures + unoccupied spacing
  const rows = primRowSlots(hp);
  const rcu = rcuOutlines(hp, vp, culler, L);
  const gaps = gapMarks(rows, vp, L, units, den);
  if (rcu.length || gaps.length) out.push(`<g data-layer="rcu-enclosures">${[...rcu, ...gaps].join('')}</g>`);
  // form factor (catalog-known only)
  const ff = formFactorGroup(hp, vp, defs, 'hatch', culler, `ff-${slugId(hall.id)}-`);
  if (ff) out.push(ff);

  // annotations: position tags, row chains, aisle widths, callouts to 121
  const hallRect: Rect = { x: 0, y: 0, w: hall.width, d: hall.depth };
  const callouts: { rect: Rect; label: string; target?: string }[] = [];
  let k = 0;
  for (const pod of scene.pods) {
    const sheet = ctx.sheetList.find((s) => s.kind === 'enlarged-plan' && s.hallId === hall.id && s.group?.podId === pod.id);
    if (!sheet) continue;
    const r = podFootprint(hp, pod.id);
    if (!r) continue;
    k++;
    callouts.push({ rect: { x: r.x - 0.45, y: r.y - 0.45, w: r.w + 0.9, d: r.d + 0.9 }, label: String(k), target: sheet.number });
  }
  const list = emptyDrawList('plan', hall.id, hallRect);
  const ann = annotate(project, hp, list, { locale: L, units, scaleDen: den, lod: 3, layers: ['position-tags', 'dimensions', 'notes'], callouts, window: hallRect });
  const r = drawListToSvg(list, ann, vp, { idPrefix: `up-${slugId(hall.id)}-`, culler, clip: false, hp });
  defs.push(...r.defs);
  out.push(r.svg);

  // key for the upgrade symbols (right of the existing legend)
  const kx = area.x + 26 + 100 + 270 + 6;
  const ky = area.y + area.h - 66 + 4;
  const kw = area.x + area.w - kx - 2;
  if (kw >= 60) out.push(`<g data-layer="notes">${upgradeKey(kx, ky, kw, L, { rcu: rcu.length > 0, gaps: gaps.length > 0, doors: doors.length > 0, cdoors: cdoors.length > 0, callouts: callouts.length > 0 })}</g>`);
  void m;
  void P;
  return { svg: out.join(''), viewports: [vp] };
}

/** r4 viewports of a 101 plan (owner: stream B1): the plan region with the exact world ↔ paper transform drawPlan used. */
export function planViewports(scene: HallScene, plan: PlanResult, _area: { x: number; y: number; w: number; h: number }): DrawingViewport[] {
  const m = plan.map;
  if (!m || !(m.mmPerM > 0)) return [];
  const pr = m.region;
  const s = m.mmPerM;
  return [{ paperRect: { ...pr }, hallId: scene.hall.id, space: 'plan', worldRect: { x: (pr.x - m.ox) / s, y: (m.oy + m.hallD * s - pr.y - pr.h) / s, w: pr.w / s, d: pr.h / s }, mmPerM: s }];
}

/** column letters A..Z, AA..AZ, ... */
/** 'pod-01' → 'DU01' (generator naming; other ids are returned unchanged) */
function podName(podId: string): string {
  const m = /^pod-(\d+)$/.exec(podId);
  return m ? `DU${m[1]}` : podId;
}

export function colLetter(i: number): string {
  let s = '';
  let v = i;
  do {
    s = String.fromCharCode(65 + (v % 26)) + s;
    v = Math.floor(v / 26) - 1;
  } while (v >= 0);
  return s;
}

interface Mapper {
  s: number;
  X: (x: number) => number;
  Y: (y: number) => number;
}

function dimH(m: Mapper, x1: number, x2: number, yPaper: number, label: string, size = 2.2): string {
  const a = m.X(Math.min(x1, x2));
  const b = m.X(Math.max(x1, x2));
  const out = [line(a, yPaper, b, yPaper, { stroke: INK, sw: 0.2 })];
  for (const x of [a, b]) out.push(line(x - 0.9, yPaper + 0.9, x + 0.9, yPaper - 0.9, { stroke: INK, sw: 0.35 }));
  const tw = textWidth(label, size);
  if (tw <= b - a - 1) out.push(text((a + b) / 2, yPaper - 0.8, label, { size, anchor: 'middle', fill: INK }));
  else out.push(text(b + 1, yPaper - 0.8, label, { size: size * 0.9, anchor: 'start', fill: INK }));
  return out.join('');
}

function dimV(m: Mapper, y1: number, y2: number, xPaper: number, label: string, size = 2.2, side: 'left' | 'right' = 'right'): string {
  const a = m.Y(Math.max(y1, y2));
  const b = m.Y(Math.min(y1, y2));
  const out = [line(xPaper, a, xPaper, b, { stroke: INK, sw: 0.2 })];
  for (const y of [a, b]) out.push(line(xPaper - 0.9, y + 0.9, xPaper + 0.9, y - 0.9, { stroke: INK, sw: 0.35 }));
  const tw = textWidth(label, size);
  const tx = side === 'right' ? xPaper + 0.8 : xPaper - 0.8;
  if (tw <= b - a - 1) out.push(text(tx, (a + b) / 2, label, { size, anchor: 'middle', fill: INK, rotate: -90 }));
  else out.push(text(xPaper + (side === 'right' ? 1.2 : -1.2), a - 1, label, { size: size * 0.9, anchor: side === 'right' ? 'start' : 'end', fill: INK }));
  return out.join('');
}

function extLine(m: Mapper, x: number, y: number, x2: number, y2: number): string {
  return line(m.X(x), m.Y(y), m.X(x2), m.Y(y2), { stroke: LINE_LIGHT, sw: 0.12 });
}

const fmtM = (v: number) => `${(Math.round(v * 100) / 100).toFixed(2)} m`;

export function drawPlan(project: Project, scene: HallScene, area: { x: number; y: number; w: number; h: number }, locale: Locale, defs: string[]): PlanResult {
  const hall: Hall = scene.hall;
  const L = locale;
  const out: string[] = [];
  defs.push(hatchDef('ko-hatch', INK_SOFT, 1.4, 0.2));

  // reserved margins inside the content area: left (grid bubbles + depth dims), top (bubbles + width dim), right (dimension chains), bottom (legend)
  const padL = 26;
  const padT = 16;
  const padR = 44;
  const padB = 66;
  const pw = area.w - padL - padR;
  const ph = area.h - padT - padB;
  const { ratio, mmPerM } = pickScale(hall.width + 1, hall.depth + 1, pw, ph);
  const s = mmPerM;
  const ox = area.x + padL + (pw - hall.width * s) / 2;
  const oy = area.y + padT + (ph - hall.depth * s) / 2;
  const m: Mapper = { s, X: (x) => ox + x * s, Y: (y) => oy + (hall.depth - y) * s };
  const R = (r: { x: number; y: number; w: number; d: number }) => ({ x: m.X(r.x), y: m.Y(r.y + r.d), w: r.w * s, h: r.d * s });

  // ── grid (tile lines) + bubbles
  const tile = hall.tileSize > 0 ? hall.tileSize : 0.6;
  const nx = Math.min(600, Math.floor(hall.width / tile + 1e-6));
  const ny = Math.min(600, Math.floor(hall.depth / tile + 1e-6));
  for (let i = 0; i <= nx; i++) out.push(line(m.X(i * tile), m.Y(0), m.X(i * tile), m.Y(hall.depth), { stroke: GRID, sw: 0.08 }));
  for (let j = 0; j <= ny; j++) out.push(line(m.X(0), m.Y(j * tile), m.X(hall.width), m.Y(j * tile), { stroke: GRID, sw: 0.08 }));
  const every = Math.max(1, Math.ceil(11 / (tile * s)));
  const bubbleR = 2.6;
  for (let i = 0, k = 0; i * tile <= hall.width + 1e-6; i += every, k++) {
    const x = m.X(i * tile);
    out.push(line(x, m.Y(hall.depth) - 2, x, m.Y(hall.depth) - 5, { stroke: INK_SOFT, sw: 0.15 }));
    out.push(circle(x, m.Y(hall.depth) - 5 - bubbleR, bubbleR, { fill: PAPER, stroke: INK, sw: 0.25 }));
    out.push(text(x, m.Y(hall.depth) - 5 - bubbleR, colLetter(k), { size: 2.2, anchor: 'middle', baseline: 'central', weight: 600, fill: INK }));
  }
  for (let j = 0, k = 1; j * tile <= hall.depth + 1e-6; j += every, k++) {
    const y = m.Y(j * tile);
    out.push(line(m.X(0) - 2, y, m.X(0) - 5, y, { stroke: INK_SOFT, sw: 0.15 }));
    out.push(circle(m.X(0) - 5 - bubbleR, y, bubbleR, { fill: PAPER, stroke: INK, sw: 0.25 }));
    out.push(text(m.X(0) - 5 - bubbleR, y, String(k), { size: 2.2, anchor: 'middle', baseline: 'central', weight: 600, fill: INK }));
  }

  // ── hall outline
  const outline = hallOutline(hall).map((p): Pt => [m.X(p.x), m.Y(p.y)]);
  out.push(polygon(outline, { fill: 'none', stroke: INK, sw: 0.7, linejoin: 'miter' }));
  const hallHeader = `${hall.name}  ·  ${fmtM(hall.width)} × ${fmtM(hall.depth)}  ·  ${scene.racks.length} ${tr(L, 'racks')}  ·  ${scene.gpuCount.toLocaleString('en-US')} ${tr(L, 'gpus')}`;
  // QA r4 sheets: on a narrow hall (21.6 m × 340 m at 1:500) the header ran across the pod labels and callouts above the outline's
  // inside; when it is wider than the hall it goes under the outline instead (halls it fits keep the original bytes)
  if (textWidth(hallHeader, 2.8) + 4 > m.X(hall.width) - m.X(0)) out.push(text(m.X(0), m.Y(0) + 5.5, hallHeader, { size: 2.8, weight: 700, fill: INK }));
  else out.push(text(m.X(0) + 2, m.Y(hall.depth) + 4.5, hallHeader, { size: 2.8, weight: 700, fill: INK }));

  // ── keepouts
  for (const k of hall.keepouts) {
    const r = R(k.rect);
    out.push(rect(r.x, r.y, r.w, r.h, { fill: 'url(#ko-hatch)', stroke: INK_SOFT, sw: 0.25 }));
    const label = k.label ?? k.kind;
    const size = 1.8;
    const rot = r.w < textWidth(label, size) + 1 && r.h > r.w ? -90 : 0;
    out.push(text(r.x + r.w / 2, r.y + r.h / 2, fitText(label, size, Math.max(r.w, r.h) - 1), { size, anchor: 'middle', baseline: 'central', fill: INK, rotate: rot }));
  }

  // ── pods (outline + name + wave)
  for (const p of scene.pods) {
    if (!(p.rect.w > 0) || !(p.rect.d > 0)) continue;
    const r = R(p.rect);
    out.push(rect(r.x - 0.6, r.y - 0.6, r.w + 1.2, r.h + 1.2, { fill: 'none', stroke: INK_SOFT, sw: 0.2, dash: '2 0.8 0.4 0.8' }));
    const wave = scene.waves.find((w) => w.id === p.waveId);
    out.push(text(r.x - 1, r.y - 1.2, `${p.name}${wave ? ` · ${wave.name}` : ''} · ${p.rackCount} ${tr(L, 'racks')}${p.gpuCount ? ` · ${p.gpuCount} ${tr(L, 'gpus')}` : ''}`, { size: 2.2, weight: 700, fill: INK_SOFT }));
  }

  // ── containment
  for (const c of scene.containments) {
    const r = R(c.rect);
    const col = CONTAINMENT_COLOR[c.kind === 'hot-aisle' ? 'hot-aisle' : 'cold-aisle'];
    out.push(rect(r.x, r.y, r.w, r.h, { fill: col, fillOpacity: 0.07, stroke: col, sw: 0.35, dash: '1.6 0.8' }));
    const label = c.kind === 'hot-aisle' ? tr(L, 'hotAisle') : tr(L, 'coldAisle');
    const size = Math.min(2.4, Math.max(1.4, r.h * 0.45));
    const aisleText = `${label.toUpperCase()}  ${fmtM(c.rect.d)}${c.ductedToPlenum ? '  ▲' : ''}`;
    // QA r4 sheets: an aisle running up the sheet (y rows) got a horizontal label wider than the aisle, drawn over the racks; rotate it
    // along the aisle when it does not fit across (horizontal aisles keep the original bytes)
    const vertical = r.h > r.w && textWidth(aisleText, size) + aisleText.length * 0.3 > r.w - 0.5;
    if (vertical) {
      const vs = Math.min(2.4, Math.max(1.4, r.w * 0.45));
      out.push(text(r.x + r.w / 2, r.y + r.h / 2, fitText(aisleText, vs, r.h - 2), { size: vs, anchor: 'middle', baseline: 'central', fill: col, weight: 600, letterSpacing: 0.3, rotate: -90 }));
    } else out.push(text(r.x + r.w / 2, r.y + r.h / 2, aisleText, { size, anchor: 'middle', baseline: 'central', fill: col, weight: 600, letterSpacing: 0.3 }));
  }

  // ── services zone (T1, DECISIONS-v2-2 F3b): zone boundary with its mode label, reserve / expansion positions, room partition
  const zone = project.servicesZones?.find((z) => z.hallId === hall.id);
  const reservations = (project.reservations ?? []).filter((r) => r.hallId === hall.id && r.rect.w > 0 && r.rect.d > 0);
  const ZONE_MODE_KEY = { 'end-band': 'zoneEndBand', 'center-band': 'zoneCenterBand', 'support-hac': 'zoneSupportHac', 'separate-room': 'zoneSeparateRoom' } as const;
  if (zone?.rect && zone.rect.w > 0 && zone.rect.d > 0) {
    const r = R(zone.rect);
    out.push(rect(r.x - 1.4, r.y - 1.4, r.w + 2.8, r.h + 2.8, { fill: 'none', stroke: INK, sw: 0.4, dash: '4 1 0.8 1' }));
    const reserveTxt = zone.reservePositions > 0 ? ` · ${tr(L, 'reserve')} ${zone.reservePositions} ${tr(L, 'reservePositions')}` : '';
    const label = `${tr(L, 'servicesZone')} — ${tr(L, ZONE_MODE_KEY[zone.mode] ?? 'zoneEndBand')} · ${zone.racks} ${tr(L, 'racks')}${reserveTxt}`;
    const zText = fitText(label, 2.1, Math.max(40, r.w + 2.8));
    const zx1 = r.x + r.w + 1.4;
    const zx0 = zx1 - textWidth(zText, 2.1);
    // QA r4 sheets: on a narrow hall the zone label (end-anchored) ran into the pod label drawn start-anchored on the same line; it
    // goes under the zone boundary when it would meet a pod label (no overlap → original bytes)
    const podLabelBoxes = scene.pods
      .filter((pd) => pd.rect.w > 0 && pd.rect.d > 0)
      .map((pd) => {
        const pr = R(pd.rect);
        const wave = scene.waves.find((w) => w.id === pd.waveId);
        const pl = `${pd.name}${wave ? ` · ${wave.name}` : ''} · ${pd.rackCount} ${tr(L, 'racks')}${pd.gpuCount ? ` · ${pd.gpuCount} ${tr(L, 'gpus')}` : ''}`;
        return { x0: pr.x - 1, x1: pr.x - 1 + textWidth(pl, 2.2), y: pr.y - 1.2 };
      });
    const hitsPod = (y: number) => podLabelBoxes.some((b) => b.x0 < zx1 && zx0 < b.x1 && Math.abs(b.y - y) < 2.4);
    // above the boundary (original) → one line higher → under the boundary
    const zy = [r.y - 2.2, r.y - 5.0, r.y + r.h + 1.4 + 2.6].find((y) => !hitsPod(y)) ?? r.y - 2.2;
    out.push(text(zx1, zy, zText, { size: 2.1, anchor: 'end', weight: 600, fill: INK }));
  }
  for (const res of reservations) {
    const r = R(res.rect);
    if (res.kind === 'room-partition') {
      // partition wall between the separate room and the pod area (thin rect → heavy line along its long axis)
      if (r.h <= r.w) out.push(line(r.x, r.y + r.h / 2, r.x + r.w, r.y + r.h / 2, { stroke: INK, sw: 0.7 }));
      else out.push(line(r.x + r.w / 2, r.y, r.x + r.w / 2, r.y + r.h, { stroke: INK, sw: 0.7 }));
      out.push(text(r.x + 1, r.y - 1, tr(L, 'roomPartition'), { size: 1.9, fill: INK }));
      continue;
    }
    out.push(rect(r.x, r.y, r.w, r.h, { fill: 'none', stroke: INK_SOFT, sw: 0.3, dash: '1.2 0.7' }));
    const label = `${tr(L, 'reserve')} × ${res.positions}`;
    const size = 1.8;
    const along = Math.max(r.w, r.h) - 1;
    if (Math.min(r.w, r.h) >= 2.2 && textWidth(label, size) <= along) out.push(text(r.x + r.w / 2, r.y + r.h / 2, label, { size, anchor: 'middle', baseline: 'central', fill: INK_SOFT, rotate: r.h > r.w ? -90 : 0 }));
  }

  // ── overhead runs (trays / busways / pipes) as thin coloured lines
  for (const run of scene.runs) {
    const pts = run.points.map((p): Pt => [m.X(p.x), m.Y(p.y)]);
    const dash = run.kind === 'pipe' ? '1.2 0.5' : run.kind === 'busway' ? undefined : '0.8 0.4';
    out.push(polyline(pts, { stroke: SYSTEM_COLOR[run.system], sw: Math.max(0.25, run.widthM * s * 0.35), dash, opacity: 0.85, linecap: 'butt' }));
  }

  // ── equipment
  let rackCount = 0;
  for (const it of [...scene.mech, ...scene.racks]) {
    const r = R(it.rect);
    const st = it.system ? { fill: SYSTEM_COLOR[it.system], stroke: INK } : categoryPlanStyle(it.item.category);
    const fillOpacity = it.system ? 0.35 : 1;
    out.push(rect(r.x, r.y, r.w, r.h, { fill: st.fill, fillOpacity, stroke: st.stroke, sw: it.isRack ? 0.2 : 0.3 }));
    if (it.isRack) rackCount++;
    // front tick: thick line along the front edge
    const f = it.front;
    const tick = 0.6;
    if (Math.abs(f.y) > 0.5) {
      const y = f.y > 0 ? r.y : r.y + r.h;
      out.push(line(r.x + 0.2, y + (f.y > 0 ? tick / 2 : -tick / 2), r.x + r.w - 0.2, y + (f.y > 0 ? tick / 2 : -tick / 2), { stroke: st.stroke, sw: tick }));
    } else {
      const x = f.x > 0 ? r.x + r.w : r.x;
      out.push(line(x + (f.x > 0 ? -tick / 2 : tick / 2), r.y + 0.2, x + (f.x > 0 ? -tick / 2 : tick / 2), r.y + r.h - 0.2, { stroke: st.stroke, sw: tick }));
    }
    // tag text (rotated along the longer paper side)
    // tag at the 1.8 mm A1 minimum (ISO 3098); inside a pod the pod prefix is dropped (DU01-A-01 → A-01, the pod is labelled once
    // on its outline) and a tag that still does not fit is omitted rather than shrunk below the minimum
    const full = it.e.tag;
    const pn = it.e.podId ? podName(it.e.podId) : '';
    const short = pn && full.startsWith(`${pn}-`) ? full.slice(pn.length + 1) : full;
    const along = Math.max(r.w, r.h) - 1.2;
    const across = Math.min(r.w, r.h);
    if (across >= 2.2 && along >= 3) {
      const size = Math.max(MIN_TEXT_MM, Math.min(it.isRack ? 1.8 : 2.2, across * 0.62));
      const rot = r.h > r.w ? -90 : 0;
      const tag = textWidth(full, size) <= along ? full : textWidth(short, size) <= along ? short : null;
      if (tag) out.push(text(r.x + r.w / 2, r.y + r.h / 2, tag, { size, anchor: 'middle', baseline: 'central', fill: INK, rotate: rot, family: "'DejaVu Sans Mono', Menlo, Consolas, monospace" }));
    }
  }

  // ── dimensions: overall width (top), overall depth (left), pod / aisle chain (right)
  const topY = m.Y(hall.depth) - 12;
  out.push(extLine(m, 0, hall.depth, 0, hall.depth + 14 / s), extLine(m, hall.width, hall.depth, hall.width, hall.depth + 14 / s));
  out.push(dimH(m, 0, hall.width, topY, `${tr(L, 'overall')} ${fmtM(hall.width)}`, 2.4));
  const leftX = m.X(0) - 13;
  out.push(extLine(m, 0, 0, -15 / s, 0), extLine(m, 0, hall.depth, -15 / s, hall.depth));
  out.push(dimV(m, 0, hall.depth, leftX, `${tr(L, 'overall')} ${fmtM(hall.depth)}`, 2.4, 'left'));

  // chain on the right: every y boundary of pods and containments
  const bounds = new Set<number>();
  const pods = scene.pods.filter((p) => p.rect.d > 0);
  for (const p of pods) {
    bounds.add(p.rect.y);
    bounds.add(p.rect.y + p.rect.d);
  }
  for (const c of scene.containments) {
    bounds.add(c.rect.y);
    bounds.add(c.rect.y + c.rect.d);
  }
  const ys = [...bounds].map((v) => Math.round(v * 1000) / 1000).sort((a, b) => a - b);
  const chainX = m.X(hall.width) + 8;
  if (ys.length >= 2) {
    for (const y of ys) out.push(extLine(m, hall.width, y, hall.width + 10 / s, y));
    for (let i = 0; i + 1 < ys.length; i++) {
      const len = ys[i + 1] - ys[i];
      if (len <= 1e-3) continue;
      out.push(dimV(m, ys[i], ys[i + 1], chainX, fmtM(len), 1.8));
    }
  }
  // pod pitch (between consecutive pod rects along y)
  const podsByY = [...pods].sort((a, b) => a.rect.y - b.rect.y);
  let pitchDrawn = false;
  for (let i = 0; i + 1 < podsByY.length; i++) {
    const a = podsByY[i];
    const b = podsByY[i + 1];
    const pitch = b.rect.y - a.rect.y;
    if (pitch <= a.rect.d + 1e-3) continue; // side by side, not stacked
    out.push(dimV(m, a.rect.y, b.rect.y, chainX + 14, `${tr(L, 'podPitch')} ${fmtM(pitch)}`, 2.0));
    pitchDrawn = true;
    break;
  }
  if (!pitchDrawn && podsByY.length) {
    const a = podsByY[0];
    out.push(dimV(m, a.rect.y, a.rect.y + a.rect.d, chainX + 14, `${a.name} ${fmtM(a.rect.d)}`, 2.0));
  }

  // ── north arrow (top-right of the plan)
  const nx0 = m.X(hall.width) + 30;
  const ny0 = m.Y(hall.depth) - 6;
  out.push(circle(nx0, ny0, 5, { fill: PAPER, stroke: INK, sw: 0.3 }));
  out.push(path(`M${nx0} ${ny0 - 4.2} L${nx0 + 1.6} ${ny0 + 3} L${nx0} ${ny0 + 1.6} L${nx0 - 1.6} ${ny0 + 3} Z`, { fill: INK }));
  out.push(text(nx0, ny0 - 6, tr(L, 'north'), { size: 2.6, anchor: 'middle', weight: 700, fill: INK }));

  // ── scale bar (bottom-left of the content area)
  const sbX = area.x + padL;
  const sbY = area.y + area.h - padB + 8;
  const stepM = ratio >= 300 ? 5 : ratio >= 100 ? 2 : 1;
  for (let i = 0; i < 5; i++) out.push(rect(sbX + i * stepM * s, sbY, stepM * s, 1.6, { fill: i % 2 ? PAPER : INK, stroke: INK, sw: 0.2 }));
  for (let i = 0; i <= 5; i++) out.push(text(sbX + i * stepM * s, sbY + 4.4, `${i * stepM}`, { size: 2, anchor: 'middle', fill: INK }));
  out.push(text(sbX + 5 * stepM * s + 3, sbY + 1.6, `m   1:${ratio}`, { size: 2.2, fill: INK, weight: 600 }));

  // ── legend (bottom)
  const entries = [
    { color: categoryPlanStyle('gpu-rack').fill, stroke: categoryPlanStyle('gpu-rack').stroke, label: tr(L, 'gpuRack') },
    { color: categoryPlanStyle('cpu-rack').fill, stroke: categoryPlanStyle('cpu-rack').stroke, label: tr(L, 'cpuRack') },
    { color: categoryPlanStyle('storage-rack').fill, stroke: categoryPlanStyle('storage-rack').stroke, label: tr(L, 'storageRack') },
    { color: SYSTEM_COLOR.trays, label: `${tr(L, 'networkRack')} — ${tr(L, 'leaf')}/${tr(L, 'spine')}` },
    { color: SYSTEM_COLOR.frontend, label: `${tr(L, 'networkRack')} — ${tr(L, 'frontend')}` },
    { color: categoryPlanStyle('mgmt-rack').fill, stroke: categoryPlanStyle('mgmt-rack').stroke, label: tr(L, 'mgmtRack') },
    { color: categoryPlanStyle('crah').fill, stroke: categoryPlanStyle('crah').stroke, label: tr(L, 'crah') },
    { color: categoryPlanStyle('cdu').fill, stroke: categoryPlanStyle('cdu').stroke, label: tr(L, 'cdu') },
    { color: CONTAINMENT_COLOR['hot-aisle'], label: tr(L, 'containment'), dash: '1.6 0.8', kind: 'line' as const },
    { color: 'url(#ko-hatch)', stroke: INK_SOFT, label: tr(L, 'keepout') },
    { color: SYSTEM_COLOR.trays, label: tr(L, 'tray'), kind: 'line' as const, dash: '0.8 0.4' },
    { color: SYSTEM_COLOR['busway-a'], label: tr(L, 'busway'), kind: 'line' as const },
    { color: SYSTEM_COLOR['cdu-supply'], label: tr(L, 'liquid'), kind: 'line' as const, dash: '1.2 0.5' },
    { color: INK, label: tr(L, 'frontTick'), kind: 'line' as const },
    ...(zone?.rect ? [{ color: INK, label: tr(L, 'zoneLegend'), kind: 'line' as const, dash: '4 1 0.8 1' }] : []),
    ...(reservations.some((r) => r.kind === 'reserve') ? [{ color: 'none', stroke: INK_SOFT, label: tr(L, 'reserveLegend'), dash: '1.2 0.7' }] : []),
    ...(reservations.some((r) => r.kind === 'room-partition') ? [{ color: INK, label: tr(L, 'roomPartition'), kind: 'line' as const }] : []),
  ];
  const lg = drawLegend(area.x + padL + 100, area.y + area.h - padB + 4, tr(L, 'legend'), entries, { cols: 3, colW: 90 });
  out.push(lg.svg);
  // stream E (P5): standards basis next to the grid note, only with a profile (legacy plans unchanged)
  const stdBasis = standardsBasisLine(project, hall, L);
  const stdNote = stdBasis ? `  ${tr(L, 'standardsBasis')}: ${stdBasis.profile}` : '';
  const gridNote = `${tr(L, 'grid')}: ${fmtM(tile)} · ${every > 1 ? `${every}×` : ''}${stdNote}`;
  out.push(text(area.x + padL, area.y + area.h - padB + 22, gridNote.length > 84 ? `${gridNote.slice(0, 83)}…` : gridNote, { size: 2, fill: INK_SOFT }));

  return { svg: out.join(''), scale: `1:${ratio}`, rackCount, map: { ox, oy, mmPerM: s, hallW: hall.width, hallD: hall.depth, region: { x: area.x + padL, y: area.y + padT, w: pw, h: ph } } };
}

// ───────────────────────────── r4 B1 shared helpers (101 upgrade · 111 · 121 · 002 · 611) ─────────────────────────────

export type PaperRect = { x: number; y: number; w: number; h: number };

const B1_TEXT = {
  planningGrid: { en: 'PLANNING GRID {g} — NOT STRUCTURAL', ko: '계획 그리드 {g} — 구조 그리드 아님' },
  structAxes: { en: 'STRUCTURAL AXES THROUGH ALIGNED COLUMNS (DERIVED)', ko: '정렬된 기둥을 지나는 구조 축 (파생)' },
  structAxesModel: { en: 'STRUCTURAL GRID (MODEL)', ko: '구조 그리드 (모델)' },
  keyTitle: { en: 'Plan symbols (r4)', ko: '평면 기호 (r4)' },
  keyPos: { en: 'Position tag (gaps unnumbered)', ko: '위치 태그 (갭은 번호 없음)' },
  keyChain: { en: 'Row chain · aisle width', ko: '열 치수선 · 통로 폭' },
  keyGap: { en: 'Unoccupied spacing · enclosure break', ko: '미점유 간격 · 인클로저 구분' },
  keyRcu: { en: 'RCU enclosure (2 / 4 racks)', ko: 'RCU 인클로저 (랙 2 / 4대)' },
  keyCallout: { en: 'Callout → enlarged DU plan', ko: '콜아웃 → DU 확대 평면도' },
  keyDoor: { en: 'Room door swing', ko: '실 출입문 개폐' },
  keyCdoor: { en: 'Containment door', ko: '컨테인먼트 문' },
  north: { en: 'N', ko: 'N' },
  scale: { en: 'Scale', ko: '축척' },
  keyPlan: { en: 'Key plan', ko: '키 플랜' },
  formEia: { en: 'EIA 19" rack', ko: 'EIA 19" 랙' },
  formOcp: { en: 'ORv3 / ORW rack (OU)', ko: 'ORv3 / ORW 랙 (OU)' },
} as const;
export type B1Key = keyof typeof B1_TEXT;

/** Shared B1 sheet vocabulary (EN / KO); `{name}` placeholders are replaced from `vars`. */
export function b1t(L: Locale, key: B1Key, vars: Record<string, string> = {}): string {
  let s: string = B1_TEXT[key][L === 'ko' ? 'ko' : 'en'];
  for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, v);
  return s;
}

/** id-safe token for svg ids / attributes */
export const slugId = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, '-');

/** Length with a unit suffix on metric sheets ("2.40 m"); imperial strings already carry ' and ". */
export function lenU(m: number, units: DrawingUnits, den?: number): string {
  const s = fmtLength(m, units, den);
  return units === 'metric' ? `${s} m` : s;
}

const unescXml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

/** Reserve the paper box of every `<text>` of an existing svg fragment in a culler (new labels never overlap old ones). */
export function reserveSvgTexts(svg: string, culler: LabelCuller): number {
  const re = /<text ([^>]*)>([^<]*)<\/text>/g;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(svg))) {
    const a = m[1];
    const s = unescXml(m[2]);
    if (!s.trim()) continue;
    const num = (key: string) => {
      const r = new RegExp(`(?:^|\\s)${key}="(-?[\\d.]+)"`).exec(a);
      return r ? Number(r[1]) : undefined;
    };
    const x = num('x');
    const y = num('y');
    if (x === undefined || y === undefined) continue;
    const anchor = (/text-anchor="(\w+)"/.exec(a)?.[1] ?? 'start') as 'start' | 'middle' | 'end';
    const bl = /dominant-baseline="(\w+)"/.exec(a)?.[1];
    const rot = Number(/rotate\((-?[\d.]+)/.exec(a)?.[1] ?? 0);
    culler.reserve(textBox(x, y, s, num('font-size') ?? 2.5, anchor, bl === 'central' || bl === 'middle' ? 'central' : 'auto', rot));
    k++;
  }
  return k;
}

const touches = (a: Rect, b: Rect) => a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.d && b.y <= a.y + a.d;
const planRectOf = (p: Prim): Rect => {
  const b = primAabb(p);
  return { x: b.min.x, y: b.min.y, w: b.max.x - b.min.x, d: b.max.y - b.min.y };
};
const unionRects = (rs: readonly Rect[]): Rect | null => {
  if (!rs.length) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rs) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.d);
  }
  return { x: x0, y: y0, w: x1 - x0, d: y1 - y0 };
};

/** Paper box (y down) of a world rect through a viewport. */
export function vpBox(vp: DrawingViewport, r: Rect): PaperRect {
  const [x0, y1] = viewportWorldToPaper(vp, r.x, r.y);
  const [x1, y0] = viewportWorldToPaper(vp, r.x + r.w, r.y + r.d);
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
}

// ── rows of prims (floor-order slots, same rule as annotate) ──

export interface PrimRowSlots {
  rowId: string;
  axis: 'x' | 'y';
  center: number;
  depth: number;
  frontSign: 1 | -1;
  podId?: string;
  letter: string;
  slots: RowSlotsResult<RowSlotInput & { prim: Prim }>;
}

export function primRowSlots(hp: HallPrims): PrimRowSlots[] {
  const byRow = new Map<string, Prim[]>();
  for (const p of hp.prims) {
    if ((p.emitter !== 'rack' && p.emitter !== 'unit') || !p.rowId) continue;
    const l = byRow.get(p.rowId);
    if (l) l.push(p);
    else byRow.set(p.rowId, [p]);
  }
  const out: PrimRowSlots[] = [];
  for (const g of hp.rows) {
    const prims = byRow.get(g.id);
    if (!prims?.length) continue;
    const items = prims.map((p) => {
      const b = primAabb(p);
      return { id: p.id, a0: g.axis === 'x' ? b.min.x : b.min.y, a1: g.axis === 'x' ? b.max.x : b.max.y, kind: p.emitter === 'rack' ? ('rack' as const) : ('unit' as const), ...(p.tag ? { tag: p.tag } : {}), prim: p };
    });
    const racks = prims.filter((p) => p.emitter === 'rack');
    const boxes = (racks.length ? racks : prims).map((p) => primAabb(p));
    const c0 = Math.min(...boxes.map((b) => (g.axis === 'x' ? b.min.y : b.min.x)));
    const c1 = Math.max(...boxes.map((b) => (g.axis === 'x' ? b.max.y : b.max.x)));
    out.push({ rowId: g.id, axis: g.axis, center: g.center, depth: c1 - c0, frontSign: g.frontSign, ...(g.podId ? { podId: g.podId } : {}), letter: rowLetter(g.id), slots: rowSlots(g.id, items) });
  }
  return out;
}

/** equipment id → position tag (A01 …) */
export function positionTagsByEquipment(rows: readonly PrimRowSlots[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of rows) for (const s of r.slots.slots) if (s.positionTag && s.item.prim.refId) m.set(s.item.prim.refId, s.positionTag);
  return m;
}

/** 'pod-01' → 'DU01' */
export function duName(podId: string | undefined): string {
  if (!podId) return '';
  const m = /^pod-(\d+)$/.exec(podId);
  if (m) return `DU${m[1].padStart(2, '0')}`;
  if (podId.startsWith('pod-services')) return 'SV';
  return podId.replace(/^pod-/, '').toUpperCase();
}

/** Union footprint of a pod's racks, units and containment (hall-local m). */
export function podFootprint(hp: HallPrims, podId: string): Rect | null {
  const rowIds = new Set(hp.rows.filter((r) => r.podId === podId).map((r) => r.id));
  return unionRects(hp.prims.filter((p) => ((p.emitter === 'rack' || p.emitter === 'unit') && (p.podId === podId || (p.rowId && rowIds.has(p.rowId)))) || (p.layer === 'containment' && p.podId === podId)).map(planRectOf));
}

/**
 * Enlarged-plan window of a pod (121): pod racks + units + containment, one aisle each side across the rows (to the facing row's front
 * edge + 0.3 m, or to the wall incl. its 0.30 m slab; an aisle is capped at 3.6 m) and 1.2 m past each row end (containment doors).
 */
export function enlargedWindow(hp: HallPrims, hall: Hall, podId: string): Rect | null {
  const rowIds = new Set(hp.rows.filter((r) => r.podId === podId).map((r) => r.id));
  const isMember = (p: Prim) => (p.emitter === 'rack' || p.emitter === 'unit') && (p.podId === podId || (!!p.rowId && rowIds.has(p.rowId)));
  const fp = podFootprint(hp, podId);
  if (!fp) return null;
  const podRows = hp.rows.filter((r) => rowIds.has(r.id));
  const axis: 'x' | 'y' = podRows.length ? (podRows.filter((r) => r.axis === 'x').length >= podRows.length / 2 ? 'x' : 'y') : fp.w >= fp.d ? 'x' : 'y';
  const aLo = axis === 'x' ? fp.x : fp.y;
  const aHi = axis === 'x' ? fp.x + fp.w : fp.y + fp.d;
  const cLo = axis === 'x' ? fp.y : fp.x;
  const cHi = axis === 'x' ? fp.y + fp.d : fp.x + fp.w;
  const La = axis === 'x' ? hall.width : hall.depth;
  const Lc = axis === 'x' ? hall.depth : hall.width;
  let gapHi = Lc - cHi;
  let gapLo = cLo;
  let rowHi = false;
  let rowLo = false;
  for (const p of hp.prims) {
    if ((p.emitter !== 'rack' && p.emitter !== 'unit') || isMember(p)) continue;
    const b = primAabb(p);
    const oa0 = axis === 'x' ? b.min.x : b.min.y;
    const oa1 = axis === 'x' ? b.max.x : b.max.y;
    if (oa1 <= aLo + 1e-6 || oa0 >= aHi - 1e-6) continue;
    const oc0 = axis === 'x' ? b.min.y : b.min.x;
    const oc1 = axis === 'x' ? b.max.y : b.max.x;
    if (oc0 >= cHi - 1e-6 && oc0 - cHi < gapHi) {
      gapHi = oc0 - cHi;
      rowHi = true;
    }
    if (oc1 <= cLo + 1e-6 && cLo - oc1 < gapLo) {
      gapLo = cLo - oc1;
      rowLo = true;
    }
  }
  // an aisle to a facing row shows 0.3 m of that row; an aisle to the wall (≤ 4.2 m) shows the 0.30 m wall slab; wider aisles are cut at 3.6 m
  const ext = (gap: number, row: boolean) => (row ? (gap > 3.6 ? 3.6 : gap + 0.3) : gap > 4.2 ? 3.6 : gap + 0.35);
  const c0 = cLo - ext(Math.max(0, gapLo), rowLo);
  const c1 = cHi + ext(Math.max(0, gapHi), rowHi);
  const a0 = aLo - Math.min(1.2, Math.max(0, aLo) + 0.35);
  const a1 = aHi + Math.min(1.2, Math.max(0, La - aHi) + 0.35);
  const f = (v: number) => Math.floor(v * 20 + 1e-6) / 20;
  const cl = (v: number) => Math.ceil(v * 20 - 1e-6) / 20;
  return axis === 'x' ? { x: f(a0), y: f(c0), w: cl(a1) - f(a0), d: cl(c1) - f(c0) } : { x: f(c0), y: f(a0), w: cl(c1) - f(c0), d: cl(a1) - f(a0) };
}

// ── draw-list clipping (windowed sheets: nothing may leave the viewport) ──

function clipPoly(pts: [number, number][], r: Rect): [number, number][] {
  const edges: [(p: [number, number]) => boolean, (a: [number, number], b: [number, number]) => [number, number]][] = [
    [(p) => p[0] >= r.x, (a, b) => [r.x, a[1] + ((b[1] - a[1]) * (r.x - a[0])) / (b[0] - a[0])]],
    [(p) => p[0] <= r.x + r.w, (a, b) => [r.x + r.w, a[1] + ((b[1] - a[1]) * (r.x + r.w - a[0])) / (b[0] - a[0])]],
    [(p) => p[1] >= r.y, (a, b) => [a[0] + ((b[0] - a[0]) * (r.y - a[1])) / (b[1] - a[1]), r.y]],
    [(p) => p[1] <= r.y + r.d, (a, b) => [a[0] + ((b[0] - a[0]) * (r.y + r.d - a[1])) / (b[1] - a[1]), r.y + r.d]],
  ];
  let cur = pts;
  for (const [inside, cross] of edges) {
    if (!cur.length) break;
    const next: [number, number][] = [];
    for (let i = 0; i < cur.length; i++) {
      const a = cur[(i + cur.length - 1) % cur.length];
      const b = cur[i];
      if (inside(b)) {
        if (!inside(a)) next.push(cross(a, b));
        next.push(b);
      } else if (inside(a)) next.push(cross(a, b));
    }
    cur = next;
  }
  return cur;
}

function clipSegment(ax: number, ay: number, bx: number, by: number, r: Rect): [number, number, number, number] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dy = by - ay;
  const tests: [number, number][] = [[-dx, ax - r.x], [dx, r.x + r.w - ax], [-dy, ay - r.y], [dy, r.y + r.d - ay]];
  for (const [p, q] of tests) {
    if (Math.abs(p) < 1e-12) {
      if (q < 0) return null;
    } else {
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
      if (t0 > t1) return null;
    }
  }
  return [ax + t0 * dx, ay + t0 * dy, ax + t1 * dx, ay + t1 * dy];
}

/**
 * A copy of a draw list with every item clipped to `r` (rects intersected, polygons Sutherland–Hodgman, polylines split, circles kept
 * only when wholly inside — or by centre with `circles: 'centre'` — texts by anchor); bounds become `r` and the hash is recomputed. Shared by plans (121, windowed 101) and
 * sections / elevations (301 / 302 / 311, where r is the (u, z) window) — backlog T2 #8 merged the two copies.
 */
export function clipDrawList(list: DrawList2D, r: Rect, opts: { circles?: 'inside' | 'centre' } = {}): DrawList2D {
  const centre = opts.circles === 'centre';
  const items: DrawItem2D[] = [];
  for (const it of list.items) {
    const p = it.pts;
    if (it.kind === 'rect') {
      const x0 = Math.max(r.x, Math.min(p[0], p[0] + p[2]));
      const y0 = Math.max(r.y, Math.min(p[1], p[1] + p[3]));
      const x1 = Math.min(r.x + r.w, Math.max(p[0], p[0] + p[2]));
      const y1 = Math.min(r.y + r.d, Math.max(p[1], p[1] + p[3]));
      if (x1 - x0 < -1e-9 || y1 - y0 < -1e-9 || (x1 - x0 <= 1e-9 && y1 - y0 <= 1e-9)) continue;
      items.push({ ...it, pts: [x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0)] });
    } else if (it.kind === 'polygon') {
      const pts: [number, number][] = [];
      for (let i = 0; i + 1 < p.length; i += 2) pts.push([p[i], p[i + 1]]);
      const c = clipPoly(pts, r);
      if (c.length >= 3) items.push({ ...it, pts: c.flat() });
    } else if (it.kind === 'polyline') {
      let cur: number[] = [];
      for (let i = 0; i + 3 < p.length; i += 2) {
        const s = clipSegment(p[i], p[i + 1], p[i + 2], p[i + 3], r);
        if (!s) {
          if (cur.length >= 4) items.push({ ...it, pts: cur });
          cur = [];
          continue;
        }
        if (cur.length && Math.abs(cur[cur.length - 2] - s[0]) < 1e-9 && Math.abs(cur[cur.length - 1] - s[1]) < 1e-9) cur.push(s[2], s[3]);
        else {
          if (cur.length >= 4) items.push({ ...it, pts: cur });
          cur = [...s];
        }
      }
      if (cur.length >= 4) items.push({ ...it, pts: cur });
    } else if (it.kind === 'circle') {
      // sections keep a cut pipe / tube circle by its centre (a pipe on the window edge still counts); plans keep only whole circles
      if (centre ? p[0] >= r.x && p[0] <= r.x + r.w && p[1] >= r.y && p[1] <= r.y + r.d : p[0] - p[2] >= r.x - 1e-9 && p[0] + p[2] <= r.x + r.w + 1e-9 && p[1] - p[2] >= r.y - 1e-9 && p[1] + p[2] <= r.y + r.d + 1e-9) items.push(it);
    } else if (p[0] >= r.x && p[0] <= r.x + r.w && p[1] >= r.y && p[1] <= r.y + r.d) items.push(it);
  }
  const out = { ...list, items, bounds: { ...r } };
  return { ...out, hash: drawListHash(out) };
}

// ── structural grid ──

export interface StructuralAxes {
  x: { at: number; label: string }[];
  y: { at: number; label: string }[];
  source: 'model' | 'derived' | 'none';
}

/** Hall.structuralGrid, else axes through column keepout centres aligned within 0.05 m (≥ 2 columns per axis), else none. */
export function structuralAxes(hall: Hall): StructuralAxes {
  const sg = hall.structuralGrid;
  if (sg && (sg.x?.at.length ?? 0) + (sg.y?.at.length ?? 0) > 0) {
    return { x: (sg.x?.at ?? []).map((at, i) => ({ at, label: sg.x?.labels?.[i] ?? String(i + 1) })), y: (sg.y?.at ?? []).map((at, i) => ({ at, label: sg.y?.labels?.[i] ?? colLetter(i) })), source: 'model' };
  }
  const cols = hall.keepouts.filter((k) => k.kind === 'column');
  const cluster = (vals: number[]) => {
    const s = [...vals].sort((a, b) => a - b);
    const groups: number[][] = [];
    for (const v of s) {
      const g = groups[groups.length - 1];
      if (g && v - g[0] <= 0.05 + 1e-9) g.push(v);
      else groups.push([v]);
    }
    return groups.filter((g) => g.length >= 2).map((g) => Math.round((g.reduce((a, b) => a + b, 0) / g.length) * 1000) / 1000);
  };
  const xs = cluster(cols.map((c) => c.rect.x + c.rect.w / 2));
  const ys = cluster(cols.map((c) => c.rect.y + c.rect.d / 2));
  if (!xs.length && !ys.length) return { x: [], y: [], source: 'none' };
  return { x: xs.map((at, i) => ({ at, label: String(i + 1) })), y: ys.map((at, i) => ({ at, label: colLetter(i) })), source: 'derived' };
}

function structuralGridGroup(hall: Hall, vp: DrawingViewport, culler: LabelCuller, L: Locale, units: DrawingUnits): string {
  const ax = structuralAxes(hall);
  const P = (x: number, y: number) => viewportWorldToPaper(vp, x, y);
  const [xl, yt] = P(0, hall.depth);
  const [xr, yb] = P(hall.width, 0);
  const out: string[] = [];
  const caption = ax.source === 'none' ? b1t(L, 'planningGrid', { g: lenU(hall.tileSize > 0 ? hall.tileSize : 0.6, units) }) : b1t(L, ax.source === 'model' ? 'structAxesModel' : 'structAxes');
  for (const [cx, cy] of [[xl + 2, yt + 8.8], [xl + 2, yb - 2.4]] as const) {
    const b = textBox(cx, cy, caption, 2.0, 'start');
    if (!culler.tryPlace(b)) continue;
    out.push(text(cx, cy, caption, { size: 2.0, weight: 600, fill: INK_SOFT }));
    break;
  }
  const bubble = (bx: number, by: number, label: string) => {
    const r = 2.6;
    const b = { x: bx - r, y: by - r, w: 2 * r, h: 2 * r };
    if (!culler.tryPlace(b)) return '';
    return circle(bx, by, r, { fill: PAPER, stroke: INK, sw: PAPER_LW.thin }) + circle(bx, by, r - 0.55, { fill: 'none', stroke: INK, sw: PAPER_LW.hair }) + text(bx, by, label, { size: 2.0, anchor: 'middle', baseline: 'central', weight: 700, fill: INK });
  };
  for (const a of ax.x) {
    const [px] = P(a.at, 0);
    out.push(`<g data-axis="x" data-at="${n(a.at)}">${line(px, yt - 1.5, px, yb + 3.2, { stroke: INK_SOFT, sw: PAPER_LW.thin, dash: DASH_DOT })}${bubble(px, yb + 6, a.label)}</g>`);
  }
  for (const a of ax.y) {
    const [, py] = P(0, a.at);
    out.push(`<g data-axis="y" data-at="${n(a.at)}">${line(xl - 1.5, py, xr + 33.2, py, { stroke: INK_SOFT, sw: PAPER_LW.thin, dash: DASH_DOT })}${bubble(xr + 36, py, a.label)}</g>`);
  }
  return `<g data-layer="structural-grid" data-grid="${ax.source === 'none' ? 'planning' : 'structural'}">${out.join('')}</g>`;
}

// ── doors ──

const arcPts = (fn: (t: number) => Pt, k = 12): Pt[] => Array.from({ length: k + 1 }, (_, i) => fn(((Math.PI / 2) * i) / k));

/** Room door symbols (door prims on 'doors'): leaves swinging in / out (quarter arcs) or a sliding leaf with its travel arrow. */
export function roomDoorSymbols(hp: HallPrims, hall: Hall, vp: DrawingViewport, window?: Rect): string[] {
  const P = (x: number, y: number) => viewportWorldToPaper(vp, x, y);
  const out: string[] = [];
  const W = hall.width;
  const D = hall.depth;
  for (const p of hp.prims) {
    if (p.emitter !== 'door' || p.layer !== 'doors') continue;
    const r = planRectOf(p);
    if (window && !touches(r, window)) continue;
    const wall = String(p.meta?.wall ?? 'W') as 'N' | 'S' | 'E' | 'W';
    const leaves = Number(p.meta?.leaves ?? 1) === 2 ? 2 : 1;
    const swing = String(p.meta?.swing ?? 'in');
    const alongY = wall === 'W' || wall === 'E';
    const s0 = alongY ? r.y : r.x;
    const s1 = alongY ? r.y + r.d : r.x + r.w;
    const world = (s: number, off: number): Pt => {
      const [x, y] = wall === 'W' ? [off, s] : wall === 'E' ? [W - off, s] : wall === 'S' ? [s, off] : [s, D - off];
      return P(x, y);
    };
    const els: string[] = [];
    if (swing === 'sliding') {
      const off = 0.12;
      els.push(line(...world(s0, off), ...world(s1, off), { stroke: INK, sw: PAPER_LW.medium }));
      const [ax, ay] = world(s1 + 0.1, off + 0.12);
      const [bx, by] = world(s1 - Math.min(0.6, (s1 - s0) / 2), off + 0.12);
      els.push(line(bx, by, ax, ay, { stroke: INK, sw: PAPER_LW.hair }));
      els.push(circle(ax, ay, 0.35, { fill: INK }));
    } else {
      const base = swing === 'out' ? -0.3 : 0;
      const dir = swing === 'out' ? -1 : 1;
      const hinges: [number, number][] = leaves === 2 ? [[s0, 1], [s1, -1]] : [[s0, 1]];
      const lw = (s1 - s0) / leaves;
      for (const [h, sg] of hinges) {
        els.push(line(...world(h, base), ...world(h, base + dir * lw), { stroke: INK, sw: PAPER_LW.medium }));
        els.push(polyline(arcPts((t) => world(h + sg * lw * Math.cos(t), base + dir * lw * Math.sin(t))), { stroke: INK, sw: PAPER_LW.hair }));
      }
    }
    out.push(`<g data-door="${esc(p.id)}" data-swing="${esc(swing)}" data-leaves="${leaves}">${els.join('')}</g>`);
  }
  return out;
}

/** Containment end doors: sliding (two leaves outside the frame with travel arrows) or swing-double (two outward quarter arcs). */
export function containmentDoorSymbols(hp: HallPrims, vp: DrawingViewport, window?: Rect): string[] {
  const P = (x: number, y: number) => viewportWorldToPaper(vp, x, y);
  const kindOf = new Map<string, string>();
  for (const p of hp.prims) if (p.emitter === 'containment-panel' && p.refId && typeof p.meta?.kind === 'string') kindOf.set(p.refId, p.meta.kind);
  const out: string[] = [];
  for (const p of hp.prims) {
    if (p.emitter !== 'door' || p.layer !== 'containment-doors') continue;
    const r = planRectOf(p);
    if (window && !touches(r, window)) continue;
    const axis = (p.meta?.axis === 'y' ? 'y' : 'x') as 'x' | 'y';
    const end = Number(p.meta?.end ?? 0);
    const type = String(p.meta?.doorType ?? 'sliding');
    const out1 = end === 0 ? -1 : 1;
    const ae = axis === 'x' ? r.x + r.w / 2 : r.y + r.d / 2;
    const p0 = axis === 'x' ? r.y : r.x;
    const p1 = axis === 'x' ? r.y + r.d : r.x + r.w;
    const W = (al: number, ac: number): Pt => (axis === 'x' ? P(al, ac) : P(ac, al));
    const col = CONTAINMENT_COLOR[kindOf.get(p.refId ?? '') === 'cold-aisle' ? 'cold-aisle' : 'hot-aisle'];
    const els: string[] = [line(...W(ae, p0), ...W(ae, p1), { stroke: col, sw: PAPER_LW.medium })];
    const mid = (p0 + p1) / 2;
    if (type === 'swing-double') {
      const lw = (p1 - p0) / 2;
      for (const [h, sg] of [[p0, 1], [p1, -1]] as const) {
        els.push(line(...W(ae, h), ...W(ae + out1 * lw, h), { stroke: col, sw: PAPER_LW.thin }));
        els.push(polyline(arcPts((t) => W(ae + out1 * lw * Math.sin(t), h + sg * lw * Math.cos(t))), { stroke: col, sw: PAPER_LW.hair }));
      }
    } else {
      for (const [c0, c1, sg] of [[p0, mid + 0.04, -1], [mid - 0.04, p1, 1]] as const) {
        const poly = [W(ae + out1 * 0.05, c0), W(ae + out1 * 0.05, c1), W(ae + out1 * 0.1, c1), W(ae + out1 * 0.1, c0)];
        els.push(polygon(poly, { fill: PAPER, stroke: col, sw: PAPER_LW.thin }));
        const edge = sg < 0 ? c0 : c1;
        const [ax, ay] = W(ae + out1 * 0.2, edge + sg * 0.3);
        const [bx, by] = W(ae + out1 * 0.2, edge - sg * 0.25);
        els.push(line(bx, by, ax, ay, { stroke: col, sw: PAPER_LW.hair }));
        const dx = ax - bx;
        const dy = ay - by;
        const d = Math.hypot(dx, dy) || 1;
        const ux = dx / d;
        const uy = dy / d;
        els.push(polygon([[ax, ay], [ax - ux * 1.1 - uy * 0.45, ay - uy * 1.1 + ux * 0.45], [ax - ux * 1.1 + uy * 0.45, ay - uy * 1.1 - ux * 0.45]], { fill: col }));
      }
    }
    out.push(`<g data-door="${esc(p.id)}" data-door-type="${esc(type)}">${els.join('')}</g>`);
  }
  return out;
}

// ── RCU enclosures, unoccupied spacing ──

export const GAP_INK = '#c2185b';

/** RCU enclosure outlines (rack meta.rcu groups; red when not 2 or 4), with a short label on the rear side when it fits. */
export function rcuOutlines(hp: HallPrims, vp: DrawingViewport, culler: LabelCuller, _L: Locale, window?: Rect): string[] {
  const groups = new Map<string, Prim[]>();
  for (const p of hp.prims) {
    if (p.emitter !== 'rack' || typeof p.meta?.rcu !== 'string' || !p.meta.rcu) continue;
    const l = groups.get(p.meta.rcu);
    if (l) l.push(p);
    else groups.set(p.meta.rcu, [p]);
  }
  const out: string[] = [];
  for (const [id, ps] of [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    const u = unionRects(ps.map(planRectOf))!;
    if (window && !touches(u, window)) continue;
    const r = { x: u.x - 0.05, y: u.y - 0.05, w: u.w + 0.1, d: u.d + 0.1 };
    const b = vpBox(vp, r);
    const ok = ps.length === 2 || ps.length === 4;
    const stroke = ok ? CALLOUT_INK : '#c62828';
    out.push(`<rect x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}" fill="none" stroke="${stroke}" stroke-width="${n(PAPER_LW.thin)}" stroke-dasharray="2 0.8" data-rcu="${esc(id)}" data-rcu-count="${ps.length}"/>`);
    const label = `${id.split(/[-_]/).pop() ?? id} ×${ps.length}`;
    const fs = Number(ps[0].meta?.frontSign ?? 1) >= 0 ? 1 : -1;
    const alongX = u.w >= u.d;
    // rear side: world −frontSign across the row → paper
    const size = MIN_TEXT_MM;
    const tx = alongX ? b.x + b.w / 2 : fs > 0 ? b.x - 1.4 : b.x + b.w + 1.4;
    const ty = alongX ? (fs > 0 ? b.y + b.h + 1.9 : b.y - 0.9) : b.y + b.h / 2;
    const rot = alongX ? 0 : -90;
    const box = textBox(tx, ty, label, size, 'middle', 'central', rot);
    if (textWidth(label, size) <= (alongX ? b.w : b.h) && culler.tryPlace(box)) out.push(text(tx, ty, label, { size, anchor: 'middle', baseline: 'central', fill: stroke, weight: 600, rotate: rot || undefined }));
  }
  return out;
}

/** Unoccupied-spacing marks (magenta dashed line across the row) and enclosure breaks (double tick), with data-gap-after / data-break-after. */
export function gapMarks(rows: readonly PrimRowSlots[], vp: DrawingViewport, _L: Locale, _units: DrawingUnits, _den: number, window?: Rect): string[] {
  const P = (x: number, y: number) => viewportWorldToPaper(vp, x, y);
  const out: string[] = [];
  for (const r of rows) {
    for (const g of r.slots.gaps) {
      const a = (g.a0 + g.a1) / 2;
      const c0 = r.center - r.depth / 2 - 0.15;
      const c1 = r.center + r.depth / 2 + 0.15;
      const wr: Rect = r.axis === 'x' ? { x: g.a0, y: c0, w: g.width, d: c1 - c0 } : { x: c0, y: g.a0, w: c1 - c0, d: g.width };
      if (window && !touches(wr, window)) continue;
      const W = (al: number, ac: number) => (r.axis === 'x' ? P(al, ac) : P(ac, al));
      const after = g.afterPosition !== undefined ? String(g.afterPosition).padStart(2, '0') : '00';
      if (g.kind === 'gap') out.push(`<line x1="${n(W(a, c0)[0])}" y1="${n(W(a, c0)[1])}" x2="${n(W(a, c1)[0])}" y2="${n(W(a, c1)[1])}" stroke="${GAP_INK}" stroke-width="${n(PAPER_LW.medium)}" stroke-dasharray="1.2 0.7" data-row="${esc(r.rowId)}" data-gap-after="${after}" data-gap-m="${n(g.width, 3)}"/>`);
      else {
        const d = Math.max(0.02, g.width * 0.25);
        for (const [k, aa] of [[0, a - d], [1, a + d]] as const) {
          const [x1, y1] = W(aa, r.center - r.depth / 2 + 0.1);
          const [x2, y2] = W(aa, r.center + r.depth / 2 - 0.1);
          out.push(`<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" stroke="${INK}" stroke-width="${n(PAPER_LW.thin)}"${k === 0 ? ` data-row="${esc(r.rowId)}" data-break-after="${after}"` : ''}/>`);
        }
      }
    }
  }
  return out;
}

// ── form factor ──

/** Rack form factor from the catalog (meta.rackForm eia-19 / orv3-21 / orw-double-wide) or the instance meta; undefined when unknown. */
export function formFactorOf(p: Prim): 'EIA' | 'ORv3' | undefined {
  const cat = typeof p.meta?.catalogId === 'string' ? findCatalogItem(p.meta.catalogId) : undefined;
  const f = cat?.meta?.rackForm ?? p.meta?.rackForm ?? p.meta?.formFactor;
  if (typeof f !== 'string') return undefined;
  const s = f.toLowerCase();
  if (s.startsWith('eia')) return 'EIA';
  if (s.startsWith('orv3') || s.startsWith('orw') || s.startsWith('ocp')) return 'ORv3'; // 'ocp…' = legacy stored meta
  return undefined;
}

/** Form-factor layer: a light hatch (plans) or a ` EIA` / ` ORv3` suffix near the rack front (enlarged plans). '' when no rack has a known form. */
export function formFactorGroup(hp: HallPrims, vp: DrawingViewport, defs: string[], mode: 'hatch' | 'suffix', culler: LabelCuller, prefix: string, window?: Rect): string {
  const els: string[] = [];
  const used = new Set<string>();
  for (const p of hp.prims) {
    if (p.emitter !== 'rack') continue;
    const f = formFactorOf(p);
    if (!f) continue;
    const r = planRectOf(p);
    if (window && !touches(r, window)) continue;
    const b = vpBox(vp, r);
    if (mode === 'hatch') {
      used.add(f);
      els.push(`<rect x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}" fill="url(#${prefix}${f.toLowerCase()})" stroke="none" data-form="${f}"/>`);
    } else {
      const fs = Number(p.meta?.frontSign ?? 1) >= 0 ? 1 : -1;
      const alongX = r.w >= r.d;
      // near the front edge inside the footprint
      const tx = alongX ? b.x + b.w / 2 : b.x + b.w / 2;
      const ty = alongX ? b.y + b.h / 2 : fs > 0 ? b.y + 2.2 : b.y + b.h - 2.2;
      const box = textBox(tx, ty, f, MIN_TEXT_MM, 'middle', 'central');
      if (box.w <= b.w - 0.6 && culler.tryPlace(box)) els.push(text(tx, ty, f, { size: MIN_TEXT_MM, anchor: 'middle', baseline: 'central', weight: 700, fill: f === 'ORv3' ? '#2f7d32' : '#3949ab' }).replace('<text ', `<text data-form="${f}" `));
    }
  }
  if (!els.length) return '';
  if (used.has('ORv3')) defs.push(hatchDef(`${prefix}orv3`, '#2f7d32', 1.4, 0.12));
  if (used.has('EIA')) defs.push(`<pattern id="${prefix}eia" patternUnits="userSpaceOnUse" width="1.4" height="1.4" patternTransform="rotate(-45)"><line x1="0" y1="0" x2="0" y2="1.4" stroke="#3949ab" stroke-width="0.12"/></pattern>`);
  return `<g data-layer="form-factor">${els.join('')}</g>`;
}

// ── tap-off tags ──

/**
 * One tag per tap-off box (`<position>-<side>`, e.g. A07-B; full tag in data-tag): outside the busway pair, A on its side and B on the
 * other, along the row when it fits the rack pitch, else across it. Placed first and reserved; returns the elements and a count.
 */
/**
 * Tap-off tags `<position>-<side>` beside each tap-off box (three offsets tried against the culler). `force` (default true) keeps the
 * last offset even when it collides, so every box has a tag (111); enlarged plans pass `force: false` below 1:50 (QA r4 sheets: forced
 * tags landed on rack / position tags at 1:100–1:150).
 */
export function tapoffTags(hp: HallPrims, vp: DrawingViewport, rows: readonly PrimRowSlots[], culler: LabelCuller, window?: Rect, opts: { force?: boolean } = {}): { svg: string[]; count: number; forced: number } {
  const pos = positionTagsByEquipment(rows);
  const rowById = new Map(hp.rows.map((r) => [r.id, r]));
  const boxes = hp.prims.filter((p) => p.emitter === 'tapoff' && p.shape === 'box' && typeof p.meta?.equipmentId === 'string');
  const byEq = new Map<string, Prim[]>();
  for (const b of boxes) {
    const k = String(b.meta!.equipmentId);
    const l = byEq.get(k);
    if (l) l.push(b);
    else byEq.set(k, [b]);
  }
  const out: string[] = [];
  let count = 0;
  let forced = 0;
  const k = vp.mmPerM;
  const size = MIN_TEXT_MM;
  for (const b of boxes) {
    const r = planRectOf(b);
    if (window && !touches(r, window)) continue;
    const row = b.rowId ? rowById.get(b.rowId) : undefined;
    const axis: 'x' | 'y' = row?.axis ?? (r.w >= r.d ? 'x' : 'y');
    const side = String(b.meta?.side ?? 'A');
    const eq = String(b.meta!.equipmentId);
    const other = byEq.get(eq)?.find((o) => o !== b);
    const cSelf = axis === 'x' ? r.y + r.d / 2 : r.x + r.w / 2;
    const cOther = other ? (axis === 'x' ? planRectOf(other).y + planRectOf(other).d / 2 : planRectOf(other).x + planRectOf(other).w / 2) : row ? row.center : cSelf - 1;
    const dir = Math.sign(cSelf - cOther) || (side === 'A' ? -1 : 1);
    const label = `${pos.get(eq) ?? b.tag?.replace(/^TO-/, '') ?? eq}-${side}`;
    const [cx, cy] = viewportWorldToPaper(vp, r.x + r.w / 2, r.y + r.d / 2);
    // world +across → paper: x rows (across = y) → (0, −1); y rows (across = x) → (1, 0)
    const ux = axis === 'x' ? 0 : dir;
    const uy = axis === 'x' ? -dir : 0;
    const half = (TAPOFF_HALF_M * k);
    const tw = textWidth(label, size);
    const pitch = 0.6 * k;
    const alongFits = tw + 0.8 <= pitch;
    const rot = alongFits ? (axis === 'x' ? 0 : -90) : axis === 'x' ? -90 : 0;
    const ext = alongFits ? size / 2 : tw / 2;
    for (let i = 0; i < 3; i++) {
      const off = half + 0.5 + ext + i * (size + 0.6);
      const tx = cx + ux * off;
      const ty = cy + uy * off;
      const box = textBox(tx, ty, label, size, 'middle', 'central', rot);
      const ok = culler.tryPlace(box);
      if (!ok && (i < 2 || opts.force === false)) continue;
      if (!ok) {
        forced++;
        // Forced tags are still real occupied text. Reserve them so later match-line and furniture labels route around them.
        culler.reserve(box);
      }
      out.push(text(tx, ty, label, { size, anchor: 'middle', baseline: 'central', fill: side === 'A' ? '#8a4f00' : SYSTEM_COLOR['busway-b'], family: MONO, rotate: rot || undefined }).replace('<text ', `<text data-tapoff="${esc(b.id)}" data-tag="${esc(b.tag ?? '')}" `));
      count++;
      break;
    }
  }
  return { svg: out, count, forced };
}
const TAPOFF_HALF_M = 0.1;

// ── sheet furniture ──

export function northArrow(x: number, y: number, L: Locale, r = 5): string {
  return circle(x, y, r, { fill: PAPER, stroke: INK, sw: 0.3 }) + path(`M${n(x)} ${n(y - r * 0.84)} L${n(x + r * 0.32)} ${n(y + r * 0.6)} L${n(x)} ${n(y + r * 0.32)} L${n(x - r * 0.32)} ${n(y + r * 0.6)} Z`, { fill: INK }) + text(x, y - r - 1, b1t(L, 'north'), { size: 2.6, anchor: 'middle', weight: 700, fill: INK });
}

/** Alternating scale bar of five steps (metres, or feet on imperial sheets) with the ratio. */
export function scaleBar(x: number, y: number, mmPerM: number, den: number, units: DrawingUnits): { svg: string; w: number } {
  const imperial = units === 'imperial';
  const unitM = imperial ? 0.3048 : 1;
  const steps = imperial ? [1, 2, 5, 10, 20, 50, 100, 200, 500] : [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500];
  const step = steps.find((s) => s * unitM * mmPerM >= 8) ?? steps[steps.length - 1];
  const sw = step * unitM * mmPerM;
  const out: string[] = [];
  for (let i = 0; i < 5; i++) out.push(rect(x + i * sw, y, sw, 1.6, { fill: i % 2 ? PAPER : INK, stroke: INK, sw: 0.2 }));
  for (let i = 0; i <= 5; i++) out.push(text(x + i * sw, y + 4.4, `${Math.round(i * step * 10) / 10}${imperial ? "'" : ''}`, { size: 2, anchor: 'middle', fill: INK }));
  out.push(text(x + 5 * sw + 3, y + 1.6, `${imperial ? 'ft' : 'm'}   1:${den}`, { size: 2.2, fill: INK, weight: 600 }));
  return { svg: out.join(''), w: 5 * sw + 3 + textWidth(`m   1:${den}`, 2.2) };
}

// the key plan inset lives in keyPlan.ts (backlog T2 #8: one copy for 121 and 301 / 302 / 311)
export { keyPlanInset } from './keyPlan.ts';

export interface LegendEntry {
  /** symbol drawn in a 9 × 3.4 mm cell whose top-left is (x, y) */
  draw: (x: number, y: number) => string;
  label: string;
}

/** Framed legend: title + entries in `cols` columns. */
export function legendBox(x: number, y: number, w: number, title: string, entries: readonly LegendEntry[], cols = 1): { svg: string; h: number } {
  const rowH = 4.6;
  const rows = Math.ceil(entries.length / Math.max(1, cols));
  const colW = w / Math.max(1, cols);
  const h = rows * rowH + 8;
  const out = [rect(x, y, w, h, { fill: PAPER, stroke: INK, sw: PAPER_LW.thin }), text(x + 2, y + 4.4, title, { size: 2.6, weight: 700, fill: INK })];
  entries.forEach((e, i) => {
    const c = Math.floor(i / rows);
    const r = i % rows;
    const ex = x + 2 + c * colW;
    const ey = y + 7.2 + r * rowH;
    out.push(e.draw(ex, ey));
    out.push(text(ex + 11, ey + 2.6, fitText(e.label, 2.0, colW - 13), { size: 2.0, fill: INK }));
  });
  return { svg: out.join(''), h };
}

export const sym = {
  line: (stroke: string, sw: number, dash?: string) => (x: number, y: number) => line(x, y + 1.7, x + 9, y + 1.7, { stroke, sw, dash }),
  box: (fill: string, stroke: string, dash?: string) => (x: number, y: number) => rect(x, y + 0.2, 9, 3, { fill, stroke, sw: PAPER_LW.thin, dash }),
  small: (fill: string, stroke: string) => (x: number, y: number) => rect(x + 3.2, y + 0.4, 2.6, 2.6, { fill, stroke, sw: PAPER_LW.thin }),
  text: (s: string, fill = INK) => (x: number, y: number) => text(x + 4.5, y + 2.6, s, { size: 1.8, anchor: 'middle', fill, family: MONO, weight: 600 }),
  mark: (stroke: string) => (x: number, y: number) => line(x + 3, y + 0.2, x + 6, y + 3.2, { stroke, sw: PAPER_LW.medium }) + line(x + 6, y + 0.2, x + 3, y + 3.2, { stroke, sw: PAPER_LW.medium }),
};

function upgradeKey(x: number, y: number, w: number, L: Locale, f: { rcu: boolean; gaps: boolean; doors: boolean; cdoors: boolean; callouts: boolean }): string {
  const entries: LegendEntry[] = [
    { draw: sym.text('A01', INK_SOFT), label: b1t(L, 'keyPos') },
    { draw: (ex, ey) => line(ex, ey + 1.7, ex + 9, ey + 1.7, { stroke: INK, sw: PAPER_LW.hair }) + line(ex - 0.6, ey + 2.3, ex + 0.6, ey + 1.1, { stroke: INK, sw: PAPER_LW.thin }) + line(ex + 8.4, ey + 2.3, ex + 9.6, ey + 1.1, { stroke: INK, sw: PAPER_LW.thin }), label: b1t(L, 'keyChain') },
  ];
  if (f.gaps) entries.push({ draw: (ex, ey) => line(ex + 4.5, ey, ex + 4.5, ey + 3.4, { stroke: GAP_INK, sw: PAPER_LW.medium, dash: '1.2 0.7' }), label: b1t(L, 'keyGap') });
  if (f.rcu) entries.push({ draw: sym.box('none', CALLOUT_INK, '2 0.8'), label: b1t(L, 'keyRcu') });
  if (f.callouts) entries.push({ draw: (ex, ey) => rect(ex, ey + 0.2, 6, 3, { fill: 'none', stroke: CALLOUT_INK, sw: PAPER_LW.thin, dash: DASH_DOT }) + circle(ex + 8, ey + 0.6, 1.4, { fill: PAPER, stroke: CALLOUT_INK, sw: PAPER_LW.thin }), label: b1t(L, 'keyCallout') });
  if (f.doors) entries.push({ draw: (ex, ey) => line(ex + 2, ey + 3.3, ex + 2, ey, { stroke: INK, sw: PAPER_LW.medium }) + polyline(arcPts((t) => [ex + 2 + 3.3 * Math.sin(t), ey + 3.3 - 3.3 * Math.cos(t)]), { stroke: INK, sw: PAPER_LW.hair }), label: b1t(L, 'keyDoor') });
  if (f.cdoors) entries.push({ draw: sym.line(CONTAINMENT_COLOR['hot-aisle'], PAPER_LW.medium), label: b1t(L, 'keyCdoor') });
  return legendBox(x, y, w, b1t(L, 'keyTitle'), entries, 1).svg;
}
