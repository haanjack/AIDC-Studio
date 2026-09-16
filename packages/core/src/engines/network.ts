import { cableTypes, findCatalogItem } from '../catalog/catalog.ts';
import { switchesPerNetworkRack } from '../layout/estimates.ts';
import { detectRowGroups } from '../layout/rows.ts';
import { trunkSleeveSpot } from '../layout/trunkSleeves.ts';
import { manhattan } from '../model/geometry.ts';
import type {
  CableRun,
  CableTray,
  CableType,
  CatalogItem,
  ClusterDef,
  ClusterNetworkSummary,
  EtaCalibration,
  EtaSourceType,
  FabricAnalysis,
  FabricTech,
  FabricTopology,
  LoadBalancing,
  NetworkAnalysis,
  NetworkRackLoad,
  NetworkTier,
  Project,
  ScaleOutNetwork,
  SpecSource,
  Vec2,
} from '../model/types.ts';
import { resolveClusters, zoneHallOf } from './cluster.ts';
import { buildContext, cableUnitUSD, clamp, type Ctx, distribute, FACILITY_ENDPOINT_CATEGORIES, itemPriceUSD, type Placed, podKey, siteXY } from './context.ts';
import { ETA_HOST_SOURCE, etaSourceFor, NOMINAL_RANK_ETA, specSourceOfEta } from './eta.ts';
import { railsForDomain, sizeFabricFromPodPorts } from './radix.ts';

/**
 * Network fabrics, switch placement and structured cabling.
 *
 * Sizing (per fabric, radix k, leaf oversubscription o = down:up):
 *   leaf downlinks d = floor(k·o/(o+1)), uplinks u = k − d  (mgmt switches: d = k, dedicated uplinks)
 *   leaves per pod   = rails · ceil(ports / rails / d)   (rail-optimized scale-out)  |  ceil(ports / d)
 *   2-tier feasible  ⇔ L ≤ k;  spines S = ceil(L·u / k)
 *   3-tier fat tree: P = floor(k/2) leaves per network pod, spines = pods · u, cores = ceil(spines·P / k)
 *   endpoint ports faster than the switch are broken out (800G NIC → 2 × 400G links); slower endpoints use breakout cables.
 *   DDC (DriveNets FSE, AMD–DriveNets RA Table 11/12): NCP = ceil(endpoints800 / 18) per pod for 800G endpoints (Table 11) and
 *   ceil(endpoints400 / 32) for 400G endpoints (Table 12, TOR-aligned; 36 only rail-optimized), NCF count from the base cluster row
 *   whose endpoint count covers the design (AI-108 … AI-4608-800 → 1/2/5/10/20/40; min AI-216-800 for 400G endpoints), extrapolated
 *   as ceil(NCP·20/128) beyond the largest validated cluster and infeasible past 256 NCP / 40 NCF (2-tier FSE cap; 3-tier not in RA).
 *
 * Placement (PROPOSAL-v2 §3.2 — `network.scaleOut.leafPlacement` / `spinePlacement` are honoured here):
 *   leaves   → network racks of their pod ('mid-row' / 'end-of-row' differ only in the geometry the layout engine produced);
 *              'tor' → spare U-space of HGX-type compute racks (gpusPerNode present, scale-up domain ≤ node) — NVL72 racks fall
 *              back to the pod network racks ('mid-row').
 *   spines   → 'distributed': racks tagged networkRole 'scale-out-spine' inside compute pods, every leaf's uplinks spread over ALL
 *              of them (2-tier: the spine is the hall-shared tier); 'central-end' / 'central-center' / 'separate-room': racks of the
 *              network-core / services rows (RowGroup kind 'network-core' when the layout engine emits rows, else non-compute pods).
 *
 * Cable length (single model shared by BOM, comparator and fabric comparison): `cableLengthM(project, a, b, trays?)` routes along the
 *   tray graph (rack → nearest tray, row tray → main tray, vertical rise/drop, slack per end) when `project.trays` (or `trays`) exists,
 *   otherwise the Manhattan approximation (route factor + vertical + slack).
 *
 * Collective efficiency vs an ideal non-blocking IB XDR fabric (legacy scalar, kept for the fabric comparison table):
 *   eff = tech · topology · 1/(1 + α·(o − 1)) · (1 − 0.01·(maxHops − 3)) · min(1, linkGbps·lanes / nicGbps)
 *   tech: IB XDR 1.00, IB NDR 0.97, Spectrum-X 800G 0.95 / 400G 0.93, generic RoCE 0.80, plain Ethernet ≤ 0.78,
 *         DriveNets FSE 0.97 (ESTIMATE — the RA measures ESE only), DriveNets ESE + UEC NIC 0.90 (estimate from the RA's ≈90 % of
 *         NIC line rate all-to-all)
 *   topology: rail-optimized 1.00, fat-tree 0.98, leaf-spine 0.96;  α = 0.2 (rail-optimized) / 0.35
 *   The workload-driven traffic engine (engines/traffic.ts) supersedes this scalar with `TrafficReport.commEfficiencyEffective`.
 */

export const FABRIC_LABEL: Record<FabricTech, string> = {
  'ib-xdr-800': 'InfiniBand XDR 800G (Quantum-X800)',
  'ib-ndr-400': 'InfiniBand NDR 400G (Quantum-2)',
  'spectrumx-800': 'Spectrum-X Ethernet 800G (RoCE)',
  'spectrumx-400': 'Spectrum-X Ethernet 400G (RoCE)',
  'roce-generic-400': 'Generic RoCEv2 Ethernet 400G',
  'roce-generic-800': 'Generic RoCEv2 Ethernet 800G',
  'ethernet-400': 'Ethernet 400G',
  'ethernet-200': 'Ethernet 200G',
  'ethernet-100': 'Ethernet 100G',
  'ethernet-1g': '1GbE',
  'drivenets-fse': 'DriveNets FSE DDC 800G (5300R NCP + 9300F NCF)',
  'ese-uec-400': 'DriveNets ESE Ethernet 400G + UEC NIC (TH5)',
};

export const FABRIC_TECH_FACTOR: Record<FabricTech, number> = {
  'ib-xdr-800': 1.0,
  'ib-ndr-400': 0.97,
  'spectrumx-800': 0.95,
  'spectrumx-400': 0.93,
  'roce-generic-400': 0.8,
  'roce-generic-800': 0.82, // estimate — generic 400 + the Spectrum-X 800-vs-400 delta (0.95 − 0.93)
  'ethernet-400': 0.78,
  'ethernet-200': 0.75,
  'ethernet-100': 0.7,
  'ethernet-1g': 0.3,
  'drivenets-fse': 0.97, // estimate — no FSE measurement in the AMD–DriveNets RA (review-pdf-amd-drivenets.md #6)
  'ese-uec-400': 0.9, // estimate — RA ESE all-to-all ≈ 90 % of NIC line rate (2500S + Pollara)
};

/** Default switch model per fabric technology. */
export const FABRIC_SWITCH: Record<FabricTech, string> = {
  'ib-xdr-800': 'nvidia-q3400',
  'ib-ndr-400': 'nvidia-qm9700',
  'spectrumx-800': 'nvidia-sn5600',
  'spectrumx-400': 'nvidia-sn5400',
  // stream C (P3, NW-04): generic Ethernet fabrics default to generic switch classes (51.2T 128 × 400G; 48 × 1G OOB); IB, Spectrum-X and DDC
  // fabrics are vendor fabric technologies and keep their vendor instance
  'ethernet-400': 'generic-roce-400',
  'roce-generic-400': 'generic-roce-400',
  'roce-generic-800': 'generic-roce-800',
  'ethernet-200': 'generic-roce-400',
  'ethernet-100': 'generic-roce-400',
  'ethernet-1g': 'switch-oob-1g-48',
  'drivenets-fse': 'drivenets-5300r',
  'ese-uec-400': 'drivenets-2500s',
};

/** Spine-tier switch for fabrics whose leaf and spine boxes differ (DDC: NCP leaf, NCF spine). */
export const FABRIC_SPINE_SWITCH: Partial<Record<FabricTech, string>> = {
  'drivenets-fse': 'drivenets-9300f',
};

/** Load-balancing class per fabric (PROPOSAL-v2 §3.3): IB adaptive routing, Spectrum-X packet spraying, UEC spraying, DDC cells. */
export const FABRIC_LB_DEFAULT: Record<FabricTech, LoadBalancing> = {
  'ib-xdr-800': 'adaptive',
  'ib-ndr-400': 'adaptive',
  'spectrumx-800': 'adaptive',
  'spectrumx-400': 'adaptive',
  'roce-generic-400': 'ecmp',
  'roce-generic-800': 'ecmp',
  'ethernet-400': 'ecmp',
  'ethernet-200': 'ecmp',
  'ethernet-100': 'ecmp',
  'ethernet-1g': 'ecmp',
  'drivenets-fse': 'ddc',
  'ese-uec-400': 'adaptive',
};

/**
 * Load-balancing efficiency η_fabric defaults per class — sourced values only (engines/eta.ts ETA_SOURCES; r2-eta.md §3; DECISIONS-v2-2 §C):
 *  - ecmp 0.60 measured-paper (Alibaba HPN App. A; NVIDIA's "60 percent" corroborates) · qp-scaling 0.70 measured-paper (Meta SIGCOMM'24
 *    §4.4.1) · te 0.80 measured-paper (Meta §4.4.2) · adaptive 0.95 vendor-claim (Spectrum-X white paper; IB AR uses the same proxy with an
 *    "unmeasured" badge) · ddc 1.0 nominal (no FSE measurement) — computed and ranked at NOMINAL_RANK_ETA 0.95.
 * `value` here is the number the engine computes with; `nominalValue` carries the unmeasured 1.0.
 */
const etaDefaultOf = (cls: LoadBalancing): { value: number; source: SpecSource; citation: string; sourceType: EtaSourceType; nominalValue?: number } => {
  const s = etaSourceFor(cls);
  if (!s) return { value: NOMINAL_RANK_ETA, nominalValue: 1, source: 'estimate', citation: 'Nominal · unmeasured — no published η for this load-balancing class', sourceType: 'nominal' };
  const nominal = s.sourceType === 'nominal';
  return { value: nominal ? NOMINAL_RANK_ETA : s.value, ...(nominal ? { nominalValue: s.value } : {}), source: specSourceOfEta(s.sourceType), citation: s.citation, sourceType: s.sourceType };
};
export const ETA_DEFAULT: Record<LoadBalancing, { value: number; source: SpecSource; citation: string; sourceType: EtaSourceType; nominalValue?: number }> = {
  ecmp: etaDefaultOf('ecmp'),
  'qp-scaling': etaDefaultOf('qp-scaling'),
  te: etaDefaultOf('te'),
  adaptive: etaDefaultOf('adaptive'),
  ddc: etaDefaultOf('ddc'),
};

export const LB_LABEL: Record<LoadBalancing, string> = {
  ecmp: 'Static ECMP (1 QP)',
  'qp-scaling': 'E-ECMP + QP scaling',
  te: 'Centralised traffic engineering (TE)',
  adaptive: 'Adaptive routing / packet spraying',
  ddc: 'Cell-scheduled DDC (VOQ)',
};

/** v1 projects may still carry the old placement literals (contract mapping: same semantics). */
const LEAF_LEGACY: Record<string, ScaleOutNetwork['leafPlacement']> = { 'end-of-row': 'end-of-row', 'middle-of-row': 'mid-row', centralized: 'end-of-row', 'mid-row': 'mid-row', tor: 'tor' };
const SPINE_LEGACY: Record<string, ScaleOutNetwork['spinePlacement']> = { centralized: 'central-end', 'per-hall': 'distributed', 'central-end': 'central-end', 'central-center': 'central-center', distributed: 'distributed', 'separate-room': 'separate-room' };
export const normalizeLeafPlacement = (v: string | undefined): ScaleOutNetwork['leafPlacement'] => LEAF_LEGACY[v ?? ''] ?? 'end-of-row';
export const normalizeSpinePlacement = (v: string | undefined): ScaleOutNetwork['spinePlacement'] => SPINE_LEGACY[v ?? ''] ?? 'central-end';

/** η in use for a scale-out design, with its provenance (the traffic engine, the panel badge and the documents read this). */
export interface EtaInUse {
  /** η_fabric the engine computes with on spine / core tiers */
  value: number;
  class: LoadBalancing;
  source: SpecSource;
  sourceType: EtaSourceType;
  citation: string;
  url?: string;
  conditions?: string;
  /** true when the value comes from the user (measured calibration or typed override) */
  overridden: boolean;
  /** unmeasured nominal value (1.0) when `value` is the rank lower bound */
  nominalValue?: number;
  measuredAt?: string;
  /** η_host — NIC busbw factor */
  host: number;
  hostSourceType: EtaSourceType;
  hostCitation: string;
  /** η for expert-parallel all-to-all when an alltoall calibration is stored */
  a2a?: number;
}

/**
 * Effective load-balancing class and η for a scale-out design. Precedence (DECISIONS-v2-2 §C / stream T2):
 *   etaCalibration (user-measured, η_fabric of a pasted cross-spine log) > etaOverride (typed) > sourced class default (ETA_SOURCES) >
 *   nominal 1.0 (computed at the 0.95 lower bound). η_host = the calibration's measured host factor, else ETA_HOST_SOURCE (0.95).
 */
