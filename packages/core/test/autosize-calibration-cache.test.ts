import { describe, expect, it } from 'vitest';
import { addHall, autoSizeGridChoice, calibrationCacheSize, createNvidiaReferenceProject, defaultWaveStart, layoutOptionsFromProject, resolveLayoutTemplate, type AutoSizeRequest, type Project } from '../src/index.ts';

/**
 * Backlog #12 (stream D / P4): the isolated CRAH calibration of the auto-size grid probe is cached by its inputs, so the Auto-size
 * preview, Apply and remedy probes do not repeat it. Any edit that the calibration reads changes the key.
 */

function setup(templateId: string, pods: number) {
  const base = structuredClone(createNvidiaReferenceProject({ pods: 1 }).project);
  const { project: p, hallId } = addHall(base, {});
  const hall = p.halls.find((h) => h.id === hallId)!;
  const o = layoutOptionsFromProject(p, hall);
  const tpl = resolveLayoutTemplate(templateId, { project: p })!;
  const req: AutoSizeRequest = {
    templateId,
    template: { ...tpl.pod, cduCatalogId: o.template.cduCatalogId, cduRedundancy: o.template.cduRedundancy, oversubscription: o.template.oversubscription, accelerators: [] },
    pods,
    services: { spineRacks: 'auto', storageRacks: 0, cpuRacks: 0, mgmtRacks: 0 },
    crahCatalogId: o.crahCatalogId,
    marginM: 1,
    podsPerWave: 2,
    waveStart: defaultWaveStart(p, hallId),
    autoSize: true,
    crahStrategy: tpl.defaults.crahStrategy,
    servicesZone: 'auto',
    grid: { auto: true, orientation: 'x', columns: 1 },
    crahWalls: 'auto',
  };
  return { p, hall, req };
}

describe('auto-size calibration cache (backlog #12)', () => {
  it('repeated identical requests reuse one calibration and choose the same grid; an input change calibrates again', () => {
    calibrationCacheSize(true);
    const { p, hall, req } = setup('rack-scale-liquid-du', 8);
    const first = autoSizeGridChoice(p, hall, req);
    expect(calibrationCacheSize()).toBe(1);
    const again = autoSizeGridChoice(structuredClone(p), structuredClone(hall), req);
    expect(calibrationCacheSize()).toBe(1);
    expect(again).toEqual(first);
    // a cooling setting the calibration reads → new key
    const edited: Project = { ...p, cooling: { ...p.cooling, supplyAirC: p.cooling.supplyAirC + 2 } };
    autoSizeGridChoice(edited, hall, req);
    expect(calibrationCacheSize()).toBe(2);
    // a different pod count → new key
    autoSizeGridChoice(p, hall, { ...req, pods: 4 });
    expect(calibrationCacheSize()).toBe(3);
    calibrationCacheSize(true);
    expect(calibrationCacheSize()).toBe(0);
  }, 120_000);
});
