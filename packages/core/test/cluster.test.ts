import { describe, expect, it } from 'vitest';
import { analyzeProject, applyHallLayout, buildContext, cableLengthM, cableTypes, calibrateLayout, createNvidiaReferenceProject, findCatalogItem, growHallToFit, interHallCoreFor, joinHalls, layoutOptionsFromProject, mediumOf, nextPodIndex, resolveClusters, splitCluster, trunkSleeveSpot, type EquipmentInstance, type Project } from '../src/index.ts';

/** Reference project with Hall B populated by a copy of Hall A (same geometry, hall-local coordinates). */
function twoHall(): Project {
  const p = createNvidiaReferenceProject().project;
  const a = p.equipment.filter((e) => e.hallId === 'hall-a');
  const b: EquipmentInstance[] = a.map((e) => ({ ...e, id: `${e.id}-b`, hallId: 'hall-b', tag: `B-${e.tag}`, ...(e.podId ? { podId: `${e.podId}-b` } : {}), ...(e.rowId ? { rowId: `${e.rowId}-b` } : {}) }));
  const trays = (p.trays ?? []).filter((t) => t.hallId === 'hall-a').map((t) => ({ ...t, id: `${t.id}-b`, hallId: 'hall-b' }));
  return { ...p, equipment: [...p.equipment, ...b], trays: [...(p.trays ?? []), ...trays] };
}

/** Extra network racks: in-hall spine racks (joined halls double the top tier) and inter-hall core racks in the zone hall. */
function withJoinRacks(p: Project, spineRacksPerHall: number, coreRacks: number): Project {
  const netRack = p.equipment.find((e) => findCatalogItem(e.catalogId)?.category === 'network-rack' && e.networkRole === 'scale-out-spine')!;
  const extra: EquipmentInstance[] = [];
  for (const hallId of ['hall-a', 'hall-b']) {
    const anchor = p.equipment.find((e) => e.hallId === hallId && e.networkRole === 'scale-out-spine')!;
    for (let i = 0; i < spineRacksPerHall; i++) extra.push({ ...netRack, id: `x-spine-${hallId}-${i}`, hallId, tag: `${hallId === 'hall-a' ? '' : 'B-'}XSP-${i}`, position: { x: anchor.position.x + 0.6 * (i + 1), y: anchor.position.y }, networkRole: 'scale-out-spine' });
  }
  const anchorA = p.equipment.find((e) => e.hallId === 'hall-a' && e.networkRole === 'scale-out-spine')!;
  for (let i = 0; i < coreRacks; i++) extra.push({ ...netRack, id: `x-ihc-${i}`, hallId: 'hall-a', tag: `IHC-${i}`, position: { x: anchorA.position.x - 0.6 * (i + 1), y: anchorA.position.y }, networkRole: 'inter-hall-core' as EquipmentInstance['networkRole'] });
  return { ...p, equipment: [...p.equipment, ...extra] };
}

const hallOf = (p: Project) => new Map(p.equipment.map((e) => [e.id, e.hallId]));
const crossHall = (p: Project, a: ReturnType<typeof analyzeProject>) => {
  const h = hallOf(p);
  return a.network.cableRuns.filter((r) => h.get(r.fromId) !== h.get(r.toId));
};

describe('cluster.ts — scope helpers', () => {
  it('join / split keep every hall in exactly one cluster', () => {
    const p = twoHall();
    expect(resolveClusters(p).map((c) => c.hallIds)).toEqual([['hall-a'], ['hall-b']]);
    const joined = joinHalls(p, ['hall-a', 'hall-b'], 'AB');
    expect(joined).toHaveLength(1);
    expect(joined[0]).toMatchObject({ name: 'AB', hallIds: ['hall-a', 'hall-b'], interHallCore: { zoneHallId: 'hall-a' } });
    const split = splitCluster({ ...p, clusters: joined }, joined[0].id);
    expect(split.map((c) => c.hallIds)).toEqual([['hall-a'], ['hall-b']]);
    // an explicit cluster that omits a populated hall still leaves that hall its own default cluster
    expect(resolveClusters({ ...p, clusters: [{ id: 'only-a', name: 'A', hallIds: ['hall-a'] }] }).map((c) => c.id)).toEqual(['only-a', 'cluster-hall-b']);
  });
});

