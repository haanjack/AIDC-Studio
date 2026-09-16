import { describe, expect, it } from 'vitest';
import {
  analyzeProject, backendP2p, buildCableSchedule, buildIpPlan, buildSwitchUnits, createNvidiaReferenceProject, FABRIC_SWITCH, ipHallLayout, ipPlanCapacity, ipToString, normalizeIpv6Prefix, projectUlaPrefix, summarizeCableSchedule, type EquipmentInstance, type Hall, type Project,
} from '../src/index.ts';

const ref = () => createNvidiaReferenceProject().project;

/** Reference hall copied into `n` halls (hall-local coordinates, origins spaced along X). */
function halls(n: number, fabric?: 'spectrumx-800'): Project {
  const p = ref();
  const hallA = p.halls[0];
  const hs: Hall[] = Array.from({ length: n }, (_, i) => ({ ...hallA, id: i === 0 ? 'hall-a' : `hall-${i}`, name: `Hall ${i + 1}`, origin: { x: i * (hallA.width + 12), y: 0 } }));
  const a = p.equipment.filter((e) => e.hallId === 'hall-a');
  const eq: EquipmentInstance[] = [...a];
  for (let i = 1; i < n; i++) eq.push(...a.map((e) => ({ ...e, id: `${e.id}-${i}`, hallId: `hall-${i}`, tag: `${i}-${e.tag}`, ...(e.podId ? { podId: `${e.podId}-${i}` } : {}), ...(e.rowId ? { rowId: `${e.rowId}-${i}` } : {}) })));
  const trays = (p.trays ?? []).filter((t) => t.hallId === 'hall-a');
  const allTrays = [...trays, ...Array.from({ length: n - 1 }, (_, k) => trays.map((t) => ({ ...t, id: `${t.id}-${k + 1}`, hallId: `hall-${k + 1}` }))).flat()];
  const out: Project = { ...p, halls: hs, equipment: eq, trays: allTrays };
  if (fabric) out.network = { ...p.network, scaleOut: { ...p.network.scaleOut, fabric, switchCatalogId: FABRIC_SWITCH[fabric] } };
  return out;
}

describe('links.ts — per-cable schedule', () => {
  const p = ref();
  const a = analyzeProject(p);
  const rows = buildCableSchedule(p, a);

  it('one row per cable: Σ rows = Σ CableRun.count, per run as well', () => {
    const total = a.network.cableRuns.reduce((s, r) => s + r.count, 0);
    expect(total).toBe(20772); // fix v2 2차: OOB leaves' own mgmt0 ports counted
    expect(rows).toHaveLength(total);
    expect(rows.length).toBe(a.network.cablesByType.reduce((s, c) => s + c.count, 0));
    const perRun = new Map<string, number>();
    for (const r of rows) perRun.set(r.runId!, (perRun.get(r.runId!) ?? 0) + 1);
    for (const run of a.network.cableRuns) expect(perRun.get(run.id), run.id).toBe(run.count);
  });

  it('unique cable ids, no switch port or NIC used twice, every end resolved inside the switch radix', () => {
    expect(new Set(rows.map((r) => r.cableId)).size).toBe(rows.length);
    const ends = rows.flatMap((r) => [r.fromPort, r.toPort]);
    expect(new Set(ends).size).toBe(ends.length);
    const units = buildSwitchUnits(p, a);
    const s = summarizeCableSchedule(rows, units);
    expect(s.unresolvedEnds).toBe(0);
    expect(s.overflowPorts).toBe(0);
    expect(s.cables).toBe(rows.length);
    // every placed switch became a unit
    const placed = a.network.rackLoads!.reduce((acc, l) => acc + l.switches.reduce((x, sw) => x + sw.count, 0), 0);
    expect(units).toHaveLength(placed);
  });

  it('ids, labels, U positions and waves follow the documented scheme', () => {
    const r = rows.find((x) => x.tier === 'endpoint-leaf' && x.fabricKey === 'scale-out')!;
    expect(r.cableId).toMatch(/^IB-H1-\d{6}$/); // InfiniBand XDR reference
    expect(r.fromPort).toMatch(/^H1\.DU\d{2}-[AB]-\d{2}-U\d+:N\d{2}:be\d+$/);
    expect(r.toPort).toMatch(/^H1\.[\w-]+-U\d+:P\d+$/);
    expect(r.labelA.startsWith(`${r.cableId} BSN `)).toBe(true);
    expect(r.labelA).toContain(`THIS ${r.fromPort} | FAR ${r.toPort}`);
    expect(r.labelB).toContain(`THIS ${r.toPort} | FAR ${r.fromPort}`);
    expect(r.fromU).toBeGreaterThanOrEqual(1);
    expect(r.fromU).toBeLessThanOrEqual(48);
    expect(r.wave).toBeDefined();
    expect(rows.filter((x) => x.fabricKey === 'oob').every((x) => x.cableId.startsWith('OOB-H1-'))).toBe(true);
    expect(rows.filter((x) => x.tier === 'leaf-spine').every((x) => /:P\d+$/.test(x.fromPort) && /:P\d+$/.test(x.toPort))).toBe(true);
    // numbering starts at 1 per (net, hall)
    expect(rows.some((x) => x.cableId === 'FE-H1-000001')).toBe(true);
  });

  it('is deterministic', () => {
    expect(buildCableSchedule(p, analyzeProject(ref()))).toEqual(rows);
  });
});

