import { describe, expect, it } from 'vitest';
import {
  analyzeCooling, analyzeProject, coolingLoopsFor, createNvidiaReferenceProject, DEFAULT_COOLING_PLACEMENT, findCatalogItem, generateHallLayout, layoutOptionsFromProject, regenerateCooling, regenerateCoolingReport, regenerateHallWithCooling,
  TCS_LOOP_BUDGET_M, TCS_LOOP_WARN_M, type CoolingPlacementOptions, type Project,
} from '../src/index.ts';

/** "Regenerate cooling only" (stream T1, DECISIONS-v2-2 F8, r2-layout.md §3) — the engine behind T4's cooling placement section. */

const cat = (p: Project, id: string) => findCatalogItem(p.equipment.find((e) => e.id === id)!.catalogId)?.category;
const cdusOf = (p: Project, hallId = 'hall-a') => p.equipment.filter((e) => e.hallId === hallId && findCatalogItem(e.catalogId)?.category === 'cdu');
const crahsOf = (p: Project, hallId = 'hall-a') => p.equipment.filter((e) => e.hallId === hallId && findCatalogItem(e.catalogId)?.category === 'crah');
const nonCooling = (p: Project) => p.equipment.filter((e) => !['cdu', 'crah', 'fan-wall'].includes(findCatalogItem(e.catalogId)?.category ?? ''));
const opts = (o: Partial<CoolingPlacementOptions>): CoolingPlacementOptions => ({ ...DEFAULT_COOLING_PLACEMENT, crahWalls: ['W', 'E'], ...o });

