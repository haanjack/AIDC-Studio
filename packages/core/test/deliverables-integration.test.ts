// Integration v2 2차 (#12, #13): NOS configs and the acceptance test kit generated from T2's LIVE cable schedule and IP plan on the
// reference project (not hand-built fixtures), and the η calibration round trip: the log the generated 30-collectives kit writes →
// parseCollectiveLog / nominalInputsFor / calibrateEta (the Network panel's path) and the kit's own eta_calibrate.py → same η.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  analyzeProject, buildCableSchedule, buildIpPlan, buildTestKitModel, calibrateEta, createNvidiaReferenceProject, FABRIC_SWITCH, findCatalogItem, generateNosConfigs,
  generateTestPlan, NOS_TARGETS, nominalBusbwGBps, nominalInputsFor, parseCollectiveLog,
  type CableScheduleRow, type GeneratedFile, type IpPlan, type NosTarget, type Project, type ProjectAnalysis,
} from '../src/index.ts';
import { buildNosModel, type NosModel } from '../src/deploy/nos/model.ts';
import { planDevices, splitEndpoint } from '../src/deploy/devices.ts';

interface Live {
  project: Project;
  analysis: ProjectAnalysis;
  rows: CableScheduleRow[];
  plan: IpPlan;
  model: NosModel;
}

function live(project: Project): Live {
  const analysis = analyzeProject(project);
  const rows = buildCableSchedule(project, analysis);
  const plan = buildIpPlan(project, analysis);
  return { project, analysis, rows, plan, model: buildNosModel(project, analysis, plan, rows) };
}

const ref = live(createNvidiaReferenceProject().project);
const roceProject = (() => {
  const p = createNvidiaReferenceProject().project;
  return { ...p, network: { ...p.network, scaleOut: { ...p.network.scaleOut, fabric: 'roce-generic-800' as const, switchCatalogId: FABRIC_SWITCH['roce-generic-800'] } } };
})();
const roce = live(roceProject);

const RFC1123 = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const ETH_TARGETS = NOS_TARGETS.filter((t): t is Exclude<NosTarget, 'ib-ufm'> => t !== 'ib-ufm');

