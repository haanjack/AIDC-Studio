// Regression tests for the v2 2차 QA fix round (docs/research/fix-v2-2.md). One `describe` per finding group.
import { describe, expect, it } from 'vitest';
import {
  analyzeMaxQ, analyzeProject, applyHallLayout, BENCHMARKS, buildCableSchedule, buildIpPlan, buildPowerPlane, buildSwitchUnits, calibrateFromBenchmark,
  chooseLayoutGrid, createNvidiaReferenceProject, defaultWaveStart, evaluatePowerScenario, FABRIC_SWITCH, findCatalogItem, generateHallLayout, growHallToFit,
  layoutOptionsFromProject, networkReachRunM, nextPodIndex, placeRackComponents, rackComponentsFor, redundantCount, summarizeCableSchedule, upsBlocks,
  type CableScheduleRow, type Project, type WorkloadBlueprint,
} from '../src/index.ts';

const ref = () => structuredClone(createNvidiaReferenceProject().project);
const dev = (p: string) => p.slice(0, p.lastIndexOf(':'));

function variant(rackId: string, fabric: keyof typeof FABRIC_SWITCH): Project {
  const p = ref();
  const old = p.equipment.find((e) => findCatalogItem(e.catalogId)?.category === 'gpu-rack')!.catalogId;
  for (const e of p.equipment) if (e.catalogId === old) e.catalogId = rackId;
  p.network.scaleOut = { ...p.network.scaleOut, fabric, switchCatalogId: FABRIC_SWITCH[fabric] };
  return p;
}

/** lower switch → (upper switch → cable count) for one tier / fabric key */
function spread(rows: CableScheduleRow[], tier: string, key: string) {
  const m = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (r.tier !== tier || r.fabricKey !== key) continue;
    const lo = dev(r.fromPort);
    const hi = dev(r.toPort);
    const x = m.get(lo) ?? new Map<string, number>();
    m.set(lo, x);
    x.set(hi, (x.get(hi) ?? 0) + 1);
  }
  return m;
}

function components(rows: CableScheduleRow[], key: string): number {
  const g = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!g.has(a)) g.set(a, new Set());
    if (!g.has(b)) g.set(b, new Set());
    g.get(a)!.add(b);
    g.get(b)!.add(a);
  };
  for (const r of rows) if (r.fabricKey === key && r.tier !== 'endpoint-leaf' && r.tier !== 'uplink') link(dev(r.fromPort), dev(r.toPort));
  const seen = new Set<string>();
  let n = 0;
  for (const s of g.keys()) {
    if (seen.has(s)) continue;
    n++;
    const st = [s];
    seen.add(s);
    while (st.length) for (const y of g.get(st.pop()!)!) if (!seen.has(y)) { seen.add(y); st.push(y); }
  }
  return n;
}

