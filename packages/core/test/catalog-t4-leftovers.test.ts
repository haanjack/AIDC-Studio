import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  analyzeProject, announcedSpec, buildWaveBom, builtinCatalog, candidateCompute, catalogItems, chipComputeTflops, computeCountsByPod, computeCountsOf, coolantLimitCheck,
  createNvidiaReferenceProject, findCatalogItem, fitCandidateOrder, isRegistrationRecord, LAYOUT_TEMPLATES, libraryWithRegistration, mergeRegistrationRecords, migrateLibraryRegistrations,
  mixedComputeFamilies, registerPlatformInProject, resolveCatalog, setActiveCatalog, slotMissingEquipmentIds, unregisteredPlatforms, waveBomMarkdown, withTemplateSlot,
  type CatalogItem, type FitCandidate, type Project,
} from '../src/index.ts';
import { countOf, plural, pluralKey } from '../../../apps/web/src/i18n/plural.ts';

/** Stream T4 (technical leftovers 2026-09-15): catalog / workload / web helper fixes. */

afterEach(() => setActiveCatalog(null));

const placeableGpuRacks = () => catalogItems().filter((it) => it.category === 'gpu-rack' && it.meta?.placeable !== false && (it.compute?.gpus ?? 0) > 0);

function withAcceleratorRack(): { project: Project; accId: string; accChips: number } {
  const { project: base } = createNvidiaReferenceProject({ pods: 1 });
  const project = structuredClone(base);
  const racks = project.equipment.filter((e) => findCatalogItem(e.catalogId)?.category === 'gpu-rack');
  expect(racks.length).toBeGreaterThan(1);
  const acc = racks[racks.length - 1];
  acc.meta = { ...(acc.meta ?? {}), computeSlot: 'npu' };
  return { project, accId: acc.id, accChips: findCatalogItem(acc.catalogId)!.compute!.gpus };
}

describe('T4 #1 coolant limit vs TCS supply', () => {
  it('flags a liquid platform whose coolant limit is below the TCS supply with the exact numbers', () => {
    const item = { id: 'x', cooling: { liquidFraction: 0.9, airflowM3s: 1, liquidFlowLpm: 10, maxInletC: 35, maxCoolantSupplyC: 30 } } as CatalogItem;
    expect(coolantLimitCheck(item, 35)).toEqual({ catalogId: 'x', limitC: 30, tcsSupplyC: 35, excessC: 5 });
    expect(coolantLimitCheck(item, 30)).toBeUndefined();
    expect(coolantLimitCheck({ ...item, cooling: { ...item.cooling!, liquidFraction: 0 } }, 45)).toBeUndefined();
    expect(coolantLimitCheck({ ...item, cooling: { ...item.cooling!, maxCoolantSupplyC: undefined } }, 45)).toBeUndefined();
  });
  it('every built-in liquid GPU rack is checked against the reference TCS supply without throwing', () => {
    const { project } = createNvidiaReferenceProject({ pods: 1 });
    for (const it of placeableGpuRacks()) {
      const c = coolantLimitCheck(it, project.cooling.tcsSupplyC);
      if (c) expect(c.limitC).toBeLessThan(project.cooling.tcsSupplyC);
    }
  });
});

describe('T4 #2 / #6 accelerator-slot chips are their own count', () => {
  it('computeCountsOf / computeCountsByPod split GPUs and accelerator-slot chips', () => {
    const item = { category: 'gpu-rack', compute: { gpus: 72 } } as CatalogItem;
    expect(computeCountsOf({}, item)).toEqual({ gpus: 72, accelerators: 0 });
    expect(computeCountsOf({ meta: { computeSlot: 'lpx' } }, item)).toEqual({ gpus: 0, accelerators: 72 });
    expect(computeCountsOf({}, { category: 'cdu' } as CatalogItem)).toEqual({ gpus: 0, accelerators: 0 });
    const { project, accChips } = withAcceleratorRack();
    const byPod = computeCountsByPod(project.equipment, findCatalogItem);
    const tot = [...byPod.values()].reduce((s, c) => ({ gpus: s.gpus + c.gpus, acc: s.acc + c.accelerators }), { gpus: 0, acc: 0 });
    expect(tot.acc).toBe(accChips);
  });
  it('analysis summary carries acceleratorChips outside gpus; the BOM has an accelerator line and column', () => {
    const { project: base } = createNvidiaReferenceProject({ pods: 1 });
    const before = analyzeProject(base).summary.gpus;
    const { project, accChips } = withAcceleratorRack();
    const a = analyzeProject(project);
    expect(a.summary.acceleratorChips).toBe(accChips);
    expect(a.summary.gpus).toBe(before - accChips);
    const bom = buildWaveBom(project, a, 'en');
    expect(bom.lines.some((l) => l.group === 'racks' && /accelerator slot \(\d+ chips? per rack, not counted as GPUs\)/.test(l.description))).toBe(true);
    const md = waveBomMarkdown(project, a, bom, 'en');
    expect(md).toContain('Accelerators (slot)');
    expect(waveBomMarkdown(project, a, buildWaveBom(project, a, 'ko'), 'ko')).toContain('가속기(슬롯)');
  });
});