function checkModelAgainstPlanAndSchedule(L: Live, label: string) {
  const { model, plan, rows } = L;
  const lo = new Map(plan.loopbacks.map((x) => [x.deviceId, x.ip]));
  const asn = new Map(plan.asns.map((x) => [x.deviceId, x.asn]));
  // hostnames: RFC 1123 and unique across Ethernet and InfiniBand switches
  const names = [...model.switches.map((s) => s.hostname), ...model.ibSwitches.map((d) => d.hostname)];
  expect(names.every((h) => RFC1123.test(h)), `${label}: RFC 1123`).toBe(true);
  expect(new Set(names).size, `${label}: unique hostnames`).toBe(names.length);
  // loopbacks / ASNs come from the IP plan device ids
  for (const s of model.switches) {
    if (lo.has(s.device.id)) expect(s.loopback?.replace(/\/\d+$/, ''), `${label} ${s.hostname} loopback`).toBe(lo.get(s.device.id)!.replace(/\/\d+$/, ''));
    if (asn.has(s.device.id)) expect(s.asn, `${label} ${s.hostname} ASN`).toBe(asn.get(s.device.id));
  }
  expect(model.switches.filter((s) => s.loopback).length, `${label}: every plan loopback is on a configured switch`).toBe(plan.loopbacks.filter((x) => model.switches.some((s) => s.device.id === x.deviceId)).length);
  // physical ports: a switch port is used once — whole, or as breakout lanes of one speed (no 400G link + 4×100G lanes on the same cage)
  const use = new Map<string, { whole: number; lanes: Set<string> }>();
  for (const r of rows)
    for (const end of [r.fromPort, r.toPort]) {
      const pm = /^(.*-U\d+):P(\d+)(?:\/(\d+))?$/.exec(end);
      if (!pm) continue;
      const u = use.get(`${pm[1]}:P${pm[2]}`) ?? { whole: 0, lanes: new Set<string>() };
      if (pm[3]) {
        expect(u.lanes.has(pm[3]), `${label}: lane reused ${end}`).toBe(false);
        u.lanes.add(pm[3]);
      } else u.whole++;
      use.set(`${pm[1]}:P${pm[2]}`, u);
    }
  const clashes = [...use.entries()].filter(([, u]) => u.whole > 1 || (u.whole > 0 && u.lanes.size > 0)).map(([k]) => k);
  expect(clashes, `${label}: switch ports used both whole and broken out`).toEqual([]);
  // peer interfaces: every cable-schedule row with a configured switch end appears on that switch with the far end as peer
  // (the far end is named by its hostname when it is a switch of the plan, else by its schedule device id, e.g. a node NIC)
  const byTia = new Map(model.switches.filter((s) => s.device.tia).map((s) => [s.device.tia!, s]));
  const hostOfTia = new Map<string, string>([...model.switches, ...model.ibSwitches.map((d) => ({ device: d, hostname: d.hostname }))].filter((s) => s.device.tia).map((s) => [s.device.tia!, s.hostname]));
  const ifByCable = new Map<string, { host: string; peer: string; peerPort: string }[]>();
  for (const s of model.switches) for (const i of s.interfaces) if (i.cableId) ifByCable.set(i.cableId, [...(ifByCable.get(i.cableId) ?? []), { host: s.hostname, peer: i.peer, peerPort: i.peerPort }]);
  let checked = 0;
  for (const r of rows) {
    const A = splitEndpoint(r.fromPort);
    const B = splitEndpoint(r.toPort);
    for (const [me, far] of [[A, B], [B, A]] as const) {
      const sw = byTia.get(me.device);
      // a switch's own management port (OOB cable to `…-U39:mgmt0`) is not a front-panel data interface of its config
      if (!sw || !/^(UP|P)\d+(\/\d+)?$/.test(me.port ?? '')) continue;
      const hits = (ifByCable.get(r.cableId) ?? []).filter((x) => x.host === sw.hostname);
      expect(hits.length, `${label}: ${r.cableId} on ${sw.hostname}`).toBeGreaterThan(0);
      const farName = hostOfTia.get(far.device) ?? far.device;
      expect(hits.some((x) => (x.peer === farName || x.peer === far.device) && x.peerPort === (far.port ?? '')), `${label}: ${r.cableId} peer ${farName}:${far.port} (got ${JSON.stringify(hits)})`).toBe(true);
      checked++;
    }
  }
  expect(checked, `${label}: switch-side cable ends checked`).toBeGreaterThan(0);
  // host /31 or VLAN gateway: the switch side of every host address in the plan is an interface / SVI of the leaf the host is cabled to
  const gwOnSwitch = new Set(model.switches.flatMap((s) => [...s.interfaces.filter((i) => i.ip).map((i) => `${i.peer}:${i.peerPort}=${i.ip!.replace(/\/\d+$/, '')}`)]));
  const p2pHosts = plan.hosts.filter((h) => h.gw && h.vlan === undefined);
  for (const h of p2pHosts.slice(0, 4000)) expect(gwOnSwitch.has(`${h.nodeId}:${h.nic}=${h.gw}`), `${label}: host ${h.nodeId}:${h.nic} gw ${h.gw}`).toBe(true);
  return { checked, p2pHosts: p2pHosts.length };
}

