import { describe, expect, it } from 'vitest';
import { analyzeProject, createNvidiaReferenceProject, findCatalogItem, generateHallLayout, LAYOUT_TEMPLATES, polylineInside, resolveLayoutTemplate, roundUpToGrid, type HallLayoutOptions, type Project } from '../src/index.ts';

/** Layout templates (PROPOSAL-v2 §3.1, stream S1): every template generates a clean, analysable hall at 2 pods. */

function generate(templateId: string, pods = 2, extra: Partial<HallLayoutOptions> = {}) {
  const t = resolveLayoutTemplate(templateId)!;
  const { project: base } = createNvidiaReferenceProject({ pods: 1 });
  const p: Project = structuredClone(base);
  const hall = p.halls[0];
  hall.itPowerBudgetKW = 1e9;
  hall.liquidCoolingBudgetKW = 1e9;
  hall.airCoolingBudgetKW = 1e9;
  p.site.utility.forEach((u) => (u.capacityMVA = 1e6));
  const opts: HallLayoutOptions = { hall, pods, template: t.pod, services: { spineRacks: 'auto', storageRacks: 2, cpuRacks: 1, mgmtRacks: 1 }, crahCatalogId: 'vertiv-cw375', crahs: 'auto', crahRedundancy: 'N+1', marginM: 1, podsPerWave: 2, spinePlacement: 'central-end', templateId: t.id, crahStrategy: t.defaults.crahStrategy, servicesZone: t.defaults.servicesZone, ...extra };
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
  return { t, p, hall, layout };
}

