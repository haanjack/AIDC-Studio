// Polish round v2 2차 — layout & cooling placement engine (docs/research/polish-layout-v2-2.md).
import { describe, expect, it } from 'vitest';
import {
  analyzeProject, applyHallLayout, chooseLayoutGrid, FREE_WALL_AREA_TOLERANCE, coolingPlacementFor, createNvidiaReferenceProject, defaultServicesZone, defaultSpinePlacement, findCatalogItem, footprintRect, generateHallLayout,
  growHallToFit, layoutOptionsFromProject, nextPodIndex, regenerateCooling, regenerateCoolingReport, rowEndWalls,
  type GrowthPattern, type Project,
} from '../src/index.ts';

const cat = (id: string) => findCatalogItem(id)?.category ?? '';
const SERVICES = { spineRacks: 'auto' as const, storageRacks: 8, cpuRacks: 4, mgmtRacks: 2 };

function setup(pods: number, growth: GrowthPattern, size?: { w: number; d: number }) {
  const { project } = createNvidiaReferenceProject();
  const d: Project = structuredClone(project);
  d.growth = growth;
  d.network.scaleOut.spinePlacement = defaultSpinePlacement(growth);
  const hall = d.halls.find((h) => h.id === 'hall-a')!;
  hall.width = size?.w ?? 0;
  hall.depth = size?.d ?? 0;
  hall.keepouts = [];
  const base = layoutOptionsFromProject(d, hall, { pods, podIndexStart: nextPodIndex(d, hall.id), services: SERVICES, spinePlacement: defaultSpinePlacement(growth), servicesZone: defaultServicesZone(growth) });
  return { d, hall, base };
}

