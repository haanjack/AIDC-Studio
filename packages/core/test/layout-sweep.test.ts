import { describe, expect, it } from 'vitest';
import { analyzeProject, createNvidiaReferenceProject, findCatalogItem, instanceRect, polylineInside, rectContains, type Project } from '../src/index.ts';

/**
 * Layout engine v2 sweep (PROPOSAL-v2 §1.3 / §3.1 Phase A, stream S1): DU 1–40 × racks-per-row 12/24/36 on a hall
 * whose power / cooling / utility budgets scale with the DU count, so only geometry and network placement are
 * asserted: no space / layout errors, no unplaced / unconnected network switches, and every footprint, tray and
 * busway inside the hall rectangle.
 */

function build(pods: number, racksPerRow: number): Project {
  const { project } = createNvidiaReferenceProject({ pods, racksPerRow });
  const hall = project.halls[0];
  hall.itPowerBudgetKW = 1e9;
  hall.liquidCoolingBudgetKW = 1e9;
  hall.airCoolingBudgetKW = 1e9;
  project.site.utility.forEach((u) => (u.capacityMVA = 1e6));
  return project;
}

interface Check { space: string[]; layout: string[]; network: string[] }

/** Space / layout / network-placement error ids from the full pipeline (analyzeProject must not throw at any size — the
 *  placement comparator's argument-spread overflow at DU 40 × 36 racks/row was fixed in integration). Trays are stripped so
 *  the sweep asserts geometry with the Manhattan cable model (the tray-graph router is exercised by the reference tests). */
function check(project: Project): Check {
  const scratch: Project = { ...project, trays: undefined, busways: undefined };
  const a = analyzeProject(scratch);
  const errs = a.issues.filter((i) => i.severity === 'error');
  return {
    space: errs.filter((i) => i.domain === 'space').map((i) => i.id),
    layout: errs.filter((i) => i.domain === 'layout').map((i) => i.id),
    network: errs.filter((i) => i.id.startsWith('network-unplaced') || i.id === 'network-unconnected').map((i) => i.id),
  };
}

function geometryInside(project: Project): string[] {
  const hall = project.halls[0];
  const hallRect = { x: 0, y: 0, w: hall.width, d: hall.depth };
  const bad: string[] = [];
  for (const e of project.equipment) {
    const item = findCatalogItem(e.catalogId);
    if (!item) continue;
    if (!rectContains(hallRect, instanceRect(e, item))) bad.push(`eq:${e.tag}`);
  }
  for (const c of project.containments) if (!rectContains(hallRect, c.rect)) bad.push(`cont:${c.id}`);
  for (const t of project.trays ?? []) if (!polylineInside(t.points, hall)) bad.push(`tray:${t.id}`);
  for (const b of project.busways ?? []) if (!polylineInside(b.points, hall)) bad.push(`bus:${b.id}`);
  return bad;
}

const DUS = Array.from({ length: 40 }, (_, i) => i + 1);

describe.each([12, 24, 36])('DU sweep — %i racks per row', (rpr) => {
  it('DU 1–40: no space / layout / network-placement errors, everything inside the hall', () => {
    const failures: string[] = [];
    for (const du of DUS) {
      const project = build(du, rpr);
      const inside = geometryInside(project);
      if (inside.length) failures.push(`DU ${du}: outside ${inside.slice(0, 3).join(', ')} (+${Math.max(0, inside.length - 3)})`);
      expect(project.trays?.length ?? 0, `DU ${du}: trays generated`).toBeGreaterThan(0);
      expect(project.busways?.length ?? 0, `DU ${du}: busways generated`).toBeGreaterThan(0);
      const c = check(project);
      for (const [k, ids] of Object.entries(c)) if (ids.length) failures.push(`DU ${du}: ${k} ${ids.slice(0, 3).join(', ')} (+${Math.max(0, ids.length - 3)})`);
    }
    expect(failures).toEqual([]);
  });
});

describe('reference project (4 DU) — v2 layout', () => {
  const { project } = createNvidiaReferenceProject();
  it('keeps 96 GB300 racks / 6,912 GPUs and grows the services block to what the network engine needs', () => {
    const a = analyzeProject({ ...project, trays: undefined, busways: undefined });
    expect(a.summary.gpus).toBe(6912);
    expect(a.summary.gpuRacks).toBe(96);
    const central = project.equipment.filter((e) => e.podId === 'pod-services');
    const netRacks = central.filter((e) => findCatalogItem(e.catalogId)?.category === 'network-rack');
    expect(netRacks.length).toBeGreaterThanOrEqual(6); // v0.1 reserved 8 spine racks for a 2-tier formula; radix sizing for all four fabrics
    expect(a.issues.filter((i) => i.id.startsWith('network-unplaced'))).toEqual([]);
    // wrapped rows: no central row longer than the pod row
    const hall = project.halls[0];
    for (const rowId of new Set(central.map((e) => e.rowId))) {
      const xs = central.filter((e) => e.rowId === rowId).map((e) => e.position.x);
      expect(Math.max(...xs) + 0.3).toBeLessThanOrEqual(hall.width - 1);
    }
  });
  it('emits kinds on the pods and clips trays to the hall', () => {
    expect(project.trays!.every((t) => polylineInside(t.points, project.halls[0]))).toBe(true);
    expect(project.trays!.some((t) => t.kind === 'main')).toBe(true);
    expect(project.trays!.some((t) => t.kind === 'row')).toBe(true);
    expect(project.busways!.filter((b) => b.path === 'A').length).toBe(project.busways!.filter((b) => b.path === 'B').length);
    expect(project.halls[0].layoutPolicy?.templateId).toBe('rack-scale-liquid-du');
  });
});
