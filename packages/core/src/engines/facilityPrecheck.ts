// Stream C (P3) — informational facility pre-check (OCP-DESIGN-PROPOSAL §5.4, DO-6).
//
// Compares modelled hall values with the attribute thresholds of the two published facility assessment revisions (registry ids
// `facility-v1@1.5` and `facility-v2hs@1.15`, CC BY 4.0). The thresholds are stream B's data (`standards/data/facility-*.ts`, re-expressed
// and modified with attribution); this module only maps design values onto them. No assessment text is copied.
//
// Levels per attribute: optimum · acceptable · exception · not-modelled. The pre-check never raises errors, lists every attribute it
// cannot model, and its aggregate wording says "Informational pre-check, not an OCP assessment or certification". The density attribute
// (≥ 12 kW) carries the note that it says nothing about liquid-cooled racks. A separate structural finding (FC-05S) flags racks whose
// load per caster / foot is beyond the concentrated-load class.
//
// Rule ids: FC-01 cold aisle · FC-02 hot aisle / containment · FC-03 clear height · FC-04 uniform load · FC-05 concentrated load ·
// FC-06 rolling load / delivery path · FC-07 generator acceptance · FC-08 circuits / UPS / rack BBU · FC-09 density / IT ΔT ·
// FC-10 not modelled · FC-00 aggregate · FC-05S structural.
import type { Hall, Project } from '../model/types.ts';
import { CORRIDOR_DEFAULTS } from '../layout/generate.ts';
import { FACILITY_ATTRIBUTES_NOT_MODELLED, type FacilityAttribute, facilityAttributes } from '../standards/data/facility-types.ts';
import { standardCitation } from '../standards/registry.ts';
import type { FacilityPrecheckKey, StandardsProfile } from '../standards/types.ts';
import { IT_LOAD_CATEGORIES, RACK_CATEGORIES, type Ctx } from './context.ts';
import { RDHX_DOOR_META } from './coolingTopology.ts';
import { fmt, hallProfile, makeResult, type StandardsCheckResult } from './standardsBasis.ts';

export type FacilityLevel = 'optimum' | 'acceptable' | 'exception' | 'not-modelled';
export type FacilityBasisId = Exclude<FacilityPrecheckKey, 'off'>;

export interface FacilityPrecheckRow {
  ruleId: string;
  /** attribute reference in the assessment revision, e.g. '2.2-F' ('—' for areas outside the model) */
  ref: string;
  key: string;
  attributeEn: string;
  attributeKo: string;
  designValue?: number | string;
  unit?: string;
  level: FacilityLevel;
  /** threshold text rendered from the data, e.g. "optimum ≥ 1500 mm · acceptable ≥ 1200 mm" */
  thresholdEn?: string;
  noteEn?: string;
  noteKo?: string;
}

export interface FacilityPrecheckReport {
  hallId: string;
  basisId: FacilityBasisId;
  /** "<title> <version>" from the registry */
  citation: string;
  rows: FacilityPrecheckRow[];
  counts: Record<FacilityLevel, number>;
  summaryEn: string;
  summaryKo: string;
}

/** Load points per rack used for the per-caster / per-foot load (planner estimate; ORW-class racks stand on feet or a pallet base). */
export const RACK_LOAD_POINTS = 4;

