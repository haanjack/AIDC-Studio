// r4 stream A0 — T4 (spec §4.4): plan / section / elevation projections, exact visible outlines, rotation symmetry, pack round trip.
import { describe, expect, it } from 'vitest';
import { analyzeProject, createNvidiaReferenceProject, type DrawingCut, type ElevationTarget } from '../src/index.ts';
import { buildHallPrims } from '../src/scene/build.ts';
import { packDrawList, unpackDrawList, type DrawItem2D, type DrawList2D } from '../src/scene/drawList.ts';
import { LAYERS } from '../src/scene/layers.ts';
import { GridIndex, primAabb, primsHash, type HallPrims, type Prim } from '../src/scene/prims.ts';
import { elevationCut, projectElevation } from '../src/scene/project/elevation.ts';
import { visibleOutlines, type OccRect } from '../src/scene/project/occlude.ts';
import { PLAN_CUT_Z_M, planCutZ, projectPlan } from '../src/scene/project/plan.ts';
import { projectSection, sectionDepth } from '../src/scene/project/section.ts';
import { r4FixtureHallPrims } from './fixtures/r4-prims.ts';

const ref = createNvidiaReferenceProject().project;
const refA = analyzeProject(ref);
const hpRef = buildHallPrims(ref, refA, { hallId: 'hall-a', detail: 'pod' });
const byId = (hp: HallPrims) => new Map(hp.prims.map((p) => [p.id, p]));
const mm = (a: number, b: number) => Math.abs(a - b) <= 1e-3;

let seed = 424242;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

describe('projectPlan', () => {
  it('classifies cut / below / overhead at cutZ; services and rcp modes ghost racks; slab never, ceiling only in rcp', () => {
    const hp = r4FixtureHallPrims();
    const role = (l: DrawList2D, id: string) => l.items.find((it) => it.primId === id)?.role;
    const floor = projectPlan(hp);
    expect(planCutZ(hp)).toBe(PLAN_CUT_Z_M);
    expect(role(floor, 'rack:DU01-A-01')).toBe('cut');
    expect(role(floor, 'busway:bw-A-row-A')).toBe('overhead');
    expect(role(floor, 'door:door-1')).toBe('cut');
    expect(floor.items.some((it) => it.layer === 'slab' || it.layer === 'ceiling')).toBe(false);
    const high = projectPlan(hp, { cutZ: 2.5 });
    expect(role(high, 'rack:DU01-A-01')).toBe('below');
    expect(role(high, 'pipe:DU01-A#S')).toBe('cut'); // 2.52 ± 0.08
    expect(role(high, 'busway:bw-A-row-A')).toBe('overhead');
    const services = projectPlan(hp, { mode: 'services' });
    expect(role(services, 'rack:DU01-A-01')).toBe('ghost');
    expect(planCutZ(hp, 'services')).toBeLessThan(2.44);
    const rcp = projectPlan(hp, { mode: 'rcp' });
    expect(planCutZ(hp, 'rcp')).toBeCloseTo(4.19, 9);
    expect(rcp.items.some((it) => it.layer === 'ceiling')).toBe(true);
    // painter order: ghost → below → cut → overhead
    const rank = { ghost: 0, below: 1, cut: 2, overhead: 3, beyond: 4 } as const;
    for (const l of [floor, high, services, rcp]) for (let i = 1; i < l.items.length; i++) expect(rank[l.items[i].role]).toBeGreaterThanOrEqual(rank[l.items[i - 1].role]);
    // explicit layers
    const only = projectPlan(hp, { layers: ['racks', 'slab'] });
    expect(new Set(only.items.map((it) => it.layer))).toEqual(new Set(['racks', 'slab']));
  });

  it('every rack / unit / busway / tray / drop / pipe / tap-off prim appears with its primId and xy extent (±1 mm); busway rect = 2 × halfW', () => {
    const plan = projectPlan(hpRef);
    const items = new Map<string, DrawItem2D[]>();
    for (const it of plan.items) items.set(it.primId!, [...(items.get(it.primId!) ?? []), it]);
    let n = 0;
    for (const p of hpRef.prims) {
      if (!['rack', 'unit', 'busway', 'tray', 'drop', 'pipe', 'tapoff'].includes(p.emitter)) continue;
      const got = items.get(p.id);
      expect(got, p.id).toHaveLength(1);
      const b = primAabb(p);
      const it = got![0];
      if (it.kind === 'rect') {
        expect(mm(it.pts[0], b.min.x) && mm(it.pts[1], b.min.y) && mm(it.pts[2], b.max.x - b.min.x) && mm(it.pts[3], b.max.y - b.min.y), p.id).toBe(true);
      } else if (it.kind === 'circle') {
        expect(mm(it.pts[0] - it.pts[2], b.min.x) && mm(it.pts[1] + it.pts[2], b.max.y), p.id).toBe(true);
      }
      if (p.emitter === 'busway') expect(Math.min(it.pts[2], it.pts[3])).toBeCloseTo(2 * p.halfW, 9);
      n++;
    }
    expect(n).toBeGreaterThan(900);
    const layers = new Set(LAYERS.map((l) => l.id));
    expect(plan.items.every((it) => layers.has(it.layer) && it.lodMin >= 0 && it.lodMin <= 3 && it.pts.every(Number.isFinite))).toBe(true);
    expect(projectPlan(hpRef).hash).toBe(plan.hash);
  });

  it('a window returns exactly the prims whose plan AABB meets it (grid index = brute force)', () => {
    for (let k = 0; k < 40; k++) {
      const w = { x: rnd() * 26 - 2, y: rnd() * 50 - 5, w: rnd() * 8, d: rnd() * 8 };
      const got = new Set(projectPlan(hpRef, { window: w }).items.map((it) => it.primId));
      const want = new Set(
        hpRef.prims
          .filter((p) => p.layer !== 'slab' && p.layer !== 'ceiling')
          .filter((p) => {
            const b = primAabb(p);
            return b.min.x <= w.x + w.w && b.max.x >= w.x && b.min.y <= w.y + w.d && b.max.y >= w.y;
          })
          .map((p) => p.id),
      );
      expect(got).toEqual(want);
    }
    // structured clone (worker) keeps working: the index is rebuilt
    const cloned = structuredClone(hpRef);
    expect(projectPlan(cloned).items).toEqual(projectPlan(hpRef).items);
  });
});