describe('NOS configs from the live cable schedule and IP plan (reference project)', () => {
  it('IB reference: Ethernet front-end / storage / OOB switches and IB scale-out switches agree with the plan and the schedule', () => {
    expect(ref.model.isIbScaleOut).toBe(true);
    expect(ref.rows.length).toBe(ref.analysis.network.cableRuns.reduce((s, r) => s + r.count, 0));
    expect(ref.model.switches.length).toBeGreaterThan(0);
    expect(ref.model.ibSwitches.length).toBeGreaterThan(0);
    const r = checkModelAgainstPlanAndSchedule(ref, 'ib');
    expect(r.checked).toBeGreaterThan(1000);
  });

  it('RoCE variant: backend leaves carry the host /31 gateways, BGP loopbacks and ASNs of the plan', () => {
    expect(roce.model.isIbScaleOut).toBe(false);
    const r = checkModelAgainstPlanAndSchedule(roce, 'roce');
    expect(r.p2pHosts).toBeGreaterThan(0);
    const leaves = roce.model.switches.filter((s) => s.device.fabricKey === 'scale-out' && s.device.role === 'leaf');
    expect(leaves.length).toBeGreaterThan(0);
    expect(leaves.every((s) => s.asn !== undefined && s.loopback)).toBe(true);
    // unique leaf ASNs, one spine ASN per hall (RFC 7938 as T2's plan)
    expect(new Set(leaves.map((s) => s.asn)).size).toBe(leaves.length);
  });

  for (const [label, L] of [['ib', ref], ['roce', roce]] as const) {
    it(`${label}: every target renders each switch with its hostname, loopback, ASN and every peer interface (${ETH_TARGETS.length} Ethernet targets + ib-ufm)`, () => {
      for (const t of ETH_TARGETS) {
        const files = generateNosConfigs(L.project, L.analysis, L.plan, t, { cableSchedule: L.rows });
        const byHost = new Map<string, string>();
        for (const f of files) {
          const host = /^([a-z0-9-]+)(?:[/.])/.exec(f.path)?.[1];
          if (host) byHost.set(host, (byHost.get(host) ?? '') + '\n' + f.content);
        }
        for (const s of L.model.switches) {
          const text = byHost.get(s.hostname);
          expect(text, `${t}: files for ${s.hostname}`).toBeDefined();
          if (s.loopback) expect(text!.includes(s.loopback.replace(/\/\d+$/, '')), `${t} ${s.hostname} loopback ${s.loopback}`).toBe(true);
          if (s.asn !== undefined) expect(text!.includes(String(s.asn)), `${t} ${s.hostname} ASN ${s.asn}`).toBe(true);
          for (const i of s.interfaces) expect(text!.includes(i.peer), `${t} ${s.hostname} port ${i.port}/${i.lane} peer ${i.peer}`).toBe(true);
        }
        const csv = files.find((f) => f.path === 'switches.csv')!.content;
        for (const s of L.model.switches) expect(csv.includes(s.hostname), `${t} switches.csv ${s.hostname}`).toBe(true);
      }
      const ib = generateNosConfigs(L.project, L.analysis, L.plan, 'ib-ufm', { cableSchedule: L.rows });
      const ibCsv = ib.find((f) => f.path === 'switches.csv')?.content ?? '';
      for (const d of L.model.ibSwitches) expect(ibCsv.includes(d.hostname), `ib-ufm switches.csv ${d.hostname}`).toBe(true);
    });
  }

  it('hostnames in the configs are the plan devices of T2 (planDevices ↔ buildSwitchUnits ↔ IpPlan)', () => {
    const devs = planDevices(ref.project, ref.analysis, ref.plan);
    const byId = new Map(devs.map((d) => [d.id, d.hostname]));
    for (const s of ref.model.switches) expect(byId.get(s.device.id)).toBe(s.hostname);
    for (const x of ref.plan.loopbacks) expect(byId.has(x.deviceId), `plan device ${x.deviceId}`).toBe(true);
  });
});