describe('regenerateCooling', () => {
  const { project } = createNvidiaReferenceProject();
  const before = JSON.stringify(project);

  it('row-ends / auto: new project, input untouched, every non-cooling item keeps id and position, opts stored', () => {
    const r = regenerateCoolingReport(project, 'hall-a', opts({}));
    expect(JSON.stringify(project)).toBe(before);
    expect(r.project).not.toBe(project);
    expect(r.project.halls[0].coolingPlacement).toEqual(opts({}));
    const a = new Map(nonCooling(project).map((e) => [e.id, e.position]));
    const b = new Map(nonCooling(r.project).map((e) => [e.id, e.position]));
    expect([...b.keys()].sort()).toEqual([...a.keys()].sort());
    for (const [id, pos] of a) expect(b.get(id), id).toEqual(pos);
    expect(r.shiftedRows).toEqual([]);
    // counts: cooling engine rule per pod (liquid ÷ CDU capacity + N+1) and its CRAH requirement
    expect(r.cdu.placed).toBe(r.cdu.required);
    expect(r.crah.placed).toBe(r.crah.required);
    const cool = analyzeCooling({ ...r.project, trays: undefined, busways: undefined });
    for (const pod of cool.perPod ?? []) if (pod.liquidKW > 0) expect(pod.cdusPlaced, pod.podId).toBe(pod.cdusRequired);
    expect(r.issues.filter((i) => i.severity === 'error')).toEqual([]);
    // CDUs sit at both ends of the pod rows
    const pod1 = cdusOf(r.project).filter((e) => e.podId === 'pod-01');
    const racksX = r.project.equipment.filter((e) => e.podId === 'pod-01' && cat(r.project, e.id) === 'gpu-rack').map((e) => e.position.x);
    expect(pod1.some((e) => e.position.x < Math.min(...racksX))).toBe(true);
    expect(pod1.every((e) => e.position.x < Math.min(...racksX) || e.position.x > Math.max(...racksX))).toBe(true);
    const a2 = analyzeProject({ ...r.project, trays: undefined, busways: undefined });
    expect(a2.issues.filter((i) => i.severity === 'error' && (i.domain === 'space' || i.domain === 'layout' || i.domain === 'cooling')).map((i) => i.id)).toEqual([]);
  });

  it('manual counts: 2 CDUs per pod, 12 CRAHs', () => {
    const p = regenerateCooling(project, 'hall-a', opts({ cduPerPod: 2, crahCount: 12 }));
    for (const pod of ['pod-01', 'pod-02', 'pod-03', 'pod-04']) expect(cdusOf(p).filter((e) => e.podId === pod).length).toBe(2);
    expect(crahsOf(p).length).toBe(12);
  });

  it('ends-center: a centre CDU between the two rack halves; rows of the column shift consistently', () => {
    const r = regenerateCoolingReport(project, 'hall-a', opts({ cduPlacement: 'ends-center' }));
    const nofit = r.issues.find((i) => i.id.startsWith('layout-cooling-center-nofit'));
    if (nofit) {
      expect(r.shiftedRows).toEqual([]);
      return;
    }
    expect(r.shiftedRows.length).toBeGreaterThan(0);
    const row = 'pod-01-a';
    const racks = r.project.equipment.filter((e) => e.rowId === row && cat(r.project, e.id) === 'gpu-rack').map((e) => e.position.x).sort((a, b) => a - b);
    const cdus = cdusOf(r.project).filter((e) => e.rowId === row).map((e) => e.position.x);
    expect(cdus.some((x) => x > racks[5] && x < racks[6])).toBe(true);
    // every shifted row moved its second half by the same distance
    const shift = (p: Project, rowId: string) => {
      const orig = project.equipment.filter((e) => e.rowId === rowId && cat(project, e.id) === 'gpu-rack').map((e) => e.position.x).sort((a, b) => a - b);
      const now = p.equipment.filter((e) => e.rowId === rowId && cat(p, e.id) === 'gpu-rack').map((e) => e.position.x).sort((a, b) => a - b);
      return +(now[now.length - 1] - orig[orig.length - 1]).toFixed(6);
    };
    const shifts = new Set(r.shiftedRows.map((id) => shift(r.project, id)));
    expect(shifts.size).toBe(1);
    // the pod containment grew with the rows; nothing overlaps
    const a = analyzeProject({ ...r.project, trays: undefined, busways: undefined });
    expect(a.issues.filter((i) => i.severity === 'error' && (i.domain === 'space' || i.domain === 'layout')).map((i) => i.id)).toEqual([]);
  });

  it('gallery: CDUs against the row-end wall, grouped ≤ 2 pods, loop lengths within the budget', () => {
    const r = regenerateCoolingReport(project, 'hall-a', opts({ cduPlacement: 'gallery', cduGalleryWall: 'W' }));
    const g = cdusOf(r.project);
    expect(g.length).toBe(r.cdu.required);
    expect(g.length).toBeGreaterThan(0);
    expect(g.every((e) => e.meta?.gallery === true && !e.rowId)).toBe(true);
    expect(new Set(g.map((e) => e.meta?.group)).size).toBe(2);
    const racks = r.project.equipment.filter((e) => cat(r.project, e.id) === 'gpu-rack').map((e) => e.position.x);
    expect(Math.max(...g.map((e) => e.position.x))).toBeLessThan(Math.min(...racks));
    expect(r.loops.length).toBe(4);
    for (const l of r.loops) expect(l.equivalentM).toBeGreaterThan(0);
    expect(r.cdu.galleryWall).toBe('W');
    // CRAHs on the gallery wall sit in front of the CDU strip, never on it
    const crahW = crahsOf(r.project).filter((e) => e.rotationDeg === 270);
    for (const c of crahW) expect(c.position.x).toBeGreaterThan(Math.max(...g.map((e) => e.position.x)));
  });

  it('gallery on a side wall of a long single-column hall → secondary loop beyond the hydraulic budget is reported', () => {
    const { project: p8 } = createNvidiaReferenceProject({ pods: 8 });
    const r = regenerateCoolingReport(p8, 'hall-a', opts({ cduPlacement: 'gallery', cduGalleryWall: 'S' }));
    const worst = Math.max(...r.loops.map((l) => l.equivalentM));
    expect(worst).toBeGreaterThan(TCS_LOOP_WARN_M.value);
    expect(r.issues.some((i) => i.id.startsWith('layout-cooling-loop-'))).toBe(true);
    if (worst > TCS_LOOP_BUDGET_M.value) expect(r.issues.some((i) => i.id.startsWith('layout-cooling-loop-') && i.severity === 'error')).toBe(true);
    // validate.ts raises the same issue in the full analysis
    const a = analyzeProject({ ...r.project, trays: undefined, busways: undefined });
    expect(a.issues.some((i) => i.id.startsWith('layout-cooling-loop-'))).toBe(true);
    expect(coolingLoopsFor(r.project, 'hall-a').length).toBe(8);
  });

  it('per-pod CRAH strategy: when the rows cannot hold the units the input is returned unchanged and a hall regeneration places them', () => {
    // fix v2 2차 (QA): per-pod placed 2 of 10 CRAHs on generated halls and the panel applied it — never a partial apply
    const r = regenerateCoolingReport(project, 'hall-a', opts({ crahStrategy: 'per-pod', crahCount: 8 }));
    if (r.requiresRegenerate) {
      expect(r.project).toBe(project);
      expect(r.issues.some((i) => i.severity === 'error' && i.id.startsWith('layout-crah-short'))).toBe(true);
      const regen = regenerateHallWithCooling(project, 'hall-a', opts({ crahStrategy: 'per-pod', crahCount: 8 }));
      const c = crahsOf(regen);
      expect(c.length).toBeGreaterThanOrEqual(8);
      expect(c.every((e) => !!e.rowId)).toBe(true);
    } else {
      const c = crahsOf(r.project);
      expect(c.length).toBe(r.crah.placed);
      expect(r.crah.placed).toBeGreaterThanOrEqual(r.crah.required);
      expect(c.every((e) => !!e.rowId)).toBe(true);
    }
  });

  it('unknown hall → the input project', () => {
    expect(regenerateCooling(project, 'nope', opts({}))).toBe(project);
  });
});

