import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  AMD_UBB8_RACKS,
  analyzeProject,
  createNvidiaReferenceProject,
  createReferenceProject,
  createVendorSampleProject,
  findCatalogItem,
  findNodeSpec,
  NEUTRAL_REFERENCE_NAME,
  NPU_RACKS,
  NVIDIA_HGX_RACKS,
  NVIDIA_RACK_SCALE,
  PROJECT_TEMPLATE_NAMES,
  rackSlotMap,
  rackTotalU,
  rackUnitLabel,
  standardsCheckReport,
  upgradeProject,
  type Project,
  type ProjectAnalysis,
} from '../src/index.ts';
import { termRe } from './guard-terms.ts';

/**
 * Vendor-neutral reference project and the vendor sample factory (stream D / P4; OCP-DESIGN-PROPOSAL §7, §8.3;
 * DECISIONS-v2-2 §I DO-1, DO-2, DO-6, DO-7, DO-10 and the naming instruction "NVIDIA reference").
 * Goldens: test/__golden__/reference-neutral.json (regenerate with UPDATE_GOLDEN=1 after review) and
 * test/__golden__/reference-nvidia-sample.json (captured before stream D; never regenerated).
 */

const GOLDEN_DIR = new URL('./__golden__/', import.meta.url);
const UPDATE = process.env.UPDATE_GOLDEN === '1';

let project: Project;
let pods: number;
let a: ProjectAnalysis;
beforeAll(() => {
  const r = createReferenceProject();
  project = r.project;
  pods = r.pods.length;
  a = analyzeProject(project);
}, 120_000);

const VENDOR_IDS = new Set([...NVIDIA_RACK_SCALE, ...NVIDIA_HGX_RACKS, ...AMD_UBB8_RACKS, ...NPU_RACKS, 'amd-helios-mi455x', 'nvidia-groq3-lpx']);

describe('neutral reference project (§7.1)', () => {
  it('is the default reference: neutral name, confirmed orv3-hpr-liquid profile, facility pre-check v2 for Hyperscale, advisory, drafts off', () => {
    expect(project.name).toBe(NEUTRAL_REFERENCE_NAME);
    expect(PROJECT_TEMPLATE_NAMES.reference).toBe(NEUTRAL_REFERENCE_NAME);
    expect(project.name).not.toMatch(termRe('\\bOCP\\b|Open Compute|nvidia|gb300|<t>', 'i'));
    expect(project.description).not.toMatch(termRe('\\bOCP\\b|Open Compute|nvidia|gb300|<t>', 'i'));
    expect(project.standards).toMatchObject({ id: 'orv3-hpr-liquid', rackForm: 'orv3-hpr', rackPower: 'dc-busbar-50v-hpr', shelfClass: 'hpr-33kw', facilityPrecheck: 'facility-v2hs@1.15', strictness: 'advisory', includeDraftSpecs: false });
    expect(project.standards?.inferred).toBeUndefined();
    expect(project.halls[0].layoutPolicy?.templateId).toBe('std-orv3-hpr-liquid-du');
    expect(project.halls[0].layoutPolicy?.corridors).toMatchObject({ coldAisleM: 1.4, hotAisleM: 1.2 });
    expect(project.halls[0].facility?.generatorAcceptanceS).toBeGreaterThan(0);
    // upgrade keeps the declared profile (no inference over a confirmed profile)
    expect(upgradeProject(project).standards).toEqual(project.standards);
  });

  it('places no vendor product: generic classes and generic service racks only', () => {
    const ids = [...new Set(project.equipment.map((e) => e.catalogId))];
    for (const id of ids) {
      expect(VENDOR_IDS.has(id), id).toBe(false);
      expect(['Generic', 'OEM'], id).toContain(findCatalogItem(id)!.vendor);
      expect(id, id).not.toMatch(/nvidia|amd|vertiv|liebert|broadcom|hgx|gb\d|coolit|motivair/i);
    }
    for (const id of [project.power.upsCatalogId, project.cooling.cduCatalogId, project.cooling.crahCatalogId, project.network.scaleOut.switchCatalogId, project.network.frontend.switchCatalogId, project.network.storage.switchCatalogId, project.network.oob.switchCatalogId])
      expect(findCatalogItem(id)?.vendor, id).toBe('Generic');
  });

  it('hall A: 4 DUs of 2 × 12 racks × 5 DLC nodes = 3,840 accelerators; every rack ≤ 82.5 kW (PW-01 N+1 clean)', () => {
    const gpuRacks = project.equipment.filter((e) => findCatalogItem(e.catalogId)?.category === 'gpu-rack');
    expect(gpuRacks.length).toBe(96);
    expect(new Set(gpuRacks.map((e) => e.catalogId))).toEqual(new Set(['ubb8-oam-dlc-hpr-5x']));
    expect(a.summary.gpus).toBe(3840);
    const rack = findCatalogItem('ubb8-oam-dlc-hpr-5x')!;
    expect(rack.power!.nameplateKW).toBeLessThanOrEqual(82.5);
    expect(project.halls[1].layoutPolicy).toBeUndefined();
    expect(project.equipment.every((e) => e.hallId === 'hall-a')).toBe(true);
  });

  it('≥ 2 blind-mate connector pairs per node carry the node liquid load (CL-04 clean)', () => {
    const rack = findCatalogItem('ubb8-oam-dlc-hpr-5x')!;
    const node = findNodeSpec(rack.meta!.node as string)!;
    const pairs = (node.liquidInterface!.ports ?? 0) / 2;
    expect(pairs).toBeGreaterThanOrEqual(2);
    const liquidKW = node.power.nameplateKW * (node.cooling.liquidFraction ?? 0);
    // 9 L/min per pair at 1.5 L/min per kW → 6 kW per pair (derived)
    expect(liquidKW).toBeLessThanOrEqual(pairs * 6 + 1e-9);
  });

  it('OU elevation: 44 OU frame, the 9 OU power zone and 5 nodes of ≤ 7 OU each (RK-01 clean)', () => {
    const rack = findCatalogItem('ubb8-oam-dlc-hpr-5x')!;
    expect(rackTotalU(rack)).toBe(44);
    expect(rackUnitLabel(rack)).toBe('OU');
    const map = rackSlotMap(rack, undefined, findCatalogItem);
    const power = map.slots.filter((s) => s.category === 'power-shelf').reduce((n, s) => n + s.units, 0);
    const nodes = map.slots.filter((s) => s.category === 'gpu-node');
    expect(power).toBe(9);
    expect(nodes.length).toBe(5);
    expect(nodes.every((s) => s.units <= 7)).toBe(true);
    expect(power + nodes.reduce((n, s) => n + s.units, 0)).toBeLessThanOrEqual(44);
  });

  it('check posture: no errors; RK / PW-01 / PW-06 / CL-04 / CL-05 pass; facility pre-check informational only', () => {
    expect(a.summary.errors).toBe(0);
    expect(a.issues.filter((i) => i.severity === 'error')).toEqual([]);
    const rep = standardsCheckReport(project);
    const status = (rule: string) => rep.results.filter((r) => r.ruleId === rule).map((r) => r.status);
    for (const rule of ['RK-01', 'RK-02', 'RK-03', 'PW-01', 'PW-06', 'CL-04', 'CL-05']) {
      expect(status(rule).length, rule).toBeGreaterThan(0);
      expect(status(rule).every((s) => s === 'pass'), `${rule}: ${status(rule).join(',')}`).toBe(true);
    }
    // advisory profile: no standards finding above warning
    expect(rep.results.filter((r) => r.status === 'finding').every((r) => r.severity !== 'error')).toBe(true);
    // facility pre-check rows exist for hall A and say "informational"
    expect(rep.facility.find((f) => f.hallId === 'hall-a')?.rows.length).toBeGreaterThan(5);
    expect(a.issues.find((i) => i.id === 'std-fc-summary-hall-a')?.severity).toBe('info');
  });

  it('matches the neutral reference golden (counts, kW, issues, standards posture)', () => {
    const rep = standardsCheckReport(project);
    const byCat: Record<string, number> = {};
    for (const e of project.equipment) byCat[e.catalogId] = (byCat[e.catalogId] ?? 0) + 1;
    const s = a.summary;
    const actual = {
      name: project.name, id: project.id, pods, hallA: { width: project.halls[0].width, depth: project.halls[0].depth },
      equipmentByCatalogId: Object.fromEntries(Object.entries(byCat).sort()),
      gpus: s.gpus, racks: s.racks, itKW: +(s.itMW * 1000).toFixed(3), pue: +s.pue.toFixed(5), capexUSD: Math.round(s.capexUSD), errors: s.errors, warnings: s.warnings,
      issues: a.issues.map((i) => `${i.severity}:${i.id}`).sort(),
      standardsPosture: [...new Set(rep.results.map((r) => `${r.ruleId}:${r.status}:${r.severity}`))].sort(),
    };
    const file = new URL('reference-neutral.json', GOLDEN_DIR);
    const golden = JSON.parse(readFileSync(file, 'utf8'));
    if (UPDATE) writeFileSync(file, JSON.stringify({ note: golden.note, ...actual }, null, 2) + '\n');
    const { note: _n, ...expected } = golden;
    void _n;
    expect(actual).toEqual(expected);
  });
});

