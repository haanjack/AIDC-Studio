import { SHARED_WALL_SEPARATION_M } from './powerPaths.ts';
import { instanceRect, rectContains, rectsOverlap } from '../model/geometry.ts';
import { findCatalogItem } from '../catalog/catalog.ts';
import type {
  CostAnalysis,
  Issue,
  NetworkAnalysis,
  PowerAnalysis,
  ScheduleAnalysis,
  SpaceAnalysis,
  WorkloadAnalysis,
} from '../model/types.ts';
import type { CoolingResult } from './cooling.ts';
import { type Ctx, parseISO } from './context.ts';
import { clearanceZones, FootprintIndex, findClearanceIntrusions, floorItems, floorLoadKgPerM2 } from './space.ts';
import { normalizeTemplate } from '../layout/generate.ts';
import { liquidHeatKW, redundantCount } from '../layout/estimates.ts'; // polish: gallery group redundancy
import { polylineInside, rowGroupsFromEquipment } from '../layout/rows.ts';
import { findLayoutTemplate } from '../layout/templates/index.ts';
import { coolingLoopIssues, coolingLoopsFor } from '../layout/coolingPlacement.ts'; // T1: gallery CDU loop budget
import { shareIssues } from '../workload/shares.ts'; // T6: workload-share-over
import { standardsCheckIssues } from './standardsChecks.ts'; // stream C (P3): RK / PW / CL / NW / FC parameter checks

interface Inputs {
  space: SpaceAnalysis[];
  network: NetworkAnalysis;
  cooling: CoolingResult;
  power: PowerAnalysis;
  schedule: ScheduleAnalysis;
  cost: CostAnalysis;
  workloads: WorkloadAnalysis[];
}

const kw = (v: number) => `${Math.round(v).toLocaleString('en-US')} kW`;