describe('projectSection', () => {
  const hall = ref.halls[0];
  const cont = ref.containments.find((c) => c.hallId === hall.id)!;
  const xCut: DrawingCut = { id: 'T1', label: 'T–T', hallId: hall.id, axis: 'x', at: cont.rect.x + cont.rect.w / 2 + 0.15, look: 1, depthM: 0.6 };

  it('cut items keep the prim u / z extents (±1 mm); flipping look mirrors u', () => {
    const map = byId(hpRef);
    const a = projectSection(hpRef, xCut, { depth: 'cut' });
    const b = projectSection(hpRef, { ...xCut, look: -1 }, { depth: 'cut' });
    expect(a.items.every((it) => it.role === 'cut')).toBe(true);
    expect(a.items.length).toBeGreaterThan(50);
    const ext = (it: DrawItem2D) => (it.kind === 'circle' ? [it.pts[0] - it.pts[2], it.pts[0] + it.pts[2], it.pts[1] - it.pts[2], it.pts[1] + it.pts[2]] : it.kind === 'rect' ? [it.pts[0], it.pts[0] + it.pts[2], it.pts[1], it.pts[1] + it.pts[3]] : [Math.min(it.pts[0], it.pts[2]), Math.max(it.pts[0], it.pts[2]), Math.min(it.pts[1], it.pts[3]), Math.max(it.pts[1], it.pts[3])]);
    for (const it of a.items) {
      const p = map.get(it.primId!)!;
      const box = primAabb(p);
      expect(box.min.x <= xCut.at + 1e-9 && box.max.x >= xCut.at - 1e-9, p.id).toBe(true);
      const [u0, u1, z0, z1] = ext(it);
      expect(mm(u0, -box.max.y) && mm(u1, -box.min.y) && mm(z0, box.min.z) && mm(z1, box.max.z), p.id).toBe(true);
    }
    const bb = new Map(b.items.map((it) => [it.primId, it]));
    expect(new Set(bb.keys())).toEqual(new Set(a.items.map((it) => it.primId)));
    for (const it of a.items) {
      const [u0, u1, z0, z1] = ext(it);
      const [v0, v1, w0, w1] = ext(bb.get(it.primId)!);
      expect(mm(v0, -u1) && mm(v1, -u0) && mm(w0, z0) && mm(w1, z1), it.primId).toBe(true);
    }
    expect(a.cut).toEqual(xCut);
    // pipes run along x: a cut ⟂ x shows them end-on (circles), a cut ⟂ y through the pipe line shows them as rects
    expect(a.items.some((it) => it.kind === 'circle' && it.style === 'pipe')).toBe(true);
    const pipe = hpRef.prims.find((p) => p.emitter === 'pipe')!;
    const along = projectSection(hpRef, { ...xCut, axis: 'y', at: pipe.a.y }, { depth: 'cut' }).items.filter((it) => it.primId === pipe.id);
    expect(along).toHaveLength(1);
    expect(along[0].kind).toBe('rect');
  });

  it("depth presets: 'next-row' stops at the opposite row face (capped), 'wall' at the interior wall face, 'cut' has no beyond", () => {
    const fx = r4FixtureHallPrims();
    const aisle: DrawingCut = { id: 'A', label: 'A–A', hallId: fx.hallId, axis: 'y', at: 5.2, look: 1, depthM: 2.4 };
    expect(sectionDepth(fx, aisle, 'next-row')).toBeCloseTo(0.6, 9); // row B rear face at y 5.8
    expect(sectionDepth(fx, { ...aisle, look: -1 }, 'next-row')).toBeCloseTo(0.6, 9); // row A rear face at y 4.6
    expect(sectionDepth(fx, aisle, 'next-row', 0.25)).toBe(0.25);
    const l = projectSection(fx, aisle, { depth: 'next-row' });
    const beyond = l.items.filter((it) => it.role === 'beyond');
    expect(beyond.every((it) => it.depth! <= 0.6 + 1e-9)).toBe(true);
    expect(beyond.some((it) => it.primId!.startsWith('rack:DU01-B-'))).toBe(true);
    expect(l.items.some((it) => it.primId === 'busway:bw-A-row-B')).toBe(false);
    expect(projectSection(fx, aisle, { depth: 'cut' }).items.every((it) => it.role === 'cut')).toBe(true);
    const hall = ref.halls[0];
    expect(sectionDepth(hpRef, { axis: 'y', at: 10, look: 1 }, 'wall')).toBeCloseTo(hall.depth - 10, 9);
    expect(sectionDepth(hpRef, { axis: 'x', at: 4, look: -1 }, 'wall')).toBeCloseTo(4, 9);
    expect(sectionDepth(hpRef, { axis: 'x', at: 4, look: -1 }, 1.7)).toBe(1.7);
  });

  it('beyond items are emitted far → near, after them the cut items; nothing hidden is emitted as a closed rect', () => {
    const l = projectSection(hpRef, { ...xCut, depthM: 6 });
    let seenCut = false;
    let last = Infinity;
    for (const it of l.items) {
      if (it.role === 'cut') seenCut = true;
      else {
        expect(seenCut).toBe(false);
        expect(it.depth!).toBeLessThanOrEqual(last + 1e-12);
        last = it.depth!;
      }
    }
    expect(l.items.some((it) => it.role === 'beyond' && it.kind === 'polyline')).toBe(true);
  });
});