export function etaFor(so: Pick<ScaleOutNetwork, 'fabric' | 'loadBalancing' | 'etaOverride' | 'etaCalibration' | 'etaCalibrationA2a'>): EtaInUse {
  const cls = so.loadBalancing ?? FABRIC_LB_DEFAULT[so.fabric] ?? 'ecmp';
  const d = ETA_DEFAULT[cls] ?? etaDefaultOf(cls);
  const hostDefault = { host: ETA_HOST_SOURCE.value, hostSourceType: ETA_HOST_SOURCE.sourceType, hostCitation: ETA_HOST_SOURCE.citation };
  const fabricOf = (c: EtaCalibration | undefined) => (c ? (c.etaFabric ?? c.eta) : 0);
  const a2aCal = so.etaCalibrationA2a;
  const a2a = a2aCal && Number.isFinite(fabricOf(a2aCal)) && fabricOf(a2aCal) > 0 ? { a2a: clamp(fabricOf(a2aCal), 0.05, 1) } : {};
  const cal = so.etaCalibration;
  if (cal && Number.isFinite(fabricOf(cal)) && fabricOf(cal) > 0) {
    const m = cal.measurement;
    const measuredHost = cal.packed && cal.etaHost !== undefined;
    return {
      value: clamp(fabricOf(cal), 0.05, 1),
      class: cls,
      source: 'user',
      sourceType: 'user-measured',
      citation: `Measured on site — ${m.tool} ${m.collective}${m.ranks ? `, ${m.ranks} ranks` : ''}${m.nodes ? ` / ${m.nodes} nodes` : ''}${cal.measuredAt ? `, ${cal.measuredAt}` : ''}: ${cal.basis}`,
      conditions: `Replaces the class default ${d.value} (${d.sourceType}: ${d.citation}).`,
      overridden: true,
      ...(cal.measuredAt ? { measuredAt: cal.measuredAt } : {}),
      host: clamp(cal.etaHost ?? ETA_HOST_SOURCE.value, 0.05, 1),
      hostSourceType: measuredHost ? 'user-measured' : ETA_HOST_SOURCE.sourceType,
      hostCitation: measuredHost ? 'Measured single-leaf busbw ÷ nominal (pasted packed log)' : ETA_HOST_SOURCE.citation,
      ...a2a,
    };
  }
  const ov = so.etaOverride;
  if (ov != null && Number.isFinite(ov) && ov > 0) {
    return { value: clamp(ov, 0.05, 1), class: cls, source: 'user', sourceType: 'user', citation: `User-entered η (class default ${d.value}: ${d.citation})`, overridden: true, ...hostDefault, ...a2a };
  }
  const s = etaSourceFor(cls, so.fabric);
  if (s) {
    const nominal = s.sourceType === 'nominal';
    return { value: nominal ? NOMINAL_RANK_ETA : s.value, class: cls, source: specSourceOfEta(s.sourceType), sourceType: s.sourceType, citation: s.citation, ...(s.url ? { url: s.url } : {}), conditions: s.conditions, overridden: false, ...(nominal ? { nominalValue: s.value } : {}), ...hostDefault, ...a2a };
  }
  return { value: NOMINAL_RANK_ETA, class: cls, source: 'estimate', sourceType: 'nominal', citation: 'Nominal · unmeasured — no published η for this load-balancing class', conditions: `Computed and ranked at the ${NOMINAL_RANK_ETA} lower bound; paste a cross-spine log to replace it.`, overridden: false, nominalValue: 1, ...hostDefault, ...a2a };
}

// ───────────── DDC (DriveNets FSE) ─────────────

/** AMD–DriveNets System RA Table 11 (validated 2-tier FSE base clusters). endpoints = 800G endpoints. */
export const DDC_TABLE: { name: string; endpoints800: number; ncf: number; ncp: number }[] = [
  { name: 'AI-108-800', endpoints800: 108, ncf: 1, ncp: 6 },
  { name: 'AI-216-800', endpoints800: 216, ncf: 2, ncp: 12 },
  { name: 'AI-576-800', endpoints800: 576, ncf: 5, ncp: 32 },
  { name: 'AI-1152-800', endpoints800: 1152, ncf: 10, ncp: 64 },
  { name: 'AI-2304-800', endpoints800: 2304, ncf: 20, ncp: 128 },
  { name: 'AI-4608-800', endpoints800: 4608, ncf: 40, ncp: 256 },
];
const NCP_NET_PORTS = 18;
const NCP_FABRIC_PORTS = 20;
const NCF_PORTS = 128;
/** 800G network ports an NCP populates with 400G endpoints in the TOR-aligned Table 12 designs (32 × 400G = 16 of 18; RA Fig 20 "32/36") */
const NCP_NET_PORTS_TOR_400 = 16;
/** 2-tier FSE cap: one 400G lane per NCP–NCF pair → NCP ≤ 2 × NCF ports (256), NCF ≤ 2 × NCP fabric ports (40) */
export const DDC_MAX_NCP = 2 * NCF_PORTS;
export const DDC_MAX_NCF = 2 * NCP_FABRIC_PORTS;

export interface DdcSizing {
  ncp: number;
  ncf: number;
  /** RA base cluster the NCF count was read from (absent beyond AI-4608-800) */
  base?: string;
  /** false beyond the largest validated base cluster — the NCF count is an extrapolation */
  withinRA: boolean;
  /** false when the 2-tier FSE cap (256 NCP / 40 NCF) is exceeded — a 3-tier FSE is not sized in the RA */
  feasible: boolean;
}

export interface DdcOptions {
  /** endpoint (NIC) speed; 400G endpoints follow Table 12 (32 × 400G per NCP), 800G endpoints Table 11 (18 × 800G per NCP) */
  endpointGbps?: number;
  /** rail-optimized full population: 36 × 400G per NCP (only the RA's 9,216-endpoint row; default false = TOR-aligned) */
  railOptimized?: boolean;
}

/**
 * DDC sizing (review-pdf-amd-drivenets.md corrections #2/#3, QA-network-v2 #1/#2): pick the base cluster whose endpoint count
 * covers the design and keep its NCF count; NCPs = ceil(endpoints800 / 18) for 800G endpoints (Table 11) and ceil(endpoints400 / 32)
 * for 400G endpoints (Table 12, TOR-aligned; 36 per NCP only for rail-optimized full population). Table 12 designs never use
 * AI-108-800 — the minimum base for 400G endpoints is AI-216-800 (2 NCF). Beyond AI-4608-800 the 2-tier FSE (20 fabric ports per
 * NCP, 1 × 400G lane per NCP–NCF pair) is extrapolated as NCF = ceil(NCP·20/128) with `withinRA: false`, and `feasible` turns false
 * past 256 NCP / 40 NCF (physical cap of a 2-tier FSE; a 3-tier FSE is not sized in the RA).
 */
export function sizeDdc(endpoints800: number, netPorts = NCP_NET_PORTS, fabricPorts = NCP_FABRIC_PORTS, ncfPorts = NCF_PORTS, opts: DdcOptions = {}): DdcSizing {
  if (endpoints800 <= 0) return { ncp: 0, ncf: 0, withinRA: true, feasible: true };
  const ep400 = (opts.endpointGbps ?? 800) < 800;
  const perNcp = ep400 && !opts.railOptimized ? Math.min(netPorts, NCP_NET_PORTS_TOR_400) : netPorts;
  const ncp = Math.ceil(endpoints800 / perNcp - 1e-9);
  const maxNcp = 2 * ncfPorts;
  const maxNcf = 2 * fabricPorts;
  const minRow = ep400 ? 1 : 0;
  const rowIdx = DDC_TABLE.findIndex((r) => r.endpoints800 >= endpoints800 - 1e-9);
  const row = rowIdx >= 0 ? DDC_TABLE[Math.max(rowIdx, minRow)] : undefined;
  if (row && netPorts === NCP_NET_PORTS && fabricPorts === NCP_FABRIC_PORTS && ncfPorts === NCF_PORTS) return { ncp, ncf: row.ncf, base: row.name, withinRA: true, feasible: ncp <= maxNcp };
  const ncf = Math.max(1, Math.ceil((ncp * fabricPorts) / ncfPorts - 1e-9));
  return { ncp, ncf, withinRA: false, feasible: ncp <= maxNcp && ncf <= maxNcf };
}

/**
 * Fallback switch specs used only when the catalog (S3 seeds) does not carry the id. Values from the AMD–DriveNets System RA
 * (Table 5/9/10: port counts, RU, typical/max W w/o optics) — vendor-datasheet; prices are estimates.
 */
const FALLBACK_SWITCH: Record<string, CatalogItem> = {
  'drivenets-5300r': {
    id: 'drivenets-5300r', category: 'switch', vendor: 'DriveNets / UfiSpace', model: 'NCP 5300R', name: 'DriveNets 5300R NCP (18 + 20 × 800G)',
    description: 'DDC leaf (Network Cloud Packet forwarder): 18 × OSFP800 network + 20 × OSFP800 fabric ports, 2 RU, 782 W typ / 1,140 W max (w/o optics).',
    dims: { w: 0.44, d: 0.8, h: 0.087 }, weightKg: 21, clearance: { front: 0, rear: 0, sides: 0 },
    power: { nameplateKW: 1.14, typicalKW: 0.78, idleKW: 0.4, peakKW: 1.14, feeds: 2, voltageV: 230 },
    cooling: { liquidFraction: 0, airflowM3s: 0.1, liquidFlowLpm: 0, maxInletC: 35 },
    switch: { fabric: 'drivenets-fse', ports: 38, portGbps: 800, rackUnits: 2, role: 'leaf', netPorts: 18, fabricPorts: 20 },
    cost: { capexUSD: 60_000, installHours: 3, leadTimeWeeks: 12 }, source: 'vendor-datasheet', notes: 'AMD–DriveNets System RA Table 9; price estimate.',
  },
  'drivenets-9300f': {
    id: 'drivenets-9300f', category: 'switch', vendor: 'DriveNets / UfiSpace', model: 'NCF 9300F', name: 'DriveNets 9300F NCF (128 × 800G fabric)',
    description: 'DDC fabric element (spine): 128 × OSFP 800G fabric ports, 6 RU, 1,113 W typ / 1,918 W max (w/o optics).',
    dims: { w: 0.44, d: 0.8, h: 0.263 }, weightKg: 63, clearance: { front: 0, rear: 0, sides: 0 },
    power: { nameplateKW: 1.92, typicalKW: 1.11, idleKW: 0.6, peakKW: 1.92, feeds: 2, voltageV: 230 },
    cooling: { liquidFraction: 0, airflowM3s: 0.2, liquidFlowLpm: 0, maxInletC: 35 },
    switch: { fabric: 'drivenets-fse', ports: 128, portGbps: 800, rackUnits: 6, role: 'spine', fabricPorts: 128 },
    cost: { capexUSD: 160_000, installHours: 4, leadTimeWeeks: 14 }, source: 'vendor-datasheet', notes: 'AMD–DriveNets System RA Table 10; price estimate.',
  },
  'drivenets-2500s': {
    id: 'drivenets-2500s', category: 'switch', vendor: 'DriveNets / UfiSpace', model: '2500S (Tomahawk 5)', name: 'DriveNets 2500S ESE (TH5, 64 × 800G)',
    description: 'DriveNets ESE Ethernet switch on Broadcom Tomahawk 5 (BCM78900), 64 × OSFP800, 2 RU, 1,066 W typ / 1,684 W max (w/o optics).',
    dims: { w: 0.44, d: 0.58, h: 0.089 }, weightKg: 22, clearance: { front: 0, rear: 0, sides: 0 },
    power: { nameplateKW: 1.68, typicalKW: 1.07, idleKW: 0.5, peakKW: 1.68, feeds: 2, voltageV: 230 },
    cooling: { liquidFraction: 0, airflowM3s: 0.16, liquidFlowLpm: 0, maxInletC: 35 },
    switch: { fabric: 'ese-uec-400', ports: 128, portGbps: 400, rackUnits: 2, role: 'any' },
    cost: { capexUSD: 55_000, installHours: 4, leadTimeWeeks: 10 }, source: 'vendor-datasheet', notes: 'AMD–DriveNets System RA Table 5 (64 × 800G = 128 × 400G); price estimate.',
  },
  'broadcom-th5-64x800': {
    id: 'broadcom-th5-64x800', category: 'switch', vendor: 'Broadcom (ODM)', model: 'Tomahawk 5 51.2T', name: 'Tomahawk 5 51.2T (64 × 800G)',
    description: 'Merchant 51.2 Tb/s Ethernet switch, 64 × 800G OSFP (128 × 400G), 2 RU.',
    dims: { w: 0.44, d: 0.66, h: 0.089 }, weightKg: 22, clearance: { front: 0, rear: 0, sides: 0 },
    power: { nameplateKW: 1.7, typicalKW: 1.1, idleKW: 0.5, peakKW: 1.7, feeds: 2, voltageV: 230 },
    cooling: { liquidFraction: 0, airflowM3s: 0.16, liquidFlowLpm: 0, maxInletC: 35 },
    switch: { fabric: 'ese-uec-400', ports: 128, portGbps: 400, rackUnits: 2, role: 'any' },
    cost: { capexUSD: 50_000, installHours: 4, leadTimeWeeks: 10 }, source: 'public-spec', notes: 'Broadcom TH5 public port configuration; power/price estimates.',
  },
};

/** Catalog switch or the inline fallback (DDC / TH5 ids the S3 seeds may not carry yet). */
export function resolveSwitchItem(id: string, fabric: FabricTech): CatalogItem {
  return findCatalogItem(id) ?? findCatalogItem(FABRIC_SWITCH[fabric]) ?? FALLBACK_SWITCH[id] ?? FALLBACK_SWITCH[FABRIC_SWITCH[fabric]] ?? findCatalogItem(FABRIC_SWITCH['ethernet-400'])!;
}

export type FabricKey = 'scale-out' | 'frontend' | 'storage' | 'oob';
type Role = 'leaf' | 'spine' | 'core';

const RACK_KW_CAPACITY = 35;
const OOB_UPLINKS_PER_LEAF = 2;
const OOB_UPLINK_GBPS = 100;
/** ToR leaves in compute racks: spare-U budget = 48U − nodes × node RU (HGX 8-GPU server 10U; 4U for smaller nodes) — estimate. */
const TOR_KW_CAPACITY = 6;
const torSpareRU = (item: CatalogItem): number => {
  const c = item.compute;
  if (!c?.nodesPerRack) return 0;
  const nodeRU = (c.gpusPerNode ?? 8) >= 8 ? 10 : 4;
  return Math.max(0, (item.rackUnits ?? 48) - c.nodesPerRack * nodeRU);
};

/** HGX-type compute rack: multiple nodes whose scale-up domain is the node itself (NVL72-class racks are not). */
export function isHgxType(item: CatalogItem | undefined): boolean {
  const c = item?.compute;
  if (!c?.gpusPerNode || !c.nodesPerRack) return false;
  const domain = c.scaleUp.domainSize;
  return domain <= c.gpusPerNode;
}

interface EndpointLinks {
  rack: Placed;
  links: number; // logical links toward the fabric
  gbps: number; // link speed
  switchPorts: number; // switch ports consumed
}

export interface FabricPlan {
  key: FabricKey;
  fabric: FabricTech;
  label: string;
  sw: CatalogItem;
  /** spine/core switch when it differs from the leaf box (DDC: NCF) */
  spineSw?: CatalogItem;
  kind: 'clos' | 'ddc';
  topology: FabricTopology;
  oversubscription: number;
  endpointsByPod: Map<string, EndpointLinks[]>;
  leavesByPod: Map<string, number>;
  downPerLeaf: number;
  upPerLeaf: number;
  leaves: number;
  spines: number;
  cores: number;
  tiers: 1 | 2 | 3;
  feasible: boolean;
  /** DDC: sized beyond the RA's validated base clusters (NCF count extrapolated) */
  extrapolated?: boolean;
  links: number;
  linkGbps: number;
  extraSpinePorts: number;
  notes: string[];
  // ── v2 2차 (T2): cluster scope ──
  clusterId?: string;
  clusterName?: string;
  /** GPUs of the cluster this plan serves (a training job never spans clusters) */
  clusterGpus?: number;
  /** joined clusters: GPUs reachable below the inter-hall super-spine (one hall) */
  gpusPerSpineDomain?: number;
}