describe('test kit from the live schedule / plan: η host lists cross the spine', () => {
  for (const [label, L] of [['ib', ref], ['roce', roce]] as const) {
    it(`${label}: single-leaf hosts share one leaf; cross-spine hosts are one node per leaf / pod, so every ring edge leaves its leaf`, () => {
      const files = generateTestPlan(L.project, L.analysis, { locale: 'en', cableSchedule: L.rows, ipPlan: L.plan });
      const m = buildTestKitModel(L.project, L.analysis, L.plan, L.rows);
      const hostfile = (p: string) => (files.find((f) => f.path === p)?.content ?? '').split('\n').filter((l) => l && !l.startsWith('#'));
      expect(hostfile('inventory/hostfiles/single-leaf.txt')).toEqual(m.singleLeaf);
      expect(hostfile('inventory/hostfiles/cross-spine.txt')).toEqual(m.crossSpine);
      const rail = m.nicNames[0];
      const node = new Map(m.nodes.map((n) => [n.hostname, n]));
      const leafOf = (h: string) => node.get(h)?.leafByNic[rail];
      expect(m.singleLeaf.length).toBeGreaterThanOrEqual(2);
      expect(new Set(m.singleLeaf.map(leafOf)).size).toBe(1);
      expect(m.crossSpine.length).toBe(m.singleLeaf.length);
      const leaves = m.crossSpine.map(leafOf);
      expect(leaves.every(Boolean)).toBe(true);
      expect(new Set(leaves).size, 'one node per leaf').toBe(m.crossSpine.length);
      expect(m.crossSpineGroups).toBeGreaterThanOrEqual(2);
      // consecutive hosts (and the ring's wrap-around edge) sit on different leaves → with 2-tier leaf–spine every edge crosses a spine
      for (let i = 0; i < leaves.length; i++) expect(leaves[i], `ring edge ${i}`).not.toBe(leaves[(i + 1) % leaves.length]);
      // leaf hostnames of the kit are switches of the NOS model (same device naming as the configs)
      const swNames = new Set([...L.model.switches.map((s) => s.hostname), ...L.model.ibSwitches.map((d) => d.hostname)]);
      for (const l of leaves) expect(swNames.has(l!), `leaf ${l}`).toBe(true);
      // Ethernet: kit node addresses are the IP plan's host addresses
      if (!m.isIb) {
        // the kit writes host addresses without the prefix length (hostfile / ssh form)
        const ip = new Map(L.plan.hosts.map((h) => [`${h.nodeId}:${h.nic}`, h.ip.replace(/\/\d+$/, '')]));
        const withIp = m.nodes.filter((n) => Object.keys(n.ipByNic).length > 0);
        expect(withIp.length).toBeGreaterThan(0);
        for (const n of withIp) for (const [nic, addr] of Object.entries(n.ipByNic)) expect(ip.get(`${n.id}:${nic}`), `${n.hostname}:${nic}`).toBe(addr.replace(/\/\d+$/, ''));
      }
    });
  }
});

// ───────────── η calibration round trip ─────────────

const hasPython = spawnSync('python3', ['--version']).status === 0;
const kitDir = mkdtempSync(join(tmpdir(), 'aidc-eta-roundtrip-'));
afterAll(() => rmSync(kitDir, { recursive: true, force: true }));

/** nccl-tests stdout for `<coll>_perf -b 1M -e 16G -f 2 -g 1` under NCCL_TESTS_SPLIT="MOD gpn", prefixed with the kit's header line. */
function kitLog(files: GeneratedFile[], o: { scope: 'single-leaf' | 'cross-spine'; coll: 'all_reduce' | 'alltoall'; hosts: string[]; gpn: number; plateau: number }): string {
  const script = files.find((f) => f.path === '30-collectives/eta_mpirun.sh')!.content;
  const echo = /echo "(# AIDC-KIT eta [^"]+)"/.exec(script);
  if (!echo) throw new Error('kit script has no AIDC-KIT header');
  const header = echo[1].replace('${scope}', o.scope).replace('${coll}', o.coll).replace('${GPN}', String(o.gpn)).replace('${N}', String(o.hosts.length));
  const lines = [header, `# nThread 1 nGpus 1 minBytes 1048576 maxBytes 17179869184 step: 2(factor) warmup iters: 5 iters: 20 agg iters: 1 validation: 1 graph: 0`, '#', '# Using devices'];
  let rank = 0;
  for (const h of o.hosts) for (let d = 0; d < o.gpn; d++) lines.push(`#  Rank ${String(rank++).padStart(3)} Group  0 Pid ${String(40000 + rank).padStart(6)} on ${h} device  ${d} [0x0${d}] NVIDIA GB300`);
  lines.push('#', '#                                                              out-of-place                       in-place          ');
  lines.push('#       size         count      type   redop    root     time   algbw   busbw #wrong     time   algbw   busbw #wrong');
  lines.push('#        (B)    (elements)                               (us)  (GB/s)  (GB/s)            (us)  (GB/s)  (GB/s)       ');
  const noise = [0.998, 1.002, 1.0, 0.999, 1.001];
  for (let size = 1 << 20, k = 0; size <= 16 * 1024 ** 3; size *= 2, k++) {
    const big = size >= 1024 ** 3;
    const bus = big ? o.plateau * noise[k % noise.length] : o.plateau * Math.min(1, 0.25 + 0.06 * k);
    const alg = bus / 1.9;
    const fmt = (v: number) => v.toFixed(2).padStart(7);
    lines.push(`${String(size).padStart(12)}  ${String(Math.floor(size / 4)).padStart(12)}     float     sum      -1  ${String(Math.round(size / 1e4)).padStart(7)} ${fmt(alg)} ${fmt(bus)}      0  ${String(Math.round(size / 1e4)).padStart(7)} ${fmt(alg)} ${fmt(bus)}      0`);
  }
  lines.push('# Out of bounds values : 0 OK', `# Avg bus bandwidth    : ${(o.plateau * 0.61).toFixed(4)} `, '#');
  return lines.join('\n') + '\n';
}

