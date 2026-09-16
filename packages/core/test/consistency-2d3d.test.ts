// r4 stream A1 — T3 (spec §4.4): one geometry source for 2D and 3D, on the sweep reference · synthetic POD · Helios 2-pod · y-oriented hall ·
// RCU template · 16-pod (+ a column-on-the-main-tray hall for the cable dodge).
//   (a) every rack / busway / tray / drop / pipe / tap-off prim appears in projectPlan with the same primId and plan extent (±1 mm)
//   (b) projectSection at the generated transverse (301) and longitudinal (302) cuts: every intersected prim is a cut item whose u / z
//       extents match the prim (±1 mm); datums equal hallDatums and the Hall.verticals defaults
//   (d) the viewer mesh-builder adapters (apps/web/src/viewer/geometry/primMeshes.ts) produce vertex-AABB unions equal to the prim-AABB
//       unions, per prim and per emitter (±1 mm)
//   (e) plan busway stroke width = 2 × prim halfW (G3)
//   (c) sheets 101 / 121 / 301 (integration r4): every rack rect maps back through viewports[0] to its prim (±1 mm); the 121 section
//       markers carry the 301 / 302 cuts (axis, position, look)
// Everything is generated in memory; nothing under data/ is read or written.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  analyzeProject, applyHallLayout, auditHallGeometry, cableRunPaths, chooseLayoutGrid, CORRIDOR_DEFAULTS, createNvidiaReferenceProject,
  defaultServicesZone, generateHallLayout, growHallToFit, layoutOptionsFromProject, nextPodIndex, normalizePlacement, notchKeepouts, resolveLayoutTemplate,
  rowEndWalls, roundUpToGrid, type DrawingCut, type EquipmentInstance, type HallLayoutOptions, type Prim, type Project, type ProjectAnalysis,
  createSheetContext, openDrawingSet, viewportPaperToWorld, viewportWorldToPaper, type DrawingViewport,
} from '../src/index.ts';
import { enlargedPlanCuts } from '../src/drawings/enlarged.ts';
import { blockingKeepouts, rowGroupsFromEquipment } from '../src/layout/rows.ts';
import { buildHallPrims, BUSWAY_W_M } from '../src/scene/build.ts';
import { hallDatums, resolveVerticals } from '../src/scene/datums.ts';
import { primAabb, type Aabb3, type HallPrims } from '../src/scene/prims.ts';
import { projectPlan } from '../src/scene/project/plan.ts';
import { projectSection } from '../src/scene/project/section.ts';
import { frameBox } from '../src/scene/project/ortho.ts';
import { fixtureHeight } from '../src/scene/shell.ts';
import {
  bodyAabbs, buswayParts, containmentParts, disposeParts, isObliquePrim, lightMatrix, lightStrips, lightUnitGeometry, pipeParts, powerPlaneParts, shellParts,
  sleeveParts, trayParts, vertexAabb, type MeshPart,
} from '../../../apps/web/src/viewer/geometry/primMeshes.ts';
import { createRefPodFixture } from './fixtures/ref-pod.ts';

const MM = 1e-3 + 1e-9;
const clone = <T,>(v: T): T => structuredClone(v);
const VIEWER_DIR = fileURLToPath(new URL('../../../apps/web/src/viewer', import.meta.url));

// ───────────────────────────── sweep ─────────────────────────────

/** LayoutPanel-like generation of hall A (auto grid or forced), other halls removed (as geometry-wall-audit.test.ts). */
function gen(pods: number, force?: { orientation: 'x' | 'y'; columns: number }): Project {
  const d = clone(createNvidiaReferenceProject().project);
  d.halls = d.halls.filter((h) => h.id === 'hall-a');
  const hall = d.halls[0];
  hall.itPowerBudgetKW = 1e9;
  hall.liquidCoolingBudgetKW = 1e9;
  hall.airCoolingBudgetKW = 1e9;
  const base = layoutOptionsFromProject(d, hall, {
    pods,
    podIndexStart: nextPodIndex(d, hall.id),
    services: { spineRacks: 'auto', storageRacks: 8, cpuRacks: 4, mgmtRacks: 2 },
    spinePlacement: normalizePlacement(d.network.scaleOut.spinePlacement),
    servicesZone: defaultServicesZone(d.growth),
  });
  const choice = chooseLayoutGrid(base, { mode: 'auto-size' });
  const orientation = force?.orientation ?? choice.orientation;
  const o = { ...base, orientation, columns: force?.columns ?? choice.columns, crahWalls: rowEndWalls(orientation) };
  const layout = growHallToFit(hall, o);
  notchKeepouts(layout, hall, CORRIDOR_DEFAULTS.egressM);
  applyHallLayout(d, hall.id, layout, o, { waveStart: 1 });
  return d;
}

