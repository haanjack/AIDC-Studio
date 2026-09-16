// Polish v2 2차 — network deliverables and document minors (docs/research/polish-network-collab-v2-2.md).
import { describe, expect, it } from 'vitest';
import {
  analyzeProject, applyHallLayout, buildCableSchedule, buildDeployBundle, buildIpPlan, buildSwitchUnits, buildWaveBom, createNvidiaReferenceProject,
  FABRIC_SWITCH, generateTestPlan, growHallToFit, htmlPage, layoutOptionsFromProject, nextPodIndex, nominalBusbwGBps, nominalInputsFor,
  parseCollectiveLog, reconcileBom, type Project,
} from '../src/index.ts';

const ref = () => structuredClone(createNvidiaReferenceProject().project);
const dev = (p: string) => p.slice(0, p.lastIndexOf(':'));

function joinedPair(): Project {
  const d = ref();
  d.network.scaleOut = { ...d.network.scaleOut, fabric: 'spectrumx-800', switchCatalogId: FABRIC_SWITCH['spectrumx-800'] };
  const hall = d.halls.find((h) => h.id === 'hall-b')!;
  d.clusters = [{ id: 'c-ab', name: 'A+B', hallIds: ['hall-a', 'hall-b'] }];
  const o = layoutOptionsFromProject(d, hall, { pods: 4, podIndexStart: nextPodIndex(d, 'hall-b'), services: { spineRacks: 'auto', storageRacks: 0, cpuRacks: 0, mgmtRacks: 0 } });
  applyHallLayout(d, 'hall-b', growHallToFit(hall, o), o);
  const ha = d.halls.find((h) => h.id === 'hall-a')!;
  const oa = layoutOptionsFromProject(d, ha, { pods: 4, podIndexStart: nextPodIndex(d, 'hall-a'), services: { spineRacks: 'auto', storageRacks: 8, cpuRacks: 4, mgmtRacks: 2 } });
  applyHallLayout(d, 'hall-a', growHallToFit(ha, oa), oa);
  return d;
}

describe('OOB for inter-hall super-spines of joined clusters', () => {
  it('every switch (super-spines included) has one mgmt0 row and one OOB IP; OOB leaves stay within their access and uplink ports', () => {
    const d = joinedPair();
    const a = analyzeProject(d);
    const units = buildSwitchUnits(d, a);
    const rows = buildCableSchedule(d, a);
    const plan = buildIpPlan(d, a);
    const superSpines = units.filter((u) => u.interHall);
    expect(superSpines.length).toBeGreaterThan(0);
    const mgmt = rows.filter((r) => /:mgmt0$/.test(r.fromPort)).map((r) => r.fromPort);
    expect(new Set(mgmt).size).toBe(mgmt.length);
    expect(mgmt.length).toBe(units.length);
    const mgmtDevices = new Set(mgmt.map(dev));
    const oobIps = new Set(plan.oob.map((o) => o.deviceId));
    for (const port of mgmt) expect(oobIps.has(port), port).toBe(true);
    for (const u of superSpines) expect([...mgmtDevices].some((m) => m.endsWith(`.${u.rackTag}-U${u.u}`)), u.id).toBe(true);
    // OOB leaves: access ports ≤ radix, uplinks ≤ the catalog's uplink ports (SN2201: 48 × 1G + 4 × 100G)
    const oobLeaves = units.filter((u) => u.fabricKey === 'oob' && u.role === 'leaf');
    const access = new Map<string, number>();
    const up = new Map<string, number>();
    for (const r of rows) {
      if (r.fabricKey !== 'oob') continue;
      const m = /^(.*):P(\d+)$/.exec(r.toPort);
      if (r.tier === 'endpoint-leaf' && m) access.set(m[1], Math.max(access.get(m[1]) ?? 0, Number(m[2])));
      const u = /^(.*):UP(\d+)$/.exec(r.fromPort);
      if (u) up.set(u[1], Math.max(up.get(u[1]) ?? 0, Number(u[2])));
    }
    for (const u of oobLeaves) {
      const id = [...access.keys()].find((k) => k.endsWith(`.${u.rackTag}-U${u.u}`));
      if (id) expect(access.get(id)!, u.id).toBeLessThanOrEqual(u.ports);
      const upId = [...up.keys()].find((k) => k.endsWith(`.${u.rackTag}-U${u.u}`));
      expect(upId, `${u.id} has an uplink`).toBeTruthy();
      expect(up.get(upId!)!).toBeLessThanOrEqual(4);
    }
  }, 120_000);
});

