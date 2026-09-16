// autosize v2 2차 (DECISIONS-v2-2 §F): a freshly auto-sized hall has zero sizing issues for every DU template × registered compute platform
// (and accelerator slot), a binding budget raises ONE budget-limited issue with the shortfall, and every one-click remedy removes its issue.
import { describe, expect, it } from 'vitest';
import {
  acceleratorRacksPerDu, addHall, analyzeProject, applyRemedy, autoSizeHall, createNvidiaReferenceProject, defaultSpinePlacement, defaultWaveStart,
  findCatalogItem, fixAllRemedies, hallUnreachableRuns, issueHallId, issueRemedy, LAYOUT_TEMPLATES, noRemedyReason, layoutOptionsFromProject,
  registeredPlatformIds, resolveLayoutTemplate, SIZING_ISSUE_RE,
  type AutoSizeRequest, type Issue, type PodAccelerator, type Project, type ProjectAnalysis,
} from '../src/index.ts';

type GenPatch = { accelerators?: PodAccelerator[]; budgets?: 'fit' | 'hold'; project?: Project; growth?: 'phased' | 'single-build' };

/** the Layout panel's request for a new hall (addHall) of the reference project */
function setup(templateId: string, gpu: string | undefined, pods: number, patch: GenPatch = {}) {
  const base = patch.project ?? structuredClone(createNvidiaReferenceProject().project);
  if (patch.growth && patch.growth !== (base.growth ?? 'phased')) {
    base.growth = patch.growth;
    base.network.scaleOut.spinePlacement = defaultSpinePlacement(patch.growth);
    base.network.scaleOut.separateRoom = false;
  }
  const { project: p, hallId } = addHall(base, {});
  const hall = p.halls.find((h) => h.id === hallId)!;
  const o = layoutOptionsFromProject(p, hall);
  const tpl = resolveLayoutTemplate(templateId, { project: p })!;
  const req: AutoSizeRequest = {
    templateId,
    template: { ...tpl.pod, cduCatalogId: o.template.cduCatalogId, cduRedundancy: o.template.cduRedundancy, oversubscription: o.template.oversubscription, ...(gpu ? { gpuRackCatalogId: gpu } : {}), accelerators: patch.accelerators ?? [] },
    pods,
    services: { spineRacks: 'auto', storageRacks: 0, cpuRacks: 0, mgmtRacks: 0 },
    crahCatalogId: o.crahCatalogId,
    marginM: 1,
    podsPerWave: 2,
    waveStart: defaultWaveStart(p, hallId),
    autoSize: true,
    crahStrategy: tpl.defaults.crahStrategy,
    servicesZone: 'auto',
    grid: { auto: true, orientation: 'x', columns: 1 },
    crahWalls: 'auto',
    ...(patch.budgets ? { budgets: patch.budgets } : {}),
  };
  return { p, hallId, hall, req };
}

function generate(templateId: string, gpu: string | undefined, pods: number, patch: GenPatch = {}) {
  const { p, hallId, req } = setup(templateId, gpu, pods, patch);
  const r = autoSizeHall(p, hallId, req);
  if (!r.ok) throw new Error(`${templateId} did not fit`);
  return { p, hallId, r, a: r.analysis };
}

/** sizing issues of the new hall + project-level sizing issues */
const sizing = (p: Project, a: ProjectAnalysis, hallId: string) => a.issues.filter((i) => i.severity !== 'info' && SIZING_ISSUE_RE.test(i.id) && (issueHallId(p, i) === hallId || !issueHallId(p, i))).map((i) => i.id);
const ids = (a: ProjectAnalysis) => a.issues.map((i) => i.id);
const find = (a: ProjectAnalysis, re: RegExp): Issue => {
  const i = a.issues.find((x) => re.test(x.id));
  if (!i) throw new Error(`no issue ${re} in ${ids(a).join(', ')}`);
  return i;
};
const hallOf = (p: Project, hallId: string, cat: string) => p.equipment.filter((e) => e.hallId === hallId && findCatalogItem(e.catalogId)?.category === cat);