describe('T4 #3 fit ranking across accelerator families', () => {
  const cand = (id: string, gpus: number, family: string, tflopsPerChip: number, errors = 0) =>
    ({ id, gpus, computeFamily: family, computeTflops: gpus * tflopsPerChip, errors, score: gpus, rowsAlongLongSide: true, columns: 1, cableUSD: 0 }) as unknown as FitCandidate;
  it('mixed families rank by normalised compute, a single family keeps the chip-count order', () => {
    const npu = cand('npu', 9216, 'npu-x', 100);
    const gpu = cand('gpu', 6912, 'blackwell', 1500);
    const mixed = [npu, gpu];
    expect(mixedComputeFamilies(mixed)).toBe(true);
    expect([...mixed].sort(fitCandidateOrder('max-gpus', mixed)).map((c) => c.id)).toEqual(['gpu', 'npu']);
    const same = [cand('a', 100, 'blackwell', 1500), cand('b', 200, 'blackwell', 1500)];
    expect(mixedComputeFamilies(same)).toBe(false);
    expect([...same].sort(fitCandidateOrder('max-gpus', same)).map((c) => c.id)).toEqual(['b', 'a']);
    const withErr = [cand('big', 6912, 'blackwell', 1500, 2), npu];
    expect([...withErr].sort(fitCandidateOrder('max-gpus', withErr))[0].id).toBe('npu');
  });
  it('candidateCompute counts primary racks only and names a source per chip', () => {
    const racks = placeableGpuRacks();
    const r = racks[0];
    const c1 = candidateCompute([{ catalogId: r.id }, { catalogId: r.id, meta: { computeSlot: 'npu' } }]);
    const chip = chipComputeTflops(r);
    expect(chip.tflops).toBeGreaterThan(0);
    expect(chip.source).not.toBe('none');
    expect(c1.computeTflops).toBeCloseTo(r.compute!.gpus * chip.tflops, 3);
    for (const it of racks) expect(chipComputeTflops(it).tflops).toBeGreaterThan(0);
  });
});

describe('T4 #4 library registration stores a record, not a copy', () => {
  const builtin = () => builtinCatalog().items;
  it('registration record merges into the current built-in item (seed updates stay visible)', () => {
    const item = placeableGpuRacks()[0];
    const lib = libraryWithRegistration({ items: [], cables: [] }, item, builtin(), 'std-eia-liquid-uqd-du:primary');
    expect(lib.items).toHaveLength(1);
    expect(isRegistrationRecord(lib.items![0])).toBe(true);
    expect(lib.items![0].power).toBeUndefined();
    const resolved = resolveCatalog(null, lib).items.get(item.id)!;
    expect(resolved.power).toEqual(item.power);
    expect(resolved.meta?.templateSlots).toContain('std-eia-liquid-uqd-du:primary');
    const updatedSeed = new Map(builtin());
    updatedSeed.set(item.id, { ...item, weightKg: item.weightKg + 123 });
    expect(mergeRegistrationRecords(updatedSeed, lib.items!)[0].weightKg).toBe(item.weightKg + 123);
    // a second registration extends the same record
    const lib2 = libraryWithRegistration(lib, item, builtin(), 'std-eia-air-du:primary');
    expect(lib2.items).toHaveLength(1);
    expect(lib2.items![0].meta?.templateSlots).toEqual(['std-eia-liquid-uqd-du:primary', 'std-eia-air-du:primary']);
    // records without a base item are dropped at resolve time
    expect(mergeRegistrationRecords(new Map(), lib.items!)).toEqual([]);
  });
  it('migrates equal full copies and keeps edited copies', () => {
    const [a, b] = placeableGpuRacks();
    const copyA = withTemplateSlot(a, 'std-eia-liquid-uqd-du', 'primary');
    const editedB = { ...withTemplateSlot(b, 'std-eia-liquid-uqd-du', 'primary'), weightKg: b.weightKg + 1 };
    const r = migrateLibraryRegistrations({ items: [copyA, editedB], cables: [] }, builtin());
    expect(r.migrated).toEqual([a.id]);
    expect(r.kept).toEqual([b.id]);
    expect(isRegistrationRecord(r.library.items![0])).toBe(true);
    expect(r.library.items![1]).toBe(editedB);
  });
  it('the record passes the server library validation', async () => {
    const { catalogLibraryErrors } = await import('../../../apps/server/src/catalogStore.ts');
    const lib = libraryWithRegistration({ items: [], cables: [] }, placeableGpuRacks()[0], builtin(), 'std-eia-liquid-uqd-du:primary');
    expect(catalogLibraryErrors(lib)).toEqual([]);
  });
});