describe('visible outlines (exact hidden-line removal)', () => {
  const onSeg = (pu: number, pz: number, c: number[]) => {
    for (let i = 0; i + 3 < c.length; i += 2) {
      const [u0, z0, u1, z1] = [c[i], c[i + 1], c[i + 2], c[i + 3]];
      if (Math.abs(z0 - z1) < 1e-12 && Math.abs(pz - z0) < 1e-9 && pu >= Math.min(u0, u1) - 1e-9 && pu <= Math.max(u0, u1) + 1e-9) return true;
      if (Math.abs(u0 - u1) < 1e-12 && Math.abs(pu - u0) < 1e-9 && pz >= Math.min(z0, z1) - 1e-9 && pz <= Math.max(z0, z1) + 1e-9) return true;
    }
    return false;
  };
  it('equals a brute-force point test on random rectangle sets (ties at equal depth never occlude)', () => {
    for (let trial = 0; trial < 25; trial++) {
      const rects: OccRect[] = Array.from({ length: 40 }, () => {
        const u0 = Math.round(rnd() * 40) / 4;
        const z0 = Math.round(rnd() * 20) / 4;
        return { u0, z0, u1: u0 + Math.round(rnd() * 16 + 1) / 4, z1: z0 + Math.round(rnd() * 12 + 1) / 4, depth: Math.floor(rnd() * 6) };
      });
      const vis = visibleOutlines(rects, trial % 2 ? { cellU: 0.7, cellZ: 0.3 } : {});
      rects.forEach((r, i) => {
        const v = vis[i];
        for (let s = 0; s < 60; s++) {
          const t = (s + 0.37) / 60;
          const side = s % 4;
          const [pu, pz] = side === 0 ? [r.u0 + t * (r.u1 - r.u0), r.z0] : side === 1 ? [r.u1, r.z0 + t * (r.z1 - r.z0)] : side === 2 ? [r.u0 + t * (r.u1 - r.u0), r.z1] : [r.u0, r.z0 + t * (r.z1 - r.z0)];
          const horizontal = side % 2 === 0;
          // skip samples that fall on another rectangle's boundary (ambiguous by construction)
          if (rects.some((o, j) => j !== i && (horizontal ? Math.abs(o.u0 - pu) < 1e-6 || Math.abs(o.u1 - pu) < 1e-6 : Math.abs(o.z0 - pz) < 1e-6 || Math.abs(o.z1 - pz) < 1e-6))) continue;
          // nearer rectangles are closed across the edge (a coincident nearer boundary hides the farther edge)
          const covered = rects.some((o) => o.depth < r.depth && (horizontal ? o.z0 <= pz && o.z1 >= pz && o.u0 < pu && o.u1 > pu : o.u0 <= pu && o.u1 >= pu && o.z0 < pz && o.z1 > pz));
          const drawn = v.full || v.chains.some((c) => onSeg(pu, pz, c));
          expect(drawn, `trial ${trial} rect ${i} side ${side} t ${t}`).toBe(!covered);
        }
      });
    }
  });
});

