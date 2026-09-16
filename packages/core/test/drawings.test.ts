import { describe, expect, it } from 'vitest';
import { analyzeProject, createNvidiaReferenceProject, generateDrawings, type DrawingSheet, type Project } from '../src/index.ts';
import { buildHallScene, phaseMatrix, rackUMap } from '../src/drawings/index.ts';
import { findCatalogItem } from '../src/catalog/catalog.ts';

/** Tiny tag-balance checker (vitest runs in node — no DOMParser): every <tag> must be closed, in order. */
function checkBalanced(svg: string): { ok: boolean; error?: string; counts: Record<string, number> } {
  const stack: string[] = [];
  const counts: Record<string, number> = {};
  const re = /<(\/?)([A-Za-z][\w:-]*)([^<>]*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg))) {
    const [, close, name, , selfClose] = m;
    if (close) {
      const top = stack.pop();
      if (top !== name) return { ok: false, error: `expected </${top}> got </${name}> at ${m.index}`, counts };
    } else {
      counts[name] = (counts[name] ?? 0) + 1;
      if (!selfClose) stack.push(name);
    }
  }
  if (stack.length) return { ok: false, error: `unclosed ${stack.join(',')}`, counts };
  return { ok: true, counts };
}

const ref = () => {
  const { project } = createNvidiaReferenceProject();
  project.updatedAt = '2026-09-14T00:00:00.000Z';
  project.client = 'ACME AI Cloud';
  project.author = 'Consultant';
  return project;
};