describe('T4 #5 announced badge data', () => {
  it('reads meta.specStatus / announcedFields', () => {
    const lpx = findCatalogItem('nvidia-groq3-lpx');
    expect(lpx).toBeDefined();
    const a = announcedSpec(lpx);
    expect(a.announced).toBe(true);
    expect(a.fields.length).toBeGreaterThan(0);
    expect(announcedSpec(placeableGpuRacks().find((x) => !x.meta?.specStatus && x.source !== 'announced')).announced).toBe(false);
  });
});

describe('T4 #7 accelerator rack in a slot the template does not have', () => {
  it('reports slotMissing, registration cannot clear it, removal ids are listed', () => {
    const { project, accId } = withAcceleratorRack();
    const tpl = LAYOUT_TEMPLATES.find((t) => !t.computeSlots.some((s) => s.id === 'npu'))!;
    const hall = project.halls[0];
    hall.layoutPolicy = { ...(hall.layoutPolicy ?? {}), templateId: tpl.id } as NonNullable<typeof hall.layoutPolicy>;
    const acc = project.equipment.find((e) => e.id === accId)!;
    acc.hallId = hall.id;
    acc.podId = acc.podId?.startsWith('pod-') && !acc.podId.startsWith('pod-services') ? acc.podId : 'pod-01';
    const miss = unregisteredPlatforms(project, hall.id).filter((u) => u.slotMissing);
    expect(miss).toHaveLength(1);
    expect(miss[0]).toMatchObject({ slotId: 'npu', catalogId: acc.catalogId, slotMissing: true });
    registerPlatformInProject(project, tpl.id, 'npu', acc.catalogId);
    expect(unregisteredPlatforms(project, hall.id).some((u) => u.slotMissing)).toBe(true);
    expect(slotMissingEquipmentIds(project, miss[0])).toEqual([accId]);
    project.equipment = project.equipment.filter((e) => e.id !== accId);
    expect(unregisteredPlatforms(project, hall.id).some((u) => u.slotMissing)).toBe(false);
  });
});

describe('T4 #9 English plural helper', () => {
  it('picks <key>_one for a count of 1 in English only', () => {
    const has = (k: string) => k === 'x.nodes_one';
    expect(pluralKey('en', 'x.nodes', { n: 1 }, has)).toBe('x.nodes_one');
    expect(pluralKey('en', 'x.nodes', { n: '1' }, has)).toBe('x.nodes_one');
    expect(pluralKey('en', 'x.nodes', { n: 2 }, has)).toBe('x.nodes');
    expect(pluralKey('en', 'x.nodes', { count: 1 }, has)).toBe('x.nodes_one');
    expect(pluralKey('en', 'x.other', { n: 1 }, has)).toBe('x.other');
    expect(pluralKey('ko', 'x.nodes', { n: 1 }, has)).toBe('x.nodes');
    expect(countOf({ n: '1,234' })).toBe(1234);
    expect(plural(1, 'node', 'nodes')).toBe('node');
    expect(plural(0, 'node', 'nodes')).toBe('nodes');
  });
  it('every English _one key has its base key, no Hangul, and Korean _one keys repeat the Korean base text', () => {
    const dir = fileURLToPath(new URL('../../../apps/web/src/i18n/locales/', import.meta.url));
    for (const loc of ['en', 'ko']) {
      for (const f of readdirSync(dir + loc)) {
        const text = readFileSync(`${dir}${loc}/${f}`, 'utf8');
        const keys = [...text.matchAll(/^\s*['"]([\w.\-]+)['"]\s*:/gm)].map((m) => m[1]);
        const ones = keys.filter((k) => k.endsWith('_one'));
        if (loc === 'ko') { for (const k of ones) { const v = (key: string) => text.match(new RegExp(`^\\s*['"]${key.replace(/\./g, '\\.')}['"]\\s*:\\s*(.*)$`, 'm'))?.[1]; expect(v(k)).toBe(v(k.slice(0, -4))); } continue; }
        for (const k of ones) expect(keys).toContain(k.slice(0, -4));
        for (const m of text.matchAll(/^\s*['"][\w.\-]+_one['"]\s*:\s*(.*)$/gm)) expect(m[1]).not.toMatch(/[가-힣]/);
      }
    }
  });
});
