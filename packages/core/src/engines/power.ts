import { findCatalogItem } from '../catalog/catalog.ts';
import type { OneLineNode, PowerAnalysis } from '../model/types.ts';
import { type Ctx, IT_LOAD_CATEGORIES, unitsFor } from './context.ts';
import type { CoolingResult } from './cooling.ts';
import { buildPowerPlane, resolveBusways, sizeElectricalRooms, sizeUpsBlocks } from './powerPaths.ts';
import { upsBlocks } from '../layout/estimates.ts';
import type { NetworkResult } from './network.ts';

/**
 * Electrical load build-up and infrastructure sizing.
 *
 *  IT nameplate = Σ rack nameplate + switches + switch-side optics;  IT design = racks × diversity + network.
 *  Mechanical at design scales with IT design / IT nameplate (loads track heat).
 *  Losses: UPS double conversion η = 97 % on the critical load (IT + UPS-backed mechanical),
 *    transformers 1.5 % of facility load (MV + LV stages), LV distribution 1 % of IT,
 *    electrical-room cooling = 30 % of UPS + transformer losses, ancillary (lighting/BMS/security) 0.6 % IT + 50 kW/hall.
 *  Utility: required MVA = design facility kW / 0.95 site PF.
 *    Firm capacity rule: feeds grouped by substation; with ≥ 2 independent substations firm = total − largest
 *    substation group (N−1); with a single substation firm = total but flagged as a single point of failure.
 *  UPS kVA = critical kW / IT PF;  generators back the whole facility (derate 0.95);  transformers = facility kVA.
 *  Busway/RPP (polish v2 2차, QA m1 — one circuit model with the power plane): the counts are the plane's busway circuits, per row
 *    side, contiguous rack groups within the profile continuous limit (IEC 1.0 / NEC 0.8 or 1.0 for 100 %-rated assemblies;
 *    engines/powerPaths.ts continuousLimitRule), rating √3·V·I·PF; either side carries 100 % of its row. Racks without a row busway
 *    fall back to ⌈pod kW ÷ limit⌉ with the same rating and limit. maxLoading = worst circuit sizing kW ÷ rating.
 *  UPS block-redundant / DR: blocks and modules from engines/powerPaths.ts sizeUpsBlocks (worst single busway circuit / row-side
 *    failure, r2-platform.md §1.3); electrical rooms sized from those modules (sizeElectricalRooms).
 */

const UPS_EFF = 0.97;
const SITE_PF = 0.95;