describe('projectElevation', () => {
  it('wall / row-face front + rear / aisle-end: every item beyond, painter order far → near, rear mirrors the front', () => {
    const row = hpRef.rows.find((r) => r.kind === 'compute')!;
    const cont = ref.containments.find((c) => c.hallId === 'hall-a')!;
    const targets: ElevationTarget[] = [
      { kind: 'wall', wall: 'N' },
      { kind: 'wall', wall: 'W' },
      { kind: 'row-face', rowId: row.id, face: 'front' },
      { kind: 'row-face', rowId: row.id, face: 'rear' },
      { kind: 'aisle-end', containmentId: cont.id, end: 0 },
      { kind: 'aisle-end', containmentId: cont.id, end: 1 },
    ];
    for (const t of targets) {
      const l = projectElevation(hpRef, t);
      expect(l.space).toBe('elevation');
      expect(l.elevation).toEqual(t);
      expect(l.items.length, JSON.stringify(t)).toBeGreaterThan(10);
      for (let i = 0; i < l.items.length; i++) {
        expect(l.items[i].role).toBe('beyond');
        if (i) expect(l.items[i].depth!).toBeLessThanOrEqual(l.items[i - 1].depth! + 1e-12);
      }
    }
    const front = elevationCut(hpRef, targets[2])!;
    const rear = elevationCut(hpRef, targets[3])!;
    expect(front.look).toBe(-rear.look);
    expect(front.axis).toBe(rear.axis);
    const racksF = new Set(projectElevation(hpRef, targets[2]).items.filter((it) => it.style === 'rack').map((it) => it.primId));
    expect([...racksF].every((id) => hpRef.prims.find((p) => p.id === id)!.rowId === row.id)).toBe(true);
    expect(racksF.size).toBe(hpRef.prims.filter((p) => p.rowId === row.id && p.emitter === 'rack').length);
    // aisle-end: the near door is fully visible and closes the view
    const endItems = projectElevation(hpRef, targets[4]).items;
    const nearDoor = endItems.filter((it) => it.primId === `door:${cont.id}#end0`);
    expect(nearDoor.length).toBeGreaterThan(0);
    expect(nearDoor[0].depth).toBeCloseTo(0.05, 9); // plane 0.05 m outside the door's outer face
    // the far door has the same (u, z) rectangle, strictly farther: hidden
    expect(endItems.some((it) => it.primId === `door:${cont.id}#end1`)).toBe(false);
    // painter mode: same visible prims, closed rects (lines only for zero-area prims)
    const painter = projectElevation(hpRef, targets[4], { outlines: 'painter' }).items;
    expect(new Set(painter.map((it) => it.primId))).toEqual(new Set(endItems.map((it) => it.primId)));
    expect(painter.filter((it) => it.kind === 'polyline').every((it) => it.pts.length === 4)).toBe(true);
    expect(painter.length).toBeLessThanOrEqual(endItems.length);
    expect(projectElevation(hpRef, { kind: 'row-face', rowId: 'nope', face: 'front' }).items).toEqual([]);
  });
});