describe('cable schedule — Clos striping, rails, port ranges, OOB (QA B1–B3, OOB, mgmt)', () => {
  const p = ref();
  const a = analyzeProject(p);
  const rows = buildCableSchedule(p, a);
  const units = buildSwitchUnits(p, a);

  it('every leaf reaches min(spines, uplinks) distinct spines with at most ⌈u/S⌉ links per pair; the switch graph is connected', () => {
    const m = spread(rows, 'leaf-spine', 'scale-out');
    const spines = new Set([...m.values()].flatMap((x) => [...x.keys()])).size;
    for (const [lo, x] of m) {
      const u = [...x.values()].reduce((s, v) => s + v, 0);
      expect(x.size, lo).toBe(Math.min(spines, u));
      expect(Math.max(...x.values()), lo).toBeLessThanOrEqual(Math.ceil(u / spines));
    }
    expect(components(rows, 'scale-out')).toBe(1);
    expect(components(rows, 'frontend')).toBe(1);
  });

  it('rail-optimized: one NIC index per leaf, and each node lands its NICs on distinct leaves', () => {
    const railsByLeaf = new Map<string, Set<string>>();
    const leafByNodeNic = new Map<string, Map<string, string>>();
    for (const r of rows) {
      if (r.tier !== 'endpoint-leaf' || r.fabricKey !== 'scale-out') continue;
      const nic = /:be(\d+)/.exec(r.fromPort)![1];
      const leaf = dev(r.toPort);
      railsByLeaf.set(leaf, (railsByLeaf.get(leaf) ?? new Set()).add(nic));
      const node = dev(r.fromPort);
      const nm = leafByNodeNic.get(node) ?? new Map<string, string>();
      nm.set(nic, leaf);
      leafByNodeNic.set(node, nm);
    }
    for (const [leaf, s] of railsByLeaf) expect(s.size, leaf).toBe(1);
    for (const [node, nm] of leafByNodeNic) expect(new Set(nm.values()).size, node).toBe(nm.size);
  });

  it('HGX H200 on NDR: host links are capped at leaf downlinks — no end outside its range, no duplicate end, rails aligned', () => {
    const q = variant('hgx-h200-air-4x', 'ib-ndr-400');
    const aq = analyzeProject(q);
    const rq = buildCableSchedule(q, aq);
    const s = summarizeCableSchedule(rq, buildSwitchUnits(q, aq));
    expect(s.overflowPorts).toBe(0);
    expect(s.unresolvedEnds).toBe(0);
    expect(rq.length).toBe(aq.network.cableRuns.reduce((x, r) => x + r.count, 0));
    const railsByLeaf = new Map<string, Set<string>>();
    for (const r of rq) if (r.tier === 'endpoint-leaf' && r.fabricKey === 'scale-out') railsByLeaf.set(dev(r.toPort), (railsByLeaf.get(dev(r.toPort)) ?? new Set()).add(/:be(\d+)/.exec(r.fromPort)![1]));
    for (const s2 of railsByLeaf.values()) expect(s2.size).toBe(1);
  });

  it('summary counts range violations and duplicate ends as overflow', () => {
    const bad = rows.slice(0, 2).map((r) => ({ ...r }));
    const leafSpine = rows.find((r) => r.tier === 'leaf-spine')!;
    bad[0] = { ...leafSpine, toPort: leafSpine.toPort };
    bad[1] = { ...leafSpine, cableId: 'X', toPort: leafSpine.toPort };
    expect(summarizeCableSchedule(bad, units).overflowPorts).toBeGreaterThan(0);
  });

  it('OOB: every OOB leaf has an uplink, no UP index beyond its 4 uplink ports; every switch has exactly one mgmt0 row and one OOB IP', () => {
    const oobLeaves = units.filter((u) => u.fabricKey === 'oob' && u.role === 'leaf');
    const up = new Map<string, number>();
    for (const r of rows) if (r.tier === 'uplink') up.set(dev(r.fromPort), (up.get(dev(r.fromPort)) ?? 0) + 1);
    for (const u of oobLeaves) expect(up.get(`H1.${u.rackTag}-U${u.u}`), u.id).toBeGreaterThan(0);
    for (const r of rows) {
      const m = /:UP(\d+)/.exec(r.fromPort);
      if (m) expect(Number(m[1])).toBeLessThanOrEqual(4);
    }
    const mgmt = rows.filter((r) => /:mgmt0$/.test(r.fromPort)).map((r) => r.fromPort);
    expect(new Set(mgmt).size).toBe(mgmt.length);
    expect(mgmt.length).toBe(units.length);
    const plan = buildIpPlan(p, a);
    for (const port of mgmt) expect(plan.oob.some((o) => o.deviceId === port), port).toBe(true);
  });
});

