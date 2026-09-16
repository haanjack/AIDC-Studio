// Backlog T3 (1)–(3): front-end leaf capacity per pod (no unresolved cable ends with a Spectrum-X-class scale-out on the reference hall),
// unique rack-level management port names when a rack has more OOB ports than nodes, and IP plan / review text in EN and KO.
import { describe, expect, it } from 'vitest';
import {
  analyzeProject, buildCableSchedule, buildIpPlan, buildIpReview, buildSwitchUnits, createNvidiaReferenceProject, FABRIC_SWITCH, findCatalogItem, groupIpPlanByRail,
  groupIpPlanBySubnet, summarizeCableSchedule, type Project,
} from '../src/index.ts';

const HANGUL = /[가-힣]/;
const withFabric = (p: Project, fabric: 'spectrumx-800' | 'ib-xdr-800'): Project => ({ ...p, network: { ...p.network, scaleOut: { ...p.network.scaleOut, fabric, switchCatalogId: FABRIC_SWITCH[fabric] } } });

describe('front-end leaves sized per pod (backlog T3 (1))', () => {
  const sx = withFabric(createNvidiaReferenceProject().project, 'spectrumx-800');
  const a = analyzeProject(sx);
  const rows = buildCableSchedule(sx, a);

  it('every front-end endpoint lands on a switch port — no `NET2:?` cable ends, no port overflow', () => {
    const fe = rows.filter((r) => r.fabricKey === 'frontend' && r.tier === 'endpoint-leaf');
    expect(fe.length).toBeGreaterThan(1900);
    expect(fe.filter((r) => r.toPort.endsWith(':?'))).toEqual([]);
    const sum = summarizeCableSchedule(rows, buildSwitchUnits(sx, a));
    expect(sum.unresolvedEnds).toBe(0);
    expect(sum.overflowPorts).toBe(0);
  });

  it('the IP review lists no "not addressed" endpoints', () => {
    const review = buildIpReview(sx, a, { numberedFabric: false });
    expect(review.entries.filter((e) => e.unresolved)).toEqual([]);
    expect(groupIpPlanBySubnet(review).children.some((g) => g.code === 'unresolved')).toBe(false);
  });

  it('the InfiniBand reference keeps its schedule (no unresolved ends)', () => {
    const ref = createNvidiaReferenceProject().project;
    expect(summarizeCableSchedule(buildCableSchedule(ref, analyzeProject(ref))).unresolvedEnds).toBe(0);
  });
});

describe('unique OOB port names (backlog T3 (2))', () => {
  it('ports beyond one BMC per node get rack-level MGMT<n> names instead of repeating the last node', () => {
    const item = findCatalogItem('nvidia-gb300-nvl72')!;
    const before = item.compute!.oobPorts;
    try {
      item.compute!.oobPorts = 26; // 18 nodes → 1 BMC per node + 8 rack-level management ports
      const p = createNvidiaReferenceProject({ pods: 1 }).project;
      const rows = buildCableSchedule(p, analyzeProject(p));
      const oob = rows.filter((r) => r.fabricKey === 'oob' && r.tier === 'endpoint-leaf');
      const seen = new Map<string, number>();
      for (const r of oob) seen.set(r.fromPort, (seen.get(r.fromPort) ?? 0) + 1);
      expect([...seen].filter(([, n]) => n > 1)).toEqual([]);
      const rack = oob.find((r) => r.fromPort.includes(':N18:bmc'))!.fromRack;
      const names = oob.filter((r) => r.fromRack === rack).map((r) => r.fromPort.slice(rack.length));
      expect(names.filter((n) => /:N\d\d:bmc$/.test(n))).toHaveLength(18);
      expect(names.filter((n) => /:MGMT\d$/.test(n)).sort()).toEqual(['MGMT1', 'MGMT2', 'MGMT3', 'MGMT4', 'MGMT5', 'MGMT6', 'MGMT7', 'MGMT8'].map((m) => `:${m}`));
    } finally {
      item.compute!.oobPorts = before;
    }
  });

  it('the reference rack (32 OOB ports, 2 per node) keeps its node-level names', () => {
    const p = createNvidiaReferenceProject({ pods: 1 }).project;
    const oob = buildCableSchedule(p, analyzeProject(p)).filter((r) => r.fabricKey === 'oob' && r.tier === 'endpoint-leaf');
    expect(oob.some((r) => /:MGMT\d+$/.test(r.fromPort) && /-(01|02|03)$/.test(r.fromRack))).toBe(false);
    expect(new Set(oob.map((r) => r.fromPort)).size).toBe(oob.length);
  });
});

describe('IP plan text in EN and KO (backlog T3 (3))', () => {
  const ib = createNvidiaReferenceProject().project;
  const ia = analyzeProject(ib);
  const sx = withFabric(createNvidiaReferenceProject().project, 'spectrumx-800');
  const sa = analyzeProject(sx);

  it('KO: block purposes, notes and loopback role labels are Korean; addresses are identical to EN', () => {
    for (const [p, a] of [[ib, ia], [sx, sa]] as const) {
      const en = buildIpPlan(p, a);
      const ko = buildIpPlan(p, a, { locale: 'ko' });
      expect(ko.blocks.map((b) => [b.name, b.cidr])).toEqual(en.blocks.map((b) => [b.name, b.cidr]));
      for (const b of ko.blocks) expect(b.purpose, b.name).toMatch(HANGUL);
      for (const b of en.blocks) expect(b.purpose, b.name).not.toMatch(HANGUL);
      expect(ko.loopbacks).toEqual(en.loopbacks);
      expect(ko.hosts).toEqual(en.hosts);
      expect(ko.oob).toEqual(en.oob);
      const koNotes = (ko as { notes?: string[] }).notes ?? [];
      const enNotes = (en as { notes?: string[] }).notes ?? [];
      expect(koNotes.length).toBe(enNotes.length);
      for (const n of koNotes) expect(n).toMatch(HANGUL);
    }
  });

  it('KO: review group labels (networks, rails, tiers, loopback roles) are Korean; codes unchanged', () => {
    const en = buildIpReview(sx, sa);
    const ko = buildIpReview(sx, sa, { locale: 'ko' });
    const labels = (g: ReturnType<typeof groupIpPlanByRail>, out: { code?: string; kind: string; label: string }[] = []) => {
      for (const c of g.children) {
        out.push({ code: c.code, kind: c.kind, label: c.label });
        labels(c, out);
      }
      return out;
    };
    const k = labels(groupIpPlanByRail(ko));
    const e = labels(groupIpPlanByRail(en));
    // loopback tier groups are keyed by their role label (localized with it); every other group code is language-neutral
    const codes = (xs: typeof k) => xs.filter((x) => x.kind !== 'tier').map((x) => `${x.kind}|${x.code ?? ''}`).sort();
    expect(codes(k)).toEqual(codes(e));
    expect(k.filter((x) => x.kind === 'tier').length).toBe(e.filter((x) => x.kind === 'tier').length);
    for (const x of k.filter((x) => ['net', 'rail', 'links', 'tier'].includes(x.kind))) expect(x.label, `${x.kind} ${x.code}`).toMatch(HANGUL);
    expect(e.filter((x) => x.kind === 'net').map((x) => x.label)).toContain('Backend (scale-out)');
    expect(e.filter((x) => x.kind === 'tier').some((x) => x.label === 'backend leaf')).toBe(true);
    expect(k.filter((x) => x.kind === 'tier').some((x) => x.label === '백엔드 리프')).toBe(true);
  });
});
