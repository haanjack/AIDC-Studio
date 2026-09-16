import { cableTypes } from '../catalog/catalog.ts';
import * as fitModule from '../layout/fit.ts';
import type { HallLayout } from '../layout/generate.ts';
import { instanceRect } from '../model/geometry.ts';
import type { CableRun, CableType, EquipmentInstance, PlacementCandidate, PlacementReport, Project, SpinePlacement } from '../model/types.ts';
import { buildContext, cableUnitUSD, type Ctx } from './context.ts';
import { analyzeNetworkCtx, isOptical, mediumOf, type NetworkResult, normalizeSpinePlacement, wattsPerEnd } from './network.ts';

/**
 * Spine / core placement comparator (stream S2, PROPOSAL-v2 §3.2, docs/research/spine-placement.md §5–§6).
 *
 * For every `SpinePlacement` candidate the comparator obtains a geometry — `relayoutForPlacement(project, hallId, placement)` from
 * layout/fit.ts (stream S1) when it exists, otherwise an in-place approximation that moves the spine/core racks (end / centre /
 * distributed per pod / separate room +3 m) — runs the network engine on it and reports, for the scale-out leaf→spine (+ spine→core)
 * links: mean / max link vs the medium reach, fibre km, peak tray cross-section at the chosen fill (NEC 392.22 50 % default,
 * TIA-569 40 %), switch-side transceivers and their power, rack positions lost inside the compute area, interconnect USD and
 * over-limit links. Everything uses the single length model `cableLengthM(project, a, b, trays?)`, so the table matches the BOM.
 *
 * Tray demand per cable: fibre patch 3.0 mm → 7.07 mm² (NVIDIA SuperPOD design guide: 3 mm average, 50 % fill); 800G passive DAC
 * 26 AWG 9.43 mm → 69.8 mm²; AEC/ACC ≈ 6.5 mm → 33.2 mm² (estimates).
 */
export interface PlacementInput {
  project: Project;
  ctx: Ctx;
  network: NetworkResult;
}

export interface PlacementOptions {
  /** tray fill ratio for trayPeakMm2 (default 0.5 = NEC 392.22; 0.4 = TIA-569) */
  fillRatio?: number;
  candidates?: SpinePlacement[];
  hallId?: string;
  /** regenerate tray polylines for every candidate and route on the tray graph (default false: Manhattan model for all
   *  candidates — a few ms per variant; with trays ≈ +0.4 s per variant at DU 24 after the heap router) */
  trays?: boolean;
}

export const PLACEMENT_LABEL: Record<SpinePlacement, string> = {
  'central-end': '중앙 집중 · 홀 끝',
  'central-center': '중앙 집중 · 홀 중앙',
  distributed: '분산 (포드별)',
  'separate-room': '별도 네트워크실',
};

const ALL: SpinePlacement[] = ['central-end', 'central-center', 'distributed', 'separate-room'];
const SEPARATE_ROOM_OFFSET_M = 3;

const cableAreaMm2 = (t: CableType): number => {
  if (isOptical(t)) return Math.PI * 1.5 * 1.5;
  if (t.kind === 'dac') return Math.PI * 4.715 * 4.715;
  if (t.kind === 'cat6a') return Math.PI * 3.1 * 3.1;
  return Math.PI * 3.25 * 3.25;
};

type Relayout = (project: Project, hallId: string, placement: SpinePlacement, ro?: { trays?: boolean }) => unknown;

/** S1's relayout hook, when it has landed (contract: `relayoutForPlacement(project, hallId, placement)` in layout/fit.ts). */
function relayoutHook(): Relayout | undefined {
  const fn = (fitModule as Record<string, unknown>).relayoutForPlacement;
  return typeof fn === 'function' ? (fn as Relayout) : undefined;
}

function applyRelayout(project: Project, hallId: string, result: unknown): Project | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const r = result as Partial<Project> & Partial<HallLayout>;
  if (Array.isArray(r.halls) && Array.isArray(r.equipment) && r.schemaVersion === 1) return r as Project;
  if (Array.isArray(r.equipment) && Array.isArray(r.pods)) {
    const layout = r as HallLayout;
    return {
      ...project,
      equipment: [...project.equipment.filter((e) => e.hallId !== hallId), ...layout.equipment],
      containments: [...project.containments.filter((c) => c.hallId !== hallId), ...layout.containments],
    };
  }
  return undefined;
}

/** Hall with the most GPUs (comparator scope for the MVP). */
function primaryHall(ctx: Ctx, hallId?: string): string | undefined {
  if (hallId && ctx.halls.has(hallId)) return hallId;
  let best: string | undefined;
  let bestG = -1;
  for (const [id, list] of ctx.byHall) {
    const g = list.reduce((s, p) => s + (p.item.category === 'gpu-rack' ? p.item.compute?.gpus ?? 0 : 0), 0);
    if (g > bestG) {
      bestG = g;
      best = id;
    }
  }
  return best;
}

