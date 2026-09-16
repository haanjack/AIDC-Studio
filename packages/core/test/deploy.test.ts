import { describe, expect, it } from 'vitest';
import {
  CABLE_SCHEDULE_COLUMNS, EXPORT_FORMATS, IP_PLAN_COMBINED_COLUMNS, IP_PLAN_SECTIONS, SWITCH_INVENTORY_COLUMNS, analyzeProject, buildDeployBundle, buildExportFiles, buildRackPlan, buildWaveBom,
  cableScheduleCsv, createNvidiaReferenceProject, csvFile, lengthBin, parseCsv, toCsv, topologyDot, type ProjectAnalysis,
} from '../src/index.ts';
import { tagBalance } from './docs-helpers.ts';
import { nosFixture } from './nos-fixtures.ts';

const project = createNvidiaReferenceProject().project;
const a: ProjectAnalysis = analyzeProject(project);
const sum = <T,>(xs: T[], f: (x: T) => number) => xs.reduce((s, x) => s + f(x), 0);

describe('deployment bundle — BOM by wave', () => {
  const bom = buildWaveBom(project, a, 'en');
  const byItem = (group: string) => {
    const m = new Map<string, number>();
    for (const l of bom.lines.filter((x) => x.group === group)) m.set(l.itemId, (m.get(l.itemId) ?? 0) + l.qty);
    return m;
  };

  it('lists every project wave plus a common bucket and assigns racks to waves', () => {
    expect(bom.waves.map((w) => w.id)).toEqual(project.schedule.waves.map((w) => w.id));
    const rackWaves = new Set(bom.lines.filter((l) => l.group === 'racks').map((l) => l.waveId));
    for (const w of project.schedule.waves) expect(rackWaves.has(w.id), w.id).toBe(true);
  });

  it('rack quantities reconcile with the cost BOM (it + network domains)', () => {
    const racks = byItem('racks');
    for (const line of a.cost.bom.filter((l) => l.domain === 'it' || (l.domain === 'network' && l.itemId.includes('rack')))) {
      expect(racks.get(line.itemId), line.itemId).toBe(line.qty);
    }
    expect(sum([...racks.values()], (v) => v)).toBe(a.summary.racks);
  });

  it('switch quantities (placed + unplaced) reconcile with the cost BOM', () => {
    const sw = byItem('switches');
    const bomSwitches = a.cost.bom.filter((l) => l.domain === 'network' && !l.itemId.includes('rack'));
    expect(bomSwitches.length).toBeGreaterThan(0);
    for (const line of bomSwitches) expect(sw.get(line.itemId), line.itemId).toBe(line.qty);
  });

  it('cables per type and transceivers reconcile with the network analysis and the cost BOM', () => {
    const cables = byItem('cables');
    const optics = byItem('transceivers');
    for (const c of a.network.cablesByType) {
      expect(cables.get(c.cableTypeId), c.cableTypeId).toBe(c.count);
      if (c.transceivers > 0) expect(optics.get(`${c.cableTypeId}-optic`), c.cableTypeId).toBe(c.transceivers);
      const metres = sum(bom.lines.filter((l) => l.group === 'cables' && l.itemId === c.cableTypeId), (l) => l.totalLengthM ?? 0);
      expect(Math.abs(metres - c.totalLengthM)).toBeLessThan(1);
    }
    for (const line of a.cost.bom.filter((l) => l.domain === 'cabling')) {
      const q = line.itemId.endsWith('-optic') ? optics.get(line.itemId) : cables.get(line.itemId);
      expect(q, line.itemId).toBe(line.qty);
    }
    for (const l of bom.lines.filter((x) => x.group === 'cables')) expect(l.lengthBin).toBeTruthy();
    expect(lengthBin(2)).toBe('≤3 m');
    expect(lengthBin(45)).toBe('30–50 m');
    expect(lengthBin(900)).toBe('>500 m');
  });

  it('CDU / CRAH totals reconcile with the cooling analysis and PDUs with the power analysis', () => {
    const cooling = bom.lines.filter((l) => l.group === 'cooling');
    const cdus = sum(cooling.filter((l) => l.itemId === project.cooling.cduCatalogId || l.description.toLowerCase().includes('cdu')), (l) => l.qty);
    expect(cdus).toBeGreaterThanOrEqual(a.cooling.cdus.units);
    const bomCdu = a.cost.bom.filter((l) => l.domain === 'cooling' && cooling.some((c) => c.itemId === l.itemId));
    for (const line of bomCdu) expect(sum(cooling.filter((c) => c.itemId === line.itemId), (c) => c.qty), line.itemId).toBe(line.qty);
    expect(sum(bom.lines.filter((l) => l.group === 'pdus'), (l) => l.qty)).toBe(a.power.rpps.units);
  });

  it('is deterministic and localised', () => {
    expect(buildWaveBom(project, a, 'en')).toEqual(bom);
    const ko = buildWaveBom(project, a, 'ko');
    expect(ko.lines.length).toBe(bom.lines.length);
  });
});

