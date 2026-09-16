// Test-kit model (stream T7): nodes, NIC rails and leaf membership from the cable schedule (T2), hostfile selection for
// the η measurement kit (DECISIONS-v2-2 §C), predictions and acceptance thresholds with source types.
import { findCatalogItem } from '../../catalog/catalog.ts';
import type { CableScheduleRow, IpPlan, LoadBalancing, Project, ProjectAnalysis } from '../../model/types.ts';
import { planDevices, splitEndpoint, type PlanDevice } from '../devices.ts';

export type SourceType = 'measured-paper' | 'vendor-claim' | 'acceptance-threshold' | 'standard' | 'official-config' | 'derived' | 'estimate';

export interface Threshold {
  id: string;
  stage: '00-inventory' | '10-links' | '20-rdma' | '30-collectives' | '40-node' | '50-storage' | '60-thermal-power';
  check: string;
  op: '>=' | '<=' | '==' | 'range' | 'record';
  /** null = no credible published value (shown as such, never invented) */
  value: number | null;
  max?: number;
  unit: string;
  sourceType: SourceType;
  source: string;
  note?: string;
}

export interface KitNode {
  id: string;
  hostname: string;
  rackTag: string;
  podId?: string;
  /** scale-out NIC name → leaf hostname */
  leafByNic: Record<string, string>;
  /** NIC name → address (Ethernet only) */
  ipByNic: Record<string, string>;
}

export interface TestKitModel {
  projectName: string;
  vendor: 'nvidia' | 'amd' | 'other';
  tool: 'nccl-tests' | 'rccl-tests';
  gpuModel: string;
  gpuRackCatalogId?: string;
  gpusPerNode: number;
  /** scale-up (NVLink) domain size — larger than gpusPerNode on NVL72-class racks (multi-node NVLink) */
  scaleUpDomain?: number;
  nicGbps: number;
  nicNames: string[];
  isIb: boolean;
  fabric: string;
  lbClass: LoadBalancing | 'te';
  etaHost: { value: number; sourceType: SourceType; source: string };
  etaFabric: { value: number; sourceType: SourceType; source: string };
  /** predicted plateau busbw (GB/s) of MOD-split runs */
  predicted: { idealGBps: number; singleLeafGBps: number; crossSpineGBps: number };
  nodes: KitNode[];
  singleLeaf: string[];
  crossSpine: string[];
  crossSpineGroups: number;
  bisection: { server: string; client: string }[];
  thresholds: Threshold[];
  racks: { tag: string; designKW: number; catalogId: string }[];
  switches: PlanDevice[];
  expectedLinks: { cableId: string; aDevice: string; aPort: string; bDevice: string; bPort: string }[];
  liquidSupplyMaxC: { value: number | null; sourceType: SourceType; source: string };
  notes: string[];
}

const ETA_FABRIC_DEFAULT: Record<string, { value: number; sourceType: SourceType; source: string }> = {
  ecmp: { value: 0.6, sourceType: 'measured-paper', source: 'Alibaba HPN (SIGCOMM 2024) App. A — static ECMP hash polarisation' },
  'qp-scaling': { value: 0.7, sourceType: 'derived', source: 'Meta RoCE (SIGCOMM 2024) §4.4.1 — 4-QP E-ECMP 1.4× slower than roofline' },
  te: { value: 0.8, sourceType: 'measured-paper', source: 'Meta RoCE (SIGCOMM 2024) §4.4.2 — "TE uniformly utilizes 80% of max bandwidth"' },
  adaptive: { value: 0.95, sourceType: 'vendor-claim', source: 'NVIDIA Spectrum-X white paper — "up to 95 percent effective bandwidth" (also used as the IB AR proxy)' },
  ddc: { value: 1.0, sourceType: 'vendor-claim', source: 'Nominal — no public at-scale measurement (DECISIONS-v2-2 §C); treat as unmeasured' },
};