/**
 * Geometry approximation used until S1's relayout exists: spine/core racks are re-positioned along the pod stacking axis
 * (end / central inter-pod band / one per pod row end / end + 3 m). Positions are estimates (no collision check, tagged in the notes).
 */
function approximate(project: Project, ctx: Ctx, hallId: string, placement: SpinePlacement): { project: Project; lost: number; notes: string[] } {
  const notes: string[] = [];
  const hall = ctx.halls.get(hallId);
  const inHall = (ctx.byHall.get(hallId) ?? []).filter((p) => p.item.category === 'gpu-rack');
  const spineRacks = (ctx.byHall.get(hallId) ?? []).filter((p) => p.item.category === 'network-rack' && (p.e.networkRole === 'scale-out-spine' || p.e.networkRole === 'scale-out-core'));
  const pods = new Map<string, { minX: number; maxX: number; minY: number; maxY: number; rowY: number }>();
  for (const p of inHall) {
    const r = instanceRect(p.e, p.item);
    const key = p.e.podId ?? 'none';
    const cur = pods.get(key) ?? { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, rowY: p.e.position.y };
    cur.minX = Math.min(cur.minX, r.x);
    cur.maxX = Math.max(cur.maxX, r.x + r.w);
    cur.minY = Math.min(cur.minY, r.y);
    cur.maxY = Math.max(cur.maxY, r.y + r.d);
    pods.set(key, cur);
  }
  if (!hall || spineRacks.length === 0 || pods.size === 0) return { project, lost: 0, notes: ['스파인 랙 또는 컴퓨트 포드가 없어 현재 배치를 그대로 평가합니다.'] };
  const podList = [...pods.entries()].sort((a, b) => a[1].minY - b[1].minY || a[1].minX - b[1].minX);
  const ys = podList.map(([, r]) => (r.minY + r.maxY) / 2);
  const xs = podList.map(([, r]) => (r.minX + r.maxX) / 2);
  const spreadY = Math.max(...ys) - Math.min(...ys);
  const spreadX = Math.max(...xs) - Math.min(...xs);
  const alongY = spreadY >= spreadX; // pods stack along +Y (reference generator) → the core row runs along X
  const moved = new Map<string, Partial<EquipmentInstance>>();
  const w = spineRacks[0].item.dims.w;
  const d = spineRacks[0].item.dims.d;
  const areaMin = alongY ? Math.min(...podList.map(([, r]) => r.minY)) : Math.min(...podList.map(([, r]) => r.minX));
  const areaMax = alongY ? Math.max(...podList.map(([, r]) => r.maxY)) : Math.max(...podList.map(([, r]) => r.maxX));
  const lineStart = alongY ? Math.min(...podList.map(([, r]) => r.minX)) : Math.min(...podList.map(([, r]) => r.minY));
  const line = (i: number, coord: number) => {
    const along = lineStart + i * w + w / 2;
    return alongY ? { x: along, y: coord } : { x: coord, y: along };
  };
  let lost = 0;
  if (placement === 'central-end' || placement === 'separate-room') {
    const coord = areaMax + 1.5 + d / 2 + (placement === 'separate-room' ? SEPARATE_ROOM_OFFSET_M : 0);
    spineRacks.forEach((p, i) => moved.set(p.e.id, { position: line(i, coord), podId: 'pod-services', rowId: 'pod-services-a', networkRole: 'scale-out-spine' }));
    notes.push(placement === 'separate-room' ? `별실: 코어 열을 컴퓨트 구역 끝에서 +${SEPARATE_ROOM_OFFSET_M} m(벽·문 통과) 떨어진 위치로 가정 (추정).` : '홀 끝: 코어 열을 마지막 포드 뒤 1.5 m 통로 너머에 배치 (추정).');
  } else if (placement === 'central-center') {
    const n = podList.length;
    const lo = podList[Math.max(0, Math.floor(n / 2) - 1)][1];
    const hi = podList[Math.min(n - 1, Math.floor(n / 2))][1];
    const coord = n > 1 ? ((alongY ? lo.maxY : lo.maxX) + (alongY ? hi.minY : hi.minX)) / 2 : (areaMin + areaMax) / 2;
    spineRacks.forEach((p, i) => moved.set(p.e.id, { position: line(i, coord), podId: 'pod-services', rowId: 'pod-services-a', networkRole: 'scale-out-spine' }));
    notes.push('홀 중앙: 코어 열을 가운데 두 포드 사이 통로에 배치 — 실제로는 포드 1피치(코어 열)를 추가로 확보해야 합니다 (추정).');
  } else {
    // distributed: spine racks round-robin over compute pods, at each pod's row end (they displace one compute position each)
    spineRacks.forEach((p, i) => {
      const [podId, r] = podList[i % podList.length];
      const k = Math.floor(i / podList.length);
      const pos = alongY ? { x: r.maxX + 0.3 + k * w + w / 2, y: r.minY + d / 2 } : { x: r.minX + d / 2, y: r.maxY + 0.3 + k * w + w / 2 };
      moved.set(p.e.id, { position: pos, podId, rowId: `${podId}-a`, networkRole: 'scale-out-spine' });
    });
    lost = spineRacks.length;
    notes.push(`분산: 스파인 랙 ${spineRacks.length}대를 포드 열 끝에 순환 배치 — 포드당 컴퓨트 자리 ${Math.ceil(spineRacks.length / podList.length)}개를 잃습니다 (추정, 충돌 검사 없음).`);
  }
  const equipment = project.equipment.map((e) => (moved.has(e.id) ? { ...e, ...moved.get(e.id)! } : e));
  return { project: { ...project, equipment, network: { ...project.network, scaleOut: { ...project.network.scaleOut, spinePlacement: placement } } }, lost, notes };
}

