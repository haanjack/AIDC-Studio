import { describe, expect, it } from 'vitest';
import {
  analyzeProject, buildCableSchedule, buildRackContents, buildRackPlan, buildSwitchUnits, createNvidiaReferenceProject, findCatalogItem, generateDrawings,
  hallLayoutHash, nodeU, parseCsv, rackContents, rackElevationDeployFiles, rackRowGroups, rackSlotMap, rackUMap, layoutRow, type Project, type ThermalSnapshot,
} from '../src/index.ts';

const ref = () => {
  const { project } = createNvidiaReferenceProject();
  project.updatedAt = '2026-09-14T00:00:00.000Z';
  // project-supplied free text (reference description / names may be Korean) — the EN check is about generated vocabulary
  project.description = 'Reference GB300 hall';
  project.name = 'Reference GB300 hall';
  project.site.name = 'Site';
  project.site.location = 'Seoul';
  project.halls.forEach((h, i) => { h.name = `Hall ${String.fromCharCode(65 + i)}`; });
  project.schedule.waves.forEach((w, i) => { w.name = `Wave ${i + 1}`; });
  return project;
};

function balanced(xml: string): string | null {
  const stack: string[] = [];
  const voids = new Set(['meta', 'br', 'hr', 'img', 'input', 'link']);
  const re = /<(\/?)([A-Za-z][\w:-]*)((?:[^<>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  const src = xml.replace(/<!doctype[^>]*>/i, '').replace(/<style>[\s\S]*?<\/style>/g, '');
  while ((m = re.exec(src))) {
    const [, close, name, , self] = m;
    const n = name.toLowerCase();
    if (voids.has(n) && !close) continue;
    if (close) {
      const top = stack.pop();
      if (top !== n) return `expected </${top}> got </${n}> at ${m.index}`;
    } else if (!self) stack.push(n);
  }
  return stack.length ? `unclosed ${stack.slice(-3).join(',')}` : null;
}

describe('D2 rack elevations', () => {
  const project = ref();
  const analysis = analyzeProject(project);
  const contents = buildRackContents(project, analysis);
  const groups = rackRowGroups(contents, project);
  const sheets = generateDrawings(project, analysis, { rackRows: 'all' });
  const relev = sheets.filter((s) => s.id.startsWith('relev-'));

  it('sheet count = DUs × rows × sides + services / network-core groups × sides', () => {
    const duGroups = groups.filter((g) => g.zone === 'du');
    const dus = new Set(duGroups.map((g) => g.du));
    const rowsPerDu = Math.max(...[...dus].map((d) => duGroups.filter((g) => g.du === d).length));
    const other = groups.filter((g) => g.zone !== 'du');
    const segs = groups.reduce((s, g) => s + layoutRow(g, 759 - 16).segments.length, 0);
    expect(dus.size).toBe(4);
    expect(rowsPerDu).toBe(2);
    expect(duGroups.length).toBe(dus.size * rowsPerDu);
    expect(other.length).toBeGreaterThanOrEqual(1);
    expect(relev.length).toBe(segs * 2);
    if (segs === groups.length) expect(relev.length).toBe(dus.size * rowsPerDu * 2 + other.length * 2);
    expect(relev.map((s) => s.number)).toContain('2-DU01-A-F');
    expect(relev.map((s) => s.number)).toContain('2-DU01-B-R');
    expect(sheets.map((s) => s.number)).toContain('201'); // rack-type catalogue sheet kept
    // every rack on exactly one front and one rear sheet
    const ids = new Map<string, number>();
    for (const s of relev) for (const m of s.svg.matchAll(/data-equipment-id="([^"]+)"/g)) ids.set(m[1], (ids.get(m[1]) ?? 0) + 1);
    for (const r of contents) expect(ids.get(r.rack.id)).toBe(2);
    console.log(`[D2] reference: ${groups.length} row groups, ${relev.length} rack elevation sheets, ${contents.length} racks`);
  });

  it('units match the resolver U-map, switch positions and the cable schedule; no overlap; used + free = rack U', () => {
    const units = buildSwitchUnits(project, analysis);
    const cables = buildCableSchedule(project, analysis);
    for (const r of contents) {
      const sorted = [...r.units].sort((a, b) => a.uStart - b.uStart);
      let next = 1;
      for (const u of sorted) {
        expect(u.uStart).toBe(next); // contiguous, no overlap, no gap (blanks fill free runs)
        expect(u.uEnd - u.uStart + 1).toBe(u.units);
        next = u.uEnd + 1;
      }
      expect(next - 1).toBe(r.totalU);
      expect(r.usedU + r.freeU).toBe(r.totalU);
      const item = findCatalogItem(r.rack.catalogId)!;
      const um = rackUMap(item, 'en', (analysis.network.rackLoads ?? []).find((l) => l.rackId === r.rack.id));
      expect(um.blocks.reduce((s, b) => s + b.units * b.count, 0)).toBe(r.totalU);
      for (const su of units.filter((x) => x.rackId === r.rack.id)) {
        const slot = r.units.find((u) => u.uStart === su.u && u.category === 'switch');
        expect(slot, `${r.rack.tag} switch U${su.u}`).toBeDefined();
        expect(slot!.catalogId).toBe(su.catalogId);
      }
      for (let i = 0; i < 40; i++) {
        const nu = nodeU(item, i);
        if (nu === undefined) break;
        expect(r.units.some((u) => u.uStart === nu && ['compute-tray', 'gpu-node'].includes(u.category))).toBe(true);
      }
    }
    const byRef = new Map(contents.map((r) => [`${r.rack.hallCode}.${r.rack.tag}`, r]));
    let checked = 0;
    for (const row of cables) {
      for (const [rack, u] of [[row.fromRack, row.fromU], [row.toRack, row.toU]] as [string, number | undefined][]) {
        const rc = byRef.get(rack);
        if (!rc || u === undefined) continue;
        const slot = rc.units.find((s) => u >= s.uStart && u <= s.uEnd);
        expect(slot && !['blank', 'reserved'].includes(slot.category), `${rack} U${u}`).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('NVL72 follows the vendor user-guide tray order (re-pinned cable U values)', () => {
    const gb = findCatalogItem('nvidia-gb300-nvl72')!;
    const map = rackSlotMap(gb, undefined, findCatalogItem);
    const at = (u: number) => map.slots.find((s) => u >= s.uStart && u <= s.uEnd)!;
    expect(at(5).category).toBe('power-shelf');
    expect(at(8).category).toBe('power-shelf');
    expect(at(11).category).toBe('compute-tray');
    expect(at(19).category).toBe('scaleup-switch-tray');
    expect(at(27).category).toBe('scaleup-switch-tray');
    expect(at(29).category).toBe('compute-tray');
    expect(at(38).category).toBe('compute-tray');
    expect(at(40).category).toBe('power-shelf');
    expect(at(43).category).toBe('power-shelf');
    expect(map.slots.filter((s) => s.category === 'compute-tray')).toHaveLength(18);
    expect(map.slots.filter((s) => s.category === 'scaleup-switch-tray')).toHaveLength(9);
    // cable schedule node U: tray 1 at U38 (was U40 with 8 shelves on top), tray 11 at U18 (was U21)
    expect(nodeU(gb, 0)).toBe(38);
    expect(nodeU(gb, 10)).toBe(18);
    expect(nodeU(gb, 17)).toBe(11);
  });

  it('documents: HTML well-formed and self-contained, CSV rows = devices, summary rows = rack plan, both locales, no NaN', () => {
    for (const locale of ['en', 'ko'] as const) {
      const files = rackElevationDeployFiles({ ...project, locale }, analysis, { locale });
      const html = files.find((f) => f.path === 'rack-elevations.html')!.content;
      expect(balanced(html)).toBeNull();
      expect(html).not.toMatch(/<script|<link|src="http|href="http|xlink:href="http/);
      expect(html).not.toMatch(/NaN|undefined|Infinity/);
      expect(html).not.toMatch(/\bActual\b/);
      if (locale === 'en') expect(html.replace(/<style>[\s\S]*?<\/style>/g, '')).not.toMatch(/[가-힣]/); // shared print CSS carries a Korean comment
      else expect(html).toContain('랙 입면도');
      for (const g of groups.filter((x) => x.zone === 'du')) expect(html).toContain(g.du);
      const csv = parseCsv(files.find((f) => f.path === 'rack-contents.csv')!.content).filter((r) => r.length > 1);
      // finish v2 2차 (QA m6): + one residual row per rack (slot weights + residual = rack weight)
      expect(csv.length - 1).toBe(contents.reduce((s, r) => s + r.units.length + r.zeroU.length + 1, 0));
      const sum = parseCsv(files.find((f) => f.path === 'rack-summary.csv')!.content).filter((r) => r.length > 1);
      expect(sum.length - 1).toBe(buildRackPlan(project, analysis).rows.length);
      expect(files.map((f) => f.content).join('')).not.toMatch(/NaN|undefined/);
    }
  });

  it('sheets: well-formed, text ≥ 1.8 mm, no NaN, EN / KO, deterministic', () => {
    for (const s of relev) {
      expect(balanced(s.svg), s.number).toBeNull();
      expect(s.svg).not.toMatch(/NaN|undefined|Infinity/);
      for (const m of s.svg.matchAll(/font-size="([\d.]+)"/g)) expect(Number(m[1])).toBeGreaterThanOrEqual(1.8);
      expect(s.svg).toContain('width="841mm"');
    }
    const ko = generateDrawings({ ...project, locale: 'ko' }, analysis, { rackRows: 'all' }).filter((s) => s.id.startsWith('relev-'));
    expect(ko[0].svg).toContain('전면');
    expect(relev[0].svg).not.toMatch(/[가-힣]/);
    const again = generateDrawings(project, analysis, { rackRows: 'all' }).filter((s) => s.id.startsWith('relev-'));
    expect(again.map((s) => s.svg)).toEqual(relev.map((s) => s.svg));
  });

  it('thermal snapshot: simulated values with thresholds, stale on layout change, none without', () => {
    const hall = project.halls[0];
    const racks = contents.filter((r) => r.rack.hallId === hall.id).slice(0, 5);
    const vals = [17.9, 18, 27, 27.1, 35.1];
    const snap: ThermalSnapshot = { id: 't1', hallId: hall.id, at: '2026-09-15T10:00:00Z', layoutHash: hallLayoutHash(project, hall.id), maxInletC: 35.1, racks: racks.map((r, i) => ({ id: r.rack.id, tag: r.rack.tag, inletBandsC: [vals[i], vals[i], vals[i]], inletAvgC: vals[i], inletMaxC: vals[i], exhaustC: 40, airflowM3s: 1 })) };
    const withSnap = racks.map((r) => rackContents(project, analysis, r.rack.id, { thermal: [snap] })!);
    const expected = ['amber', 'green', 'green', 'amber', 'red'];
    withSnap.forEach((c, i) => {
      expect(c.thermal.state).toBe('simulated');
      expect(c.sensors[0].valueC).toBe(vals[i]);
      if ((findCatalogItem(c.rack.catalogId)!.cooling?.maxInletC ?? 35) === 35) expect(c.sensors[1].status).toBe(expected[i]);
    });
    const stale = rackContents(project, analysis, racks[0].rack.id, { thermal: [{ ...snap, layoutHash: 'deadbeef' }] })!;
    expect(stale.thermal.state).toBe('stale');
    expect(stale.sensors.every((s) => s.valueC === undefined && s.state === 'stale')).toBe(true);
    expect(contents.every((c) => c.thermal.state === 'none' && c.sensors.every((s) => s.valueC === undefined))).toBe(true);
  });

  it('40-DU performance (synthetic project, no analysis)', () => {
    const big: Project = structuredClone(project);
    const pod1 = project.equipment.filter((e) => e.podId === 'pod-01');
    const span = Math.max(...pod1.map((e) => e.position.y)) - Math.min(...pod1.map((e) => e.position.y)) + 4;
    big.equipment = [];
    for (let k = 0; k < 40; k++) {
      const pid = `pod-${String(k + 1).padStart(2, '0')}`;
      for (const e of pod1) big.equipment.push({ ...e, id: `${e.id}-k${k}`, podId: pid, rowId: e.rowId?.replace('pod-01', pid), tag: e.tag.replace('DU01', `DU${String(k + 1).padStart(2, '0')}`), position: { ...e.position, y: e.position.y + k * span } });
    }
    big.halls = [{ ...big.halls[0], depth: big.halls[0].depth + 40 * span }];
    for (const e of big.equipment) e.hallId = big.halls[0].id;
    const t0 = performance.now();
    const c = buildRackContents(big, null);
    const t1 = performance.now();
    const sh = generateDrawings(big, null, { sheets: ['rack-elevation'], rackRows: 'all' }).filter((s) => s.id.startsWith('relev-'));
    const t2 = performance.now();
    const docs = rackElevationDeployFiles(big, null, {});
    const t3 = performance.now();
    console.log(`[D2] 40 DU: ${c.length} racks · contents ${(t1 - t0).toFixed(0)} ms · ${sh.length} sheets ${(t2 - t1).toFixed(0)} ms · docs ${docs.length} files ${(t3 - t2).toFixed(0)} ms (${(docs.reduce((s, f) => s + f.content.length, 0) / 1e6).toFixed(1)} MB)`);
    expect(new Set(c.map((r) => r.rack.du)).size).toBe(40);
    expect(docs.some((f) => f.path.startsWith('rack-elevations/'))).toBe(true); // > 16 DU → per-DU split
    expect(t2 - t0).toBeLessThan(60000);
  });
});
