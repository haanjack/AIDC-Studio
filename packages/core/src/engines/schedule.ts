import { findCatalogItem } from '../catalog/catalog.ts';
import type { CatalogItem, PowerAnalysis, ScheduleAnalysis, ScheduleSettings, ScheduleTask } from '../model/types.ts';
import { addDays, type Ctx, IT_LOAD_CATEGORIES, parseISO, type Placed } from './context.ts';
import type { CoolingResult } from './cooling.ts';
import type { NetworkResult } from './network.ts';

/**
 * Deployment schedule (CPM).
 *
 *  Durations: labor hours / (crews × crewSize × hoursPerDay) working days, converted to calendar days
 *  with ceil(wd · 7 / workDaysPerWeek).  Long-lead POs (≥ 26 weeks) are placed at NTP, the rest after IFC design.
 *  Utility energization cannot start before `site.utility[].availableFrom`.
 *  Waves share crews: each wave's crew task waits for the previous wave's same task.
 *  Critical path: forward pass (ES/EF) + backward pass from project finish (LS/LF); slack ≤ 0 → critical.
 */

interface Draft {
  id: string;
  name: string;
  phase: ScheduleTask['phase'];
  waveId?: string;
  durationDays: number;
  dependsOn: string[];
  notBefore?: string;
  crew?: keyof ScheduleSettings['crews'];
  qty?: number;
  laborHours?: number;
}