interface Geometry {
  project: Project;
  network: NetworkResult;
  ctx: Ctx;
  basis: NonNullable<PlacementCandidate['basis']>;
  lost?: number;
  notes: string[];
}

function geometryFor(input: PlacementInput, hallId: string, placement: SpinePlacement, useTrays = false): Geometry {
  const { project, ctx } = input;
  const current = normalizeSpinePlacement(project.network.scaleOut.spinePlacement);
  if (placement === current) {
    // the project's own geometry (hand edits included). Every candidate shares one cable model: without `useTrays`
    // the variants are relaid out without tray polylines (Manhattan model), so the current one is re-evaluated the same way.
    if (useTrays || !project.trays?.length) return { project, ctx, network: input.network, basis: 'current', notes: ['현재 프로젝트 배치.'] };
    const v: Project = { ...project, trays: undefined, busways: undefined };
    const vctx = buildContext(v);
    return { project: v, ctx: vctx, network: analyzeNetworkCtx(vctx), basis: 'current', notes: ['현재 프로젝트 배치 (후보 간 비교를 위해 맨해튼 케이블 모델로 재평가).'] };
  }
  const hook = relayoutHook();
  if (hook) {
    try {
      const variant = applyRelayout(project, hallId, hook(project, hallId, placement, { trays: useTrays }));
      if (variant) {
        const v: Project = { ...variant, network: { ...variant.network, scaleOut: { ...variant.network.scaleOut, spinePlacement: placement } } };
        const vctx = buildContext(v);
        return { project: v, ctx: vctx, network: analyzeNetworkCtx(vctx), basis: 'relayout', notes: ['배치 엔진(relayoutForPlacement) 재배치 결과.'] };
      }
    } catch (e) {
      /* fall through to the approximation */
      void e;
    }
  }
  const approx = approximate(project, ctx, hallId, placement);
  const vctx = buildContext(approx.project);
  return { project: approx.project, ctx: vctx, network: analyzeNetworkCtx(vctx), basis: 'approximation', lost: approx.lost, notes: approx.notes };
}