describe('polish v2 2차 — layout', () => {
  // tolerance: 0.5 % of area (the chooser now predicts with growHallToFit itself; measured worst excess 0.03 % with calibration)
  it('auto-size growth matches the chooser: grown area ≤ chosen candidate + 0.5 % and ≤ minimum-area candidate within 2:1 + 1.5 % (1 % chooser tie), DU 1–40 × phased / single-build', { timeout: 120_000 }, () => {
    const bad: string[] = [];
    for (const growth of ['phased', 'single-build'] as const)
      for (let du = 1; du <= 40; du++) {
        const { hall, base } = setup(du, growth);
        const choice = chooseLayoutGrid(base, { mode: 'auto-size' });
        const within0 = choice.candidates.filter((c) => c.aspect <= choice.targetAspect + 1e-6);
        // qa-autosize v2 2차: the chooser only picks among the in-reach grids when there are any
        const within = within0.some((c) => c.reachOk) ? within0.filter((c) => c.reachOk) : within0;
        const minA = Math.min(...(within.length ? within : choice.candidates).map((c) => c.areaM2));
        growHallToFit(hall, { ...base, orientation: choice.orientation, columns: choice.columns, crahWalls: rowEndWalls(choice.orientation) });
        const area = hall.width * hall.depth;
        // growth = the chosen candidate's predicted hall (+0.5 %), and the chosen candidate is inside the chooser's 1 % area tie (auto-min-area)
        // qa-autosize v2 2차 (§3): a grid that leaves a wall free for the electrical rooms may cost up to FREE_WALL_AREA_TOLERANCE extra area
        const tol = choice.reason === 'auto-free-wall' ? 1 + FREE_WALL_AREA_TOLERANCE.value + 0.005 : 1.015;
        if (area > choice.chosen.areaM2 * 1.005 + 1e-6 || area > minA * tol + 1e-6) bad.push(`${growth} DU ${du}: ${hall.width}×${hall.depth} = ${area.toFixed(0)} m² vs chosen ${choice.chosen.areaM2} / min ${minA}`);
      }
    expect(bad).toEqual([]);
  });

  it('grid chooser flags out-of-reach grids and selects an in-reach alternative when available; DU 8 remains in reach', () => {
    for (const [growth, du] of [['phased', 16], ['phased', 24]] as const) {
      const { base } = setup(du, growth);
      const choice = chooseLayoutGrid(base, { mode: 'auto-size' });
      // At least one otherwise valid grid is flagged when its distribution run exceeds 100 m.
      const within = choice.candidates.filter((c) => c.aspect <= choice.targetAspect + 1e-6);
      const beyond = within.filter((c) => !c.reachOk);
      expect(beyond.length, `${growth} ${du}`).toBeGreaterThan(0);
      expect(Math.min(...beyond.map((c) => c.reachRunM ?? 0)), `${growth} ${du}`).toBeGreaterThan(100);
      // … and (qa-autosize v2 2차) the chooser takes an in-reach grid when one exists, else it warns
      if (within.some((c) => c.reachOk)) expect(choice.chosen.reachOk, `${growth} ${du}`).toBe(true);
      else expect(choice.warnings.find((x) => x.code === 'reach')?.params.runM).toBeGreaterThan(100);
    }
    const { base } = setup(8, 'phased');
    expect(chooseLayoutGrid(base, { mode: 'auto-size' }).chosen.reachOk).toBe(true);
  });

  it('fixed 60 × 40 m hall, DU 6: row-end CRAHs stand on the pod-area edge line (worst gap ≤ 6 m, was 15.8 m) with a measured issue', () => {
    const { hall, base } = setup(6, 'phased', { w: 60, d: 40 });
    const choice = chooseLayoutGrid(base, { mode: 'fixed' });
    const L = generateHallLayout({ ...base, hall, orientation: choice.orientation, columns: choice.columns, crahWalls: rowEndWalls(choice.orientation) });
    const rect = (e: (typeof L.equipment)[number]) => footprintRect(findCatalogItem(e.catalogId)!.dims, e.position, e.rotationDeg);
    const racks = L.equipment.filter((e) => cat(e.catalogId).endsWith('rack')).map(rect);
    const crahs = L.equipment.filter((e) => cat(e.catalogId) === 'crah');
    expect(crahs.length).toBe(L.crah.required);
    const gap = (a: ReturnType<typeof rect>, b: ReturnType<typeof rect>) => Math.hypot(Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w)), Math.max(0, a.y - (b.y + b.d), b.y - (a.y + a.d)));
    const worst = Math.max(...crahs.map((c) => Math.min(...racks.map((r) => gap(rect(c), r)))));
    expect(worst).toBeLessThanOrEqual(6);
    const iss = L.issues.find((i) => i.id === 'layout-crah-pod-edge-hall-a');
    expect(iss?.messageEn).toMatch(/cooling line at the pod-area edge/);
    // a cooling-only regeneration keeps the same line (ids and positions)
    const { d, base: b2 } = setup(6, 'phased', { w: 60, d: 40 });
    applyHallLayout(d, 'hall-a', L, { ...b2, orientation: choice.orientation, columns: choice.columns });
    const h2 = d.halls.find((h) => h.id === 'hall-a')!;
    const rep = regenerateCoolingReport(d, 'hall-a', { ...coolingPlacementFor(h2), crahCount: L.crah.required });
    // the regeneration uses the same line (row CDUs are re-placed at both row ends, so the extent can differ by a CDU): every unit placed, ids kept, gap ≤ 6 m
    const after = rep.project.equipment.filter((e) => e.hallId === 'hall-a' && cat(e.catalogId) === 'crah');
    const ids = new Set(crahs.map((c) => c.id));
    expect(after.filter((e) => ids.has(e.id)).length).toBe(crahs.length);
    expect(rep.issues.some((i) => i.id === 'layout-crah-pod-edge-hall-a')).toBe(true);
    const racks2 = rep.project.equipment.filter((e) => e.hallId === 'hall-a' && cat(e.catalogId).endsWith('rack')).map(rect);
    // ≤ 7 m: the line stands one CRAH zone beyond the outermost row member, and a row-ends CDU at the row end moves that member by one CDU (measured 6.5 m)
    expect(Math.max(...after.map((c) => Math.min(...racks2.map((r) => gap(rect(c), r)))))).toBeLessThanOrEqual(7);
  });

  it('rows along Y: CRAH tags / ids name the hall-frame wall and survive regenerateCooling', () => {
    const { hall, base } = setup(8, 'phased', { w: 40.2, d: 35.4 });
    const L = generateHallLayout({ ...base, hall, orientation: 'y', columns: 2, crahWalls: ['S', 'N'] });
    const crahs = L.equipment.filter((e) => cat(e.catalogId) === 'crah');
    expect(crahs.length).toBeGreaterThan(0);
    for (const c of crahs) {
      const r = footprintRect(findCatalogItem(c.catalogId)!.dims, c.position, c.rotationDeg);
      const wall = r.y < hall.depth / 2 ? 'S' : 'N';
      expect(c.tag[5], c.tag).toBe(wall);
      expect(c.id).toBe(`eq-${c.tag.toLowerCase()}`);
    }
    const { d, base: b2 } = setup(8, 'phased', { w: 40.2, d: 35.4 });
    applyHallLayout(d, 'hall-a', L, { ...b2, orientation: 'y', columns: 2 });
    const h2 = d.halls.find((h) => h.id === 'hall-a')!;
    const after = regenerateCooling(d, 'hall-a', { ...coolingPlacementFor(h2), crahCount: crahs.length }).equipment.filter((e) => e.hallId === 'hall-a' && cat(e.catalogId) === 'crah');
    const ids = new Set(crahs.map((c) => c.id));
    expect(after.filter((e) => ids.has(e.id)).length).toBe(crahs.length);
  });

  it('CoolingPlacementOptions.crahCatalogId places the chosen unit model; default keeps the project CRAH', () => {
    const { project } = createNvidiaReferenceProject();
    const hall = project.halls.find((h) => h.id === 'hall-a')!;
    const fan = regenerateCoolingReport(project, 'hall-a', { ...coolingPlacementFor(hall), crahStrategy: 'gallery-fan-wall', crahCatalogId: 'liebert-cwa-fanwall-600' });
    const units = (p: Project) => [...new Set(p.equipment.filter((e) => e.hallId === 'hall-a' && ['crah', 'fan-wall'].includes(cat(e.catalogId))).map((e) => e.catalogId))];
    expect(units(fan.project)).toEqual(['liebert-cwa-fanwall-600']);
    expect(fan.crah.placed).toBe(fan.crah.required);
    expect(fan.project.halls[0].coolingPlacement?.crahCatalogId).toBe('liebert-cwa-fanwall-600');
    expect(units(regenerateCooling(project, 'hall-a', coolingPlacementFor(hall)))).toEqual([project.cooling.crahCatalogId]);
  });

  it('generator CRAH issues carry English text', () => {
    const { hall, base } = setup(8, 'phased', { w: 12, d: 12 });
    const L = generateHallLayout({ ...base, hall, crahs: 400 });
    const crahIssues = L.issues.filter((i) => i.id.startsWith('layout-crah-'));
    expect(crahIssues.length).toBeGreaterThan(0);
    for (const i of L.issues) expect(i.messageEn, i.id).toBeTruthy();
  });

  it('validate: stale inter-hall-core racks and a short gallery group are raised by the analysis', () => {
    const { project } = createNvidiaReferenceProject();
    const net = project.equipment.find((e) => e.hallId === 'hall-a' && cat(e.catalogId) === 'network-rack' && e.podId?.startsWith('pod-services'))!;
    net.networkRole = 'inter-hall-core';
    expect(analyzeProject(project).issues.some((i) => i.id === 'layout-ihc-stale-hall-a' && i.severity === 'warning')).toBe(true);

    const { project: p2 } = createNvidiaReferenceProject();
    const hall = p2.halls.find((h) => h.id === 'hall-a')!;
    const g = regenerateCoolingReport(p2, 'hall-a', { ...coolingPlacementFor(hall), cduPlacement: 'gallery', cduGalleryWall: 'W' });
    const before = analyzeProject(g.project).issues.filter((i) => i.id === 'layout-cdu-gallery-short-hall-a');
    expect(before).toEqual(g.issues.filter((i) => i.id === 'layout-cdu-gallery-short-hall-a').map(() => expect.anything()));
    const gallery = g.project.equipment.filter((e) => e.meta?.gallery === true);
    expect(gallery.length).toBeGreaterThan(1);
    const cut = { ...g.project, equipment: g.project.equipment.filter((e) => e.id !== gallery[0].id) };
    const after = analyzeProject(cut).issues.find((i) => i.id === 'layout-cdu-gallery-short-hall-a');
    expect(after?.severity).toBe('error');
    expect(after?.messageEn).toMatch(/group redundancy/);
  });
});
