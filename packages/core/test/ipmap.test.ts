import { describe, expect, it } from 'vitest';
import {
  analyzeProject, buildIpMap, buildIpPlan, createNvidiaReferenceProject, duplicateHall, findInIpMap, FABRIC_SWITCH, ipMapMatchRank, parseCidr, prefixOf, type IpMap, type IpMapNode, type Project,
} from '../src/index.ts';

function walk(n: IpMapNode, fn: (n: IpMapNode, parent?: IpMapNode) => void, parent?: IpMapNode) {
  fn(n, parent);
  n.children.forEach((c) => walk(c, fn, n));
}

function checkTree(root: IpMapNode) {
  let nodes = 0;
  walk(root, (n) => {
    nodes++;
    expect(n.size).toBeGreaterThan(0);
    expect(n.utilisation).toBeGreaterThanOrEqual(0);
    expect(n.utilisation, n.id).toBeLessThanOrEqual(1);
    if (n.cidr) expect(parseCidr(n.cidr), n.id).toEqual({ start: n.start, size: n.size });
    if (!n.children.length) return;
    // children nest inside the parent
    for (const c of n.children) {
      expect(c.start, `${c.id} in ${n.id}`).toBeGreaterThanOrEqual(n.start);
      expect(c.start + c.size, `${c.id} in ${n.id}`).toBeLessThanOrEqual(n.start + n.size);
    }
    // siblings never overlap (sorted by start)
    for (let i = 1; i < n.children.length; i++) expect(n.children[i].start, `${n.children[i - 1].id} vs ${n.children[i].id}`).toBeGreaterThanOrEqual(n.children[i - 1].start + n.children[i - 1].size);
    // utilisation sums
    expect(n.used, n.id).toBe(n.children.reduce((a, c) => a + c.used, 0));
  });
  return nodes;
}

const withFabric = (p: Project, fabric: 'spectrumx-800'): Project => ({ ...p, network: { ...p.network, scaleOut: { ...p.network.scaleOut, fabric, switchCatalogId: FABRIC_SWITCH[fabric] } } });

