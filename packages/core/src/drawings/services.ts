// r4 sheet 111+ — overhead services plan per hall (RCP level, spec §1.1).
// Owner: stream B1. One geometry source: buildHallPrims('pod') → projectPlan(mode 'services') → drawListToSvg, plus sheet labels:
//   racks / CRAH ghosted, CDUs below; busway A / B with tap-off boxes (every box tagged `<position>-<side>`), circuit end ticks c1…,
//   feeders from the power plane, cable trays by tier (T1 solid · T2 dashed · T3 dotted) + drops, TCS supply / return pairs, light
//   strips, containment chimneys, wall sleeves (WallPenetration) and a red × where a feeder crosses the hall wall without one.
import type { DrawingViewport, Hall, Locale, Rect } from '../model/types.ts';
import type { DrawItem2D } from '../scene/drawList.ts';
import type { LayerId } from '../scene/layers.ts';
import { bundleFeederItems, feederBundleLabel, feederBundleMid } from '../scene/project/feeders.ts';
import { projectPlan } from '../scene/project/plan.ts';
import { primAabb, type HallPrims, type Prim } from '../scene/prims.ts';
import { crossRefNotes, equipmentTag, LabelCuller, PAPER_LW, textBox, type NoteSystem } from './annotate.ts';
import { type SheetBuildResult, type SheetContext, type SheetEntry } from './context.ts';
import { tr } from './i18n.ts';
import { CONTAINMENT_COLOR, GHOST_FILL, GHOST_STROKE, INK, INK_SOFT, PAPER, SYSTEM_COLOR } from './palette.ts';
import { b1t, duName, legendBox, lenU, northArrow, primRowSlots, scaleBar, slugId, sym, tapoffTags, vpBox, type LegendEntry } from './plan.ts';
import { A1, sheetFrame, type SheetMeta } from './sheet.ts';
import { esc, fitText, line, n, rect, svgDocument, text, textWidth } from './svg.ts';
import { drawListToSvg, fitViewport, mixOnPaper, PAPER_STYLES } from './toSvg.ts';
import { drawingUnitsOf, fmtLevel } from './units.ts';

const TITLE = { en: 'Overhead services plan', ko: '상부 설비 평면도' };