function endpointLinks(rack: Placed, ports: number, gbps: number, swGbps: number): EndpointLinks | null {
  if (ports <= 0 || gbps <= 0) return null;
  if (gbps >= swGbps) {
    const lanes = Math.max(1, Math.round(gbps / swGbps));
    return { rack, links: ports * lanes, gbps: swGbps, switchPorts: ports * lanes };
  }
  return { rack, links: ports, gbps, switchPorts: (ports * gbps) / swGbps };
}

function collectEndpoints(ctx: Ctx, key: Exclude<FabricKey, 'oob'>, swGbps: number): Map<string, EndpointLinks[]> {
  const m = new Map<string, EndpointLinks[]>();
  for (const p of ctx.placed) {
    const c = p.item.compute;
    if (!c) continue;
    let ports = 0;
    let gbps = 0;
    if (key === 'scale-out' && p.item.category === 'gpu-rack') {
      ports = c.gpus * c.scaleOutPortsPerGpu;
      gbps = c.scaleOutPortGbps;
    } else if (key === 'frontend') {
      ports = c.frontendPorts;
      gbps = c.frontendPortGbps;
    } else if (key === 'storage') {
      ports = c.storagePorts;
      gbps = c.storagePortGbps;
    }
    const ep = endpointLinks(p, ports, gbps, swGbps);
    if (!ep) continue;
    const k = podKey(p.e);
    const arr = m.get(k);
    if (arr) arr.push(ep);
    else m.set(k, [ep]);
  }
  return m;
}

/** Native scale-up domains split into this many scale-out rails (4 GPUs per NVL72/Helios compute tray; 8 for HGX/UBB8). */
export function railsFor(item: CatalogItem | undefined): number {
  const c = item?.compute;
  if (c?.railsPerNode && c.railsPerNode > 0) return c.railsPerNode;
  return railsForDomain(c?.scaleUp.domainSize ?? 0);
}

interface SizeOpts {
  key: FabricKey;
  fabric: FabricTech;
  sw: CatalogItem;
  spineSw?: CatalogItem;
  oversubscription: number;
  tiers: 'auto' | 2 | 3;
  topology: FabricTopology;
  endpointsByPod: Map<string, EndpointLinks[]>;
  rails: number;
  extraSpinePorts?: number;
  /** 'ddc' → DriveNets NCP/NCF sizing; default 'clos' (also inferred from the fabric) */
  kind?: 'clos' | 'ddc';
}

export function sizeFabric(o: SizeOpts): FabricPlan {
  const kind = o.kind ?? (o.fabric === 'drivenets-fse' ? 'ddc' : 'clos');
  const k = o.sw.switch?.ports ?? 64;
  const swGbps = o.sw.switch?.portGbps ?? 400;
  const mgmt = o.sw.switch?.role === 'mgmt';
  const os = Math.max(1, o.oversubscription);
  const extra = o.extraSpinePorts ?? 0;
  const notes: string[] = [];
  // per-pod switch-port demand (breakout already applied by endpointLinks); pods with no ports get no leaves
  const podKeys: string[] = [];
  const podPorts: number[] = [];
  let links = 0;
  let linkGbpsWeighted = 0;
  for (const [pod, eps] of o.endpointsByPod) {
    const ports = eps.reduce((s, e) => s + e.switchPorts, 0);
    links += eps.reduce((s, e) => s + e.links, 0);
    linkGbpsWeighted += eps.reduce((s, e) => s + e.links * e.gbps, 0);
    if (ports <= 0) continue;
    podKeys.push(pod);
    podPorts.push(ports);
  }
  const base = {
    key: o.key,
    fabric: o.fabric,
    label: FABRIC_LABEL[o.fabric],
    sw: o.sw,
    spineSw: o.spineSw,
    kind,
    topology: o.topology,
    oversubscription: os,
    endpointsByPod: o.endpointsByPod,
    links,
    linkGbps: links > 0 ? linkGbpsWeighted / links : swGbps,
    extraSpinePorts: extra,
    notes,
  };
  if (kind === 'ddc') {
    // DriveNets FSE: NCP per pod = ceil(ports800 / 18); NCF from the RA base-cluster table (rails and oversubscription do not apply —
    // the cell-sprayed fabric is non-blocking by construction, 1:1 tagged from the RA)
    const netPorts = o.sw.switch?.netPorts ?? NCP_NET_PORTS;
    const fabricPorts = o.sw.switch?.fabricPorts ?? NCP_FABRIC_PORTS;
    const ncfPorts = o.spineSw?.switch?.fabricPorts ?? o.spineSw?.switch?.ports ?? NCF_PORTS;
    // 400G endpoints (breakout) populate 32 × 400G per NCP (Table 12, TOR-aligned) — 36 only on a rail-optimized full population
    const endpointGbps = links > 0 ? linkGbpsWeighted / links : swGbps;
    const ddcOpts: DdcOptions = { endpointGbps, railOptimized: o.topology === 'rail-optimized' && o.rails > 1 };
    const perNcp = endpointGbps < 800 && !ddcOpts.railOptimized ? Math.min(netPorts, NCP_NET_PORTS_TOR_400) : netPorts;
    const leavesByPod = new Map<string, number>();
    podKeys.forEach((pod, i) => leavesByPod.set(pod, Math.ceil(podPorts[i] / perNcp - 1e-9)));
    const totalPorts = podPorts.reduce((s, v) => s + v, 0);
    const ddc = sizeDdc(totalPorts, netPorts, fabricPorts, ncfPorts, ddcOpts);
    const leaves = [...leavesByPod.values()].reduce((s, v) => s + v, 0);
    // per-pod rounding can exceed the flat ceil(E/18): keep the larger (real racks) but never fewer NCFs than the fabric ports need
    const ncf = Math.max(ddc.ncf, Math.ceil((leaves * fabricPorts) / ncfPorts - 1e-9));
    const feasible = ddc.feasible && leaves <= DDC_MAX_NCP && ncf <= DDC_MAX_NCF;
    const ruleTxt = endpointGbps < 800 ? `ceil(${Math.round(totalPorts * 2)} × 400G / ${perNcp * 2})` : `ceil(${totalPorts}/${netPorts})`;
    if (ddc.base) notes.push(`DDC base cluster ${ddc.base} (AMD–DriveNets RA Table ${endpointGbps < 800 ? '12' : '11'}): NCF ${ddc.ncf}, NCP = ${ruleTxt} = ${ddc.ncp}.`);
    else if (totalPorts > 0) notes.push(`DDC: ${totalPorts} × 800G endpoints exceed the largest validated 2-tier FSE cluster (AI-4608-800) — NCF = ceil(NCP·${fabricPorts}/${ncfPorts}) is an extrapolation; a 3-tier FSE is not sized in the RA (estimate).`);
    if (!feasible) notes.push(`DDC: ${leaves} NCP / ${ncf} NCF exceed the 2-tier FSE cap (${DDC_MAX_NCP} NCP × ${DDC_MAX_NCF} NCF — one 400G lane per NCP–NCF pair); the design is not feasible as a 2-tier FSE (estimate — 3-tier FSE not sized in the RA).`);
    if (os > 1) notes.push('DDC fabric is cell-scheduled and non-blocking; the leaf oversubscription setting is ignored for NCP/NCF sizing.');
    return { ...base, leavesByPod, downPerLeaf: perNcp, upPerLeaf: fabricPorts, leaves, spines: leaves > 1 ? ncf : 0, cores: 0, tiers: leaves > 1 ? 2 : 1, feasible, extrapolated: !ddc.withinRA };
  }
  // shared radix math (engines/radix.ts) — the layout generator uses the same functions
  const r = sizeFabricFromPodPorts({ switchPortsByPod: podPorts, rails: o.rails, k, oversubscription: os, extraSpinePorts: extra, tiers: o.tiers, mgmt });
  const leavesByPod = new Map<string, number>();
  podKeys.forEach((pod, i) => leavesByPod.set(pod, r.leavesByPod[i]));
  const { downPerLeaf: d, upPerLeaf: u, leaves: L, spines, cores, tiers, feasible } = r;
  return { ...base, leavesByPod, downPerLeaf: d, upPerLeaf: u, leaves: L, spines, cores, tiers, feasible };
}

const spineSwOf = (plan: FabricPlan): CatalogItem => plan.spineSw ?? plan.sw;

function fabricAnalysis(plan: FabricPlan, name: string): FabricAnalysis {
  const k = plan.sw.switch?.ports ?? 64;
  const P = Math.floor(k / 2);
  const ssw = spineSwOf(plan);
  const tiers: NetworkTier[] = [];
  if (plan.kind === 'ddc') {
    if (plan.leaves > 0) tiers.push({ name: 'NCP (leaf)', switches: plan.leaves, portsPerSwitch: k, downlinks: plan.downPerLeaf, uplinks: plan.upPerLeaf });
    if (plan.tiers >= 2) tiers.push({ name: 'NCF (fabric)', switches: plan.spines, portsPerSwitch: ssw.switch?.ports ?? NCF_PORTS, downlinks: ssw.switch?.ports ?? NCF_PORTS, uplinks: 0 });
  } else {
    if (plan.leaves > 0) tiers.push({ name: plan.key === 'oob' ? 'OOB Leaf' : 'Leaf', switches: plan.leaves, portsPerSwitch: k, downlinks: plan.downPerLeaf, uplinks: plan.upPerLeaf });
    if (plan.tiers >= 2) tiers.push({ name: 'Spine', switches: plan.spines, portsPerSwitch: k, downlinks: plan.tiers === 2 ? k : P, uplinks: plan.tiers === 2 ? 0 : P });
    if (plan.tiers === 3) tiers.push({ name: 'Core', switches: plan.cores, portsPerSwitch: k, downlinks: k, uplinks: 0 });
  }
  const total = plan.leaves + plan.spines + plan.cores;
  const upper = plan.spines + plan.cores;
  return {
    name,
    fabric: plan.fabric,
    endpoints: plan.links,
    tiers,
    switchCatalogId: plan.sw.id,
    totalSwitches: total,
    bisectionGbps: (plan.links * plan.linkGbps) / (2 * plan.oversubscription),
    oversubscription: plan.oversubscription,
    // DDC behaves as one distributed chassis (cells sprayed NCP → NCF → NCP): report a single logical hop
    maxHops: plan.kind === 'ddc' ? 1 : plan.tiers === 1 ? 1 : plan.tiers === 2 ? 3 : 5,
    powerKW: plan.leaves * (plan.sw.power?.nameplateKW ?? 0) + upper * (ssw.power?.nameplateKW ?? 0),
    racksNeeded: (plan.leaves > 0 ? Math.ceil(plan.leaves / switchesPerNetworkRack(plan.sw)) : 0) + (upper > 0 ? Math.ceil(upper / switchesPerNetworkRack(ssw)) : 0),
    topology: plan.topology,
    linkGbps: plan.linkGbps,
    links: plan.links,
    feasible: plan.feasible,
    ...(plan.extrapolated ? { extrapolated: true } : {}),
  };
}

// ───────────── switch placement ─────────────

interface Entry {
  fabric: FabricKey;
  role: Role;
  pod?: string;
  sw: CatalogItem;
  count: number;
}

interface Host {
  rack: Placed;
  ru: number;
  kw: number;
  ruCap: number;
  kwCap: number;
  entries: Entry[];
  /** compute rack lending spare U-space to ToR leaves */
  tor?: boolean;
}

function hostFit(h: Host, sw: CatalogItem, want: number): number {
  const ru = sw.switch?.rackUnits ?? 1;
  const kw = sw.power?.nameplateKW ?? 0;
  const byRu = Math.floor((h.ruCap - h.ru) / ru + 1e-9);
  const byKw = kw > 0 ? Math.floor((h.kwCap - h.kw) / kw + 1e-9) : want;
  return Math.max(0, Math.min(want, byRu, byKw));
}

function placeInto(hosts: readonly Host[], fabric: FabricKey, role: Role, pod: string | undefined, sw: CatalogItem, count: number): number {
  let left = count;
  for (const h of hosts) {
    if (left <= 0) break;
    const n = hostFit(h, sw, left);
    if (n <= 0) continue;
    h.ru += n * (sw.switch?.rackUnits ?? 1);
    h.kw += n * (sw.power?.nameplateKW ?? 0);
    const existing = h.entries.find((e) => e.fabric === fabric && e.role === role && e.pod === pod && e.sw.id === sw.id);
    if (existing) existing.count += n;
    else h.entries.push({ fabric, role, pod, sw, count: n });
    left -= n;
  }
  return left;
}

const roleOf = (h: Host) => h.rack.e.networkRole ?? 'mixed';

function uniq(hosts: Host[]): Host[] {
  return [...new Set(hosts)];
}

// ───────────── cabling: single length model ─────────────

const JOIN_M = 0.8; // tray-to-tray junction tolerance
const ATTACH_M = 6; // rack must be within this horizontal distance of a tray to use the tray route

interface TrayGraph {
  pts: { x: number; y: number; z: number }[];
  adj: Map<number, { to: number; len: number }[]>;
  segs: { a: number; b: number; hallId: string }[];
  /** attach-point lookup (`att|hall|x|y` → node) */
  cache: Map<string, number>;
  /** attach nodes added after a per-source distance table was computed: they split a segment, so every distance to them
   *  is min(dist[a] + la, dist[b] + lb) — no shortcut is created and the cached tables stay valid */
  parents: Map<number, { a: number; b: number; la: number; lb: number }>;
  /** per-source shortest distances (binary-heap Dijkstra once per source node; indexed by node) */
  dist: Map<number, Float64Array>;
}

/** Minimal binary min-heap keyed by distance (node, key pairs). */
class MinHeap {
  private n: number[] = [];
  private k: number[] = [];
  get size() { return this.n.length; }
  push(node: number, key: number) {
    const n = this.n;
    const k = this.k;
    n.push(node);
    k.push(key);
    let i = n.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [n[p], n[i]] = [n[i], n[p]];
      [k[p], k[i]] = [k[i], k[p]];
      i = p;
    }
  }
  pop(): { node: number; key: number } {
    const n = this.n;
    const k = this.k;
    const top = { node: n[0], key: k[0] };
    const ln = n.pop()!;
    const lk = k.pop()!;
    if (n.length) {
      n[0] = ln;
      k[0] = lk;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < n.length && k[l] < k[m]) m = l;
        if (r < n.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [n[m], n[i]] = [n[i], n[m]];
        [k[m], k[i]] = [k[i], k[m]];
        i = m;
      }
    }
    return top;
  }
}

const trayGraphCache = new WeakMap<object, TrayGraph>();

function addEdge(g: TrayGraph, a: number, b: number, len: number) {
  if (a === b) return;
  const push = (from: number, to: number) => {
    const arr = g.adj.get(from);
    if (arr) arr.push({ to, len });
    else g.adj.set(from, [{ to, len }]);
  };
  push(a, b);
  push(b, a);
}

