// v2 2차 contract: every stub is exported from @aidc/core with its final signature, and the trivial defaults hold.
// When a stream makes its stub live, it updates the matching pin here (this file is shared; localized edits only).
import { describe, expect, it } from 'vitest';
import {
  analyzeMaxQ, analyzePowerPaths, analyzeProject, BENCHMARKS, buildCableSchedule, buildIpPlan, calibrateFromBenchmark, catalogImage,
  compareCoolingTopologies, coolingPlacementFor, createNvidiaReferenceProject, defaultServicesZone, ETA_SOURCES, etaFromMeasurement,
  evaluatePowerScenario, findCatalogItem, findModelPreset, generateNosConfigs, generateTestPlan, gpuShareTotal, htmlPage, htmlTable,
  MODEL_PRESETS, normalizeShares, NOS_TARGETS, parseCollectiveLog, regenerateCooling, renderDesignDocumentHtml, resolveClusters,
  servicesZoneRect, takeShare, toCsv,
} from '../src/index.ts';

const { project } = createNvidiaReferenceProject();
const analysis = analyzeProject(project);

describe('v2 2차 contract', () => {
  it('resolveClusters: one cluster per populated hall by default, explicit clusters win', () => {
    const populated = new Set(project.equipment.map((e) => e.hallId));
    const clusters = resolveClusters(project);
    expect(clusters.length).toBe(project.halls.filter((h) => populated.has(h.id)).length);
    for (const c of clusters) {
      expect(c.hallIds).toHaveLength(1);
      expect(populated.has(c.hallIds[0])).toBe(true);
    }
    const explicit = [{ id: 'c-all', name: 'All halls', hallIds: project.halls.map((h) => h.id) }];
    expect(resolveClusters({ ...project, clusters: explicit })).toBe(explicit);
  });

  it('model presets and benchmarks are copied from r2-model-presets.json', () => {
    expect(MODEL_PRESETS).toHaveLength(24);
    expect(BENCHMARKS).toHaveLength(15);
    const ds = findModelPreset('deepseek-v3')!;
    expect(ds).toMatchObject({ kind: 'moe', paramsB: 671, activeParamsB: 37, layers: 61, hiddenSize: 7168, vocab: 129280, moe: { experts: 256, topK: 8, shared: 1, denseLayers: 3 }, mla: { dLatent: 512, dRope: 64 } });
    expect(findModelPreset('qwen3-235b-a22b')?.headDim).toBe(128);
    for (const id of ['glm-5.2', 'kimi-k2.5', 'kimi-k3', 'minimax-m3', 'deepseek-v4-pro', 'deepseek-v4-flash', 'qwen3.5-122b-a10b', 'qwen3.5-35b-a3b', 'deepseek-r1', 'llama3.1-70b']) {
      expect(findModelPreset(id), id).toBeDefined();
    }
    expect(new Set(MODEL_PRESETS.map((p) => p.id)).size).toBe(MODEL_PRESETS.length);
    expect(new Set(BENCHMARKS.map((b) => b.id)).size).toBe(BENCHMARKS.length);
    // every row cites a source (URL, or a local research note for user-supplied PDFs such as the AMD RA)
    expect(BENCHMARKS.every((b) => b.sourceUrl.length > 0)).toBe(true);
    expect(BENCHMARKS.find((b) => b.id === 'amd-grok2-mi355x-64')?.sourceType).toBe('vendor-claim');
  });

  it('toCsv / htmlTable / htmlPage escape correctly', () => {
    expect(toCsv([{ a: 'x,y', b: 'say "hi"', c: 3 }, { a: 'plain', d: true }])).toBe('a,b,c,d\n"x,y","say ""hi""",3,\nplain,,,true\n');
    expect(toCsv([{ a: 1, b: 2 }], ['b', 'a'])).toBe('b,a\n2,1\n');
    expect(htmlTable(['<h>'], [['a&b']], { numericCols: [0] })).toContain('<td class="num">a&amp;b</td>');
    expect(htmlPage('T <1>', '<p>x</p>', 'ko')).toMatch(/^<!doctype html>\n<html lang="ko">[\s\S]*<title>T &lt;1&gt;<\/title>[\s\S]*<p>x<\/p>/);
  });

  it('small helpers with trivial defaults', () => {
    expect(defaultServicesZone('phased')).toBe('end-band');
    expect(defaultServicesZone(undefined)).toBe('end-band');
    expect(defaultServicesZone('single-build')).toBe('center-band');
    expect(coolingPlacementFor(project.halls[0]).cduPerPod).toBe('auto');
    expect(gpuShareTotal(project.workloads)).toBeCloseTo(project.workloads.reduce((s, w) => s + w.gpuShare, 0), 12);
    expect(NOS_TARGETS).toHaveLength(7);
  });

  it('stubs return empty / identity values and analyzeProject output is unchanged', () => {
    const hallId = project.halls[0].id;
    const rack = findCatalogItem('nvidia-gb300-nvl72')!;
    // T1 live: services-zone band rect + regenerate-cooling-only (behaviour tests in layout-zones / layout-cooling tests)
    expect(servicesZoneRect(project, hallId)?.w).toBeGreaterThan(0);
    const cooled = regenerateCooling(project, hallId, coolingPlacementFor(project.halls[0]));
    expect(cooled).not.toBe(project);
    expect(cooled.halls[0].coolingPlacement).toEqual(coolingPlacementFor(project.halls[0]));
    expect(regenerateCooling(project, 'no-such-hall', coolingPlacementFor(project.halls[0]))).toBe(project);
    expect(ETA_SOURCES.length).toBeGreaterThan(0); // T2 live — sourced η defaults (eta.test.ts)
    expect(parseCollectiveLog('# nccl-tests')).toEqual([]);
    expect(etaFromMeasurement({ tool: 'nccl-tests', collective: 'all_reduce', rows: [] }, 400).nominalGBps).toBe(400);
    expect(buildCableSchedule(project, analysis).length).toBe(analysis.network.cableRuns.reduce((s, r) => s + r.count, 0)); // T2 live (links-ipplan.test.ts)
    expect(buildIpPlan(project, analysis).blocks.length).toBeGreaterThan(0); // T2 live (links-ipplan.test.ts)
    // T3 live: power plane paths + Max-Q (behaviour tests in power-plane.test.ts)
    expect(analyzePowerPaths(project).length).toBeGreaterThan(0);
    expect(evaluatePowerScenario(project, analysis, { kind: 'normal' }).droppedEquipmentIds).toEqual([]);
    expect(analyzeMaxQ(project, analysis)?.budgetKW).toBeGreaterThan(0);
    expect(compareCoolingTopologies(project, analysis).map((r) => r.option)).toEqual(['gallery-fan-wall', 'perimeter-crah', 'in-row', 'sidecar-l2a', 'rdhx']); // T4 live (cooling-topology.test.ts)
    // T6 live: training row → training blueprint gives a back-solved MFU; shares are real (workload-v2-2.test.ts)
    expect(calibrateFromBenchmark(project.workloads[0], BENCHMARKS[0], rack).mfu).toBeGreaterThan(0);
    expect(normalizeShares([{ ...project.workloads[0], gpuShare: 0.5 }])).toHaveLength(1);
    expect(takeShare(project.workloads, project.workloads[0].id, project.workloads[0].gpuShare)).toBe(project.workloads);
    // T5 live: GB300 has a GLB → rendered thumbnail (precedence tests in catalog-images.test.ts)
    // N1a (neutralization): no thumbnail map registered in this test → schematic (thumbnails are never guessed; pack-derived
    // gb300 thumbnails were archived). Precedence with a registered map is covered in catalog-images.test.ts.
    expect(catalogImage(rack)?.kind).toBe('schematic');
    // T7 live: HTML design document, NOS bundles (README first), test kit (behaviour tests in docs-html / nos / testplan tests)
    expect(renderDesignDocumentHtml(project, analysis, { locale: 'en' })).toMatch(/^<!doctype html>/);
    expect(generateNosConfigs(project, analysis, buildIpPlan(project, analysis), 'sonic')[0].path).toBe('README.txt');
    expect(generateTestPlan(project, analysis).some((f) => f.path === '30-collectives/eta_mpirun.sh')).toBe(true);
    expect('paths' in analysis.power).toBe(true);
    expect('maxq' in analysis.power).toBe(true);
    expect(analysis.cooling.topology?.length).toBe(5); // T4 live: attached by analyzeProject
  });
});
