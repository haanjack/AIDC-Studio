// r4 sheet 311-Hn-C<k> — containment aisle-end elevation, one per containment type (kind · roof · ducted · end doors · door type),
// 1:25 A1L: rack end panels, containment panels / roof / chimney, door (sliding or swing-double per doorType), service
// stack above, "(OPEN TO BEYOND)" where nothing tall stands behind the plane, vertical dimensions from FFL (door head, containment
// top, every tier — cumulative), keynotes, generated cross-reference notes (S11) with leaders. Stream B2.
import type { Containment, DrawingViewport, ElevationTarget, Hall, Rect } from '../model/types.ts';
import { hallRackHeight, resolveVerticals } from '../scene/datums.ts';
import type { DrawList2D } from '../scene/drawList.ts';
import { primAabb } from '../scene/prims.ts';
import { elevationCut, projectElevation } from '../scene/project/elevation.ts';
import { frameBox, frameU } from '../scene/project/ortho.ts';
import { ANN_TEXT, crossRefNote, crossRefNotes, LabelCuller, PAPER_LW, textBox, type Annotation2D } from './annotate.ts';
import { hallCode, stubSheetSvg, viewportWorldToPaper, type SheetBuildResult, type SheetContext, type SheetEntry } from './context.ts';
import { tr } from './i18n.ts';
import { CONTAINMENT_COLOR, INK, INK_SOFT, PAPER } from './palette.ts';
import { orthoZRange, presentSystems, renderOrthoSheet, type OrthoOverlay } from './section.ts';
import { A1L, type SheetMeta } from './sheet.ts';
import { line, polygon, rect, text, type Pt } from './svg.ts';
import { drawingUnitsOf, fmtLength } from './units.ts';

const TITLE = { en: 'Containment aisle-end elevation', ko: '컨테인먼트 통로 끝 입면도' };

const S = {
  en: {
    hot: 'hot aisle',
    cold: 'cold aisle',
    roof: 'roof',
    chimney: 'ducted chimney',
    open: 'open top',
    sliding: 'sliding doors',
    swing: 'double swing doors',
    noDoors: 'no end doors',
    typical: (n: number, ids: string) => `typical for ${n}: ${ids}`,
    looking: 'viewed from the aisle end, looking along the aisle',
    openBeyond: ['(OPEN', 'TO', 'BEYOND)'],
    doorNote: (t: string, src: string) => `End doors: ${t} (${src}).`,
    heightNote: (h: string) => `Containment height ${h} (existing); door head 0.10 below (existing viewer rule).`,
    dimNote: 'Heights dimensioned from FFL ±0.00 (top of slab); tiers: pipe / busway centre line, ladders at the underside.',
    tierNote: 'Service tiers: pipe, busway, T1, T2 existing rules; T3 estimate (Hall.verticals).',
    noCont: 'Containment not found in the prims',
    estimate: 'estimate, Containment.doorType absent',
    existing: 'existing',
  },
  ko: {
    hot: '열복도',
    cold: '냉복도',
    roof: '지붕',
    chimney: '덕트 침니',
    open: '상부 개방',
    sliding: '슬라이딩 문',
    swing: '양개 여닫이 문',
    noDoors: '끝 문 없음',
    typical: (n: number, ids: string) => `동일 유형 ${n}개: ${ids}`,
    looking: '통로 끝에서 통로 방향으로 본 입면',
    openBeyond: ['(뒤쪽', '개방)'],
    doorNote: (t: string, src: string) => `끝 문: ${t} (${src}).`,
    heightNote: (h: string) => `컨테인먼트 높이 ${h} (기존); 문 헤드는 0.10 아래 (기존 뷰어 규칙).`,
    dimNote: '높이 치수는 FFL ±0.00 (슬래브 상단) 기준; 배관·버스웨이는 중심선, 래더는 하단.',
    tierNote: '서비스 단: 배관·버스웨이·T1·T2 기존 규칙, T3 추정 (Hall.verticals).',
    noCont: '프림에서 컨테인먼트를 찾지 못함',
    estimate: '추정, Containment.doorType 없음',
    existing: '기존',
  },
} as const;

/** containment "type" signature: one 311 sheet per distinct signature per hall */
export const containmentSignature = (c: Containment) => `${c.kind}|${c.roof ? 1 : 0}|${c.ductedToPlenum ? 1 : 0}|${c.endDoors ? 1 : 0}|${c.doorType ?? 'sliding'}`;

