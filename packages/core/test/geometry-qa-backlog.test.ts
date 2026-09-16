// QA lens GEOMETRY, backlog round (docs/research/qa-backlog-geometry.md): site shifts for every hall / room conflict of a sized hall, the
// fan-wall remedy on the row-end walls, per-tier trays (busway-side edge, gaps at main-tray crossings), junctions at every main-over-row
// crossing, and the off-row CDU link lane. Every case is built in memory (nothing under data/ is read or written).
import { describe, expect, it } from 'vitest';
import {
  addHall, analyzeProject, auditHallGeometry, autoSizeHall, buildHallPipes, buildTierTrays, buildTrays, coolingPlacementFor, createNvidiaReferenceProject,
  defaultSpinePlacement, defaultWaveStart, detectRowGroups, layoutOptionsFromProject, regenerateCoolingReport, resolveLayoutTemplate,
  type AutoSizeRequest, type Project, type ProjectAnalysis,
} from '../src/index.ts';

function size(p: Project, hallId: string, templateId: string, pods: number, grid: 'auto' | 'x' | 'y', columns = 1, gpuRackCatalogId?: string) {
  const hall = p.halls.find((h) => h.id === hallId)!;
  const lo = layoutOptionsFromProject(p, hall);
  const tpl = resolveLayoutTemplate(templateId, { project: p })!;
  const req: AutoSizeRequest = {
    templateId,
    template: { ...tpl.pod, ...(gpuRackCatalogId ? { gpuRackCatalogId } : {}), cduCatalogId: lo.template.cduCatalogId, cduRedundancy: lo.template.cduRedundancy, oversubscription: lo.template.oversubscription, accelerators: [] },
    pods, services: { spineRacks: 'auto', storageRacks: 0, cpuRacks: 0, mgmtRacks: 0 }, crahCatalogId: lo.crahCatalogId, marginM: 1, podsPerWave: 2,
    waveStart: defaultWaveStart(p, hallId), autoSize: true, crahStrategy: tpl.defaults.crahStrategy, servicesZone: 'auto',
    grid: { auto: grid === 'auto', orientation: grid === 'y' ? 'y' : 'x', columns }, crahWalls: 'auto',
  };
  const r = autoSizeHall(p, hallId, req);
  if (!r.ok) throw new Error(`${templateId} did not fit`);
  return r;
}

type R = { x: number; y: number; w: number; d: number };
const hit = (a: R, b: R) => a.x < b.x + b.w - 0.01 && a.x + a.w > b.x + 0.01 && a.y < b.y + b.d - 0.01 && a.y + a.d > b.y + 0.01;
function siteOverlaps(p: Project, a: ProjectAnalysis): string[] {
  const out: string[] = [];
  const rect = (id: string) => { const h = p.halls.find((x) => x.id === id)!; return { x: h.origin.x, y: h.origin.y, w: h.width, d: h.depth }; };
  const rooms = (a.power.rooms ?? []).map((r) => { const h = rect(r.hallId); return { r, s: { x: h.x + r.rect.x, y: h.y + r.rect.y, w: r.rect.w, d: r.rect.d } }; });
  for (const h of p.halls) for (const g of p.halls) if (h.id < g.id && hit(rect(h.id), rect(g.id))) out.push(`${h.id}/${g.id}`);
  for (const x of rooms) {
    for (const h of p.halls) if (h.id !== x.r.hallId && hit(x.s, rect(h.id))) out.push(`${x.r.id}/${h.id}`);
    for (const y of rooms) if (x.r.hallId < y.r.hallId && hit(x.s, y.s)) out.push(`${x.r.id}/${y.r.id}`);
  }
  return out;
}
const refBase = () => {
  const p = structuredClone(createNvidiaReferenceProject().project);
  p.halls = p.halls.filter((h) => p.equipment.some((e) => e.hallId === h.id));
  return p;
};

describe('QA backlog geometry: site conflicts of auto-sized halls', () => {
  it('halls added first and sized afterwards (16 DU next to 4 DU) end with no hall or room overlap', () => {
    let p = refBase();
    const ids: string[] = [];
    for (let k = 0; k < 2; k++) {
      const r = addHall(p, {});
      p = r.project;
      ids.push(r.hallId);
    }
    size(p, ids[0], 'rack-scale-liquid-du', 16, 'auto');
    size(p, ids[1], 'rcu-row', 4, 'x');
    const a = analyzeProject(p);
    expect(siteOverlaps(p, a)).toEqual([]);
    expect(a.issues.filter((i) => i.id.startsWith('site-hall-overlap-'))).toEqual([]);
  }, 240_000);

  it('a 16-DU hall whose rooms stand on CRAH walls is moved clear of the hall before it', () => {
    const { project: p, hallId } = addHall(structuredClone(createNvidiaReferenceProject().project), {});
    const r = size(p, hallId, 'std-orw-liquid-sidecar-du', 16, 'auto', 1, 'amd-helios-mi455x');
    const a = analyzeProject(p);
    expect(siteOverlaps(p, a)).toEqual([]);
    expect(r.report.corrections).toContain('room-gap');
  }, 240_000);
});