const ATTRIBUTE_LABEL: Readonly<Record<string, { ruleId: string; en: string; ko: string }>> = {
  'cold-aisle-width': { ruleId: 'FC-01', en: 'Minimum cold aisle width', ko: '최소 냉복도 폭' },
  'cage-cold-aisle-width': { ruleId: 'FC-01', en: 'Minimum free cold aisle width inside a cage', ko: '케이지 내부 최소 냉복도 폭' },
  'hot-aisle-width': { ruleId: 'FC-02', en: 'Minimum hot aisle width', ko: '최소 열복도 폭' },
  containment: { ruleId: 'FC-02', en: 'Containment', ko: '컨테인먼트' },
  'clear-height': { ruleId: 'FC-03', en: 'Finished floor to ceiling (clear)', ko: '마감 바닥–천장 순높이' },
  'white-space-uniform-load': { ruleId: 'FC-04', en: 'White space uniform load', ko: '전산실 등분포 하중' },
  'staging-uniform-load': { ruleId: 'FC-04', en: 'Staging area uniform load', ko: '스테이징 구역 등분포 하중' },
  'white-space-concentrated-load': { ruleId: 'FC-05', en: 'White space concentrated load', ko: '전산실 집중 하중' },
  'staging-concentrated-load': { ruleId: 'FC-05', en: 'Staging area concentrated load', ko: '스테이징 구역 집중 하중' },
  'white-space-rolling-load': { ruleId: 'FC-06', en: 'White space rolling load', ko: '전산실 이동 하중' },
  'corridor-rolling-load': { ruleId: 'FC-06', en: 'Corridor rolling load', ko: '복도 이동 하중' },
  'delivery-path-white-space': { ruleId: 'FC-06', en: 'Delivery path, goods-in → white space', ko: '반입 경로 (입고실 → 전산실)' },
  'delivery-path-dock': { ruleId: 'FC-06', en: 'Delivery path, dock → goods-in', ko: '반입 경로 (하역장 → 입고실)' },
  'generator-load-acceptance': { ruleId: 'FC-07', en: 'Generator load acceptance', ko: '발전기 부하 수용 시간' },
  'circuits-to-rack': { ruleId: 'FC-08', en: 'Circuits to rack', ko: '랙 급전 회로' },
  'upstream-ups': { ruleId: 'FC-08', en: 'Upstream UPS feed', ko: '상위 UPS 급전' },
  'rack-bbu': { ruleId: 'FC-08', en: 'Rack-based batteries (BBU)', ko: '랙 배터리(BBU)' },
  'rack-density': { ruleId: 'FC-09', en: 'Maximum rack density supported', ko: '지원 최대 랙 밀도' },
  'it-temperature-rise': { ruleId: 'FC-09', en: 'IT temperature rise', ko: 'IT 온도 상승' },
};

const NOT_MODELLED_LABEL: Readonly<Record<(typeof FACILITY_ATTRIBUTES_NOT_MODELLED)[number], { en: string; ko: string }>> = {
  security: { en: 'Security', ko: '보안' },
  'service-levels': { en: 'Service levels', ko: '서비스 수준' },
  'telecom-and-meet-me-room': { en: 'Telecom entrances and meet-me rooms', ko: '통신 인입 · MMR' },
  operations: { en: 'Operations', ko: '운영' },
  'air-quality': { en: 'Air quality and filtration', ko: '공기질 · 필터' },
  'receptacle-types': { en: 'Receptacle types', ko: '리셉터클 형식' },
  certifications: { en: 'Certifications', ko: '인증' },
};

const RHO_CP_AIR = 1.18 * 1.006;

type Dims = { h: number; w: number; d?: number };
const isDims = (v: unknown): v is Dims => typeof v === 'object' && v !== null && !Array.isArray(v) && 'h' in v && 'w' in v;
const dimsOk = (v: Dims, t: Dims) => v.h >= t.h - 1e-9 && v.w >= t.w - 1e-9 && (t.d === undefined || v.d === undefined || v.d >= t.d - 1e-9);
const dimsText = (t: Dims) => `${fmt(t.h, 2)} × ${fmt(t.w, 2)}${t.d !== undefined ? ` × ${fmt(t.d, 2)}` : ''} m`;
/** Attributes whose optimum and acceptable thresholds are equal and differ by floor construction (slab on grade vs access floor). */
const bySlab = (a: FacilityAttribute) => typeof a.optimum === 'number' && a.acceptable === a.optimum && /slab/i.test(a.note ?? '');

