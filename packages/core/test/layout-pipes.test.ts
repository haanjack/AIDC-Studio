// r4 stream B2: layout/pipes.ts buildPipes — derived TCS pipe network (spec §2.4 "Derived pipes", S9).
import { describe, expect, it } from 'vitest';
import { buildHallPipes, buildPipes, detectRowGroups, findCatalogItem, pipeVelocityMs, sizePipeDn, TCS_LPM_PER_KW, TCS_MAX_VELOCITY_MS, type PipeNetwork, type PipeRun, type Project } from '../src/index.ts';
import { podProject, rcuProject, refProject } from './drawings-r4-helpers.ts';

const baseId = (id: string) => id.replace(/#\d+$/, '');
const liquidRacks = (p: Project, hallId: string) =>
  p.equipment.filter((e) => {
    if (e.hallId !== hallId) return false;
    const it = findCatalogItem(e.catalogId);
    return !!it && ['gpu-rack', 'cpu-rack', 'storage-rack', 'network-rack', 'mgmt-rack'].includes(it.category) && (it.cooling?.liquidFraction ?? 0) > 0 && !!e.rowId;
  });

/** one entry per logical run (column cuts split a run into `#k` parts carrying the same flow) */
function logical(net: PipeNetwork): PipeRun[] {
  const seen = new Map<string, PipeRun>();
  for (const r of net.runs) if (!seen.has(baseId(r.id))) seen.set(baseId(r.id), { ...r, id: baseId(r.id) });
  return [...seen.values()];
}

function checkConservation(net: PipeNetwork) {
  const runs = logical(net);
  for (const sys of ['tcs-supply', 'tcs-return'] as const) {
    const S = runs.filter((r) => r.system === sys);
    const pods = new Set(S.filter((r) => r.part === 'cross').map((r) => r.podId!));
    expect(pods.size).toBeGreaterThan(0);
    for (const pod of pods) {
      const cross = S.filter((r) => r.part === 'cross' && r.podId === pod);
      const crossFlow = cross.reduce((s, r) => s + r.flowLpm!, 0);
      const links = S.filter((r) => r.part === 'link' && r.podId === pod);
      if (links.length) expect(links.reduce((s, r) => s + r.flowLpm!, 0)).toBeCloseTo(crossFlow, 3);
      const rowsOfPod = [...new Set(S.filter((r) => r.part === 'row' && r.podId === pod).map((r) => r.rowId!))];
      let firstSum = 0;
      for (const rowId of rowsOfPod) {
        // segments in feed order: ':row' or ':row:L1', ':row:L2' …
        const segs = S.filter((r) => r.part === 'row' && r.rowId === rowId).sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
        firstSum += segs[0].flowLpm!;
        const branches = S.filter((r) => r.kind === 'branch' && r.rowId === rowId);
        segs.forEach((seg, k) => {
          const downstream = k + 1 < segs.length ? segs[k + 1].flowLpm! : 0;
          const loopBranches = branches.filter((b) => b.loopId === seg.loopId);
          expect(seg.flowLpm! - downstream, `${seg.id}`).toBeCloseTo(loopBranches.reduce((s, b) => s + b.flowLpm!, 0), 3);
        });
      }
      expect(firstSum).toBeCloseTo(crossFlow, 3);
    }
    // per CDU: riser = Σ links
    for (const riser of S.filter((r) => r.kind === 'riser')) {
      const links = S.filter((r) => r.part === 'link' && r.cduIds[0] === riser.cduIds[0]);
      expect(links.reduce((s, r) => s + r.flowLpm!, 0)).toBeCloseTo(riser.flowLpm!, 3);
    }
  }
}

describe('r4 B2 layout/pipes.ts buildPipes', () => {
  const ref = refProject();
  const hall = ref.halls[0];
  const net = buildHallPipes(ref, hall, detectRowGroups(ref, hall));

  it('sizing: 1.5 LPM/kW, smallest DN with v ≤ 2.4 m/s (DN25 floor)', () => {
    expect(TCS_LPM_PER_KW.value).toBe(1.5);
    expect(sizePipeDn(1)).toBe(25);
    expect(sizePipeDn(175)).toBe(40); // one GB-class rack ≈ 117 kW liquid → 1 1/2" branch
    expect(sizePipeDn(2100)).toBe(150); // 12 racks → 6" header
    for (const r of net.runs) expect(pipeVelocityMs(r.flowLpm!, r.dnMM), r.id).toBeLessThanOrEqual(TCS_MAX_VELOCITY_MS.value + 1e-9);
    for (const r of net.runs) if (r.dnMM > 25) expect(pipeVelocityMs(r.flowLpm!, [15, 20, 25, 32, 40, 50, 65, 80, 100, 125, 150, 200, 250, 300, 350, 400, 450, 500, 600].filter((d) => d < r.dnMM).pop()!)).toBeGreaterThan(2.4);
  });

  it('every liquid rack has exactly one supply and one return branch, one EPIV and two isolation valves', () => {
    const racks = liquidRacks(ref, hall.id);
    expect(racks.length).toBeGreaterThan(0);
    const branches = net.runs.filter((r) => r.kind === 'branch');
    expect(branches.length).toBe(2 * racks.length);
    for (const e of racks) {
      const tag = e.tag || e.id;
      expect(branches.filter((b) => b.id === `tcs-S:${tag}:branch`).length, tag).toBe(1);
      expect(branches.filter((b) => b.id === `tcs-R:${tag}:branch`).length, tag).toBe(1);
      expect(net.fittings.filter((f) => f.kind === 'epiv' && f.equipmentId === e.id).length).toBe(1);
      expect(net.fittings.filter((f) => f.kind === 'isolation-valve' && f.equipmentId === e.id).length).toBe(2);
    }
    // branch flow = 1.5 LPM/kW × nameplate × liquid fraction
    const e = racks[0];
    const it = findCatalogItem(e.catalogId)!;
    expect(branches.find((b) => b.id === `tcs-S:${e.tag}:branch`)!.flowLpm).toBeCloseTo(1.5 * it.power!.nameplateKW * it.cooling!.liquidFraction, 4);
  });

  it('flow is conserved per loop (REF in-row CDUs)', () => {
    checkConservation(net);
    const risers = net.runs.filter((r) => r.kind === 'riser');
    expect(risers.length).toBe(2 * ref.equipment.filter((q) => q.hallId === hall.id && findCatalogItem(q.catalogId)?.category === 'cdu').length);
  });

  it('RCU template: row headers split per meta.rcu loop, isolation valves between loops, conservation holds', () => {
    const p = rcuProject();
    const h = p.halls[0];
    const n = buildHallPipes(p, h, detectRowGroups(p, h));
    checkConservation(n);
    const row = n.runs.filter((r) => r.part === 'row' && r.system === 'tcs-supply' && r.rowId === 'pod-01-a');
    const loops = new Set(p.equipment.filter((e) => e.rowId === 'pod-01-a' && e.meta?.rcu).map((e) => String(e.meta!.rcu)));
    expect(loops.size).toBeGreaterThan(1);
    expect(new Set(row.map((r) => r.loopId)).size).toBe(loops.size);
    expect(n.fittings.filter((f) => f.id.startsWith('iv:pod-01-a:L') && f.id.endsWith(':S')).length).toBe(loops.size - 1);
  });

  it('no pipe inside a column; a column across a header cuts the run (flow kept)', () => {
    const p = refProject();
    const h = p.halls[0];
    // column across the row header in the service lead-in before the first CDU; generated rack runs are contiguous
    const gx = 5.05;
    const cw = 0.1;
    h.keepouts = [...h.keepouts, { id: 'col-test', kind: 'column', rect: { x: gx - cw / 2, y: 4.2952 + 0.22 - 0.3, w: cw, d: 0.6 }, label: 'Column' }];
    const n = buildHallPipes(p, h, detectRowGroups(p, h));
    const cols = h.keepouts.filter((k) => k.kind === 'column' || k.kind === 'shaft');
    for (const r of n.runs) {
      const rad = r.dnMM / 2000;
      for (let i = 1; i < r.points.length; i++) {
        const a = r.points[i - 1];
        const b = r.points[i];
        const box = { x0: Math.min(a.x, b.x) - rad, x1: Math.max(a.x, b.x) + rad, y0: Math.min(a.y, b.y) - rad, y1: Math.max(a.y, b.y) + rad };
        for (const c of cols) expect(box.x0 < c.rect.x + c.rect.w && box.x1 > c.rect.x && box.y0 < c.rect.y + c.rect.d && box.y1 > c.rect.y, `${r.id} in ${c.id}`).toBe(false);
      }
    }
    expect(n.runs.some((r) => /tcs-S:pod-01-a:row#2$/.test(r.id))).toBe(true);
    checkConservation(n);
    // POD: real columns, no CDUs → branches and headers, no risers
    const pod = podProject();
    if (pod) {
      const ph = pod.halls[0];
      const pn = buildHallPipes(pod, ph, detectRowGroups(pod, ph));
      expect(pn.runs.filter((r) => r.kind === 'riser').length).toBe(0);
      expect(pn.runs.filter((r) => r.kind === 'branch').length).toBe(2 * liquidRacks(pod, ph.id).length);
      checkConservation(pn);
    }
  });

  it('deterministic, empty without equipment, hall-local inside the hall', () => {
    expect(buildHallPipes(ref, hall, detectRowGroups(ref, hall))).toEqual(net);
    expect(buildPipes(hall, detectRowGroups(ref, hall), [])).toEqual({ hallId: hall.id, runs: [], fittings: [] });
    for (const r of net.runs) for (const q of r.points) {
      expect(q.x).toBeGreaterThanOrEqual(0);
      expect(q.x).toBeLessThanOrEqual(hall.width);
      expect(q.y).toBeGreaterThanOrEqual(0);
      expect(q.y).toBeLessThanOrEqual(hall.depth);
    }
    expect(new Set(net.runs.map((r) => r.id)).size).toBe(net.runs.length);
    expect(new Set(net.fittings.map((f) => f.id)).size).toBe(net.fittings.length);
  });
});