describe('autosize: fresh generation has zero sizing issues', () => {
  const combos: [string, string, PodAccelerator | undefined][] = [];
  for (const t of LAYOUT_TEMPLATES) {
    for (const id of registeredPlatformIds(t.id, t.computeSlots[0].id)) combos.push([t.id, id, undefined]);
    const def = resolveLayoutTemplate(t.id)!.pod;
    for (const s of t.computeSlots.slice(1)) for (const id of registeredPlatformIds(t.id, s.id)) combos.push([t.id, def.gpuRackCatalogId, { slotId: s.id, catalogId: id, racksPerDu: acceleratorRacksPerDu(s, def.racksPerRow * (def.rowsPerPod ?? 2)) }]);
  }
  it(`every template × registered platform / accelerator (${combos.length} combos, 1 DU)`, () => {
    const failures: string[] = [];
    for (const [tpl, gpu, acc] of combos) {
      const { p, hallId, a } = generate(tpl, gpu, 1, { accelerators: acc ? [acc] : [] });
      const s = sizing(p, a, hallId);
      if (s.length) failures.push(`${tpl} ${gpu}${acc ? ` + ${acc.catalogId}` : ''}: ${s.join(' ')}`);
    }
    expect(failures).toEqual([]);
  }, 240_000);

  it.each([
    ['std-eia-air-du', 'amd-mi300x-air-4x'],
    ['std-eia-liquid-uqd-du', 'amd-mi355x-dlc-4x'],
    ['std-orw-liquid-sidecar-du', 'amd-helios-mi455x'],
    ['custom', 'rebellions-atom-max-8x'],
    ['rack-scale-liquid-du', 'nvidia-vr-nvl72'],
    ['rcu-row', 'nvidia-vr-nvl72'],
  ])('%s %s at 4 DU (budgets raised to the design)', (tpl, gpu) => {
    const { p, hallId, a, r } = generate(tpl, gpu, 4);
    expect(sizing(p, a, hallId)).toEqual([]);
    if (r.ok) expect(r.report.budgets.it.after).toBeGreaterThanOrEqual(r.report.budgets.it.before);
  }, 60_000);

  it('liquid-cooled UBB8 on the liquid EIA template gets CDUs at the engine rule', () => {
    const { p, hallId, a } = generate('std-eia-liquid-uqd-du', 'amd-mi355x-dlc-4x', 1);
    const perPod = (a.cooling.perPod ?? []).filter((x) => x.liquidKW > 0);
    expect(perPod.length).toBeGreaterThan(0);
    for (const pod of perPod) expect(pod.cdusPlaced).toBeGreaterThanOrEqual(pod.cdusRequired);
    expect(hallOf(p, hallId, 'cdu').length).toBeGreaterThan(0);
  });

  it('a new hall keeps the project fabric switch when another hall already uses it (no stranded spines)', () => {
    const { p, r, a } = generate('rcu-row', 'nvidia-vr-nvl72', 1);
    expect(r.ok && r.report.switchKept?.kept).toBe('nvidia-q3400');
    expect(p.network.scaleOut.switchCatalogId).toBe('nvidia-q3400');
    expect(ids(a).filter((i) => i.startsWith('network-unplaced') || i === 'network-unconnected')).toEqual([]);
  });
});