/** Template hall at `pods` (as layout-templates.test.ts): stored trays / busways dropped → derived geometry. */
function template(templateId: string, pods: number, gpuRackCatalogId?: string): Project {
  const t = resolveLayoutTemplate(templateId)!;
  const p: Project = clone(createNvidiaReferenceProject({ pods: 1 }).project);
  const hall = p.halls[0];
  hall.itPowerBudgetKW = 1e9;
  hall.liquidCoolingBudgetKW = 1e9;
  hall.airCoolingBudgetKW = 1e9;
  p.site.utility.forEach((u) => (u.capacityMVA = 1e6));
  const opts: HallLayoutOptions = { hall, pods, template: { ...t.pod, ...(gpuRackCatalogId ? { gpuRackCatalogId } : {}) }, services: { spineRacks: 'auto', storageRacks: 2, cpuRacks: 1, mgmtRacks: 1 }, crahCatalogId: 'vertiv-cw375', crahs: 'auto', crahRedundancy: 'N+1', marginM: 1, podsPerWave: 2, spinePlacement: 'central-end', templateId: t.id };
  const probe = generateHallLayout(opts);
  hall.width = roundUpToGrid(probe.requiredWidth, 0.6);
  hall.depth = roundUpToGrid(probe.requiredDepth, 0.6);
  hall.keepouts = [];
  const layout = generateHallLayout(opts);
  p.equipment = layout.equipment;
  p.containments = layout.containments;
  p.trays = undefined;
  p.busways = undefined;
  p.network.scaleOut.switchCatalogId = t.pod.scaleOutSwitchCatalogId;
  p.cooling.cduCatalogId = t.pod.cduCatalogId;
  return p;
}

/** The reference hall mirrored across x = y: every row along Y, stored trays / busways dropped (G4 fallback for y rows). */
function yOriented(src: Project): Project {
  const q = clone(src);
  const rot = (r: EquipmentInstance['rotationDeg']) => ((270 - r + 360) % 360) as EquipmentInstance['rotationDeg'];
  const sw = (r: { x: number; y: number; w: number; d: number }) => ({ x: r.y, y: r.x, w: r.d, d: r.w });
  for (const h of q.halls) {
    [h.width, h.depth] = [h.depth, h.width];
    h.keepouts = h.keepouts.map((k) => ({ ...k, rect: sw(k.rect) }));
    if (h.layoutPolicy) h.layoutPolicy = { ...h.layoutPolicy, orientation: 'y' };
  }
  q.equipment = q.equipment.map((e) => ({ ...e, position: { x: e.position.y, y: e.position.x }, rotationDeg: rot(e.rotationDeg) }));
  q.containments = q.containments.map((c) => ({ ...c, rect: sw(c.rect) }));
  q.trays = undefined;
  q.busways = undefined;
  q.reservations = [];
  return q;
}

/** A row-along-y hall with a column standing on the main tray line between the rows and the services row (live hall B shape). */
function columnOnMainTray(): Project {
  const p = gen(2, { orientation: 'y', columns: 1 });
  const hall = p.halls[0];
  const main = (p.trays ?? []).filter((t) => t.hallId === hall.id && t.kind === 'main').sort((a, b) => b.points.length - a.points.length)[0];
  const y = main.points[0].y;
  // in the middle of the widest gap between two row-tray junctions on the main tray (live hall B: column C-2 between two junctions)
  const xs = [...new Set(rowGroupsFromEquipment(hall.id, p.equipment).filter((r) => r.axis === 'y').map((r) => Math.round((r.center + r.frontSign * 0.3) * 1e4) / 1e4))].sort((a, b) => a - b);
  let k = 0;
  for (let i = 1; i < xs.length - 1; i++) if (xs[i + 1] - xs[i] > xs[k + 1] - xs[k]) k = i;
  const x = (xs[k] + xs[k + 1]) / 2;
  hall.keepouts = [...hall.keepouts, { id: 'ko-a1-col', kind: 'column', rect: { x: x - 0.3, y: y - 0.15, w: 0.6, d: 0.6 }, label: 'Column on main tray' }];
  return p;
}

interface Case {
  name: string;
  project: Project;
  analysis: ProjectAnalysis | null;
}