describe('BOM reconciliation (bom-by-wave vs analysis.cost.bom)', () => {
  const p = ref();
  const a = analyzeProject(p);
  const bom = buildWaveBom(p, a, 'en');
  const rec = reconcileBom(bom, a.cost.bom);

  it('the reconciliation table sums to the cost BOM total and shared items agree in quantity', () => {
    const rowsUSD = rec.rows.reduce((s, r) => s + r.costUSD, 0);
    const scopeUSD = Object.values(rec.usdByScope).reduce((s, v) => s + (v ?? 0), 0);
    const total = a.cost.bom.reduce((s, l) => s + l.totalUSD, 0);
    expect(rowsUSD).toBeCloseTo(total, 2);
    expect(scopeUSD).toBeCloseTo(total, 2);
    expect(rec.costTotalUSD).toBeCloseTo(total, 2);
    expect(rec.qtyMismatches).toBe(0);
    // every cost line and every wave item appears exactly once
    expect(rec.rows.filter((r) => r.costQty !== undefined).length).toBe(new Set(a.cost.bom.map((l) => l.itemId)).size);
    expect(rec.rows.filter((r) => r.waveQty !== undefined).length).toBe(new Set(bom.lines.map((l) => l.itemId)).size);
  });

  it('lists the cost-only groups: facility plant, labour, contingency (and wave-only trays / busway)', () => {
    const scopes = new Set(rec.rows.map((r) => r.scope));
    for (const s of ['shared', 'facility-plant', 'labour', 'contingency'] as const) expect(scopes.has(s), s).toBe(true);
    expect(rec.rows.find((r) => r.itemId === 'install-labor')?.scope).toBe('labour');
    expect(rec.rows.find((r) => r.itemId === 'contingency')?.scope).toBe('contingency');
    expect(rec.rows.find((r) => r.itemId === 'shell')?.scope).toBe('facility-plant');
    expect(rec.rows.some((r) => r.scope === 'wave-only')).toBe(true);
    const html = buildDeployBundle(p, a, { locale: 'en' }).find((f) => f.path === 'bom-by-wave.html')!.content as string;
    expect(html).toContain('id="bom-reconciliation"');
    expect(html).toContain('Reconciliation with the cost BOM');
    expect(html).not.toContain('Totals reconcile with the cost BOM');
    const ko = buildDeployBundle(p, a, { locale: 'ko' }).find((f) => f.path === 'bom-by-wave.html')!.content as string;
    expect(ko).toContain('비용 BOM과의 대사');
  });
});