describe('autosize: hall envelope modes', () => {
  it('right-size reclaims unused floor area and keeps E/N wall keepouts attached', () => {
    const { p, hallId, hall, req } = setup('std-eia-air-du', 'hgx-b200-air-4x', 1);
    hall.width = 120;
    hall.depth = 90;
    hall.keepouts = [
      { id: 'east-egress', kind: 'egress', rect: { x: 119.7, y: 2, w: 0.3, d: 1.2 }, label: 'East egress' },
      { id: 'north-door', kind: 'door', rect: { x: 4, y: 89.7, w: 2.4, d: 0.3 }, label: 'North door' },
    ];
    const r = autoSizeHall(p, hallId, { ...req, rightSize: true });
    expect(r.ok).toBe(true);
    expect(hall.width).toBeLessThan(120);
    expect(hall.depth).toBeLessThan(90);
    expect(hall.keepouts.find((x) => x.id === 'east-egress')!.rect.x + 0.3).toBeCloseTo(hall.width, 6);
    expect(hall.keepouts.find((x) => x.id === 'north-door')!.rect.y + 0.3).toBeCloseTo(hall.depth, 6);
    if (r.ok) expect(r.report.hall.mode).toBe('right-size');
  }, 60_000);

  it('grow-only preserves an oversized user envelope', () => {
    const { p, hallId, hall, req } = setup('std-eia-air-du', 'hgx-b200-air-4x', 1);
    hall.width = 120;
    hall.depth = 90;
    const r = autoSizeHall(p, hallId, req);
    expect(r.ok).toBe(true);
    expect(hall.width).toBe(120);
    expect(hall.depth).toBe(90);
  }, 60_000);
});

describe('autosize: binding budgets', () => {
  it('hold → one budget-limited issue with the exact shortfall, and its remedy clears it', () => {
    const { p, hallId, a } = generate('rack-scale-liquid-du', 'nvidia-vr-nvl72', 4, { budgets: 'hold' });
    const hall = p.halls.find((h) => h.id === hallId)!;
    const lim = a.issues.filter((i) => i.id.startsWith('layout-budget-limited-'));
    expect(lim.map((i) => i.id)).toEqual([`layout-budget-limited-${hallId}`]);
    expect(ids(a).some((i) => /^(power-hall-budget-|cooling-(liquid|air)-budget-)/.test(i) && i.endsWith(hallId))).toBe(false);
    const need = a.power.perHall.find((h) => h.hallId === hallId)!.itKW;
    expect(lim[0].messageEn).toContain(`${Math.round(need - hall.itPowerBudgetKW).toLocaleString('en-US')} kW`);
    // The utility shortfall, when present, is folded into the same issue
    // (no separate power-utility-* error) and its remedy raises the feeds too, so it is offered per issue (review first)
    expect(ids(a).filter((i) => /^power-utility-(firm|total)$/.test(i))).toEqual([]);
    const utilityShort = a.power.utilityRequiredMVA > a.power.utilityAvailableMVA;
    if (utilityShort) expect(lim[0].messageEn).toContain('utility');
    const rem = issueRemedy(p, a, lim[0])!;
    expect(rem.kind).toBe(utilityShort ? 'budget-utility' : 'hall-budget');
    expect(rem.safe).toBe(!utilityShort);
    const fixed = applyRemedy(p, rem);
    const a2 = analyzeProject(fixed);
    expect(ids(a2).filter((i) => i.startsWith('layout-budget-limited-') || i.startsWith('power-hall-budget') || /^power-utility-(firm|total)$/.test(i))).toEqual([]);
  }, 60_000);

  it('hold with only the hall budgets binding → one safe hall-budget issue; utility alone → one utility issue', () => {
    const { p, hallId, a } = generate('std-eia-air-du', 'amd-mi300x-air-4x', 4, { budgets: 'hold' });
    const budget = a.issues.filter((i) => /^(layout-budget-limited-|power-hall-budget|cooling-(liquid|air)-budget-|power-utility-(firm|total)$)/.test(i.id));
    expect(budget.length).toBeLessThanOrEqual(1);
    if (budget.length) {
      const rem = issueRemedy(p, a, budget[0])!;
      const a2 = analyzeProject(applyRemedy(p, rem));
      expect(ids(a2)).not.toContain(budget[0].id);
    }
    // utility alone: hall budgets raised, the feeds held
    const q = structuredClone(p);
    const h = q.halls.find((x) => x.id === hallId)!;
    h.itPowerBudgetKW = h.liquidCoolingBudgetKW = h.airCoolingBudgetKW = 1e6;
    q.site.utility.forEach((f) => (f.capacityMVA = 5));
    const aq = analyzeProject(q);
    const only = aq.issues.filter((i) => /^(layout-budget-limited-|power-utility-(firm|total)$)/.test(i.id));
    expect(only.map((i) => i.id)).toHaveLength(1);
    expect(issueRemedy(q, aq, only[0])!.kind).toBe('utility-feeds');
  }, 60_000);
});