export function validateProjectCtx(ctx: Ctx, r: Inputs): Issue[] {
  const { project } = ctx;
  const issues: Issue[] = [];
  const add = (i: Issue) => {
    if (!issues.some((x) => x.id === i.id)) issues.push(i);
  };
  const tagOf = new Map(project.equipment.map((e) => [e.id, e.tag]));

  // ── catalog / hall references ──
  for (const e of ctx.unknown) add({ id: `space-unknown-${e.id}`, severity: 'error', domain: 'space', message: `${e.tag}: 카탈로그에 없는 장비(${e.catalogId})입니다.`, refs: [e.id], suggestion: '카탈로그 ID를 수정하거나 장비를 삭제하세요.', messageEn: `${e.tag}: catalog item not found (${e.catalogId}).`, suggestionEn: 'Fix the catalog id or delete the item.' });
  for (const p of ctx.placed) if (!p.hall) add({ id: `space-nohall-${p.e.id}`, severity: 'error', domain: 'space', message: `${p.e.tag}: 존재하지 않는 홀(${p.e.hallId})에 배치되었습니다.`, refs: [p.e.id], messageEn: `${p.e.tag}: placed in a hall that does not exist (${p.e.hallId}).` });

  // ── space ──
  for (const hall of project.halls) {
    const items = floorItems(ctx.byHall.get(hall.id) ?? []);
    const index = new FootprintIndex(items);
    const hallRect = { x: 0, y: 0, w: hall.width, d: hall.depth };
    items.forEach((p, i) => {
      const r = index.rects[i];
      if (!rectContains(hallRect, r)) add({ id: `space-outside-${p.e.id}`, severity: 'error', domain: 'space', message: `${p.e.tag}: 홀 경계(${hall.name}) 밖으로 벗어났습니다.`, refs: [p.e.id], suggestion: '장비 위치를 홀 내부로 이동하세요.', messageEn: `${p.e.tag}: outside the hall boundary (${hall.name}).`, suggestionEn: 'Move the item inside the hall.' });
      for (const j of index.query(r)) {
        if (j <= i) continue;
        const o = items[j];
        add({ id: `space-overlap-${p.e.id}-${o.e.id}`, severity: 'error', domain: 'space', message: `${p.e.tag}와 ${o.e.tag}의 설치 면적이 겹칩니다.`, refs: [p.e.id, o.e.id], suggestion: '둘 중 하나를 이동하거나 레이아웃을 재생성하세요.', messageEn: `Footprints of ${p.e.tag} and ${o.e.tag} overlap.`, suggestionEn: 'Move one of them or regenerate the layout.' });
      }
      for (const ko of hall.keepouts) {
        if (rectsOverlap(r, ko.rect)) add({ id: `space-keepout-${p.e.id}-${ko.id}`, severity: 'error', domain: 'space', message: `${p.e.tag}: 금지 구역(${ko.label ?? ko.kind})을 침범합니다.`, refs: [p.e.id], suggestion: '기둥/출입구/피난 동선에서 장비를 이격하세요.', messageEn: `${p.e.tag}: intrudes into a keep-out (${ko.label ?? ko.kind}).`, suggestionEn: 'Keep equipment clear of columns, doors and egress paths.' });
        else if (ko.kind !== 'column' && clearanceZones(p).some((z) => z.zone !== 'side' && rectsOverlap(z.rect, ko.rect))) add({ id: `space-keepout-clr-${p.e.id}-${ko.id}`, severity: 'warning', domain: 'space', message: `${p.e.tag}: 서비스 공간이 ${ko.label ?? ko.kind}와 겹칩니다.`, refs: [p.e.id], messageEn: `${p.e.tag}: service clearance overlaps ${ko.label ?? ko.kind}.` });
      }
      const load = floorLoadKgPerM2(p);
      if (load > hall.floorLoadingKgPerM2) add({ id: `space-floorload-${p.e.id}`, severity: 'error', domain: 'space', message: `${p.e.tag}: 바닥 하중 ${Math.round(load)} kg/m²가 허용 ${hall.floorLoadingKgPerM2} kg/m²를 초과합니다.`, refs: [p.e.id], suggestion: '하중 분산 베이스를 적용하거나 구조 보강을 검토하세요.', messageEn: `${p.e.tag}: floor load ${Math.round(load)} kg/m² exceeds the allowable ${hall.floorLoadingKgPerM2} kg/m².`, suggestionEn: 'Use a load-spreading base or review structural reinforcement.' });
    });
    const intrusions = findClearanceIntrusions(items, index);
    for (const v of intrusions) add({ id: `space-clearance-${v.id}-${v.otherId}`, severity: 'warning', domain: 'space', message: `${tagOf.get(v.id)}의 ${v.zone === 'front' ? '전면' : v.zone === 'rear' ? '후면' : '측면'} 서비스 공간을 ${tagOf.get(v.otherId)}가 침범합니다.`, refs: [v.id, v.otherId], suggestion: '통로 폭을 늘리거나 장비를 이동하세요.', messageEn: `${tagOf.get(v.otherId)} intrudes into the ${v.zone} service clearance of ${tagOf.get(v.id)}.`, suggestionEn: 'Widen the aisle or move the equipment.' });
  }

  // ── power ──
  const pw = r.power;
  // autosize v2 2차 (DECISIONS-v2-2 §F): a generated hall (layoutPolicy) reports its IT / liquid / air budget shortfalls ONCE with the exact
  // figures (`layout-budget-limited-<hall>`, below the cooling block); manual halls keep the separate budget errors
  const budgetShort = new Map<string, { it?: [number, number]; liquid?: [number, number]; air?: [number, number] }>();
  const short = (hallId: string, key: 'it' | 'liquid' | 'air', need: number, budget: number) => budgetShort.set(hallId, { ...(budgetShort.get(hallId) ?? {}), [key]: [need, budget] });
  /** IT-headroom warnings, emitted after the budget block: a budget-limited hall reports its budgets once (that remedy also restores the headroom) */
  const deferHi: Issue[] = [];
  for (const h of pw.perHall) {
    const hall = project.halls.find((x) => x.id === h.hallId)!;
    if (h.itKW > h.budgetKW && hall.layoutPolicy && project.purpose !== 'reference-cfd') short(hall.id, 'it', h.itKW, h.budgetKW);
    else if (h.itKW > h.budgetKW) add({ id: `power-hall-budget-${h.hallId}`, severity: 'error', domain: 'power', message: `${hall.name}: IT 부하 ${kw(h.itKW)}가 공급 가능 전력 ${kw(h.budgetKW)}를 초과합니다.`, refs: [h.hallId], suggestion: '랙 수를 줄이거나 홀 수전 용량 배정을 늘리세요.', messageEn: `${hall.name}: IT load ${kw(h.itKW)} exceeds the available power ${kw(h.budgetKW)}.`, suggestionEn: 'Reduce the rack count or raise the hall power allocation.' });
    else if (h.budgetKW > 0 && h.utilization > 0.9) deferHi.push({ id: `power-hall-budget-hi-${h.hallId}`, severity: 'warning', domain: 'power', message: `${hall.name}: IT 부하가 공급 가능 전력의 ${(h.utilization * 100).toFixed(0)}%로 여유가 부족합니다.`, refs: [h.hallId], messageEn: `${hall.name}: IT load is ${(h.utilization * 100).toFixed(0)} % of the available power — little headroom.` });
  }
  // qa-autosize v2 2차: the utility issue is held back — with a budget-limited generated hall the shortfall joins that ONE budget issue
  const utilityIssues: Issue[] = [];
  const addUtility = (i: Issue) => utilityIssues.push(i);
  if (pw.utilityRequiredMVA > (pw.utilityTotalMVA ?? pw.utilityAvailableMVA)) addUtility({ id: 'power-utility-total', severity: 'error', domain: 'power', message: `필요 수전 ${pw.utilityRequiredMVA.toFixed(1)} MVA가 전체 수전 용량 ${(pw.utilityTotalMVA ?? 0).toFixed(1)} MVA를 초과합니다.`, suggestion: '추가 수전 인입 또는 단계별 증설 계획을 수립하세요.', messageEn: `Required utility feed ${pw.utilityRequiredMVA.toFixed(1)} MVA exceeds the total utility capacity ${(pw.utilityTotalMVA ?? 0).toFixed(1)} MVA.`, suggestionEn: 'Plan an additional utility feed or a phased build-out.' });
  else if (pw.utilityRequiredMVA > pw.utilityAvailableMVA) addUtility({ id: 'power-utility-firm', severity: 'error', domain: 'power', message: `필요 수전 ${pw.utilityRequiredMVA.toFixed(1)} MVA가 N-1 확정 용량 ${pw.utilityAvailableMVA.toFixed(1)} MVA를 초과합니다 (한 회선 정지 시 공급 불가).`, suggestion: '각 회선 용량을 필요 수전 이상으로 확보하세요.', messageEn: `Required utility feed ${pw.utilityRequiredMVA.toFixed(1)} MVA exceeds the N-1 firm capacity ${pw.utilityAvailableMVA.toFixed(1)} MVA (cannot be supplied with one feeder out).`, suggestionEn: 'Size each feeder at or above the required feed.' });
  const substations = new Set(project.site.utility.map((f) => f.substation));
  if (project.site.utility.length > 0 && substations.size < 2) add({ id: 'power-utility-single', severity: 'warning', domain: 'power', message: `모든 수전 회선이 단일 변전소(${[...substations][0]})에 의존합니다.`, suggestion: '독립 변전소 이중 인입을 검토하세요.', messageEn: `All utility feeders depend on a single substation (${[...substations][0]}).`, suggestionEn: 'Consider dual feeds from independent substations.' });
  if (project.site.utility.length === 0) add({ id: 'power-utility-none', severity: 'error', domain: 'power', message: '수전 회선이 정의되지 않았습니다.', messageEn: 'No utility feeder is defined.' });
  // polish v2 2차: the circuit count follows the power plane's profile continuous limit (IEC 1.0 / NEC 0.8), not deratingFactor alone
  const rppLimit = pw.rpps.limitFactor ?? project.power.deratingFactor;
  if (pw.rpps.maxLoading > rppLimit + 1e-6) add({ id: 'power-rpp-overload', severity: 'error', domain: 'power', message: `버스웨이/RPP 최대 부하율 ${(pw.rpps.maxLoading * 100).toFixed(0)}%가 연속 정격 ${(rppLimit * 100).toFixed(0)}%를 초과합니다.`, suggestion: '분기 회로를 추가하세요.', messageEn: `Busway / RPP peak loading ${(pw.rpps.maxLoading * 100).toFixed(0)} % exceeds the continuous rating ${(rppLimit * 100).toFixed(0)} %.`, suggestionEn: 'Add branch circuits.' });
  if (pw.upsSizing && !pw.upsSizing.survives) add({ id: 'power-ups-block-headroom', severity: 'warning', domain: 'power', message: `UPS 블록 ${pw.upsSizing.activeBlocks} × ${pw.upsSizing.blockModules}모듈(+ catcher)이 단일 고장 "${pw.upsSizing.worstContingency}"에서 ${pw.upsSizing.worstPct.toFixed(1)}%까지 부하됩니다${pw.upsSizing.override ? ' (사용자 지정 구성)' : ''}.`, suggestion: '블록당 모듈 또는 블록 수를 늘리세요 (자동 구성은 N-1을 만족하도록 산정).', messageEn: `UPS blocks ${pw.upsSizing.activeBlocks} × ${pw.upsSizing.blockModules} modules (+ catcher) reach ${pw.upsSizing.worstPct.toFixed(1)} % under the single contingency "${pw.upsSizing.worstContingency}"${pw.upsSizing.override ? ' (user arrangement)' : ''}.`, suggestionEn: 'Add modules per block or blocks (the automatic arrangement is sized to survive N-1).' });
  for (const room of pw.rooms ?? []) if (room.conflict) add({ id: `power-elec-room-wall-${room.id}`, severity: 'warning', domain: 'power', refs: [room.hallId], message: `전기실 ${room.side} (${room.wall ?? '?'} 벽)이 ${room.conflict === 'crah' ? 'CRAH 벽' : room.conflict === 'cdu-gallery' ? 'CDU 갤러리 벽' : room.conflict === 'room' ? '다른 홀의 전기실' : '다른 홀'}과 겹치며 비어 있는 벽이 없습니다.`, suggestion: room.conflict === 'room' || room.conflict === 'hall' ? '홀 사이 간격을 두 전기실 깊이 + 0.8 m 이상으로 넓히거나 한 홀의 냉각 벽을 바꾸세요.' : '냉각 벽 배치를 바꾸거나 전기실을 별도 위치로 계획하세요.', messageEn: `Electrical room ${room.side} (${room.wall ?? '?'} wall) conflicts with ${room.conflict === 'crah' ? 'the CRAH wall' : room.conflict === 'cdu-gallery' ? 'the CDU gallery wall' : room.conflict === 'room' ? "another hall's electrical room" : 'another hall'} and no free wall is available.`, suggestionEn: room.conflict === 'room' || room.conflict === 'hall' ? 'Widen the gap between the halls to at least both room depths + 0.8 m, or move the cooling wall of one hall.' : 'Move the cooling walls or plan the electrical room elsewhere.' });
  // qa-autosize v2 2차 (§3): rooms A and B side by side on one wall parallel to the rows (the row-end walls carry the cooling units)
  for (const hall of project.halls) {
    const ra = (pw.rooms ?? []).find((r) => r.hallId === hall.id && r.side === 'A' && !r.conflict);
    const rb = (pw.rooms ?? []).find((r) => r.hallId === hall.id && r.side === 'B' && !r.conflict);
    if (ra?.wall && ra.wall === rb?.wall) add({ id: `power-elec-room-shared-wall-${hall.id}`, severity: project.site.targetTier === 'IV' ? 'warning' : 'info', domain: 'power', refs: [hall.id], message: `${project.site.targetTier === 'IV' ? '목표 등급 Tier IV: 전기실 A·B는 홀 반대편에 있어야 합니다. ' : ''}${hall.name}: 행 끝 벽을 냉각 유닛이 사용해 전기실 A·B를 ${ra.wall} 벽에 나란히 배치했습니다 (A는 열 시작 쪽 절반, B는 열 끝 쪽 절반, 간격 ${SHARED_WALL_SEPARATION_M} m). 두 실을 내화 구획으로 분리하세요. A·B 피더는 서로 다른 슬리브를 지납니다.`, suggestion: 'A·B 전기실을 홀 반대편에 두어야 하면(예: Tier IV 요구) 홀을 넓혀 CRAH를 행 끝 벽에만 두세요.', messageEn: `${project.site.targetTier === 'IV' ? 'Target tier IV: rooms A and B must stand on opposite hall sides. ' : ''}${hall.name}: the row-end walls carry the cooling units, so electrical rooms A and B stand side by side on the ${ra.wall} wall (A on the row-start half, B on the row-end half, ${SHARED_WALL_SEPARATION_M} m apart). Separate the two rooms as fire compartments; the A and B feeders use separate sleeves.`, suggestionEn: 'If rooms A and B must be on opposite hall sides (e.g. a Tier IV requirement), enlarge the hall so the CRAHs stay on the row-end walls.' });
  }
  // finish v2 2차 (QA M8): halls must not overlap on the site (growing a hall used to run it into its neighbour without an issue)
  for (let i = 0; i < project.halls.length; i++) {
    for (let j = i + 1; j < project.halls.length; j++) {
      const a = project.halls[i];
      const b = project.halls[j];
      const ov = Math.min(a.origin.x + a.width, b.origin.x + b.width) - Math.max(a.origin.x, b.origin.x);
      const od = Math.min(a.origin.y + a.depth, b.origin.y + b.depth) - Math.max(a.origin.y, b.origin.y);
      if (ov <= 0.01 || od <= 0.01) continue;
      const shiftX = Math.round((a.origin.x + a.width + 12 - b.origin.x) * 10) / 10;
      add({ id: `site-hall-overlap-${a.id}-${b.id}`, severity: 'error', domain: 'layout', refs: [a.id, b.id], message: `${a.name}과 ${b.name}이 부지에서 ${ov.toFixed(1)} × ${od.toFixed(1)} m 겹칩니다.`, suggestion: `${b.name}을 동쪽으로 ${shiftX} m 옮기거나(사이트 패널의 홀 원점) ${a.name}의 크기를 줄이세요.`, messageEn: `${a.name} and ${b.name} overlap on the site by ${ov.toFixed(1)} × ${od.toFixed(1)} m.`, suggestionEn: `Move ${b.name} ${shiftX} m east (hall origin in the Site panel) or shrink ${a.name}.` });
    }
  }
  if (pw.ups.installedKVA < pw.ups.requiredKVA) add({ id: 'power-ups-under', severity: 'error', domain: 'power', message: 'UPS 설치 용량이 필요 용량보다 작습니다.', messageEn: 'Installed UPS capacity is below the required capacity.' });

  // ── cooling ──
  const ca = r.cooling.analysis;
  for (const h of ca.perHall ?? []) {
    const hall = project.halls.find((x) => x.id === h.hallId)!;
    const generated = !!hall.layoutPolicy && project.purpose !== 'reference-cfd';
    if (generated && h.liquidKW > hall.liquidCoolingBudgetKW) short(hall.id, 'liquid', h.liquidKW, hall.liquidCoolingBudgetKW);
    if (generated && h.airKW > hall.airCoolingBudgetKW) short(hall.id, 'air', h.airKW, hall.airCoolingBudgetKW);
    if (!generated && h.liquidKW > hall.liquidCoolingBudgetKW) add({ id: `cooling-liquid-budget-${h.hallId}`, severity: 'error', domain: 'cooling', message: `${hall.name}: 액체 냉각 부하 ${kw(h.liquidKW)}가 설비 용량 ${kw(hall.liquidCoolingBudgetKW)}를 초과합니다.`, refs: [h.hallId], messageEn: `${hall.name}: liquid cooling load ${kw(h.liquidKW)} exceeds the plant capacity ${kw(hall.liquidCoolingBudgetKW)}.` });
    if (!generated && h.airKW > hall.airCoolingBudgetKW) add({ id: `cooling-air-budget-${h.hallId}`, severity: 'error', domain: 'cooling', message: `${hall.name}: 공기 냉각 부하 ${kw(h.airKW)}가 설비 용량 ${kw(hall.airCoolingBudgetKW)}를 초과합니다.`, refs: [h.hallId], messageEn: `${hall.name}: air cooling load ${kw(h.airKW)} exceeds the plant capacity ${kw(hall.airCoolingBudgetKW)}.` });
    if (h.airKW > 0 && h.crahsPlaced > 0) {
      // polish v2 2차 (cooling): rear doors (rack meta) remove h.rdhxDutyKW before the room units; active doors keep the rack airflow local
      if (h.crahCapacityKW < h.airKW - (h.rdhxDutyKW ?? 0)) add({ id: `cooling-crah-under-${h.hallId}`, severity: 'error', domain: 'cooling', message: `${hall.name}: CRAH 용량 ${kw(h.crahCapacityKW)}가 공기 발열 ${kw(h.airKW)}보다 작습니다.`, refs: [h.hallId], suggestion: `CRAH를 ${h.crahsRequired - h.crahsPlaced}대 이상 추가하세요.`, messageEn: `${hall.name}: CRAH capacity ${kw(h.crahCapacityKW)} is below the air heat load ${kw(h.airKW)}.`, suggestionEn: `Add at least ${h.crahsRequired - h.crahsPlaced} CRAH units.` });
      else if (h.crahsPlaced < h.crahsRequired) add({ id: `cooling-crah-redundancy-${h.hallId}`, severity: 'warning', domain: 'cooling', message: `${hall.name}: CRAH ${h.crahsPlaced}대로 ${project.cooling.crahRedundancy} 이중화(${h.crahsRequired}대)를 충족하지 못합니다.`, refs: [h.hallId], messageEn: `${hall.name}: ${h.crahsPlaced} CRAH units do not meet ${project.cooling.crahRedundancy} redundancy (${h.crahsRequired} required).` });
      if (!h.rdhxDoors && h.airflowPlacedM3s < h.airflowRequiredM3s) add({ id: `cooling-airflow-${h.hallId}`, severity: 'error', domain: 'cooling', message: `${hall.name}: CRAH 풍량 ${h.airflowPlacedM3s.toFixed(0)} m³/s가 필요 풍량 ${h.airflowRequiredM3s.toFixed(0)} m³/s보다 작습니다 (재순환 위험).`, refs: [h.hallId], messageEn: `${hall.name}: CRAH airflow ${h.airflowPlacedM3s.toFixed(0)} m³/s is below the required ${h.airflowRequiredM3s.toFixed(0)} m³/s (recirculation risk).` });
    } else if (h.airKW > 0 && h.crahsPlaced === 0) {
      add({ id: `cooling-crah-none-${h.hallId}`, severity: 'warning', domain: 'cooling', message: `${hall.name}: 공기 발열 ${kw(h.airKW)}에 대한 CRAH가 배치되지 않았습니다 (필요 ${h.crahsRequired}대).`, refs: [h.hallId], messageEn: `${hall.name}: no CRAH placed for the air heat load ${kw(h.airKW)} (${h.crahsRequired} required).` });
    }
  }
  // qa-autosize v2 2차 (§F "예산이 묶이면 명시적 예산 이슈 1건"): a utility shortfall at the same time joins the budget issue instead of a second error
  const utilityTotal = utilityIssues[0]?.id === 'power-utility-total';
  const utilityCap = utilityTotal ? (pw.utilityTotalMVA ?? 0) : pw.utilityAvailableMVA;
  const mva = (v: number) => `${v.toFixed(1)} MVA`;
  const utilityPart = utilityIssues.length ? `${mva(pw.utilityRequiredMVA)} / ${mva(utilityCap)} (−${mva(pw.utilityRequiredMVA - utilityCap)})` : null;
  for (const [hallId, s] of budgetShort) {
    const hall = project.halls.find((x) => x.id === hallId)!;
    const part = (label: string, v?: [number, number]) => (v ? `${label} ${kw(v[0])} / ${kw(v[1])} (−${kw(v[0] - v[1])})` : null);
    const ko = [part('IT', s.it), part('액체 냉각', s.liquid), part('공기 냉각', s.air), utilityPart && `수전 ${utilityTotal ? '전체 용량' : 'N-1 확정 용량'} ${utilityPart}`].filter(Boolean).join(', ');
    const en = [part('IT', s.it), part('liquid cooling', s.liquid), part('air cooling', s.air), utilityPart && `utility ${utilityTotal ? 'total capacity' : 'N-1 firm capacity'} ${utilityPart}`].filter(Boolean).join(', ');
    add({
      id: `layout-budget-limited-${hallId}`,
      severity: 'error',
      domain: 'layout',
      refs: [hallId],
      message: `${hall.name}: 설계 부하가 ${utilityPart ? '홀 예산과 수전 용량' : '홀 예산'}을 넘습니다 — 필요 / 예산 (부족): ${ko}.`,
      messageEn: `${hall.name}: the design exceeds the hall budgets${utilityPart ? ' and the utility capacity' : ''} — required / budget (shortfall): ${en}.`,
      suggestion: utilityPart ? '홀 예산과 수전 회선 용량을 필요값으로 올리거나(자동 해결, 확인 후 적용) DU 수를 줄여 다시 생성하세요.' : '홀 예산을 필요값으로 올리거나(자동 해결) DU 수를 줄여 다시 생성하세요.',
      suggestionEn: utilityPart ? 'Raise the hall budgets and the utility feeds to the required values (auto-fix, review first) or regenerate with fewer DUs.' : 'Raise the hall budgets to the required values (auto-fix) or regenerate with fewer DUs.',
    });
  }
  if (!budgetShort.size) for (const i of utilityIssues) add(i);
  for (const i of deferHi) if (!budgetShort.has(i.refs?.[0] ?? '')) add(i);
  const hallCduCap = new Map<string, number>();
  for (const p of ctx.placed) if (p.item.category === 'cdu') hallCduCap.set(p.e.hallId, (hallCduCap.get(p.e.hallId) ?? 0) + (p.item.capacity?.coolingKW ?? 0));
  for (const pod of ca.perPod ?? []) {
    if (pod.liquidKW <= 0) continue;
    if (pod.cdusPlaced === 0) {
      const hallId = ctx.byPod.get(pod.podId)?.[0]?.e.hallId ?? '';
      const hallLiquid = (ca.perHall ?? []).find((h) => h.hallId === hallId)?.liquidKW ?? 0;
      if ((hallCduCap.get(hallId) ?? 0) < hallLiquid) add({ id: `cooling-cdu-none-${pod.podId}`, severity: 'error', domain: 'cooling', message: `${pod.podId}: 액체 냉각 부하 ${kw(pod.liquidKW)}를 처리할 CDU가 없습니다.`, suggestion: `CDU ${pod.cdusRequired}대를 배치하세요.`, messageEn: `${pod.podId}: no CDU to handle the liquid cooling load ${kw(pod.liquidKW)}.`, suggestionEn: `Place ${pod.cdusRequired} CDUs.` });
    } else if (pod.cduCapacityKW < pod.liquidKW) {
      add({ id: `cooling-cdu-under-${pod.podId}`, severity: 'error', domain: 'cooling', message: `${pod.podId}: CDU 용량 ${kw(pod.cduCapacityKW)}가 액체 발열 ${kw(pod.liquidKW)}보다 작습니다.`, suggestion: `CDU를 ${pod.cdusRequired - pod.cdusPlaced}대 추가하세요.`, messageEn: `${pod.podId}: CDU capacity ${kw(pod.cduCapacityKW)} is below the liquid heat load ${kw(pod.liquidKW)}.`, suggestionEn: `Add ${pod.cdusRequired - pod.cdusPlaced} CDUs.` });
    } else if (pod.cdusPlaced < pod.cdusRequired) {
      add({ id: `cooling-cdu-redundancy-${pod.podId}`, severity: 'warning', domain: 'cooling', message: `${pod.podId}: CDU ${pod.cdusPlaced}대로 ${project.cooling.cduRedundancy} 이중화(${pod.cdusRequired}대)를 충족하지 못합니다.`, messageEn: `${pod.podId}: ${pod.cdusPlaced} CDUs do not meet ${project.cooling.cduRedundancy} redundancy (${pod.cdusRequired} required).` });
    }
  }
  for (const p of ctx.placed) {
    const lf = p.item.cooling?.liquidFraction ?? 0;
    const maxSupply = p.item.cooling?.maxCoolantSupplyC;
    if (lf > 0 && maxSupply !== undefined && project.cooling.tcsSupplyC > maxSupply) {
      add({ id: `cooling-tcs-temp-${p.item.id}`, severity: 'error', domain: 'cooling', message: `${p.item.name}: TCS 공급 온도 ${project.cooling.tcsSupplyC}°C가 허용 ${maxSupply}°C를 초과합니다.`, messageEn: `${p.item.name}: TCS supply temperature ${project.cooling.tcsSupplyC} °C exceeds the allowed ${maxSupply} °C.` });
    }
    if (project.cooling.supplyAirC > (p.item.cooling?.maxInletC ?? 99) && p.item.category !== 'crah') {
      add({ id: `cooling-supply-air-${p.item.id}`, severity: 'error', domain: 'cooling', message: `${p.item.name}: 급기 온도 ${project.cooling.supplyAirC}°C가 허용 흡기 ${p.item.cooling?.maxInletC}°C를 초과합니다.`, messageEn: `${p.item.name}: supply air ${project.cooling.supplyAirC} °C exceeds the allowed inlet ${p.item.cooling?.maxInletC} °C.` });
    }
  }
  if (project.cooling.tcsSupplyC < project.cooling.fwsSupplyC + 2) add({ id: 'cooling-approach', severity: 'warning', domain: 'cooling', message: `TCS 공급(${project.cooling.tcsSupplyC}°C)과 FWS 공급(${project.cooling.fwsSupplyC}°C)의 접근 온도차가 2 K 미만입니다.`, suggestion: 'CDU 열교환기 접근 온도(3–5 K)를 고려하세요.', messageEn: `Approach between TCS supply (${project.cooling.tcsSupplyC} °C) and FWS supply (${project.cooling.fwsSupplyC} °C) is below 2 K.`, suggestionEn: 'Allow for the CDU heat-exchanger approach (3–5 K).' });

  // ── network ──
  // v2 2차 (T2): inter-hall super-spines of joined clusters are reported by the cluster block below
  for (const u of (r.network.unplacedSwitches ?? []).filter((x) => !x.podId?.startsWith('inter-hall:'))) {
    add({ id: `network-unplaced-${u.catalogId}-${u.role}-${u.podId ?? 'central'}-${u.fabric}`, severity: 'error', domain: 'network', message: `${u.fabric}: ${u.role} 스위치 ${u.count}대가 네트워크 랙 용량(RU/전력)을 초과해 배치되지 않았습니다${u.podId ? ` (${u.podId})` : ''}.`, suggestion: `네트워크 랙을 ${Math.ceil(u.count / 8)}개 이상 추가하세요.`, messageEn: `${u.fabric}: ${u.count} ${u.role} switches exceed the network rack capacity (RU / power) and are not placed${u.podId ? ` (${u.podId})` : ''}.`, suggestionEn: `Add at least ${Math.ceil(u.count / 8)} network racks.` });
  }
  if ((r.network.unconnectedLinks ?? 0) > 0) add({ id: 'network-unconnected', severity: 'error', domain: 'network', message: `스위치가 없어 연결되지 않은 링크가 ${r.network.unconnectedLinks}개 있습니다.`, suggestion: '해당 포드에 네트워크 랙을 배치하세요.', messageEn: `${r.network.unconnectedLinks} links have no switch to connect to.`, suggestionEn: 'Place network racks in the affected pods.' });
  // backlog #10 (stream C): surplus OOB uplinks used to end at '?' ports with no issue
  if ((r.network.oobUplinksUnterminated ?? 0) > 0) add({ id: 'network-oob-uplinks-unterminated', severity: 'warning', domain: 'network', message: `OOB 리프 업링크 ${r.network.oobUplinksUnterminated}개가 프런트엔드 스파인과 리프의 빈 100G 레인을 넘어 케이블 스케줄에서 끝점 포트가 없습니다(?).`, suggestion: '프런트엔드 스파인 수를 늘리거나(OOB 집계 여유 포트 포함) OOB 집계 스위치를 따로 두세요.', messageEn: `${r.network.oobUplinksUnterminated} OOB leaf uplinks exceed the free 100G lanes of the front-end spines and leaves; their cable-schedule ends have no port (?).`, suggestionEn: 'Add front-end spines with spare ports for OOB aggregation, or plan dedicated OOB aggregation switches.' });
  for (const [i, u] of (r.network.unreachableRuns ?? []).slice(0, 20).entries()) add({ id: `network-unreachable-${i}`, severity: 'error', domain: 'network', message: `케이블 도달 거리 초과: ${u}`, suggestion: '스위치 랙을 가깝게 배치하거나 싱글모드 광을 사용하세요.', messageEn: `Cable reach exceeded: ${u}`, suggestionEn: 'Place switch racks closer or use single-mode fibre.' });
  for (const f of r.network.fabrics) {
    if (f.feasible === false && f.fabric === 'drivenets-fse') add({ id: `network-infeasible-${f.fabric}-${f.name}`, severity: 'error', domain: 'network', message: `${f.name}: ${f.endpoints}개 엔드포인트가 2-tier FSE 한계(NCP 256 × NCF 40, NCP–NCF 쌍당 400G 레인 1개)를 넘습니다 — 3-tier FSE는 RA에 정의되지 않았습니다 (추정).`, suggestion: '클러스터를 여러 2-tier FSE로 나누거나 다른 패브릭을 선택하세요.', messageEn: `${f.name}: ${f.endpoints} endpoints exceed the 2-tier FSE cap (256 NCP × 40 NCF, one 400G lane per NCP–NCF pair) — a 3-tier FSE is not sized in the RA (estimate).`, suggestionEn: 'Split the cluster into several 2-tier FSEs or choose another fabric.' });
    else if (f.feasible === false) add({ id: `network-infeasible-${f.fabric}-${f.name}`, severity: 'error', domain: 'network', message: `${f.name}: 지정한 계층 수로는 ${f.endpoints}개 엔드포인트를 수용할 수 없습니다.`, suggestion: '계층을 auto 또는 3으로 설정하세요.', messageEn: `${f.name}: the forced tier count cannot reach ${f.endpoints} endpoints.`, suggestionEn: 'Set tiers to auto or 3.' });
    if (f.extrapolated) add({ id: `network-extrapolated-${f.fabric}-${f.name}`, severity: 'warning', domain: 'network', message: `${f.name}: RA에서 검증된 최대 클러스터(AI-4608-800)를 넘어 NCF 수를 외삽했습니다 (추정).`, messageEn: `${f.name}: sized beyond the largest RA-validated cluster (AI-4608-800) — the NCF count is an extrapolation (estimate).` });
  }
  // v2 2차 (T2, DECISIONS-v2-2 F2): joined clusters — inter-hall super-spines need 'inter-hall-core' racks; SMF trunks within reach
  for (const c of r.network.clusters ?? []) {
    const ih = c.interHall;
    if (!ih) continue;
    const zone = project.halls.find((h) => h.id === ih.zoneHallId)?.name ?? ih.zoneHallId;
    const missing = ih.superSpines - ih.placedSuperSpines;
    if (missing > 0) add({ id: `network-cluster-core-unplaced-${c.id}`, severity: 'error', domain: 'network', message: `${c.name}: 홀 간 슈퍼 스파인 ${missing}대를 둘 inter-hall-core 랙이 ${zone}에 부족합니다 — 홀 간 트렁크 ${ih.trunks}개 중 일부 또는 전부가 연결되지 않습니다.`, suggestion: `${zone}의 네트워크 코어 구역에 networkRole 'inter-hall-core' 네트워크 랙을 ${Math.ceil(missing / 8)}개 이상 배치하거나(배치 엔진), 클러스터를 홀별로 분리하세요.`, messageEn: `${c.name}: ${zone} lacks 'inter-hall-core' racks for ${missing} inter-hall super-spines — some or all of the ${ih.trunks} inter-hall trunks are not connected.`, suggestionEn: `Place at least ${Math.ceil(missing / 8)} network racks with networkRole 'inter-hall-core' in the network-core zone of ${zone} (layout engine), or split the cluster per hall.` });
    if (ih.overReach > 0) add({ id: `network-cluster-reach-${c.id}`, severity: 'error', domain: 'network', message: `${c.name}: 홀 간 트렁크 ${ih.overReach}개가 케이블 도달 거리(${ih.reachM ?? '?'} m)를 넘습니다 (최대 ${ih.maxTrunkM} m).`, suggestion: '홀 원점(통로 진입점)을 가깝게 두거나 FR급(2 km) SMF 광 모듈을 지정하세요.', messageEn: `${c.name}: ${ih.overReach} inter-hall trunks exceed the cable reach (${ih.reachM ?? '?'} m; longest ${ih.maxTrunkM} m).`, suggestionEn: 'Move the hall origins (pathway entries) closer or select FR-class (2 km) single-mode optics.' });
    else if (ih.nearReach > 0) add({ id: `network-cluster-reach-near-${c.id}`, severity: 'warning', domain: 'network', message: `${c.name}: 홀 간 트렁크 ${ih.nearReach}개가 도달 거리의 90 %를 넘습니다 (최대 ${ih.maxTrunkM} m / ${ih.reachM} m, NVIDIA DU-10438 계획 한계).`, messageEn: `${c.name}: ${ih.nearReach} inter-hall trunks exceed 90 % of the cable reach (longest ${ih.maxTrunkM} m of ${ih.reachM} m; NVIDIA DU-10438 planning limit).` });
  }
  const so = project.network.scaleOut;
  if (so.oversubscription > 1 && ctx.gpus > 0) add({ id: 'network-oversub', severity: 'warning', domain: 'network', message: `Scale-out 오버서브스크립션 ${so.oversubscription}:1 — 대규모 학습의 집합 통신 효율이 저하됩니다 (효율 ${(r.network.commEfficiency * 100).toFixed(0)}%).`, messageEn: `Scale-out oversubscription ${so.oversubscription}:1 — collective-communication efficiency of large training jobs degrades (efficiency ${(r.network.commEfficiency * 100).toFixed(0)} %).` });
  const nic = ctx.gpuRack?.compute?.scaleOutPortGbps ?? 0;
  const sw = r.network.fabrics.find((f) => f.name.startsWith('Scale-out'));
  if (sw && nic > 0 && (sw.linkGbps ?? nic) < nic) add({ id: 'network-breakout', severity: 'info', domain: 'network', message: `GPU NIC ${nic}G가 스위치 포트 ${sw.linkGbps}G로 분할(breakout) 연결됩니다 — 스위치 포트 수가 늘어납니다.`, messageEn: `GPU NIC ${nic}G connects through ${sw.linkGbps}G switch ports (breakout) — more switch ports are consumed.` });

  // ── schedule ──
  const sch = r.schedule;
  for (const w of project.schedule.waves) {
    if (!w.targetReadyDate) continue;
    const rfs = sch.milestones.find((m) => m.id === `ms-rfs-${w.id}`)?.date;
    for (const f of project.site.utility) {
      if (parseISO(f.availableFrom) > parseISO(w.targetReadyDate)) add({ id: `schedule-utility-${f.id}-${w.id}`, severity: 'error', domain: 'schedule', message: `${f.name} 가용일(${f.availableFrom})이 ${w.name} 목표일(${w.targetReadyDate})보다 늦습니다.`, suggestion: '한전 수전 일정 협의 또는 목표일 조정이 필요합니다.', messageEn: `${f.name} available from ${f.availableFrom}, after the ${w.name} target date (${w.targetReadyDate}).`, suggestionEn: 'Negotiate the utility schedule or move the target date.' });
    }
    if (rfs && parseISO(rfs) > parseISO(w.targetReadyDate)) add({ id: `schedule-late-${w.id}`, severity: 'warning', domain: 'schedule', message: `${w.name} 예상 준공일 ${rfs}이 목표일 ${w.targetReadyDate}보다 늦습니다.`, suggestion: '장납기 품목 조기 발주, 작업조 증원, 웨이브 분할을 검토하세요.', messageEn: `${w.name} forecast ready-for-service ${rfs} is after the target ${w.targetReadyDate}.`, suggestionEn: 'Order long-lead items early, add crews or split the wave.' });
  }

  // ── workloads ──
  for (const wl of r.workloads) {
    const bp = project.workloads.find((x) => x.id === wl.workloadId);
    if (!bp) continue;
    if (wl.peakPowerKW > pw.ups.installedKVA * project.power.powerFactor) {
      add({ id: `workload-peak-ups-${wl.workloadId}`, severity: 'error', domain: 'workload', message: `${bp.name}: 워크로드 피크 ${kw(wl.peakPowerKW)}가 UPS 설치 용량을 초과합니다.`, suggestion: '다양성 계수를 1.0으로 설계하거나 UPS를 증설하세요.', messageEn: `${bp.name}: workload peak ${kw(wl.peakPowerKW)} exceeds the installed UPS capacity.`, suggestionEn: 'Design with a diversity factor of 1.0 or add UPS capacity.' });
    } else if (wl.peakPowerKW > pw.itDesignKW) {
      const ratio = wl.peakPowerKW / pw.itDesignKW;
      add({ id: `workload-peak-design-${wl.workloadId}`, severity: ratio > 1.1 ? 'warning' : 'info', domain: 'workload', message: `${bp.name}: 1초 피크 ${kw(wl.peakPowerKW)}가 IT 설계 부하 ${kw(pw.itDesignKW)}의 ${(ratio * 100).toFixed(0)}%입니다 (다양성 계수 ${project.power.diversityFactor}).`, suggestion: 'AI 학습은 동기 부하이므로 다양성 계수 0.95–1.0 적용을 검토하세요.', messageEn: `${bp.name}: 1-second peak ${kw(wl.peakPowerKW)} is ${(ratio * 100).toFixed(0)} % of the IT design load ${kw(pw.itDesignKW)} (diversity factor ${project.power.diversityFactor}).`, suggestionEn: 'AI training is a synchronous load — consider a diversity factor of 0.95–1.0.' });
    }
    // fix v2 2차 (QA): MoE trained with EP ≤ 1 puts no expert all-to-all on the fabric; per-GPU memory feasibility of weights + optimizer
    if (bp.training && (bp.model.moe?.experts ?? 1) > 1 && (bp.training.ep ?? 1) <= 1) add({ id: `workload-moe-ep1-${wl.workloadId}`, severity: 'warning', domain: 'workload', message: `${bp.name}: MoE 모델(전문가 ${bp.model.moe!.experts}개)을 EP 1로 학습합니다 — 전문가 all-to-all 바이트가 0이 되어 스텝 시간이 낙관적입니다.`, suggestion: 'EP를 전문가 수에 맞게 설정하세요 (예: DeepSeek-V3 EP64).', messageEn: `${bp.name}: MoE model (${bp.model.moe!.experts} experts) trained with EP 1 — expert all-to-all bytes are 0 and the step time is optimistic.`, suggestionEn: 'Set EP to match the expert count (e.g. DeepSeek-V3 EP64).' });
    if (bp.training && wl.gpus > 0) {
      const tr = bp.training;
      const gpuRack = project.equipment.map((e) => findCatalogItem(e.catalogId)).find((it) => it?.category === 'gpu-rack');
      const hbm = gpuRack?.compute?.gpuMemoryGB ?? 0;
      const mp = Math.max(1, (tr.tp ?? 1) * (tr.pp ?? 1) * (tr.ep ?? 1) * (tr.cp ?? 1));
      const dp = Math.max(1, Math.floor(wl.gpus / mp));
      const z = tr.zeroStage ?? 0;
      const P = bp.model.paramsB * 1e9;
      // mixed-precision Adam: 2 B weights + 2 B grads + 12 B optimizer per parameter; ZeRO-1/2/3 shard optimizer / grads / weights over DP (estimate)
      const perGpuGB = (P * (2 / (z >= 3 ? dp : 1) + 2 / (z >= 2 ? dp : 1) + 12 / (z >= 1 ? dp : 1))) / ((tr.tp ?? 1) * (tr.pp ?? 1) * (tr.ep ?? 1)) / 1e9;
      if (hbm > 0 && perGpuGB > hbm) add({ id: `workload-memory-${wl.workloadId}`, severity: 'warning', domain: 'workload', message: `${bp.name}: GPU당 가중치+옵티마이저 ${perGpuGB.toFixed(0)} GB가 HBM ${hbm} GB를 넘습니다 (TP·PP·EP = ${(tr.tp ?? 1) * (tr.pp ?? 1) * (tr.ep ?? 1)}, ZeRO ${z}, 활성값 제외, 추정).`, suggestion: 'TP / PP / EP 또는 ZeRO 단계를 늘리세요.', messageEn: `${bp.name}: weights + optimizer ${perGpuGB.toFixed(0)} GB per GPU exceed the ${hbm} GB HBM (TP·PP·EP = ${(tr.tp ?? 1) * (tr.pp ?? 1) * (tr.ep ?? 1)}, ZeRO ${z}, activations excluded, estimate).`, suggestionEn: 'Raise TP / PP / EP or the ZeRO stage.' });
    }
    if (wl.gpus === 0) add({ id: `workload-empty-${wl.workloadId}`, severity: 'warning', domain: 'workload', message: `${bp.name}: ${wl.notes[0] ?? '시뮬레이션 불가'}`, messageEn: `${bp.name}: ${wl.notesEn?.[0] ?? wl.notes[0] ?? 'simulation not possible'}` });
    if (wl.gpusRequired !== undefined && wl.gpusRequired > wl.gpus) add({ id: `workload-capacity-${wl.workloadId}`, severity: 'warning', domain: 'workload', message: `${bp.name}: 목표 처리량에 GPU ${wl.gpusRequired}개가 필요하나 ${wl.gpus}개만 할당되었습니다.`, messageEn: `${bp.name}: the target throughput needs ${wl.gpusRequired} GPUs but only ${wl.gpus} are allocated.` });
    if (bp.inference && wl.ttftMs !== undefined && wl.ttftMs > bp.inference.ttftSloMs) add({ id: `workload-ttft-${wl.workloadId}`, severity: 'warning', domain: 'workload', message: `${bp.name}: 예상 TTFT ${wl.ttftMs.toFixed(0)} ms > SLO ${bp.inference.ttftSloMs} ms`, messageEn: `${bp.name}: predicted TTFT ${wl.ttftMs.toFixed(0)} ms > SLO ${bp.inference.ttftSloMs} ms` });
    if (bp.inference && wl.tpotMs !== undefined && wl.tpotMs > bp.inference.tpotSloMs * 1.001) add({ id: `workload-tpot-${wl.workloadId}`, severity: 'warning', domain: 'workload', message: `${bp.name}: 예상 TPOT ${wl.tpotMs.toFixed(1)} ms > SLO ${bp.inference.tpotSloMs} ms`, messageEn: `${bp.name}: predicted TPOT ${wl.tpotMs.toFixed(1)} ms > SLO ${bp.inference.tpotSloMs} ms` });
  }
  // ── v2 2차 (T6, F9): GPU share over-allocation (rule lives in workload/shares.ts) ──
  for (const i of shareIssues(project.workloads)) add(i);

  // ── layout (S1, PROPOSAL-v2 §3.1 Phase A): generated geometry must stay inside the hall; skipped for reference-CFD projects ──
  if (project.purpose !== 'reference-cfd') {
    for (const hall of project.halls) {
      const hallRect = { x: 0, y: 0, w: hall.width, d: hall.depth };
      const items = ctx.byHall.get(hall.id) ?? [];
      const byId = new Map(items.map((p) => [p.e.id, p]));
      const rows = rowGroupsFromEquipment(hall.id, items.map((p) => p.e));
      // rows (pod rows, services and network-core rows) inside the hall
      for (const row of rows) {
        const outside = row.axis === 'x' ? row.a0 < -1e-3 || row.a1 > hall.width + 1e-3 : row.a0 < -1e-3 || row.a1 > hall.depth + 1e-3;
        if (outside) add({ id: `layout-row-outside-${row.id}`, severity: 'error', domain: 'layout', message: `${hall.name}: 열 ${row.id}(${row.a0.toFixed(2)}–${row.a1.toFixed(2)} m)이 홀 경계를 벗어납니다.`, refs: [hall.id, ...row.memberIds.slice(0, 4)], suggestion: '홀 크기를 늘리거나 상면 맞춤 모드로 다시 배치하세요.', messageEn: `${hall.name}: row ${row.id} (${row.a0.toFixed(2)}–${row.a1.toFixed(2)} m) leaves the hall boundary.`, suggestionEn: 'Enlarge the hall or re-place with fit-to-space.' });
      }
      for (const c of project.containments) {
        if (c.hallId !== hall.id) continue;
        if (!rectContains(hallRect, c.rect)) add({ id: `layout-containment-outside-${c.id}`, severity: 'error', domain: 'layout', message: `${hall.name}: 컨테인먼트 ${c.podId ?? c.id}가 홀 경계를 벗어납니다.`, refs: [hall.id, c.id], messageEn: `${hall.name}: containment ${c.podId ?? c.id} leaves the hall boundary.` });
      }
      for (const t of project.trays ?? []) {
        if (t.hallId !== hall.id) continue;
        if (!polylineInside(t.points, hall)) add({ id: `layout-tray-outside-${t.id}`, severity: 'error', domain: 'layout', message: `${hall.name}: 케이블 트레이 ${t.id}가 홀 경계를 벗어납니다.`, refs: [hall.id], messageEn: `${hall.name}: cable tray ${t.id} leaves the hall boundary.` });
      }
      for (const b of project.busways ?? []) {
        if (b.hallId !== hall.id) continue;
        if (!polylineInside(b.points, hall)) add({ id: `layout-busway-outside-${b.id}`, severity: 'error', domain: 'layout', message: `${hall.name}: 버스웨이 ${b.id}가 홀 경계를 벗어납니다.`, refs: [hall.id], messageEn: `${hall.name}: busway ${b.id} leaves the hall boundary.` });
      }
      // services / network-core racks vs CRAH footprints and service clearances
      const crahs = items.filter((p) => p.item.category === 'crah' || p.item.category === 'fan-wall');
      if (crahs.length) {
        const crahRects = crahs.map((p) => ({ p, rect: instanceRect(p.e, p.item) }));
        for (const row of rows) {
          if (row.kind === 'compute') continue;
          for (const id of row.memberIds) {
            const p = byId.get(id);
            if (!p) continue;
            const zones = clearanceZones(p).filter((z) => z.zone !== 'side');
            const fp = instanceRect(p.e, p.item);
            for (const c of crahRects) {
              if (rectsOverlap(fp, c.rect)) add({ id: `layout-services-crah-${p.e.id}-${c.p.e.id}`, severity: 'error', domain: 'layout', message: `${hall.name}: 서비스/네트워크 코어 랙 ${p.e.tag}가 CRAH ${c.p.e.tag}와 겹칩니다.`, refs: [p.e.id, c.p.e.id], suggestion: '중앙 열 길이 상한을 줄이거나(열 감기) CRAH 벽을 바꾸세요.', messageEn: `${hall.name}: services / network-core rack ${p.e.tag} overlaps CRAH ${c.p.e.tag}.`, suggestionEn: 'Reduce the central row length cap (wrap rows) or change the CRAH walls.' });
              else if (zones.some((z) => rectsOverlap(z.rect, c.rect))) add({ id: `layout-services-crah-clr-${p.e.id}-${c.p.e.id}`, severity: 'warning', domain: 'layout', message: `${hall.name}: ${p.e.tag}의 서비스 공간이 CRAH ${c.p.e.tag}와 겹칩니다.`, refs: [p.e.id, c.p.e.id], messageEn: `${hall.name}: service clearance of ${p.e.tag} overlaps CRAH ${c.p.e.tag}.` });
            }
          }
        }
      }
      // CRAH count: what the cooling engine requires vs what the layout placed (generated halls only)
      if (hall.layoutPolicy) {
        const ch = (r.cooling.analysis.perHall ?? []).find((h) => h.hallId === hall.id);
        if (ch && ch.airKW > 0 && ch.crahsPlaced < ch.crahsRequired) add({ id: `layout-crah-count-${hall.id}`, severity: 'error', domain: 'layout', message: `${hall.name}: 냉각 엔진이 요구하는 CRAH ${ch.crahsRequired}대 중 ${ch.crahsPlaced}대만 배치되었습니다.`, refs: [hall.id], suggestion: '둘레 벽을 추가(N/S)하거나 홀을 키우거나 in-row / per-pod 냉각 전략을 선택하세요.', messageEn: `${hall.name}: only ${ch.crahsPlaced} of the ${ch.crahsRequired} CRAH units the cooling engine requires are placed.`, suggestionEn: 'Add perimeter walls (N/S), enlarge the hall or choose an in-row / per-pod cooling strategy.' });
        // row longer than the template allows
        const tpl = findLayoutTemplate(hall.layoutPolicy.templateId);
        const maxRacks = tpl ? normalizeTemplate(tpl.pod).maxRacksPerRow : 40;
        for (const row of rows) {
          if (row.kind !== 'compute') continue;
          const gpuRacks = row.memberIds.filter((id) => byId.get(id)?.item.category === 'gpu-rack').length;
          if (gpuRacks > maxRacks) add({ id: `layout-row-long-${row.id}`, severity: 'warning', domain: 'layout', message: `${hall.name}: 열 ${row.id}의 GPU 랙 ${gpuRacks}개가 템플릿(${tpl?.name ?? hall.layoutPolicy.templateId}) 상한 ${maxRacks}개를 넘습니다.`, refs: row.memberIds.slice(0, 4), suggestion: '열당 랙 수를 줄이고 포드 컬럼을 늘리세요.', messageEn: `${hall.name}: row ${row.id} holds ${gpuRacks} GPU racks, above the template (${tpl?.name ?? hall.layoutPolicy.templateId}) cap of ${maxRacks}.`, suggestionEn: 'Reduce racks per row and add pod columns.' });
        }
      }
      // v2 2차 (T1, F8): mechanical-gallery CDUs — secondary-loop route vs the hydraulic budget (r2-layout.md §3.3)
      if (items.some((p) => p.item.category === 'cdu' && p.e.meta?.gallery === true)) for (const i of coolingLoopIssues(hall, coolingLoopsFor(project, hall.id))) add(i);
      // polish v2 2차 (QA F11): a gallery group short of its N + redundancy used to be reported only by regenerateCooling's transient report
      if (hall.coolingPlacement?.cduPlacement === 'gallery') {
        const groups = new Map<string, { pods: Set<string>; units: number; item?: typeof items[number]['item'] }>();
        for (const p of items) {
          if (p.item.category !== 'cdu' || p.e.meta?.gallery !== true) continue;
          const key = String(p.e.meta?.group ?? '');
          const g = groups.get(key) ?? { pods: new Set<string>(), units: 0, item: p.item };
          String(p.e.meta?.pods ?? '').split(',').filter(Boolean).forEach((x) => g.pods.add(x));
          g.units++;
          groups.set(key, g);
        }
        const served = new Set([...groups.values()].flatMap((g) => [...g.pods]));
        const cduItem = findCatalogItem(project.cooling.cduCatalogId) ?? [...groups.values()][0]?.item;
        const cap = cduItem?.capacity?.coolingKW ?? 0;
        const red = hall.coolingPlacement.cduRedundancy ?? project.cooling.cduRedundancy;
        const podLiquid = new Map<string, number>();
        for (const p of items) if (p.e.podId && !p.e.podId.startsWith('pod-services') && !p.e.podId.startsWith('pod-network-core')) podLiquid.set(p.e.podId, (podLiquid.get(p.e.podId) ?? 0) + liquidHeatKW(p.item));
        let required = 0;
        let placed = 0;
        const short: string[] = [];
        for (const [key, g] of groups) {
          const liquid = [...g.pods].reduce((a, x) => a + (podLiquid.get(x) ?? 0), 0);
          const n = hall.coolingPlacement.cduPerPod === 'auto' ? (liquid > 0 && cap > 0 ? redundantCount(Math.ceil(liquid / cap - 1e-9), red) : 0) : Math.max(0, Math.round(hall.coolingPlacement.cduPerPod)) * g.pods.size;
          required += n;
          placed += Math.min(n, g.units);
          if (g.units < n) short.push(key);
        }
        const unserved = [...podLiquid].filter(([pod, kw]) => kw > 0 && !served.has(pod)).map(([pod]) => pod);
        if (short.length || unserved.length)
          add({
            id: `layout-cdu-gallery-short-${hall.id}`,
            severity: 'error',
            domain: 'layout',
            message: `${hall.name}: 기계 갤러리 CDU ${required}대 중 ${placed}대만 그룹 이중화(${red})를 채웁니다${short.length ? ` — 부족 그룹 ${short.join(', ')}` : ''}${unserved.length ? ` — 갤러리 그룹이 없는 포드 ${unserved.slice(0, 4).join(', ')}` : ''}.`,
            messageEn: `${hall.name}: only ${placed} of ${required} mechanical-gallery CDUs meet the group redundancy (${red})${short.length ? ` — short groups ${short.join(', ')}` : ''}${unserved.length ? ` — pods without a gallery group ${unserved.slice(0, 4).join(', ')}` : ''}.`,
            refs: [hall.id],
            suggestion: '냉각 패널에서 갤러리 벽을 바꾸거나(두 번째 벽) 홀을 다시 생성하세요. 또는 열 끝 / 끝+중앙 CDU 배치를 선택하세요.',
            suggestionEn: 'Change the gallery wall (or use a second wall) in the cooling panel or regenerate the hall, or choose row-end / ends + centre CDUs.',
          });
      }
      // polish v2 2차 (QA F10): inter-hall-core racks left behind after a cluster was un-joined
      const ihcRacks = items.filter((p) => p.e.networkRole === 'inter-hall-core');
      const joined = project.network.scaleOut.fabric !== 'drivenets-fse' && (project.clusters ?? []).some((c) => c.hallIds.length > 1 && (c.interHallCore?.zoneHallId ?? c.hallIds[0]) === hall.id);
      if (ihcRacks.length && !joined)
        add({
          id: `layout-ihc-stale-${hall.id}`,
          severity: 'warning',
          domain: 'layout',
          message: `${hall.name}: 이 홀을 영역 홀로 쓰는 다중 홀 클러스터가 없는데 홀 간 코어 랙 ${ihcRacks.length}개가 남아 있습니다 (클러스터 해제 후).`,
          messageEn: `${hall.name}: ${ihcRacks.length} inter-hall-core rack(s) remain although no joined multi-hall cluster uses this hall as its zone hall (cluster un-joined).`,
          refs: [hall.id, ...ihcRacks.slice(0, 3).map((p) => p.e.id)],
          suggestion: '배치 패널에서 홀을 다시 생성하면 홀 간 코어 랙과 두 배로 늘린 스파인 랙이 해제됩니다. 다시 묶을 계획이면 그대로 두세요.',
          suggestionEn: 'Regenerate the hall in the layout panel to release the inter-hall-core racks and the doubled spine racks; keep them only if the halls will be joined again.',
        });
    }
  }

  // ── stream C (P3): standards parameter checks (no profile → none; inferred profile → info; DO-3 caps in standardsBasis.ts) ──
  for (const i of standardsCheckIssues(ctx, { network: r.network })) add(i);

  if (r.cost.capexUSD <= 0 && ctx.placed.length > 0) add({ id: 'cost-zero', severity: 'warning', domain: 'cost', message: 'CAPEX가 0으로 계산되었습니다. 가격 설정을 확인하세요.', messageEn: 'CAPEX computed as 0 — check the pricing settings.' });
  void r.space;

  if (project.purpose === 'reference-cfd') {
    // reference geometry (e.g. rebuilt from a CFD case): only physical placement checks are meaningful
    const kept = issues.filter((i) => i.domain === 'space' || i.domain === 'thermal');
    // finish v2 2차: the CFD case models compute racks and cooling units only — say so, with the switch count the network engine could
    // not place (the analysis used to be read as "6 unplaced switches": 6 groups holding every switch of the sized fabrics)
    const unplaced = (r.network.unplacedSwitches ?? []).reduce((s, u) => s + u.count, 0);
    const netRacks = ctx.placed.filter((p) => p.item.category === 'network-rack').length;
    const netNote = unplaced > 0 && netRacks === 0;
    kept.push({
      id: 'reference-cfd-scope',
      severity: 'info',
      domain: 'thermal',
      message: `레퍼런스 CFD 형상 프로젝트입니다. 전력·냉각 설비·네트워크·일정·워크로드 설계 검증은 생략합니다.${netNote ? ` CFD 형상에 네트워크 랙이 없어 산정된 스위치 ${unplaced}대(${(r.network.unplacedSwitches ?? []).length}개 그룹) 전부가 미배치이고 케이블 런이 없습니다.` : ''}`,
      suggestion: '형상 전용 프로젝트입니다. 냉각·열 화면에서 자체 솔버로 이 배치를 해석하세요.',
      messageEn: `Reference CFD geometry project — power, cooling plant, network, schedule and workload validation are skipped.${netNote ? ` The CFD geometry has no network racks, so all ${unplaced} sized switches (${(r.network.unplacedSwitches ?? []).length} groups) are unplaced and no cable runs exist.` : ''}`,
      suggestionEn: 'Geometry-only project: run the built-in solver on this layout on the Cooling / Thermal page.',
    });
    issues.splice(0, issues.length, ...kept);
  }

  const order = { error: 0, warning: 1, info: 2 } as const;
  return issues.sort((a, b) => order[a.severity] - order[b.severity] || a.domain.localeCompare(b.domain) || a.id.localeCompare(b.id));
}
