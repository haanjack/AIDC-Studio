// Finish round v2 2차 — regression tests for the rack-elevation and template findings (docs/research/finish-geometry-racks-v2-2.md).
// The wall-piercing geometry has its own sweep (geometry-wall-audit.test.ts).
import { afterEach, describe, expect, it } from 'vitest';
import {
  analyzeProject, applyHallLayout, buildCableSchedule, buildExportFiles, buildRackContents, buildRackPlan, createNvidiaReferenceProject, findCatalogItem, generateDrawings,
  generateHallLayout, getCatalogItem, layoutOptionsFromProject, normalizeLoadedProject, rackElevationsHtmlFiles, rackSlotMap, resolveLayoutTemplate, roundUpToGrid,
  setActiveCatalog, type HallLayoutOptions, type PodAccelerator, type Project,
} from '../src/index.ts';

afterEach(() => setActiveCatalog(null));

const { project: ref } = createNvidiaReferenceProject();
const refAnalysis = analyzeProject(ref);

/** same helper as templates-registry.test.ts: one template on the reference hall, budgets lifted */
function generate(templateId: string, pods: number, patch: { gpu?: string; accelerators?: PodAccelerator[] } = {}, from?: Project) {
  const t = resolveLayoutTemplate(templateId)!;
  const p: Project = structuredClone(from ?? createNvidiaReferenceProject({ pods: 1 }).project);
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

describe('rack elevations (QA rack-elevations M1–M6)', () => {
  const contents = buildRackContents(ref, refAnalysis);

  it('M6: rack-plan kW, weight and U used equal the rack contents (network racks carry their switches)', () => {
    const plan = buildRackPlan(ref, refAnalysis);
    const byId = new Map(contents.map((c) => [c.rack.id, c]));
    const sumPlan = plan.rows.reduce((s, r) => s + r.kw, 0);
    const sumContents = contents.reduce((s, c) => s + c.kwDesign, 0);
    expect(sumPlan).toBeCloseTo(sumContents, 3);
    const net = plan.rows.filter((r) => r.category === 'network-rack');
    expect(net.length).toBeGreaterThan(0);
    expect(net.some((r) => r.kw > 0)).toBe(true);
    for (const r of net) {
      const c = byId.get(ref.equipment.find((e) => e.tag === r.tag)!.id)!;
      expect(r.kw).toBeCloseTo(c.kwDesign, 6);
      expect(r.weightKg).toBe(c.weightKg);
    }
    for (const u of plan.umaps) {
      const c = byId.get(u.rackIds[0])!;
      expect(u.ruUsed, u.key).toBe(c.usedU);
    }
  });

  it('M3: GB300 power status is amber (N+N shelf margin −3 %, capping) not red; space is not rated for rack-scale maps; weight reads the floor load', () => {
    const gb = contents.filter((c) => c.rack.catalogId === 'nvidia-gb300-nvl72');
    expect(gb.length).toBe(96);
    for (const c of gb) {
      expect(c.status.power).toBe('amber');
      expect(c.powerFlags).toMatchObject({ shelfMarginPct: -3, capping: true });
      expect(c.powerFlags.peakOverKw).toBeGreaterThan(132);
      expect(c.status.space).toBe('grey');
      expect(c.spaceRated).toBe(false);
      expect(c.statusNotes.some((n) => /capping required/.test(n))).toBe(true);
    }
    const red = contents.filter((c) => c.status.overall === 'red').length;
    expect(red).toBeLessThan(10);
  });

  it('M2: run labels start with the U range and keep kW; the model moves to a second line', () => {
    const sheet = generateDrawings(ref, refAnalysis, { rackRows: ['DU01'], locale: 'en' }).find((s) => /2-DU01-A-F/.test(s.svg))!;
    expect(sheet).toBeDefined();
    expect(sheet.svg).toContain('U29–38 · 10 × CT · ');
    expect(sheet.svg).not.toContain('Comput…');
  });

  it('M4: the drawings export marks cabled switch ports (cable schedule passed)', () => {
    const files = buildExportFiles(ref, refAnalysis, 'drawings');
    const key = Object.keys(files).find((k) => /2-DU01-A-F/.test(k))!;
    const withSchedule = generateDrawings(ref, refAnalysis, { rackRows: 'all', cableSchedule: buildCableSchedule(ref, refAnalysis) }).find((s) => /2-DU01-A-F/.test(s.svg))!.svg;
    const without = generateDrawings(ref, refAnalysis, { rackRows: 'all' }).find((s) => /2-DU01-A-F/.test(s.svg))!.svg;
    expect(files[key]).toBe(withSchedule);
    expect(withSchedule).not.toBe(without);
  });

  it('M1: HTML figures are sized in mm at a fixed 1:20 and fit the A3 landscape content width', () => {
    const html = rackElevationsHtmlFiles(ref, refAnalysis, { locale: 'en' })[0].content;
    const widths = [...html.matchAll(/viewBox="0 0 ([\d.]+) ([\d.]+)" width="([\d.]+)mm"/g)].map((m) => [Number(m[1]), Number(m[3])]);
    expect(widths.length).toBeGreaterThan(10);
    for (const [vb, mm] of widths) {
      expect(mm).toBeCloseTo(vb, 1);
      expect(mm).toBeLessThanOrEqual(400);
    }
    expect(html).toContain('1:20 (A3)');
    expect(html).not.toMatch(/1:15|1:25|1:30/);
  });

  it('m6: rack-contents.csv slot weights plus the residual row equal the rack weight', () => {
    const csv = buildExportFiles(ref, refAnalysis, 'deploy');
    const key = Object.keys(csv).find((k) => k.endsWith('rack-contents.csv'))!;
    // quoted CSV fields may contain commas
    const parse = (line: string) => {
      const out: string[] = [];
      let cur = '';
      let q = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (q) {
          if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
        } else if (ch === '"') q = true;
        else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
      }
      out.push(cur);
      return out;
    };
    const lines = String(csv[key]).trim().split('\n');
    const cols = parse(lines[0]);
    const ix = { rack: cols.indexOf('rack_id'), w: cols.indexOf('weight_kg') };
    const sum = new Map<string, number>();
    for (const l of lines.slice(1)) {
      const f = parse(l);
      sum.set(f[ix.rack], (sum.get(f[ix.rack]) ?? 0) + (Number(f[ix.w]) || 0));
    }
    for (const c of contents.slice(0, 20)) expect(sum.get(c.rack.id), c.rack.tag).toBeCloseTo(c.weightKg, 0);
  });
});

