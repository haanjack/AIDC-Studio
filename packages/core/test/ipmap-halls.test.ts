import { describe, expect, it } from 'vitest';
import {
  analyzeProject, asnOf, buildIpMapFromPlan, buildIpPlanDetailed, buildIpReviewFromDetailed, createNvidiaReferenceProject, duplicateHall, FABRIC_SWITCH, groupIpPlanByRail,
  ipHallLayout, parseCidr, type IpMapNode, type Project,
} from '../src/index.ts';
import { buildIpPlanDetailed as legacyDetailed } from './ipmap-legacy-ipplan.ts';

const withFabric = (p: Project, fabric: 'spectrumx-800'): Project => ({ ...p, network: { ...p.network, scaleOut: { ...p.network.scaleOut, fabric, switchCatalogId: FABRIC_SWITCH[fabric] } } });

function checkTree(n: IpMapNode) {
  for (const c of n.children) {
    expect(c.start, c.id).toBeGreaterThanOrEqual(n.start);
    expect(c.start + c.size, c.id).toBeLessThanOrEqual(n.start + n.size);
  }
  for (let i = 1; i < n.children.length; i++) expect(n.children[i].start, n.children[i].id).toBeGreaterThanOrEqual(n.children[i - 1].start + n.children[i - 1].size);
  if (n.children.length) expect(n.used, n.id).toBe(n.children.reduce((a, c) => a + c.used, 0));
  n.children.forEach(checkTree);
}