describe('IP plan and inter-hall trunks (QA M3, M4)', () => {
  function joinedPair(): Project {
    const d = ref();
    d.network.scaleOut = { ...d.network.scaleOut, fabric: 'spectrumx-800', switchCatalogId: FABRIC_SWITCH['spectrumx-800'] };
    const hall = d.halls.find((h) => h.id === 'hall-b')!;
    d.clusters = [{ id: 'c-ab', name: 'A+B', hallIds: ['hall-a', 'hall-b'] }];
    const o = layoutOptionsFromProject(d, hall, { pods: 4, podIndexStart: nextPodIndex(d, 'hall-b'), services: { spineRacks: 'auto', storageRacks: 0, cpuRacks: 0, mgmtRacks: 0 } });
    applyHallLayout(d, 'hall-b', growHallToFit(hall, o), o);
    const ha = d.halls.find((h) => h.id === 'hall-a')!;
    const oa = layoutOptionsFromProject(d, ha, { pods: 4, podIndexStart: nextPodIndex(d, 'hall-a'), services: { spineRacks: 'auto', storageRacks: 8, cpuRacks: 4, mgmtRacks: 2 } });
    applyHallLayout(d, 'hall-a', growHallToFit(ha, oa), oa);
    return d;
  }

  it('numbered fabric: every /31 is unique (mixed breakout lanes on FE spines)', () => {
    const d = joinedPair();
    const a = analyzeProject(d);
    const cidrs = buildIpPlan(d, a, { numberedFabric: true }).p2p.map((l) => l.cidr!).filter(Boolean);
    expect(cidrs.length).toBeGreaterThan(0);
    expect(new Set(cidrs).size).toBe(cidrs.length);
  }, 120_000);

  it('a trunk between two racks of the zone hall uses the in-hall tray route', () => {
    const d = joinedPair();
    const a = analyzeProject(d);
    const hallOf = new Map(d.equipment.map((e) => [e.id, e.hallId]));
    const zone = a.network.cableRuns.filter((r) => r.tier === 'inter-hall' && hallOf.get(r.fromId) === hallOf.get(r.toId));
    const cross = a.network.cableRuns.filter((r) => r.tier === 'inter-hall' && hallOf.get(r.fromId) !== hallOf.get(r.toId));
    if (!zone.length || !cross.length) return; // no zone-hall trunks in this geometry
    const meanZone = zone.reduce((s, r) => s + r.lengthM * r.count, 0) / zone.reduce((s, r) => s + r.count, 0);
    const ih = a.network.clusters?.find((c) => c.interHall)?.interHall;
    expect(meanZone).toBeLessThan(60);
    // mean / max trunk describe cross-hall trunks only
    expect(ih!.maxTrunkM).toBe(Math.max(...cross.map((r) => r.lengthM)));
  }, 120_000);
});

describe('workload calibration (QA B, T6)', () => {
  const { project } = createNvidiaReferenceProject();
  const rack = findCatalogItem(project.equipment.find((e) => findCatalogItem(e.catalogId)?.category === 'gpu-rack')!.catalogId)!;

  it('every training benchmark row back-solves within 1 % of its published TFLOP/s per GPU', () => {
    for (const b of BENCHMARKS) {
      if (!b.derived?.tflopsPerGpu || /inference/i.test(b.suite)) continue;
      const moe = /moe|deepseek|grok/i.test(`${b.task} ${b.model}`);
      const w: WorkloadBlueprint = structuredClone(project.workloads[0]);
      if (moe) w.model = { ...w.model, moe: { experts: 256, topK: 8 } } as WorkloadBlueprint['model'];
      const r = calibrateFromBenchmark(w, b, rack);
      expect(r.tflopsPerGpu, b.id).toBeDefined();
      expect(Math.abs(r.tflopsPerGpu! / 1e12 / b.derived.tflopsPerGpu - 1), b.id).toBeLessThan(0.01);
    }
  });

  it('Llama 3 paper row: 430 TFLOP/s, MFU ≈ 43 % on the H100 BF16 peak', () => {
    const b = BENCHMARKS.find((x) => x.id === 'paper-llama3-405b-h100-8192')!;
    const r = calibrateFromBenchmark(structuredClone(project.workloads[0]), b, rack);
    expect(r.tflopsPerGpu! / 1e12).toBeCloseTo(430, 6);
    expect(r.mfu!).toBeGreaterThan(0.35);
    expect(r.mfu!).toBeLessThan(0.5);
  });
});

