import { describe, expect, it } from 'vitest';
import {
  addHall, analyzeProject, createNvidiaReferenceProject, duplicateHall, hallRemovalSummary, nextHallName, removeHall, renameHall, type Project,
} from '../src/index.ts';

const ref = () => structuredClone(createNvidiaReferenceProject().project);

const rectsOverlap = (a: Project['halls'][number], b: Project['halls'][number]) =>
  a.origin.x < b.origin.x + b.width && b.origin.x < a.origin.x + a.width && a.origin.y < b.origin.y + b.depth && b.origin.y < a.origin.y + a.depth;

/** every project-level hall reference points at an existing hall */
function danglingHallRefs(p: Project): string[] {
  const ids = new Set(p.halls.map((h) => h.id));
  const bad: string[] = [];
  const check = (what: string, id: string | undefined) => { if (id !== undefined && !ids.has(id)) bad.push(`${what}:${id}`); };
  p.equipment.forEach((e) => check('equipment', e.hallId));
  p.containments.forEach((c) => check('containment', c.hallId));
  (p.trays ?? []).forEach((t) => check('tray', t.hallId));
  (p.busways ?? []).forEach((b) => check('busway', b.hallId));
  (p.reservations ?? []).forEach((r) => check('reservation', r.hallId));
  (p.servicesZones ?? []).forEach((z) => check('servicesZone', z.hallId));
  (p.thermalSnapshots ?? []).forEach((s) => check('thermalSnapshot', s.hallId));
  (p.clusters ?? []).forEach((c) => { c.hallIds.forEach((h) => check('cluster', h)); check('clusterZone', c.interHallCore?.zoneHallId); });
  return bad;
}