/** Level of a design value against one attribute (pure; exported for tests). */
export function facilityLevel(a: FacilityAttribute, v: number | string | Dims | undefined, onAccessFloor = false): { level: FacilityLevel; withNotes?: boolean } {
  if (v === undefined) return { level: 'not-modelled' };
  switch (a.compare) {
    case 'min':
    case 'max': {
      if (typeof v !== 'number') return { level: 'not-modelled' };
      const ok = (t: number | undefined) => t !== undefined && (a.compare === 'min' ? v >= t - 1e-9 : v <= t + 1e-9);
      if (ok(a.optimum as number)) return { level: bySlab(a) && onAccessFloor ? 'acceptable' : 'optimum' };
      if (ok(a.acceptable as number | undefined)) return { level: 'acceptable' };
      if (ok(a.acceptableWithNotes)) return { level: 'acceptable', withNotes: true };
      return { level: 'exception' };
    }
    case 'min-dims': {
      if (!isDims(v)) return { level: 'not-modelled' };
      if (isDims(a.optimum) && dimsOk(v, a.optimum)) return { level: 'optimum' };
      if (Array.isArray(a.acceptable) && (a.acceptable as unknown[]).some((t) => isDims(t) && dimsOk(v, t))) return { level: 'acceptable' };
      return { level: 'exception' };
    }
    case 'enum': {
      if (typeof v !== 'string') return { level: 'not-modelled' };
      if (Array.isArray(a.optimum) && (a.optimum as string[]).includes(v)) return { level: 'optimum' };
      if (Array.isArray(a.acceptable) && (a.acceptable as unknown[]).includes(v)) return { level: 'acceptable' };
      return { level: 'exception' };
    }
  }
}

function thresholdText(a: FacilityAttribute): string {
  const op = a.compare === 'max' ? '≤' : '≥';
  const unit = a.unit === 'enum' ? '' : ` ${a.unit}`;
  const one = (t: unknown): string => (isDims(t) ? dimsText(t) : Array.isArray(t) ? (t as unknown[]).map((x) => (isDims(x) ? dimsText(x) : String(x))).join(' / ') : `${op} ${fmt(t as number, 2)}${unit}`);
  const parts = [`optimum ${a.compare === 'enum' ? '' : ''}${one(a.optimum)}`.replace('optimum  ', 'optimum ')];
  if (a.acceptable !== undefined && a.acceptable !== a.optimum) parts.push(`acceptable ${one(a.acceptable)}`);
  if (a.acceptableWithNotes !== undefined) parts.push(`with notes ${op} ${fmt(a.acceptableWithNotes, 2)}${unit}`);
  return parts.join(' · ');
}

/** Design values the model can supply per attribute key (undefined = not modelled). */
function designValues(project: Project, hall: Hall, basisId: FacilityBasisId, profile: StandardsProfile | undefined, placed: Ctx['placed']): Record<string, number | string | Dims | undefined> {
  const f = hall.facility ?? {};
  const corridors = hall.layoutPolicy ? (hall.layoutPolicy.corridors ?? CORRIDOR_DEFAULTS) : undefined;
  const busways = (project.busways ?? []).filter((b) => b.hallId === hall.id);
  const racks = placed.filter((p) => p.e.hallId === hall.id && IT_LOAD_CATEGORIES.has(p.item.category));
  const ups = project.power.upsRedundancy;
  const twoN = ups === '2N' || ups === '2N+1';
  const cont = project.containments.filter((c) => c.hallId === hall.id);
  const doors = placed.some((p) => p.e.hallId === hall.id && Number(p.e.meta?.[RDHX_DOOR_META] ?? 0) > 0);
  let airKW = 0;
  let airflow = 0;
  for (const p of racks) {
    const flow = p.item.cooling?.airflowM3s ?? 0;
    if (flow <= 0) continue;
    airKW += (p.item.power?.nameplateKW ?? 0) * (1 - (p.item.cooling?.liquidFraction ?? 0));
    airflow += flow;
  }
  return {
    'cold-aisle-width': corridors ? Math.round(corridors.coldAisleM * 1000) : undefined,
    'hot-aisle-width': corridors ? Math.round(corridors.hotAisleM * 1000) : undefined,
    containment: f.containment ?? (cont.some((c) => c.kind === 'hot-aisle') ? 'hot-aisle' : cont.some((c) => c.kind === 'cold-aisle') ? 'cold-aisle' : doors ? 'rdhx' : undefined),
    'clear-height': hall.clearHeight > 0 ? hall.clearHeight : undefined,
    'white-space-uniform-load': hall.floorLoadingKgPerM2 > 0 ? hall.floorLoadingKgPerM2 : undefined,
    'white-space-concentrated-load': f.concentratedLoadKg,
    'white-space-rolling-load': f.rollingLoadKg,
    'delivery-path-white-space': f.deliveryPath,
    'generator-load-acceptance': f.generatorAcceptanceS,
    'circuits-to-rack': f.circuits ?? (busways.length ? (new Set(busways.map((b) => b.path)).size >= 2 ? '2N' : '1N') : undefined),
    'upstream-ups': f.upsFeed ?? (twoN && basisId === 'facility-v2hs@1.15' ? 'n-plus-n-ups' : ups ? 'ups-only' : undefined),
    'rack-bbu': f.rackBbuAllowed !== undefined ? (f.rackBbuAllowed ? 'allowed' : 'not-allowed') : profile?.bbu === 'in-rack' ? 'allowed' : undefined,
    'rack-density': racks.length ? racks.reduce((m, p) => Math.max(m, p.item.power?.nameplateKW ?? 0), 0) : undefined,
    'it-temperature-rise': airflow > 0 ? Math.round((airKW / (RHO_CP_AIR * airflow)) * 10) / 10 : undefined,
  };
}

