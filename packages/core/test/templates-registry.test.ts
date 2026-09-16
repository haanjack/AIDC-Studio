import { afterEach, describe, expect, it } from 'vitest';
import {
  analyzeProject, applyHallLayout, createNvidiaReferenceProject, CORRIDOR_DEFAULTS, findCatalogItem, findNodeSpec, fitPlatformsFor, fitToSpace, generateHallLayout, getCatalogItem, isPlatformRegistered,
  LAYOUT_TEMPLATES, layoutOptionsFromProject, neutralRackClass, NPU_RACKS, platformRackClass, registeredPlatformIds, registerPlatformInProject, registrablePlatforms, resolveCatalog, resolveLayoutTemplate,
  roundUpToGrid, setActiveCatalog, slotPlatformOptions, unregisteredPlatforms, withTemplateSlot,
  type FitOptions, type HallLayoutOptions, type PodAccelerator, type Project,
} from '../src/index.ts';

/** DECISIONS-v2-2 §E: DU template compute slots ↔ compute platform registry. */

afterEach(() => setActiveCatalog(null));

function generate(templateId: string, pods: number, patch: { gpu?: string; accelerators?: PodAccelerator[] } = {}) {
  const t = resolveLayoutTemplate(templateId)!;
  const { project: base } = createNvidiaReferenceProject({ pods: 1 });
  const p: Project = structuredClone(base);
  const hall = p.halls[0];
  hall.itPowerBudgetKW = 1e9;
  hall.liquidCoolingBudgetKW = 1e9;
  hall.airCoolingBudgetKW = 1e9;
  p.site.utility.forEach((u) => (u.capacityMVA = 1e6));
  const template = { ...t.pod, ...(patch.gpu ? { gpuRackCatalogId: patch.gpu } : {}), ...(patch.accelerators ? { accelerators: patch.accelerators } : {}) };
  const opts: HallLayoutOptions = { hall, pods, template, services: { spineRacks: 'auto', storageRacks: 2, cpuRacks: 1, mgmtRacks: 1 }, crahCatalogId: 'vertiv-cw375', crahs: 'auto', crahRedundancy: 'N+1', marginM: 1, podsPerWave: 2, spinePlacement: 'central-end', templateId: t.id };
  const probe = generateHallLayout(opts);
  hall.width = roundUpToGrid(probe.requiredWidth, 0.6);
  hall.depth = roundUpToGrid(probe.requiredDepth, 0.6);
  hall.keepouts = [];
  const layout = generateHallLayout(opts);
  applyHallLayout(p, hall.id, layout, opts);
  p.network.scaleOut.switchCatalogId = t.pod.scaleOutSwitchCatalogId;
  p.cooling.cduCatalogId = t.pod.cduCatalogId;
  return { p, hall, layout, opts };
}

const isAcc = (e: { meta?: Record<string, unknown> }) => typeof e.meta?.computeSlot === 'string';
const gpuRack = (id: string) => findCatalogItem(id)?.category === 'gpu-rack';