const ref = createNvidiaReferenceProject().project;
const pod = createRefPodFixture();
const lazy = new Map<string, Case>();
const CASES: [string, () => Case][] = [
  ['reference', () => ({ name: 'reference', project: ref, analysis: analyzeProject(ref) })],
  ['ref-pod', () => ({ name: 'ref-pod', project: pod, analysis: null })],
  ['helios-2pod', () => ({ name: 'helios-2pod', project: template('std-orw-liquid-sidecar-du', 2, 'amd-helios-mi455x'), analysis: null })],
  ['y-oriented', () => ({ name: 'y-oriented', project: yOriented(ref), analysis: null })],
  ['rcu-row', () => ({ name: 'rcu-row', project: template('rcu-row', 2), analysis: null })],
  ['16-pod', () => ({ name: '16-pod', project: gen(16), analysis: null })],
];
const sweep = (name: string, build: () => Case) => {
  let c = lazy.get(name);
  if (!c) lazy.set(name, (c = build()));
  return c;
};
const hallsOf = (p: Project) => p.halls.filter((h) => p.equipment.some((e) => e.hallId === h.id));

const within = (a: number, b: number, tol = MM) => Math.abs(a - b) <= tol;
const boxDiff = (a: Aabb3, b: Aabb3) => Math.max(Math.abs(a.min.x - b.min.x), Math.abs(a.min.y - b.min.y), Math.abs(a.min.z - b.min.z), Math.abs(a.max.x - b.max.x), Math.abs(a.max.y - b.max.y), Math.abs(a.max.z - b.max.z));
const union = (boxes: Iterable<Aabb3>): Aabb3 | null => {
  let u: Aabb3 | null = null;
  for (const b of boxes) {
    if (!u) u = { min: { ...b.min }, max: { ...b.max } };
    else {
      u.min.x = Math.min(u.min.x, b.min.x);
      u.min.y = Math.min(u.min.y, b.min.y);
      u.min.z = Math.min(u.min.z, b.min.z);
      u.max.x = Math.max(u.max.x, b.max.x);
      u.max.y = Math.max(u.max.y, b.max.y);
      u.max.z = Math.max(u.max.z, b.max.z);
    }
  }
  return u;
};

// ───────────────────────────── (d) viewer parity ─────────────────────────────

/** Prims the 3D viewer draws as bodies (the slab and zero-height egress / reserve floor marks are drawn as decals only). */
const drawn = (p: Prim) => p.emitter !== 'slab' && !(p.emitter === 'room' && (p.layer === 'egress' || p.layer === 'reserves')) && p.emitter !== 'unit' && p.emitter !== 'rack';

function viewerParts(hp: HallPrims, clearHeight: number, paths: ProjectAnalysis['power']['paths']): MeshPart[] {
  return [
    ...trayParts(hp.prims, { rodTop: clearHeight }),
    ...buswayParts(hp.prims),
    ...pipeParts(hp.prims),
    ...powerPlaneParts(hp.prims, { paths: paths ?? [] }),
    ...sleeveParts(hp.prims),
    ...containmentParts(hp.prims),
    ...shellParts(hp.prims),
  ];
}

describe('T3 (d) viewer mesh adapters = prim AABBs (±1 mm)', () => {
  for (const [name, build] of CASES) {
    it(name, () => {
      const c = sweep(name, build);
      for (const hall of hallsOf(c.project)) {
        const hp = buildHallPrims(c.project, c.analysis, { hallId: hall.id, detail: 'pod' });
        const parts = viewerParts(hp, hall.clearHeight, c.analysis?.power.paths);
        const body = bodyAabbs(parts);
        const lights = lightStrips(hp.prims);
        const unit = lightUnitGeometry();
        for (const s of lights) body.set(s.primId, vertexAabb([unit], lightMatrix(s))!);
        unit.dispose();
        const ids = new Set(hp.prims.map((p) => p.id));
        for (const id of body.keys()) expect(ids.has(id), `${name}/${hall.id}: part for unknown prim ${id}`).toBe(true);
        const bad: string[] = [];
        const perEmitter = new Map<string, { prim: Aabb3[]; mesh: Aabb3[] }>();
        let oblique = 0;
        let checked = 0;
        for (const p of hp.prims) {
          if (!drawn(p)) continue;
          if (isObliquePrim(p)) {
            oblique++;
            continue;
          }
          const want = primAabb(p);
          const got = body.get(p.id);
          if (!got) {
            bad.push(`${p.id}: no mesh`);
            continue;
          }
          const d = boxDiff(want, got);
          if (d > MM) bad.push(`${p.id}: Δ ${d.toFixed(4)} m`);
          const key = `${p.emitter}/${p.layer}`;
          const e = perEmitter.get(key) ?? { prim: [], mesh: [] };
          e.prim.push(want);
          e.mesh.push(got);
          perEmitter.set(key, e);
          checked++;
        }
        expect(bad.slice(0, 12), `${name}/${hall.id}: ${bad.length} mismatches`).toEqual([]);
        for (const [key, e] of perEmitter) expect(boxDiff(union(e.prim)!, union(e.mesh)!), `${name}/${hall.id} union ${key}`).toBeLessThanOrEqual(MM);
        expect(oblique, `${name}/${hall.id}: oblique bars`).toBe(0);
        expect(checked).toBeGreaterThan(20);
        // the emitters the viewer migrated are all present in a hall with racks
        for (const em of ['tray', 'busway', 'wall', 'light', 'ceiling'] as const) expect(perEmitter.size && [...perEmitter.keys()].some((k) => k.startsWith(`${em}/`)), `${name}/${hall.id} ${em}`).toBe(true);
        disposeParts(parts);
      }
    }, 120_000);
  }

  it('G1: no viewer-side row detector or run derivation is left (drawings/scene.ts is stream B, reported only)', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const full = join(dir, f);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(f)) files.push(full);
      }
    };
    walk(VIEWER_DIR);
    const hits = files.filter((f) => /function (detectRows|deriveRuns)\b/.test(readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
    const scene = fileURLToPath(new URL('../src/drawings/scene.ts', import.meta.url));
    if (existsSync(scene) && /function (detectRows|deriveRuns)\b/.test(readFileSync(scene, 'utf8'))) console.warn('[T3 G1] drawings/scene.ts still has detectRows / deriveRuns (stream B consumers; integrator note)');
  });
});