describe('drawings (S5)', () => {
  const project: Project = ref();
  const analysis = analyzeProject(project);
  const sheets = generateDrawings(project, analysis);
  const hallA = project.halls[0];
  const racksA = project.equipment.filter((e) => e.hallId === hallA.id && ['gpu-rack', 'cpu-rack', 'storage-rack', 'network-rack', 'mgmt-rack'].includes(findCatalogItem(e.catalogId)?.category ?? '')).length;

  it('produces plan / elevation / systems sheets with 100 / 200 / 400 numbering', () => {
    const kinds = sheets.map((s) => `${s.number}:${s.kind}`);
    expect(kinds).toContain('101:plan');
    expect(kinds).toContain('102:plan'); // hall B (empty white space)
    expect(kinds).toContain('201:rack-elevation');
    expect(kinds).toContain('401:iso-systems');
    expect(sheets.filter((s) => s.kind === 'iso-systems')).toHaveLength(1); // empty hall B gets no systems sheet
  });

  it('every sheet is a balanced SVG with a title block and no NaN', () => {
    for (const s of sheets) {
      const r = checkBalanced(s.svg);
      expect(r.ok, `${s.number}: ${r.error}`).toBe(true);
      expect(s.svg.startsWith('<svg')).toBe(true);
      expect(s.svg).not.toContain('NaN');
      expect(s.svg).not.toContain('Infinity');
      expect(s.svg).not.toContain('undefined');
      // title block fields
      expect(s.svg).toContain('AIDC Studio');
      expect(s.svg).toContain('ACME AI Cloud');
      expect(s.svg).toContain(`>${s.number}<`); // large sheet number
      expect(s.svg).toContain('Design coordination');
      expect(s.svg).toContain('2026-09-14');
      expect(s.svg).toContain('width="594mm" height="841mm"');
    }
  });

  it('plan sheet draws one rectangle per rack with a tag and a scale', () => {
    const plan = sheets.find((s) => s.number === '101')!;
    expect(plan.scale).toMatch(/^1:\d+$/);
    const r = checkBalanced(plan.svg);
    // racks + mech + keepouts + containment + pods + legend swatches ≥ rack count
    expect(r.counts.rect).toBeGreaterThanOrEqual(racksA);
    const tags = project.equipment.filter((e) => e.hallId === hallA.id).map((e) => e.tag);
    // tags are drawn at the 1.8 mm A1 minimum; inside a pod the pod prefix is dropped when the full tag does not fit (DU01-A-01 → A-01)
    const found = tags.filter((t) => plan.svg.includes(`>${t}<`) || plan.svg.includes(`>${t.replace(/^DU\d+-/, '')}<`)).length;
    expect(found).toBe(tags.length);
    expect(plan.svg).toContain('HOT AISLE');
    expect(plan.svg).toContain('Overall');
    expect(plan.svg).toContain('Pod pitch');
    expect(plan.svg).toContain('Equipment door');
  });

  it('systems sheet stacks the layers and lists systems × waves', () => {
    const iso = sheets.find((s) => s.number === '401')!;
    expect(iso.svg).toContain('CEILING PLENUM');
    expect(iso.svg).toContain('OVERHEAD');
    expect(iso.svg).toContain('FLOOR');
    expect(iso.svg).not.toContain('UNDERFLOOR'); // reference hall is slab-on-grade
    const scene = buildHallScene(project, hallA);
    const pm = phaseMatrix(scene, project, 'en');
    expect(pm.waves.map((w) => w.id)).toEqual(project.schedule.waves.map((w) => w.id));
    expect(pm.systems.map((s) => s.id)).toContain('supply-air');
    expect(pm.systems.map((s) => s.id)).toContain('busway-a');
    expect(pm.systems.map((s) => s.id)).toContain('cdu-supply');
    const busA = pm.systems.findIndex((s) => s.id === 'busway-a');
    expect(pm.cells[busA][0]).toBe('operational');
    expect(pm.cells[busA][1]).toBe('stopped'); // shared trunk: tie-in of wave 2
    const trays = pm.systems.findIndex((s) => s.id === 'trays');
    expect(pm.cells[trays][1]).toBe('operational');
    for (const w of project.schedule.waves) expect(iso.svg).toContain(w.name);
    // polygons for every rack box (3 faces each) in the floor layer
    const r = checkBalanced(iso.svg);
    expect(r.counts.polygon).toBeGreaterThanOrEqual(racksA * 3);
  });

  it('rack elevations cover every rack type incl. network racks with switch loads', () => {
    const elev = sheets.filter((s) => s.kind === 'rack-elevation');
    expect(elev.length).toBeGreaterThanOrEqual(1);
    const all = elev.map((s) => s.svg).join('');
    expect(all).toContain('GB300 NVL72');
    expect(all).toContain('Compute tray');
    expect(all).toContain('Patch panel');
    expect(all).toContain('Leaf');
    const gb = rackUMap(findCatalogItem('nvidia-gb300-nvl72')!, 'en');
    expect(gb.blocks.filter((b) => b.kind === 'compute').reduce((s, b) => s + b.count, 0)).toBe(18);
    expect(gb.blocks.filter((b) => b.kind === 'switch').reduce((s, b) => s + b.count, 0)).toBe(9);
    const helios = findCatalogItem('amd-helios-mi455x');
    if (helios) {
      const hu = rackUMap(helios, 'en');
      expect(hu.unit).toBe('OU');
      expect(hu.totalU).toBe(44);
      expect(hu.blocks.reduce((s, b) => s + b.units * b.count, 0)).toBe(44);
    }
  });

  it('follows project.locale (ko) and is deterministic', () => {
    const ko = generateDrawings({ ...project, locale: 'ko' }, analysis);
    expect(ko[0].svg).toContain('상면');
    expect(ko.find((s) => s.kind === 'iso-systems')!.svg).toContain('천장 플레넘');
    const again = generateDrawings(project, analysis);
    expect(again.map((s) => s.svg)).toEqual(sheets.map((s) => s.svg));
  });

  it('works without analysis and with an empty project', () => {
    const noAnalysis = generateDrawings(project, null);
    expect(noAnalysis.length).toBe(sheets.length);
    const empty: Project = { ...project, equipment: [], containments: [], halls: [{ ...project.halls[0], keepouts: [] }] };
    const es = generateDrawings(empty, null);
    expect(es.map((s: DrawingSheet) => s.kind)).toEqual(['plan']);
    expect(checkBalanced(es[0].svg).ok).toBe(true);
    expect(es[0].svg).not.toContain('NaN');
  });
});

describe('drawings export format (files.ts append)', () => {
  it("buildExportFiles(..., 'drawings') returns one SVG per sheet", async () => {
    const { buildExportFiles, EXPORT_FORMATS } = await import('../src/export/files.ts');
    const project = ref();
    const files = buildExportFiles(project, null, 'drawings');
    const names = Object.keys(files);
    expect(EXPORT_FORMATS).toContain('drawings');
    // D2 (DECISIONS-v2-2 §D): the drawings export also carries the per-DU rack row sheets (opt-in in generateDrawings)
    expect(names.length).toBe(generateDrawings(project, null, { rackRows: 'all' }).length);
    expect(names.some((n) => n.startsWith('200-rack-elevations/DU01/2-DU01-A-F'))).toBe(true);
    expect(names.every((n) => n.endsWith('.svg'))).toBe(true);
    expect(names.some((n) => n.startsWith('101-'))).toBe(true);
    expect(names.some((n) => n.startsWith('401-'))).toBe(true);
  });
});
