import { describe, expect, it } from 'vitest';
import {
  analyzeProject, buildCableSchedule, buildIpPlanDetailed, buildIpReview, buildIpReviewFromDetailed, buildSwitchUnits, createNvidiaReferenceProject, FABRIC_SWITCH, filterIpReview, groupIpPlanByLocation, groupIpPlanByRail, groupIpPlanBySubnet,
  ipReviewCsv, ipReviewGroupEntries, parseCidr, type IpReview, type IpReviewGroup, type Project,
} from '../src/index.ts';

const withFabric = (p: Project, fabric: 'spectrumx-800' | 'ib-xdr-800'): Project => ({ ...p, network: { ...p.network, scaleOut: { ...p.network.scaleOut, fabric, switchCatalogId: FABRIC_SWITCH[fabric] } } });

function walk(g: IpReviewGroup, fn: (g: IpReviewGroup, path: IpReviewGroup[]) => void, path: IpReviewGroup[] = []) {
  fn(g, path);
  for (const c of g.children) walk(c, fn, [...path, g]);
}

/** every entry exactly once; additive counters equal own entries + Σ children at every level */
function checkView(review: IpReview, root: IpReviewGroup) {
  const keys = ipReviewGroupEntries(root).map((e) => e.key);
  expect(keys.length).toBe(review.entries.length);
  expect(new Set(keys).size).toBe(keys.length);
  expect(new Set(keys)).toEqual(new Set(review.entries.map((e) => e.key)));
  walk(root, (g) => {
    const own = g.entries;
    const sum = (f: (x: IpReviewGroup) => number, ownCount: number) => ownCount + g.children.reduce((a, c) => a + f(c), 0);
    expect(g.total, g.id).toBe(sum((c) => c.total, own.length));
    expect(g.nics, g.id).toBe(sum((c) => c.nics, own.filter((e) => e.kind === 'nic' || e.kind === 'mgmt' || e.kind === 'oob').length));
    expect(g.links, g.id).toBe(sum((c) => c.links, own.filter((e) => e.kind === 'link').length));
    expect(g.loopbacks, g.id).toBe(sum((c) => c.loopbacks, own.filter((e) => e.kind === 'loopback').length));
    expect(g.addresses, g.id).toBe(sum((c) => c.addresses, own.filter((e) => e.ip || (e.cidr && !e.unnumbered)).length));
    expect(g.utilisation, g.id).toBeLessThanOrEqual(1);
    // leaf groups hold the entries; inner groups only group
    if (g.children.length) expect(own.length, g.id).toBe(0);
  });
  expect(root.total).toBe(review.entries.length);
}