describe('layout templates', () => {
  it('registers the template set with the standard 21-inch OU liquid pod as the default (stream D / P4)', () => {
    expect(LAYOUT_TEMPLATES.map((t) => t.id)).toEqual(['std-orv3-hpr-liquid-du', 'std-orv3-hpr-rackscale-du', 'std-orw-liquid-sidecar-du', 'std-eia-air-du', 'std-eia-liquid-uqd-du', 'rack-scale-liquid-du', 'nvidia-facilities-su', 'rcu-row', 'custom']);
    expect(LAYOUT_TEMPLATES[0].pod.racksPerRow).toBe(12);
    for (const t of LAYOUT_TEMPLATES) expect(['public-spec', 'estimate', 'user']).toContain(t.source);
  });

  it('keeps template ids, primary-platform defaults and aisle semantics internally consistent', () => {
    expect(new Set(LAYOUT_TEMPLATES.map((t) => t.id)).size).toBe(LAYOUT_TEMPLATES.length);
    for (const t of LAYOUT_TEMPLATES) {
      const primary = t.computeSlots[0];
      expect(primary.role, t.id).toBe('primary');
      expect(primary.defaultPlatform, t.id).toBe(t.pod.gpuRackCatalogId);
      expect(primary.platforms, t.id).toContain(primary.defaultPlatform);
      for (const slot of t.computeSlots) for (const id of slot.platforms) expect(findCatalogItem(id), `${t.id} → ${slot.id} → ${id}`).toBeDefined();
      if ((t.pod.rowsPerPod ?? 2) === 1) expect(t.pod.containment, t.id).toBe('none');
    }
  });

  it.each(LAYOUT_TEMPLATES.map((t) => t.id))('%s generates a clean 2-pod hall (no layout issues, no space / layout / network-placement errors, trays inside)', (id) => {
    const { p, hall, layout } = generate(id);
    expect(layout.issues).toEqual([]);
    expect(layout.crah.placed).toBe(layout.crah.required);
    expect(layout.trays.every((t) => polylineInside(t.points, hall))).toBe(true);
    expect(layout.busways.every((b) => polylineInside(b.points, hall))).toBe(true);
    const a = analyzeProject(p);
    const errs = a.issues.filter((i) => i.severity === 'error' && (i.domain === 'space' || i.domain === 'layout' || i.id.startsWith('network-unplaced') || i.id === 'network-unconnected'));
    expect(errs.map((e) => e.id)).toEqual([]);
    expect(a.summary.gpus).toBeGreaterThan(0);
  });

  it('nvidia-facilities-su: one compute HAC has two rows of eight GPU racks and services use a support HAC', () => {
    const { layout } = generate('nvidia-facilities-su', 1, { servicesZone: 'support-hac' });
    const computeRows = ['pod-01-a', 'pod-01-b'].map((rowId) => layout.equipment.filter((e) => e.rowId === rowId && findCatalogItem(e.catalogId)?.category === 'gpu-rack').length);
    expect(computeRows).toEqual([8, 8]);
    expect(layout.zone?.mode).toBe('support-hac');
    expect(layout.containments.some((c) => c.podId === 'pod-01' && c.kind === 'hot-aisle')).toBe(true);
    expect(layout.containments.some((c) => c.podId === 'pod-services' && c.kind === 'hot-aisle')).toBe(true);
  });

  it('a single-row custom unit cannot silently claim aisle containment', () => {
    const base = resolveLayoutTemplate('custom')!;
    const { layout } = generate('custom', 1, { template: { ...base.pod, rowsPerPod: 1, containment: 'hot-aisle' } });
    expect(layout.containments).toEqual([]);
    expect(layout.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: expect.stringMatching(/^layout-containment-single-row-/), severity: 'warning' }),
    ]));
  });

  it('rcu-row: enclosures of 4 racks recorded in meta.rcu, ~0.1 m break between enclosures', () => {
    const { layout } = generate('rcu-row', 1);
    const gpus = layout.equipment.filter((e) => e.rowId === 'pod-01-a' && findCatalogItem(e.catalogId)?.category === 'gpu-rack').sort((a, b) => a.position.x - b.position.x);
    expect(gpus.length).toBe(16);
    const enclosures = new Set(gpus.map((e) => e.meta?.rcu));
    expect(enclosures.size).toBe(4);
    const gaps = gpus.slice(1).map((e, i) => +(e.position.x - gpus[i].position.x).toFixed(3));
    expect(gaps.filter((g) => g > 0.6 + 1e-6).length).toBeGreaterThanOrEqual(3);
  });

  it('nvidia-facilities-su: at most 8 compute racks per row', () => {
    const { layout } = generate('nvidia-facilities-su', 2, { servicesZone: 'support-hac' });
    for (const rowId of new Set(layout.equipment.map((e) => e.rowId))) {
      const n = layout.equipment.filter((e) => e.rowId === rowId && findCatalogItem(e.catalogId)?.category === 'gpu-rack').length;
      expect(n).toBeLessThanOrEqual(8);
    }
  });

  it('the wide-rack interface template registers Helios without calling the physical DU an AMD SU', () => {
    const t = resolveLayoutTemplate('std-orw-liquid-sidecar-du')!;
    expect(t.computeSlots[0].platforms).toContain('amd-helios-mi455x');
    expect(findCatalogItem('amd-helios-mi455x')?.compute?.scaleUp).toMatchObject({ kind: 'ualink', domainSize: 72 });
  });

  it('templates carry the network / storage / cpu / mgmt rack ids and network-rack air kW as fields', () => {
    const { layout } = generate('custom', 1, { template: { ...resolveLayoutTemplate('custom')!.pod, networkRackCatalogId: 'network-rack-48u', storageRackCatalogId: 'storage-rack-afa', cpuRackCatalogId: 'cpu-rack-2s-20', mgmtRackCatalogId: 'mgmt-rack-42u', networkRackAirKW: 60 } });
    expect(layout.equipment.some((e) => e.catalogId === 'storage-rack-afa')).toBe(true);
    expect(layout.equipment.some((e) => e.catalogId === 'cpu-rack-2s-20')).toBe(true);
    expect(layout.crah.airKW).toBeGreaterThan(0);
  });

  it('orientation y transposes the plan (rows along Y) and keeps everything inside the hall', () => {
    const { layout, hall } = generate('rack-scale-liquid-du', 2, { orientation: 'y' });
    expect(layout.rows.every((r) => r.axis === 'y')).toBe(true);
    expect(layout.requiredWidth).toBeLessThanOrEqual(hall.width + 1e-6);
    expect(layout.trays.every((t) => polylineInside(t.points, hall))).toBe(true);
    const rot = new Set(layout.equipment.filter((e) => findCatalogItem(e.catalogId)?.category === 'gpu-rack').map((e) => e.rotationDeg));
    expect([...rot].every((r) => r === 90 || r === 270)).toBe(true);
  });

  it('CRAHs never disappear silently: wide rows add N/S walls; an impossible count raises a layout issue', () => {
    const { layout } = generate('rack-scale-liquid-du', 4, { template: { ...resolveLayoutTemplate('rack-scale-liquid-du')!.pod, racksPerRow: 36 } });
    expect(layout.crah.placed).toBe(layout.crah.required);
    expect(layout.crah.required).toBeGreaterThan(0);
    // tiny hall with a huge explicit CRAH count → four walls, then row-end units (reported), never silent drops
    const t = resolveLayoutTemplate('rack-scale-liquid-du')!;
    const { project } = createNvidiaReferenceProject({ pods: 1 });
    const tiny = generateHallLayout({ hall: { ...project.halls[0], width: 20, depth: 20 }, pods: 1, template: t.pod, crahCatalogId: 'vertiv-cw375', crahs: 60, crahRedundancy: 'N', marginM: 1, podsPerWave: 2 });
    expect(tiny.crah.placed).toBe(60);
    expect(tiny.crah.walls).toEqual(['W', 'E', 'N', 'S']);
    expect(tiny.issues.some((i) => i.domain === 'layout' && i.id.startsWith('layout-crah-row-end'))).toBe(true);
    expect(tiny.equipment.filter((e) => e.catalogId === 'vertiv-cw375' && e.rowId).length).toBeGreaterThan(0);
    // and when there are no pod rows to fall back to, the shortfall is an error issue
    const noPods = generateHallLayout({ hall: { ...project.halls[0], width: 12, depth: 12 }, pods: 0, template: t.pod, services: { spineRacks: 'auto', storageRacks: 4, cpuRacks: 0, mgmtRacks: 0 }, crahCatalogId: 'vertiv-cw375', crahs: 40, crahRedundancy: 'N', marginM: 1, podsPerWave: 2 });
    expect(noPods.crah.placed).toBeLessThan(40);
    expect(noPods.issues.some((i) => i.domain === 'layout' && i.id.startsWith('layout-crah-short') && i.severity === 'error')).toBe(true);
  });
});