const S = {
  sub: { en: 'RCP level · racks ghosted · overhead services cut above {z}', ko: '천장 평면 레벨 · 랙 흐리게 표시 · {z} 위 상부 설비' },
  legend: { en: 'Legend', ko: '범례' },
  notes: { en: 'Notes', ko: '주기' },
  rackGhost: { en: 'Rack / CRAH (ghosted, below)', ko: '랙 / CRAH (하부, 흐리게)' },
  cdu: { en: 'CDU (below)', ko: 'CDU (하부)' },
  buswayA: { en: 'Busway A', ko: '버스웨이 A' },
  buswayB: { en: 'Busway B', ko: '버스웨이 B' },
  tapoff: { en: 'Tap-off box + tag <position>-<side>', ko: '탭오프 박스 + 태그 <위치>-<계통>' },
  circuit: { en: 'Circuit end c1… (from the feed end)', ko: '회로 끝 c1… (급전 측부터)' },
  feeder: { en: 'Feeder to switchboard', ko: '배전반 피더' },
  t1: { en: 'Ladder T1 — row (scale-out)', ko: '래더 T1 — 열 (스케일아웃)' },
  t2: { en: 'Ladder T2 — main / cross (FE, storage, OOB)', ko: '래더 T2 — 메인 / 크로스 (FE, 스토리지, OOB)' },
  t3: { en: 'Ladder T3', ko: '래더 T3' },
  t3Pending: { en: 'Ladder T3 — per-tier emission pending (P1)', ko: '래더 T3 — 단별 생성 예정 (P1)' },
  drop: { en: 'Cable drop to rack', ko: '랙 케이블 드롭' },
  tcsS: { en: 'TCS supply (estimate)', ko: 'TCS 공급 (추정)' },
  tcsR: { en: 'TCS return (estimate)', ko: 'TCS 환수 (추정)' },
  light: { en: 'Light strip', ko: '조명 스트립' },
  chimney: { en: 'Containment chimney / roof', ko: '컨테인먼트 침니 / 지붕' },
  sleeve: { en: 'Wall sleeve (declared penetration)', ko: '벽 슬리브 (선언된 관통부)' },
  unsleeved: { en: 'Feeder crossing without a sleeve', ko: '슬리브 없는 피더 관통' },
  room: { en: 'Electrical room (switchboard + UPS)', ko: '전기실 (배전반 + UPS)' },
  levels: { en: 'Service levels', ko: '설비 레벨' },
  stack: { en: 'stack order', ko: '적층 순서' },
  noteEstimate: { en: 'Pipe routes and sizes are estimates (derived); tray tiers T1 row / T2 main — explicit tiers and T3 emission pending (P1).', ko: '배관 경로·규격은 추정값(파생)입니다. 트레이 단: T1 열 / T2 메인 — 명시적 단 및 T3 생성 예정 (P1).' },
  noteTags: { en: 'Busway tag BW-<side>-<DU>-<row> · circuits · source switchboard; tap-off tags <position>-<side>.', ko: '버스웨이 태그 BW-<계통>-<DU>-<열> · 회로 · 급전 배전반; 탭오프 태그 <위치>-<계통>.' },
  noteGhost: { en: 'Racks and CRAH are drawn ghosted for reference; CDUs below the services.', ko: '랙과 CRAH는 참고용으로 흐리게, CDU는 설비 아래에 표시합니다.' },
  noteUnsleeved: { en: '{n} feeder crossing(s) of the hall wall without a declared sleeve (red ×).', ko: '선언된 슬리브 없이 홀 벽을 지나는 피더 {n}곳 (빨간 ×).' },
  noteSleevesOk: { en: 'Every feeder crossing of the hall wall lies inside a declared sleeve.', ko: '홀 벽을 지나는 모든 피더가 선언된 슬리브 안에 있습니다.' },
  noteTapoffs121: { en: 'At this scale tap-off boxes, their tags and rack drops are shown on the 121 enlarged DU plans only.', ko: '이 축척에서는 탭오프 박스·태그와 랙 드롭을 121 DU 확대 평면도에만 표시합니다.' },
  noServices: { en: 'No overhead services in this hall.', ko: '이 홀에는 상부 설비가 없습니다.' },
};
const s = (L: Locale, k: keyof typeof S, vars: Record<string, string> = {}) => {
  let v: string = S[k][L === 'ko' ? 'ko' : 'en'];
  for (const [a, b] of Object.entries(vars)) v = v.replace(`{${a}}`, b);
  return v;
};

export function listServicesPlans(ctx: SheetContext): SheetEntry[] {
  return ctx.halls.map((h, i) => ({
    id: `services-${h.id}`,
    number: String(111 + i),
    title: `${TITLE[ctx.locale]} — ${h.name}`,
    kind: 'services-plan' as const,
    scale: '',
    hallId: h.id,
    zones: ctx.scene(h.id).pods.map((p) => p.rect),
    discipline: tr(ctx.locale, 'disciplineMech'),
    paper: A1,
    build: (meta: SheetMeta) => drawServicesPlan(ctx, h, meta),
  }));
}

/** Layers drawn on 111 (slab / ceiling / floor marks off; circuits drawn as end ticks, not bars). */
/** feeder bundles shorter than this (riser / sleeve stubs) get no circuit-count label on 111 (m) */
const FEEDER_LABEL_MIN_M = 1.5;

export const SERVICES_LAYERS: readonly LayerId[] = ['walls', 'columns', 'doors', 'partitions', 'racks', 'cdu-crah', 'containment', 'containment-roof', 'containment-doors', 'busway-a', 'busway-b', 'tapoffs', 'feeders', 'electrical-rooms', 'tray-t1', 'tray-t2', 'tray-t3', 'drops', 'pipes', 'lights', 'sleeves'];
const SERVICES_SCALES = [50, 75, 100, 150, 200, 250, 300, 400, 500, 750, 1000, 1500, 2000];
const SERVICE_CUT = new Set<LayerId>(['busway-a', 'busway-b', 'tapoffs', 'feeders', 'tray-t1', 'tray-t2', 'tray-t3', 'drops', 'pipes', 'lights', 'sleeves', 'containment-roof']);