export function analyzeScheduleCtx(ctx: Ctx, r: { network: NetworkResult; cooling: CoolingResult; power: PowerAnalysis }): ScheduleAnalysis {
  const { project } = ctx;
  const s = project.schedule;
  const wpw = Math.min(7, Math.max(1, s.workDaysPerWeek));
  const cal = (wd: number) => Math.max(1, Math.ceil((wd * 7) / wpw));
  const crewDays = (hours: number, crew: keyof ScheduleSettings['crews'], minWd: number) => {
    const cap = Math.max(1, s.crews[crew]) * Math.max(1, s.crewSize) * Math.max(1, s.hoursPerDay);
    return cal(Math.max(minWd, Math.ceil(hours / cap)));
  };

  const drafts: Draft[] = [];
  const has = new Set<string>();
  const task = (d: Draft) => {
    d.dependsOn = d.dependsOn.filter((x) => has.has(x));
    drafts.push(d);
    has.add(d.id);
  };

  const hallArea = project.halls.reduce((a, h) => a + h.width * h.depth, 0);
  task({ id: 'design', name: 'Design & engineering (IFC)', phase: 'site', durationDays: 90, dependsOn: [] });
  task({ id: 'permits', name: 'Permits & approvals', phase: 'site', durationDays: 75, dependsOn: ['design'] });
  task({ id: 'shell', name: 'White-space fit-out (floor, plenum, fire, lighting)', phase: 'site', durationDays: cal(40 + Math.ceil(hallArea / 40)), dependsOn: ['permits'], qty: Math.round(hallArea) });

  const procure = (id: string, name: string, item: CatalogItem | undefined, extraWeeks = 0, phase: ScheduleTask['phase'] = 'procurement') => {
    if (!item) return;
    const weeks = item.cost.leadTimeWeeks + extraWeeks;
    task({ id, name: `Procure ${name} (${weeks} wk lead)`, phase, durationDays: weeks * 7, dependsOn: weeks >= 26 ? [] : ['design'] });
  };

  const pd = project.power;
  const cd = project.cooling;
  const ca = r.cooling.analysis;
  const pw = r.power;

  // waves & membership
  const waves = s.waves.length ? s.waves : [{ id: 'wave-all', name: 'All', podIds: [...new Set(ctx.placed.map((p) => p.e.podId).filter((x): x is string => !!x))] }];
  const waveOf = (p: Placed): string => {
    if (p.e.waveId && waves.some((w) => w.id === p.e.waveId)) return p.e.waveId;
    const w = waves.find((wv) => p.e.podId && wv.podIds.includes(p.e.podId));
    return (w ?? waves[0]).id;
  };
  const inWave = new Map<string, Placed[]>(waves.map((w) => [w.id, []]));
  for (const p of ctx.placed) inWave.get(waveOf(p))?.push(p);

  const ofCategory = (cat: string) => ctx.placed.filter((p) => p.item.category === cat);
  const itItems = ctx.placed.filter((p) => IT_LOAD_CATEGORIES.has(p.item.category));
  waves.forEach((w, i) => {
    const items = (inWave.get(w.id) ?? []).filter((p) => IT_LOAD_CATEGORIES.has(p.item.category));
    const lead = items.reduce((m, p) => Math.max(m, p.item.cost.leadTimeWeeks), 0);
    if (!items.length) return;
    const weeks = lead + Math.round((i * 30) / 7);
    task({ id: `proc-it-${w.id}`, name: `Procure IT racks — ${w.name} (${weeks} wk)`, phase: 'procurement', waveId: w.id, durationDays: weeks * 7, dependsOn: lead >= 26 ? [] : ['design'], qty: items.length });
  });
  const sw = r.network.plans[0]?.sw;
  if (sw) task({ id: 'proc-network', name: `Procure switches & optics (${sw.cost.leadTimeWeeks} wk lead)`, phase: 'procurement', durationDays: sw.cost.leadTimeWeeks * 7, dependsOn: sw.cost.leadTimeWeeks >= 26 ? [] : ['design'] });
  if (ca.cdus.units > 0) procure('proc-cdu', 'CDUs', ofCategory('cdu')[0]?.item ?? findCatalogItem(cd.cduCatalogId));
  if (ca.crahs.units > 0) procure('proc-crah', 'CRAHs', ofCategory('crah')[0]?.item ?? findCatalogItem(cd.crahCatalogId));
  if (ca.chillers.units > 0) procure('proc-chiller', 'chillers', findCatalogItem(cd.chillerCatalogId));
  if ((ca.dryCoolers?.units ?? 0) > 0) procure('proc-drycooler', 'dry coolers', findCatalogItem('drycooler-2000'));
  if (pw.ups.units > 0) procure('proc-ups', 'UPS systems', findCatalogItem(pd.upsCatalogId));
  if (pw.generators.units > 0) procure('proc-gen', 'generators', findCatalogItem(pd.generatorCatalogId));
  if (pw.transformers.units > 0) procure('proc-xfmr', 'transformers & switchgear', findCatalogItem(pd.transformerCatalogId));
  if (pw.rpps.units > 0) procure('proc-rpp', 'busway / RPP', findCatalogItem(pd.rppCatalogId));
  const bess = pd.powerSmoothing === 'bess' ? findCatalogItem('bess-2mw') : undefined;
  if (bess) procure('proc-bess', 'BESS', bess);

  // utility & central plant
  task({ id: 'hv-sub', name: 'Customer HV/MV substation construction', phase: 'power', durationDays: 150, dependsOn: ['permits'] });
  const feedTasks: string[] = [];
  for (const f of project.site.utility) {
    const id = `utility-${f.id}`;
    task({ id, name: `Utility energization — ${f.name}`, phase: 'power', durationDays: 1, dependsOn: ['hv-sub'], notBefore: f.availableFrom });
    feedTasks.push(id);
  }
  const xfmr = findCatalogItem(pd.transformerCatalogId);
  const mvlvHours = pw.transformers.units * ((xfmr?.cost.installHours ?? 120) + 80);
  task({ id: 'mvlv', name: 'MV/LV transformers & switchgear installation', phase: 'power', durationDays: crewDays(mvlvHours, 'electrical', 20), dependsOn: ['proc-xfmr', 'shell'], crew: 'electrical', qty: pw.transformers.units, laborHours: mvlvHours });
  const ups = findCatalogItem(pd.upsCatalogId);
  const upsHours = pw.ups.units * ((ups?.cost.installHours ?? 120) + 40);
  task({ id: 'ups', name: 'UPS & battery installation', phase: 'power', durationDays: crewDays(upsHours, 'electrical', 10), dependsOn: ['proc-ups', 'mvlv'], crew: 'electrical', qty: pw.ups.units, laborHours: upsHours });
  const gen = findCatalogItem(pd.generatorCatalogId);
  const genHours = pw.generators.units * (gen?.cost.installHours ?? 320);
  task({ id: 'gens', name: 'Generators, fuel system & paralleling gear', phase: 'power', durationDays: crewDays(genHours, 'electrical', 15), dependsOn: ['proc-gen', 'shell'], crew: 'electrical', qty: pw.generators.units, laborHours: genHours });
  if (bess) task({ id: 'bess', name: 'BESS installation', phase: 'power', durationDays: crewDays(200 * 4, 'electrical', 10), dependsOn: ['proc-bess', 'mvlv'], crew: 'electrical' });
  const plantMW = (ca.liquidHeatKW + ca.airHeatKW) / 1000;
  const plantHours = ca.chillers.units * 240 + (ca.dryCoolers?.units ?? 0) * 160 + plantMW * 300;
  task({ id: 'cooling-plant', name: 'Heat rejection plant & facility water piping', phase: 'cooling', durationDays: crewDays(plantHours, 'mechanical', 30), dependsOn: ['proc-chiller', 'proc-drycooler', 'shell'], crew: 'mechanical', laborHours: plantHours });
  task({ id: 'energize', name: 'Permanent power energization', phase: 'power', durationDays: cal(5), dependsOn: ['mvlv', 'ups', ...feedTasks], crew: 'electrical' });

  // per wave
  const runsByRack = new Map<string, number>();
  for (const run of r.network.analysis.cableRuns) runsByRack.set(run.fromId, (runsByRack.get(run.fromId) ?? 0) + run.count);
  const switchesByRack = new Map<string, number>();
  for (const rl of r.network.analysis.rackLoads ?? []) switchesByRack.set(rl.rackId, rl.switches.reduce((a, x) => a + x.count, 0));
  const rppPerPod = new Map((pw.rppPerPod ?? []).map((x) => [x.podId, x.runsPerPath * 2]));
  const rpp = findCatalogItem(pd.rppCatalogId);

  let prev: string | undefined;
  const handovers: { waveId: string; taskId: string; gpus: number; itKW: number }[] = [];
  for (const w of waves) {
    const items = inWave.get(w.id) ?? [];
    if (!items.length) continue;
    const dep = (base: string) => (prev ? [`${prev}-${base}`] : []);
    const mech = items.filter((p) => p.item.category === 'cdu' || p.item.category === 'crah' || p.item.category === 'fan-wall');
    const liquidRacks = items.filter((p) => (p.item.cooling?.liquidFraction ?? 0) > 0).length;
    const mechHours = mech.reduce((a, p) => a + p.item.cost.installHours, 0) + liquidRacks * 6;
    task({ id: `${w.id}-mech`, name: `${w.name}: CDU/CRAH setting & TCS piping`, phase: 'cooling', waveId: w.id, durationDays: crewDays(mechHours, 'mechanical', 10), dependsOn: ['shell', 'proc-cdu', 'proc-crah', ...dep('mech')], crew: 'mechanical', qty: mech.length, laborHours: mechHours });
    const pods = new Set(items.map((p) => p.e.podId).filter((x): x is string => !!x));
    const runs = [...pods].reduce((a, pod) => a + (rppPerPod.get(pod) ?? 0), 0);
    const busHours = runs * (rpp?.cost.installHours ?? 40);
    task({ id: `${w.id}-busway`, name: `${w.name}: busway / RPP installation`, phase: 'power', waveId: w.id, durationDays: crewDays(busHours, 'electrical', 5), dependsOn: ['shell', 'proc-rpp', 'mvlv', ...dep('busway')], crew: 'electrical', qty: runs, laborHours: busHours });
    const racks = items.filter((p) => IT_LOAD_CATEGORIES.has(p.item.category) || p.item.category === 'network-rack');
    const rackHours = racks.reduce((a, p) => a + p.item.cost.installHours, 0);
    task({ id: `${w.id}-rack`, name: `${w.name}: rack delivery, set & connect`, phase: 'it', waveId: w.id, durationDays: crewDays(rackHours, 'rackAndStack', 5), dependsOn: [`proc-it-${w.id}`, `${w.id}-busway`, `${w.id}-mech`, ...dep('rack')], crew: 'rackAndStack', qty: racks.length, laborHours: rackHours });
    const cables = items.reduce((a, p) => a + (runsByRack.get(p.e.id) ?? 0), 0);
    const switches = items.reduce((a, p) => a + (switchesByRack.get(p.e.id) ?? 0), 0);
    const cableHours = cables * 0.4 + switches * (sw?.cost.installHours ?? 4);
    task({ id: `${w.id}-cabling`, name: `${w.name}: switches & structured cabling`, phase: 'network', waveId: w.id, durationDays: crewDays(cableHours, 'cabling', 5), dependsOn: ['proc-network', `${w.id}-rack`, ...dep('cabling')], crew: 'cabling', qty: cables, laborHours: cableHours });
    task({ id: `${w.id}-cx-l3`, name: `${w.name}: L1–L3 commissioning (FAT, install verification, start-up)`, phase: 'commissioning', waveId: w.id, durationDays: cal(10), dependsOn: [`${w.id}-rack`, 'energize', ...dep('cx-l3')], crew: 'commissioning' });
    task({ id: `${w.id}-cx-l4`, name: `${w.name}: L4 functional performance tests`, phase: 'commissioning', waveId: w.id, durationDays: cal(10), dependsOn: [`${w.id}-cx-l3`, 'cooling-plant', 'gens', ...(bess ? ['bess'] : []), ...dep('cx-l4')], crew: 'commissioning' });
    task({ id: `${w.id}-cx-l5`, name: `${w.name}: L5 integrated systems test & cluster burn-in`, phase: 'commissioning', waveId: w.id, durationDays: cal(20), dependsOn: [`${w.id}-cx-l4`, `${w.id}-cabling`, ...dep('cx-l5')], crew: 'commissioning' });
    task({ id: `${w.id}-handover`, name: `${w.name}: handover / ready for service`, phase: 'handover', waveId: w.id, durationDays: 1, dependsOn: [`${w.id}-cx-l5`] });
    handovers.push({
      waveId: w.id,
      taskId: `${w.id}-handover`,
      gpus: items.reduce((a, p) => a + (p.item.category === 'gpu-rack' ? p.item.compute?.gpus ?? 0 : 0), 0),
      itKW: items.reduce((a, p) => a + (IT_LOAD_CATEGORIES.has(p.item.category) ? p.item.power?.nameplateKW ?? 0 : 0), 0),
    });
    prev = w.id;
  }
  void itItems;

  // CPM
  const start = s.projectStart;
  const byId = new Map(drafts.map((d) => [d.id, d]));
  const es = new Map<string, number>();
  const ef = new Map<string, number>();
  const visit = (id: string): number => {
    const known = ef.get(id);
    if (known !== undefined) return known;
    const d = byId.get(id)!;
    let t = 0;
    for (const dep of d.dependsOn) t = Math.max(t, visit(dep));
    if (d.notBefore) t = Math.max(t, Math.round((parseISO(d.notBefore) - parseISO(start)) / 86_400_000));
    es.set(id, t);
    ef.set(id, t + d.durationDays);
    return t + d.durationDays;
  };
  drafts.forEach((d) => visit(d.id));
  const finish = Math.max(0, ...ef.values());
  const successors = new Map<string, string[]>();
  for (const d of drafts) for (const dep of d.dependsOn) successors.set(dep, [...(successors.get(dep) ?? []), d.id]);
  const ls = new Map<string, number>();
  const lateStart = (id: string): number => {
    const known = ls.get(id);
    if (known !== undefined) return known;
    const d = byId.get(id)!;
    const succ = successors.get(id) ?? [];
    const lf = succ.length ? Math.min(...succ.map(lateStart)) : finish;
    const v = lf - d.durationDays;
    ls.set(id, v);
    return v;
  };

  const tasks: ScheduleTask[] = drafts.map((d) => {
    const slack = lateStart(d.id) - es.get(d.id)!;
    return {
      id: d.id,
      name: d.name,
      phase: d.phase,
      waveId: d.waveId,
      start: addDays(start, es.get(d.id)!),
      end: addDays(start, ef.get(d.id)!),
      durationDays: d.durationDays,
      dependsOn: d.dependsOn,
      critical: slack <= 0,
      crew: d.crew,
      qty: d.qty,
      laborHours: d.laborHours,
      slackDays: slack,
    };
  });
  const endOf = (id: string) => tasks.find((t) => t.id === id)?.end;

  const milestones: ScheduleAnalysis['milestones'] = [{ id: 'ntp', name: 'Notice to proceed', date: start }];
  if (endOf('design')) milestones.push({ id: 'ifc', name: 'Design IFC complete', date: endOf('design')! });
  for (const f of project.site.utility) {
    const e = endOf(`utility-${f.id}`);
    if (e) milestones.push({ id: `ms-utility-${f.id}`, name: `${f.name} energized`, date: e });
  }
  if (endOf('energize')) milestones.push({ id: 'ms-power', name: 'Permanent power available', date: endOf('energize')! });
  const ramp: ScheduleAnalysis['capacityRamp'] = [{ date: start, gpus: 0, itKW: 0 }];
  let gpus = 0;
  let itKW = 0;
  handovers
    .map((h) => ({ ...h, date: endOf(h.taskId)! }))
    .sort((a, b) => a.date.localeCompare(b.date))
    .forEach((h) => {
      gpus += h.gpus;
      itKW += h.itKW;
      const wave = waves.find((w) => w.id === h.waveId)!;
      milestones.push({ id: `ms-rfs-${h.waveId}`, name: `${wave.name} ready for service`, date: h.date });
      ramp.push({ date: h.date, gpus, itKW });
    });
  const readyForServiceDate = addDays(start, finish);
  milestones.push({ id: 'ms-rfs', name: 'Final ready for service', date: readyForServiceDate });

  return {
    tasks,
    milestones,
    readyForServiceDate,
    capacityRamp: ramp,
    totalLaborHours: tasks.reduce((a, t) => a + (t.laborHours ?? 0), 0),
  };
}