describe('template compute slots (§E2 / §E3)', () => {
  it('every template has a primary slot first; every registered platform resolves in the catalog and matches the slot rack class', () => {
    for (const t of LAYOUT_TEMPLATES) {
      expect(t.computeSlots[0]?.role, t.id).toBe('primary');
      for (const slot of t.computeSlots) {
        expect(slot.platforms.length, `${t.id}:${slot.id}`).toBeGreaterThan(0);
        for (const id of slot.platforms) {
          const item = findCatalogItem(id);
          expect(item, `${t.id}:${slot.id} → ${id}`).toBeDefined();
          expect(item!.category, id).toBe('gpu-rack');
          // stream D (P4): standard slots declare neutral classes; legacy and neutral spellings compare through neutralRackClass
          if (slot.rackClass !== 'any') expect(slot.rackClass.map((c) => neutralRackClass(c)), `${t.id}:${slot.id} → ${id} (${platformRackClass(item!)})`).toContain(neutralRackClass(platformRackClass(item!)));
        }
        if (slot.defaultPlatform) expect(slot.platforms, `${t.id}:${slot.id}`).toContain(slot.defaultPlatform);
        if (slot.role === 'accelerator') expect(slot.optional, `${t.id}:${slot.id}`).toBe(true);
      }
      expect(registeredPlatformIds(t.id, 'primary'), t.id).toContain(resolveLayoutTemplate(t.id)!.pod.gpuRackCatalogId);
    }
  });

  it('template groups separate physical interfaces from platform instances and keep optional accelerator slots explicit', () => {
    for (const t of LAYOUT_TEMPLATES.filter((x) => x.group === 'vendor-sample')) for (const id of t.computeSlots[0].platforms) expect(getCatalogItem(id).vendor, `${t.id} → ${id}`).toBe('NVIDIA');
    const air = LAYOUT_TEMPLATES.find((x) => x.id === 'std-eia-air-du')!;
    for (const id of ['hgx-b200-air-4x', 'hgx-b300-air-4x', 'hgx-h100-air-4x', 'hgx-h200-air-4x', 'amd-mi300x-air-4x']) expect(air.computeSlots[0].platforms).toContain(id);
    expect(LAYOUT_TEMPLATES.find((x) => x.id === 'std-eia-liquid-uqd-du')!.computeSlots[0].platforms).toContain('amd-mi355x-dlc-4x');
    expect(LAYOUT_TEMPLATES.find((x) => x.id === 'std-orw-liquid-sidecar-du')!.computeSlots[0].platforms).toContain('amd-helios-mi455x');
    const custom = LAYOUT_TEMPLATES.find((x) => x.id === 'custom')!;
    for (const id of NPU_RACKS) expect(custom.computeSlots[0].platforms).toContain(id);
    const item = getCatalogItem('nvidia-groq3-lpx');
    expect(item.compute!.gpus).toBe(256);
    expect(item.meta?.specStatus).toBe('announced');
    expect(platformRackClass(item)).toBe('lpu-accelerator');
    expect(registeredPlatformIds('nvidia-facilities-su', 'primary')).not.toContain(item.id); // no published LPX : NVL72 layout ratio
    for (const id of ['amd-mi300x-node', 'amd-mi325x-node', 'amd-mi350x-node', 'amd-mi355x-dlc-node', 'amd-mi355x-air-node']) expect(findNodeSpec(id)!.model, id).toContain('UBB8');
    expect(findNodeSpec('amd-mi300x-node')!.description).toMatch(/UBB 2\.0 \(UBB8/);
  });
});

describe('platform registry (§E3 / §E5)', () => {
  it('the select lists only registered platforms, for every template and slot', () => {
    const all = resolveCatalog(null, null).list().filter((c) => c.category === 'gpu-rack');
    for (const t of LAYOUT_TEMPLATES) {
      for (const slot of t.computeSlots) {
        const reg = new Set(registeredPlatformIds(t.id, slot.id));
        const opts = slotPlatformOptions(t.id, slot.id).map((o) => o.value);
        expect(opts.length).toBe(reg.size);
        for (const v of opts) expect(reg.has(v), `${t.id}:${slot.id} lists ${v}`).toBe(true);
        for (const it of all) if (!reg.has(it.id)) expect(opts, `${t.id}:${slot.id}`).not.toContain(it.id);
        for (const it of registrablePlatforms(t.id, slot.id)) expect(reg.has(it.id)).toBe(false);
      }
    }
  });

  it('project layer: registering a catalog item adds it to that slot only (and only with the project context)', () => {
    const { project } = createNvidiaReferenceProject({ pods: 1 });
    expect(slotPlatformOptions('std-eia-liquid-uqd-du', 'primary', { project }).map((o) => o.value)).not.toContain('hgx-b200-air-4x');
    expect(registerPlatformInProject(project, 'std-eia-liquid-uqd-du', 'primary', 'hgx-b200-air-4x')).toBe(true);
    expect(registerPlatformInProject(project, 'std-eia-liquid-uqd-du', 'primary', 'hgx-b200-air-4x')).toBe(false);
    expect(slotPlatformOptions('std-eia-liquid-uqd-du', 'primary', { project }).map((o) => o.value)).toContain('hgx-b200-air-4x');
    expect(isPlatformRegistered('std-orw-liquid-sidecar-du', 'primary', 'hgx-b200-air-4x', { project })).toBe(false);
    expect(isPlatformRegistered('std-eia-liquid-uqd-du', 'npu', 'hgx-b200-air-4x', { project })).toBe(false);
    expect(isPlatformRegistered('std-eia-liquid-uqd-du', 'primary', 'hgx-b200-air-4x')).toBe(false);
  });

  it('library layer: a catalog item tagged meta.templateSlots is registered through the active catalog', () => {
    const copy = withTemplateSlot(getCatalogItem('intel-gaudi3-air-4x'), 'rack-scale-liquid-du', 'primary');
    expect(copy.meta?.templateSlots).toEqual(['rack-scale-liquid-du:primary']);
    expect(isPlatformRegistered('rack-scale-liquid-du', 'primary', 'intel-gaudi3-air-4x')).toBe(false);
    setActiveCatalog(resolveCatalog(null, { items: [copy] }));
    expect(slotPlatformOptions('rack-scale-liquid-du', 'primary').map((o) => o.value)).toContain('intel-gaudi3-air-4x');
    // the library copy keeps its other registrations (custom:primary is built in)
    expect(isPlatformRegistered('custom', 'primary', 'intel-gaudi3-air-4x')).toBe(true);
  });

  it('a project with an unregistered platform still generates, is flagged, and one registration clears the warning', () => {
    const { p, hall, layout } = generate('std-eia-liquid-uqd-du', 1, { gpu: 'hgx-b200-air-4x' });
    expect(layout.equipment.filter((e) => e.catalogId === 'hgx-b200-air-4x').length).toBe(20);
    expect(unregisteredPlatforms(p, hall.id)).toEqual([{ hallId: hall.id, templateId: 'std-eia-liquid-uqd-du', slotId: 'primary', catalogId: 'hgx-b200-air-4x' }]);
    registerPlatformInProject(p, 'std-eia-liquid-uqd-du', 'primary', 'hgx-b200-air-4x');
    expect(unregisteredPlatforms(p, hall.id)).toEqual([]);
  });
});

describe('heterogeneous DU generation (§E2)', () => {
  it('EIA air DU + 2 NPU racks per DU: counts per DU / row, tags, clean analysis, options round-trip', () => {
    const accelerators = [{ slotId: 'npu', catalogId: 'intel-gaudi3-air-4x', racksPerDu: 2 }];
    const { p, hall, layout } = generate('custom', 2, { accelerators });
    const acc = layout.equipment.filter(isAcc);
    expect(acc.length).toBe(4);
    expect(acc.every((e) => e.catalogId === 'intel-gaudi3-air-4x' && e.meta?.computeSlot === 'npu' && /-ACC\d+$/.test(e.tag))).toBe(true);
    for (const pod of ['pod-01', 'pod-02']) {
      expect(acc.filter((e) => e.podId === pod).length).toBe(2);
      expect(acc.filter((e) => e.rowId === `${pod}-a`).length).toBe(1);
      expect(acc.filter((e) => e.rowId === `${pod}-b`).length).toBe(1);
      expect(layout.equipment.filter((e) => e.podId === pod && gpuRack(e.catalogId) && !isAcc(e)).length).toBe(24);
    }
    const a = analyzeProject(p);
    const errs = a.issues.filter((i) => i.severity === 'error' && (i.domain === 'space' || i.domain === 'layout' || i.id.startsWith('network-unplaced') || i.id === 'network-unconnected'));
    expect(errs.map((e) => e.id)).toEqual([]);
    // finish v2 2차 (QA templates #1): accelerator-slot racks (meta.computeSlot) are not counted as GPUs of the primary platform
    expect(a.summary.gpus).toBe(2 * 24 * 64);
    const o = layoutOptionsFromProject(p, hall);
    expect(o.template.gpuRackCatalogId).toBe('pcie-cem-8x-eia42-8x');
    expect(o.template.accelerators).toEqual(accelerators);
  });

  it('an odd optional-accelerator count is split row-wise in a two-row custom DU', () => {
    const two = generate('custom', 1, { accelerators: [{ slotId: 'npu', catalogId: 'rebellions-rebel-quad-4x', racksPerDu: 3 }] }).layout.equipment.filter(isAcc);
    expect([two.filter((e) => e.rowId === 'pod-01-a').length, two.filter((e) => e.rowId === 'pod-01-b').length]).toEqual([2, 1]);
  });

  it('racksPerDu 0 or a missing catalog id keeps the DU homogeneous', () => {
    expect(generate('custom', 1, { accelerators: [{ slotId: 'npu', catalogId: 'intel-gaudi3-air-4x', racksPerDu: 0 }] }).layout.equipment.filter(isAcc)).toEqual([]);
    expect(generate('custom', 1, { accelerators: [{ slotId: 'npu', catalogId: 'no-such-rack', racksPerDu: 2 }] }).layout.equipment.filter(isAcc)).toEqual([]);
  });
});

describe('fit-to-space enumerates template × registered platforms (§E5)', () => {
  function whiteSpace(): { project: Project; hallId: string } {
    const { project } = createNvidiaReferenceProject({ pods: 4 });
    const hall = project.halls[1];
    hall.width = 36;
    hall.depth = 30;
    hall.itPowerBudgetKW = 40_000;
    hall.liquidCoolingBudgetKW = 36_000;
    hall.airCoolingBudgetKW = 12_000;
    project.site.utility.forEach((u) => (u.capacityMVA = 1e6));
    return { project, hallId: hall.id };
  }
  const policy: FitOptions['policy'] = { templateId: 'std-eia-liquid-uqd-du', orientation: 'x', corridors: CORRIDOR_DEFAULTS, crahStrategy: 'perimeter', crahWalls: ['W', 'E'], objective: 'max-gpus' };
  const base = { policy, top: 100, orientations: ['x' as const], spinePlacements: ['central-end' as const], maxColumns: 1 };

  it('fitPlatformsFor never returns an unregistered platform', () => {
    for (const t of LAYOUT_TEMPLATES) {
      const reg = registeredPlatformIds(t.id, 'primary');
      expect(fitPlatformsFor(t.id, 'all', undefined)).toEqual(reg);
      for (const pref of ['hgx-b200-air-4x', 'nvidia-gb300-nvl72', 'amd-helios-mi455x', 'intel-gaudi3-air-4x', undefined]) {
        const got = fitPlatformsFor(t.id, 'selected', pref);
        expect(got.length).toBe(1);
        expect(reg).toContain(got[0]);
        if (pref && reg.includes(pref)) expect(got).toEqual([pref]);
      }
    }
  });

  it("'all' tries every registered platform; an unregistered preferred platform falls back to the template default", () => {
    const { project, hallId } = whiteSpace();
    const hall = project.halls.find((h) => h.id === hallId)!;
    const all = fitToSpace(project, hall, { ...base, templateIds: ['std-eia-liquid-uqd-du'], platforms: 'all' });
    const reg = registeredPlatformIds('std-eia-liquid-uqd-du', 'primary');
    const seen = new Set(all.map((c) => c.platformId));
    expect(seen.size).toBeGreaterThan(1);
    for (const id of seen) expect(reg).toContain(id);
    for (const c of all) expect(c.layout.equipment.filter((e) => gpuRack(e.catalogId) && !isAcc(e)).every((e) => e.catalogId === c.platformId)).toBe(true);
    const sel = fitToSpace(project, hall, { ...base, templateIds: ['std-eia-liquid-uqd-du'], template: { gpuRackCatalogId: 'hgx-b200-air-4x' } });
    expect(sel.length).toBeGreaterThan(0);
    expect(new Set(sel.map((c) => c.platformId))).toEqual(new Set(['ubb8-oam-dlc-uqd-eia48-5x']));
    // registering it in the project makes it a valid preferred platform
    registerPlatformInProject(project, 'std-eia-liquid-uqd-du', 'primary', 'hgx-b200-air-4x');
    const reg2 = fitToSpace(project, hall, { ...base, templateIds: ['std-eia-liquid-uqd-du'], template: { gpuRackCatalogId: 'hgx-b200-air-4x' } });
    expect(new Set(reg2.map((c) => c.platformId))).toEqual(new Set(['hgx-b200-air-4x']));
  });
});
