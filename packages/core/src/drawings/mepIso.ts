// r4 sheet 411-[Hn-]DUnn — assembled MEP piping isometric per DU (NTS A1L). Stream B2.
// Content: CDUs serving the DU, risers, supply / return distribution (cross) headers, row headers split per RCU loop, branches, EPIV
// and isolation valves per rack, loop isolation valves, strainers; racks, containment roof outline and row ladders as context.
// Leader labels with "(TYP.)"; every DN is marked estimate. Right panel: pipe schedule (DN, flow, quantity, length), fittings count,
// legend, basis notes with source tags, cross-reference notes. Geometry from layout/pipes.ts buildPipes (derived, never stored).
import { findCatalogItem } from '../catalog/catalog.ts';
import { buildPipes, DN_INCH, TCS_LPM_PER_KW, TCS_MAX_VELOCITY_MS, TCS_RETURN_RAISE_M } from '../layout/pipes.ts';
import type { Hall, PipeFitting, PipeNetwork, PipeRun } from '../model/types.ts';
import { primAabb } from '../scene/prims.ts';
import { crossRefNotes, PAPER_LW } from './annotate.ts';
import { hallCode, slug, stubSheetSvg, type SheetBuildResult, type SheetContext, type SheetEntry } from './context.ts';
import { tr } from './i18n.ts';
import { IsoScene, isoPoint, type IsoFrame } from './iso.ts';
import { categoryPlanStyle, CONTAINMENT_COLOR, INK, INK_SOFT, LINE_LIGHT, PAPER, SYSTEM_COLOR } from './palette.ts';
import type { ScenePod } from './scene.ts';
import { panelSection, wrapText } from './section.ts';
import { A1L, sheetFrame, type SheetMeta } from './sheet.ts';
import { circle, fitText, line, n, polygon, polyline, rect, svgDocument, text, textWidth, type Pt } from './svg.ts';
import { drawingUnitsOf } from './units.ts';

const TITLE = { en: 'MEP piping isometric', ko: '기계 배관 등각도' };