describe('power — UPS blocks, NEC circuits, load factor, Max-Q (QA power findings)', () => {
  it('block-redundant count = K·s + s with s = ⌈n/4⌉ and K = ⌈n/s⌉', () => {
    for (const n of [1, 3, 5, 12, 13]) {
      const b = upsBlocks(n);
      expect(b.activeBlocks * b.blockModules).toBeGreaterThanOrEqual(n);
      expect(redundantCount(n, 'block-redundant')).toBe((b.activeBlocks + 1) * b.blockModules);
    }
    expect(redundantCount(12, 'block-redundant')).toBe(15);
  });

  it('reference: equal blocks + catcher; normal ≤ 100 %; module failure → transferred to the catcher', () => {
    const p = ref();
    const a = analyzeProject(p);
    const ups = a.power.oneLine.nodes.filter((n) => n.kind === 'ups');
    expect(ups.some((n) => n.path === 'C')).toBe(true);
    expect(new Set(ups.map((n) => n.ratingKVA)).size).toBe(1);
    const normal = evaluatePowerScenario(p, a, { kind: 'normal' });
    for (const e of normal.elements.filter((x) => x.kind === 'ups')) expect(e.loadingPct ?? 0, e.id).toBeLessThanOrEqual(100);
    const mod = evaluatePowerScenario(p, a, { kind: 'ups-module-failure' });
    expect(mod.elements.some((e) => e.kind === 'ups' && e.state === 'transferred')).toBe(true);
  });

  it('every busway circuit carries at most its continuous limit (IEC and NEC)', () => {
    for (const profile of ['iec', 'nec'] as const) {
      const p = ref();
      p.site.powerProfile = profile;
      const a = analyzeProject(p);
      const plane = buildPowerPlane(p, a);
      const kw = new Map(plane.racks.map((r) => [r.id, r.kw]));
      for (const c of plane.circuits) expect(c.rackIds.reduce((s, id) => s + (kw.get(id) ?? 0), 0), `${profile} ${c.id}`).toBeLessThanOrEqual(c.limitKW + 1e-6);
      const bf = evaluatePowerScenario(p, a, { kind: 'busway-failure' });
      expect(bf.summary.overloadedPaths, profile).toBe(0);
    }
  });

  it('generator failure: shed racks non-increasing and genset margin increasing as the load factor drops', () => {
    const p = ref();
    const a = analyzeProject(p);
    let prevShed = Infinity;
    let prevMargin = -Infinity;
    for (const lf of [1, 0.75, 0.5, 0.25]) {
      const r = evaluatePowerScenario(p, a, { kind: 'generator-failure', count: 2, loadFactor: lf });
      expect(r.droppedEquipmentIds.length).toBeLessThanOrEqual(prevShed);
      expect(r.summary.gensetMarginPct!).toBeGreaterThan(prevMargin);
      prevShed = r.droppedEquipmentIds.length;
      prevMargin = r.summary.gensetMarginPct!;
    }
  });

  it('Vera Rubin static Max-Q: rack gain equals the blog gain on both allocation bases', () => {
    for (const vrBasis of ['maxlps-docs', 'maxlps-blog'] as const) {
      const p = ref();
      const old = p.equipment.find((e) => findCatalogItem(e.catalogId)?.category === 'gpu-rack')!.catalogId;
      for (const e of p.equipment) if (e.catalogId === old) e.catalogId = 'nvidia-vr-nvl72';
      p.power.maxq = { ...(p.power.maxq ?? {}), vrBasis };
      const m = analyzeMaxQ(p, analyzeProject(p))!;
      const s = m.staticMaxQ!;
      expect(s.racks / m.racks! - 1, vrBasis).toBeCloseTo(s.gainPct / 100, 1);
      expect(!!s.derived, vrBasis).toBe(vrBasis === 'maxlps-docs');
    }
  });
});