describe('network.ts — per-cluster fabrics (DECISIONS-v2-2 F2)', () => {
  it('single populated hall: one cluster, output identical to the hall-wide sizing (reference pins unchanged)', () => {
    const p = createNvidiaReferenceProject().project;
    const a = analyzeProject(p);
    expect(a.network.clusters).toHaveLength(1);
    expect(a.network.clusters![0]).toMatchObject({ hallIds: ['hall-a'], gpus: 6912 });
    expect(a.network.clusters![0].interHall).toBeUndefined();
    const so = a.network.fabrics.find((f) => f.name.startsWith('Scale-out'))!;
    expect(so.name).toBe('Scale-out · InfiniBand XDR 800G (Quantum-X800)');
    expect(so.tiers.map((t) => t.switches)).toEqual([96, 48]);
    expect(a.network.cablesByType.reduce((s, c) => s + c.count, 0)).toBe(20772); // fix v2 2차: OOB leaves' own mgmt0 ports counted (+4 OOB leaves, +87 cables)
  });

  it('two populated halls, default clusters: every fabric is sized per hall and no cable leaves its hall', () => {
    const p = twoHall();
    const a = analyzeProject(p);
    expect(crossHall(p, a)).toHaveLength(0);
    expect(a.network.clusters!.map((c) => [c.hallIds, c.gpus])).toEqual([[['hall-a'], 6912], [['hall-b'], 6912]]);
    const so = a.network.fabrics.filter((f) => f.name.startsWith('Scale-out'));
    expect(so).toHaveLength(2);
    for (const f of so) expect(f.tiers.map((t) => t.switches)).toEqual([96, 48]);
    expect(a.network.fabrics).toHaveLength(8);
    expect(new Set(a.network.fabrics.map((f) => f.name)).size).toBe(8);
    expect(a.network.unplacedSwitches).toEqual([]);
    expect(a.network.unconnectedLinks).toBe(0);
    // switches only in racks of the fabric's own hall
    const h = hallOf(p);
    for (const load of a.network.rackLoads!) {
      for (const sw of load.switches) {
        const f = a.network.fabrics.find((x) => x.name.endsWith(sw.fabric))!;
        const cluster = a.network.clusters!.find((c) => c.id === f.clusterId)!;
        expect(cluster.hallIds).toContain(h.get(load.rackId));
      }
    }
    // the training job is sized inside one cluster
    expect(a.network.traffic!.notes.some((n) => /collectives never cross clusters/.test(n))).toBe(true);
  });

  it('joined halls: only inter-hall SMF trunks cross halls, counts follow the radix (spines reserve k/2 uplinks, super-spines = ceil(trunks/k))', () => {
    const base = twoHall();
    const p = withJoinRacks({ ...base, clusters: joinHalls(base, ['hall-a', 'hall-b'], 'A+B') }, 12, 16);
    const a = analyzeProject(p);
    const cross = crossHall(p, a);
    expect(cross.length).toBeGreaterThan(0);
    expect(cross.every((r) => r.tier === 'inter-hall')).toBe(true);
    const types = new Map(cableTypes().map((t) => [t.id, t]));
    expect(cross.every((r) => mediumOf(types.get(r.cableTypeId)!) === 'smf')).toBe(true);
    const summary = a.network.clusters!.find((c) => c.hallIds.length === 2)!;
    expect(summary.interHall).toBeDefined();
    const so = a.network.fabrics.find((f) => f.clusterId === summary.id && f.name.startsWith('Scale-out'))!;
    const leaf = so.tiers.find((t) => t.name === 'Leaf')!;
    const spine = so.tiers.find((t) => t.name === 'Spine')!;
    const ss = so.tiers.find((t) => /Super-spine/.test(t.name))!;
    // trunks of the zone hall (hall-a) land in the same hall, so count every inter-hall-tier run; the ones that cross halls are a subset
    const trunks = a.network.cableRuns.filter((r) => r.tier === 'inter-hall').reduce((s, r) => s + r.count, 0);
    expect(cross.reduce((s, r) => s + r.count, 0)).toBeLessThan(trunks);
    expect(leaf.switches).toBe(192);
    expect(spine.uplinks).toBe(Math.floor(spine.portsPerSwitch / 2));
    expect(spine.switches).toBe(2 * Math.ceil((2 * 96 * leaf.uplinks) / spine.portsPerSwitch));
    expect(trunks).toBe(spine.switches * spine.uplinks);
    expect(ss.switches).toBe(Math.ceil(trunks / ss.portsPerSwitch));
    expect(summary.interHall).toMatchObject({ trunks, superSpines: ss.switches, placedSuperSpines: ss.switches, zoneHallId: 'hall-a' });
    expect(a.network.unplacedSwitches).toEqual([]);
    expect(a.network.unconnectedLinks).toBe(0);
    // leaf → spine links stay inside each hall (L · u per hall)
    const leafSpine = a.network.cableRuns.filter((r) => r.tier === 'leaf-spine' && r.fabric.includes('A+B')).reduce((s, r) => s + r.count, 0);
    expect(leafSpine).toBe(2 * 96 * leaf.uplinks);
    // finish v2 2차 (D5): trunk length = in-hall route to the trunk sleeve on the facing wall (B) + site pathway between the sleeves
    // + in-hall route from A's sleeve + vertical + slack — the hall-origin rule is gone
    const ctx = buildContext(p);
    const run = cross.find((r) => p.equipment.find((e) => e.id === r.fromId)!.hallId === 'hall-b')!;
    const from = ctx.placed.find((x) => x.e.id === run.fromId)!;
    const to = ctx.placed.find((x) => x.e.id === run.toId)!;
    const cab = p.network.cabling;
    const ha = p.halls.find((x) => x.id === 'hall-b')!;
    const sa = trunkSleeveSpot(p, 'hall-b', 'hall-a')!;
    const sb = trunkSleeveSpot(p, 'hall-a', 'hall-b')!;
    expect([sa.wall, sb.wall]).toEqual(['W', 'E']);
    const expected = (Math.abs(from.e.position.x - sa.local.x) + Math.abs(from.e.position.y - sa.local.y)) * cab.routeFactor + Math.abs(sa.site.x - sb.site.x) + Math.abs(sa.site.y - sb.site.y) + (Math.abs(to.e.position.x - sb.local.x) + Math.abs(to.e.position.y - sb.local.y)) * cab.routeFactor + 2 * Math.max(0.5, Math.max(ha.trayHeight ?? 2.9, 1.8) - 1.2) + 2 * cab.slackPerEndM;
    // the drawn geometry uses the same sleeves: one trunk-sleeve per hall, a site pathway between them
    expect(a.network.penetrations!.filter((x) => x.kind === 'trunk-sleeve').map((x) => x.hallId).sort()).toEqual(['hall-a', 'hall-b']);
    expect(a.network.interHallPathways).toHaveLength(1);
    expect(run.lengthM).toBe(Math.ceil(expected * 2) / 2);
    expect(cableLengthM(p, from, to)).toBe(run.lengthM);
  });

  it('joined halls without inter-hall core racks: super-spines reported unplaced with a suggestion, trunks not cabled', () => {
    const base = twoHall();
    const p = withJoinRacks({ ...base, clusters: joinHalls(base, ['hall-a', 'hall-b']) }, 12, 0);
    const a = analyzeProject(p);
    expect(crossHall(p, a)).toHaveLength(0);
    const unplaced = a.network.unplacedSwitches!.filter((u) => u.role === 'core');
    expect(unplaced.length).toBe(1);
    expect(unplaced[0].count).toBe(a.network.clusters!.find((c) => c.hallIds.length === 2)!.interHall!.superSpines);
    const issue = a.issues.find((i) => i.id.startsWith('network-cluster-core-unplaced'));
    expect(issue?.severity).toBe('error');
    expect(issue?.suggestionEn).toMatch(/inter-hall-core/);
  });
});