describe('autosize: every remedy removes its issue', () => {
  const base = () => generate('rack-scale-liquid-du', 'nvidia-gb300-nvl72', 1);

  it('cooling-units: a missing CDU', () => {
    const { p, hallId } = base();
    const cdu = hallOf(p, hallId, 'cdu')[0];
    p.equipment = p.equipment.filter((e) => e.id !== cdu.id);
    const a = analyzeProject(p);
    const issue = find(a, /^cooling-cdu-(redundancy|under|none)-/);
    const r = issueRemedy(p, a, issue)!;
    expect(r.kind).toBe('cooling-units');
    const a2 = analyzeProject(applyRemedy(p, r));
    expect(ids(a2)).not.toContain(issue.id);
    expect(sizing(p, a2, hallId)).toEqual([]);
  }, 60_000);

  it('cooling-units: missing CRAHs', () => {
    const { p, hallId } = base();
    const crahs = hallOf(p, hallId, 'crah');
    p.equipment = p.equipment.filter((e) => !crahs.slice(0, 2).some((c) => c.id === e.id));
    const a = analyzeProject(p);
    const issue = find(a, /^(cooling-crah-(under|redundancy|none)|layout-crah-count|cooling-airflow)-/);
    const r = issueRemedy(p, a, issue)!;
    expect(r.kind).toBe('cooling-units');
    const a2 = analyzeProject(applyRemedy(p, r));
    expect(ids(a2).filter((i) => /^(cooling-crah|layout-crah-count|cooling-airflow)/.test(i))).toEqual([]);
  }, 60_000);

  it('hall-budget: IT utilisation above 90 %', () => {
    const { p, hallId, a } = base();
    p.halls.find((h) => h.id === hallId)!.itPowerBudgetKW = Math.ceil(a.power.perHall.find((h) => h.hallId === hallId)!.itKW / 0.95);
    const a1 = analyzeProject(p);
    const issue = find(a1, new RegExp(`^power-hall-budget-hi-${hallId}$`));
    const a2 = analyzeProject(applyRemedy(p, issueRemedy(p, a1, issue)!));
    expect(ids(a2)).not.toContain(issue.id);
  }, 60_000);

  it('utility-feeds: firm capacity below the required feed (not in fix-all)', () => {
    const { p } = base();
    p.site.utility.forEach((f) => (f.capacityMVA = 5));
    const a = analyzeProject(p);
    const issue = find(a, /^power-utility-(firm|total)$/);
    const r = issueRemedy(p, a, issue)!;
    expect(r.kind).toBe('utility-feeds');
    expect(r.safe).toBe(false);
    const a2 = analyzeProject(applyRemedy(p, r));
    expect(ids(a2).filter((i) => /^power-utility-(firm|total)$/.test(i))).toEqual([]);
  }, 60_000);

  it('tcs-supply: a liquid-cooled accelerator that needs a colder loop', () => {
    const { p } = generate('custom', undefined, 1, { accelerators: [{ slotId: 'npu', catalogId: 'cerebras-cs3-2x', racksPerDu: 2 }] });
    const a = analyzeProject(p);
    const issue = find(a, /^cooling-tcs-temp-/);
    const r = issueRemedy(p, a, issue)!;
    expect(r.kind).toBe('tcs-supply');
    const a2 = analyzeProject(applyRemedy(p, r));
    expect(ids(a2).filter((i) => i.startsWith('cooling-tcs-temp-'))).toEqual([]);
  }, 60_000);

  it('supply-air: supply air above the equipment inlet limit', () => {
    const { p } = base();
    p.cooling.supplyAirC = 45;
    const a = analyzeProject(p);
    const issue = find(a, /^cooling-supply-air-/);
    const a2 = analyzeProject(applyRemedy(p, issueRemedy(p, a, issue)!));
    expect(ids(a2).filter((i) => i.startsWith('cooling-supply-air-'))).toEqual([]);
  }, 60_000);

  it('ups-auto: a hand-set UPS block arrangement that does not survive N-1', () => {
    const { p } = base();
    p.power.upsBlocks = { blockModules: 1, activeBlocks: 1 };
    const a = analyzeProject(p);
    const issue = find(a, /^power-ups-block-headroom$/);
    const a2 = analyzeProject(applyRemedy(p, issueRemedy(p, a, issue)!));
    expect(ids(a2)).not.toContain('power-ups-block-headroom');
  }, 60_000);

  it('regenerate-hall: network racks sized for another switch', () => {
    const { p, hallId } = generate('rack-scale-liquid-du', 'nvidia-gb300-nvl72', 2);
    p.network.scaleOut.switchCatalogId = 'nvidia-sn5600';
    const a = analyzeProject(p);
    const issue = a.issues.find((i) => i.id.startsWith('network-unplaced-') && issueRemedy(p, a, i)?.hallId === hallId) ?? find(a, /^network-unplaced-/);
    const r = issueRemedy(p, a, issue)!;
    expect(r.kind).toBe('regenerate-hall');
    const fixed = applyRemedy(p, r);
    const a2 = analyzeProject(fixed);
    expect(a2.issues.filter((i) => i.id.startsWith('network-unplaced-') && issueHallId(fixed, i) === r.hallId).map((i) => i.id)).toEqual([]);
  }, 60_000);

  it('single-mode: offered only when single-mode optics reach the run (a 100G run past every 100G type has no automatic fix)', () => {
    const { p, a } = base();
    const fake: Issue = { id: 'network-unreachable-0', severity: 'error', domain: 'network', message: 'x' };
    const a100: ProjectAnalysis = { ...a, network: { ...a.network, unreachableRuns: ['DU06-B-NET1→SVC-FEN02 109 m @100G'] } };
    expect(issueRemedy(p, a100, fake)).toBeUndefined();
    expect(noRemedyReason(p, fake)).toBe('geometry');
    // the remedy itself still switches the preference when offered
    expect(applyRemedy(p, { issueId: fake.id, kind: 'single-mode', safe: false, key: 'single-mode', params: {} }).network.cabling.preferSingleMode).toBe(true);
  });

  it('fix all applies the safe remedies in one step and leaves the site-level ones', () => {
    const { p, hallId, a } = base();
    const cdu = hallOf(p, hallId, 'cdu')[0];
    p.equipment = p.equipment.filter((e) => e.id !== cdu.id);
    p.halls.find((h) => h.id === hallId)!.itPowerBudgetKW = Math.ceil(a.power.perHall.find((h) => h.hallId === hallId)!.itKW / 0.95);
    p.site.utility.forEach((f) => (f.capacityMVA = 5));
    const res = fixAllRemedies(p);
    expect(res.applied.map((r) => r.kind).sort()).toEqual(['cooling-units', 'hall-budget']);
    expect(ids(res.analysis).filter((i) => /^(cooling-cdu|power-hall-budget)/.test(i))).toEqual([]);
    expect(ids(res.analysis).some((i) => /^power-utility-(firm|total)$/.test(i))).toBe(true);
  }, 120_000);

  it('regenerate-hall keeps budgets that fitted the design fitted (qa perturbation: Helios 4 DU after a switch change raised layout-budget-limited)', () => {
    const { p, hallId } = generate('std-orw-liquid-sidecar-du', 'amd-helios-mi455x', 4);
    p.network.scaleOut.switchCatalogId = 'nvidia-sn5600';
    const a = analyzeProject(p);
    const errors0 = new Set(a.issues.filter((i) => i.severity === 'error').map((i) => i.id));
    const issue = a.issues.find((i) => i.id.startsWith('network-unplaced-') && issueRemedy(p, a, i)?.hallId === hallId);
    expect(issue).toBeDefined();
    const r = issueRemedy(p, a, issue!)!;
    expect(r.kind).toBe('regenerate-hall');
    const fixed = applyRemedy(p, r);
    const a2 = analyzeProject(fixed);
    expect(a2.issues.filter((i) => i.severity === 'error' && !errors0.has(i.id)).map((i) => i.id)).toEqual([]);
    // … while a budget that was already binding stays binding (no silent raise)
    const held = structuredClone(p);
    held.halls.find((h) => h.id === hallId)!.itPowerBudgetKW = 1000;
    const ah = analyzeProject(held);
    const rh = issueRemedy(held, ah, ah.issues.find((i) => i.id.startsWith('network-unplaced-') && issueRemedy(held, ah, i)?.hallId === hallId)!)!;
    expect(applyRemedy(held, rh).halls.find((h) => h.id === hallId)!.itPowerBudgetKW).toBe(1000);
  }, 180_000);
});