describe('rotation symmetry and transfer', () => {
  const rotate = (hp: HallPrims, k: number): HallPrims => {
    const R = (x: number, y: number): [number, number] => {
      let [a, b] = [x, y];
      for (let i = 0; i < k; i++) [a, b] = [-b, a];
      return [a, b];
    };
    const prims: Prim[] = hp.prims.map((p) => {
      const [ax, ay] = R(p.a.x, p.a.y);
      const [bx, by] = R(p.b.x, p.b.y);
      if (p.shape === 'box' || p.shape === 'plane') return { ...p, a: { x: Math.min(ax, bx), y: Math.min(ay, by), z: p.a.z }, b: { x: Math.max(ax, bx), y: Math.max(ay, by), z: p.b.z } };
      const vertical = Math.abs(p.a.x - p.b.x) < 1e-12 && Math.abs(p.a.y - p.b.y) < 1e-12 && p.shape === 'bar';
      return { ...p, a: { x: ax, y: ay, z: p.a.z }, b: { x: bx, y: by, z: p.b.z }, ...(vertical && k % 2 ? { halfW: p.halfH, halfH: p.halfW } : {}) };
    });
    return { ...hp, prims, index: GridIndex.build(prims), hash: primsHash(prims) };
  };
  const canon = (l: DrawList2D) => l.items.map((it) => `${it.primId}|${it.role}|${it.kind}|${it.pts.map((v) => v.toFixed(6)).join(',')}|${(it.depth ?? 0).toFixed(6)}`).sort();

  it('sections of a hall rotated by 0 / 90 / 180 / 270° are identical in (u, z)', () => {
    const fx = r4FixtureHallPrims();
    for (const [at, look] of [[5.2, 1], [5.0, -1], [4.3, 1]] as const) {
      const base = projectSection(fx, { id: 'S', label: 'S', hallId: fx.hallId, axis: 'y', at, look, depthM: 3 });
      expect(base.items.length).toBeGreaterThan(5);
      for (const k of [1, 2, 3]) {
        const rot = rotate(fx, k);
        // the plane y = at, look ±y, after k quarter turns (x, y) → (−y, x)
        const cut: DrawingCut =
          k === 1 ? { id: 'S', label: 'S', hallId: fx.hallId, axis: 'x', at: -at, look: (-look) as 1 | -1, depthM: 3 }
          : k === 2 ? { id: 'S', label: 'S', hallId: fx.hallId, axis: 'y', at: -at, look: (-look) as 1 | -1, depthM: 3 }
          : { id: 'S', label: 'S', hallId: fx.hallId, axis: 'x', at, look, depthM: 3 };
        expect(canon(projectSection(rot, cut)), `k=${k} at=${at} look=${look}`).toEqual(canon(base));
      }
    }
  });

  it('plan item areas are invariant under rotation; packDrawList round-trips real plan / section / elevation lists', () => {
    const fx = r4FixtureHallPrims();
    const area = (l: DrawList2D) => Object.fromEntries(l.items.filter((it) => it.kind === 'rect').map((it) => [it.primId, +(it.pts[2] * it.pts[3]).toFixed(9)]));
    const base = area(projectPlan(fx));
    for (const k of [1, 2, 3]) expect(area(projectPlan(rotate(fx, k)))).toEqual(base);
    const lists = [projectPlan(hpRef), projectSection(hpRef, { id: 'x', label: 'x', hallId: 'hall-a', axis: 'y', at: 12, look: -1, depthM: 3 }), projectElevation(hpRef, { kind: 'wall', wall: 'S' })];
    for (const l of lists) {
      const p = packDrawList(l);
      expect(unpackDrawList(p)).toEqual(l);
      expect(unpackDrawList(structuredClone(p))).toEqual(l);
    }
  });
});