export interface UnsleevedCrossing {
  primId: string;
  x: number;
  y: number;
  z: number;
  wall: 'N' | 'S' | 'E' | 'W';
}

/** Horizontal feeder segments that cross the hall rectangle boundary at a point no sleeve prim contains (±0.05 m). */
export function unsleevedCrossings(hp: HallPrims, hall: Hall): UnsleevedCrossing[] {
  const W = hall.width;
  const D = hall.depth;
  const sleeves = hp.prims.filter((p) => p.emitter === 'sleeve').map((p) => primAabb(p));
  const out: UnsleevedCrossing[] = [];
  const seen = new Set<string>();
  for (const p of hp.prims) {
    if (p.emitter !== 'feeder') continue;
    if (Math.abs(p.a.z - p.b.z) > 1e-6) continue;
    const pts: [number, number, 'N' | 'S' | 'E' | 'W'][] = [];
    const { x: ax, y: ay } = p.a;
    const { x: bx, y: by } = p.b;
    const cross = (a: number, b: number, v: number) => (a - v) * (b - v) < 0;
    if (cross(ax, bx, 0)) pts.push([0, ay + ((by - ay) * (0 - ax)) / (bx - ax), 'W']);
    if (cross(ax, bx, W)) pts.push([W, ay + ((by - ay) * (W - ax)) / (bx - ax), 'E']);
    if (cross(ay, by, 0)) pts.push([ax + ((bx - ax) * (0 - ay)) / (by - ay), 0, 'S']);
    if (cross(ay, by, D)) pts.push([ax + ((bx - ax) * (D - ay)) / (by - ay), D, 'N']);
    for (const [x, y, wall] of pts) {
      if (x < -0.05 || x > W + 0.05 || y < -0.05 || y > D + 0.05) continue;
      const z = p.a.z;
      const ok = sleeves.some((b) => x >= b.min.x - 0.05 && x <= b.max.x + 0.05 && y >= b.min.y - 0.05 && y <= b.max.y + 0.05 && z >= b.min.z - 0.05 && z <= b.max.z + 0.05);
      if (ok) continue;
      const key = `${Math.round(x * 10)}|${Math.round(y * 10)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ primId: p.id, x, y, z, wall });
    }
  }
  return out;
}

const compactList = (ks: number[]) => {
  const v = [...new Set(ks)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < v.length; ) {
    let j = i;
    while (j + 1 < v.length && v[j + 1] === v[j] + 1) j++;
    parts.push(j - i >= 2 ? `c${v[i]}–c${v[j]}` : j > i ? `c${v[i]}, c${v[j]}` : `c${v[i]}`);
    i = j + 1;
  }
  return parts.join(', ');
};

export function drawServicesPlan(ctx: SheetContext, hall: Hall, meta: SheetMeta): SheetBuildResult {
  const L = ctx.locale;
  const project = ctx.project;
  const units = drawingUnitsOf(project);
  // scale from the hall-detail extent; tap-off boxes / rack drops (pod detail) only at 1:200 and larger (0.6 m pitch ≥ 3 mm) — beyond
  // that they are left to the 121 enlarged plans (spec §3.4: hall plans use hall detail)
  const hpHall = ctx.hallPrims(hall.id, 'hall');
  const probe = sheetFrame(meta);
  const c = probe.content;
  const legendH = 128;
  const region = { x: c.x + 16, y: c.y + 24, w: c.w - 32, h: c.h - 24 - legendH - 14 };

  const probeList = projectPlan(hpHall, { mode: 'services', layers: [...SERVICES_LAYERS] });
  const pb = probeList.bounds;
  const probeVp = fitViewport({ x: pb.x - 1.2, y: pb.y - 1.2, w: pb.w + 2.4, d: pb.d + 2.4 }, region, { hallId: hall.id, space: 'plan', candidates: SERVICES_SCALES, pad: 0 });
  const podDetail = probeVp.scaleDen <= 200;
  const hp = podDetail ? ctx.hallPrims(hall.id, 'pod') : hpHall;
  const raw = podDetail ? projectPlan(hp, { mode: 'services', layers: [...SERVICES_LAYERS] }) : probeList;
  const primById = new Map(hp.prims.map((p) => [p.id, p]));
  // feeders (backlog T2 #5): parallel circuit feeders of one route form a bundle drawn as one centre line with a circuit-count label
  // (the sheet is a hall-LOD drawing, 1:100–1:500); single feeders stay as drawn. The sleeve tag still carries the run count.
  const fb = bundleFeederItems(raw);
  const inBundle = new Set(fb.bundles.flatMap((b) => b.itemIdx));
  const kept: DrawItem2D[] = fb.list.items.filter((_, i) => !inBundle.has(i));
  const items: DrawItem2D[] = kept.map((it) => {
    const p = it.primId ? primById.get(it.primId) : undefined;
    if (SERVICE_CUT.has(it.layer)) return { ...it, role: 'cut' as const };
    if (p?.emitter === 'unit' && p.meta?.category === 'cdu') return { ...it, role: 'below' as const };
    return it;
  });
  const list = { ...raw, items };
  const b = raw.bounds;
  const world: Rect = { x: b.x - 1.2, y: b.y - 1.2, w: b.w + 2.4, d: b.d + 2.4 };
  const { viewport: vp, scaleDen: den, scale } = fitViewport(world, region, { hallId: hall.id, space: 'plan', candidates: SERVICES_SCALES, pad: 0 });
  meta.scale = scale;
  const frame = sheetFrame(meta);
  const defs = [...frame.defs];
  const body = [...frame.body];
  const culler = new LabelCuller();
  const prefix = `sv-${slugId(hall.id)}-`;
  const cutZ = Math.min(...hp.prims.filter((p) => ['busway', 'tray', 'pipe', 'circuit'].includes(p.emitter)).map((p) => primAabb(p).min.z));

  // header
  const head = `${TITLE[L]} — ${hall.name}`;
  body.push(`<g data-layer="notes">${text(c.x + 8, c.y + 9, head, { size: 4.2, weight: 700, fill: INK })}${text(c.x + 8, c.y + 15, `${s(L, 'sub', { z: Number.isFinite(cutZ) ? fmtLevel(cutZ - 0.05, units) : '—' })} · ${scale}`, { size: 2.4, fill: INK_SOFT })}</g>`);

  // geometry (clipped to the region; every prim lies inside the fitted world rect)
  const rows = primRowSlots(hp);
  const taps = podDetail ? tapoffTags(hp, vp, rows, culler) : { svg: [] as string[], count: 0, forced: 0 };
  const geo = drawListToSvg(list, [], vp, { idPrefix: prefix, hp, culler });
  defs.push(...geo.defs);
  body.push(geo.svg);
  const P = (x: number, y: number) => vpToPaper(vp, x, y);

  const labels: string[] = [];
  const place = (x: number, y: number, str: string, o: { size?: number; anchor?: 'start' | 'middle' | 'end'; rot?: number; fill?: string; weight?: 400 | 500 | 600 | 700; halo?: boolean; attrs?: string }) => {
    const size = o.size ?? 1.8;
    const box = textBox(x, y, str, size, o.anchor ?? 'middle', 'central', o.rot ?? 0);
    if (!culler.tryPlace(box)) return false;
    const halo = o.halo ? rect(box.x - 0.25, box.y - 0.1, box.w + 0.5, box.h + 0.2, { fill: PAPER, stroke: 'none' }) : '';
    const t = text(x, y, str, { size, anchor: o.anchor ?? 'middle', baseline: 'central', fill: o.fill ?? INK, weight: o.weight, rotate: o.rot || undefined });
    labels.push(halo + (o.attrs ? t.replace('<text ', `<text ${o.attrs} `) : t));
    return true;
  };

  // room tags
  const roomEls: string[] = [];
  for (const p of hp.prims) {
    if (p.layer !== 'electrical-rooms') continue;
    const r = vpBox(vp, rectOf(p));
    const [x, y] = [r.x + r.w / 2, r.y + r.h / 2];
    const sw = String(p.meta?.switchboardId ?? '');
    if (place(x, y - 1.6, p.tag ?? 'SWBD', { size: 2.4, weight: 700, fill: p.meta?.side === 'B' ? SYSTEM_COLOR['busway-b'] : '#8a4f00' })) roomEls.push('');
    if (sw) place(x, y + 1.6, sw, { size: 1.8, fill: INK_SOFT });
  }

  // busway tags (one per busway, A at the low end, B at the high end) + circuit end ticks
  const busEls: string[] = [];
  const circuitsByBusway = new Map<string, Prim[]>();
  for (const p of hp.prims) {
    if (p.emitter !== 'circuit' || typeof p.meta?.buswayId !== 'string') continue;
    const l = circuitsByBusway.get(p.meta.buswayId);
    if (l) l.push(p);
    else circuitsByBusway.set(p.meta.buswayId, [p]);
  }
  const roomTagOf = (side: string) => hp.prims.find((p) => p.layer === 'electrical-rooms' && p.meta?.side === side)?.tag ?? `SWBD ${side}`;
  const seenBus = new Set<string>();
  for (const p of hp.prims) {
    if (p.emitter !== 'busway' || !p.refId || seenBus.has(p.refId)) continue;
    seenBus.add(p.refId);
    const segs = hp.prims.filter((q) => q.emitter === 'busway' && q.refId === p.refId);
    const bbs = segs.map((q) => primAabb(q));
    const x0 = Math.min(...bbs.map((q) => q.min.x));
    const x1 = Math.max(...bbs.map((q) => q.max.x));
    const y0 = Math.min(...bbs.map((q) => q.min.y));
    const y1 = Math.max(...bbs.map((q) => q.max.y));
    const alongX = x1 - x0 >= y1 - y0;
    const side = String(p.meta?.side ?? 'A');
    const row = rows.find((r) => r.rowId === p.rowId);
    const rowLabel = row ? `${duName(row.podId) || row.rowId}-${row.letter}` : p.refId;
    const circs = circuitsByBusway.get(p.refId) ?? [];
    const ks = circs.map((q) => Number(q.meta?.circuit ?? 0)).filter((k) => k > 0);
    const tag = `BW-${side}-${rowLabel}${ks.length ? ` · ${compactList(ks)}` : ''} · ${roomTagOf(side)}`;
    const fill = side === 'B' ? SYSTEM_COLOR['busway-b'] : '#8a4f00';
    const attrs = `data-busway="${esc(p.refId)}"`;
    if (alongX) {
      const yc = (y0 + y1) / 2;
      if (side === 'A') {
        const [px, py] = P(x0, yc);
        place(px - 1.2, py, tag, { anchor: 'end', fill, weight: 600, attrs });
      } else {
        const [px, py] = P(x1, yc);
        place(px + 1.2, py, tag, { anchor: 'start', fill, weight: 600, attrs });
      }
    } else {
      const xc = (x0 + x1) / 2;
      if (side === 'A') {
        const [px, py] = P(xc, y0);
        place(px, py + 1.2, tag, { anchor: 'end', rot: -90, fill, weight: 600, attrs });
      } else {
        const [px, py] = P(xc, y1);
        place(px, py - 1.2, tag, { anchor: 'start', rot: -90, fill, weight: 600, attrs });
      }
    }
    // circuit ends
    for (const q of circs) {
      const qa = primAabb(q);
      const k = Number(q.meta?.circuit ?? 0);
      const end = alongX ? qa.max.x : qa.max.y;
      const cc = alongX ? (qa.min.y + qa.max.y) / 2 : (qa.min.x + qa.max.x) / 2;
      const [ex, ey] = alongX ? P(end, cc) : P(cc, end);
      const t = 1.1;
      busEls.push(alongX ? line(ex, ey - t, ex, ey + t, { stroke: fill, sw: PAPER_LW.medium }) : line(ex - t, ey, ex + t, ey, { stroke: fill, sw: PAPER_LW.medium }));
      busEls[busEls.length - 1] = busEls[busEls.length - 1].replace('<line ', `<line data-circuit="${esc(q.refId ?? q.id)}" `);
      if (k > 0) {
        if (alongX) place(ex - 0.4, ey, `c${k}`, { anchor: 'end', size: 1.8, fill, halo: true });
        else place(ex, ey + 0.4, `c${k}`, { anchor: 'end', rot: -90, size: 1.8, fill, halo: true });
      }
    }
  }

  // tier tags (one per tray polyline, at its start)
  const seenTray = new Set<string>();
  for (const p of hp.prims) {
    if (p.emitter !== 'tray') continue;
    const key = (p.refId ?? p.id).replace(/\/s\d+$/, '');
    if (seenTray.has(key)) continue;
    seenTray.add(key);
    const tier = p.tier ?? 'T1';
    const w = Number(p.meta?.widthM ?? 0.3);
    const alongX = Math.abs(p.b.x - p.a.x) >= Math.abs(p.b.y - p.a.y);
    const lo = alongX ? (p.a.x <= p.b.x ? p.a : p.b) : p.a.y <= p.b.y ? p.a : p.b;
    const [px, py] = P(lo.x, lo.y);
    const label = `${tier} ${Math.round(w * 1000)}`;
    const col = PAPER_STYLES[p.system && p.system !== 'it' && p.system !== 'arch' ? p.system : 'trays']?.stroke ?? INK;
    if (alongX) place(px + 1.2 + textWidth(label, 1.8) / 2, py, label, { size: 1.8, fill: col, weight: 600, halo: true, attrs: `data-tier="${tier}"` });
    else place(px, py - 1.2 - textWidth(label, 1.8) / 2, label, { size: 1.8, fill: col, weight: 600, halo: true, rot: -90, attrs: `data-tier="${tier}"` });
  }

  // TCS pipe tags (one per row) over the row-header extent of the derived network (integration r4: risers, cross headers and branches
  // are skipped). Tried past the high end, then past the low end, so the tag survives the tap-off / circuit labels at the row ends.
  const pipeRows = new Map<string, { alongX: boolean; lo: { x: number; y: number }; hi: { x: number; y: number } }>();
  for (const p of hp.prims) {
    if (p.emitter !== 'pipe' || !p.rowId || (p.meta?.part !== undefined && p.meta.part !== 'row') || Math.abs(p.a.z - p.b.z) > 1e-6) continue;
    const alongX = Math.abs(p.b.x - p.a.x) >= Math.abs(p.b.y - p.a.y);
    const [lo, hi] = alongX ? (p.a.x <= p.b.x ? [p.a, p.b] : [p.b, p.a]) : p.a.y <= p.b.y ? [p.a, p.b] : [p.b, p.a];
    const cur = pipeRows.get(p.rowId);
    if (!cur) pipeRows.set(p.rowId, { alongX, lo, hi });
    else if (cur.alongX === alongX) {
      const k = alongX ? 'x' : 'y';
      if (lo[k] < cur.lo[k]) cur.lo = lo;
      if (hi[k] > cur.hi[k]) cur.hi = hi;
    }
  }
  for (const { alongX, lo, hi } of pipeRows.values()) {
    const label = 'TCS S/R';
    const w = textWidth(label, 1.8);
    const o = { size: 1.8, fill: SYSTEM_COLOR['cdu-supply'], weight: 600 as const, halo: true, attrs: 'data-pipe-tag="row"' };
    const [hx, hy] = P(hi.x, hi.y);
    const [lx, ly] = P(lo.x, lo.y);
    if (alongX) {
      if (!place(hx + 1.2 + w / 2, hy, label, o)) place(lx - 1.2 - w / 2, ly, label, o);
    } else if (!place(hx, hy - 1.2 - w / 2, label, { ...o, rot: -90 })) place(lx, ly + 1.2 + w / 2, label, { ...o, rot: -90 });
  }

  // CDU tags inside the footprint
  for (const p of hp.prims) {
    if (p.emitter !== 'unit' || p.meta?.category !== 'cdu' || !p.tag) continue;
    const r = vpBox(vp, rectOf(p));
    const short = p.tag.replace(/^DU\d+-/, '');
    const et = equipmentTag(r, short);
    if (et.box && culler.tryPlace(et.box)) labels.push(et.svg);
  }

  // sleeves + unsleeved crossings
  const sleeveEls: string[] = [];
  for (const p of hp.prims) {
    if (p.emitter !== 'sleeve') continue;
    const r = vpBox(vp, rectOf(p));
    const runs = p.meta?.runs;
    place(r.x + r.w / 2, r.y - 1.6, `SL${runs !== undefined ? ` · ${runs}` : ''}`, { size: 1.8, fill: '#c62828', weight: 600, attrs: `data-sleeve="${esc(p.id)}"` });
  }
  const unsleeved = unsleevedCrossings(hp, hall);
  for (const u of unsleeved) {
    const [x, y] = P(u.x, u.y);
    const k = 1.4;
    sleeveEls.push(`<g data-unsleeved="${esc(u.primId)}">${line(x - k, y - k, x + k, y + k, { stroke: '#c62828', sw: PAPER_LW.heavy })}${line(x + k, y - k, x - k, y + k, { stroke: '#c62828', sw: PAPER_LW.heavy })}</g>`);
  }

  body.push(`<g data-layer="tapoffs">${taps.svg.join('')}</g>`);
  if (busEls.length) body.push(`<g data-layer="circuits">${busEls.join('')}</g>`);
  if (sleeveEls.length) body.push(`<g data-layer="sleeves">${sleeveEls.join('')}</g>`);
  // feeder bundle labels: circuit count at the middle of the centre line, beside it; placed after every other tag so the culler gives
  // room, busway, tier, pipe, CDU and sleeve tags their spots first
  for (const b of fb.bundles) {
    if (b.a1 - b.a0 < FEEDER_LABEL_MIN_M) continue; // riser / sleeve stubs: the bundle line alone
    const [mx, my] = feederBundleMid(b);
    const r = vpBox(vp, { x: mx, y: my, w: 0, d: 0 });
    const str = feederBundleLabel(L, b.count);
    const off = 1.6;
    const rot = b.axis === 'v' ? -90 : 0;
    const cands: [number, number][] = b.axis === 'h' ? [[r.x, r.y - off], [r.x, r.y + off]] : [[r.x - off, r.y], [r.x + off, r.y]];
    for (const [x, y] of cands) if (place(x, y, str, { size: 1.8, rot, fill: '#8a4f00', weight: 600, halo: true, attrs: `data-feeder-bundle="${b.count}"` })) break;
  }

  body.push(`<g data-layer="tags">${labels.join('')}</g>`);
  if (!hp.prims.some((p) => ['busway', 'tray', 'pipe'].includes(p.emitter))) body.push(`<g data-layer="notes">${text(region.x + region.w / 2, region.y + 10, s(L, 'noServices'), { size: 3, anchor: 'middle', fill: INK_SOFT })}</g>`);

  // legend + notes band
  const ly = c.y + c.h - legendH - 4;
  const tiers = new Set(hp.prims.filter((p) => p.emitter === 'tray').map((p) => p.tier ?? 'T1'));
  const st = (k: string) => PAPER_STYLES[k];
  const entries: LegendEntry[] = [
    { draw: sym.box(GHOST_FILL, GHOST_STROKE), label: s(L, 'rackGhost') },
    { draw: sym.box(mixOnPaper(st('cdu').fill, 0.5), '#9aa0a6'), label: s(L, 'cdu') },
    { draw: sym.box(mixOnPaper(SYSTEM_COLOR['busway-a'], 0.35), SYSTEM_COLOR['busway-a']), label: s(L, 'buswayA') },
    { draw: sym.box(mixOnPaper(SYSTEM_COLOR['busway-b'], 0.35), SYSTEM_COLOR['busway-b']), label: s(L, 'buswayB') },
    { draw: (x, y) => sym.small(st('tapoff').fill, st('tapoff').stroke)(x, y), label: s(L, 'tapoff') },
    { draw: (x, y) => line(x + 1, y + 1.7, x + 7, y + 1.7, { stroke: SYSTEM_COLOR['busway-a'], sw: 0.7 }) + line(x + 7, y + 0.5, x + 7, y + 2.9, { stroke: '#8a4f00', sw: PAPER_LW.medium }), label: s(L, 'circuit') },
    { draw: sym.line(st('feeder').stroke, PAPER_LW.medium), label: s(L, 'feeder') },
    { draw: sym.line(SYSTEM_COLOR.trays, 0.9), label: s(L, 't1') },
    { draw: sym.line(SYSTEM_COLOR.frontend, 0.9, st('tray-t2').dash), label: s(L, 't2') },
    { draw: sym.line(SYSTEM_COLOR.oob, 0.9, st('tray-t3').dash), label: s(L, tiers.has('T3') ? 't3' : 't3Pending') },
    { draw: sym.small(mixOnPaper(SYSTEM_COLOR.trays, 0.5), INK_SOFT), label: s(L, 'drop') },
    { draw: sym.line(SYSTEM_COLOR['cdu-supply'], 0.9), label: s(L, 'tcsS') },
    { draw: sym.line(SYSTEM_COLOR['cdu-return'], 0.9), label: s(L, 'tcsR') },
    { draw: sym.box(st('light').fill, st('light').stroke), label: s(L, 'light') },
    { draw: sym.box(mixOnPaper(CONTAINMENT_COLOR['hot-aisle'], 0.07), CONTAINMENT_COLOR['hot-aisle']), label: s(L, 'chimney') },
    { draw: sym.box(st('sleeve').fill, st('sleeve').stroke), label: s(L, 'sleeve') },
    { draw: sym.mark('#c62828'), label: s(L, 'unsleeved') },
    { draw: sym.box('none', INK_SOFT, '2 1'), label: s(L, 'room') },
  ];
  const lg = legendBox(c.x + 8, ly, c.w - 16, s(L, 'legend'), entries, 3);
  const notes: string[] = [];
  const present: NoteSystem[] = ['busway', 'trays', 'pipes', 'cdu'];
  for (const nt of crossRefNotes(ctx.sheetList, present, L, hall.id)) notes.push(nt.text);
  const lv = hp.datums.filter((d) => ['pipe', 'busway', 'T1', 'T2', 'T3', 'light'].includes(d.id)).map((d) => `${d.id === 'pipe' ? 'TCS' : d.id === 'busway' ? 'BW' : d.id === 'light' ? (L === 'ko' ? '조명' : 'light') : d.id} ${fmtLevel(d.z, units)}`);
  if (lv.length) notes.push(`${s(L, 'levels')}: ${lv.join(' · ')} (${s(L, 'stack')}: ${hall.verticals?.stackOrder === 'trays-busway' ? 'trays → busway' : 'pipe → busway → trays'})`);
  notes.push(s(L, podDetail ? 'noteTags' : 'noteTapoffs121'), s(L, 'noteEstimate'), s(L, 'noteGhost'));
  if (hp.prims.some((p) => p.emitter === 'feeder')) notes.push(unsleeved.length ? s(L, 'noteUnsleeved', { n: String(unsleeved.length) }) : s(L, 'noteSleevesOk'));
  const ny = ly + lg.h + 5;
  const noteEls = [text(c.x + 8, ny, s(L, 'notes'), { size: 2.6, weight: 700, fill: INK })];
  notes.forEach((t, i) => {
    if (ny + 4.2 + i * 3.6 > c.y + c.h - 3) return;
    noteEls.push(text(c.x + 8, ny + 4.2 + i * 3.6, fitText(`${i + 1}. ${t}`, 2.1, c.w - 90), { size: 2.1, fill: INK }));
  });
  const sbW = scaleBar(0, 0, vp.mmPerM, den, units).w;
  const sb = scaleBar(c.x + c.w - 26 - sbW, ny + 2, vp.mmPerM, den, units);
  body.push(`<g data-layer="notes">${lg.svg}${noteEls.join('')}${sb.svg}${northArrow(c.x + c.w - 14, ny + 14, L)}</g>`);
  void roomEls;
  void n;
  return { svg: svgDocument(A1.w, A1.h, defs, body, `${meta.number} ${meta.title}`), viewports: [vp] };
}

const rectOf = (p: Prim): Rect => {
  const b = primAabb(p);
  return { x: b.min.x, y: b.min.y, w: b.max.x - b.min.x, d: b.max.y - b.min.y };
};

function vpToPaper(vp: DrawingViewport, x: number, y: number): [number, number] {
  const w = vp.worldRect!;
  return [vp.paperRect.x + (x - w.x) * vp.mmPerM, vp.paperRect.y + vp.paperRect.h - (y - w.y) * vp.mmPerM];
}
