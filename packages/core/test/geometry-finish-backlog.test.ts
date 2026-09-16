// Backlog round finish (docs/research/backlog-results.md): regressions for the QA open items resolved at finish.
//   1. parallel main trays closer than a tray width merge (no main × main plan overlap, no graze of a ducted chimney's end transom)
//   2. the wall audit reads the chimney end transoms as planes (unsleeved-chimney-crossing)
//   3. row air units taller than the overhead services raise layout-row-unit-overhead
//   4. default tier datums: `main` is carried at T2 (the level buildTrays uses), T3 carries OOB only
import { describe, expect, it } from 'vitest';
import {
  addHall, analyzeProject, auditHallGeometry, autoSizeHall, buildHallPrims, coolingPlacementFor, createNvidiaReferenceProject, defaultWaveStart, layoutOptionsFromProject,
  primAabb, regenerateCoolingReport, resolveLayoutTemplate, resolveVerticals, type AutoSizeRequest, type Project,
} from '../src/index.ts';

function sized(templateId: string, pods: number, gpuRackCatalogId?: string): { p: Project; hallId: string } {
  const { project: p, hallId } = addHall(structuredClone(createNvidiaReferenceProject().project), {});
  const hall = p.halls.find((h) => h.id === hallId)!;
  const lo = layoutOptionsFromProject(p, hall);
  const tpl = resolveLayoutTemplate(templateId, { project: p })!;
  const req = {
    templateId,
    template: { ...tpl.pod, ...(gpuRackCatalogId ? { gpuRackCatalogId } : {}), cduCatalogId: lo.template.cduCatalogId, cduRedundancy: lo.template.cduRedundancy, oversubscription: lo.template.oversubscription, accelerators: [] },
    pods, services: { spineRacks: 'auto', storageRacks: 0, cpuRacks: 0, mgmtRacks: 0 }, crahCatalogId: lo.crahCatalogId, marginM: 1, podsPerWave: 2,
    waveStart: defaultWaveStart(p, hallId), autoSize: true, crahStrategy: tpl.defaults.crahStrategy, servicesZone: 'auto',
    grid: { auto: true, orientation: 'x', columns: 1 }, crahWalls: 'auto',
  } as unknown as AutoSizeRequest;
  expect(autoSizeHall(p, hallId, req).ok).toBe(true);
  return { p, hallId };
}

describe('backlog finish — main trays and chimney transoms', () => {
  it('Helios-class 4 DU: one main tray at the pod column end, clear of every end transom', () => {
    const { p, hallId } = sized('std-orw-liquid-sidecar-du', 4, 'amd-helios-mi455x');
    const mains = (p.trays ?? []).filter((t) => t.hallId === hallId && t.kind === 'main');
    const lines = mains.map((t) => ({ id: t.id, a: t.points[0].x, vertical: t.points.every((q) => q.x === t.points[0].x) })).filter((m) => m.vertical);
    for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) expect(Math.abs(lines[i].a - lines[j].a), `${lines[i].id} / ${lines[j].id}`).toBeGreaterThanOrEqual(0.45 + 0.1 - 1e-9);
    const a = analyzeProject(p);
    const prims = buildHallPrims(p, a, { hallId, detail: 'pod' }).prims;
    const transoms = prims.filter((x) => x.emitter === 'containment-roof' && x.meta?.part === 'transom').map(primAabb);
    const trays = prims.filter((x) => x.emitter === 'tray' || x.emitter === 'drop').map(primAabb);
    expect(transoms.length).toBeGreaterThan(0);
    let hits = 0;
    for (const t of transoms) for (const y of trays) {
      const o = (lo0: number, hi0: number, lo1: number, hi1: number) => Math.min(hi0, hi1) - Math.max(lo0, lo1) > 1e-4;
      if (o(t.min.x, t.max.x, y.min.x, y.max.x) && o(t.min.y, t.max.y, y.min.y, y.max.y) && o(t.min.z, t.max.z, y.min.z, y.max.z)) hits++;
    }
    expect(hits).toBe(0);
  }, 120_000);

  it('the wall audit flags a tray segment through a ducted chimney end transom', () => {
    const { p, hallId } = sized('std-orw-liquid-sidecar-du', 1, 'amd-helios-mi455x');
    const cont = p.containments.find((c) => c.hallId === hallId && c.ductedToPlenum && c.endDoors)!;
    expect(cont).toBeTruthy();
    const alongX = cont.rect.w >= cont.rect.d;
    const end = alongX ? cont.rect.x + cont.rect.w : cont.rect.y + cont.rect.d;
    const mid = alongX ? cont.rect.y + cont.rect.d / 2 : cont.rect.x + cont.rect.w / 2;
    const z = cont.height + 0.5;
    const pt = (a: number) => (alongX ? { x: a, y: mid, z } : { x: mid, y: a, z });
    p.trays = [...(p.trays ?? []), { id: 'tray-finish-probe', hallId, kind: 'main', points: [pt(end - 0.4), pt(end + 0.4)], widthM: 0.1, cableCount: 1 }];
    const audit = auditHallGeometry(p, analyzeProject(p), hallId);
    expect(audit.violations.some((v) => v.check === 'unsleeved-chimney-crossing' && v.id === 'tray-finish-probe')).toBe(true);
  }, 120_000);
});

describe('backlog finish — row air units and tier datums', () => {
  it('in-row placement of a room air unit raises layout-row-unit-overhead (warning, not an error)', () => {
    const { p, hallId } = sized('nvidia-facilities-su', 1);
    const base = coolingPlacementFor(p.halls.find((h) => h.id === hallId)!);
    const rep = regenerateCoolingReport(p, hallId, { ...base, crahStrategy: 'in-row' });
    expect(rep.crah.placed).toBeGreaterThan(0);
    const w = rep.issues.find((i) => i.id === `layout-row-unit-overhead-${hallId}`);
    expect(w?.severity).toBe('warning');
    expect(w?.messageEn).toMatch(/no in-row air unit/);
    const perimeter = regenerateCoolingReport(p, hallId, { ...base, crahStrategy: 'perimeter' });
    expect(perimeter.issues.some((i) => i.id.startsWith('layout-row-unit-overhead'))).toBe(false);
  }, 120_000);

  it('default verticals carry the main trays at T2, OOB alone at T3', () => {
    const hall = createNvidiaReferenceProject().project.halls[0];
    const tiers = resolveVerticals({ ...hall, verticals: undefined }, 2.3).tiers;
    expect(tiers.find((t) => t.id === 'T2')!.carries).toEqual(['frontend', 'storage', 'main']);
    expect(tiers.find((t) => t.id === 'T3')!.carries).toEqual(['oob']);
  });
});