describe('document minors', () => {
  it('every HTML deliverable carries a script-free CSP and print rules that keep identifiers unbroken', () => {
    const html = htmlPage('T', '<p>x</p>', 'en');
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">`);
    expect(html).toMatch(/@media print\{[\s\S]*td\.mono,td\.num,td\.nowrap\{white-space:nowrap;\}/);
  });
});

describe('network minors (QA network m2, m3, m4, m6)', () => {
  const table = (groups: number, nodes: number, bus: number) => {
    const lines: string[] = ['# nThread 1 nGpus 1 minBytes 1073741824 maxBytes 8589934592', '#  Using devices'];
    let rank = 0;
    for (let n = 0; n < nodes; n++) for (let g = 0; g < groups; g++) lines.push(`#  Rank ${String(rank++).padStart(2)} Group ${g} Pid 1000 on node${n} device ${g} [0x00] NVIDIA B200`);
    lines.push('#', '#                                                              out-of-place                       in-place', '#       size         count      type   redop    root     time   algbw   busbw #wrong     time   algbw   busbw #wrong');
    for (const size of [1073741824, 2147483648, 4294967296, 8589934592]) lines.push(`  ${size}  ${size / 4}  float  sum  -1  1000  ${bus.toFixed(2)}  ${bus.toFixed(2)}  0  1000  ${bus.toFixed(2)}  ${bus.toFixed(2)}  0`);
    return lines.join('\n');
  };

  it('m2: a MOD-split log without the kit header is recognised by its Group column and flagged', () => {
    const [m] = parseCollectiveLog(table(8, 8, 47.34));
    expect(m.groups).toBe(8);
    expect(m.nodes).toBe(8);
    const d = nominalInputsFor(m, { scaleOutPortGbps: 400, gpusPerNode: 8, scaleOutPortsPerGpu: 1 });
    expect(d).toMatchObject({ split: 8, splitInferred: true, ranksPerNode: 1, nicsPerNode: 1, ranks: 8 });
    expect(nominalBusbwGBps({ collective: 'all_reduce', ...d })).toBeCloseTo(50, 5); // one 400G NIC per rank, not 8 × 50
    // plain per-node log (one group) keeps the per-node defaults
    const [plain] = parseCollectiveLog(table(1, 8, 300));
    expect(plain.groups).toBeUndefined();
    expect(nominalInputsFor(plain, { scaleOutPortGbps: 400, gpusPerNode: 8, scaleOutPortsPerGpu: 1 }).splitInferred).toBeUndefined();
  });

  it('m3: GB300 alltoall without a kit header defaults g to the NVLink domain', () => {
    const [m] = parseCollectiveLog(table(1, 36, 20).replace('float  sum', 'float  none'));
    const a2a = { ...m, collective: 'alltoall' as const, ranks: 144, ranksPerNode: 4 };
    const d = nominalInputsFor(a2a, { scaleOutPortGbps: 800, gpusPerNode: 4, scaleOutPortsPerGpu: 1, scaleUpDomain: 72 });
    expect(d).toMatchObject({ ranksPerNode: 72, domainGroup: true });
    const perTray = nominalBusbwGBps({ collective: 'alltoall', nicGbps: 800, nicsPerNode: 4, ranksPerNode: 4, ranks: 144 });
    const perDomain = nominalBusbwGBps({ collective: 'alltoall', ...d });
    expect(perDomain / perTray).toBeGreaterThan(1.9); // QA: 198.6 vs 102.1 GB/s
    expect(nominalInputsFor(a2a, { scaleOutPortGbps: 800, gpusPerNode: 8, scaleOutPortsPerGpu: 1, scaleUpDomain: 8 }).domainGroup).toBeUndefined();
  });

  it('m4: with planes declared, backend host blocks are numbered per (hall, plane); the default keeps plane 0 addresses', () => {
    const p = ref();
    p.network.scaleOut = { ...p.network.scaleOut, fabric: 'spectrumx-800', switchCatalogId: FABRIC_SWITCH['spectrumx-800'] };
    const a = analyzeProject(p);
    const one = buildIpPlan(p, a);
    const same = buildIpPlan(p, a, { planes: 1 });
    expect(same.hosts.map((h) => h.ip)).toEqual(one.hosts.map((h) => h.ip));
    const four = buildIpPlan(p, a, { planes: 4 });
    const ips = four.hosts.filter((h) => h.ip.endsWith('/31')).map((h) => h.ip);
    expect(ips.length).toBeGreaterThan(0);
    expect(new Set(ips).size).toBe(ips.length);
    const planeOf = (ipStr: string) => (Number(ipStr.split('.')[1]) - 64) % 16 >> 1; // hall<<20 | plane<<17 → second octet bits
    expect(new Set(ips.map(planeOf)).size).toBeGreaterThan(1);
  });

  it('m6: the η kit notes hostfiles below 8 nodes', () => {
    const p = ref();
    const a = analyzeProject(p);
    const small = generateTestPlan(p, a, { maxRunNodes: 4 }).find((f) => f.path === 'README.html')!.content;
    expect(small).toMatch(/below the recommended 8 nodes/);
    const full = generateTestPlan(p, a).find((f) => f.path === 'README.html')!.content; // reference: 16-node hostfiles
    expect(full).not.toMatch(/below the recommended 8 nodes/);
  });
});