const S = {
  en: {
    est: '(EST.)',
    typ: '(TYP.)',
    rack: 'LIQUID-COOLED RACK',
    cdu: 'COOLANT DISTRIBUTION UNIT',
    riserS: 'TCS SUPPLY RISER',
    riserR: 'TCS RETURN RISER',
    crossS: 'TCS SUPPLY DISTRIBUTION HEADER',
    crossR: 'TCS RETURN DISTRIBUTION HEADER',
    rowS: 'TCS SUPPLY ROW HEADER',
    rowR: 'TCS RETURN ROW HEADER',
    linkS: 'TCS SUPPLY FROM CDU',
    branchS: 'SUPPLY BRANCH',
    branchR: 'RETURN BRANCH',
    epiv: 'EPIV AT RACK INLET',
    iv: 'ISOLATION VALVE',
    loopIv: 'LOOP ISOLATION VALVE',
    strainer: 'STRAINER',
    tray: 'CABLE LADDER T1',
    cont: 'HOT AISLE CONTAINMENT',
    schedule: 'PIPE SCHEDULE (SIZES ESTIMATED)',
    cols: ['Run', 'DN', 'L/min', 'Qty', 'm'],
    fittings: 'FITTINGS',
    legend: 'LEGEND',
    supply: 'TCS supply',
    ret: 'TCS return',
    notes: 'NOTES',
    kind: { riser: 'Riser', link: 'CDU link', cross: 'Distribution hdr', row: 'Row header', branch: 'Branch' } as Record<string, string>,
    sys: { 'tcs-supply': 'S', 'tcs-return': 'R' } as Record<string, string>,
    fit: { epiv: 'EPIV', 'isolation-valve': 'Isolation valve', strainer: 'Strainer', 'qd-manifold': 'QD manifold' } as Record<string, string>,
    basis: [
      `Flow ${TCS_LPM_PER_KW.value} L/min per kW of rack liquid load (derived, typical TCS design flow); rack liquid kW = nameplate × liquid fraction (catalog).`,
      `Pipe size: smallest DN with velocity ≤ ${TCS_MAX_VELOCITY_MS.value} m/s (typical), Sch 40 bore. All sizes are estimates.`,
      'One EPIV per rack inlet; isolation valves on every branch and CDU riser (AIDC Studio convention).',
      'Row headers split per RCU loop where racks carry an RCU group.',
      `Assembled isometric, not to scale. Return network drawn ${TCS_RETURN_RAISE_M.value} m above supply (routing convention, estimate).`,
    ],
    noCdu: 'No CDU serves this DU in the model: risers and CDU links are omitted.',
    subtitle: (runs: number, racks: number) => `${runs} pipe runs · ${racks} liquid-cooled racks · NTS`,
    noLiquid: 'No liquid-cooled racks in this DU',
  },
  ko: {
    est: '(추정)',
    typ: '(TYP.)',
    rack: '액체 냉각 랙',
    cdu: '냉각수 분배 장치 (CDU)',
    riserS: 'TCS 공급 입상관',
    riserR: 'TCS 환수 입상관',
    crossS: 'TCS 공급 분배 헤더',
    crossR: 'TCS 환수 분배 헤더',
    rowS: 'TCS 공급 열 헤더',
    rowR: 'TCS 환수 열 헤더',
    linkS: 'CDU 공급 연결관',
    branchS: '공급 분기관',
    branchR: '환수 분기관',
    epiv: '랙 입구 EPIV',
    iv: '차단 밸브',
    loopIv: '루프 차단 밸브',
    strainer: '스트레이너',
    tray: '케이블 래더 T1',
    cont: '열복도 컨테인먼트',
    schedule: '배관 일람 (관경 추정)',
    cols: ['구간', 'DN', 'L/min', '수량', 'm'],
    fittings: '부속',
    legend: '범례',
    supply: 'TCS 공급',
    ret: 'TCS 환수',
    notes: '주기',
    kind: { riser: '입상관', link: 'CDU 연결', cross: '분배 헤더', row: '열 헤더', branch: '분기관' } as Record<string, string>,
    sys: { 'tcs-supply': 'S', 'tcs-return': 'R' } as Record<string, string>,
    fit: { epiv: 'EPIV', 'isolation-valve': '차단 밸브', strainer: '스트레이너', 'qd-manifold': 'QD 매니폴드' } as Record<string, string>,
    basis: [
      `유량 ${TCS_LPM_PER_KW.value} L/min / 랙 액체 부하 kW (파생, 일반적인 TCS 설계 유량); 랙 액체 kW = 정격 × 액체 비율 (카탈로그).`,
      `관경: 유속 ≤ ${TCS_MAX_VELOCITY_MS.value} m/s 인 최소 DN (일반 관행), Sch 40 내경. 모든 관경은 추정치.`,
      '랙 입구마다 EPIV 1개, 모든 분기관과 CDU 입상관에 차단 밸브 (AIDC Studio 기준).',
      '랙에 RCU 그룹이 있으면 열 헤더를 RCU 루프별로 분할.',
      `조립 등각도, 축척 없음. 환수 배관은 공급보다 ${TCS_RETURN_RAISE_M.value} m 위에 표현 (배관 규칙, 추정).`,
    ],
    noCdu: '모델에 이 DU를 담당하는 CDU가 없음: 입상관과 CDU 연결관 생략.',
    subtitle: (runs: number, racks: number) => `배관 ${runs}개 · 액체 냉각 랙 ${racks}개 · 축척 없음`,
    noLiquid: '이 DU에 액체 냉각 랙이 없음',
  },
} as const;

export function listMepIsos(ctx: SheetContext): SheetEntry[] {
  const out: SheetEntry[] = [];
  for (const h of ctx.halls) {
    const code = hallCode(ctx.project, h.id);
    for (const pod of ctx.scene(h.id).pods) {
      if (!pod.rows.some((r) => r.liquid)) continue;
      out.push({
        id: `mep-iso-${h.id}-${slug(pod.id)}`,
        number: `411-${ctx.multiHall ? `${code}-` : ''}${pod.name}`,
        title: `${TITLE[ctx.locale]} — ${pod.name}`,
        kind: 'mep-iso',
        scale: 'NTS',
        hallId: h.id,
        zones: [pod.rect],
        discipline: tr(ctx.locale, 'disciplineMech'),
        paper: A1L,
        group: { hallId: h.id, zone: 'du', groupKey: pod.name, podId: pod.id },
        build: (meta) => drawMepIso(ctx, h, pod, meta),
      });
    }
  }
  return out;
}

const NETS = new WeakMap<SheetContext, Map<string, PipeNetwork>>();