// ───────────────────────────── (a) plan, (e) busway stroke ─────────────────────────────

const PLAN_EMITTERS = new Set<Prim['emitter']>(['rack', 'busway', 'tray', 'drop', 'pipe', 'tapoff']);

describe('T3 (a) plan xy = prim (±1 mm), (e) busway stroke = 2 × halfW', () => {
  for (const [name, build] of CASES) {
    it(name, () => {
      const c = sweep(name, build);
      for (const hall of hallsOf(c.project)) {
        const hp = buildHallPrims(c.project, c.analysis, { hallId: hall.id, detail: 'pod' });
        const list = projectPlan(hp);
        const byPrim = new Map(list.items.filter((i) => i.primId).map((i) => [i.primId!, i]));
        const bad: string[] = [];
        let n = 0;
        let busways = 0;
        for (const p of hp.prims) {
          if (!PLAN_EMITTERS.has(p.emitter)) continue;
          const it = byPrim.get(p.id);
          if (!it) {
            bad.push(`${p.id}: missing`);
            continue;
          }
          const b = primAabb(p);
          let x0: number, y0: number, x1: number, y1: number;
          if (it.kind === 'rect') [x0, y0, x1, y1] = [it.pts[0], it.pts[1], it.pts[0] + it.pts[2], it.pts[1] + it.pts[3]];
          else if (it.kind === 'circle') [x0, y0, x1, y1] = [it.pts[0] - it.pts[2], it.pts[1] - it.pts[2], it.pts[0] + it.pts[2], it.pts[1] + it.pts[2]];
          else {
            const xs = it.pts.filter((_, k) => k % 2 === 0);
            const ys = it.pts.filter((_, k) => k % 2 === 1);
            [x0, y0, x1, y1] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
            // oblique: the exact footprint (a, b ± the perpendicular half width)
            const len = Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y);
            const px = Math.abs(((p.b.y - p.a.y) / len) * p.halfW);
            const py = Math.abs(((p.b.x - p.a.x) / len) * p.halfW);
            b.min.x = Math.min(p.a.x, p.b.x) - px;
            b.max.x = Math.max(p.a.x, p.b.x) + px;
            b.min.y = Math.min(p.a.y, p.b.y) - py;
            b.max.y = Math.max(p.a.y, p.b.y) + py;
          }
          if (!(within(x0, b.min.x) && within(y0, b.min.y) && within(x1, b.max.x) && within(y1, b.max.y))) bad.push(`${p.id}: plan [${x0},${y0},${x1},${y1}] vs prim [${b.min.x},${b.min.y},${b.max.x},${b.max.y}]`);
          if (p.emitter === 'busway' && it.kind === 'rect') {
            busways++;
            expect(p.halfW).toBe(BUSWAY_W_M / 2);
            expect(within(Math.min(it.pts[2], it.pts[3]), 2 * p.halfW, 1e-6), `${p.id} stroke`).toBe(true);
          }
          n++;
        }
        expect(bad.slice(0, 10), `${name}/${hall.id}: ${bad.length}`).toEqual([]);
        expect(n).toBeGreaterThan(10);
        expect(busways, `${name}/${hall.id} busways`).toBeGreaterThan(0);
      }
    }, 120_000);
  }
});