/** Facility pre-check of one hall against one assessment revision. Pure. */
export function facilityPrecheck(project: Project, hall: Hall, basisId: FacilityBasisId, placed: Ctx['placed'] = []): FacilityPrecheckReport {
  const profile = hallProfile(project, hall);
  const values = designValues(project, hall, basisId, profile, placed);
  const rows: FacilityPrecheckRow[] = [];
  const derivedKeys = new Set(['circuits-to-rack', 'upstream-ups', 'rack-bbu', 'containment']);
  for (const a of facilityAttributes(basisId)) {
    const label = ATTRIBUTE_LABEL[a.key] ?? { ruleId: 'FC-10', en: a.key, ko: a.key };
    const v = values[a.key];
    const { level, withNotes } = facilityLevel(a, v, hall.raisedFloorHeight > 0);
    const derived = derivedKeys.has(a.key) && v !== undefined && hall.facility?.[a.key === 'circuits-to-rack' ? 'circuits' : a.key === 'upstream-ups' ? 'upsFeed' : a.key === 'rack-bbu' ? 'rackBbuAllowed' : 'containment'] === undefined;
    const notesEn = [a.note, withNotes ? 'acceptable with notes' : undefined, derived ? 'derived from the design (not a facility input)' : undefined].filter(Boolean).join('; ');
    const notesKo = [a.key === 'rack-density' ? '이 항목은 12 kW에서 끝납니다. 액체냉각 랙에 대한 적합성 지표가 아닙니다' : undefined, withNotes ? '비고 조건부 허용' : undefined, derived ? '설계에서 산정(시설 입력 아님)' : undefined].filter(Boolean).join('; ');
    rows.push({
      ruleId: label.ruleId, ref: a.ref, key: a.key, attributeEn: label.en, attributeKo: label.ko,
      ...(v !== undefined ? { designValue: isDims(v) ? dimsText(v) : v } : {}),
      ...(a.unit !== 'enum' ? { unit: a.unit } : {}),
      level, thresholdEn: thresholdText(a),
      ...(notesEn ? { noteEn: notesEn } : {}), ...(notesKo ? { noteKo: notesKo } : {}),
    });
  }
  for (const k of FACILITY_ATTRIBUTES_NOT_MODELLED) rows.push({ ruleId: 'FC-10', ref: '—', key: k, attributeEn: NOT_MODELLED_LABEL[k].en, attributeKo: NOT_MODELLED_LABEL[k].ko, level: 'not-modelled' });

  const counts: Record<FacilityLevel, number> = { optimum: 0, acceptable: 0, exception: 0, 'not-modelled': 0 };
  for (const r of rows) counts[r.level]++;
  const citation = standardCitation(basisId);
  const summaryEn = `Modelled ${citation} requirement attributes: ${counts.optimum} optimum, ${counts.acceptable} acceptable, ${counts.exception} exception, ${counts['not-modelled']} not modelled. Informational pre-check, not an OCP assessment or certification.`;
  const summaryKo = `${citation} 요구 항목 모델 결과: 최적 ${counts.optimum}, 허용 ${counts.acceptable}, 예외 ${counts.exception}, 모델 없음 ${counts['not-modelled']}. 정보용 사전점검이며 OCP 평가나 인증이 아닙니다.`;
  return { hallId: hall.id, basisId, citation, rows, counts, summaryEn, summaryKo };
}