describe('joined reference pair through the layout generator (integration v2 2차)', () => {
  it('T1 reserves T2’s super-spines (⌈Σ top · ⌊k/2⌋ ÷ k_ss⌉ with the doubled top tier) and doubled in-hall spines → nothing unplaced', () => {
    const regen = (d: Project, hallId: string, pods: number) => {
      const hall = d.halls.find((h) => h.id === hallId)!;
      const svc = hallId === 'hall-a' ? { storageRacks: 8, cpuRacks: 4, mgmtRacks: 2 } : { storageRacks: 0, cpuRacks: 0, mgmtRacks: 0 };
      const opts = layoutOptionsFromProject(d, hall, { pods, podIndexStart: nextPodIndex(d, hallId), services: { spineRacks: 'auto', ...svc } });
      let layout = growHallToFit(hall, opts);
      const cal = calibrateLayout(d, hall, opts, { keepPods: true, rounds: 2, isolate: true, quick: true });
      layout = cal.layout;
      if (layout.requiredWidth > hall.width + 1e-6 || layout.requiredDepth > hall.depth + 1e-6) layout = growHallToFit(hall, cal.opts);
      applyHallLayout(d, hallId, layout, cal.opts, {});
    };
    const d = structuredClone(createNvidiaReferenceProject().project);
    d.clusters = joinHalls(d, ['hall-a', 'hall-b'], 'A+B');
    regen(d, 'hall-b', 4);
    regen(d, 'hall-a', 4); // zone hall last: reserves the inter-hall core racks for both halls
    const plan = interHallCoreFor(d, 'hall-a');
    expect(plan.topSwitchesByHall).toEqual({ 'hall-a': 96, 'hall-b': 96 });
    expect(plan.superSpines).toBe(96);
    const a = analyzeProject(d);
    const summary = a.network.clusters!.find((c) => c.hallIds.length === 2)!;
    expect(summary.interHall).toMatchObject({ superSpines: 96, placedSuperSpines: 96, trunks: 13824 });
    expect(a.network.unplacedSwitches).toEqual([]);
    expect(a.network.unconnectedLinks).toBe(0);
    expect(a.issues.filter((i) => i.domain === 'network' && i.severity === 'error')).toEqual([]);
    expect(d.equipment.filter((e) => e.hallId === 'hall-a' && e.networkRole === 'inter-hall-core').length).toBe(plan.racks);
    for (const h of ['hall-a', 'hall-b']) expect(d.equipment.filter((e) => e.hallId === h && e.networkRole === 'scale-out-spine').length, h).toBe(12);
    // one cluster: the workload and its private traffic model use the cluster's GPUs; the Network panel exposes the concurrent sum
    const train = a.workloads.find((w) => w.workloadId === 'wl-pretrain-405b')!;
    expect(train.gpus).toBe(Math.floor((0.8 * summary.gpus) / 32) * 32);
    expect(train.details?.stepModel).toBe('traffic-v2');
    expect(a.network.traffic).toMatchObject({ mode: 'aggregate', basis: 'aggregate-second' });
  });

  it('two populated halls split by default: the job and the workload panel use one hall’s GPUs, not the project total', () => {
    const p = twoHall();
    const a = analyzeProject(p);
    const train = a.workloads.find((w) => w.workloadId === 'wl-pretrain-405b')!;
    expect(a.summary.gpus).toBe(13824);
    expect(train.gpus).toBe(Math.floor((0.8 * 6912) / 32) * 32);
    expect(train.details?.stepModel).toBe('traffic-v2');
    expect(a.network.traffic).toMatchObject({ mode: 'aggregate', basis: 'aggregate-second' });
  });
});