describe('η calibration round trip: generated kit log → Network panel path and eta_calibrate.py', () => {
  const files = generateTestPlan(ref.project, ref.analysis, { locale: 'en', cableSchedule: ref.rows, ipPlan: ref.plan });
  const m = buildTestKitModel(ref.project, ref.analysis, ref.plan, ref.rows);
  for (const f of files) {
    mkdirSync(dirname(join(kitDir, f.path)), { recursive: true });
    writeFileSync(join(kitDir, f.path), f.content);
  }
  const compute = findCatalogItem(ref.project.equipment.find((e) => findCatalogItem(e.catalogId)?.category === 'gpu-rack')!.catalogId)!.compute!;
  const nicL8 = m.nicGbps / 8;
  const packedLog = kitLog(files, { scope: 'single-leaf', coll: 'all_reduce', hosts: m.singleLeaf, gpn: m.gpusPerNode, plateau: 0.95 * nicL8 });
  const spreadLog = kitLog(files, { scope: 'cross-spine', coll: 'all_reduce', hosts: m.crossSpine, gpn: m.gpusPerNode, plateau: 0.95 * 0.9 * nicL8 });
  mkdirSync(join(kitDir, 'logs/collectives'), { recursive: true });
  writeFileSync(join(kitDir, 'logs/collectives/all_reduce_single-leaf.log'), packedLog);
  writeFileSync(join(kitDir, 'logs/collectives/all_reduce_cross-spine.log'), spreadLog);

  it('both kit scripts write the header before the tee -a run, and the header states the MOD split and NIC speed', () => {
    for (const p of ['30-collectives/eta_mpirun.sh', '30-collectives/_eta_srun.sh']) {
      const s = files.find((f) => f.path === p)!.content;
      expect(s).toMatch(/echo "# AIDC-KIT eta scope=\$\{scope\} collective=\$\{coll\} split=MOD:\$\{GPN\} nic_gbps=\d+ nics_per_rank=1 nodes=\$\{N\}" > "\$\{OUT\}\/\$\{coll\}_\$\{scope\}\.log"/);
      expect(s).toContain('| tee -a "${OUT}/${coll}_${scope}.log"');
      expect(s).toContain(`NCCL_TESTS_SPLIT`);
    }
    expect(packedLog.split('\n')[0]).toBe(`# AIDC-KIT eta scope=single-leaf collective=all_reduce split=MOD:${m.gpusPerNode} nic_gbps=${m.nicGbps} nics_per_rank=1 nodes=${m.singleLeaf.length}`);
  });

  it('the Network panel path (parseCollectiveLog → nominalInputsFor → calibrateEta) yields η_host 0.95, η_fabric 0.90 and no flags', () => {
    const [spread] = parseCollectiveLog(spreadLog);
    const [packed] = parseCollectiveLog(packedLog);
    expect(spread.kit).toMatchObject({ scope: 'cross-spine', split: m.gpusPerNode, nicGbps: m.nicGbps, nicsPerRank: 1, nodes: m.crossSpine.length });
    expect(spread.collective).toBe('all_reduce');
    expect(spread.nodes).toBe(m.crossSpine.length);
    expect(spread.ranksPerNode).toBe(m.gpusPerNode);
    // what CalibrationBox computes for its default fields
    const d = nominalInputsFor(spread, compute);
    expect(d).toMatchObject({ nicGbps: m.nicGbps, nicsPerNode: 1, ranksPerNode: 1, ranks: m.crossSpine.length, split: m.gpusPerNode });
    const nominal = nominalBusbwGBps({ collective: 'all_reduce', nicGbps: d.nicGbps, nicsPerNode: d.nicsPerNode, ranksPerNode: d.ranksPerNode, ranks: d.ranks });
    expect(nominal).toBeCloseTo(nicL8, 9); // = the kit's η_bus denominator (NIC Gb/s ÷ 8)
    const cal = calibrateEta({ spread, packed, nominalGBps: nominal, measuredAt: '2026-09-15' });
    expect(cal.etaHost).toBeCloseTo(0.95, 3);
    expect(cal.etaFabric).toBeCloseTo(0.9, 3);
    expect(cal.etaTotal).toBeCloseTo(0.855, 3);
    expect(cal.flags).toEqual([]);
    // a non-kit log with the same numbers would have used the node's NICs (r = GPUs per node) — the header is what makes η_host right
    const bare = parseCollectiveLog(spreadLog.split('\n').slice(1).join('\n'))[0];
    expect(bare.kit).toBeUndefined();
    expect(nominalInputsFor(bare, compute).nicsPerNode).toBeGreaterThan(1);

    // applied to the project (panel "적용"): the traffic engine uses η_fabric on the spine tiers and η_host on the NIC
    const p: Project = { ...ref.project, network: { ...ref.project.network, scaleOut: { ...ref.project.network.scaleOut, etaCalibration: cal } } };
    const a = analyzeProject(p);
    expect(a.network.traffic?.eta?.value).toBeCloseTo(0.9, 3);
    expect(a.network.traffic?.eta?.sourceType).toBe('user-measured');
    expect(a.network.traffic?.etaHost).toBeCloseTo(0.95, 3);
  });

  it('flags survive the round trip: a single-leaf run above nominal is not network-bound and blocks the panel', () => {
    const hot = kitLog(files, { scope: 'single-leaf', coll: 'all_reduce', hosts: m.singleLeaf, gpn: m.gpusPerNode, plateau: 1.1 * nicL8 });
    const [spread] = parseCollectiveLog(hot);
    const d = nominalInputsFor(spread, compute);
    const cal = calibrateEta({ spread, nominalGBps: nominalBusbwGBps({ collective: 'all_reduce', ...d }) });
    expect(cal.flags).toContain('not-network-bound');
  });

  it.skipIf(!hasPython)('the kit’s own eta_calibrate.py reads the same logs to the same η_bus / η_fabric', () => {
    const out = spawnSync('python3', [join(kitDir, '30-collectives/eta_calibrate.py'), join(kitDir, 'logs/collectives/all_reduce_single-leaf.log'), join(kitDir, 'logs/collectives/all_reduce_cross-spine.log'), '--nic-gbps', String(m.nicGbps)], { encoding: 'utf8' });
    expect(out.status, out.stderr).toBe(0);
    const r = JSON.parse(out.stdout);
    expect(r.runs['single-leaf'].etaBus).toBeCloseTo(0.95, 3);
    expect(r.runs['cross-spine'].etaBus).toBeCloseTo(0.855, 3);
    expect(r.etaFabric).toBeCloseTo(0.9, 3);
    expect(r.runs['single-leaf'].flags).toEqual([]);
    const [spread] = parseCollectiveLog(spreadLog);
    const [packed] = parseCollectiveLog(packedLog);
    const d = nominalInputsFor(spread, compute);
    const cal = calibrateEta({ spread, packed, nominalGBps: nominalBusbwGBps({ collective: 'all_reduce', ...d }) });
    expect(cal.etaFabric).toBeCloseTo(r.etaFabric, 6);
    expect(cal.etaHost).toBeCloseTo(r.runs['single-leaf'].etaBus, 6);
  });
});