// ───────────────────────────── (b) sections ─────────────────────────────

/** 301 transverse cut per pod (plane ⟂ the row axis through the pod centre) and 302 longitudinal cut per row (plane on the row centre). */
function generatedCuts(hp: HallPrims): DrawingCut[] {
  const cuts: DrawingCut[] = [];
  const pods = new Map<string, { axis: 'x' | 'y'; a0: number; a1: number }>();
  for (const r of hp.rows) {
    const key = `${r.podId ?? r.id}|${r.axis}`;
    const q = pods.get(key);
    if (q) {
      q.a0 = Math.min(q.a0, r.a0);
      q.a1 = Math.max(q.a1, r.a1);
    } else pods.set(key, { axis: r.axis, a0: r.a0, a1: r.a1 });
    cuts.push({ id: `L-${r.id}`, label: `L ${r.id}`, hallId: hp.hallId, axis: r.axis === 'x' ? 'y' : 'x', at: r.center, look: 1, depthM: 1.2 });
  }
  for (const [key, q] of pods) cuts.push({ id: `T-${key}`, label: `T ${key}`, hallId: hp.hallId, axis: q.axis, at: Math.round(((q.a0 + q.a1) / 2) * 1e4) / 1e4 + 0.0137, look: -1, depthM: 1.2 });
  return cuts;
}

const FLOOR_MARKS = new Set(['hall-outline', 'egress', 'reserves']);