describe('autosize: cable reach at 16 DU (qa-autosize-v2-2 §1 leftovers)', () => {
  it('rack-scale liquid DU, VR NVL72 phased: overflow front-end leaves sit in the pod rack nearest the aggregation zone — no run beyond reach on the chosen grid', () => {
    const { p, hallId, a, r } = generate('rack-scale-liquid-du', 'nvidia-vr-nvl72', 16);
    expect(hallUnreachableRuns(p, a, hallId)).toEqual([]);
    // backlog T1a: the grid probes now place the calibrated CRAH count, so the first grid may differ and R3 may keep the next one ('reach');
    // the outcome pinned here is unchanged — no run beyond reach and no sizing issue on the written hall
    expect(r.ok).toBe(true);
    expect(sizing(p, a, hallId)).toEqual([]);
  }, 240_000);

  it('rack-scale liquid DU, GB200 single-build: a tray route the geometric check cannot see (109 m) makes autoSizeHall keep the next grid, deterministically', () => {
    const one = generate('rack-scale-liquid-du', 'nvidia-gb200-nvl72', 16, { growth: 'single-build' });
    expect(hallUnreachableRuns(one.p, one.a, one.hallId)).toEqual([]);
    // backlog T1a: with the calibrated CRAH count in the grid probes the first grid is already in reach for this hall (no 'reach' retry);
    // The phased rack-scale case above still exercises the large-hall route. Pinned: in reach, no sizing issue, deterministic
    expect(one.r.ok).toBe(true);
    expect(sizing(one.p, one.a, one.hallId)).toEqual([]);
    const two = generate('rack-scale-liquid-du', 'nvidia-gb200-nvl72', 16, { growth: 'single-build' });
    const hall = (x: typeof one) => x.p.halls.find((h) => h.id === x.hallId)!;
    expect([hall(two).width, hall(two).depth, hall(two).layoutPolicy?.grid?.columns, hall(two).layoutPolicy?.orientation]).toEqual([hall(one).width, hall(one).depth, hall(one).layoutPolicy?.grid?.columns, hall(one).layoutPolicy?.orientation]);
  }, 240_000);
});

describe('autosize: electrical-room walls (qa-autosize-v2-2 §3)', () => {
  it('rooms keep opposite walls when the row-end walls hold every CRAH (1 DU): no shared-wall note', () => {
    const { hallId, a } = generate('custom', 'amd-mi300x-air-4x', 1);
    expect(ids(a).filter((i) => i.startsWith(`power-elec-room-shared-wall-${hallId}`) || i.startsWith(`power-elec-room-wall-elec-${hallId}`))).toEqual([]);
    const rooms = (a.power.rooms ?? []).filter((r) => r.hallId === hallId);
    expect(new Set(rooms.map((r) => r.wall)).size).toBe(2);
  }, 60_000);
});