describe('deployment bundle — rack plan', () => {
  const plan = buildRackPlan(project, a, 'en');

  it('has one row per rack (= analysis rack count) with hall / row / position / tag / wave / kW / weight', () => {
    expect(plan.rows.length).toBe(a.summary.racks);
    expect(new Set(plan.rows.map((r) => r.tag)).size).toBe(plan.rows.length);
    for (const r of plan.rows) {
      expect(r.hall).toBeTruthy();
      expect(r.row).toBeTruthy();
      expect(r.position).toBeGreaterThan(0);
      expect(r.waveId).toBeTruthy();
      expect(r.weightKg).toBeGreaterThan(0);
    }
    expect(plan.rows.filter((r) => r.category === 'gpu-rack').length).toBe(a.summary.gpuRacks);
    expect(plan.rows.filter((r) => r.category === 'gpu-rack').every((r) => r.kw > 100)).toBe(true);
  });

  it('positions are 1..n within each row without gaps', () => {
    const rows = new Map<string, number[]>();
    for (const r of plan.rows) rows.set(`${r.hallId}|${r.row}`, [...(rows.get(`${r.hallId}|${r.row}`) ?? []), r.position]);
    for (const [k, ps] of rows) expect([...ps].sort((x, y) => x - y), k).toEqual(ps.map((_, i) => i + 1));
  });

  it('builds U-maps per rack type from rackLoads (network) and public specs (NVL72)', () => {
    expect(plan.umaps.length).toBeGreaterThan(1);
    expect(sum(plan.umaps, (u) => u.rackIds.length)).toBe(plan.rows.length);
    const gpu = plan.umaps.find((u) => u.category === 'gpu-rack')!;
    expect(gpu.entries.some((e) => e.content.includes('NVLink'))).toBe(true);
    expect(gpu.entries.every((e) => e.ruFrom >= 1 && e.ruTo <= gpu.ruCapacity)).toBe(true);
    const net = plan.umaps.filter((u) => u.category === 'network-rack');
    expect(net.length).toBeGreaterThan(0);
    expect(net.some((u) => u.entries.some((e) => /leaf|spine|core/.test(e.content)))).toBe(true);
    for (const u of plan.umaps) expect(u.ruUsed).toBeLessThanOrEqual(u.ruCapacity);
  });
});