function addPoint(g: TrayGraph, p: { x: number; y: number; z: number }): number {
  g.pts.push(p);
  return g.pts.length - 1;
}

function closestOnSegment(p: Vec2, a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): { x: number; y: number; z: number; d: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 <= 1e-9 ? 0 : clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / l2, 0, 1);
  const q = { x: a.x + t * dx, y: a.y + t * dy, z: a.z + t * (b.z - a.z) };
  return { ...q, d: Math.hypot(p.x - q.x, p.y - q.y) };
}

function buildTrayGraph(trays: readonly CableTray[]): TrayGraph {
  const cached = trayGraphCache.get(trays);
  if (cached) return cached;
  const g: TrayGraph = { pts: [], adj: new Map(), segs: [], cache: new Map(), parents: new Map(), dist: new Map() };
  const ends: { idx: number; hallId: string }[] = [];
  for (const t of trays) {
    let prev = -1;
    t.points.forEach((p, i) => {
      const idx = addPoint(g, { x: p.x, y: p.y, z: p.z });
      if (prev >= 0) {
        const a = g.pts[prev];
        addEdge(g, prev, idx, Math.hypot(p.x - a.x, p.y - a.y, p.z - a.z));
        g.segs.push({ a: prev, b: idx, hallId: t.hallId });
      }
      if (i === 0 || i === t.points.length - 1) ends.push({ idx, hallId: t.hallId });
      prev = idx;
    });
  }
  // junctions: every polyline end that lies on (or near) another tray segment gets connected to it
  const segCount = g.segs.length;
  for (const e of ends) {
    const p = g.pts[e.idx];
    let best: { s: number; q: { x: number; y: number; z: number; d: number } } | null = null;
    for (let s = 0; s < segCount; s++) {
      const seg = g.segs[s];
      if (seg.hallId !== e.hallId || seg.a === e.idx || seg.b === e.idx) continue;
      const q = closestOnSegment(p, g.pts[seg.a], g.pts[seg.b]);
      if (q.d <= JOIN_M && (!best || q.d < best.q.d)) best = { s, q };
    }
    if (!best) continue;
    const seg = g.segs[best.s];
    const j = addPoint(g, { x: best.q.x, y: best.q.y, z: best.q.z });
    addEdge(g, j, seg.a, Math.hypot(best.q.x - g.pts[seg.a].x, best.q.y - g.pts[seg.a].y));
    addEdge(g, j, seg.b, Math.hypot(best.q.x - g.pts[seg.b].x, best.q.y - g.pts[seg.b].y));
    addEdge(g, e.idx, j, Math.max(0.1, best.q.d) + Math.abs(best.q.z - p.z));
  }
  trayGraphCache.set(trays, g);
  return g;
}

/** Attach a rack to the tray graph: nearest segment (same hall) within ATTACH_M; returns node index, horizontal offset and tray z. */
function attach(g: TrayGraph, hallId: string, p: Vec2): { node: number; offset: number; z: number } | null {
  let best: { s: number; q: { x: number; y: number; z: number; d: number } } | null = null;
  for (let s = 0; s < g.segs.length; s++) {
    const seg = g.segs[s];
    if (seg.hallId !== hallId) continue;
    const q = closestOnSegment(p, g.pts[seg.a], g.pts[seg.b]);
    if (q.d <= ATTACH_M && (!best || q.d < best.q.d)) best = { s, q };
  }
  if (!best) return null;
  const key = `att|${hallId}|${best.q.x.toFixed(3)}|${best.q.y.toFixed(3)}`;
  let node = g.cache.get(key);
  if (node === undefined) {
    const seg = g.segs[best.s];
    node = addPoint(g, { x: best.q.x, y: best.q.y, z: best.q.z });
    const la = Math.hypot(best.q.x - g.pts[seg.a].x, best.q.y - g.pts[seg.a].y);
    const lb = Math.hypot(best.q.x - g.pts[seg.b].x, best.q.y - g.pts[seg.b].y);
    addEdge(g, node, seg.a, la);
    addEdge(g, node, seg.b, lb);
    g.parents.set(node, { a: seg.a, b: seg.b, la, lb });
    g.cache.set(key, node);
  }
  return { node, offset: best.q.d, z: best.q.z };
}

/** Full single-source Dijkstra (binary heap) over the nodes present now; cached per source. */
function distancesFrom(g: TrayGraph, from: number): Float64Array {
  const hit = g.dist.get(from);
  if (hit) return hit;
  const n = g.pts.length;
  const dist = new Float64Array(n).fill(Infinity);
  dist[from] = 0;
  const heap = new MinHeap();
  heap.push(from, 0);
  while (heap.size) {
    const { node: u, key: du } = heap.pop();
    if (du > dist[u]) continue; // stale entry
    for (const e of g.adj.get(u) ?? []) {
      const nd = du + e.len;
      if (nd < dist[e.to]) {
        dist[e.to] = nd;
        heap.push(e.to, nd);
      }
    }
  }
  g.dist.set(from, dist);
  return dist;
}

/** Distance from `from` to `to`, where `to` may be an attach node created after `dist` was computed (derive via its segment). */
function distTo(g: TrayGraph, dist: Float64Array, to: number): number {
  if (to < dist.length) return dist[to];
  const p = g.parents.get(to);
  if (!p) return Infinity;
  return Math.min(distTo(g, dist, p.a) + p.la, distTo(g, dist, p.b) + p.lb);
}

function shortestPath(g: TrayGraph, from: number, to: number): number {
  if (from === to) return 0;
  // prefer a source whose table already exists (symmetric graph), else compute from the older node so later attach
  // points can still be derived from their segment endpoints
  const cachedFrom = g.dist.get(from);
  const cachedTo = g.dist.get(to);
  if (cachedFrom) return distTo(g, cachedFrom, to);
  if (cachedTo) return distTo(g, cachedTo, from);
  const [src, dst] = from < to ? [from, to] : [to, from];
  return distTo(g, distancesFrom(g, src), dst);
}

/**
 * Cable length between two placed racks (m), rounded up to 0.5 m.
 *  - tray graph when `trays` (default `project.trays`) covers both ends: rack→tray offset + tray path + vertical rise/drop + slack;
 *  - otherwise Manhattan × route factor + vertical (tray height − 1.2 m mid-rack) + slack per end (+25 m between halls).
 */
export function cableLengthM(project: Project, a: Placed, b: Placed, trays?: readonly CableTray[]): number {
  if (a.e.id === b.e.id) return 2;
  const cab = project.network.cabling;
  const list = trays ?? project.trays;
  if (list && list.length > 0 && a.e.hallId === b.e.hallId) {
    const g = buildTrayGraph(list);
    const ta = attach(g, a.e.hallId, a.e.position);
    const tb = attach(g, b.e.hallId, b.e.position);
    if (ta && tb) {
      const path = shortestPath(g, ta.node, tb.node);
      if (Number.isFinite(path)) {
        const vertical = Math.max(0.5, ta.z - 1.2) + Math.max(0.5, tb.z - 1.2);
        return Math.ceil((ta.offset + path + tb.offset + vertical + 2 * cab.slackPerEndM) * 2) / 2;
      }
    }
  }
  if (a.e.hallId !== b.e.hallId) return interHallLengthM(project, a, b);
  const pa = siteXY(a);
  const pb = siteXY(b);
  const d = manhattan(pa, pb);
  if (a.e.rowId && a.e.rowId === b.e.rowId && d <= 3) return Math.ceil((d * 1.1 + 2) * 2) / 2;
  const tray = Math.max(a.hall?.trayHeight ?? 2.9, 1.8);
  const vertical = 2 * Math.max(0.5, tray - 1.2);
  return Math.ceil((d * cab.routeFactor + vertical + 2 * cab.slackPerEndM) * 2) / 2;
}

/**
 * Cable between racks in different halls (only inter-hall super-spine trunks of a joined cluster create these):
 *   in-hall route from rack A to its trunk sleeve (Manhattan × route factor) + site pathway between the two sleeves (Manhattan)
 *   + in-hall route from hall B's sleeve to rack B + vertical rise/drop + slack per end, rounded up to 0.5 m.
 * finish v2 2차 (D5): the sleeves sit on the facing walls (layout/trunkSleeves.ts) — the drawn trunk path uses the same positions;
 * the former "hall origin = pathway entry" rule is gone.
 */
export function interHallLengthM(project: Project, a: Placed, b: Placed): number {
  const cab = project.network.cabling;
  const sa = trunkSleeveSpot(project, a.e.hallId, b.e.hallId);
  const sb = trunkSleeveSpot(project, b.e.hallId, a.e.hallId);
  const oa = a.hall?.origin ?? { x: 0, y: 0 };
  const ob = b.hall?.origin ?? { x: 0, y: 0 };
  const la = sa?.local ?? { x: 0, y: 0 };
  const lb = sb?.local ?? { x: 0, y: 0 };
  const inA = (Math.abs(a.e.position.x - la.x) + Math.abs(a.e.position.y - la.y)) * cab.routeFactor;
  const inB = (Math.abs(b.e.position.x - lb.x) + Math.abs(b.e.position.y - lb.y)) * cab.routeFactor;
  const pa = sa?.site ?? oa;
  const pb = sb?.site ?? ob;
  const between = Math.abs(pa.x - pb.x) + Math.abs(pa.y - pb.y);
  const tray = Math.max(a.hall?.trayHeight ?? 2.9, 1.8);
  const vertical = 2 * Math.max(0.5, tray - 1.2);
  return Math.ceil((inA + between + inB + vertical + 2 * cab.slackPerEndM) * 2) / 2;
}

/** Physical medium of a cable type (v2 `medium` field, else inferred from `kind`). */
export function mediumOf(t: CableType): 'copper' | 'mmf' | 'smf' | 'aoc' {
  if (t.medium) return t.medium;
  if (t.kind === 'dac' || t.kind === 'acc' || t.kind === 'aec' || t.kind === 'cat6a' || t.kind === 'power') return 'copper';
  if (t.kind === 'aoc') return 'aoc';
  if (t.kind === 'smf') return 'smf';
  return 'mmf';
}
export const isOptical = (t: CableType) => mediumOf(t) !== 'copper';
/** Power per switch-side cable end (W): v2 wattsPerEnd, else transceiverW. */
export const wattsPerEnd = (t: CableType) => t.wattsPerEnd ?? t.transceiverW;

export function chooseCable(project: Project, gbps: number, lengthM: number): { type: CableType; ok: boolean; unitUSD: number } {
  const cab = project.network.cabling;
  const types = cableTypes();
  const speedOk = types.filter((t) => t.kind !== 'power' && (gbps <= 1 ? t.kind === 'cat6a' : t.kind !== 'cat6a' && t.gbps >= gbps));
  const cls = speedOk.length ? Math.min(...speedOk.map((t) => t.gbps)) : 0;
  const pool = speedOk.filter((t) => t.gbps === cls);
  const allowed = pool.filter((t) => {
    const medium = mediumOf(t);
    if ((t.kind === 'dac' || t.kind === 'acc') && lengthM > cab.maxCopperM) return false;
    if ((t.kind === 'aec' || t.kind === 'acc') && !cab.allowActiveCopper) return false;
    if (cab.preferSingleMode && (medium === 'mmf' || medium === 'aoc')) return false;
    return lengthM >= t.minReachM && lengthM <= t.maxReachM;
  });
  if (allowed.length > 0) {
    let best = allowed[0];
    let bestUSD = cableUnitUSD(project, best, lengthM);
    for (const t of allowed.slice(1)) {
      const usd = cableUnitUSD(project, t, lengthM);
      if (usd < bestUSD) {
        best = t;
        bestUSD = usd;
      }
    }
    return { type: best, ok: true, unitUSD: bestUSD };
  }
  const fallback = (pool.length ? pool : types).reduce((a, b) => (b.maxReachM > a.maxReachM ? b : a));
  return { type: fallback, ok: fallback.maxReachM >= lengthM, unitUSD: cableUnitUSD(project, fallback, lengthM) };
}

export function commEfficiency(plan: Pick<FabricPlan, 'fabric' | 'topology' | 'oversubscription' | 'tiers' | 'linkGbps'> & { kind?: 'clos' | 'ddc' }, nicGbps: number, lanes = 1): number {
  const tech = FABRIC_TECH_FACTOR[plan.fabric] ?? 0.8;
  const topo = plan.topology === 'rail-optimized' ? 1 : plan.topology === 'fat-tree' ? 0.98 : 0.96;
  const alpha = plan.topology === 'rail-optimized' ? 0.2 : 0.35;
  const oversub = plan.kind === 'ddc' ? 1 : 1 / (1 + alpha * (plan.oversubscription - 1));
  const hops = plan.kind === 'ddc' ? 1 : plan.tiers === 1 ? 1 : plan.tiers === 2 ? 3 : 5;
  const hopF = 1 - 0.01 * Math.max(0, hops - 3);
  const speed = nicGbps > 0 ? Math.min(1, (plan.linkGbps * lanes) / nicGbps) : 1;
  return clamp(tech * topo * oversub * hopF * speed, 0.05, 1);
}

// ───────────── main entry ─────────────

export interface NetworkResult {
  analysis: NetworkAnalysis;
  plans: FabricPlan[];
  /** kW of switches (nameplate) */
  switchKW: number;
  /** placement decisions / fallbacks (surfaced by the placement comparator and the traffic report) */
  notes: string[];
  /** effective leaf / spine placement after fallbacks (e.g. 'tor' on NVL72 → 'mid-row') */
  effectivePlacement: { leaf: ScaleOutNetwork['leafPlacement']; spine: ScaleOutNetwork['spinePlacement'] };
}

interface ScopeOpts {
  /** cable-run id counter shared across scopes (ids stay unique when scopes are merged) */
  seq?: { n: number };
  /** appended to the scale-out label (joined cluster name, or the hall name when several scopes exist) */
  soSuffix?: string;
  /** appended to the front-end / storage / OOB labels (hall name when several scopes exist) */
  auxSuffix?: string;
  clusterId?: string;
  clusterName?: string;
  /** hall of a joined cluster: the scale-out top tier reserves floor(k/2) uplinks per switch toward the inter-hall super-spines */
  joinUplinks?: boolean;
  /** polish v2 2차: switch units placed outside this scope's hosts that still need an OOB mgmt0 port here (rack id → switches) —
   *  the inter-hall super-spines of a joined cluster, sized after the per-hall scopes and placed in the zone hall */
  oobExtraSwitches?: ReadonlyMap<string, number>;
}