describe('generateHallLayout honours hall.coolingPlacement', () => {
  const { project } = createNvidiaReferenceProject();
  const hall = project.halls[0];

  it('manual CDUs per pod at both row ends', () => {
    const o = layoutOptionsFromProject(project, { ...hall, coolingPlacement: opts({ cduPerPod: 4 }) });
    const l = generateHallLayout({ ...o, hall: { ...o.hall, coolingPlacement: opts({ cduPerPod: 4 }) } });
    const cdus = l.equipment.filter((e) => findCatalogItem(e.catalogId)?.category === 'cdu');
    expect(cdus.length).toBe(16);
    const row = l.equipment.filter((e) => e.rowId === 'pod-01-a').sort((a, b) => a.position.x - b.position.x);
    expect(findCatalogItem(row[0].catalogId)?.category).toBe('cdu');
    expect(findCatalogItem(row[row.length - 1].catalogId)?.category).toBe('cdu');
  });

  it('gallery: no in-row CDU slots, a gallery strip on the chosen wall, hall grows by the strip', () => {
    const cp = opts({ cduPlacement: 'gallery', cduGalleryWall: 'W' });
    const base = layoutOptionsFromProject(project, hall);
    const plain = generateHallLayout({ ...base, hall: { ...hall, width: 0, depth: 0, keepouts: [] } });
    const l = generateHallLayout({ ...base, hall: { ...hall, width: 0, depth: 0, keepouts: [], coolingPlacement: cp } });
    const cdus = l.equipment.filter((e) => findCatalogItem(e.catalogId)?.category === 'cdu');
    expect(cdus.length).toBeGreaterThan(0);
    expect(cdus.every((e) => e.meta?.gallery === true && !e.rowId)).toBe(true);
    expect(l.issues.filter((i) => i.severity === 'error')).toEqual([]);
    // no CDU slots in the rows → shorter rows; the gallery strip adds its depth on the W side
    expect(l.grid.rowLengthM).toBeLessThan(plain.grid.rowLengthM);
    const minRackX = Math.min(...l.equipment.filter((e) => findCatalogItem(e.catalogId)?.category === 'gpu-rack').map((e) => e.position.x));
    expect(Math.max(...cdus.map((e) => e.position.x))).toBeLessThan(minRackX);
  });
});