describe('ipmap.ts — nested allocation map', () => {
  const p = withFabric(createNvidiaReferenceProject().project, 'spectrumx-800');
  const a = analyzeProject(p);

  it('prefix helpers', () => {
    expect(prefixOf(parseCidr('10.64.0.0/10')!.start, 2 ** 22)).toBe('10.64.0.0/10');
    expect(prefixOf(parseCidr('10.64.0.1')!.start, 2)).toBeUndefined();
    expect(parseCidr('10.40.3.17')).toEqual({ start: parseCidr('10.40.3.17/32')!.start, size: 1 });
  });

  it('blocks nest correctly, siblings never overlap, used sums up (unnumbered and numbered fabric)', () => {
    for (const numberedFabric of [false, true]) {
      const map = buildIpMap(p, a, { numberedFabric });
      expect(map.root.cidr).toBe('10.0.0.0/8');
      expect(map.outside).toEqual([]);
      expect(checkTree(map.root)).toBeGreaterThan(map.root.children.length);
      expect(map.root.children.map((c) => c.cidr)).toEqual(expect.arrayContaining(buildIpPlan(p, a, { numberedFabric }).blocks.map((b) => b.cidr)));
      const kinds = new Set<string>();
      walk(map.root, (n) => kinds.add(n.kind));
      for (const k of ['site', 'block', 'hall', 'group', 'subnet']) expect(kinds.has(k), k).toBe(true);
    }
  });

  it('used counts match the plan: every assigned host and loopback is counted once', () => {
    const plan = buildIpPlan(p, a);
    const map = buildIpMap(p, a);
    const block = (name: string) => map.root.children.find((c) => c.label === name)!;
    expect(block('loopback').used + block('cluster-loopback').used).toBe(plan.loopbacks.length);
    const backendHosts = plan.hosts.filter((h) => h.ip.endsWith('/31')).length;
    expect(block('backend-host').used).toBe(2 * backendHosts);
    // access /24: hosts + one gateway per subnet
    const fe = block('frontend');
    let feSubnets = 0;
    walk(fe, (n) => { if (n.kind === 'subnet') feSubnets++; });
    expect(fe.used).toBe(plan.hosts.filter((h) => h.vlan === 30).length + feSubnets);
  });

  it('lookup by node, NIC and IP finds the subnet that holds the address', () => {
    const plan = buildIpPlan(p, a);
    const map = buildIpMap(p, a);
    const host = plan.hosts.find((h) => h.ip.endsWith('/31'))!;
    const byNic = findInIpMap(map, `${host.nodeId}:${host.nic}`);
    expect(byNic.length).toBeGreaterThan(0);
    const sub = byNic[0].path[byNic[0].path.length - 1];
    expect(sub.kind).toBe('subnet');
    const addr = parseCidr(host.ip.split('/')[0])!.start;
    expect(addr).toBeGreaterThanOrEqual(sub.start);
    expect(addr).toBeLessThan(sub.start + sub.size);
    const byIp = findInIpMap(map, host.ip.split('/')[0]);
    expect(byIp[0].path.at(-1)!.id).toBe(sub.id);
    expect(findInIpMap(map, 'no-such-device-xyz')).toEqual([]);
  });

  it('two halls get separate hall prefixes', () => {
    const q: Project = { ...p, halls: [...p.halls] };
    if (q.halls.length < 2) return;
    const map = buildIpMap(q, analyzeProject(q));
    checkTree(map.root);
  });

  // ── QA halls-ipmap v2 2차 regressions ──
  it('two populated halls: the copy gets its own hall prefix next to the source hall, nothing overflows', () => {
    const { project: two, hallId } = duplicateHall(p, p.halls[0].id, { withLayout: true });
    const map = buildIpMap(two, analyzeProject(two));
    checkTree(map.root);
    expect(map.outside).toEqual([]);
    const be = map.root.children.find((c) => c.label === 'backend-host')!;
    expect(be.children.filter((c) => c.kind === 'hall').map((c) => c.hallId)).toEqual(expect.arrayContaining([p.halls[0].id, hallId]));
  });

  it('text search ranks exact names before longer names that contain the query (node:be1 never selects node:be10)', () => {
    expect(ipMapMatchRank('H1.N10:be1', 'h1.n10:be1')).toBe(0);
    expect(ipMapMatchRank('sw-U1:mgmt0', 'sw-u1')).toBe(1);
    expect(ipMapMatchRank('sw-U11', 'sw-u1')).toBe(2);
    expect(ipMapMatchRank('sw-U2', 'sw-u1')).toBe(-1);
    const base = parseCidr('10.0.0.0')!.start;
    const sub = (id: string, start: number, members: string[]): IpMapNode => ({ id, kind: 'subnet', label: `subnet ${id}`, start, size: 4, used: 1, utilisation: 0.25, children: [], members });
    // the longer names sit at LOWER addresses: a plain substring walk would return them first
    const root: IpMapNode = {
      id: 'site', kind: 'site', label: 'site', start: base, size: 256, used: 3, utilisation: 3 / 256,
      children: [sub('a', base, ['node:be10', 'sw-U11']), sub('b', base + 4, ['sw-U1:mgmt0']), sub('c', base + 8, ['node:be1', 'sw-U1'])],
    };
    const map = { root, plan: buildIpPlan(p, a), subnetCount: 3, outside: [] } as IpMap;
    expect(findInIpMap(map, 'node:be1').map((m) => m.path.at(-1)!.id)).toEqual(['c', 'a']);
    expect(findInIpMap(map, 'SW-U1').map((m) => m.member)).toEqual(['sw-U1', 'sw-U1:mgmt0', 'sw-U11']);
    expect(findInIpMap(map, 'sw-U1', 1)[0].path.at(-1)!.id).toBe('c');
    // label hits still work and rank like members
    expect(findInIpMap(map, 'subnet b')[0].path.at(-1)!.id).toBe('b');
  });

  it('InfiniBand, numbered: the Ethernet fabric /31s lie inside a declared plan block (no overflow)', () => {
    const ib: Project = { ...p, network: { ...p.network, scaleOut: { ...p.network.scaleOut, fabric: 'ib-xdr-800', switchCatalogId: FABRIC_SWITCH['ib-xdr-800'] } } };
    const ia = analyzeProject(ib);
    const numbered = buildIpMap(ib, ia, { numberedFabric: true });
    expect(numbered.plan.p2p.some((l) => l.cidr)).toBe(true);
    expect(numbered.outside).toEqual([]);
    checkTree(numbered.root);
    // unnumbered IB keeps the old block list (no p2p block)
    expect(buildIpPlan(ib, ia).blocks.some((b) => b.name === 'backend-fabric-p2p')).toBe(false);
  });
});