describe('ipmap.ts — review views (location · rail / fabric · subnet)', () => {
  const sx = withFabric(createNvidiaReferenceProject().project, 'spectrumx-800');
  const sxa = analyzeProject(sx);
  const ib = createNvidiaReferenceProject().project;
  const iba = analyzeProject(ib);

  for (const [name, p, a, numberedFabric] of [['Spectrum-X unnumbered', sx, sxa, false], ['Spectrum-X numbered', sx, sxa, true], ['InfiniBand', ib, iba, false]] as const) {
    it(`${name}: every host NIC, OOB port, loopback and link is an entry; each view lists each exactly once and counts sum`, () => {
      const review = buildIpReview(p, a, { numberedFabric });
      const { plan } = review;
      const rows = buildCableSchedule(p, a);
      expect(new Set(review.entries.map((e) => e.key)).size).toBe(review.entries.length);
      expect(review.entries.filter((e) => (e.kind === 'nic' || e.kind === 'mgmt') && e.ip).length).toBe(plan.hosts.length);
      expect(review.entries.filter((e) => e.kind === 'oob').length).toBe(plan.oob.length);
      expect(review.entries.filter((e) => e.kind === 'loopback').length).toBe(plan.loopbacks.length);
      expect(review.entries.filter((e) => e.kind === 'link').length).toBe(plan.p2p.length);
      const beRows = rows.filter((r) => r.tier === 'endpoint-leaf' && r.fabricKey === 'scale-out').length;
      if (review.isIb) expect(review.entries.filter((e) => e.noIp && e.net === 'backend').length).toBe(beRows);
      else expect(review.entries.filter((e) => e.net === 'backend' && e.kind === 'nic').length).toBe(beRows);
      // endpoints the cable schedule could not land on a switch port are listed as not addressed
      const hallNo = new Map(p.halls.map((h, i) => [h.id, i + 1]));
      const devices = new Set(buildSwitchUnits(p, a).map((u) => `H${hallNo.get(u.hallId)}.${u.rackTag}-U${u.u}`));
      const unresolved = rows.filter((r) => r.tier === 'endpoint-leaf' && !devices.has(r.toPort.slice(0, r.toPort.lastIndexOf(':'))));
      expect(review.entries.filter((e) => e.unresolved).map((e) => e.key).sort()).toEqual(unresolved.map((r) => `u:${r.fromPort}`).sort());
      // every addressed entry sits in a subnet of the plan (unnumbered links / IB NICs have none)
      for (const e of review.entries) if (e.ip) expect(e.subnetKey, e.key).toBeDefined();

      const loc = groupIpPlanByLocation(review);
      const rail = groupIpPlanByRail(review);
      const sub = groupIpPlanBySubnet(review);
      checkView(review, loc);
      checkView(review, rail);
      checkView(review, sub);

      // location: hall → pod → rack → device; members agree with their groups
      walk(loc, (g, path) => {
        if (g.kind === 'root') return;
        const kinds = [...path.map((x) => x.kind), g.kind].slice(1);
        expect(['hall', 'hall,pod', 'hall,pod,rack', 'hall,pod,rack,device']).toContain(kinds.join(','));
        if (g.kind === 'rack') for (const e of ipReviewGroupEntries(g)) expect(e.rackTag).toBe(g.rackTag);
        if (g.kind === 'device') for (const e of g.entries) expect(e.device.endsWith(g.label)).toBe(true);
        if (g.kind === 'hall') for (const e of ipReviewGroupEntries(g)) expect(e.hallId).toBe(g.hallId);
      });

      // subnet view: members inside the subnet, free space consistent
      walk(sub, (g) => {
        if (g.kind !== 'subnet') return;
        const r = parseCidr(g.cidr!)!;
        expect(r.size).toBe(g.size);
        for (const e of g.entries) {
          const x = parseCidr(e.ip ?? e.cidr!)!;
          expect(x.start, e.key).toBeGreaterThanOrEqual(r.start);
          expect(x.start + x.size, e.key).toBeLessThanOrEqual(r.start + r.size);
        }
        expect(g.free!.free).toBeGreaterThanOrEqual(0);
        expect(g.free!.free + g.used).toBeLessThanOrEqual(g.size);
        // access /24: network + broadcast reserved, gateway + hosts used
        if (g.size === 256 && g.gateways.length) expect(g.free!.free).toBe(254 - g.used);
      });
    });
  }

  it('rail view: rail membership matches the cable schedule (NIC → leaf → rail) and every railed backend NIC sits under its rail', () => {
    const review = buildIpReview(sx, sxa);
    const rows = buildCableSchedule(sx, sxa);
    const units = buildSwitchUnits(sx, sxa);
    const hallNo = new Map(sx.halls.map((h, i) => [h.id, i + 1]));
    const unitByDevice = new Map(units.map((u) => [`H${hallNo.get(u.hallId)}.${u.rackTag}-U${u.u}`, u]));
    const railOfNic = new Map<string, number | undefined>();
    for (const r of rows) {
      if (r.tier !== 'endpoint-leaf' || r.fabricKey !== 'scale-out') continue;
      railOfNic.set(r.fromPort, unitByDevice.get(r.toPort.slice(0, r.toPort.lastIndexOf(':')))?.rail);
    }
    expect(review.rails.length).toBeGreaterThan(1);
    const root = groupIpPlanByRail(review);
    let railed = 0;
    walk(root, (g, path) => {
      if (g.kind !== 'rail' || g.rail === undefined) return;
      expect(path.some((x) => x.kind === 'net' && x.code === 'backend')).toBe(true);
      for (const e of ipReviewGroupEntries(g)) {
        expect(e.rail, e.key).toBe(g.rail);
        if (e.kind === 'nic') {
          expect(railOfNic.get(`${e.device}:${e.port}`), e.key).toBe(g.rail);
          railed++;
        }
        if (e.kind === 'link') expect(unitByDevice.get(e.device)?.rail).toBe(g.rail);
      }
      for (const c of g.children) if (c.kind === 'switch') expect(review.switches.get(c.device!)?.rail).toBe(g.rail);
    });
    expect(railed).toBe([...railOfNic.values()].filter((r) => r !== undefined).length);
    // link groups sort after the leaves / rails beside them (NICs first, uplinks last)
    walk(root, (g) => {
      const firstLinks = g.children.findIndex((c) => c.kind === 'links');
      if (firstLinks >= 0) expect(g.children.slice(firstLinks).every((c) => c.kind === 'links'), g.id).toBe(true);
    });
    // fabrics present: backend, front-end, storage, in-band, OOB, loopbacks
    expect(root.children.map((c) => c.code)).toEqual(['backend', 'frontend', 'storage', 'inband', 'oob', 'loopbacks']);
  });

  it('repeated endpoint names in the plan (several OOB rows from one port) still give unique entry keys, listed once per view', () => {
    const d = buildIpPlanDetailed(sx, sxa);
    const o = d.plan.oob[0];
    const dup = { ...d, plan: { ...d.plan, oob: [...d.plan.oob, { ...o }, { ...o }] } };
    const review = buildIpReviewFromDetailed(sx, dup);
    const keys = review.entries.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.filter((k) => k.startsWith(`o:${o.deviceId}`))).toEqual([`o:${o.deviceId}`, `o:${o.deviceId}#2`, `o:${o.deviceId}#3`]);
    for (const view of [groupIpPlanByLocation(review), groupIpPlanByRail(review), groupIpPlanBySubnet(review)]) checkView(review, view);
  });

  it('filters and search: hall / DU / rack / fabric / rail / device type, IP, CIDR, text; CSV per selection', () => {
    const review = buildIpReview(sx, sxa, { numberedFabric: true });
    const rack = review.racks.find((r) => r.tag.startsWith('DU01-A-0'))!;
    const inRack = filterIpReview(review, { rackTag: rack.tag });
    expect(inRack.length).toBeGreaterThan(0);
    expect(inRack.every((e) => e.rackTag === rack.tag)).toBe(true);
    const pod = filterIpReview(review, { hallId: rack.hallId, pod: rack.pod });
    expect(pod.length).toBeGreaterThan(inRack.length);
    expect(filterIpReview(review, { rail: 1 }).every((e) => e.rail === 1)).toBe(true);
    expect(filterIpReview(review, { net: 'storage', deviceType: 'node' }).every((e) => e.net === 'storage' && e.deviceType === 'node')).toBe(true);
    const host = review.entries.find((e) => e.kind === 'nic' && e.net === 'frontend')!;
    expect(filterIpReview(review, { query: host.ip }).map((e) => e.key)).toEqual([host.key]);
    expect(host.ipv6).toBeTruthy();
    expect(host.ipv6Subnet).toMatch(/\/64$/);
    expect(filterIpReview(review, { query: host.ipv6 }).map((e) => e.key)).toEqual([host.key]);
    expect(filterIpReview(review, { query: host.ipv6Subnet }).some((e) => e.key === host.key)).toBe(true);
    // a gateway address returns every host behind it
    expect(filterIpReview(review, { query: host.gw }).length).toBeGreaterThan(1);
    const s = review.subnetByKey.get(host.subnetKey!)!;
    const cidr = `${host.ip!.split('.').slice(0, 3).join('.')}.0/24`;
    const inCidr = filterIpReview(review, { query: cidr });
    expect(inCidr.length).toBe(review.entries.filter((e) => e.subnetKey === s.key).length);
    expect(filterIpReview(review, { query: `${host.device}:${host.port}`.toUpperCase() }).some((e) => e.key === host.key)).toBe(true);
    const lo = review.entries.find((e) => e.kind === 'loopback' && e.asn)!;
    expect(filterIpReview(review, { query: String(lo.asn) }).some((e) => e.key === lo.key)).toBe(true);
    expect(filterIpReview(review, { query: 'no-such-thing-xyz' })).toEqual([]);
    // grouped filtered entries still list each once
    const g = groupIpPlanByLocation(review, inRack);
    expect(ipReviewGroupEntries(g).length).toBe(inRack.length);
    const csv = ipReviewCsv(review, inRack);
    const lines = csv.replace(/^﻿/, '').trimEnd().split('\r\n');
    expect(lines[0].split(',')[0]).toBe('hall');
    expect(lines[0]).toContain('ipv6_gateway');
    expect(lines[0]).toContain('ipv6_subnet');
    expect(lines).toHaveLength(inRack.length + 1);
  });
});