/** Fabrics, placement and cabling of one scope (one hall, or the whole project when a single hall is populated). */
function analyzeScope(ctx: Ctx, scope: ScopeOpts = {}): NetworkResult {
  const { project } = ctx;
  const net = project.network;
  const so = net.scaleOut;
  const notes: string[] = [];
  const rails = so.topology === 'rail-optimized' ? railsFor(ctx.gpuRack) : 1;
  const tagPlan = (p: FabricPlan | undefined, suffix: string | undefined) => {
    if (!p) return;
    if (suffix) p.label = `${p.label}${suffix}`;
    if (scope.clusterId) {
      p.clusterId = scope.clusterId;
      p.clusterName = scope.clusterName;
      p.clusterGpus = ctx.gpus;
    }
  };

  const resolveSwitch = (id: string, fabric: FabricTech): CatalogItem => resolveSwitchItem(id, fabric);

  const soSw = resolveSwitch(so.switchCatalogId, so.fabric);
  const soSpineId = FABRIC_SPINE_SWITCH[so.fabric];
  const soSpineSw = soSpineId ? resolveSwitch(soSpineId, so.fabric) : undefined;
  const soOpts: SizeOpts = {
    key: 'scale-out',
    fabric: so.fabric,
    sw: soSw,
    spineSw: soSpineSw,
    oversubscription: so.oversubscription,
    tiers: so.tiers,
    topology: so.topology,
    endpointsByPod: collectEndpoints(ctx, 'scale-out', soSw.switch?.portGbps ?? 800),
    rails,
  };
  let soPlan = sizeFabric(soOpts);
  if (scope.joinUplinks && soPlan.kind === 'clos' && soPlan.tiers >= 2) {
    // joined cluster (F2): the hall's top tier keeps one uplink per downlink toward the super-spines (1:1) — radix.ts extraSpinePorts
    const k = soSw.switch?.ports ?? 64;
    const reserve = soPlan.tiers === 3 ? soPlan.spines * Math.floor(k / 2) : soPlan.leaves * soPlan.upPerLeaf;
    soPlan = sizeFabric({ ...soOpts, tiers: soPlan.tiers as 2 | 3, extraSpinePorts: reserve });
    soPlan.notes.push(`Joined cluster: ${soPlan.tiers === 3 ? 'cores' : 'spines'} reserve ${Math.floor(k / 2)} of ${k} ports as uplinks to the inter-hall super-spines (${reserve} extra ports).`);
  }
  tagPlan(soPlan, scope.soSuffix);
  notes.push(...soPlan.notes);

  const stSw = resolveSwitch(net.storage.switchCatalogId, net.storage.fabric);
  const stPlan = net.storage.enabled
    ? sizeFabric({ key: 'storage', fabric: net.storage.fabric, sw: stSw, oversubscription: net.storage.oversubscription, tiers: 'auto', topology: 'leaf-spine', endpointsByPod: collectEndpoints(ctx, 'storage', stSw.switch?.portGbps ?? 400), rails: 1, kind: 'clos' })
    : undefined;

  const feSw = resolveSwitch(net.frontend.switchCatalogId, net.frontend.fabric);
  const feEndpoints = net.frontend.enabled ? collectEndpoints(ctx, 'frontend', feSw.switch?.portGbps ?? 400) : new Map<string, EndpointLinks[]>();
  const oobSw = resolveSwitch(net.oob.switchCatalogId, net.oob.fabric);

  // OOB endpoints: BMC ports of IT racks, facility controllers, and every switch's management port.
  const oobBase = new Map<string, EndpointLinks[]>();
  if (net.oob.enabled) {
    for (const p of ctx.placed) {
      const ports = p.item.compute?.oobPorts ?? (p.item.category === 'mgmt-rack' ? 8 : FACILITY_ENDPOINT_CATEGORIES.has(p.item.category) ? 1 : 0);
      const ep = endpointLinks(p, ports, 1, oobSw.switch?.portGbps ?? 1);
      if (!ep) continue;
      const k = podKey(p.e);
      const arr = oobBase.get(k);
      if (arr) arr.push(ep);
      else oobBase.set(k, [ep]);
    }
  }
  // front-end spines also aggregate the OOB leaves' 100G uplinks (estimate before placement)
  const fePre = sizeFabric({ key: 'frontend', fabric: net.frontend.fabric, sw: feSw, oversubscription: net.frontend.oversubscription, tiers: 'auto', topology: 'leaf-spine', endpointsByPod: feEndpoints, rails: 1, kind: 'clos' });
  const switchesEst = soPlan.leaves + soPlan.spines + soPlan.cores + fePre.leaves + fePre.spines + (stPlan ? stPlan.leaves + stPlan.spines : 0);
  const extraSwitchesEst = [...(scope.oobExtraSwitches?.values() ?? [])].reduce((s, n) => s + n, 0);
  const oobEndpointsEst = [...oobBase.values()].flat().reduce((s, e) => s + e.links, 0) + switchesEst + extraSwitchesEst;
  const oobLeavesEst = net.oob.enabled ? Math.ceil(oobEndpointsEst / (oobSw.switch?.ports ?? 48)) : 0;
  // autosize v2 2차: a scope without any front-end port (e.g. NPU racks whose hosts sit outside the hall, no services racks) has no front-end
  // fabric to aggregate the OOB leaves on — their uplinks go to the site management network (not modelled) instead of counting as unconnected
  const hasFrontend = [...feEndpoints.values()].some((eps) => eps.length > 0);
  if (net.frontend.enabled && !hasFrontend && oobLeavesEst > 0) notes.push('No front-end ports in this scope: the OOB leaves uplink to the site management network (outside the hall model).');
  const fePlan = net.frontend.enabled && hasFrontend
    ? sizeFabric({
        key: 'frontend',
        fabric: net.frontend.fabric,
        sw: feSw,
        oversubscription: net.frontend.oversubscription,
        tiers: 'auto',
        topology: 'leaf-spine',
        endpointsByPod: feEndpoints,
        rails: 1,
        kind: 'clos',
        extraSpinePorts: Math.ceil((oobLeavesEst * OOB_UPLINKS_PER_LEAF * OOB_UPLINK_GBPS) / (feSw.switch?.portGbps ?? 400)),
      })
    : undefined;
  tagPlan(stPlan, scope.auxSuffix);
  tagPlan(fePlan, scope.auxSuffix);

  // ── placement policy ──
  const computePods = new Set<string>();
  for (const [pod, list] of ctx.byPod) if (list.some((p) => p.item.category === 'gpu-rack')) computePods.add(pod);
  const leafPolicy = normalizeLeafPlacement(so.leafPlacement);
  const torRequested = leafPolicy === 'tor';
  const torMode = torRequested && isHgxType(ctx.gpuRack);
  if (torRequested && !torMode) notes.push(`리프 위치 'tor'는 HGX형 랙(노드 = 스케일업 도메인)에만 적용됩니다 — ${ctx.gpuRack?.name ?? 'NVL72급 랙'}은 'mid-row'(포드 네트워크 랙)로 대체합니다.`);
  const spinePolicy = normalizeSpinePlacement(so.spinePlacement);

  // ── place switches into network racks (+ HGX compute racks when ToR) ──
  // racks reserved for an inter-hall core (T1 layout, networkRole 'inter-hall-core') only host the joined cluster's super-spines
  const hosts: Host[] = ctx.placed
    .filter((p) => p.item.category === 'network-rack' && p.e.networkRole !== 'inter-hall-core')
    .map((rack) => ({ rack, ru: 0, kw: 0, ruCap: rack.item.rackUnits ?? 42, kwCap: RACK_KW_CAPACITY, entries: [] }));
  if (torMode) {
    for (const p of ctx.placed) {
      if (p.item.category !== 'gpu-rack' || !isHgxType(p.item)) continue;
      const spare = torSpareRU(p.item);
      if (spare <= 0) continue;
      hosts.push({ rack: p, ru: 0, kw: 0, ruCap: spare, kwCap: TOR_KW_CAPACITY, entries: [], tor: true });
    }
    notes.push(`ToR: HGX형 컴퓨트 랙의 여유 U(랙당 ${torSpareRU(ctx.gpuRack!)}U, 추정)에 스케일아웃 리프를 배치합니다 — 노드↔리프 링크는 랙 내 DAC.`);
  }
  const unplaced: NonNullable<NetworkAnalysis['unplacedSwitches']> = [];

  const podCentroid = (pod: string, plan?: FabricPlan) => {
    const eps = plan?.endpointsByPod.get(pod) ?? [];
    const pts = eps.length ? eps.map((e) => siteXY(e.rack)) : (ctx.byPod.get(pod) ?? []).map(siteXY);
    if (!pts.length) return { x: 0, y: 0 };
    return { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length };
  };
  const byDistance = (from: { x: number; y: number }) => [...hosts].filter((h) => !h.tor).sort((a, b) => manhattan(siteXY(a.rack), from) - manhattan(siteXY(b.rack), from) || a.rack.e.tag.localeCompare(b.rack.e.tag));
  const podHosts = (pod: string, roles: readonly string[] | null) => hosts.filter((h) => !h.tor && podKey(h.rack.e) === pod && (roles === null || roles.includes(roleOf(h))));
  const torHosts = (pod: string) => hosts.filter((h) => h.tor && podKey(h.rack.e) === pod);

  // network-core rows emitted by the layout engine (S1) — members are the preferred central spine/core hosts
  const coreRowMembers = new Set<string>();
  for (const hall of project.halls.filter((h) => ctx.byHall.has(h.id))) {
    try {
      for (const row of detectRowGroups(project, hall)) if (row.kind === 'network-core') row.memberIds.forEach((id) => coreRowMembers.add(id));
    } catch {
      /* rows not available */
    }
  }
  const isSpineRole = (h: Host) => roleOf(h) === 'scale-out-spine' || roleOf(h) === 'scale-out-core';
  const inCompute = (h: Host) => computePods.has(podKey(h.rack.e));
  const CENTRAL_ROLES = ['scale-out-spine', 'scale-out-core', 'storage', 'mixed'];
  // qa-autosize v2 2차: overflow hosts are taken nearest the hall's aggregation zone (centroid of the network racks outside compute pods),
  // not in rack-list order — 16-DU halls put front-end leaves into the far-corner scale-out leaf rack of the first pod (DU05-A-NET1 →
  // SVC-FEN17 100.5 m) and, with full central racks, front-end spines into that pod (DU20-B-NET3 → DU05-B-NET3 107.5 m). Deterministic (tag tie-break).
  const aggAnchor = new Map<string, { x: number; y: number; n: number }>();
  for (const h of hosts) {
    if (h.tor || inCompute(h)) continue;
    const q = siteXY(h.rack);
    const acc = aggAnchor.get(h.rack.e.hallId) ?? { x: 0, y: 0, n: 0 };
    aggAnchor.set(h.rack.e.hallId, { x: acc.x + q.x, y: acc.y + q.y, n: acc.n + 1 });
  }
  const nearAgg = (list: Host[]): Host[] =>
    list
      .map((h, i) => {
        const a = aggAnchor.get(h.rack.e.hallId);
        return { h, i, d: a ? manhattan(siteXY(h.rack), { x: a.x / a.n, y: a.y / a.n }) : 0 };
      })
      .sort((p, q) => p.d - q.d || p.i - q.i)
      .map((x) => x.h);
  const centralPool = () => uniq([...hosts.filter((h) => !h.tor && coreRowMembers.has(h.rack.e.id)), ...hosts.filter((h) => !h.tor && isSpineRole(h) && !inCompute(h)), ...hosts.filter((h) => !h.tor && isSpineRole(h)), ...hosts.filter((h) => !h.tor && CENTRAL_ROLES.includes(roleOf(h))), ...nearAgg(hosts.filter((h) => !h.tor))]);
  const distributedPool = () => hosts.filter((h) => !h.tor && isSpineRole(h) && inCompute(h));
  let effectiveSpine = spinePolicy;
  const spineHostsFor = (plan: FabricPlan): Host[] => {
    if (plan.key !== 'scale-out') return centralPool();
    if (spinePolicy === 'distributed') {
      const d = distributedPool();
      if (d.length > 0) return uniq([...d, ...centralPool()]);
      effectiveSpine = 'central-end';
      notes.push('스파인 위치 \'distributed\'가 요청되었지만 컴퓨트 포드 안에 networkRole=scale-out-spine 랙이 없어 서비스/네트워크 코어 열에 배치합니다 (배치 엔진이 포드 내 스파인 랙을 생성하면 자동 반영).');
      return centralPool();
    }
    return centralPool();
  };

  const leafCandidates = (plan: FabricPlan, pod: string): Host[] => {
    const aux = ['frontend', 'mixed', 'storage', 'oob'];
    const preferred =
      plan.key === 'scale-out'
        ? [...(torMode ? torHosts(pod) : []), ...podHosts(pod, ['scale-out-leaf']), ...podHosts(pod, ['mixed'])]
        : [...podHosts(pod, aux), ...nearAgg(podHosts(pod, ['scale-out-leaf']))];
    return uniq([...preferred, ...podHosts(pod, null), ...byDistance(podCentroid(pod, plan))]);
  };

  const place = (plan: FabricPlan, role: Role, pod: string | undefined, count: number, candidates: Host[]) => {
    if (count <= 0) return;
    const sw = role === 'leaf' ? plan.sw : spineSwOf(plan);
    const left = placeInto(candidates, plan.key, role, pod, sw, count);
    if (left > 0) unplaced.push({ fabric: plan.label, role, catalogId: sw.id, count: left, podId: pod });
  };

  const auxPlans = [fePlan, stPlan].filter((p): p is FabricPlan => !!p);
  const hasDedicatedRacks = (pod: string) => podHosts(pod, ['scale-out-leaf', 'frontend', 'mixed', 'storage', 'oob']).length > 0;

  // (a) scale-out leaves in their pods
  for (const [pod, n] of soPlan.leavesByPod) place(soPlan, 'leaf', pod, n, leafCandidates(soPlan, pod));
  // (b) aux leaves in pods with dedicated network racks
  for (const plan of auxPlans) for (const [pod, n] of plan.leavesByPod) if (hasDedicatedRacks(pod)) place(plan, 'leaf', pod, n, leafCandidates(plan, pod));
  // (c) spines / cores per placement policy, biggest switches first
  const central: { plan: FabricPlan; role: Role; count: number }[] = [];
  for (const plan of [soPlan, ...auxPlans]) {
    if (plan.spines > 0) central.push({ plan, role: 'spine', count: plan.spines });
    if (plan.cores > 0) central.push({ plan, role: 'core', count: plan.cores });
  }
  central.sort((a, b) => (spineSwOf(b.plan).power?.nameplateKW ?? 0) - (spineSwOf(a.plan).power?.nameplateKW ?? 0));
  for (const c of central) place(c.plan, c.role, undefined, c.count, spineHostsFor(c.plan));
  // (d) aux leaves in pods without dedicated racks (e.g. services row)
  for (const plan of auxPlans) for (const [pod, n] of plan.leavesByPod) if (!hasDedicatedRacks(pod)) place(plan, 'leaf', pod, n, leafCandidates(plan, pod));

  // OOB: endpoints now include the management port of every placed switch — including the OOB leaves themselves (fix v2 2차: the
  // first pass cannot know where OOB leaves land, so their mgmt0 ports were missing; re-size once with the placed OOB leaves counted)
  let oobPlan: FabricPlan | undefined;
  if (net.oob.enabled) {
    const oobCount = (h: Host) => h.entries.filter((e) => e.fabric === 'oob').reduce((s, e) => s + e.count, 0);
    let oobInHost = new Map<Host, number>();
    for (let pass = 0; pass < 3; pass++) {
      if (oobPlan) {
        // undo the previous pass's OOB placement
        for (const h of hosts) {
          for (const e of h.entries.filter((x) => x.fabric === 'oob')) {
            h.ru -= e.count * (e.sw.switch?.rackUnits ?? 1);
            h.kw -= e.count * (e.sw.power?.nameplateKW ?? 0);
          }
          h.entries = h.entries.filter((x) => x.fabric !== 'oob');
        }
        const label = oobPlan.label;
        for (let k = unplaced.length - 1; k >= 0; k--) if (unplaced[k].fabric === label) unplaced.splice(k, 1);
      }
      const oobEndpoints = new Map<string, EndpointLinks[]>();
      for (const [k, v] of oobBase) oobEndpoints.set(k, [...v]);
      for (const h of hosts) {
        const n = h.entries.reduce((s, e) => s + e.count, 0) + (oobInHost.get(h) ?? 0);
        const ep = endpointLinks(h.rack, n, 1, oobSw.switch?.portGbps ?? 1);
        if (!ep) continue;
        const k = podKey(h.rack.e);
        const arr = oobEndpoints.get(k);
        if (arr) arr.push(ep);
        else oobEndpoints.set(k, [ep]);
      }
      for (const [rackId, n] of scope.oobExtraSwitches ?? []) {
        const rack = ctx.placed.find((p) => p.e.id === rackId);
        const ep = rack ? endpointLinks(rack, n, 1, oobSw.switch?.portGbps ?? 1) : null;
        if (!rack || !ep) continue;
        const k = podKey(rack.e);
        const arr = oobEndpoints.get(k);
        if (arr) arr.push(ep);
        else oobEndpoints.set(k, [ep]);
      }
      oobPlan = sizeFabric({ key: 'oob', fabric: net.oob.fabric, sw: oobSw, oversubscription: 1, tiers: 'auto', topology: 'leaf-spine', endpointsByPod: oobEndpoints, rails: 1, kind: 'clos' });
      tagPlan(oobPlan, scope.auxSuffix);
      for (const [pod, n] of oobPlan.leavesByPod) place(oobPlan, 'leaf', pod, n, leafCandidates(oobPlan, pod));
      const now = new Map(hosts.map((h) => [h, oobCount(h)] as const));
      const same = hosts.every((h) => (now.get(h) ?? 0) === (oobInHost.get(h) ?? 0));
      oobInHost = now;
      if (same) break;
    }
  }

  const plans = [soPlan, fePlan, stPlan, oobPlan].filter((p): p is FabricPlan => !!p && p.links > 0);

  // ── cabling ──
  const runs = new Map<string, CableRun>();
  const unreachable: string[] = [];
  let unconnected = 0;
  /** backlog #10 (stream C): OOB leaf uplinks that fit no front-end spine or leaf lane — they keep the spine split and end at '?' in the schedule */
  let oobUnterminated = 0;
  const seq = scope.seq ?? { n: 0 };
  const addRun = (plan: FabricPlan, tier: NonNullable<CableRun['tier']>, from: Placed, to: Placed, gbps: number, count: number, railCounts?: number[]) => {
    if (count <= 0) return;
    const len = cableLengthM(project, from, to);
    const choice = chooseCable(project, gbps, len);
    if (!choice.ok) unreachable.push(`${from.e.tag}→${to.e.tag} ${len} m @${gbps}G`);
    const key = `${plan.key}|${tier}|${from.e.id}|${to.e.id}|${choice.type.id}`;
    const r = runs.get(key);
    if (r) {
      r.count += count;
      if (railCounts && r.railCounts) railCounts.forEach((v, i) => (r.railCounts![i] = (r.railCounts![i] ?? 0) + v));
    } else runs.set(key, { id: `cr-${plan.key}-${++seq.n}`, fabric: plan.label, fromId: from.e.id, toId: to.e.id, lengthM: len, cableTypeId: choice.type.id, count, speedGbps: gbps, tier, fabricKey: plan.key, ...(scope.clusterId ? { clusterId: scope.clusterId } : {}), ...(railCounts ? { railCounts: [...railCounts] } : {}) });
  };

  const hostsWith = (plan: FabricPlan, role: Role, pod?: string) =>
    hosts
      .map((h) => ({ h, n: h.entries.filter((e) => e.fabric === plan.key && e.role === role && (pod === undefined || e.pod === pod)).reduce((s, e) => s + e.count, 0) }))
      .filter((x) => x.n > 0);

  // OOB leaf capacity shared across pods: facility endpoints without a pod (CRAHs, CDUs on the walls) take the nearest OOB leaf of the
  // hall instead of the leaves placed for their pod-less group (fix v2 2차, QA: CRAH-W01 → SVC-COR39 105.5 m at 1G)
  const oobCap = new Map<Host, number>();
  for (const plan of plans) {
    // endpoints → leaves
    for (const [pod, eps] of plan.endpointsByPod) {
      const podless = plan.key === 'oob' && pod.startsWith('hall:');
      const leafHosts = podless ? hostsWith(plan, 'leaf') : hostsWith(plan, 'leaf', pod);
      if (!leafHosts.length) {
        unconnected += eps.reduce((s, e) => s + e.links, 0);
        continue;
      }
      const sorted = [...eps].sort((a, b) => a.rack.e.tag.localeCompare(b.rack.e.tag));
      const railSpread = plan.key === 'scale-out' && plan.topology === 'rail-optimized' && !(torMode && plan.key === 'scale-out');
      if (railSpread) {
        // fix v2 2차 (QA B2/B3): leaf i of the pod (rack-tag order, then top-down — links.ts SwitchUnit.rail) serves rail i mod R;
        // each endpoint's links are split per rail over the racks holding that rail's leaves, capped at their free downlinks
        // (the excess is unconnected instead of landing on uplink ports)
        const R = Math.max(1, rails);
        const lh = [...leafHosts].sort((a, b) => a.h.rack.e.tag.localeCompare(b.h.rack.e.tag) || a.h.rack.e.id.localeCompare(b.h.rack.e.id));
        let off = 0;
        const room = lh.map((x) => {
          const r = new Array<number>(R).fill(0);
          for (let i = 0; i < x.n; i++) r[(off + i) % R] += plan.downPerLeaf;
          off += x.n;
          return r;
        });
        for (const ep of sorted) {
          const portsPerLink = ep.switchPorts / ep.links;
          const perRail = distribute(ep.links, new Array<number>(R).fill(1));
          const take = lh.map(() => new Array<number>(R).fill(0));
          for (let r = 0; r < R; r++) {
            const capLinks = room.map((x) => Math.floor(x[r] / portsPerLink + 1e-9));
            const shares = allocateByCapacity(perRail[r], capLinks);
            shares.forEach((s, i) => {
              take[i][r] += s;
              room[i][r] -= s * portsPerLink;
            });
            unconnected += perRail[r] - shares.reduce((s, v) => s + v, 0);
          }
          lh.forEach((x, i) => addRun(plan, 'endpoint-leaf', ep.rack, x.h.rack, ep.gbps, take[i].reduce((s, v) => s + v, 0), take[i]));
        }
      } else {
        // nearest leaf with free downlinks (ToR keeps links inside the rack; aux fabrics keep them in the row)
        const cap = plan.key === 'oob' ? oobCap : new Map<Host, number>();
        // backlog T3 (1): front-end / storage capacity counts only this pod's leaves in the host. A rack holding leaves of two pods
        // (Spectrum-X reference hall: DU02-B-NET2 = 5 pod-01 + 1 pod-02 front-end leaves) was otherwise filled once per pod — 432 links on
        // 252 downlink ports, 180 cable ends 'NET2:?'. The cable schedule lands pod links on the pod's own leaves first (links.ts).
        for (const x of leafHosts) if (!cap.has(x.h)) cap.set(x.h, (plan.key === 'oob' ? hostsWith(plan, 'leaf').filter((y) => y.h === x.h).reduce((t, y) => t + y.n, 0) : x.n) * plan.downPerLeaf);
        for (const ep of sorted) {
          const portsPerLink = ep.switchPorts / ep.links;
          let left = ep.links;
          const near = [...leafHosts].sort((a, b) => cableLengthM(project, ep.rack, a.h.rack) - cableLengthM(project, ep.rack, b.h.rack));
          for (const x of near) {
            if (left <= 0) break;
            const can = Math.floor((cap.get(x.h) ?? 0) / portsPerLink + 1e-9);
            const take = Math.min(left, can);
            if (take <= 0) continue;
            cap.set(x.h, (cap.get(x.h) ?? 0) - take * portsPerLink);
            addRun(plan, 'endpoint-leaf', ep.rack, x.h.rack, ep.gbps, take);
            left -= take;
          }
          if (left > 0 && plan.key === 'oob' && !podless) {
            // qa-autosize v2 2차: pod-less facility endpoints (CRAHs / CDUs) take the nearest OOB leaf first, which can use up the last ports
            // of a pod's own leaves (1–5 links left over in 8 / 16-DU halls) — spill the rest to the nearest other OOB leaf of the scope
            const own = new Set(leafHosts.map((x) => x.h));
            const others = hostsWith(plan, 'leaf').filter((x) => !own.has(x.h));
            for (const x of others) if (!cap.has(x.h)) cap.set(x.h, x.n * plan.downPerLeaf);
            others.sort((a, b) => cableLengthM(project, ep.rack, a.h.rack) - cableLengthM(project, ep.rack, b.h.rack));
            for (const x of others) {
              if (left <= 0) break;
              const take = Math.min(left, Math.floor((cap.get(x.h) ?? 0) / portsPerLink + 1e-9));
              if (take <= 0) continue;
              cap.set(x.h, (cap.get(x.h) ?? 0) - take * portsPerLink);
              addRun(plan, 'endpoint-leaf', ep.rack, x.h.rack, ep.gbps, take);
              left -= take;
            }
          }
          if (left > 0) unconnected += left; // fix v2 2차 (QA B3): no free downlink left — never pile links onto a full leaf
        }
      }
    }
    const swGbps = plan.sw.switch?.portGbps ?? 400;
    // leaves → spines (every leaf's uplinks are spread across ALL spine hosts — the 2-tier spine is hall-shared)
    if (plan.tiers >= 2) {
      const spineHosts = hostsWith(plan, 'spine');
      const leafHostsAll = hostsWith(plan, 'leaf');
      // capacity-aware split: every placed spine takes an even share of all leaf uplinks, capped at its downlink ports, so per-rack
      // rounding never piles extra links onto the same spine racks; links beyond the placed capacity (unplaced spines) stay unconnected
      const spineK = spineSwOf(plan).switch?.ports ?? 64;
      // only the scale-out top tier of a joined hall reserves super-spine uplinks (front-end / storage / OOB stay hall-local)
      const joinedTop = !!scope.joinUplinks && plan.key === 'scale-out';
      const spineDown = plan.kind === 'ddc' ? spineK : plan.tiers === 3 ? Math.floor(spineK / 2) : joinedTop ? spineK - Math.floor(spineK / 2) : spineK;
      const totalUp = leafHostsAll.reduce((s, lh) => s + lh.n * plan.upPerLeaf, 0);
      const spineN = spineHosts.reduce((s, x) => s + x.n, 0);
      const perSpine = Math.min(spineDown, Math.ceil(totalUp / Math.max(1, spineN)));
      const spineRoom = spineHosts.map((s) => s.n * perSpine);
      for (const lh of leafHostsAll) {
        const uplinks = lh.n * plan.upPerLeaf;
        if (!spineHosts.length) {
          unconnected += uplinks;
          continue;
        }
        const shares = allocateByCapacity(uplinks, spineRoom);
        unconnected += uplinks - shares.reduce((s, v) => s + v, 0);
        spineHosts.forEach((s, i) => addRun(plan, 'leaf-spine', lh.h.rack, s.h.rack, swGbps, shares[i]));
      }
      if (plan.tiers === 3) {
        const coreHosts = hostsWith(plan, 'core');
        const P = Math.floor((plan.sw.switch?.ports ?? 64) / 2);
        const coreK = spineSwOf(plan).switch?.ports ?? 64;
        const coreDown = scope.joinUplinks ? coreK - Math.floor(coreK / 2) : coreK;
        const totalSpineUp = spineHosts.reduce((s, sh) => s + sh.n * P, 0);
        const coreN = coreHosts.reduce((s, x) => s + x.n, 0);
        const perCore = Math.min(coreDown, Math.ceil(totalSpineUp / Math.max(1, coreN)));
        const coreRoom = coreHosts.map((c) => c.n * perCore);
        for (const sh of spineHosts) {
          const uplinks = sh.n * P;
          if (!coreHosts.length) {
            unconnected += uplinks;
            continue;
          }
          const shares = allocateByCapacity(uplinks, coreRoom);
          unconnected += uplinks - shares.reduce((s, v) => s + v, 0);
          coreHosts.forEach((c, i) => addRun(plan, 'spine-core', sh.h.rack, c.h.rack, swGbps, shares[i]));
        }
      }
    }
  }
  // OOB leaf uplinks → front-end spines (or front-end leaves for single-tier front-ends)
  if (oobPlan && fePlan) {
    // fix v2 2차: when no front-end spine could be placed, aggregate on the front-end leaves instead of dropping every OOB uplink
    const spineTargets = fePlan.tiers >= 2 ? hostsWith(fePlan, 'spine') : [];
    const onLeaves = spineTargets.length === 0;
    const targets = onLeaves ? hostsWith(fePlan, 'leaf') : spineTargets;
    // on front-end leaves only the downlink lanes the endpoints left free are available (100G lanes of a feSw port)
    const lanesPerPort = Math.max(1, Math.round((fePlan.sw.switch?.portGbps ?? 400) / OOB_UPLINK_GBPS));
    const usedDown = new Map<string, number>();
    for (const r of runs.values()) if (r.tier === 'endpoint-leaf' && r.fabricKey === 'frontend') usedDown.set(r.toId, (usedDown.get(r.toId) ?? 0) + (r.count * (r.speedGbps ?? 0)) / (fePlan.sw.switch?.portGbps ?? 400));
    const leafRoom = targets.map((t) => (onLeaves ? Math.max(0, Math.floor((t.n * fePlan.downPerLeaf - (usedDown.get(t.h.rack.e.id) ?? 0)) * lanesPerPort + 1e-9)) : Infinity));
    // QA backlog (network lens): front-end spines whose downlinks the FE leaf uplinks already fill (generic RoCE reference: 64 of 64)
    // had OOB uplinks split onto them anyway → 162 `SVC-SPN0n:?` cable ends. The spine split is kept whenever it fits the spines' free
    // 100G lanes (so every schedule without overflow is unchanged); otherwise it follows the free lanes and spills onto front-end
    // leaves with free downlink lanes (hosts without FE spines — the cable schedule lands on spines first); the rest stays on the spines.
    const feSpineSw = spineSwOf(fePlan);
    const feSpineGbps = feSpineSw.switch?.portGbps ?? 400;
    // same downlinks as the fabric tier table (switch units in links.ts): DDC NCF = its ports; Spine = k (2-tier) or k / 2 (3-tier)
    const feLeafK = fePlan.sw.switch?.ports ?? 64;
    const feSpineDown = fePlan.kind === 'ddc' ? feSpineSw.switch?.ports ?? NCF_PORTS : fePlan.tiers === 3 ? Math.floor(feLeafK / 2) : feLeafK;
    const spineUsed = new Map<string, number>();
    if (!onLeaves) for (const r of runs.values()) if (r.tier === 'leaf-spine' && r.fabricKey === 'frontend') spineUsed.set(r.toId, (spineUsed.get(r.toId) ?? 0) + (r.count * (r.speedGbps ?? 0)) / feSpineGbps);
    const spineLanes = Math.max(1, Math.round(feSpineGbps / OOB_UPLINK_GBPS));
    const spineRoom = onLeaves ? [] : targets.map((t) => Math.max(0, Math.floor((t.n * feSpineDown - (spineUsed.get(t.h.rack.e.id) ?? 0)) * spineLanes + 1e-9)));
    const spillHosts = onLeaves ? [] : hostsWith(fePlan, 'leaf').filter((l) => !targets.some((t) => t.h === l.h));
    const spillRoom = spillHosts.map((l) => Math.max(0, Math.floor((l.n * fePlan.downPerLeaf - (usedDown.get(l.h.rack.e.id) ?? 0)) * lanesPerPort + 1e-9)));
    for (const oh of hostsWith(oobPlan, 'leaf')) {
      const want = oh.n * OOB_UPLINKS_PER_LEAF;
      if (!targets.length) {
        unconnected += want;
        continue;
      }
      if (onLeaves) {
        const shares = allocateByCapacity(want, leafRoom);
        unconnected += want - shares.reduce((s, v) => s + v, 0);
        targets.forEach((t, i) => addRun(oobPlan, 'uplink', oh.h.rack, t.h.rack, OOB_UPLINK_GBPS, shares[i]));
        continue;
      }
      let shares = distribute(want, targets.map((t) => t.n));
      if (shares.every((s, i) => s <= spineRoom[i])) shares.forEach((s, i) => (spineRoom[i] -= s));
      else {
        shares = allocateByCapacity(want, spineRoom);
        const rest = want - shares.reduce((s, v) => s + v, 0);
        const spill = rest > 0 ? allocateByCapacity(rest, spillRoom) : spillHosts.map(() => 0);
        spillHosts.forEach((l, i) => addRun(oobPlan, 'uplink', oh.h.rack, l.h.rack, OOB_UPLINK_GBPS, spill[i]));
        // what fits nowhere stays on the spines in the old proportions (as before this fix: unresolved schedule ends, no new issue)
        const left = rest - spill.reduce((s, v) => s + v, 0);
        if (left > 0) oobUnterminated += left;
        if (left > 0) distribute(left, targets.map((t) => t.n)).forEach((v, i) => (shares[i] += v));
      }
      targets.forEach((t, i) => addRun(oobPlan, 'uplink', oh.h.rack, t.h.rack, OOB_UPLINK_GBPS, shares[i]));
    }
  }

  const cableRuns = [...runs.values()];
  const agg = aggregateCables(project, cableRuns);

  const railAligned = soPlan.topology === 'rail-optimized' && rails > 1 && !torMode;
  const fabrics = plans.map((p) => ({ ...fabricAnalysis(p, `${fabricPrefix(p.key)} · ${p.label}`), ...(p.clusterId ? { clusterId: p.clusterId } : {}), ...(p === soPlan && railAligned ? { rails } : {}) }));
  const switchUSD = plans.reduce((s, p) => s + p.leaves * itemPriceUSD(project, p.sw) + (p.spines + p.cores) * itemPriceUSD(project, spineSwOf(p)), 0);
  const switchKW = fabrics.reduce((s, f) => s + f.powerKW, 0);
  const nicGbps = (ctx.gpuRack?.compute?.scaleOutPortGbps ?? 0) * (ctx.gpuRack?.compute?.scaleOutPortsPerGpu ?? 1);
  const lanes = nicGbps > 0 && soPlan.linkGbps > 0 ? Math.max(1, Math.round((ctx.gpuRack?.compute?.scaleOutPortGbps ?? 0) / (soSw.switch?.portGbps ?? 800))) : 1;

  const rackLoads: NetworkRackLoad[] = hosts
    .filter((h) => !h.tor || h.entries.length > 0)
    .map((h) => ({
      rackId: h.rack.e.id,
      ru: h.ru,
      ruCapacity: h.ruCap,
      kw: h.kw,
      kwCapacity: h.kwCap,
      switches: h.entries.map((e) => ({ fabric: plans.find((p) => p.key === e.fabric)?.label ?? e.fabric, role: e.role, catalogId: e.sw.id, count: e.count, podId: e.pod, fabricKey: e.fabric, ...(scope.clusterId ? { clusterId: scope.clusterId } : {}) })),
    }));

  return {
    plans,
    switchKW,
    notes,
    effectivePlacement: { leaf: torMode ? 'tor' : torRequested ? 'mid-row' : leafPolicy, spine: effectiveSpine },
    analysis: {
      fabrics,
      cableRuns,
      cablesByType: agg.byType,
      transceiverKW: agg.transceiverW / 1000,
      commEfficiency: soPlan.links > 0 ? commEfficiency(soPlan, nicGbps, lanes) : 1,
      costUSD: switchUSD + agg.cablingUSD,
      rackLoads,
      unplacedSwitches: unplaced,
      unconnectedLinks: unconnected,
      ...(oobUnterminated > 0 ? { oobUplinksUnterminated: oobUnterminated } : {}),
      unreachableRuns: unreachable,
    },
  };
}