describe('ipplan.ts — any number of halls', () => {
  it('layout: ≤ 4 halls keep the fixed layout; 5+ halls split each block into 2^ceil(log2 n) hall prefixes; ASN hall digits widen past 10 halls', () => {
    for (const n of [1, 2, 3, 4]) expect(ipHallLayout(n)).toMatchObject({ scaled: false, hallBits: 2, loIndexBits: 12, oobSwitchBits: 10, accessLeafBits: 8, planeShift: 17, p2pSetShift: 16, p2pNetBits: 3, asnHallDigits: 1 });
    expect(ipHallLayout(6)).toMatchObject({ scaled: true, hallBits: 3, loIndexBits: 11, oobSwitchBits: 9, accessLeafBits: 7, planeBits: 0, planeShift: 19, p2pSetShift: 16, p2pNetBits: 2, asnHallDigits: 1 });
    // numbered fabric (QA ipmap review v2 2차): tier bit + network field + /31 set fill the hall prefix exactly; 5–8 halls keep the fixed
    // layout's /16 per (tier, network) set (a 3-bit network field would halve it and overflow a 142-rack Spectrum-X hall)
    for (const n of [1, 4, 5, 6, 8, 9, 16, 40]) {
      const L = ipHallLayout(n);
      expect(1 + L.p2pNetBits + L.p2pSetShift, `${n} halls`).toBe(L.shift['backend-fabric-p2p']);
    }
    for (const n of [5, 6, 7, 8]) expect(ipHallLayout(n).p2pSetShift).toBe(16);
    expect(ipHallLayout(9).p2pSetShift).toBe(15);
    expect(ipHallLayout(6, 4)).toMatchObject({ planeBits: 2, planeShift: 17 });
    expect(ipHallLayout(40)).toMatchObject({ hallBits: 6, asnHallDigits: 2, loIndexBits: 8 });
    // the digit scheme is the original one for d = 1 and never collides across halls / roles for d = 2
    expect(asnOf(0, 3, 3, 12)).toBe(4_203_300_012);
    const asns = new Set<number>();
    for (let h = 0; h < 40; h++) for (let r = 1; r <= 8; r++) for (const i of [0, 1, 9_999]) asns.add(asnOf(8, h, r, i, 2));
    expect(asns.size).toBe(40 * 8 * 3);
    for (const a of asns) {
      expect(a).toBeGreaterThanOrEqual(4_200_000_000);
      expect(a).toBeLessThanOrEqual(4_294_967_294);
    }
  });

  it('≤ 4 halls: the IPv4 allocation and subnet records remain byte-identical to the previous allocator', () => {
    const ref = createNvidiaReferenceProject().project;
    const sx = withFabric(ref, 'spectrumx-800');
    let four = sx;
    while (four.halls.length < 4) four = duplicateHall(four, four.halls[0].id, { withLayout: true }).project;
    expect(four.halls).toHaveLength(4);
    const cases: [string, Project, Parameters<typeof legacyDetailed>[2]][] = [
      ['IB', ref, {}], ['IB numbered', ref, { numberedFabric: true }], ['Spectrum-X numbered, 2 planes', sx, { numberedFabric: true, planes: 2 }], ['4 halls numbered, 4 planes', four, { numberedFabric: true, planes: 4 }],
    ];
    for (const [name, p, o] of cases) {
      const a = analyzeProject(p);
      const now = buildIpPlanDetailed(p, a, o);
      const old = legacyDetailed(p, a, o);
      const ipv4 = {
        blocks: now.plan.blocks,
        loopbacks: now.plan.loopbacks.map(({ deviceId, ip }) => ({ deviceId, ip })),
        asns: now.plan.asns,
        p2p: now.plan.p2p.map(({ linkId, a, b, cidr, unnumbered }) => ({ linkId, a, b, ...(cidr ? { cidr } : {}), unnumbered })),
        hosts: now.plan.hosts.map(({ nodeId, nic, ip, vlan, gw }) => ({ nodeId, nic, ip, ...(vlan !== undefined ? { vlan } : {}), ...(gw ? { gw } : {}) })),
        oob: now.plan.oob.map(({ deviceId, ip }) => ({ deviceId, ip })),
        notes: now.plan.notes?.filter((n) => !n.startsWith('IPv6:')),
      };
      expect(JSON.stringify({ plan: ipv4, subnets: now.subnets }) === JSON.stringify({ plan: old.plan, subnets: old.subnets }), name).toBe(true);
      expect(now.layout.scaled).toBe(false);
    }
  }, 300_000);

  it('6 populated halls (+ 1 empty): no overlapping subnets, nothing outside, every device addressed, unique leaf ASNs', () => {
    let p = withFabric(createNvidiaReferenceProject().project, 'spectrumx-800');
    const src = p.halls[0].id;
    for (let i = 0; i < 5; i++) p = duplicateHall(p, src, { withLayout: true }).project;
    const populated = new Set(p.equipment.map((e) => e.hallId));
    expect(populated.size).toBe(6);
    expect(p.halls.length).toBe(7);
    const a = analyzeProject(p);
    const d = buildIpPlanDetailed(p, a, { numberedFabric: true });
    const { plan, subnets, layout, rows, units } = d;
    expect(layout).toMatchObject({ scaled: true, hallBits: 3 });
    expect(plan.notes!.some((n) => /overflow|exceed|outside|overlap/.test(n)), plan.notes!.join('\n')).toBe(false);

    const map = buildIpMapFromPlan(p, plan, subnets, 10, layout);
    expect(map.outside).toEqual([]);
    checkTree(map.root);
    // hall prefixes: one per populated hall in each hall-scoped block
    const be = map.root.children.find((c) => c.label === 'backend-host')!;
    expect(be.children.filter((c) => c.kind === 'hall')).toHaveLength(6);

    // no two subnets overlap, across all blocks
    const sorted = [...subnets].sort((x, y) => x.start - y.start);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i].start, `${sorted[i - 1].key} vs ${sorted[i].key}`).toBeGreaterThanOrEqual(sorted[i - 1].start + sorted[i - 1].size);

    // every endpoint cabled to a placed switch is addressed (by the switch's network, as the plan does): backend /31 per NIC, FE / storage
    // /24, in-band once per FE node, OOB per port; every switch a loopback + ASN
    const hallNo = new Map(p.halls.map((h, i) => [h.id, i + 1]));
    const unitByDevice = new Map(units.map((u) => [`H${hallNo.get(u.hallId)}.${u.rackTag}-U${u.u}`, u]));
    const ep = rows.filter((r) => r.tier === 'endpoint-leaf');
    const epBy = (key: string) => ep.filter((r) => unitByDevice.get(r.toPort.slice(0, r.toPort.lastIndexOf(':')))?.fabricKey === key);
    expect(epBy('scale-out').length).toBeGreaterThan(0);
    expect(plan.hosts.filter((h) => h.ip.endsWith('/31'))).toHaveLength(epBy('scale-out').length);
    expect(plan.hosts.filter((h) => h.vlan === 30)).toHaveLength(epBy('frontend').length);
    expect(plan.hosts.filter((h) => h.vlan === 40)).toHaveLength(epBy('storage').length);
    expect(plan.hosts.filter((h) => h.vlan === 20)).toHaveLength(new Set(epBy('frontend').map((r) => r.fromPort.slice(0, r.fromPort.lastIndexOf(':')))).size);
    expect(plan.oob).toHaveLength(epBy('oob').length);
    expect(plan.loopbacks).toHaveLength(units.length);
    expect(plan.asns).toHaveLength(units.length);
    expect(plan.p2p.every((l) => l.cidr)).toBe(true);
    expect(new Set(units.map((u) => u.hallId))).toEqual(populated);

    const ips = [...plan.hosts.map((h) => h.ip.split('/')[0]), ...plan.loopbacks.map((l) => l.ip), ...plan.oob.map((o) => o.ip.split('/')[0]), ...plan.hosts.flatMap((h) => (h.ip.endsWith('/31') && h.gw ? [h.gw] : []))];
    expect(new Set(ips).size).toBe(ips.length);
    const cidrs = plan.p2p.map((l) => l.cidr!);
    expect(new Set(cidrs).size).toBe(cidrs.length);
    // every address inside its block and its hall prefix
    for (const s of subnets) {
      const blk = map.root.children.find((b) => b.label === s.block)!;
      expect(s.start).toBeGreaterThanOrEqual(blk.start);
      expect(s.start + s.size).toBeLessThanOrEqual(blk.start + blk.size);
    }
    const asn = new Map(plan.asns.map((x) => [x.deviceId, x.asn]));
    const leaves = units.filter((u) => u.fabricKey === 'scale-out' && u.role === 'leaf');
    expect(new Set(leaves.map((u) => asn.get(u.id))).size).toBe(leaves.length);
    for (const x of plan.asns) expect(x.asn).toBeLessThanOrEqual(4_294_967_294);
    // one host example per hall lies in that hall's prefix
    const hallOf = new Map(p.halls.map((h, i) => [h.id, i]));
    for (const hall of populated) {
      const r = epBy('scale-out').find((x) => x.fromHallId === hall)!;
      const nodeNic = r.fromPort;
      const h = plan.hosts.find((x) => `${x.nodeId}:${x.nic}` === nodeNic)!;
      const addr = parseCidr(h.ip.split('/')[0])!.start;
      const hs = 2 ** layout.shift['backend-host'];
      expect(Math.floor((addr - be.start) / hs)).toBe(hallOf.get(hall));
    }
    // review over 6 halls: rails nest under halls
    const review = buildIpReviewFromDetailed(p, d);
    expect(review.multiHall).toBe(true);
    const rail = groupIpPlanByRail(review);
    const backend = rail.children.find((c) => c.code === 'backend')!;
    expect(backend.children.filter((c) => c.kind === 'hall')).toHaveLength(6);
    expect(backend.children[0].children.some((c) => c.kind === 'rail')).toBe(true);
  }, 600_000);
});