export function listContainmentElevations(ctx: SheetContext): SheetEntry[] {
  const out: SheetEntry[] = [];
  for (const h of ctx.halls) {
    const code = hallCode(ctx.project, h.id);
    const types = new Map<string, Containment[]>();
    for (const c of ctx.project.containments) {
      if (c.hallId !== h.id) continue;
      const k = containmentSignature(c);
      types.set(k, [...(types.get(k) ?? []), c]);
    }
    [...types.values()].forEach((members, k) => {
      out.push({
        id: `aisle-end-${h.id}-${k + 1}`,
        number: `311-${code}-C${k + 1}`,
        title: `${TITLE[ctx.locale]} — ${h.name} C${k + 1}`,
        kind: 'elevation',
        scale: '1:25',
        hallId: h.id,
        zones: members.map((c) => c.rect),
        discipline: tr(ctx.locale, 'disciplineArch'),
        paper: A1L,
        build: (meta) => drawContainmentElevation(ctx, h, members, meta, k),
      });
    });
  }
  return out;
}

const TALL = new Set(['rack', 'unit', 'wall', 'column', 'partition', 'containment-panel', 'door']);

export function drawContainmentElevation(ctx: SheetContext, hall: Hall, members: Containment[], meta: SheetMeta, k = 0): string | SheetBuildResult {
  const L = ctx.locale;
  const T = S[L];
  const units = drawingUnitsOf(ctx.project);
  const hp = ctx.hallPrims(hall.id, 'pod');
  const c = members[0];
  const target: ElevationTarget = { kind: 'aisle-end', containmentId: c.id, end: 0 };
  const ec0 = elevationCut(hp, target);
  if (!ec0 || !ec0.window) return stubSheetSvg(meta, T.noCont);
  // window: the aisle ± 3.0 m (one service aisle each side), clamped to the walls
  const span = ec0.axis === 'x' ? hall.depth : hall.width;
  const q0 = Math.max(-0.45, (ec0.axis === 'x' ? c.rect.y : c.rect.x) - 3.0);
  const q1 = Math.min(span + 0.45, (ec0.axis === 'x' ? c.rect.y + c.rect.d : c.rect.x + c.rect.w) + 3.0);
  const ua = ec0.axis === 'x' ? frameU(ec0, 0, q0) : frameU(ec0, q0, 0);
  const ub = ec0.axis === 'x' ? frameU(ec0, 0, q1) : frameU(ec0, q1, 0);
  const window = { u0: Math.min(ua, ub), u1: Math.max(ua, ub) };
  const ec = elevationCut(hp, target, { window }) ?? ec0;
  if (!ec.window) return stubSheetSvg(meta, T.noCont);
  const list = projectElevation(hp, target, { outlines: 'painter', window });
  const zr = orthoZRange(hall, hp);
  const win: Rect = { x: ec.window.u0, y: zr.z0, w: ec.window.u1 - ec.window.u0, d: zr.z1 - zr.z0 };
  const doorPrim = hp.prims.find((p) => p.id === `door:${c.id}#end0`);
  const doorType = (doorPrim?.meta?.doorType as string | undefined) ?? c.doorType ?? 'sliding';
  const headZ = Number(doorPrim?.meta?.headZ ?? c.height - 0.1);
  const rv = resolveVerticals(hall, hallRackHeight(hp.prims));
  const hasPipe = hp.prims.some((p) => p.emitter === 'pipe');
  const tiers = rv.tiers.filter((t) => t.kind !== 'light' && (t.kind !== 'pipe' || hasPipe || rv.explicitTiers));
  const byId = new Map(hp.prims.map((p) => [p.id, p]));
  const typeText = [c.kind === 'hot-aisle' ? T.hot : T.cold, c.ductedToPlenum ? T.chimney : c.roof ? T.roof : T.open, c.endDoors ? (doorType === 'swing-double' ? T.swing : T.sliding) : T.noDoors].join(', ');
  const ids = members.map((m) => m.id);
  const idsText = ids.length > 4 ? `${ids.slice(0, 4).join(', ')} …` : ids.join(', ');
  const aisleRect = c.rect;
  const len = (m: number, den: number) => fmtLength(m, units, den);

  const tallUMin = (l: DrawList2D) => {
    let u = Infinity;
    for (const it of l.items) {
      const p = it.primId ? byId.get(it.primId) : undefined;
      if (!p || (p.emitter !== 'rack' && p.emitter !== 'unit') || it.kind !== 'rect') continue;
      u = Math.min(u, it.pts[0]);
    }
    return u;
  };

  const tallUMax = (l: DrawList2D) => {
    let u = -Infinity;
    for (const it of l.items) {
      const p = it.primId ? byId.get(it.primId) : undefined;
      if (!p || (p.emitter !== 'rack' && p.emitter !== 'unit') || it.kind !== 'rect') continue;
      u = Math.max(u, it.pts[0] + it.pts[2]);
    }
    return u;
  };

  /** vertical FFL dimensions: one line per level at (u, 0) → (u, z) */
  const fflDims = (l: DrawList2D): { u: number; z: number }[] => {
    const uMax = tallUMax(l);
    const base = Number.isFinite(uMax) ? uMax + 0.45 : win.x + win.w - 2;
    const stops = [...new Map([...(c.endDoors ? [headZ] : []), c.height, ...tiers.map((t) => t.z)].map((z) => [Math.round(z * 1e4) / 1e4, z])).values()].sort((a, b) => a - b);
    // QA r4 sheets: the 0.34 m stagger was clamped at the window edge, so the top dimensions (T1–T3) were drawn on one line. The levels
    // that do not fit right of the right-hand rows continue left of the left-hand rows (outwards), still one line per level.
    const limit = win.x + win.w - 0.2;
    const nRight = Math.max(1, Math.floor((limit - base) / 0.34 + 1e-9) + 1);
    const uMin = tallUMin(l);
    const baseL = Number.isFinite(uMin) ? uMin - 0.45 : win.x + 2;
    return stops.map((z, i) => ({ u: i < nRight ? Math.min(base + 0.34 * i, limit) : Math.max(baseL - 0.34 * (i - nRight), win.x + 0.2), z }));
  };

  const extraAnn = (_vp: DrawingViewport, den: number, l: DrawList2D): Annotation2D[] => {
    const out: Annotation2D[] = [];
    const uMax = tallUMax(l);
    fflDims(l).forEach(({ u, z }, i) => {
      out.push({ kind: 'dim-chain', pts: [u, 0, u, z], texts: [len(z, den)], axis: 'v', priority: 29, layer: 'dimensions', lodMin: 2, size: ANN_TEXT.dim, refId: `ffl-${i}` });
    });
    // keynote 02 — rack end panel of the right-hand row
    if (Number.isFinite(uMax)) out.push({ kind: 'keynote', pts: [uMax + 0.25, 1.75, uMax, 1.3], text: '02', keynoteId: '02', priority: 41, layer: 'keynotes', lodMin: 3, size: ANN_TEXT.keynote });
    return out;
  };

  const overlays = (vp: DrawingViewport, den: number, l: DrawList2D, culler: LabelCuller): OrthoOverlay => {
    const P = (u: number, z: number): Pt => viewportWorldToPaper(vp, u, z);
    const els: string[] = [];
    // ── door symbol per doorType ──
    if (doorPrim && c.endDoors) {
      const m = frameBox(ec, primAabb(doorPrim));
      const [x0, yb] = P(m.u0, 0);
      const [x1, yh] = P(m.u1, headZ);
      const xm = (x0 + x1) / 2;
      const d: string[] = [rect(x0, yh, x1 - x0, yb - yh, { fill: PAPER, stroke: INK, sw: PAPER_LW.medium })];
      if (doorType === 'swing-double') {
        const leaf = (a: number, b: number, hingeX: number) => {
          const w = b - a;
          const h = yb - yh;
          d.push(rect(a + 0.12 * w, yh + 0.12 * h, 0.3 * w, 0.34 * h, { fill: 'none', stroke: INK_SOFT, sw: PAPER_LW.hair }));
          d.push(rect(a + 0.12 * w, yh + 0.56 * h, 0.3 * w, 0.3 * h, { fill: 'none', stroke: INK_SOFT, sw: PAPER_LW.hair }));
          const free = hingeX === a ? b : a;
          // elevation swing convention: dashed chevron with the apex at the hinge side
          d.push(`<polyline points="${free},${yh} ${hingeX},${(yh + yb) / 2} ${free},${yb}" fill="none" stroke="${INK_SOFT}" stroke-width="${PAPER_LW.hair}" stroke-dasharray="1.2 0.8"/>`);
          d.push(line(free + (hingeX === a ? -1.2 : 1.2), (yh + yb) / 2 - 1.5, free + (hingeX === a ? -1.2 : 1.2), (yh + yb) / 2 + 1.5, { stroke: INK, sw: PAPER_LW.medium }));
        };
        leaf(x0, xm, x0);
        leaf(xm, x1, x1);
        d.push(line(xm, yh, xm, yb, { stroke: INK, sw: PAPER_LW.thin }));
      } else {
        // two sliding leaves overlapping at the centre, head track and opening arrows
        d.push(rect(x0 + 0.6, yh + 0.8, xm - x0 + 0.8, yb - yh - 0.8, { fill: 'none', stroke: INK_SOFT, sw: PAPER_LW.thin }));
        d.push(rect(xm - 1.4, yh + 0.8, x1 - xm + 0.8, yb - yh - 0.8, { fill: 'none', stroke: INK_SOFT, sw: PAPER_LW.thin }));
        d.push(line(x0 - 2, yh - 0.8, x1 + 2, yh - 0.8, { stroke: INK, sw: PAPER_LW.medium }));
        const ya = yh + (yb - yh) * 0.45;
        for (const [from, to] of [[xm - 2, x0 + 3], [xm + 2, x1 - 3]] as const) {
          d.push(line(from, ya, to, ya, { stroke: INK, sw: PAPER_LW.thin }));
          const s = Math.sign(to - from);
          d.push(polygon([[to, ya], [to - s * 1.6, ya - 0.7], [to - s * 1.6, ya + 0.7]], { fill: INK }));
        }
      }
      els.push(`<g data-layer="containment-doors" data-door-type="${doorType}" data-door="${doorPrim.id}">${d.join('')}</g>`);
      // glazed transom / chimney hatch above the door
      if (c.roof || c.ductedToPlenum) {
        const zt = Math.min(c.ductedToPlenum ? Math.max(c.height + 0.3, hall.clearHeight) : c.height + 0.04, c.height + 1.1);
        const [, yt] = P(m.u0, zt);
        const [, yc] = P(m.u0, c.height);
        const g: string[] = [];
        for (let i = 0; i < 3; i++) {
          const gx = x0 + ((i + 1) * (x1 - x0)) / 4;
          const gy = yc - ((yc - yt) * (i % 2 === 0 ? 0.35 : 0.6));
          for (const off of [0, 1.1]) g.push(line(gx - 2 + off, gy + 2, gx + 2 + off, gy - 2, { stroke: INK_SOFT, sw: PAPER_LW.hair }));
        }
        els.push(`<g data-layer="containment-roof">${g.join('')}</g>`);
      }
    }
    // ── (OPEN TO BEYOND) where nothing tall stands behind the plane ──
    const covered: [number, number][] = [];
    for (const it of l.items) {
      const p = it.primId ? byId.get(it.primId) : undefined;
      if (!p || !TALL.has(p.emitter) || it.kind !== 'rect') continue;
      if (it.pts[1] > 0.1 || it.pts[1] + it.pts[3] < 1.5) continue;
      covered.push([it.pts[0], it.pts[0] + it.pts[2]]);
    }
    covered.sort((a, b) => a[0] - b[0]);
    const open: [number, number][] = [];
    let u = win.x;
    for (const [a, b] of covered) {
      if (a > u) open.push([u, a]);
      u = Math.max(u, b);
    }
    if (u < win.x + win.w) open.push([u, win.x + win.w]);
    const zX = Math.min(c.height, 2.4);
    // paper boxes of the FFL dimension texts (drawn later through the same culler): the label must not take their place (QA r4 R2:
    // the containment-height "2.30" text was culled by "(OPEN TO BEYOND)" centred on the same spot)
    const dimBoxes = fflDims(l).map(({ u: du, z }) => {
      const [x, y0] = P(du, 0);
      const [, y1] = P(du, z);
      return textBox(x - 0.8, (y0 + y1) / 2, len(z, den), ANN_TEXT.dim, 'middle', 'auto', -90);
    });
    const hits = (p: { x: number; y: number; w: number; h: number }, q: { x: number; y: number; w: number; h: number }) => p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h;
    for (const [a, b] of open) {
      if (b - a < 0.45) continue;
      const [xa, ya] = P(a + 0.12, 0.05);
      const [xb, yb2] = P(b - 0.12, zX);
      const dash = { stroke: INK_SOFT, sw: PAPER_LW.thin, dash: '2 1.2' };
      const lines = T.openBeyond;
      let txt = '';
      // centre first, then lower / upper and off-centre positions inside the crossed box
      for (const [fx, fy] of [[0.5, 0.5], [0.5, 0.25], [0.5, 0.75], [0.3, 0.5], [0.7, 0.5], [0.3, 0.25], [0.7, 0.25], [0.3, 0.75], [0.7, 0.75]] as const) {
        const cx = xa + (xb - xa) * fx;
        const cy = ya + (yb2 - ya) * fy - ((lines.length - 1) * 3.2) / 2;
        const boxes = lines.map((s, i) => textBox(cx, cy + i * 3.2, s, 2.4, 'middle', 'central'));
        if (!boxes.every((bx) => culler.fits(bx) && bx.x >= Math.min(xa, xb) && bx.x + bx.w <= Math.max(xa, xb) && !dimBoxes.some((d) => hits(bx, d)))) continue;
        txt = lines.map((s, i) => text(cx, cy + i * 3.2, s, { size: 2.4, anchor: 'middle', baseline: 'central', fill: INK_SOFT })).join('');
        boxes.forEach((bx) => culler.reserve(bx));
        break;
      }
      els.push(`<g data-layer="notes" data-open-beyond="${a.toFixed(2)}">${line(xa, ya, xb, yb2, dash)}${line(xa, yb2, xb, ya, dash)}${txt}</g>`);
    }
    // ── cross-reference notes with leaders (S11) ──
    const refs = crossRefNotes(ctx.sheetList, ['busway', 'pipes', 'trays'], L, hall.id);
    const layerOf: Record<string, string[]> = { busway: ['busway-a', 'busway-b', 'circuits'], pipes: ['pipes'], trays: ['tray-t1', 'tray-t2', 'tray-t3'] };
    const tierTop = Math.max(c.height, ...tiers.map((t) => t.z + t.heightM));
    refs.forEach((q, i) => {
      const left = i % 2 === 0;
      const zN = Math.min(hall.clearHeight - 0.3, tierTop + 1.0 + 0.45 * Math.floor(i / 2));
      const nu = left ? win.x + 0.25 : win.x + win.w - 0.25;
      let it: (typeof l.items)[number] | undefined;
      let bestD = Infinity;
      for (const x of l.items) {
        if (!layerOf[q.system]?.includes(x.layer) || x.kind !== 'rect') continue;
        const d = Math.abs(x.pts[0] + x.pts[2] / 2 - nu) + Math.abs(x.pts[1] + x.pts[3] - zN);
        if (d < bestD - 1e-9) {
          bestD = d;
          it = x;
        }
      }
      if (!it) return;
      const [nx, ny] = P(nu, zN);
      const target = P(it.pts[0] + it.pts[2] / 2, it.pts[1] + it.pts[3]);
      const note = crossRefNote(nx, ny, q.text, { anchor: left ? 'start' : 'end', leaderTo: target, size: 2.2 });
      if (!culler.fits(note.box)) return;
      culler.reserve(note.box);
      els.push(`<g data-layer="notes" data-xref="${q.system}">${note.svg}</g>`);
    });
    void den;
    return { svg: els.join(''), keynotes: ['02', ...(c.endDoors ? ['05'] : [])] };
  };

  const doorSrc = c.doorType ? T.existing : T.estimate;
  return renderOrthoSheet({
    ctx,
    hall,
    meta,
    hp,
    list,
    window: win,
    space: 'elevation',
    dens: [25, 50, 75, 100, 150, 200],
    cut: ec,
    elevation: target,
    heading: `C${k + 1} ${TITLE[L]} — ${typeText}`,
    subheading: (scale) => `${T.looking} · ${T.typical(members.length, idsText)} · ${scale}`,
    keyPlan: { highlight: members.map((m) => m.rect), cut: { axis: ec.axis, at: ec.at, t0: (ec.axis === 'x' ? aisleRect.y : aisleRect.x) - 1.8, t1: (ec.axis === 'x' ? aisleRect.y + aisleRect.d : aisleRect.x + aisleRect.w) + 1.8, look: ec.look } },
    extraAnn,
    overlays,
    noteSystems: presentSystems(list, hp).filter((s) => s !== 'busway' && s !== 'pipes' && s !== 'trays'),
    notes: [T.doorNote(c.endDoors ? (doorType === 'swing-double' ? T.swing : T.sliding) : T.noDoors, doorSrc), T.heightNote(fmtLength(c.height, units, 25)), T.dimNote, T.tierNote],
  });
}

export { CONTAINMENT_COLOR as ELEVATION_CONTAINMENT_COLOR };