describe('vendor sample factory (§7.2, DO-7): "NVIDIA reference"', () => {
  it('matches the canonical vendor-sample golden except the display name', () => {
    const golden = JSON.parse(readFileSync(new URL('reference-nvidia-sample.json', GOLDEN_DIR), 'utf8'));
    const { project: sample, pods: samplePods } = createNvidiaReferenceProject();
    expect(sample.name).toBe('NVIDIA reference');
    expect(golden.name).toBe('NVIDIA reference');
    const { createdAt: _c, updatedAt: _u, ...rest } = sample;
    void _c;
    void _u;
    const sha = createHash('sha256').update(JSON.stringify({ ...rest, name: golden.legacyName })).digest('hex');
    expect(sha).toBe(golden.projectSha);
    expect(samplePods.length).toBe(golden.pods);
    const s = analyzeProject(sample).summary;
    expect({ gpus: s.gpus, racks: s.racks, itKW: +(s.itMW * 1000).toFixed(3), pue: +s.pue.toFixed(5), capexUSD: Math.round(s.capexUSD) }).toEqual({ gpus: golden.gpus, racks: golden.racks, itKW: golden.itKW, pue: golden.pue, capexUSD: golden.capexUSD });
    expect(PROJECT_TEMPLATE_NAMES['nvidia-reference']).toBe('NVIDIA reference');
  }, 120_000);

  it('the factory, the reference option and the named builder agree', () => {
    const strip = (p: Project) => JSON.stringify({ ...p, createdAt: '', updatedAt: '' });
    const one = createVendorSampleProject('nvidia-reference', { pods: 1 }).project;
    expect(strip(createReferenceProject({ sample: 'nvidia-reference', pods: 1 }).project)).toBe(strip(one));
    expect(strip(createNvidiaReferenceProject({ pods: 1 }).project)).toBe(strip(one));
    expect(one.halls[0].layoutPolicy?.templateId).toBe('rack-scale-liquid-du');
  }, 120_000);
});