/** The pre-check basis in force for a hall (undefined when off or no profile). */
export function facilityPrecheckBasis(profile: StandardsProfile | undefined): FacilityBasisId | undefined {
  const k = profile?.facilityPrecheck;
  return k === 'facility-v1@1.5' || k === 'facility-v2hs@1.15' ? k : undefined;
}

/** Facility pre-check of every hall whose profile enables it: one aggregate info per hall and the structural point-load finding. */
export function evaluateFacilityChecks(ctx: Ctx): { reports: FacilityPrecheckReport[]; results: StandardsCheckResult[] } {
  const { project } = ctx;
  const reports: FacilityPrecheckReport[] = [];
  const results: StandardsCheckResult[] = [];
  for (const hall of project.halls) {
    const profile = hallProfile(project, hall);
    const basisId = facilityPrecheckBasis(profile);
    if (!basisId) continue;
    const rep = facilityPrecheck(project, hall, basisId, ctx.placed);
    reports.push(rep);
    const exceptions = rep.rows.filter((r) => r.level === 'exception');
    results.push(
      makeResult(profile, {
        id: `std-fc-summary-${hall.id}`, ruleId: 'FC-00', family: 'facility', status: 'finding', naturalSeverity: 'info', domain: 'space', hallId: hall.id, refs: [hall.id],
        basis: 'standard', standardId: basisId, verification: 'verified',
        ko: `${hall.name}: ${rep.summaryKo}${exceptions.length ? ` 예외 항목: ${exceptions.map((r) => `${r.ref} ${r.attributeKo}`).join(', ')}.` : ''}`,
        en: `${hall.name}: ${rep.summaryEn}${exceptions.length ? ` Exceptions: ${exceptions.map((r) => `${r.ref} ${r.attributeEn}`).join(', ')}.` : ''}`,
      }),
    );
    // FC-05S structural: heaviest rack per load point vs the concentrated-load class (or the hall's declared rating)
    const cls = facilityAttributes(basisId).find((a) => a.key === 'white-space-concentrated-load');
    const classKg = typeof cls?.optimum === 'number' ? cls.optimum : undefined;
    const limit = hall.facility?.concentratedLoadKg ?? classKg;
    let worst: { kg: number; id: string; tag: string } | undefined;
    for (const p of ctx.placed) {
      if (p.e.hallId !== hall.id || !RACK_CATEGORIES.has(p.item.category)) continue;
      const perPoint = (p.item.weightKg ?? 0) / RACK_LOAD_POINTS;
      if (!worst || perPoint > worst.kg) worst = { kg: perPoint, id: p.e.id, tag: p.e.tag };
    }
    if (limit !== undefined && worst && worst.kg > limit + 1e-9) {
      const declared = hall.facility?.concentratedLoadKg !== undefined;
      results.push(
        makeResult(profile, {
          id: `std-fc05s-${hall.id}`, ruleId: 'FC-05S', family: 'facility', status: 'finding', naturalSeverity: 'warning', domain: 'space', hallId: hall.id, refs: [hall.id, worst.id],
          designValue: Math.round(worst.kg), limit, unit: 'kg', basis: declared ? 'user' : 'estimate', ...(declared ? {} : { standardId: basisId }), verification: 'estimate',
          ko: `${hall.name}: 가장 무거운 랙 ${worst.tag}의 지지점(${RACK_LOAD_POINTS}개)당 하중 ${fmt(worst.kg, 0)} kg이 집중 하중 ${fmt(limit, 0)} kg${declared ? '' : ' 등급'}을 넘습니다. 별도 구조 검토가 필요합니다.`,
          en: `${hall.name}: the heaviest rack ${worst.tag} puts ${fmt(worst.kg, 0)} kg on each of its ${RACK_LOAD_POINTS} load points, above the ${fmt(limit, 0)} kg concentrated-load ${declared ? 'rating' : 'class'}. A separate structural review is needed.`,
          suggestion: '구조 엔지니어와 바닥 · 슬래브 하중을 확인하고, 필요하면 하중 분산 베이스를 적용하세요.',
          suggestionEn: 'Confirm the floor / slab rating with a structural engineer and use load-spreading bases where needed.',
        }),
      );
    }
  }
  return { reports, results };
}