describe('T3 (b) section u / z extents = prim (±1 mm); datums = hallDatums + Hall.verticals defaults', () => {
  for (const [name, build] of CASES) {
    it(name, () => {
      const c = sweep(name, build);
      for (const hall of hallsOf(c.project)) {
        const hp = buildHallPrims(c.project, c.analysis, { hallId: hall.id, detail: 'pod' });
        // datums
        expect(hp.datums).toEqual(hallDatums(hall, hp.prims, hall.verticals));
        const z = (id: string) => hp.datums.find((d) => d.id === id)?.z;
        const rackH = Math.max(...hp.prims.filter((p) => p.emitter === 'rack').map((p) => p.b.z - p.a.z));
        const rv = resolveVerticals(hall, rackH, hall.verticals);
        expect(rv.explicitTiers).toBe(false);
        const zt = hall.trayHeight > 0 ? hall.trayHeight : 2.9;
        expect(within(z('T1')!, zt)).toBe(true);
        expect(within(z('T2')!, zt + 0.35)).toBe(true);
        expect(within(z('busway')!, Math.min(zt - 0.22, rackH + 0.4))).toBe(true);
        if (hp.prims.some((p) => p.emitter === 'pipe')) {
          expect(within(z('pipe')!, rackH + 0.22)).toBe(true);
          // the horizontal row-header segments sit on their datum (risers, CDU links and the raised return cross header do not)
          const rowHeaders = hp.prims.filter((q) => q.emitter === 'pipe' && q.meta?.part === 'row' && Math.abs(q.a.z - q.b.z) < 1e-9);
          expect(rowHeaders.length).toBeGreaterThan(0);
          // T1b R2: when the rear lane is too narrow the return header is stacked directly above the supply header of its row
          // (same plan line, clear of the supply tube, below the T2 tier; plan-separated from the T1 tray) — every other row header sits on the pipe datum
          const od = (q: Prim) => Number(q.meta?.odM ?? 2 * q.halfW);
          const stackedOver = (p: Prim) =>
            p.system === 'cdu-return' && p.a.z + od(p) / 2 < z('T2')! &&
            rowHeaders.some((s) => s.system === 'cdu-supply' && s.rowId === p.rowId && within(s.a.z, z('pipe')!) && p.a.z - s.a.z >= (od(p) + od(s)) / 2 - 1e-3 &&
              (Math.abs(p.a.x - p.b.x) < 1e-6 ? Math.abs(s.a.x - p.a.x) < 1e-3 && Math.abs(s.b.x - s.a.x) < 1e-6 : Math.abs(s.a.y - p.a.y) < 1e-3 && Math.abs(s.b.y - s.a.y) < 1e-6));
          for (const p of rowHeaders) expect(within(p.a.z, z('pipe')!) || stackedOver(p), `${p.id} z ${p.a.z}`).toBe(true);
          // one derivation: every segment of every run of HallPrims.pipes is a pipe prim (pod detail), every fitting a fitting prim
          const ids = new Set(hp.prims.map((p) => p.id));
          for (const run of hp.pipes!.runs) {
            const segs = run.points.slice(1).filter((q, i) => Math.hypot(q.x - run.points[i].x, q.y - run.points[i].y, q.z - run.points[i].z) >= 1e-6).length;
            const got = hp.prims.filter((p) => p.emitter === 'pipe' && p.meta?.runId === run.id).length;
            expect(got, `${name}/${hall.id} ${run.id}`).toBe(segs);
          }
          for (const f of hp.pipes!.fittings) expect(ids.has(`fitting:${f.id}`), f.id).toBe(true);
        }
        expect(within(z('ceiling')!, hall.clearHeight)).toBe(true);
        expect(within(z('rack-top')!, Math.max(...hp.prims.filter((p) => p.emitter === 'rack').map((p) => p.b.z)))).toBe(true);
        if (hp.prims.some((p) => p.emitter === 'light')) expect(within(z('light')!, fixtureHeight(hall))).toBe(true);
        for (const p of hp.prims.filter((q) => q.emitter === 'busway')) expect(within(p.a.z, z('busway')!, 0.02) || hall.id !== hp.hallId, `${p.id} z ${p.a.z}`).toBe(true);
        // sections
        const cuts = generatedCuts(hp);
        expect(cuts.length).toBeGreaterThan(1);
        const bad: string[] = [];
        let cutItems = 0;
        for (const cut of cuts) {
          const list = projectSection(hp, cut, { depth: 'next-row' });
          const cutsByPrim = new Map<string, (typeof list.items)[number]>();
          for (const it of list.items) if (it.role === 'cut' && it.primId) cutsByPrim.set(it.primId, it);
          for (const p of hp.prims) {
            if (FLOOR_MARKS.has(p.layer)) continue;
            const m = frameBox(cut, primAabb(p));
            if (!(m.s0 <= 1e-9 && m.s1 >= -1e-9)) continue;
            const it = cutsByPrim.get(p.id);
            if (!it) {
              bad.push(`${cut.id} ${p.id}: not cut`);
              continue;
            }
            cutItems++;
            if (it.kind === 'rect') {
              if (!(within(it.pts[0], m.u0) && within(it.pts[1], m.z0) && within(it.pts[0] + it.pts[2], m.u1) && within(it.pts[1] + it.pts[3], m.z1))) bad.push(`${cut.id} ${p.id}: rect ${it.pts.join(',')} vs u ${m.u0}..${m.u1} z ${m.z0}..${m.z1}`);
            } else if (it.kind === 'circle') {
              if (!(within(it.pts[0], (m.u0 + m.u1) / 2) && within(it.pts[1], (m.z0 + m.z1) / 2) && within(2 * it.pts[2], m.z1 - m.z0))) bad.push(`${cut.id} ${p.id}: circle ${it.pts.join(',')}`);
            } else if (it.kind === 'polyline') {
              if (!(within(Math.min(it.pts[0], it.pts[2]), m.u0) && within(Math.max(it.pts[0], it.pts[2]), m.u1) && within(it.pts[1], m.z0) && within(it.pts[3], m.z1))) bad.push(`${cut.id} ${p.id}: line ${it.pts.join(',')}`);
            } else bad.push(`${cut.id} ${p.id}: kind ${it.kind}`);
          }
        }
        expect(bad.slice(0, 10), `${name}/${hall.id}: ${bad.length}`).toEqual([]);
        expect(cutItems).toBeGreaterThan(20);
      }
    }, 120_000);
  }
});

// ───────────────────────────── (c) sheet viewports ─────────────────────────────

type PaperR = { x: number; y: number; w: number; h: number; prim?: string };
const RECT_RE = /<rect x="(-?[\d.]+)" y="(-?[\d.]+)" width="([\d.]+)" height="([\d.]+)"([^>]*)>/g;
const svgRects = (svg: string): PaperR[] => [...svg.matchAll(RECT_RE)].map((m) => ({ x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]), prim: /data-prim="([^"]+)"/.exec(m[5])?.[1] }));
/** 1 mm in the world plus the 0.001 mm paper rounding of the SVG writer at this viewport's scale */
const vpTol = (vp: DrawingViewport) => MM + 1e-3 / vp.mmPerM;
const inPaper = (vp: DrawingViewport, r: PaperR) => r.x >= vp.paperRect.x - 1e-6 && r.y >= vp.paperRect.y - 1e-6 && r.x + r.w <= vp.paperRect.x + vp.paperRect.w + 1e-6 && r.y + r.h <= vp.paperRect.y + vp.paperRect.h + 1e-6;
/** paper rect → [x0, y0, x1, y1] (plan) or [u0, z0, u1, z1] (section) through the viewport inverse map */
const rectToWorld = (vp: DrawingViewport, r: PaperR) => {
  const [x0, y0] = viewportPaperToWorld(vp, r.x, r.y + r.h);
  const [x1, y1] = viewportPaperToWorld(vp, r.x + r.w, r.y);
  return [x0, y0, x1, y1];
};
const maxDiff = (a: number[], b: number[]) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