describe('QA backlog geometry: per-tier trays', () => {
  it('a VR-class row keeps its T2 tray off the busway band and the audit reports no tier-tray clash', () => {
    const { project: p, hallId } = addHall(structuredClone(createNvidiaReferenceProject().project), {});
    size(p, hallId, 'rcu-row', 1, 'auto');
    const hall = p.halls.find((h) => h.id === hallId)!;
    const rows = detectRowGroups(p, hall);
    const eq = p.equipment.filter((e) => e.hallId === hallId);
    for (const t of buildTierTrays(hall, rows, eq)) {
      const row = rows.find((r) => t.id.startsWith(`tray-${r.id}-`))!;
      const c = row.axis === 'x' ? t.points[0].y : t.points[0].x;
      // busway-side edge 0.15 m from the row centre, as the T1 tray
      expect(Math.abs(c - row.center) - t.widthM / 2).toBeCloseTo(0.15, 6);
    }
    const au = auditHallGeometry(p, analyzeProject(p), hallId);
    expect(au.counts['tier-tray-clash'] ?? 0).toBe(0);
    expect(au.counts['tier-tray-feeder-clash'] ?? 0).toBe(0);
  }, 120_000);

  it('a T2 tray stops short of a main tray crossing its level', () => {
    const hall = { id: 'h', name: 'h', origin: { x: 0, y: 0 }, width: 30, depth: 20, clearHeight: 6, trayHeight: 2.9, keepouts: [] } as unknown as Project['halls'][number];
    const row = (id: string, a0: number, a1: number, center: number) => ({ id, hallId: 'h', podId: id, kind: 'compute' as const, axis: 'x' as const, a0, a1, center, frontSign: -1 as const, memberIds: [] });
    const rows = [row('P1', 1, 13, 5), row('P2', 15, 27, 5), row('S', 1, 7, 9)];
    const trays = buildTrays(hall, rows, []);
    expect(trays.some((t) => t.id === 'drop-P1-x-x1')).toBe(true);
    const t2 = buildTierTrays(hall, rows, [], trays).filter((t) => t.id.startsWith('tray-P1-t2'));
    expect(t2.length).toBe(2); // split at the main tray x1 (a 7.45)
    const gap = [Math.max(...t2[0].points.map((q) => q.x)), Math.min(...t2[1].points.map((q) => q.x))].sort((p, q) => p - q);
    expect(gap[0]).toBeLessThan(7.45 - 0.225);
    expect(gap[1]).toBeGreaterThan(7.45 + 0.225);
  });
});

describe('QA backlog geometry: junctions and CDU gallery links', () => {
  it('neighbouring racks of one row under a main tray are joined on the trays (was 101–114 m)', () => {
    const base = structuredClone(createNvidiaReferenceProject().project);
    base.growth = 'single-build';
    base.network.scaleOut.spinePlacement = defaultSpinePlacement('single-build');
    base.network.scaleOut.separateRoom = false;
    const { project: p, hallId } = addHall(base, {});
    const r = size(p, hallId, 'std-eia-air-du', 16, 'x', 1, 'hgx-b200-air-4x');
    const ids = new Set(p.equipment.filter((e) => e.hallId === hallId).map((e) => e.id));
    const byId = new Map(p.equipment.map((e) => [e.id, e]));
    const sameRow = r.analysis.network.cableRuns.filter((c) => ids.has(c.fromId) && ids.has(c.toId) && byId.get(c.fromId)!.rowId && byId.get(c.fromId)!.rowId === byId.get(c.toId)!.rowId);
    expect(sameRow.length).toBeGreaterThan(100);
    expect(Math.max(...sameRow.map((c) => c.lengthM))).toBeLessThan(30);
  }, 240_000);

  it('gallery CDUs serving the second pod of a column route their links clear of busways, tap-offs and containment', () => {
    const { project: p, hallId } = addHall(structuredClone(createNvidiaReferenceProject().project), {});
    size(p, hallId, 'rack-scale-liquid-du', 4, 'y', 2);
    const hall = p.halls.find((h) => h.id === hallId)!;
    const rep = regenerateCoolingReport(p, hallId, { ...coolingPlacementFor(hall), cduPlacement: 'gallery', cduGalleryWall: 'S' });
    expect(rep.requiresRegenerate ?? false).toBe(false);
    const q = rep.project;
    const au = auditHallGeometry(q, analyzeProject(q), hallId);
    expect(au.counts['pipe-clash'] ?? 0).toBe(0); // 124 before
    const links = buildHallPipes(q, q.halls.find((h) => h.id === hallId)!, detectRowGroups(q, q.halls.find((h) => h.id === hallId)!)).runs.filter((x) => x.part === 'link');
    expect(links.length).toBeGreaterThan(0);
  }, 240_000);
});