/**
 * Split `total` links over hosts in proportion to their remaining port capacity, never beyond it; `remaining` is decremented in place.
 * Links beyond the remaining capacity are not assigned (Σ result ≤ total) — the caller counts them as unconnected.
 */
function allocateByCapacity(total: number, remaining: number[]): number[] {
  const room = remaining.map((r) => Math.max(0, r));
  const cap = room.reduce((s, v) => s + v, 0);
  const out = distribute(Math.min(total, cap), room);
  let excess = 0;
  for (let i = 0; i < out.length; i++) {
    if (out[i] > room[i]) {
      excess += out[i] - room[i];
      out[i] = room[i];
    }
  }
  for (let i = 0; excess > 0 && i < out.length; i++) {
    const add = Math.min(room[i] - out[i], excess);
    if (add > 0) {
      out[i] += add;
      excess -= add;
    }
  }
  for (let i = 0; i < out.length; i++) remaining[i] -= out[i];
  return out;
}

const fabricPrefix = (key: FabricKey) => (key === 'scale-out' ? 'Scale-out' : key === 'frontend' ? 'Front-end' : key === 'storage' ? 'Storage' : 'OOB');

/** Cable BOM aggregation shared by every scope and the inter-hall trunks. */
function aggregateCables(project: Project, cableRuns: readonly CableRun[]) {
  const byType = new Map<string, { cableTypeId: string; count: number; totalLengthM: number; transceivers: number }>();
  let transceiverW = 0;
  let cablingUSD = 0;
  const cableById = new Map(cableTypes().map((c) => [c.id, c]));
  for (const r of cableRuns) {
    const t = cableById.get(r.cableTypeId)!;
    const a = byType.get(t.id) ?? { cableTypeId: t.id, count: 0, totalLengthM: 0, transceivers: 0 };
    a.count += r.count;
    a.totalLengthM += r.count * r.lengthM;
    if (t.transceiverUSD > 0) a.transceivers += 2 * r.count;
    byType.set(t.id, a);
    // endpoint-side optics are assumed inside the IT rack nameplate; count switch-side ends only
    transceiverW += r.count * (r.tier === 'endpoint-leaf' ? 1 : 2) * wattsPerEnd(t);
    cablingUSD += r.count * cableUnitUSD(project, t, r.lengthM);
  }
  return { byType: [...byType.values()].sort((a, b) => b.count - a.count), transceiverW, cablingUSD };
}