describe('T3 (c) sheets 101 / 121 / 301: viewports[0] inverse map of rack rects → world (±1 mm)', () => {
  for (const [name, build] of CASES) {
    it(name, () => {
      const c = sweep(name, build);
      const set = openDrawingSet(c.project, c.analysis, { sheets: ['plan', 'enlarged-plan', 'section'], date: '2026-09-15' });
      const n = { plan: 0, enlarged: 0, section: 0 };
      const bad: string[] = [];
      for (const hall of hallsOf(c.project)) {
        const hpHall = buildHallPrims(c.project, c.analysis, { hallId: hall.id, detail: 'hall' });
        const hpPod = buildHallPrims(c.project, c.analysis, { hallId: hall.id, detail: 'pod' });
        const podPrims = new Map(hpPod.prims.map((p) => [p.id, p]));
        // 101: the base plan draws every rack footprint (no data-prim); find the rect through the forward map, then map it back
        const plan = set.sheets.find((m) => m.id === `plan-${hall.id}`);
        if (plan) {
          const s = set.build(plan.id);
          const vp = s.viewports![0];
          expect(vp.space).toBe('plan');
          expect(vp.hallId).toBe(hall.id);
          const rs = svgRects(s.svg);
          for (const p of hpHall.prims.filter((q) => q.emitter === 'rack')) {
            const [px0, py1] = viewportWorldToPaper(vp, p.a.x, p.a.y);
            const [px1, py0] = viewportWorldToPaper(vp, p.b.x, p.b.y);
            const hit = rs.find((r) => Math.abs(r.x - px0) < 0.01 && Math.abs(r.y - py0) < 0.01 && Math.abs(r.w - (px1 - px0)) < 0.01 && Math.abs(r.h - (py1 - py0)) < 0.01);
            if (!hit) {
              bad.push(`101 ${p.id}: no rect`);
              continue;
            }
            const d = maxDiff(rectToWorld(vp, hit), [p.a.x, p.a.y, p.b.x, p.b.y]);
            if (d > vpTol(vp)) bad.push(`101 ${p.id}: Δ ${d.toFixed(5)} m`);
            n.plan++;
          }
        }
        // 121: rack rects of the sheet's own pod (inside the window by construction)
        for (const m of set.sheets.filter((q) => q.kind === 'enlarged-plan' && q.hallId === hall.id).slice(0, 3)) {
          const s = set.build(m.id);
          const vp = s.viewports![0];
          expect(vp.space).toBe('plan');
          for (const r of svgRects(s.svg)) {
            const p = r.prim ? podPrims.get(r.prim) : undefined;
            if (!p || p.emitter !== 'rack' || p.podId !== m.group?.podId || !inPaper(vp, r)) continue;
            const d = maxDiff(rectToWorld(vp, r), [p.a.x, p.a.y, p.b.x, p.b.y]);
            if (d > vpTol(vp)) bad.push(`${m.number} ${p.id}: Δ ${d.toFixed(5)} m`);
            n.enlarged++;
          }
        }
        // 301: cut / beyond rack rects of the pod in the main 1:50 viewport → (u, z) = frameBox of the prim
        for (const m of set.sheets.filter((q) => q.id.startsWith(`section-t-${hall.id}-`)).slice(0, 3)) {
          const s = set.build(m.id);
          const vp = s.viewports![0];
          const cut = vp.cut!;
          expect(vp.space).toBe('section');
          for (const r of svgRects(s.svg)) {
            const p = r.prim ? podPrims.get(r.prim) : undefined;
            if (!p || p.emitter !== 'rack' || p.podId !== m.group?.podId || !inPaper(vp, r)) continue;
            const fb = frameBox(cut, primAabb(p));
            const d = maxDiff(rectToWorld(vp, r), [fb.u0, fb.z0, fb.u1, fb.z1]);
            if (d > vpTol(vp)) bad.push(`${m.number} ${p.id}: Δ ${d.toFixed(5)} m`);
            n.section++;
          }
        }
      }
      expect(bad.slice(0, 10), `${name}: ${bad.length} (${JSON.stringify(n)})`).toEqual([]);
      expect(n.plan, name).toBeGreaterThan(0);
      if (set.sheets.some((m) => m.kind === 'enlarged-plan')) expect(n.enlarged, name).toBeGreaterThan(0);
      if (set.sheets.some((m) => m.id.startsWith('section-t-'))) expect(n.section, name).toBeGreaterThan(0);
    }, 120_000);
  }

  it('reference: the 121 section markers carry the 301 / 302 cuts (axis, position ±1 mm, look)', () => {
    const c = sweep('reference', CASES[0][1]);
    const opts = { sheets: ['enlarged-plan', 'section'] as const };
    const set = openDrawingSet(c.project, c.analysis, { sheets: [...opts.sheets] });
    const ctx = createSheetContext(c.project, c.analysis, { sheets: [...opts.sheets] });
    let checked = 0;
    for (const hall of hallsOf(c.project)) {
      const hp = buildHallPrims(c.project, c.analysis, { hallId: hall.id, detail: 'pod' });
      for (const podId of [...new Set(hp.rows.map((r) => r.podId).filter((x): x is string => !!x))]) {
        const cuts = enlargedPlanCuts(ctx, hall, podId);
        const t = set.sheets.find((m) => m.id.startsWith(`section-t-${hall.id}-`) && m.group?.podId === podId);
        if (!t || !cuts.length) continue;
        const tc = set.build(t.id).viewports![0].cut!;
        expect([cuts[0].cut.axis, cuts[0].cut.look]).toEqual([tc.axis, tc.look]);
        expect(within(cuts[0].cut.at, tc.at), `${podId} transverse at`).toBe(true);
        checked++;
        for (const lc of cuts.slice(1)) {
          const rowId = lc.cut.id.replace(/^cut-l-/, '');
          const l = set.sheets.find((m) => m.id.startsWith(`section-l-${hall.id}-`) && m.group?.rowId === rowId);
          if (!l) continue;
          const lcut = set.build(l.id).viewports![0].cut!;
          expect([lc.cut.axis, lc.cut.look], rowId).toEqual([lcut.axis, lcut.look]);
          expect(within(lc.cut.at, lcut.at), `${rowId} longitudinal at`).toBe(true);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(4);
  });
});

// ───────────────────────────── cable bundles × columns (W8 open issue) ─────────────────────────────

describe('cable bundles dodge interior columns; the wall audit reads the prims', () => {
  it('a column on the main tray line: no bundle segment passes through it, and the audit reports no cable-through-keepout', () => {
    const p = columnOnMainTray();
    const hall = p.halls[0];
    const a = analyzeProject(p);
    const eq = p.equipment.filter((e) => e.hallId === hall.id);
    const geo = cableRunPaths(hall, eq, a.network.cableRuns, p.trays, { allEquipment: p.equipment, trunkSleeves: a.network.penetrations });
    expect(geo.paths.length).toBeGreaterThan(10);
    const col = blockingKeepouts(hall.keepouts, 0.05).find((r) => r.x > 0.5 && r.y > 0.5)!;
    let dodged = 0;
    for (const c of geo.paths) {
      for (let i = 0; i < c.points.length - 1; i++) {
        const s = c.points[i];
        const t = c.points[i + 1];
        const x0 = Math.min(s.x, t.x) - c.radius;
        const x1 = Math.max(s.x, t.x) + c.radius;
        const y0 = Math.min(s.y, t.y) - c.radius;
        const y1 = Math.max(s.y, t.y) + c.radius;
        const ox = Math.min(x1, col.x + col.w) - Math.max(x0, col.x);
        const oy = Math.min(y1, col.y + col.d) - Math.max(y0, col.y);
        expect(ox > 0.005 && oy > 0.005, `${c.runId} segment ${i} crosses the column ${JSON.stringify(col)} r ${c.radius} pts ${JSON.stringify(c.points)}`).toBe(false);
      }
      if (c.points.some((q) => Math.abs(q.x - col.x) < 0.2 || Math.abs(q.x - (col.x + col.w)) < 0.2)) dodged++;
    }
    expect(dodged).toBeGreaterThan(0);
    const hp = buildHallPrims(p, a, { hallId: hall.id, detail: 'pod' });
    const viaPrims = auditHallGeometry(p, a, hall.id, { prims: hp });
    expect(viaPrims.counts['cable-through-keepout'] ?? 0).toBe(0);
    expect(auditHallGeometry(p, a, hall.id)).toEqual(viaPrims);
  }, 120_000);
});