describe('templates × compute slots (QA templates majors)', () => {
  it('#1: accelerator-slot racks are not counted as GPUs and cannot become the primary platform', () => {
    const { p } = generate('custom', 2, { gpu: 'amd-mi355x-air-2x', accelerators: [{ slotId: 'npu', catalogId: 'tenstorrent-galaxy-4x', racksPerDu: 2 }] });
    const a = analyzeProject(p);
    const primary = p.equipment.filter((e) => e.catalogId === 'amd-mi355x-air-2x').reduce((s, e) => s + (findCatalogItem(e.catalogId)?.compute?.gpus ?? 0), 0);
    expect(a.summary.gpus).toBe(primary);
    expect(a.issues.some((i) => i.id === 'workload-capacity-wl-infer-moe')).toBe(false);
  });

  it('#2: generating another template on a hall does not inherit the previous row shape', () => {
    const first = generate('rcu-row', 1);
    expect(new Set(first.p.equipment.filter((e) => e.podId === 'pod-01').map((e) => e.rowId)).size).toBe(1);
    const hall = first.p.halls[0];
    const tpl = resolveLayoutTemplate('std-eia-air-du')!;
    const o = layoutOptionsFromProject(first.p, hall, { templateId: 'std-eia-air-du', template: { ...tpl.pod } });
    expect(o.template.rowsPerPod ?? 2).toBe(2);
    expect(o.template.cduPlacement).toBeUndefined();
    expect(o.template.endServiceRacks ?? 0).toBe(0);
  });

  it('#3: LPX and GroqRack elevations are generic LPU stacks in their own U height — no NVLink trays, no 33 kW power shelves', () => {
    for (const id of ['nvidia-groq3-lpx', 'groq-groqrack']) {
      const item = getCatalogItem(id);
      const map = rackSlotMap(item, undefined, findCatalogItem);
      expect(map.slots.some((s) => s.category === 'scaleup-switch-tray' || s.category === 'power-shelf'), id).toBe(false);
      expect(map.source, id).toBe('estimate');
      expect(map.slots.filter((s) => s.category === 'gpu-node').length, id).toBe(item.compute!.nodesPerRack);
      expect(map.slots.every((s) => s.uEnd <= map.totalU)).toBe(true);
    }
    expect(rackSlotMap(getCatalogItem('groq-groqrack'), undefined, findCatalogItem).totalU).toBe(42);
    expect(rackSlotMap(getCatalogItem('nvidia-gb300-nvl72'), undefined, findCatalogItem).slots.some((s) => s.category === 'scaleup-switch-tray')).toBe(true);
  });

  it('#4: a liquid NPU in a heterogeneous custom DU gets CDUs', () => {
    const { p } = generate('custom', 2, { accelerators: [{ slotId: 'npu', catalogId: 'cerebras-cs3-2x', racksPerDu: 2 }] });
    expect(p.equipment.filter((e) => findCatalogItem(e.catalogId)?.category === 'cdu').length).toBeGreaterThan(0);
    const a = analyzeProject(p);
    expect(a.issues.filter((i) => i.id.startsWith('cooling-cdu-none')).map((i) => i.id)).toEqual([]);
  });

  it('#5: NVIDIA HGX node racks are registered to a template', () => {
    const t = resolveLayoutTemplate('std-eia-air-du')!;
    expect(t.computeSlots[0].platforms).toContain('hgx-b300-air-4x');
    const { layout } = generate('std-eia-air-du', 1, { gpu: 'hgx-b300-air-4x' });
    expect(layout.equipment.filter((e) => e.catalogId === 'hgx-b300-air-4x').length).toBe(20);
  });
});

describe('load normalisation (NVIDIA reference POD investigation)', () => {
  it('drops trays / busways / reservations / zones of halls that do not exist; keeps a clean project as the same object', () => {
    const p = structuredClone(ref);
    expect(normalizeLoadedProject(p)).toBe(p);
    const orphan = { ...p, halls: p.halls.filter((h) => h.id !== 'hall-a') };
    const n = normalizeLoadedProject(orphan);
    expect(n).not.toBe(orphan);
    expect((n.trays ?? []).some((t) => t.hallId === 'hall-a')).toBe(false);
    expect((n.busways ?? []).some((t) => t.hallId === 'hall-a')).toBe(false);
    expect(n.equipment).toBe(orphan.equipment);
  });
});