/** Sub-context of the halls in `hallIds` (placed items reused — no catalog lookups). */
function scopeContext(ctx: Ctx, hallIds: readonly string[]): Ctx {
  const set = new Set(hallIds);
  const placed = ctx.placed.filter((p) => set.has(p.e.hallId));
  const byHall = new Map<string, Placed[]>();
  const byPod = new Map<string, Placed[]>();
  const gpuByModel = new Map<string, { item: CatalogItem; gpus: number }>();
  let gpus = 0;
  for (const p of placed) {
    const h = byHall.get(p.e.hallId);
    if (h) h.push(p);
    else byHall.set(p.e.hallId, [p]);
    const k = podKey(p.e);
    const arr = byPod.get(k);
    if (arr) arr.push(p);
    else byPod.set(k, [p]);
    const g = p.item.category === 'gpu-rack' ? (p.item.compute?.gpus ?? 0) : 0;
    if (g > 0) {
      gpus += g;
      const cur = gpuByModel.get(p.item.id) ?? { item: p.item, gpus: 0 };
      cur.gpus += g;
      gpuByModel.set(p.item.id, cur);
    }
  }
  let gpuRack: CatalogItem | undefined;
  let best = -1;
  for (const v of gpuByModel.values()) {
    if (v.gpus > best) {
      best = v.gpus;
      gpuRack = v.item;
    }
  }
  return { ...ctx, placed, unknown: [], byHall, byPod, gpus, gpuRack: gpuRack ?? ctx.gpuRack };
}

function clusterSummary(c: ClusterDef, gpus: number, fabrics: readonly FabricAnalysis[], runs: readonly CableRun[], interHall?: ClusterNetworkSummary['interHall']): ClusterNetworkSummary {
  const own = fabrics.filter((f) => f.clusterId === c.id);
  return {
    id: c.id,
    name: c.name,
    hallIds: c.hallIds,
    gpus,
    fabrics: own.map((f) => f.name),
    switches: own.reduce((s, f) => s + f.totalSwitches, 0),
    cables: runs.filter((r) => r.clusterId === c.id).reduce((s, r) => s + r.count, 0),
    ...(interHall ? { interHall } : {}),
  };
}

/**
 * Network analysis per cluster (DECISIONS-v2-2 F2, engines/cluster.ts):
 *  - a single populated hall → one scope (identical sizing to the v2 1차 hall-wide model);
 *  - otherwise every hall is sized as its own scope (leaves / spines / cores / front-end / storage / OOB) and switches only land in racks
 *    of that hall, so no cable leaves a hall;
 *  - halls joined by `project.clusters` keep their in-hall fabrics, their scale-out top tier (spines, or cores when 3-tier) reserves
 *    floor(k/2) uplinks per switch, and an inter-hall super-spine tier is added: super-spines = ceil(Σ top-tier switches · floor(k/2) ÷ k_ss),
 *    placed only in the zone hall's 'inter-hall-core' racks (else reported unplaced), cabled with single-mode trunks (DR/FR by reach,
 *    or `interHallCore.mediumCableTypeId`) whose length is interHallLengthM. A DriveNets FSE is never joined (no inter-FSE tier in the RA).
 * Plans are ordered with the largest cluster first, so `plans.find(key === 'scale-out')` (traffic, placement, fabric comparison) reads the
 * cluster that hosts the training job.
 */