describe('rack composer (QA T5)', () => {
  const node = { id: 'n10', name: 'HGX 10U', rackUnits: 10, power: { nameplateKW: 10 } } as never;
  const sw = (id: string, ru: number) => ({ item: { id, name: id, switch: { rackUnits: ru }, power: { nameplateKW: 0.2 } } as never, count: 1 });

  it('no overflow whenever Σ units ≤ rack units and nothing is pinned', () => {
    for (const cap of [42, 44, 48]) {
      for (const nodes of [1, 2, 3]) {
        for (const shelves of [0, 2, 4]) {
          const comps = rackComponentsFor({ node, nodesPerRack: nodes, switches: [sw('sn2201', 1), sw('sn5600', 2)], powerShelves: shelves ? { count: shelves, ratingKW: 33 } : undefined });
          const total = comps.reduce((s, c) => s + c.units, 0);
          const pl = placeRackComponents(comps, cap);
          if (total <= cap) expect(pl.issues.filter((i) => i.kind === 'overflow'), `${cap}U ${nodes} nodes ${shelves} shelves`).toEqual([]);
        }
      }
    }
  });

  it('switch component ids are unique when the same model appears in two rows', () => {
    const comps = rackComponentsFor({ node, nodesPerRack: 1, switches: [sw('sn2201', 1), sw('sn2201', 1)] });
    const ids = comps.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('layout — multi-hall regeneration, band balance, reach (QA layout findings)', () => {
  it('regenerating either hall of a two-hall project twice keeps pod ids and waves', () => {
    const d = ref();
    const regen = (hallId: string) => {
      const hall = d.halls.find((h) => h.id === hallId)!;
      const o = layoutOptionsFromProject(d, hall, { pods: 4, podIndexStart: nextPodIndex(d, hallId, 4) });
      applyHallLayout(d, hallId, growHallToFit(hall, o), o);
    };
    regen('hall-b');
    const podsOf = (h: string) => [...new Set(d.equipment.filter((e) => e.hallId === h && /^pod-\d+$/.test(e.podId ?? '')).map((e) => e.podId))].sort();
    const wavesOf = (h: string) => [...new Set(d.equipment.filter((e) => e.hallId === h && /^pod-\d+$/.test(e.podId ?? '')).map((e) => `${e.podId}:${e.waveId}`))].sort();
    const a0 = podsOf('hall-a');
    const b0 = podsOf('hall-b');
    const wa0 = wavesOf('hall-a');
    const wb0 = wavesOf('hall-b');
    // a new hall is phased after the existing waves
    const maxA = Math.max(...wa0.map((x) => Number(/wave-(\d+)/.exec(x)![1])));
    expect(Math.min(...wb0.map((x) => Number(/wave-(\d+)/.exec(x)![1])))).toBeGreaterThan(maxA);
    for (let i = 0; i < 2; i++) {
      regen('hall-a');
      regen('hall-b');
    }
    expect(podsOf('hall-a')).toEqual(a0);
    expect(podsOf('hall-b')).toEqual(b0);
    expect(wavesOf('hall-a')).toEqual(wa0);
    expect(wavesOf('hall-b')).toEqual(wb0);
    expect(defaultWaveStart(d, 'hall-a')).toBe(1);
  }, 120_000);

  it('band racks: every pod column gets band racks when there are at least C of them', () => {
    const d = ref();
    const hall = d.halls[0];
    hall.width = 0;
    hall.depth = 0;
    const o = { ...layoutOptionsFromProject(d, hall, { pods: 6, services: { spineRacks: 'auto', storageRacks: 8, cpuRacks: 4, mgmtRacks: 2 } }), columns: 2, orientation: 'x' as const };
    const l = generateHallLayout(o);
    const band = l.equipment.filter((e) => e.podId === 'pod-services' || e.podId === 'pod-network-core');
    const pods = l.equipment.filter((e) => /^pod-\d+$/.test(e.podId ?? ''));
    const xs = pods.map((e) => e.position.x);
    const mid = (Math.min(...xs) + Math.max(...xs)) / 2;
    if (band.length >= 2) {
      expect(band.some((e) => e.position.x < mid)).toBe(true);
      expect(band.some((e) => e.position.x > mid)).toBe(true);
    }
  });

  it('reach: worst run formula and the auto chooser flag grids whose run exceeds 100 m', () => {
    expect(networkReachRunM({ podW: 80, podD: 50, segLen: 20, bandDepthM: 5, centre: false })).toBe(80 - 10 + 50 + 5 + 6);
    expect(networkReachRunM({ podW: 80, podD: 50, segLen: 20, bandDepthM: 5, centre: true })).toBe(80 - 10 + 25 + 5 + 6);
    const d = ref();
    const hall = d.halls[0];
    hall.width = 0;
    hall.depth = 0;
    const o = layoutOptionsFromProject(d, hall, { pods: 40, services: { spineRacks: 'auto', storageRacks: 8, cpuRacks: 4, mgmtRacks: 2 } });
    const g = chooseLayoutGrid(o, { mode: 'auto-size' });
    for (const c of g.candidates) expect(c.reachOk).toBe((c.reachRunM ?? 0) <= 100 + 1e-9);
    if (!g.chosen.reachOk) expect(g.warnings.some((w) => w.code === 'reach')).toBe(true);
  }, 120_000);
});