describe('CSV helpers (RFC 4180 + Excel)', () => {
  it('quotes commas, quotes, line breaks and edge whitespace; csvFile adds BOM + CRLF; parseCsv round-trips', () => {
    const rows = [{ a: 'x,y', b: 'say "hi"', c: 'two\nlines' }, { a: ' pad', b: '한글', c: 3 }];
    const text = csvFile(rows, ['a', 'b', 'c']);
    expect(text.startsWith('﻿a,b,c\r\n')).toBe(true);
    expect(text).toContain('"x,y","say ""hi""","two\nlines"\r\n');
    expect(parseCsv(text)).toEqual([['a', 'b', 'c'], ['x,y', 'say "hi"', 'two\nlines'], [' pad', '한글', '3']]);
    expect(toCsv([{ a: 1 }], ['a'])).toBe('a\n1\n');
  });
});

describe('deployment bundle — files (HTML + CSV, no Markdown)', () => {
  const fx = nosFixture();
  const injected = buildDeployBundle(fx.project, fx.analysis, { locale: 'en', cableSchedule: fx.rows, ipPlan: fx.plan });
  const get = (files: typeof injected, p: string) => String(files.find((f) => f.path === p)?.content ?? '');

  it('ships CSV + HTML for BOM, rack plan, cable schedule, IP plan and the switch inventory in both locales', () => {
    for (const locale of ['en', 'ko'] as const) {
      const files = buildDeployBundle(project, a, { locale });
      const paths = files.map((f) => f.path);
      expect(paths).toEqual([
        'bom-by-wave.csv', 'bom-by-wave.html', 'rack-plan.csv', 'rack-plan.html',
        // D2 (DECISIONS-v2-2 §D): per-DU rack elevations added to the deploy bundle
        'rack-elevations.html', 'rack-contents.csv', 'rack-summary.csv', 'cable-schedule.csv', 'cable-schedule.html', 'topology.dot',
        'ip-plan.csv', 'ip-plan.html', ...IP_PLAN_SECTIONS.map((s) => `ip-plan/${s}.csv`), 'switch-inventory.csv', 'README.html',
      ]);
      expect(paths.some((p) => p.endsWith('.md'))).toBe(false);
      for (const f of files) {
        const text = String(f.content);
        expect(text, f.path).not.toMatch(/undefined|NaN|\[object/);
        if (f.path.endsWith('.html')) {
          expect(tagBalance(text), f.path).toBe('');
          expect(text, f.path).toContain(`<html lang="${locale}">`);
        }
        if (f.path.endsWith('.csv')) expect(text.startsWith('﻿'), f.path).toBe(true);
      }
      const rack = parseCsv(get(files, 'rack-plan.csv')).filter((r) => r.length > 1);
      expect(rack.length).toBe(a.summary.racks + 1);
      expect(get(files, 'bom-by-wave.html')).toContain(locale === 'ko' ? '웨이브별 요약' : 'Summary per wave');
      expect(get(files, 'rack-plan.html')).toContain(locale === 'ko' ? 'U-맵' : 'U-maps');
      const ipHtml = get(files, 'ip-plan.html');
      expect(ipHtml).toContain(locale === 'ko' ? '주소 계획 요약' : 'Address-plan summary');
      expect(ipHtml).toContain(locale === 'ko' ? 'IPv6 사이트 접두사' : 'IPv6 site prefix');
      expect(ipHtml).toContain(locale === 'ko' ? '주소 할당 맵' : 'Address allocation map');
      expect(ipHtml).toContain('<svg');
      expect(ipHtml).toMatch(/fd[0-9a-f]{2}:[0-9a-f]{4}:[0-9a-f]{4}::\/48/);
      const ipHeader = parseCsv(get(files, 'ip-plan.csv'))[0];
      expect(ipHeader).toContain('ipv6');
      expect(ipHeader).toContain('ipv6_gateway');
    }
    expect(get(buildDeployBundle({ ...project, locale: 'ko' }, a), 'bom-by-wave.html')).toContain('배포 웨이브별 자재 명세');
  });

  it('fixed column sets for the cable schedule, IP plan and switch inventory', () => {
    expect(parseCsv(get(injected, 'cable-schedule.csv'))[0]).toEqual([...CABLE_SCHEDULE_COLUMNS]);
    expect(parseCsv(get(injected, 'ip-plan.csv'))[0]).toEqual(IP_PLAN_COMBINED_COLUMNS);
    expect(parseCsv(get(injected, 'switch-inventory.csv'))[0]).toEqual(SWITCH_INVENTORY_COLUMNS);
    const cables = parseCsv(cableScheduleCsv(fx.rows)).filter((r) => r.length > 1);
    expect(cables.length).toBe(fx.rows.length + 1);
    const labelCol = CABLE_SCHEDULE_COLUMNS.indexOf('label_a');
    expect(cables[1][labelCol]).toBe(fx.rows[0].labelA); // commas and quotes survive
    const sections = parseCsv(get(injected, 'ip-plan.csv')).slice(1).filter((r) => r.length > 1).map((r) => r[0]);
    for (const s of ['blocks', 'loopbacks', 'asns', 'p2p', 'hosts']) expect(sections).toContain(s);
    expect(get(injected, 'ip-plan.html')).toContain('Host NIC addresses');
    expect(get(injected, 'cable-schedule.html')).toContain('TIA-606-style');
  });

  it('topology.dot uses the Cumulus PTM edge syntax with switch hostnames and swp names', () => {
    const dot = topologyDot(fx.rows, []);
    expect(dot).toContain('graph G {');
    expect(dot).toMatch(/\/\/ verify: the "graph G \{ \}" wrapper/);
    const bundled = get(injected, 'topology.dot');
    expect(bundled).toMatch(/^ {2}"h1-be-lf001":"swp33" -- "h1-be-sp001":"swp1"$/m);
    expect(bundled).toMatch(/"h1-be-lf001":"swp1s0"/);
  });

  it("export hooks: 'docs' is HTML, 'deploy' adds nos/<target>/ and tests/, 'all' includes drawings", () => {
    expect(EXPORT_FORMATS).toContain('deploy');
    expect(Object.keys(buildExportFiles(project, a, 'docs'))).toEqual(['design-document.html']);
    const deploy = Object.keys(buildExportFiles(project, a, 'deploy'));
    expect(deploy).toContain('bom-by-wave.csv');
    expect(deploy).toContain('ip-plan.html');
    expect(deploy).toContain('nos/sonic/README.txt');
    expect(deploy).toContain('nos/ib-ufm/opensm/partitions.conf');
    expect(deploy).toContain('tests/README.html');
    expect(deploy).toContain('tests/30-collectives/eta_mpirun.sh');
    expect(deploy.some((p) => p.endsWith('.md'))).toBe(false);
    // r4 (spec §4.2 item 2): the deploy bundle requests the new sheet kinds explicitly under drawings/ (the 'drawings' export is unchanged)
    const sheets = deploy.filter((p) => p.startsWith('drawings/'));
    expect(sheets.every((p) => p.endsWith('.svg'))).toBe(true);
    for (const num of ['001-', '002-', '101-', '111-', '121-DU01-', '301-H1-T01-', '302-H1-L01-', '311-H1-C1-', '411-DU01-', '601-H1-', '611-H1-']) expect(sheets.some((p) => p.startsWith(`drawings/${num}`)), num).toBe(true);
    expect(sheets.some((p) => p.includes('200-rack-elevations') || /^drawings\/[24]0\d-/.test(p))).toBe(false);
    expect(new Set(sheets).size).toBe(sheets.length);
    expect(Object.keys(buildExportFiles(project, a, 'drawings')).some((p) => /^(111|121|30[12]|311|411|60\d|611|00\d)-/.test(p))).toBe(false);
    const all = Object.keys(buildExportFiles(project, a, 'all'));
    expect(all).toContain('deploy/rack-plan.csv');
    expect(all).toContain('docs/design-document.html');
    expect(all.some((p) => p.startsWith('drawings/') && p.endsWith('.svg'))).toBe(true);
  }, 60_000);
});
