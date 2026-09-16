// Fixtures for the T7 NOS / deploy tests: a RoCE variant of the reference project and a small hand-built cable
// schedule + IP plan on two scale-out leaves and two spines (independent of T2's generator output).
import { analyzeProject, buildSwitchUnits, createNvidiaReferenceProject, type CableScheduleRow, type IpPlan, type Project, type ProjectAnalysis } from '../src/index.ts';

export function roceProject(): Project {
  const base = createNvidiaReferenceProject().project;
  return { ...base, network: { ...base.network, scaleOut: { ...base.network.scaleOut, fabric: 'roce-generic-800', switchCatalogId: 'generic-roce-800' } } };
}

export interface NosFixture {
  project: Project;
  analysis: ProjectAnalysis;
  rows: CableScheduleRow[];
  plan: IpPlan;
  leaves: { tia: string; id: string }[];
  spines: { tia: string; id: string }[];
}

export function nosFixture(): NosFixture {
  const project = roceProject();
  const analysis = analyzeProject(project);
  const hallNo = new Map(project.halls.map((h, i) => [h.id, i + 1]));
  const units = buildSwitchUnits(project, analysis).filter((u) => u.fabricKey === 'scale-out');
  const tia = (u: (typeof units)[number]) => `H${hallNo.get(u.hallId)}.${u.rackTag}-U${u.u}`;
  const leaves = units.filter((u) => u.role === 'leaf').slice(0, 2).map((u) => ({ tia: tia(u), id: u.id }));
  const spines = units.filter((u) => u.role === 'spine').slice(0, 2).map((u) => ({ tia: tia(u), id: u.id }));
  if (leaves.length < 2 || spines.length < 2) throw new Error('fixture needs 2 scale-out leaves and 2 spines');
  const rows: (CableScheduleRow & { tier: string; speedGbps: number })[] = [];
  const plan: IpPlan = { blocks: [{ name: 'loopback', cidr: '10.0.0.0/14', purpose: 'loopbacks, "quoted", with comma' }], loopbacks: [], asns: [], p2p: [], hosts: [], oob: [] };
  let seq = 0;
  const id = () => `BE-H1-${String(++seq).padStart(6, '0')}`;
  leaves.forEach((l, li) => {
    plan.loopbacks.push({ deviceId: l.id, ip: `10.0.0.${li}` });
    plan.asns.push({ deviceId: l.id, asn: 4_200_300_000 + li });
    for (let n = 0; n < 2; n++) {
      const node = `H1.DU0${li + 1}-A-01-U40:N0${n + 1}`;
      const cableId = id();
      rows.push({ cableId, fabric: 'Generic RoCEv2 Ethernet 800G', fromRack: `H1.DU0${li + 1}-A-01`, fromU: 40, fromPort: `${node}:be0`, toRack: l.tia.replace(/-U\d+$/, ''), toU: Number(/-U(\d+)$/.exec(l.tia)![1]), toPort: `${l.tia}:P1/${n + 1}`, cableTypeId: 'aoc-400', lengthM: 12.5, labelA: `${cableId} BSN 0001 | THIS ${node}:be0 | FAR ${l.tia}:P1/${n + 1}, "AOC"`, labelB: `${cableId} | THIS ${l.tia}:P1/${n + 1}`, wave: 'wave-01', tier: 'endpoint-leaf', speedGbps: 400 });
      const sw = 0x0a400000 + li * 16 + 2 * n; // 10.64.x.y
      const ip = (v: number) => [v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join('.');
      plan.hosts.push({ nodeId: node, nic: 'be0', ip: `${ip(sw + 1)}/31`, gw: ip(sw) });
    }
    spines.forEach((s, si) => {
      const cableId = id();
      rows.push({ cableId, fabric: 'Generic RoCEv2 Ethernet 800G', fromRack: l.tia.replace(/-U\d+$/, ''), fromU: Number(/-U(\d+)$/.exec(l.tia)![1]), fromPort: `${l.tia}:P${33 + si}`, toRack: s.tia.replace(/-U\d+$/, ''), toU: Number(/-U(\d+)$/.exec(s.tia)![1]), toPort: `${s.tia}:P${li + 1}`, cableTypeId: 'smf-800-dr8', lengthM: 38, labelA: `${cableId}`, labelB: `${cableId}`, wave: 'wave-01', tier: 'leaf-spine', speedGbps: 800 });
      plan.p2p.push({ linkId: cableId, a: `${l.tia}:P${33 + si}`, b: `${s.tia}:P${li + 1}`, unnumbered: true });
    });
  });
  spines.forEach((s, si) => {
    plan.loopbacks.push({ deviceId: s.id, ip: `10.0.16.${si}` });
    plan.asns.push({ deviceId: s.id, asn: 4_200_200_000 });
  });
  return { project, analysis, rows, plan, leaves, spines };
}