describe('halls.ts — add / rename / duplicate / remove', () => {
  it('adds an empty hall with the next letter, a unique id, copied tile size / heights and no overlap', () => {
    const p = ref();
    const first = p.halls[0];
    const { project: q, hallId } = addHall(p);
    expect(q.halls).toHaveLength(p.halls.length + 1);
    expect(new Set(q.halls.map((h) => h.id)).size).toBe(q.halls.length);
    const h = q.halls.find((x) => x.id === hallId)!;
    expect(h.name).toBe(nextHallName(p));
    // "Data Hall B (Phase 2)" already takes letter B
    const named = { ...p, halls: [{ ...first, name: 'Data Hall A' }, { ...first, id: 'x', name: 'Data Hall B (Phase 2)' }] };
    expect(nextHallName(named)).toBe('Data Hall C');
    expect(nextHallName({ ...p, halls: [{ ...first, name: 'Hall North' }] })).toBe('Data Hall A');
    expect(p.halls.map((x) => x.name)).not.toContain(h.name);
    expect(h.width).toBe(first.width);
    expect(h.depth).toBe(first.depth);
    expect(h.tileSize).toBe(first.tileSize);
    expect(h.clearHeight).toBe(first.clearHeight);
    expect(h.ceilingPlenumHeight).toBe(first.ceilingPlenumHeight);
    expect(h.keepouts).toEqual([]);
    expect(q.equipment.filter((e) => e.hallId === hallId)).toHaveLength(0);
    for (const o of p.halls) expect(rectsOverlap(h, o), `${h.name} × ${o.name}`).toBe(false);
    // input is not mutated
    expect(p.halls).toHaveLength(q.halls.length - 1);
    // three more halls: all names and ids unique, no overlaps anywhere
    let r = q;
    for (let i = 0; i < 3; i++) r = addHall(r).project;
    expect(new Set(r.halls.map((x) => x.id)).size).toBe(r.halls.length);
    expect(new Set(r.halls.map((x) => x.name)).size).toBe(r.halls.length);
    for (const a of r.halls) for (const b of r.halls) if (a !== b) expect(rectsOverlap(a, b)).toBe(false);
  });

  it('renames (trimmed; blank names are ignored)', () => {
    const p = ref();
    const id = p.halls[0].id;
    expect(renameHall(p, id, '  Hall North ').halls[0].name).toBe('Hall North');
    expect(renameHall(p, id, '   ').halls[0].name).toBe(p.halls[0].name);
  });

  it('duplicates with layout: unique ids everywhere, references remapped, analysis sees both halls', () => {
    const p = ref();
    const src = p.halls[0];
    const { project: q, hallId } = duplicateHall(p, src.id, { withLayout: true });
    const srcEq = p.equipment.filter((e) => e.hallId === src.id);
    const newEq = q.equipment.filter((e) => e.hallId === hallId);
    expect(newEq).toHaveLength(srcEq.length);
    expect(new Set(q.equipment.map((e) => e.id)).size).toBe(q.equipment.length);
    expect(new Set(q.containments.map((c) => c.id)).size).toBe(q.containments.length);
    expect(new Set((q.trays ?? []).map((t) => t.id)).size).toBe((q.trays ?? []).length);
    expect(new Set((q.busways ?? []).map((b) => b.id)).size).toBe((q.busways ?? []).length);
    const newIds = new Set(newEq.map((e) => e.id));
    for (const b of (q.busways ?? []).filter((x) => x.hallId === hallId)) for (const t of b.tapoffs) expect(newIds.has(t.equipmentId)).toBe(true);
    // pods of the copy are new ids and join the waves of their source pods
    const srcPods = new Set(srcEq.map((e) => e.podId).filter(Boolean));
    for (const e of newEq) if (e.podId) expect(srcPods.has(e.podId)).toBe(false);
    for (const w of p.schedule.waves) {
      const qw = q.schedule.waves.find((x) => x.id === w.id)!;
      for (const pod of w.podIds) if (srcPods.has(pod)) expect(qw.podIds).toContain(`${pod}-${hallId}`);
    }
    expect(danglingHallRefs(q)).toEqual([]);
    const a = analyzeProject(q);
    expect(a.space.map((s) => s.hallId)).toContain(hallId);
    expect(a.issues.filter((i) => i.id.startsWith('space-nohall-'))).toHaveLength(0);
    // duplicate without layout = empty hall of the same shape
    const e = duplicateHall(p, src.id);
    expect(e.project.equipment).toHaveLength(p.equipment.length);
    expect(e.project.halls.find((h) => h.id === e.hallId)!.width).toBe(src.width);
  });

  it('removes a hall and cleans every reference; analysis has no dangling hallId', () => {
    const base = ref();
    const { project: two, hallId: copy } = duplicateHall(base, base.halls[0].id, { withLayout: true });
    const joined: Project = { ...two, clusters: [{ id: 'c1', name: 'joined', hallIds: [base.halls[0].id, copy], interHallCore: { zoneHallId: copy } }, { id: 'c2', name: 'only copy', hallIds: [copy] }] };
    const s = hallRemovalSummary(joined, copy);
    expect(s.allowed).toBe(true);
    expect(s.equipment).toBe(joined.equipment.filter((e) => e.hallId === copy).length);
    expect(s.clusters).toBe(2);
    expect(s.clustersRemoved).toBe(1);
    const r = removeHall(joined, copy);
    expect(r.halls.map((h) => h.id)).not.toContain(copy);
    expect(danglingHallRefs(r)).toEqual([]);
    expect(r.clusters).toHaveLength(1);
    expect(r.clusters![0].interHallCore?.zoneHallId).toBeUndefined();
    const podIds = new Set(r.equipment.map((e) => e.podId).filter(Boolean));
    for (const w of r.schedule.waves) for (const pid of w.podIds) expect(podIds.has(pid) || base.schedule.waves.some((bw) => bw.podIds.includes(pid))).toBe(true);
    expect(r.schedule.waves.flatMap((w) => w.podIds).some((pid) => pid.endsWith(`-${copy}`))).toBe(false);
    const a = analyzeProject(r);
    const ids = new Set(r.halls.map((h) => h.id));
    for (const sp of a.space) expect(ids.has(sp.hallId)).toBe(true);
    for (const ph of a.power.perHall) expect(ids.has(ph.hallId)).toBe(true);
    for (const pp of a.power.paths ?? []) if (pp.hallId) expect(ids.has(pp.hallId)).toBe(true);
    expect(a.issues.filter((i) => i.id.startsWith('space-nohall-'))).toHaveLength(0);
    expect(JSON.stringify(a)).not.toContain(`"${copy}"`);
  });

  it('refuses to remove the last hall', () => {
    const p = ref();
    let q = p;
    while (q.halls.length > 1) q = removeHall(q, q.halls[q.halls.length - 1].id);
    expect(hallRemovalSummary(q, q.halls[0].id).allowed).toBe(false);
    expect(() => removeHall(q, q.halls[0].id)).toThrow();
  });
});