const nodeHostname = (id: string) => {
  const m = /^(H\d+)\.(.+?)-U\d+:(N\d+)$/.exec(id);
  const raw = m ? `${m[1]}-${m[2]}-${m[3]}` : id;
  return raw.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/(^-|-$)/g, '').slice(0, 63);
};

type RowX = CableScheduleRow & { tier?: string; fabricKey?: string };

export function buildTestKitModel(project: Project, analysis: ProjectAnalysis, plan: IpPlan, rows: CableScheduleRow[], maxRunNodes = 16): TestKitModel {
  const notes: string[] = [];
  const eqById = new Map(project.equipment.map((e) => [e.id, e]));
  const gpuRacks = project.equipment.filter((e) => findCatalogItem(e.catalogId)?.category === 'gpu-rack');
  // dominant GPU rack type
  const counts = new Map<string, number>();
  for (const e of gpuRacks) counts.set(e.catalogId, (counts.get(e.catalogId) ?? 0) + 1);
  const rackId = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  const item = rackId ? findCatalogItem(rackId) : undefined;
  const c = item?.compute;
  const vendorText = `${c?.accelerator?.vendor ?? ''} ${item?.vendor ?? ''} ${c?.gpuModel ?? ''}`.toLowerCase();
  const vendor: TestKitModel['vendor'] = /amd|instinct|mi3\d\d|mi4\d\d/.test(vendorText) ? 'amd' : /nvidia|gb\d00|h100|h200|b200|b300|rubin/.test(vendorText) ? 'nvidia' : 'other';
  if (vendor === 'other') notes.push(`Accelerator vendor of ${item?.name ?? 'the GPU racks'} is neither NVIDIA nor AMD — the nccl-tests commands are a template; use the vendor's collective benchmark and diagnostics.`);
  const gpusPerNode = c?.gpusPerNode ?? Math.max(1, Math.min(8, c?.scaleUp.domainSize || 8));
  const nicGbps = c?.scaleOutPortGbps ?? 400;
  const isIb = project.network.scaleOut.fabric.startsWith('ib-');
  const tr = analysis.network.traffic;
  const lbClass = (tr?.eta?.class ?? project.network.scaleOut.loadBalancing ?? 'ecmp') as TestKitModel['lbClass'];
  const trEta = tr?.eta as (NonNullable<typeof tr>['eta'] & { sourceType?: SourceType }) | undefined;
  const etaFabric = trEta && Number.isFinite(trEta.value)
    ? { value: trEta.value, sourceType: (trEta.sourceType ?? ETA_FABRIC_DEFAULT[lbClass]?.sourceType ?? 'estimate') as SourceType, source: trEta.citation || ETA_FABRIC_DEFAULT[lbClass]?.source || 'traffic engine' }
    : ETA_FABRIC_DEFAULT[lbClass] ?? ETA_FABRIC_DEFAULT.ecmp;
  const etaHost = { value: 0.95, sourceType: 'acceptance-threshold' as SourceType, source: 'η_host default 0.95 — AMD–DriveNets RA measured 0.958; Azure HPC health-check floor 0.95' };
  const idealGBps = nicGbps / 8;
  const predicted = { idealGBps, singleLeafGBps: idealGBps * etaHost.value, crossSpineGBps: idealGBps * etaHost.value * etaFabric.value };

  // ── nodes from scale-out endpoint rows ──
  const devices = planDevices(project, analysis, plan);
  const byTia = new Map(devices.filter((d) => d.tia).map((d) => [d.tia!, d]));
  const ipOf = new Map(plan.hosts.map((h) => [`${h.nodeId}:${h.nic}`, h.ip.replace(/\/\d+$/, '')]));
  const nodes = new Map<string, KitNode>();
  const tagToEq = new Map(project.equipment.map((e) => [e.tag, e]));
  for (const r of rows as RowX[]) {
    const scaleOut = r.fabricKey ? r.fabricKey === 'scale-out' : /^(BE|IB)-/.test(r.cableId);
    const endpoint = r.tier ? r.tier === 'endpoint-leaf' : true;
    if (!scaleOut || !endpoint) continue;
    const from = splitEndpoint(r.fromPort);
    const to = splitEndpoint(r.toPort);
    const leaf = byTia.get(to.device);
    if (!leaf || !from.port || !/:N\d+$/.test(from.device)) continue;
    const rackTag = /^H\d+\.(.+?)-U\d+:N\d+$/.exec(from.device)?.[1] ?? r.fromRack.replace(/^H\d+\./, '');
    const n = nodes.get(from.device) ?? { id: from.device, hostname: nodeHostname(from.device), rackTag, podId: tagToEq.get(rackTag)?.podId, leafByNic: {}, ipByNic: {} };
    n.leafByNic[from.port] = leaf.hostname;
    const ip = ipOf.get(`${from.device}:${from.port}`);
    if (ip) n.ipByNic[from.port] = ip;
    nodes.set(from.device, n);
  }
  let nodeList = [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
  if (!nodeList.length) {
    notes.push('The cable schedule has no scale-out endpoint rows for this project state — nodes are enumerated from the GPU racks and host lists are chosen by deployment unit (pod) instead of by leaf.');
    const perRack = c?.nodesPerRack ?? Math.max(1, Math.round((c?.gpus ?? gpusPerNode) / gpusPerNode));
    nodeList = gpuRacks.flatMap((e) => Array.from({ length: perRack }, (_, i) => {
      const id = `${e.tag}:N${String(i + 1).padStart(2, '0')}`;
      return { id, hostname: nodeHostname(`H1.${e.tag}-U0:N${String(i + 1).padStart(2, '0')}`), rackTag: e.tag, podId: e.podId, leafByNic: { be0: e.podId ?? e.tag }, ipByNic: {} };
    }));
  }
  const nicNames = [...new Set(nodeList.flatMap((n) => Object.keys(n.leafByNic)))].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const firstNic = nicNames[0] ?? 'be0';

  // single-leaf baseline: the leaf (of the first rail) with the most nodes
  const byLeaf = new Map<string, KitNode[]>();
  for (const n of nodeList) {
    const leaf = n.leafByNic[firstNic] ?? n.podId ?? n.rackTag;
    byLeaf.set(leaf, [...(byLeaf.get(leaf) ?? []), n]);
  }
  const leafGroups = [...byLeaf.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], 'en', { numeric: true }));
  const singleLeaf = (leafGroups[0]?.[1] ?? []).slice(0, maxRunNodes).map((n) => n.hostname);
  if (singleLeaf.length < 2) notes.push('Fewer than 2 nodes share a leaf — the single-leaf baseline cannot run; η_fabric needs a baseline.');
  // cross-spine: interleave one node per leaf group so every ring edge leaves the leaf (equal node count to the baseline)
  const groups = [...byLeaf.entries()].sort((a, b) => a[0].localeCompare(b[0], 'en', { numeric: true })).map(([, ns]) => ns);
  const target = Math.max(2, Math.min(maxRunNodes, singleLeaf.length || maxRunNodes));
  const crossSpine: string[] = [];
  for (let round = 0; crossSpine.length < target && groups.length > 1; round++) {
    let added = false;
    for (const g of groups) {
      if (crossSpine.length >= target) break;
      if (g[round]) {
        crossSpine.push(g[round].hostname);
        added = true;
      }
    }
    if (!added) break;
  }
  if (groups.length < 2) notes.push('All nodes sit on one leaf of the first rail — there is no cross-spine path to measure; η_fabric = 1 by topology.');
  // polish v2 2차 (QA network m6): the kit asks for N ≥ 8 nodes per scope so the plateau reflects the fabric, not a few hosts
  const smallScopes = [['single-leaf', singleLeaf.length], ['cross-spine', crossSpine.length]].filter(([, n]) => (n as number) >= 2 && (n as number) < 8);
  if (smallScopes.length) notes.push(`η kit hostfiles below the recommended 8 nodes: ${smallScopes.map(([k, n]) => `${k} ${n}`).join(', ')} — the measured plateau may not represent the fabric at scale; add nodes or treat η as indicative.`);
  // bisection pairs: node i of the first half of the leaf groups ↔ node i of the second half
  const half = Math.floor(groups.length / 2);
  const A = groups.slice(0, half).flat();
  const B = groups.slice(half).flat();
  const bisection = Array.from({ length: Math.min(maxRunNodes, A.length, B.length) }, (_, i) => ({ server: B[i].hostname, client: A[i].hostname }));

  // ── thresholds ──
  const gm = (c?.gpuModel ?? item?.name ?? '').toUpperCase();
  const amdBar = /MI35\dX|MI355X|MI350X/.test(gm) ? 350 : /MI30\dX|MI325X|MI300X/.test(gm) ? 304 : null;
  const T: Threshold[] = [
    { id: 'inventory.devices', stage: '00-inventory', check: 'GPU / NIC count, link speed, firmware and NIC↔GPU affinity match the plan', op: '==', value: gpusPerNode, unit: 'GPUs per node', sourceType: 'derived', source: 'Project plan (catalog node spec)' },
    { id: 'links.lldp-match', stage: '10-links', check: 'LLDP neighbours equal the cable schedule', op: '>=', value: 100, unit: '%', sourceType: 'derived', source: 'NVIDIA Cabling Data Centers DU-10438 §5.2.1 (cables connected per the point-to-point map)' },
    { id: 'links.reach', stage: '10-links', check: 'Cable run below 90 % of the media reach', op: '<=', value: 90, unit: '% of reach', sourceType: 'acceptance-threshold', source: 'NVIDIA DU-10438 — "Keep cable runs less than 90% of the max distance"' },
    { id: 'links.error-deltas', stage: '10-links', check: 'CRC / symbol / link-down counter deltas during a 10-min soak', op: '<=', value: 0, unit: 'events', sourceType: 'estimate', source: 'AIDC Studio default' },
    { id: 'links.flap', stage: '10-links', check: 'Link flap (≈5 % of ports down 5 s over 10 min): post-flap throughput vs pre-flap', op: '>=', value: 0.95, unit: '× pre-flap', sourceType: 'acceptance-threshold', source: 'AMD–DriveNets RA §11.2 (no observable degradation) + AIDC Studio 0.95 bar (estimate)' },
  ];
  if (vendor === 'amd') {
    T.push(
      { id: 'rdma.gpu-nic-loopback', stage: '20-rdma', check: 'ib_write_bw GPU → adjacent NIC loopback, every path', op: '>=', value: nicGbps === 400 ? 390 : null, unit: 'Gb/s', sourceType: 'acceptance-threshold', source: 'AMD Customer Acceptance Guide — network/rdma-benchmarking ("390 Gbps or greater")', note: nicGbps === 400 ? undefined : 'AMD publishes this value for 400G NICs only' },
      { id: 'rdma.nic-switch-nic-bidir', stage: '20-rdma', check: 'ib_write_bw NIC → switch → NIC, bidirectional', op: '>=', value: nicGbps === 400 ? 770 : null, unit: 'Gb/s', sourceType: 'acceptance-threshold', source: 'AMD Customer Acceptance Guide — network/rdma-benchmarking ("770 Gbps or greater")', note: nicGbps === 400 ? undefined : 'AMD publishes this value for 400G NICs only' },
      { id: 'collectives.two-node-allreduce', stage: '30-collectives', check: 'RCCL all_reduce busbw, two-node cluster', op: '>=', value: amdBar, unit: 'GB/s', sourceType: 'acceptance-threshold', source: 'AMD Customer Acceptance Guide — network/validation (304 GB/s MI300X · 350 GB/s MI350X/MI355X)', note: amdBar === null ? `No AMD value published for ${c?.gpuModel ?? 'this GPU'}` : undefined },
      { id: 'collectives.soak', stage: '30-collectives', check: 'Multi-node RCCL on the full cluster', op: '>=', value: 10, unit: 'h without errors', sourceType: 'acceptance-threshold', source: 'AMD Customer Acceptance Guide (multi-node RCCL 10 h)' },
      { id: 'node.rccl-single-node', stage: '40-node', check: 'Single-node all_reduce in-place busbw at 8 GB', op: '>=', value: amdBar, unit: 'GB/s', sourceType: 'acceptance-threshold', source: 'AMD Customer Acceptance Guide — common/rccl-benchmarking', note: amdBar === null ? `No AMD value published for ${c?.gpuModel ?? 'this GPU'}` : undefined },
      { id: 'node.agfhc', stage: '40-node', check: 'AGFHC minimum sequence PASS', op: '>=', value: 14.67, unit: 'h (duration)', sourceType: 'acceptance-threshold', source: 'AMD Customer Acceptance Guide — testing overview (14 h 40 min minimum sequence)' },
    );
  } else {
    T.push(
      { id: 'rdma.nic-switch-nic', stage: '20-rdma', check: 'ib_write_bw average per rail pair through the fabric', op: '>=', value: Math.round(nicGbps * 0.95), unit: 'Gb/s', sourceType: 'derived', source: 'Azure HPC health checks check_ib_bw_gdr 380 Gb/s on 400G NDR (0.95 × line rate), scaled to this NIC' },
      { id: 'collectives.single-leaf', stage: '30-collectives', check: 'Plateau busbw, single-leaf baseline (MOD split)', op: '>=', value: round2(predicted.singleLeafGBps * 0.9), unit: 'GB/s', sourceType: 'derived', source: 'Assumption: tool-predicted busbw × 0.9 — NVIDIA publishes no acceptance value; nccl-tests itself flags < 0.9 × expected' },
      { id: 'collectives.cross-spine', stage: '30-collectives', check: 'Plateau busbw, cross-spine run (MOD split)', op: '>=', value: round2(predicted.crossSpineGBps * 0.9), unit: 'GB/s', sourceType: 'derived', source: 'Assumption: tool-predicted busbw × 0.9 (predicted = NIC GB/s × η_host × η_fabric)' },
      { id: 'node.dcgm-diag-r3', stage: '40-node', check: 'dcgmi diag -r 3 PASS on every GPU (8-GPU run < 35 min)', op: '==', value: 1, unit: 'pass', sourceType: 'vendor-claim', source: 'NVIDIA DCGM diagnostics user guide' },
    );
  }
  const arClass = lbClass === 'adaptive' || lbClass === 'ddc';
  T.push(
    { id: 'eta.bus-cross-spine', stage: '30-collectives', check: 'η_bus (cross-spine plateau busbw ÷ NIC GB/s)', op: '>=', value: 0.9, unit: 'ratio', sourceType: 'derived', source: 'nccl-tests 0.9 × expected rule and the ≈0.98 RoCE header ceiling' },
    { id: 'eta.fabric', stage: '30-collectives', check: 'η_fabric = cross-spine η_bus ÷ single-leaf η_bus', op: arClass ? '>=' : 'record', value: arClass ? 0.95 : null, unit: 'ratio', sourceType: 'vendor-claim', source: arClass ? 'NVIDIA Spectrum-X "up to 95 %" effective bandwidth; 98 % bisection claim' : `Record only for ${lbClass} fabrics (≈${etaFabric.value} expected; ${etaFabric.source})` },
    { id: 'collectives.alltoall', stage: '30-collectives', check: 'alltoall busbw vs NIC line rate per rank', op: '>=', value: 0.85, unit: '× line rate', sourceType: 'derived', source: 'DriveNets RA measured ≈90 % (amd-drivenets.md); 0.85 bar' },
    { id: 'collectives.isolation', stage: '30-collectives', check: 'Cross-spine busbw delta with background noise', op: '<=', value: 5, unit: '%', sourceType: 'estimate', source: 'AIDC Studio default (DriveNets RA §11.1: curves overlap)' },
    { id: 'collectives.pfc-pause-share', stage: '30-collectives', check: 'rx_prio3_pause_duration share of run time per NIC', op: '<=', value: isIb ? null : 1, unit: '%', sourceType: 'estimate', source: isIb ? 'Not applicable (InfiniBand)' : 'AIDC Studio default' },
    { id: 'storage.throughput', stage: '50-storage', check: 'fio / IOR / mdtest vs vendor-committed values', op: '>=', value: 0.9, unit: '× committed', sourceType: 'estimate', source: 'AIDC Studio default' },
    { id: 'thermal.inlet-air', stage: '60-thermal-power', check: 'Server air inlet temperature', op: 'range', value: 18, max: 27, unit: '°C', sourceType: 'standard', source: 'ASHRAE TC 9.9 recommended envelope — standard text not fetched' },
    { id: 'power.rack-kw', stage: '60-thermal-power', check: 'Measured rack kW at 100 % load ≤ design kW and ≥ 0.8 × design', op: 'range', value: 0.8, max: 1, unit: '× design kW', sourceType: 'estimate', source: 'AIDC Studio default' },
    { id: 'power.psu-capacity', stage: '60-thermal-power', check: 'PSU InputPowerWatts ≤ PowerCapacityWatts', op: '<=', value: 1, unit: '× capacity', sourceType: 'derived', source: 'DMTF Redfish PowerSupply / PowerSupplyMetrics schemas' },
  );
  const liquidSupplyMaxC = /GB300|GB200/.test(gm) || /gb300|gb200/.test(rackId ?? '')
    ? { value: 45, sourceType: 'vendor-claim' as SourceType, source: 'NVIDIA GB300 liquid supply ≤ 45 °C' }
    : /MI355X/.test(gm) || /mi355x/.test(rackId ?? '')
      ? { value: 43, sourceType: 'vendor-claim' as SourceType, source: 'AMD MI355X liquid supply ≤ 43 °C (amd-dc-design.md §8)' }
      : { value: null, sourceType: 'vendor-claim' as SourceType, source: 'No published liquid supply limit in the research notes for this rack type' };
  T.push({ id: 'thermal.liquid-supply', stage: '60-thermal-power', check: 'Liquid supply temperature', op: '<=', value: liquidSupplyMaxC.value, unit: '°C', sourceType: liquidSupplyMaxC.sourceType, source: liquidSupplyMaxC.source });

  const racks = gpuRacks.map((e) => ({ tag: e.tag, catalogId: e.catalogId, designKW: Math.round((findCatalogItem(e.catalogId)?.power?.nameplateKW ?? 0) * (e.loadFactor ?? 1) * 10) / 10 }));
  const switchIds = new Set(devices.map((d) => d.tia).filter(Boolean));
  const expectedLinks = rows
    .filter((r) => switchIds.has(splitEndpoint(r.fromPort).device) || switchIds.has(splitEndpoint(r.toPort).device))
    .map((r) => {
      const a = splitEndpoint(r.fromPort), b = splitEndpoint(r.toPort);
      const name = (d: string) => byTia.get(d)?.hostname ?? (/:N\d+$/.test(d) ? nodeHostname(d) : d);
      return { cableId: r.cableId, aDevice: name(a.device), aPort: a.port ?? '', bDevice: name(b.device), bPort: b.port ?? '' };
    });
  void eqById;
  return {
    projectName: project.name, vendor, tool: vendor === 'amd' ? 'rccl-tests' : 'nccl-tests', gpuModel: c?.gpuModel ?? item?.name ?? '-', gpuRackCatalogId: rackId,
    gpusPerNode, scaleUpDomain: c?.scaleUp.domainSize, nicGbps, nicNames: nicNames.length ? nicNames : ['be0'], isIb, fabric: project.network.scaleOut.fabric, lbClass, etaHost, etaFabric, predicted,
    nodes: nodeList, singleLeaf, crossSpine, crossSpineGroups: groups.length, bisection, thresholds: T, racks, switches: devices, expectedLinks, liquidSupplyMaxC, notes,
  };
}

function round2(v: number) {
  return Math.round(v * 100) / 100;
}