export function analyzePowerCtx(ctx: Ctx, net: NetworkResult, cool: CoolingResult): PowerAnalysis {
  const { project } = ctx;
  const pd = project.power;

  let rackNameplate = 0;
  let rackPeak = 0;
  for (const p of ctx.placed) {
    if (!IT_LOAD_CATEGORIES.has(p.item.category)) continue;
    rackNameplate += p.item.power?.nameplateKW ?? 0;
    rackPeak += p.item.power?.peakKW ?? p.item.power?.nameplateKW ?? 0;
  }
  const networkKW = net.switchKW + net.analysis.transceiverKW;
  const itNameplateKW = rackNameplate + networkKW;
  const itDesignKW = rackNameplate * pd.diversityFactor + networkKW;
  const itPeakKW = rackPeak + networkKW;
  const loadRatio = itNameplateKW > 0 ? itDesignKW / itNameplateKW : 1;

  const mechBase = cool.mechDesignKW * loadRatio;
  const mechAnnualBase = cool.mechAnnualKW * loadRatio;
  const criticalMech = pd.mechanicalOnUps ? cool.criticalMechKW * loadRatio : 0;

  const criticalKW = itDesignKW + criticalMech;
  const upsLoss = criticalKW * (1 / UPS_EFF - 1);
  const distLoss = itDesignKW * 0.01;
  const ancillaryKW = itDesignKW * 0.006 + 50 * project.halls.length;
  const preXfmr = itDesignKW + mechBase + upsLoss + distLoss + ancillaryKW;
  const xfmrLoss = preXfmr * 0.015;
  const elecRoomCooling = (upsLoss + xfmrLoss) * 0.3;
  const mechanicalKW = mechBase + elecRoomCooling;
  const lossesKW = upsLoss + distLoss + xfmrLoss + ancillaryKW;
  const facilityKW = itDesignKW + mechanicalKW + lossesKW;
  const avgFacilityKW = itDesignKW + mechAnnualBase + elecRoomCooling + lossesKW;

  const perHall = project.halls.map((h) => {
    const items = ctx.byHall.get(h.id) ?? [];
    const racks = items.reduce((s, p) => s + (IT_LOAD_CATEGORIES.has(p.item.category) ? p.item.power?.nameplateKW ?? 0 : 0), 0);
    const sw = (net.analysis.rackLoads ?? []).filter((r) => items.some((p) => p.e.id === r.rackId)).reduce((s, r) => s + r.kw, 0);
    const itKW = racks * pd.diversityFactor + sw + (net.switchKW > 0 ? (net.analysis.transceiverKW * sw) / net.switchKW : 0);
    return { hallId: h.id, itKW, budgetKW: h.itPowerBudgetKW, utilization: h.itPowerBudgetKW > 0 ? itKW / h.itPowerBudgetKW : itKW > 0 ? Infinity : 0 };
  });

  // utility
  const feeds = project.site.utility;
  const bySubstation = new Map<string, number>();
  for (const f of feeds) bySubstation.set(f.substation, (bySubstation.get(f.substation) ?? 0) + f.capacityMVA);
  const utilityTotalMVA = feeds.reduce((s, f) => s + f.capacityMVA, 0);
  const utilityAvailableMVA = bySubstation.size >= 2 ? utilityTotalMVA - Math.max(...bySubstation.values()) : utilityTotalMVA;
  const utilityRequiredMVA = facilityKW / SITE_PF / 1000;

  const ups = findCatalogItem(pd.upsCatalogId);
  const gen = findCatalogItem(pd.generatorCatalogId);
  const xfmr = findCatalogItem(pd.transformerCatalogId);
  const rpp = findCatalogItem(pd.rppCatalogId);

  // the power plane (circuits per row side) shared with analyzeProject's paths, the scenario evaluator and the 3D overlay
  const plane = buildPowerPlane(project, { network: net.analysis });

  const upsUnitKVA = ups?.capacity?.powerKVA ?? 1000;
  const upsRequiredKVA = criticalKW / pd.powerFactor;
  let upsUnits = unitsFor(upsRequiredKVA, upsUnitKVA, pd.upsRedundancy);
  const blockRedundant = pd.upsRedundancy === 'block-redundant' || pd.upsRedundancy === 'DR';
  const upsSizing = blockRedundant && upsUnits.n > 0
    ? sizeUpsBlocks(plane, { baseModules: upsUnits.n, moduleKVA: upsUnitKVA, powerFactor: pd.powerFactor, diversity: pd.diversityFactor, critMechKW: criticalMech, override: pd.upsBlocks })
    : undefined;
  if (upsSizing) upsUnits = { n: upsUnits.n, units: upsSizing.modules };
  const genUnitKW = gen?.capacity?.powerKW ?? 2500;
  const genRequiredKW = facilityKW / 0.95;
  const genUnits = unitsFor(genRequiredKW, genUnitKW, pd.generatorRedundancy);
  const xfmrUnitKVA = xfmr?.capacity?.powerKVA ?? 3000;
  const xfmrRequiredKVA = facilityKW / SITE_PF;
  const xfmrUnits = unitsFor(xfmrRequiredKVA, xfmrUnitKVA, pd.transformerRedundancy);

  // busway / RPP circuits per pod, counted from the plane (see header)
  const rule = plane.rule;
  const catalogRatedKW = (Math.sqrt(3) * pd.distributionVoltageV * (rpp?.capacity?.currentA ?? 800) * pd.powerFactor) / 1000;
  const rppRatedKW = plane.circuits.length ? Math.max(...plane.circuits.map((c) => c.ratedKW)) : catalogRatedKW;
  const switchKWByRack = new Map((net.analysis.rackLoads ?? []).map((r) => [r.rackId, r.kw]));
  const planeKW = new Map(plane.racks.map((r) => [r.id, r.kw]));
  const podOfRack = new Map<string, string>();
  for (const [pod, items] of ctx.byPod) for (const p of items) podOfRack.set(p.e.id, pod);
  const circuitsByPod = new Map<string, { A: number; B: number; worst: number }>();
  for (const c of plane.circuits) {
    const pod = podOfRack.get(c.rackIds[0] ?? '');
    if (pod === undefined) continue;
    const e = circuitsByPod.get(pod) ?? { A: 0, B: 0, worst: 0 };
    e[c.side] += 1;
    e.worst = Math.max(e.worst, c.rackIds.reduce((s, id) => s + (planeKW.get(id) ?? 0), 0) / c.ratedKW);
    circuitsByPod.set(pod, e);
  }
  const fed = new Set(plane.racks.filter((r) => r.circuits.A || r.circuits.B).map((r) => r.id));
  const rppPerPod: NonNullable<PowerAnalysis['rppPerPod']> = [];
  for (const [pod, items] of ctx.byPod) {
    const rackKWOf = (p: (typeof items)[number]) => (IT_LOAD_CATEGORIES.has(p.item.category) ? p.item.power?.nameplateKW ?? 0 : 0) + (switchKWByRack.get(p.e.id) ?? 0);
    const kw = items.reduce((s, p) => s + rackKWOf(p), 0);
    if (kw <= 0) continue;
    const onPlane = circuitsByPod.get(pod);
    const unfedKW = items.filter((p) => !fed.has(p.e.id)).reduce((s, p) => s + rackKWOf(p), 0);
    const fallbackRuns = unfedKW > 1e-9 ? Math.ceil(unfedKW / (catalogRatedKW * rule.continuousLimit) - 1e-9) : 0;
    const runs = Math.max(onPlane?.A ?? 0, onPlane?.B ?? 0) + fallbackRuns;
    if (runs <= 0) continue;
    const loading = Math.max(onPlane?.worst ?? 0, fallbackRuns ? unfedKW / (fallbackRuns * catalogRatedKW) : 0);
    rppPerPod.push({ podId: pod, kwPerPath: kw, runsPerPath: runs, loading });
  }
  const rppUnits = rppPerPod.reduce((s, r) => s + r.runsPerPath * 2, 0);

  // one-line diagram
  const nodes: OneLineNode[] = [];
  const edges: { from: string; to: string }[] = [];
  const twoPath = feeds.length >= 2 || ['2N', '2N+1'].includes(pd.transformerRedundancy);
  const paths: ('A' | 'B')[] = twoPath ? ['A', 'B'] : ['A'];
  feeds.forEach((f, i) => {
    nodes.push({ id: `util-${f.id}`, kind: 'utility', label: `${f.name} · ${f.capacityMVA} MVA (${f.substation})`, ratingKVA: f.capacityMVA * 1000, path: paths[i % paths.length] });
  });
  const xfmrSplit = paths.length === 2 ? [Math.ceil(xfmrUnits.units / 2), Math.floor(xfmrUnits.units / 2)] : [xfmrUnits.units];
  paths.forEach((p, i) => {
    nodes.push({ id: `xfmr-${p}`, kind: 'transformer', label: `Transformers ${p} · ${xfmrSplit[i]} × ${xfmrUnitKVA.toLocaleString('en-US')} kVA`, ratingKVA: xfmrSplit[i] * xfmrUnitKVA, path: p });
    nodes.push({ id: `swgr-${p}`, kind: 'switchgear', label: `LV Switchgear ${p}`, path: p });
    edges.push({ from: `xfmr-${p}`, to: `swgr-${p}` });
    edges.push({ from: 'gen', to: `swgr-${p}` });
  });
  feeds.forEach((f, i) => edges.push({ from: `util-${f.id}`, to: `xfmr-${paths[i % paths.length]}` }));
  if (feeds.length === 1 && paths.length === 2) edges.push({ from: `util-${feeds[0].id}`, to: 'xfmr-B' });
  nodes.push({ id: 'gen', kind: 'generator', label: `Generators · ${genUnits.units} × ${genUnitKW.toLocaleString('en-US')} kW (${pd.generatorRedundancy})`, ratingKVA: genUnits.units * (gen?.capacity?.powerKVA ?? genUnitKW / 0.8) });

  // UPS systems: 2N → A/B; block-redundant / DR → K equal active blocks + a catcher of the same size (engines/powerPaths.ts pairs each
  // rack's A and B cords on different blocks); N / N+1 → one system on path A
  const upsIds: string[] = [];
  const busFeeds: Record<'A' | 'B', string[]> = { A: [], B: [] };
  const addUps = (id: string, label: string, modules: number, path?: 'A' | 'B' | 'C') => {
    nodes.push({ id, kind: 'ups', label, ratingKVA: modules * upsUnitKVA, ...(path ? { path } : {}) });
    const bid = id.replace(/^ups-/, 'batt-');
    nodes.push({ id: bid, kind: 'battery', label: `Battery ${pd.batteryMinutes} min`, ...(path ? { path } : {}) });
    edges.push({ from: bid, to: id });
    upsIds.push(id);
  };
  if (pd.upsRedundancy === '2N' || pd.upsRedundancy === '2N+1') {
    const split = [Math.ceil(upsUnits.units / 2), Math.floor(upsUnits.units / 2)];
    (['A', 'B'] as const).forEach((p, i) => {
      addUps(`ups-${p}`, `UPS ${p} · ${split[i]} × ${upsUnitKVA} kVA (${pd.upsRedundancy})`, split[i], p);
      edges.push({ from: `swgr-${paths.includes(p) ? p : 'A'}`, to: `ups-${p}` });
      busFeeds[p].push(`ups-${p}`);
    });
  } else if (pd.upsRedundancy === 'block-redundant' || pd.upsRedundancy === 'DR') {
    const { blockModules, activeBlocks } = upsSizing ?? upsBlocks(upsUnits.n);
    for (let k = 1; k <= activeBlocks; k++) {
      const id = `ups-${k}`;
      addUps(id, `UPS block ${k} · ${blockModules} × ${upsUnitKVA} kVA (${pd.upsRedundancy})`, blockModules);
      edges.push({ from: `swgr-${paths[(k - 1) % paths.length]}`, to: id });
      busFeeds.A.push(id);
      busFeeds.B.push(id);
    }
    addUps('ups-C', `Catcher UPS block · ${blockModules} × ${upsUnitKVA} kVA`, blockModules, 'C');
    paths.forEach((sp) => edges.push({ from: `swgr-${sp}`, to: 'ups-C' }));
    busFeeds.A.push('ups-C');
    busFeeds.B.push('ups-C');
  } else {
    addUps('ups-A', `UPS A · ${upsUnits.units} × ${upsUnitKVA} kVA (${pd.upsRedundancy})`, upsUnits.units, 'A');
    edges.push({ from: 'swgr-A', to: 'ups-A' });
    busFeeds.A.push('ups-A');
  }
  const busLabel = pd.distribution === 'rpp' ? 'RPP' : 'Busway';
  // v2 2차 (T3): one-line ↔ 3D linking — busway nodes reference the physical row-side busways, load nodes their racks
  const buswaysBySide = { A: [] as string[], B: [] as string[] };
  for (const b of resolveBusways(project)) buswaysBySide[b.path].push(b.id);
  (['A', 'B'] as const).forEach((p) => {
    nodes.push({ id: `bus-${p}`, kind: pd.distribution === 'rpp' ? 'rpp' : 'busway', label: `${busLabel} ${p} · ${rppUnits / 2} circuits × ${Math.round(rppRatedKW / pd.powerFactor)} kVA (${rule.profile.toUpperCase()} limit ${Math.round(rule.continuousLimit * 100)} %)`, path: p, ...(buswaysBySide[p].length ? { refs: buswaysBySide[p] } : {}) });
    if (busFeeds[p].length) for (const u of busFeeds[p]) edges.push({ from: u, to: `bus-${p}` });
    else edges.push({ from: `swgr-${paths.includes(p) ? p : 'A'}`, to: `bus-${p}` });
  });
  for (const r of rppPerPod) {
    const first = ctx.byPod.get(r.podId)?.find((p) => IT_LOAD_CATEGORIES.has(p.item.category));
    const name = first?.e.tag.split('-')[0] ?? r.podId;
    const podRacks = (ctx.byPod.get(r.podId) ?? []).filter((p) => IT_LOAD_CATEGORIES.has(p.item.category) || p.item.category === 'network-rack').map((p) => p.e.id);
    nodes.push({ id: `load-${r.podId}`, kind: 'load', label: `${name} · ${Math.round(r.kwPerPath).toLocaleString('en-US')} kW`, loadKW: r.kwPerPath, ...(podRacks.length ? { refs: podRacks } : {}) });
    edges.push({ from: 'bus-A', to: `load-${r.podId}` }, { from: 'bus-B', to: `load-${r.podId}` });
  }
  if (pd.mechanicalOnUps && criticalMech > 0) {
    nodes.push({ id: 'mech-ups', kind: 'mech', label: `CDU pumps & CRAH fans (UPS) · ${Math.round(criticalMech)} kW`, loadKW: criticalMech });
    edges.push({ from: upsIds[0], to: 'mech-ups' });
  }
  nodes.push({ id: 'mech', kind: 'mech', label: `Heat rejection plant · ${Math.round(mechanicalKW - criticalMech)} kW`, loadKW: mechanicalKW - criticalMech });
  paths.forEach((p) => edges.push({ from: `swgr-${p}`, to: 'mech' }));

  // electrical rooms: UPS modules per switchgear side (2N → A / B; blocks alternate A / B, the catcher sits with side B; N-type → A)
  const modulesBySide = { A: 0, B: 0 };
  if (pd.upsRedundancy === '2N' || pd.upsRedundancy === '2N+1') {
    modulesBySide.A = Math.ceil(upsUnits.units / 2);
    modulesBySide.B = Math.floor(upsUnits.units / 2);
  } else if (blockRedundant) {
    const { blockModules, activeBlocks } = upsSizing ?? upsBlocks(upsUnits.n);
    modulesBySide.A = blockModules * Math.ceil(activeBlocks / 2);
    modulesBySide.B = blockModules * (Math.floor(activeBlocks / 2) + 1);
  } else modulesBySide.A = upsUnits.units;
  const itSum = perHall.reduce((s, h) => s + h.itKW, 0);
  const rooms = plane.rooms.length
    ? sizeElectricalRooms(project, plane, {
      upsModulesBySide: modulesBySide, moduleKVA: upsUnitKVA, powerFactor: pd.powerFactor, batteryMinutes: pd.batteryMinutes, upsItem: ups,
      hallShare: new Map(perHall.map((h) => [h.hallId, itSum > 0 ? h.itKW / itSum : 1 / Math.max(1, perHall.length)])),
    })
    : [];

  return {
    itNameplateKW,
    itDesignKW,
    itPeakKW,
    networkKW,
    mechanicalKW,
    lossesKW,
    facilityKW,
    pue: itDesignKW > 0 ? avgFacilityKW / itDesignKW : 0,
    perHall,
    utilityRequiredMVA,
    utilityAvailableMVA,
    ups: { units: upsUnits.units, unitKVA: upsUnitKVA, installedKVA: upsUnits.units * upsUnitKVA, requiredKVA: upsRequiredKVA },
    generators: { units: genUnits.units, unitKW: genUnitKW, installedKW: genUnits.units * genUnitKW, requiredKW: genRequiredKW },
    transformers: { units: xfmrUnits.units, unitKVA: xfmrUnitKVA, installedKVA: xfmrUnits.units * xfmrUnitKVA, requiredKVA: xfmrRequiredKVA },
    rpps: { units: rppUnits, unitKW: rppRatedKW, maxLoading: rppPerPod.reduce((m, r) => Math.max(m, r.loading), 0), limitFactor: rule.continuousLimit },
    oneLine: { nodes, edges },
    designPue: itDesignKW > 0 ? facilityKW / itDesignKW : 0,
    avgFacilityKW,
    utilityTotalMVA,
    ancillaryKW,
    rppPerPod,
    ...(upsSizing ? { upsSizing } : {}),
    ...(rooms.length ? { rooms } : {}),
    // finish v2 2차 (D1 / D5): feeder sleeves (one per room) + partition sleeves, from the routed feeders of the plane
    ...(plane.penetrations.length ? { penetrations: plane.penetrations } : {}),
  };
}