export function analyzeNetworkCtx(ctx: Ctx): NetworkResult {
  const { project } = ctx;
  const populated = new Set(ctx.placed.map((p) => p.e.hallId));
  const defs = resolveClusters(project);
  const clusters = defs.map((c) => ({ ...c, hallIds: c.hallIds.filter((h) => populated.has(h)) })).filter((c) => c.hallIds.length > 0);
  const seq = { n: 0 };

  if (clusters.length <= 1 && (clusters[0]?.hallIds.length ?? 0) <= 1) {
    const c = clusters[0];
    const r = analyzeScope(ctx, c ? { seq, clusterId: c.id, clusterName: c.name } : { seq });
    r.analysis.clusters = c ? [clusterSummary(c, ctx.gpus, r.analysis.fabrics, r.analysis.cableRuns)] : [];
    return r;
  }

  const so = project.network.scaleOut;
  const isDdc = so.fabric === 'drivenets-fse';
  const hallName = (id: string) => ctx.halls.get(id)?.name ?? id;
  const extraNotes: string[] = [];
  const parts: { cluster: ClusterDef; hallId: string; sub: Ctx; r: NetworkResult; opts: ScopeOpts }[] = [];
  for (const c of clusters) {
    const joined = c.hallIds.length > 1;
    if (joined && isDdc) extraNotes.push(`Cluster '${c.name}': a DriveNets FSE cannot be joined across halls (the RA defines no inter-FSE tier) — each hall is sized as its own FSE and no inter-hall trunks are created.`);
    const join = joined && !isDdc;
    for (const hallId of c.hallIds) {
      const sub = scopeContext(ctx, [hallId]);
      const opts: ScopeOpts = { seq, clusterId: c.id, clusterName: c.name, soSuffix: ` · ${join ? c.name : hallName(hallId)}`, auxSuffix: ` · ${hallName(hallId)}`, joinUplinks: join };
      const r = analyzeScope(sub, opts);
      parts.push({ cluster: c, hallId, sub, r, opts });
    }
  }

  // ── inter-hall super-spine tier of joined clusters ──
  const extraRuns: CableRun[] = [];
  const extraLoads: NetworkRackLoad[] = [];
  const extraUnplaced: NonNullable<NetworkAnalysis['unplacedSwitches']> = [];
  const extraUnreachable: string[] = [];
  let extraSwitchUSD = 0;
  let extraSwitchKW = 0;
  const mergedPlans = new Map<string, FabricPlan>();
  const mergedFabrics = new Map<string, FabricAnalysis>();
  const interHall = new Map<string, NonNullable<ClusterNetworkSummary['interHall']>>();
  for (const c of clusters) {
    if (c.hallIds.length < 2 || isDdc) continue;
    const cp = parts.filter((p) => p.cluster.id === c.id);
    const withSo = cp.map((p) => ({ p, plan: p.r.plans.find((x) => x.key === 'scale-out') })).filter((x): x is { p: (typeof cp)[number]; plan: FabricPlan } => !!x.plan && x.plan.tiers >= 2);
    if (withSo.length < 2) continue;
    const def = defs.find((d) => d.id === c.id) ?? c;
    const ssw = resolveSwitchItem(def.interHallCore?.spineCatalogId || so.switchCatalogId, so.fabric);
    const kss = ssw.switch?.ports ?? 64;
    const zone = zoneHallOf({ ...def, hallIds: c.hallIds }) ?? c.hallIds[0];
    const soLabel = `${FABRIC_LABEL[so.fabric]} · ${c.name}`;

    // super-spines sized from the plans (radix): floor(k/2) uplinks per top-tier switch
    let planTrunks = 0;
    for (const { plan } of withSo) planTrunks += (plan.tiers === 3 ? plan.cores : plan.spines) * Math.floor((plan.sw.switch?.ports ?? 64) / 2);
    const superSpines = Math.ceil(planTrunks / kss - 1e-9);
    const zoneHosts: Host[] = ctx.placed
      .filter((p) => p.e.hallId === zone && p.item.category === 'network-rack' && p.e.networkRole === 'inter-hall-core')
      .sort((a, b) => a.e.tag.localeCompare(b.e.tag))
      .map((rack) => ({ rack, ru: 0, kw: 0, ruCap: rack.item.rackUnits ?? 42, kwCap: RACK_KW_CAPACITY, entries: [] }));
    const left = placeInto(zoneHosts, 'scale-out', 'core', undefined, ssw, superSpines);
    const placedSS = superSpines - left;
    if (left > 0) {
      extraUnplaced.push({ fabric: soLabel, role: 'core', catalogId: ssw.id, count: left, podId: `inter-hall:${zone}` });
      extraNotes.push(`Cluster '${c.name}': ${left} of ${superSpines} inter-hall super-spines have no 'inter-hall-core' rack in ${hallName(zone)} — reserve them in the layout (network-core zone) or split the cluster.`);
    }
    // polish v2 2차: the zone hall's OOB was sized before the super-spines existed → re-run that hall's scope once with their mgmt0
    // ports counted (scale-out placement does not depend on OOB, so the trunk sources below are unchanged), so every super-spine
    // gets an OOB access port and a management IP within the OOB leaves' limits
    const ssByRack = new Map<string, number>();
    for (const h of zoneHosts) if (h.entries.length) ssByRack.set(h.rack.e.id, h.entries.reduce((s, e) => s + e.count, 0));
    const zonePart = cp.find((p) => p.hallId === zone);
    if (ssByRack.size && zonePart && project.network.oob.enabled) {
      zonePart.opts = { ...zonePart.opts, oobExtraSwitches: ssByRack };
      zonePart.r = analyzeScope(zonePart.sub, zonePart.opts);
    } else if (ssByRack.size && project.network.oob.enabled) {
      extraNotes.push(`Cluster '${c.name}': the super-spine hall ${hallName(zone)} has no populated scope — super-spine mgmt0 ports are not cabled to OOB.`);
    }
    for (const p of withSo) p.plan = p.p.r.plans.find((x) => x.key === 'scale-out') ?? p.plan;

    // trunk sources: the placed top-tier switches of each hall, floor(k/2) uplinks each
    const sources: { rack: Placed; count: number; gbps: number }[] = [];
    for (const { p, plan } of withSo) {
      const top = plan.tiers === 3 ? 'core' : 'spine';
      const up = Math.floor((plan.sw.switch?.ports ?? 64) / 2);
      for (const load of p.r.analysis.rackLoads ?? []) {
        const n = load.switches.filter((s) => s.fabricKey === 'scale-out' && s.role === top).reduce((s, x) => s + x.count, 0);
        const rack = n > 0 ? p.sub.placed.find((x) => x.e.id === load.rackId) : undefined;
        if (rack) sources.push({ rack, count: n * up, gbps: plan.sw.switch?.portGbps ?? 400 });
      }
    }
    for (const h of zoneHosts) {
      if (!h.entries.length) continue;
      extraLoads.push({ rackId: h.rack.e.id, ru: h.ru, ruCapacity: h.ruCap, kw: h.kw, kwCapacity: h.kwCap, switches: h.entries.map((e) => ({ fabric: soLabel, role: e.role, catalogId: e.sw.id, count: e.count, fabricKey: 'scale-out', interHall: true, clusterId: c.id })) });
    }
    extraSwitchUSD += superSpines * itemPriceUSD(project, ssw);
    extraSwitchKW += superSpines * (ssw.power?.nameplateKW ?? 0);

    const ssHosts = zoneHosts.filter((h) => h.entries.length > 0).map((h) => ({ h, n: h.entries.reduce((s, e) => s + e.count, 0) }));
    const sourceTotal = sources.reduce((s, x) => s + x.count, 0);
    const cabled = ssHosts.length ? Math.min(sourceTotal, placedSS * kss) : 0;
    const perSource = cabled > 0 ? distribute(cabled, sources.map((s) => s.count)) : sources.map(() => 0);
    const smfProject: Project = { ...project, network: { ...project.network, cabling: { ...project.network.cabling, preferSingleMode: true } } };
    const forced = def.interHallCore?.mediumCableTypeId ? cableTypes().find((t) => t.id === def.interHallCore!.mediumCableTypeId) : undefined;
    const trunkRuns = new Map<string, CableRun>();
    let maxLen = 0;
    let lenSum = 0;
    let crossCount = 0;
    let overReach = 0;
    let nearReach = 0;
    let reachM: number | undefined;
    let cableTypeId: string | undefined;
    sources.forEach((src, i) => {
      if (perSource[i] <= 0) return;
      const shares = distribute(perSource[i], ssHosts.map((x) => x.n));
      ssHosts.forEach((x, j) => {
        const count = shares[j];
        if (count <= 0) return;
        // fix v2 2차 (QA M4): trunks between the zone hall's own top tier and its super-spines follow the in-hall tray route
        const inHall = src.rack.e.hallId === x.h.rack.e.hallId;
        const len = inHall ? cableLengthM(project, src.rack, x.h.rack) : interHallLengthM(project, src.rack, x.h.rack);
        // trunk optics are selected with the DU-10438 planning margin (route ≤ 90 % of the media reach)
        const choice = inHall ? chooseCable(project, src.gbps, len) : (() => {
          const picked = forced ?? chooseCable(smfProject, src.gbps, Math.ceil(len / 0.9)).type;
          return { type: picked, ok: len <= picked.maxReachM };
        })();
        if (!choice.ok) extraUnreachable.push(`${src.rack.e.tag}→${x.h.rack.e.tag} ${len} m @${src.gbps}G (inter-hall trunk)`);
        const key = `${src.rack.e.id}|${x.h.rack.e.id}|${choice.type.id}`;
        const r = trunkRuns.get(key);
        if (r) r.count += count;
        else trunkRuns.set(key, { id: `cr-scale-out-${++seq.n}`, fabric: soLabel, fromId: src.rack.e.id, toId: x.h.rack.e.id, lengthM: len, cableTypeId: choice.type.id, count, speedGbps: src.gbps, tier: 'inter-hall', fabricKey: 'scale-out', clusterId: c.id });
        if (inHall) return; // mean / max / reach statistics describe the cross-hall trunks only
        crossCount += count;
        if (len >= maxLen) {
          // report the cable type and reach of the longest trunk
          reachM = choice.type.maxReachM;
          cableTypeId = choice.type.id;
        }
        maxLen = Math.max(maxLen, len);
        lenSum += len * count;
        if (len > choice.type.maxReachM) overReach += count;
        else if (len > 0.9 * choice.type.maxReachM) nearReach += count;
      });
    });
    extraRuns.push(...trunkRuns.values());
    const zoneOrigin = ctx.halls.get(zone)?.origin ?? { x: 0, y: 0 };
    interHall.set(c.id, {
      zoneHallId: zone,
      superSpineCatalogId: ssw.id,
      superSpines,
      placedSuperSpines: placedSS,
      trunks: cabled,
      ...(cableTypeId ? { cableTypeId } : {}),
      maxTrunkM: maxLen,
      meanTrunkM: crossCount > 0 ? lenSum / crossCount : 0,
      ...(reachM !== undefined ? { reachM } : {}),
      overReach,
      nearReach,
      hallDistancesM: c.hallIds.map((h) => {
        const o = ctx.halls.get(h)?.origin ?? { x: 0, y: 0 };
        return { hallId: h, distanceM: Math.abs(o.x - zoneOrigin.x) + Math.abs(o.y - zoneOrigin.y) };
      }),
    });

    // one scale-out fabric for the cluster: in-hall tiers summed + the super-spine tier
    const plans = withSo.map((x) => x.plan);
    const hallFabrics = withSo.map((x) => x.p.r.analysis.fabrics.find((f) => f.name.startsWith('Scale-out'))!).filter(Boolean);
    const k = plans[0].sw.switch?.ports ?? 64;
    const up = Math.floor(k / 2);
    const tiers3 = plans.some((p) => p.tiers === 3);
    const sum = (f: (p: FabricPlan) => number) => plans.reduce((s, p) => s + f(p), 0);
    const leaves = sum((p) => p.leaves);
    const spines = sum((p) => p.spines);
    const cores = sum((p) => p.cores);
    const links = sum((p) => p.links);
    const tiers: NetworkTier[] = [
      { name: 'Leaf', switches: leaves, portsPerSwitch: k, downlinks: plans[0].downPerLeaf, uplinks: plans[0].upPerLeaf },
      { name: 'Spine', switches: spines, portsPerSwitch: k, downlinks: k - up, uplinks: up },
      ...(tiers3 ? [{ name: 'Core', switches: cores, portsPerSwitch: k, downlinks: k - up, uplinks: up }] : []),
      { name: 'Super-spine (inter-hall)', switches: superSpines, portsPerSwitch: kss, downlinks: kss, uplinks: 0 },
    ];
    mergedFabrics.set(c.id, {
      name: `Scale-out · ${soLabel}`,
      fabric: so.fabric,
      endpoints: hallFabrics.reduce((s, f) => s + f.endpoints, 0),
      tiers,
      switchCatalogId: plans[0].sw.id,
      totalSwitches: leaves + spines + cores + superSpines,
      bisectionGbps: hallFabrics.reduce((s, f) => s + f.bisectionGbps, 0),
      oversubscription: plans[0].oversubscription,
      maxHops: tiers3 ? 7 : 5,
      powerKW: hallFabrics.reduce((s, f) => s + f.powerKW, 0) + superSpines * (ssw.power?.nameplateKW ?? 0),
      racksNeeded: hallFabrics.reduce((s, f) => s + f.racksNeeded, 0) + (superSpines > 0 ? Math.ceil(superSpines / switchesPerNetworkRack(ssw)) : 0),
      topology: plans[0].topology,
      linkGbps: plans[0].linkGbps,
      links,
      feasible: plans.every((p) => p.feasible),
      clusterId: c.id,
      ...(hallFabrics[0]?.rails ? { rails: hallFabrics[0].rails } : {}),
    });
    const endpointsByPod = new Map<string, EndpointLinks[]>();
    const leavesByPod = new Map<string, number>();
    for (const p of plans) {
      for (const [key, v] of p.endpointsByPod) endpointsByPod.set(key, v);
      for (const [key, v] of p.leavesByPod) leavesByPod.set(key, v);
    }
    const hallGpus = withSo.map((x) => x.p.sub.gpus).filter((g) => g > 0);
    mergedPlans.set(c.id, {
      ...plans[0],
      label: soLabel,
      endpointsByPod,
      leavesByPod,
      leaves,
      spines,
      cores: cores + superSpines,
      tiers: 3,
      feasible: plans.every((p) => p.feasible),
      links,
      linkGbps: links > 0 ? plans.reduce((s, p) => s + p.linkGbps * p.links, 0) / links : plans[0].linkGbps,
      notes: [...new Set(plans.flatMap((p) => p.notes))],
      clusterId: c.id,
      clusterName: c.name,
      clusterGpus: withSo.reduce((s, x) => s + x.p.sub.gpus, 0),
      gpusPerSpineDomain: hallGpus.length ? Math.min(...hallGpus) : undefined,
    });
  }

  // ── merge (largest cluster first) ──
  const gpusOf = (c: ClusterDef) => parts.filter((p) => p.cluster.id === c.id).reduce((s, p) => s + p.sub.gpus, 0);
  const ordered = [...clusters].sort((a, b) => gpusOf(b) - gpusOf(a));
  const plans: FabricPlan[] = [];
  const fabrics: FabricAnalysis[] = [];
  for (const c of ordered) {
    const cp = parts.filter((p) => p.cluster.id === c.id);
    const mp = mergedPlans.get(c.id);
    const mf = mergedFabrics.get(c.id);
    if (mp) plans.push(mp);
    for (const p of cp) for (const pl of p.r.plans) if (!(mp && pl.key === 'scale-out')) plans.push(pl);
    if (mf) fabrics.push(mf);
    for (const p of cp) for (const f of p.r.analysis.fabrics) if (!(mf && f.name.startsWith('Scale-out'))) fabrics.push(f);
  }
  const partRuns = parts.flatMap((p) => p.r.analysis.cableRuns);
  const cableRuns = [...partRuns, ...extraRuns];
  const agg = aggregateCables(project, cableRuns);
  const trunkAgg = aggregateCables(project, extraRuns);
  const primary = parts.find((p) => p.cluster.id === ordered[0]?.id) ?? parts[0];
  const summaries = clusters.map((c) => clusterSummary(c, gpusOf(c), fabrics, cableRuns, interHall.get(c.id)));

  return {
    plans,
    switchKW: parts.reduce((s, p) => s + p.r.switchKW, 0) + extraSwitchKW,
    notes: [...new Set([...parts.flatMap((p) => p.r.notes), ...extraNotes])],
    effectivePlacement: primary.r.effectivePlacement,
    analysis: {
      fabrics,
      cableRuns,
      cablesByType: agg.byType,
      transceiverKW: parts.reduce((s, p) => s + p.r.analysis.transceiverKW, 0) + trunkAgg.transceiverW / 1000,
      commEfficiency: primary.r.analysis.commEfficiency,
      costUSD: parts.reduce((s, p) => s + p.r.analysis.costUSD, 0) + extraSwitchUSD + trunkAgg.cablingUSD,
      rackLoads: [...parts.flatMap((p) => p.r.analysis.rackLoads ?? []), ...extraLoads],
      unplacedSwitches: [...parts.flatMap((p) => p.r.analysis.unplacedSwitches ?? []), ...extraUnplaced],
      unconnectedLinks: parts.reduce((s, p) => s + (p.r.analysis.unconnectedLinks ?? 0), 0),
      ...(parts.some((p) => (p.r.analysis.oobUplinksUnterminated ?? 0) > 0) ? { oobUplinksUnterminated: parts.reduce((s, p) => s + (p.r.analysis.oobUplinksUnterminated ?? 0), 0) } : {}),
      unreachableRuns: [...parts.flatMap((p) => p.r.analysis.unreachableRuns ?? []), ...extraUnreachable],
      clusters: summaries,
    },
  };
}