describe('ipplan.ts — deterministic IP / ASN plan (r2-ops.md §2.4)', () => {
  it('normalises an organisation /48 and generates a stable project-specific ULA fallback', () => {
    expect(normalizeIpv6Prefix('2001:0DB8:0042::/48')).toBe('2001:db8:42::/48');
    expect(normalizeIpv6Prefix('2001:db8::/64')).toBeUndefined();
    expect(normalizeIpv6Prefix('not-an-ip/48')).toBeUndefined();
    expect(projectUlaPrefix('project-a')).toMatch(/^fd[0-9a-f]{2}:[0-9a-f]{4}:[0-9a-f]{4}::\/48$/);
    expect(projectUlaPrefix('project-a')).toBe(projectUlaPrefix('project-a'));
    expect(projectUlaPrefix('project-a')).not.toBe(projectUlaPrefix('project-b'));
  });

  it('worked example: hall 1, plane 0, leaf 5 (64 host ports), port 12 → 10.80.2.152/31 switch, .153 host', () => {
    const x = backendP2p({ hall: 1, plane: 0, leaf: 5, hostLanesPerLeaf: 64, slot: 12 });
    expect(x.leafBlock).toBe(128);
    expect(ipToString(x.leafBase)).toBe('10.80.2.128');
    expect(ipToString(x.switchIp)).toBe('10.80.2.152');
    expect(ipToString(x.hostIp)).toBe('10.80.2.153');
  });

  it('capacity: 4 halls × 20,000 GPUs fits every block (1 and 8 planes)', () => {
    for (const c of ipPlanCapacity({ halls: 4, gpusPerHall: 20_000, lanesPerGpu: 2, leafHostLanes: 64, planes: 1, accessLeavesPerHall: 135, oobSwitchesPerHall: 270 })) expect(c.ok, c.item).toBe(true);
    for (const c of ipPlanCapacity({ halls: 4, gpusPerHall: 20_000, lanesPerGpu: 1, leafHostLanes: 64, planes: 8, accessLeavesPerHall: 135, oobSwitchesPerHall: 270 })) expect(c.ok, c.item).toBe(true);
    // worst address of that site stays inside 10.64.0.0/10 and inside its leaf block
    const worst = backendP2p({ hall: 3, plane: 7, leaf: Math.ceil(20_000 / 64) - 1, hostLanesPerLeaf: 64, slot: 63 });
    expect(worst.overflow).toBe(false);
    expect(worst.hostIp).toBeLessThan((10 * 2 ** 24) + (128 << 16));
    // backlog T3 (4): capacity follows ipHallLayout — 5 halls use the scaled layout (3 hall bits) instead of failing the fixed 2-bit field
    expect(ipPlanCapacity({ halls: 4, gpusPerHall: 20_000, lanesPerGpu: 1, leafHostLanes: 64, planes: 1, accessLeavesPerHall: 1, oobSwitchesPerHall: 1 }).map((c) => c.item)).toEqual([
      'halls (2 bits)', 'planes (3 bits)', 'backend host /31 per plane (2^17 addresses)', 'backend leaf loopbacks per hall (4,096 + overflow role)',
      'backend leaf ASNs per hall (plane·10,000 + leaf)', 'access /24 per hall (8 bits)', 'OOB /24 per hall (10 bits)',
    ]);
    const five = ipPlanCapacity({ halls: 5, gpusPerHall: 20_000, lanesPerGpu: 1, leafHostLanes: 64, planes: 1, accessLeavesPerHall: 1, oobSwitchesPerHall: 1 });
    expect(five[0]).toMatchObject({ item: 'halls (3 bits)', capacity: 8, ok: true });
    for (const c of five) expect(c.ok, c.item).toBe(true);
    const L8 = ipHallLayout(8, 1);
    const eight = ipPlanCapacity({ halls: 8, gpusPerHall: 20_000, lanesPerGpu: 1, leafHostLanes: 64, planes: 1, accessLeavesPerHall: 2 ** L8.accessLeafBits + 1, oobSwitchesPerHall: 2 ** L8.oobSwitchBits });
    expect(eight.find((c) => c.item.startsWith('access'))).toMatchObject({ capacity: 2 ** L8.accessLeafBits, ok: false });
    expect(eight.find((c) => c.item.startsWith('OOB'))).toMatchObject({ capacity: 2 ** L8.oobSwitchBits, ok: true });
    expect(eight.find((c) => c.item.startsWith('backend host'))!.capacity).toBe(2 ** L8.planeShift);
    expect(ipPlanCapacity({ halls: 9, gpusPerHall: 1000, lanesPerGpu: 1, leafHostLanes: 64, planes: 9, accessLeavesPerHall: 1, oobSwitchesPerHall: 1 })[1].ok).toBe(false);
  });

  it('InfiniBand reference: no backend IPs, PKey note; front-end / storage / in-band / OOB addressed', () => {
    const p = ref();
    const a = analyzeProject(p);
    const plan = buildIpPlan(p, a);
    expect(plan.blocks.some((b) => b.name === 'backend-host')).toBe(false);
    expect(plan.notes!.some((n) => /PKey/.test(n))).toBe(true);
    const rows = buildCableSchedule(p, a);
    expect(plan.oob).toHaveLength(rows.filter((r) => r.fabricKey === 'oob' && r.tier === 'endpoint-leaf').length);
    expect(plan.hosts.filter((h) => h.vlan === 30).length).toBe(rows.filter((r) => r.fabricKey === 'frontend' && r.tier === 'endpoint-leaf').length);
    expect(plan.p2p.every((l) => l.unnumbered)).toBe(true);
    expect(plan.addressFamilies).toEqual(['ipv4', 'ipv6']);
    expect(plan.ipv6Prefix).toMatch(/^fd[0-9a-f]{2}:/);
    expect(plan.hosts.every((h) => h.ipv6?.endsWith('/64'))).toBe(true);
    expect(plan.oob.every((o) => o.ipv6?.endsWith('/64'))).toBe(true);
    expect(plan.loopbacks.every((l) => !!l.ipv6)).toBe(true);
    expect(plan.p2p.every((l) => !l.ipv6Cidr)).toBe(true); // link-local only in unnumbered mode
  });

  it('RoCE, 4 populated halls: unique host / loopback / OOB addresses, unique leaf ASNs, one spine ASN per hall', () => {
    const p = halls(4, 'spectrumx-800');
    const a = analyzeProject(p);
    const plan = buildIpPlan(p, a);
    const rows = buildCableSchedule(p, a);
    const beRows = rows.filter((r) => r.fabricKey === 'scale-out' && r.tier === 'endpoint-leaf');
    const beHosts = plan.hosts.filter((h) => h.vlan === undefined && h.nic.startsWith('be'));
    expect(beHosts).toHaveLength(beRows.length);
    const ips = [...plan.hosts.map((h) => h.ip.split('/')[0]), ...plan.loopbacks.map((l) => l.ip), ...plan.oob.map((o) => o.ip.split('/')[0]), ...plan.hosts.flatMap((h) => (h.vlan === undefined && h.gw ? [h.gw] : []))];
    expect(new Set(ips).size).toBe(ips.length);
    // /31: gateway even, host odd, same /31
    for (const h of beHosts.slice(0, 500)) {
      const host = Number(h.ip.split('/')[0].split('.')[3]);
      const gw = Number(h.gw!.split('.')[3]);
      expect(host % 2).toBe(1);
      expect(gw).toBe(host - 1);
    }
    const units = buildSwitchUnits(p, a);
    const asn = new Map(plan.asns.map((x) => [x.deviceId, x.asn]));
    const leaves = units.filter((u) => u.fabricKey === 'scale-out' && u.role === 'leaf');
    expect(new Set(leaves.map((u) => asn.get(u.id))).size).toBe(leaves.length);
    for (const hallId of p.halls.map((h) => h.id)) {
      const spines = units.filter((u) => u.fabricKey === 'scale-out' && u.role === 'spine' && u.hallId === hallId);
      expect(spines.length).toBeGreaterThan(0);
      expect(new Set(spines.map((u) => asn.get(u.id))).size).toBe(1);
      expect(leaves.some((u) => asn.get(u.id) === asn.get(spines[0].id))).toBe(false);
    }
    for (const x of plan.asns) {
      expect(x.asn).toBeGreaterThanOrEqual(4_200_000_000);
      expect(x.asn).toBeLessThanOrEqual(4_294_967_294);
    }
    expect(plan.p2p).toHaveLength(rows.filter((r) => r.tier !== 'endpoint-leaf').length);
    // numbered mode: every fabric /31 unique
    const numbered = buildIpPlan(p, a, { numberedFabric: true });
    const cidrs = numbered.p2p.map((l) => l.cidr!);
    expect(cidrs.every(Boolean)).toBe(true);
    expect(new Set(cidrs).size).toBe(cidrs.length);
    expect(plan.hosts.every((h) => !!h.ipv6 && !!h.ipv6Gw)).toBe(true);
    expect(beHosts.every((h) => h.ipv6?.endsWith('/127') && h.network === 'backend' && h.rail !== undefined)).toBe(true);
    const ipv6Endpoints = [...plan.hosts.map((h) => h.ipv6!.split('/')[0]), ...plan.oob.map((o) => o.ipv6!.split('/')[0]), ...plan.loopbacks.map((l) => l.ipv6!)];
    expect(new Set(ipv6Endpoints).size).toBe(ipv6Endpoints.length);
    expect(numbered.p2p.every((l) => l.ipv6Cidr?.endsWith('/127') && l.ipv6A && l.ipv6B)).toBe(true);
    expect(new Set(numbered.p2p.map((l) => l.ipv6Cidr)).size).toBe(numbered.p2p.length);
    const v4Only = buildIpPlan({ ...p, network: { ...p.network, addressing: { mode: 'ipv4' } } }, a);
    expect(v4Only.addressFamilies).toEqual(['ipv4']);
    expect(v4Only.ipv6Prefix).toBeUndefined();
    expect(v4Only.hosts.every((h) => !h.ipv6)).toBe(true);
    expect(plan.notes!.some((n) => /overflow|exceed|outside/.test(n))).toBe(false);
  }, 120_000);
});