/** Metrics for one geometry (scale-out leaf→spine + spine→core links). */
function metrics(g: Geometry, placement: SpinePlacement, fill: number): PlacementCandidate {
  const plan = g.network.plans.find((p) => p.key === 'scale-out');
  const byId = new Map(cableTypes().map((c) => [c.id, c]));
  const runs: CableRun[] = plan ? g.network.analysis.cableRuns.filter((r) => r.fabric === plan.label && (r.tier === 'leaf-spine' || r.tier === 'spine-core')) : [];
  const eq = new Map(g.project.equipment.map((e) => [e.id, e]));
  const alongY = (() => {
    const pts = runs.map((r) => eq.get(r.fromId)?.position).filter((p): p is { x: number; y: number } => !!p);
    if (pts.length < 2) return true;
    // loop, not Math.max(...spread): 6,912+ runs at DU 40 × 36 racks/row overflow the argument stack
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    return maxY - minY >= maxX - minX;
  })();
  let links = 0;
  let lenSum = 0;
  let maxLen = 0;
  let fiberM = 0;
  let transceivers = 0;
  let xcvrW = 0;
  let usd = 0;
  let over = 0;
  const events: { at: number; delta: number }[] = [];
  for (const r of runs) {
    const t = byId.get(r.cableTypeId);
    if (!t) continue;
    links += r.count;
    lenSum += r.count * r.lengthM;
    maxLen = Math.max(maxLen, r.lengthM);
    if (isOptical(t)) fiberM += r.count * r.lengthM;
    if (t.transceiverUSD > 0) transceivers += 2 * r.count;
    xcvrW += 2 * r.count * wattsPerEnd(t);
    usd += r.count * cableUnitUSD(g.project, t, r.lengthM);
    if (r.lengthM > t.maxReachM) over += r.count;
    const a = eq.get(r.fromId)?.position;
    const b = eq.get(r.toId)?.position;
    if (a && b) {
      const a0 = alongY ? a.y : a.x;
      const b0 = alongY ? b.y : b.x;
      const area = r.count * cableAreaMm2(t);
      events.push({ at: Math.min(a0, b0), delta: area }, { at: Math.max(a0, b0) + 1e-6, delta: -area });
    }
  }
  events.sort((p, q) => p.at - q.at || p.delta - q.delta);
  let cur = 0;
  let peak = 0;
  for (const e of events) {
    cur += e.delta;
    peak = Math.max(peak, cur);
  }
  // rack positions lost inside the compute area: spine/core racks that sit in a compute pod
  const computePods = new Set<string>();
  for (const [pod, list] of g.ctx.byPod) if (list.some((p) => p.item.category === 'gpu-rack')) computePods.add(pod);
  const lostFromGeometry = g.project.equipment.filter((e) => (e.networkRole === 'scale-out-spine' || e.networkRole === 'scale-out-core') && e.podId && computePods.has(e.podId)).length;
  return {
    spinePlacement: placement,
    meanLinkM: links > 0 ? lenSum / links : 0,
    maxLinkM: maxLen,
    fiberKm: fiberM / 1000,
    trayPeakMm2: fill > 0 ? peak / fill : peak,
    transceivers,
    lostPositions: g.lost ?? lostFromGeometry,
    interconnectUSD: usd,
    overLimitLinks: over,
    links,
    transceiverKW: xcvrW / 1000,
    basis: g.basis,
    notes: [...g.notes, ...g.network.notes.filter((n) => n.includes('스파인'))],
  };
}

/** Evaluate one placement candidate (used by the report and the UI's "what if" buttons). */
export function evaluatePlacementCandidate(project: Project, placement: SpinePlacement, opts: PlacementOptions & { ctx?: Ctx; network?: NetworkResult } = {}): PlacementCandidate | undefined {
  const ctx = opts.ctx ?? buildContext(project);
  const network = opts.network ?? analyzeNetworkCtx(ctx);
  const hallId = primaryHall(ctx, opts.hallId);
  if (!hallId) return undefined;
  return metrics(geometryFor({ project, ctx, network }, hallId, placement, opts.trays), placement, opts.fillRatio ?? 0.5);
}

export function analyzePlacement(input: PlacementInput, opts: PlacementOptions = {}): PlacementReport | undefined {
  const { project, ctx, network } = input;
  const plan = network.plans.find((p) => p.key === 'scale-out');
  if (!plan || plan.links <= 0 || plan.tiers < 2) return undefined;
  const hallId = primaryHall(ctx, opts.hallId);
  if (!hallId) return undefined;
  const fill = opts.fillRatio ?? 0.5;
  const chosen = normalizeSpinePlacement(project.network.scaleOut.spinePlacement);
  const list = opts.candidates ?? ALL;
  const candidates = list.map((placement) => metrics(geometryFor(input, hallId, placement, opts.trays), placement, fill));
  const feasible = candidates.filter((c) => c.overLimitLinks === 0);
  const pool = feasible.length ? feasible : candidates;
  const recommended = [...pool].sort((a, b) => a.interconnectUSD - b.interconnectUSD || a.maxLinkM - b.maxLinkM)[0]?.spinePlacement;
  const notes: string[] = [];
  if (!relayoutHook()) notes.push('배치 엔진의 relayoutForPlacement가 아직 없어 현재 배치 외 후보는 스파인 랙 이동 근사(추정)로 평가했습니다.');
  else if (!opts.trays) notes.push('후보는 배치 엔진(relayoutForPlacement)으로 재배치하고 맨해튼 케이블 모델로 비교했습니다 (BOM·케이블 스케줄은 트레이 경로 기준).');
  else notes.push('후보는 배치 엔진(relayoutForPlacement)으로 트레이까지 재생성해 트레이 경로 기준으로 비교했습니다.');
  const growth = project.growth ?? 'phased';
  notes.push(growth === 'phased' ? '증설 방식 phased: 한쪽 벽에서 단계 증설 → 기본 권장 central-end (DECISIONS-v2 #1).' : '증설 방식 single-build: 일괄 시공 → 기본 권장 central-center (액랭 스위치면 distributed) (DECISIONS-v2 #1).');
  notes.push(`트레이 단면은 채움률 ${Math.round(fill * 100)} % (${fill <= 0.4 ? 'TIA-569' : 'NEC 392.22 / NVIDIA SuperPOD 설계 가이드'}) 기준, 파이버 3 mm · DAC 9.4 mm (추정).`);
  return { candidates, chosen, recommended, fillRatio: fill, notes };
}