/** The derived pipe network of a hall, cached per sheet generation. */
export function hallPipeNetwork(ctx: SheetContext, hall: Hall): PipeNetwork {
  let m = NETS.get(ctx);
  if (!m) NETS.set(ctx, (m = new Map()));
  let net = m.get(hall.id);
  if (!net) {
    const eq = ctx.project.equipment.filter((e) => e.hallId === hall.id);
    const cdus = eq.filter((e) => findCatalogItem(e.catalogId)?.category === 'cdu');
    // integration r4: the same network the prims (3D, plans, sections) were built from
    const hp = ctx.hallPrims(hall.id, 'hall');
    net = hp.pipes ?? buildPipes(hall, hp.rows, cdus, hall.verticals, { equipment: eq });
    m.set(hall.id, net);
  }
  return net;
}

const baseRunId = (id: string) => id.replace(/#\d+$/, '');
const runLen = (r: PipeRun) => r.points.reduce((s, p, i) => (i ? s + Math.hypot(p.x - r.points[i - 1].x, p.y - r.points[i - 1].y, p.z - r.points[i - 1].z) : 0), 0);

export function drawMepIso(ctx: SheetContext, hall: Hall, pod: ScenePod, meta: SheetMeta): string | SheetBuildResult {
  const L = ctx.locale;
  const T = S[L];
  const units = drawingUnitsOf(ctx.project);
  const net = hallPipeNetwork(ctx, hall);
  const podRuns = net.runs.filter((r) => r.podId === pod.id && r.kind !== 'riser');
  const cduIds = new Set(podRuns.flatMap((r) => r.cduIds));
  const runs = [...podRuns, ...net.runs.filter((r) => r.kind === 'riser' && r.cduIds.some((id) => cduIds.has(id)))];
  if (!runs.length) return stubSheetSvg(meta, T.noLiquid);
  const runIds = new Set(runs.map((r) => baseRunId(r.id)));
  const fittings = net.fittings.filter((f) => f.runId && runIds.has(f.runId));
  const hp = ctx.hallPrims(hall.id, 'hall');
  const racks = hp.prims.filter((p) => p.emitter === 'rack' && p.podId === pod.id);
  const cdus = hp.prims.filter((p) => p.emitter === 'unit' && p.refId && cduIds.has(p.refId));
  const liquidIds = new Set(runs.filter((r) => r.kind === 'branch').map((r) => r.id.replace(/^tcs-[SR]:/, '').replace(/:branch$/, '')));
  const liquidRackCount = new Set(fittings.filter((f) => f.kind === 'epiv').map((f) => f.equipmentId)).size;

  // region (hall-local) = racks + CDUs + pipes
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let zTop = 0;
  const grow = (x: number, y: number, z = 0) => {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
    zTop = Math.max(zTop, z);
  };
  for (const p of [...racks, ...cdus]) {
    const b = primAabb(p);
    grow(b.min.x, b.min.y, b.max.z);
    grow(b.max.x, b.max.y, b.max.z);
  }
  for (const r of runs) for (const q of r.points) grow(q.x, q.y, q.z);
  x0 -= 0.5;
  y0 -= 0.5;
  x1 += 0.5;
  y1 += 0.5;
  zTop += 0.4;
  const trays = hp.prims.filter((p) => p.emitter === 'tray' && p.layer === 'tray-t1' && Math.abs(p.b.z - p.a.z) < 1e-6).filter((p) => {
    const b = primAabb(p);
    return b.max.x > x0 && b.min.x < x1 && b.max.y > y0 && b.min.y < y1;
  });
  const conts = ctx.project.containments.filter((c) => c.hallId === hall.id && (c.podId === pod.id || (c.rect.x < x1 && c.rect.x + c.rect.w > x0 && c.rect.y < y1 && c.rect.y + c.rect.d > y0)));

  const frame = sheetFrame(meta);
  const c = frame.content;
  const rightW = 176;
  const labelW = 78;
  const area = { x: c.x + labelW + 8, y: c.y + 24, w: c.w - rightW - 8 - 2 * (labelW + 8), h: c.h - 34 };
  // fit the iso of the region box into the area
  const unit: IsoFrame = { scale: 1, ox: 0, oy: 0 };
  let px0 = Infinity;
  let py0 = Infinity;
  let px1 = -Infinity;
  let py1 = -Infinity;
  for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [0, zTop]) {
    const [px, py] = isoPoint(unit, x, y, z);
    px0 = Math.min(px0, px);
    py0 = Math.min(py0, py);
    px1 = Math.max(px1, px);
    py1 = Math.max(py1, py);
  }
  const s = Math.min(area.w / Math.max(px1 - px0, 1e-6), area.h / Math.max(py1 - py0, 1e-6), 60);
  const f: IsoFrame = { scale: s, ox: area.x + (area.w - (px1 - px0) * s) / 2 - px0 * s, oy: area.y + (area.h - (py1 - py0) * s) / 2 - py0 * s };
  const P = (x: number, y: number, z: number): Pt => isoPoint(f, x, y, z);
  const scene = new IsoScene(f);

  // floor + context
  scene.flat([{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }], 0, { fill: '#f5f6f7', stroke: LINE_LIGHT, sw: PAPER_LW.hair }, 1e4);
  // CDUs teal, distinct from the rack greys (plan role colour is too close to the racks in the shaded iso)
  const cduFill = '#9fd3d6';
  for (const p of racks) {
    const b = primAabb(p);
    const liquid = !!p.meta?.liquid || liquidIds.has(p.tag ?? '');
    scene.box(b.min.x, b.min.y, b.min.z, b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z, liquid ? '#dfe5ec' : '#eeeff1', { stroke: '#7d848b', sw: 0.1 });
  }
  for (const p of cdus) {
    const b = primAabb(p);
    scene.box(b.min.x, b.min.y, b.min.z, b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z, cduFill, { stroke: '#2f6f73', sw: 0.14 });
  }
  for (const ct of conts) {
    const r = ct.rect;
    scene.flat([{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.d }, { x: r.x, y: r.y + r.d }], ct.height + 0.02, { fill: CONTAINMENT_COLOR[ct.kind], opacity: 0.1, stroke: CONTAINMENT_COLOR[ct.kind], sw: PAPER_LW.hair, dash: '1.2 0.6' }, -0.5);
  }
  const clampX = (v: number) => Math.min(x1, Math.max(x0, v));
  const clampY = (v: number) => Math.min(y1, Math.max(y0, v));
  for (const t of trays) {
    const a = { x: clampX(t.a.x), y: clampY(t.a.y), z: t.a.z };
    const b = { x: clampX(t.b.x), y: clampY(t.b.y), z: t.b.z };
    if (Math.hypot(b.x - a.x, b.y - a.y) < 0.1) continue;
    scene.run([a, b], 2 * t.halfW, 0.08, '#efe2a2', { opacity: 0.55, stroke: '#b89a2a' });
  }

  // pipes + fittings in their own pass, above the context (every pipe runs above rack / CDU tops; the ladder context never hides them)
  const pipeScene = new IsoScene(f);
  for (const r of runs) {
    const color = r.system === 'tcs-supply' ? SYSTEM_COLOR['cdu-supply'] : SYSTEM_COLOR['cdu-return'];
    const sw = Math.max(0.45, (r.dnMM / 1000) * s);
    let firstPiece = true;
    for (let i = 1; i < r.points.length; i++) {
      const a = r.points[i - 1];
      const b = r.points[i];
      // ≤ 0.6 m pieces so the painter's order stays local (a long header must not sort behind the racks it runs over)
      const pieces = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / 0.6));
      for (let k = 0; k < pieces; k++) {
        const t0 = k / pieces;
        const t1 = (k + 1) / pieces;
        const qa = { x: a.x + (b.x - a.x) * t0, y: a.y + (b.y - a.y) * t0, z: a.z + (b.z - a.z) * t0 };
        const qb = { x: a.x + (b.x - a.x) * t1, y: a.y + (b.y - a.y) * t1, z: a.z + (b.z - a.z) * t1 };
        const pa = P(qa.x, qa.y, qa.z);
        const pb = P(qb.x, qb.y, qb.z);
        const attrs = firstPiece ? ` data-run="${r.id}" data-kind="${r.part ?? r.kind}" data-system="${r.system}" data-dn="${r.dnMM}"` : '';
        firstPiece = false;
        const svg = `<g${attrs}>${polyline([pa, pb], { stroke: INK, sw: sw + 0.3, linecap: 'round' })}${polyline([pa, pb], { stroke: color, sw, linecap: 'round' })}</g>`;
        pipeScene.add((qa.x + qb.x) / 2 + (qa.y + qb.y) / 2 - (qa.z + qb.z) / 2 - 0.02, svg);
      }
    }
  }
  for (const ft of fittings) {
    const [x, y] = P(ft.at.x, ft.at.y, ft.at.z);
    pipeScene.add(ft.at.x + ft.at.y - ft.at.z - 0.08, `<g data-fitting="${ft.kind}"${ft.equipmentId ? ` data-eq="${ft.equipmentId}"` : ''}>${fittingSymbol(ft.kind, x, y)}</g>`);
  }

  // ── leader labels (TYP.) ──
  const dnText = (dn: number) => (units === 'imperial' ? `${DN_INCH[dn] ?? `DN${dn}`}Ø` : `DN${dn}`);
  const first = (pred: (r: PipeRun) => boolean) => runs.find(pred);
  const mid = (r: PipeRun): Pt => {
    const k = Math.floor((r.points.length - 1) / 2);
    const a = r.points[k];
    const b = r.points[Math.min(k + 1, r.points.length - 1)];
    return P((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  };
  const anchors: { at: Pt; label: string }[] = [];
  const addRun = (r: PipeRun | undefined, name: string, typ: boolean) => r && anchors.push({ at: mid(r), label: `${name} ${dnText(r.dnMM)} ${T.est}${typ ? ` ${T.typ}` : ''}` });
  addRun(first((r) => r.kind === 'riser' && r.system === 'tcs-supply'), T.riserS, cdus.length > 1);
  addRun(first((r) => r.kind === 'riser' && r.system === 'tcs-return'), T.riserR, cdus.length > 1);
  addRun(first((r) => r.part === 'cross' && r.system === 'tcs-supply'), T.crossS, false);
  addRun(first((r) => r.part === 'cross' && r.system === 'tcs-return'), T.crossR, false);
  addRun(first((r) => r.part === 'row' && r.system === 'tcs-supply'), T.rowS, true);
  addRun(first((r) => r.part === 'row' && r.system === 'tcs-return'), T.rowR, true);
  addRun(first((r) => r.kind === 'branch' && r.system === 'tcs-supply'), T.branchS, true);
  addRun(first((r) => r.kind === 'branch' && r.system === 'tcs-return'), T.branchR, true);
  const fit = (pred: (q: PipeFitting) => boolean, name: string) => {
    const q = fittings.find(pred);
    if (q) anchors.push({ at: P(q.at.x, q.at.y, q.at.z), label: `${name} ${T.typ}` });
  };
  fit((q) => q.kind === 'epiv', T.epiv);
  fit((q) => q.kind === 'isolation-valve' && /:branch$/.test(q.runId ?? ''), T.iv);
  fit((q) => q.kind === 'isolation-valve' && /:L\d+-\d+:/.test(q.id), T.loopIv);
  fit((q) => q.kind === 'strainer', T.strainer);
  if (cdus[0]) {
    const b = primAabb(cdus[0]);
    anchors.push({ at: P((b.min.x + b.max.x) / 2, b.min.y, (b.min.z + b.max.z) / 2), label: `${T.cdu} ${T.typ}` });
  }
  const lr = racks.find((p) => liquidIds.has(p.tag ?? '')) ?? racks[0];
  if (lr) {
    const b = primAabb(lr);
    anchors.push({ at: P((b.min.x + b.max.x) / 2, b.min.y, b.min.z + 0.8), label: `${T.rack} ${T.typ}` });
  }
  if (trays[0]) anchors.push({ at: P((trays[0].a.x + trays[0].b.x) / 2, (trays[0].a.y + trays[0].b.y) / 2, trays[0].a.z), label: `${T.tray} ${T.typ}` });
  if (conts[0] && conts[0].kind === 'hot-aisle') anchors.push({ at: P(conts[0].rect.x + conts[0].rect.w * 0.7, conts[0].rect.y, conts[0].height), label: T.cont });

  const labels: string[] = [];
  const cx = area.x + area.w / 2;
  for (const side of ['left', 'right'] as const) {
    const list = anchors.filter((a) => (side === 'left' ? a.at[0] < cx : a.at[0] >= cx)).sort((a, b) => a.at[1] - b.at[1]);
    const ys: number[] = [];
    let prev = area.y - 4;
    for (const a of list) {
      const yy = Math.max(a.at[1], prev + 6.4);
      ys.push(yy);
      prev = yy;
    }
    const over = ys.length ? ys[ys.length - 1] - (area.y + area.h) : 0;
    if (over > 0) for (let i = ys.length - 1, lim = area.y + area.h; i >= 0; i--) {
      ys[i] = Math.min(ys[i], lim);
      lim = ys[i] - 6.4;
    }
    list.forEach((a, i) => {
      const lx = side === 'left' ? area.x - 6 : area.x + area.w + 6;
      const t = fitText(a.label, 2.2, labelW - 2);
      const tw = textWidth(t, 2.2);
      const ly = ys[i];
      const elbow: Pt = [side === 'left' ? lx + 2 : lx - 2, ly - 0.8];
      labels.push(`<g data-leader="${i}">${polyline([[side === 'left' ? lx - tw : lx + tw, ly + 0.6], [lx, ly + 0.6], elbow, a.at], { stroke: INK_SOFT, sw: PAPER_LW.hair })}${circle(a.at[0], a.at[1], 0.45, { fill: INK })}${text(lx, ly, t, { size: 2.2, anchor: side === 'left' ? 'end' : 'start', fill: INK })}</g>`);
    });
  }

  // ── right panel ──
  const px = c.x + c.w - rightW;
  const pw = rightW - 4;
  const maxY = c.y + c.h - 4;
  let y = c.y + 4;
  const panel: string[] = [];
  // schedule
  const logical = new Map<string, { r: PipeRun; len: number }>();
  for (const r of runs) {
    const id = baseRunId(r.id);
    const cur = logical.get(id);
    if (cur) cur.len += runLen(r);
    else logical.set(id, { r, len: runLen(r) });
  }
  const order = ['riser', 'link', 'cross', 'row', 'branch'];
  const groups = new Map<string, { kind: string; sys: string; dn: number; flowMin: number; flowMax: number; qty: number; len: number }>();
  for (const { r, len } of logical.values()) {
    const kind = r.kind === 'header' ? (r.part ?? 'row') : r.kind;
    const key = `${order.indexOf(kind)}|${r.system}|${String(1000 - r.dnMM).padStart(4, '0')}`;
    const g = groups.get(key) ?? { kind, sys: r.system, dn: r.dnMM, flowMin: Infinity, flowMax: 0, qty: 0, len: 0 };
    g.flowMin = Math.min(g.flowMin, r.flowLpm ?? 0);
    g.flowMax = Math.max(g.flowMax, r.flowLpm ?? 0);
    g.qty++;
    g.len += len;
    groups.set(key, g);
  }
  const colX = [px + 2, px + 64, px + 96, px + 132, px + 150];
  const sched: string[] = [text(px + 2, y + 4.6, T.schedule, { size: 2.6, weight: 700, fill: INK })];
  let yy = y + 9.6;
  T.cols.forEach((h, i) => sched.push(text(i === 0 ? colX[0] : colX[i] + 14, yy, h, { size: 2.1, weight: 700, fill: INK_SOFT, anchor: i === 0 ? 'start' : 'end' })));
  yy += 1.4;
  sched.push(line(px + 1, yy, px + pw - 1, yy, { stroke: INK, sw: PAPER_LW.hair }));
  for (const [key, g] of [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (yy + 4 > maxY - 80) break;
    yy += 3.7;
    const flow = Math.abs(g.flowMax - g.flowMin) < 0.5 ? `${Math.round(g.flowMax)}` : `${Math.round(g.flowMin)}–${Math.round(g.flowMax)}`;
    const cells = [`${T.kind[g.kind] ?? g.kind} ${T.sys[g.sys]}`, dnText(g.dn), flow, String(g.qty), g.len.toFixed(1)];
    sched.push(`<g data-schedule-row="${key}">${cells.map((v, i) => text(i === 0 ? colX[0] : colX[i] + 14, yy, fitText(v, 2.1, i === 0 ? 60 : 30), { size: 2.1, fill: g.sys === 'tcs-supply' && i === 0 ? SYSTEM_COLOR['cdu-supply'] : g.sys === 'tcs-return' && i === 0 ? SYSTEM_COLOR['cdu-return'] : INK, anchor: i === 0 ? 'start' : 'end' })).join('')}</g>`);
  }
  yy += 2.4;
  panel.push(`<g data-layer="schedule">${rect(px, y, pw, yy - y, { fill: PAPER, stroke: INK, sw: PAPER_LW.thin })}${sched.join('')}</g>`);
  y = yy + 4;
  // fittings count
  const fc = new Map<string, number>();
  for (const q of fittings) fc.set(q.kind, (fc.get(q.kind) ?? 0) + 1);
  const fitRows = [...fc.entries()].sort().map(([k, v]) => ({ text: `${T.fit[k] ?? k}: ${v}` }));
  if (fitRows.length) {
    const fs = panelSection(px, y, pw, maxY, T.fittings, fitRows, 'panel-fittings');
    panel.push(fs.svg);
    y += fs.h + 4;
  }
  // legend
  const lg: string[] = [text(px + 2, y + 4.6, T.legend, { size: 2.6, weight: 700, fill: INK })];
  const lrow = (i: number, sym: string, label: string) => {
    const ly = y + 9 + i * 4.4;
    lg.push(sym.replace(/\{Y\}/g, n(ly)), text(px + 16, ly + 0.8, label, { size: 2.2, fill: INK }));
  };
  lrow(0, `${line(px + 3, 0, px + 12, 0, { stroke: SYSTEM_COLOR['cdu-supply'], sw: 1.2 })}`.replace(/y1="0" x2="([\d.]+)" y2="0"/, 'y1="{Y}" x2="$1" y2="{Y}"'), T.supply);
  lrow(1, `${line(px + 3, 0, px + 12, 0, { stroke: SYSTEM_COLOR['cdu-return'], sw: 1.2 })}`.replace(/y1="0" x2="([\d.]+)" y2="0"/, 'y1="{Y}" x2="$1" y2="{Y}"'), T.ret);
  const fitKinds: PipeFitting['kind'][] = ['epiv', 'isolation-valve', 'strainer'];
  fitKinds.forEach((kd, i) => {
    const ly = y + 9 + (2 + i) * 4.4;
    lg.push(fittingSymbol(kd, px + 7.5, ly), text(px + 16, ly + 0.8, T.fit[kd], { size: 2.2, fill: INK }));
  });
  const lh = 9 + 5 * 4.4;
  panel.push(`<g data-layer="legend">${rect(px, y, pw, lh, { fill: PAPER, stroke: INK, sw: PAPER_LW.thin })}${lg.join('')}</g>`);
  y += lh + 4;
  // notes
  const refs = crossRefNotes(ctx.sheetList, ['pipes', 'cdu', 'containment'], L, hall.id).map((q) => q.text).filter((t) => !/411/.test(t));
  const notes = [...T.basis, ...(cdus.length ? [] : [T.noCdu]), ...refs];
  panel.push(panelSection(px, y, pw, maxY, T.notes, notes.map((t, i) => ({ text: `${i + 1}. ${t}` })), 'panel-notes').svg);

  const head = `<g data-layer="view-title">${text(c.x + 6, c.y + 9, fitText(`${TITLE[L]} — ${pod.name}`, 4, c.w - rightW - 12), { size: 4, weight: 700, fill: INK })}${text(c.x + 6, c.y + 14, T.subtitle(logical.size, liquidRackCount), { size: 2.4, fill: INK_SOFT })}</g>`;
  const body = [...frame.body, head, `<g data-layer="pipes">${scene.render()}${pipeScene.render()}</g>`, `<g data-layer="notes">${labels.join('')}</g>`, ...panel];
  void wrapText;
  return svgDocument(meta.paper?.w ?? A1L.w, meta.paper?.h ?? A1L.h, frame.defs, body, `${meta.number} ${meta.title}`);
}

/** Paper symbol of a fitting centred at (x, y) mm. */
export function fittingSymbol(kind: PipeFitting['kind'], x: number, y: number): string {
  switch (kind) {
    case 'epiv':
      return `${circle(x, y, 1.05, { fill: '#f28c00', stroke: INK, sw: PAPER_LW.hair })}${line(x - 0.6, y, x + 0.6, y, { stroke: INK, sw: PAPER_LW.hair })}`;
    case 'isolation-valve':
      return polygon([[x - 1.2, y - 0.8], [x + 1.2, y + 0.8], [x + 1.2, y - 0.8], [x - 1.2, y + 0.8]], { fill: PAPER, stroke: INK, sw: PAPER_LW.hair });
    case 'strainer':
      return `${polygon([[x - 1.1, y - 0.9], [x + 1.1, y - 0.9], [x, y + 1.1]], { fill: PAPER, stroke: INK, sw: PAPER_LW.hair })}${line(x, y - 0.9, x, y + 1.1, { stroke: INK, sw: PAPER_LW.hair })}`;
    default:
      return rect(x - 1, y - 0.6, 2, 1.2, { fill: PAPER, stroke: INK, sw: PAPER_LW.hair });
  }
}
