import type { CatalogItem } from '../../model/types.ts';
import { composeRack, type NodeSpec } from '../compose.ts';

/**
 * AMD Instinct MI3xx seeds (DECISIONS-v2 #6; UBB 2.0 = "UBB8", the vendor-neutral "HGX / UBB8" 8-GPU baseboard class, DECISIONS-v2-2 §E4): MI300X / MI325X air-cooled 8-OAM nodes, MI350X air node, MI355X DLC node
 * (+ air variant) and racks composed through the node → rack composer (4 nodes per rack per the AMD × DriveNets RA
 * "8-GPU server; ×4 per rack" annotation — Fig 10 / Fig 20 — tagged estimate; fewer for the hot air-cooled parts).
 *
 * Per-OAM values: AMD product pages / brochures (public-spec). Node kW: AMD MI3XX RA design assumption for MI355X
 * (~14 kW average per DLC system); MI300X/MI325X/MI350X nodes ~10–12 kW are estimates (OAM TBP × 8 + 2 CPUs + fabric).
 * Helios (72 × MI455X ORW) is owned by stream S5 (seeds/helios.ts).
 *
 * Sources: public AMD Instinct documentation and product pages cited per item (links / notes).
 */

const AMD_LINKS = {
  mi300x: [{ label: 'AMD Instinct MI300X', url: 'https://www.amd.com/en/products/accelerators/instinct/mi300/mi300x.html' }],
  mi325x: [{ label: 'AMD Instinct MI325X', url: 'https://www.amd.com/en/products/accelerators/instinct/mi300/mi325x.html' }],
  mi350: [
    { label: 'AMD Instinct MI350 series', url: 'https://www.amd.com/en/products/accelerators/instinct/mi350.html' },
    { label: 'MI350X GPU brochure (PDF)', url: 'https://www.amd.com/content/dam/amd/en/documents/instinct-tech-docs/product-briefs/amd-instinct-mi350x-gpu-brochure.pdf' },
  ],
  mi355x: [
    { label: 'AMD Instinct MI350 series', url: 'https://www.amd.com/en/products/accelerators/instinct/mi350.html' },
    { label: 'MI355X platform brochure (PDF)', url: 'https://www.amd.com/content/dam/amd/en/documents/instinct-tech-docs/product-briefs/amd-instinct-miI355x-platform-brochure.pdf' },
    { label: 'AMD MI3XX Reference Design', url: 'https://instinct.docs.amd.com/projects/MI3XX-reference/latest/index.html' },
  ],
  dc: [{ label: 'AMD Instinct Data Center Design Guide', url: 'https://instinct.docs.amd.com/projects/dc-design/latest/index.html' }],
};

/** 8 × 400G backend rails (Pollara 400 / Thor2), 2 × 100G frontend, 2 × 100G storage, BMC (AMD MI3XX RA generic BOM). */
const amdNics = (soGbps = 400): NodeSpec['nics'] => [
  { role: 'scale-out', count: 8, portsPerNic: 1, portGbps: soGbps, catalogId: 'amd-pollara-400' },
  { role: 'frontend', count: 1, portsPerNic: 2, portGbps: 100 },
  { role: 'storage', count: 1, portsPerNic: 2, portGbps: 100 },
  { role: 'oob', count: 1, portsPerNic: 1, portGbps: 1 },
];

/** 7 × Infinity Fabric (xGMI) links per GPU on UBB 2.0 — bidirectional sum quoted by AMD (see notes). Vendor-proprietary scale-up (stream B: was the legacy `xgmi` key). */
const xgmi = (gbPerLink: number, links: number) => ({ kind: 'vendor-proprietary' as const, family: 'Infinity Fabric', domainSize: 8, gbpsPerGpu: Math.round(gbPerLink * links * 8) });

export const AMD_NODES: NodeSpec[] = [
  {
    id: 'amd-mi300x-node', vendor: 'AMD / OEM', model: 'MI300X 8-OAM (UBB 2.0 / UBB8)', name: 'MI300X 8-OAM node (8U, air)', role: 'gpu',
    description: '8 × Instinct MI300X (750 W OAM, 192 GB HBM3) on UBB 2.0 (UBB8, the AMD counterpart of NVIDIA HGX), 2 × EPYC, 8 × 400G backend NICs; 8U air-cooled (Dell XE9680 / Lenovo SR685a V3 / SMCI AS-8125GS class).',
    rackUnits: 8, weightKg: 125,
    power: { nameplateKW: 10.5, typicalKW: 8.5, idleKW: 2.2, peakKW: 11.0 },
    cooling: { kind: 'air', liquidFraction: 0, airflowM3s: 0.55, liquidFlowLpm: 0, maxInletC: 35 },
    cpu: { count: 2, model: 'EPYC 9004 64C' }, memoryGB: 2304,
    gpu: {
      count: 8, model: 'Instinct MI300X', memoryGB: 192, memBandwidthGBps: 5300, flopsPeak: 1.3e15, wattsW: 750,
      peakTflops: { fp64: 81.7, fp32: 163.4, tf32: 653.7, bf16: 1307.4, fp8: 2614.9 },
      scaleUp: xgmi(128, 7), accelerator: { vendor: 'AMD', family: 'CDNA 3', formFactor: 'oam' },
    },
    nics: amdNics(),
    cost: { capexUSD: 260_000, installHours: 6, leadTimeWeeks: 10 }, source: 'public-spec', links: AMD_LINKS.mi300x,
    notes: 'OAM: 750 W peak TBP, 192 GB HBM3 5.3 TB/s, 896 GB/s peak Infinity Fabric (7 × 128 GB/s), dense matrix TFLOPS fp64 81.7 / bf16 1307 / fp8 2615 (AMD product page). Node kW (~10–12 kW class) and price are estimates. xGMI gbpsPerGpu = aggregate bidirectional sum.',
  },
  {
    id: 'amd-mi325x-node', vendor: 'AMD / OEM', model: 'MI325X 8-OAM (UBB 2.0 / UBB8)', name: 'MI325X 8-OAM node (8U, air)', role: 'gpu',
    description: '8 × Instinct MI325X (1,000 W OAM, 256 GB HBM3E) on UBB 2.0 (UBB8, the AMD counterpart of NVIDIA HGX), 2 × EPYC, 8 × 400G backend NICs; 8U air-cooled.',
    rackUnits: 8, weightKg: 128,
    power: { nameplateKW: 12.0, typicalKW: 9.8, idleKW: 2.4, peakKW: 12.6 },
    cooling: { kind: 'air', liquidFraction: 0, airflowM3s: 0.62, liquidFlowLpm: 0, maxInletC: 35 },
    cpu: { count: 2, model: 'EPYC 9005 64C' }, memoryGB: 2304,
    gpu: {
      count: 8, model: 'Instinct MI325X', memoryGB: 256, memBandwidthGBps: 6000, flopsPeak: 1.3e15, wattsW: 1000,
      peakTflops: { fp64: 81.7, fp32: 163.4, tf32: 653.7, bf16: 1307.4, fp8: 2614.9 },
      scaleUp: xgmi(128, 7), accelerator: { vendor: 'AMD', family: 'CDNA 3', formFactor: 'oam' },
    },
    nics: amdNics(),
    cost: { capexUSD: 300_000, installHours: 6, leadTimeWeeks: 10 }, source: 'public-spec', links: AMD_LINKS.mi325x,
    notes: 'OAM: 1,000 W peak TBP, 256 GB HBM3E 6 TB/s (AMD product page); compute as MI300X. Node kW (~12 kW) and price are estimates.',
  },
  {
    id: 'amd-mi350x-node', vendor: 'AMD / OEM', model: 'MI350X 8-OAM (UBB 2.0 / UBB8)', name: 'MI350X 8-OAM node (10U, air)', role: 'gpu',
    description: '8 × Instinct MI350X (1,000 W OAM, 288 GB HBM3E, CDNA 4) on UBB 2.0 (UBB8, the AMD counterpart of NVIDIA HGX), 2 × EPYC 9005, 8 × 400G backend NICs; up to 10U air-cooled.',
    rackUnits: 10, weightKg: 135,
    power: { nameplateKW: 12.0, typicalKW: 10.0, idleKW: 2.4, peakKW: 12.8 },
    cooling: { kind: 'air', liquidFraction: 0, airflowM3s: 0.66, liquidFlowLpm: 0, maxInletC: 35 },
    cpu: { count: 2, model: 'EPYC 9005 64C' }, memoryGB: 2304,
    gpu: {
      count: 8, model: 'Instinct MI350X', memoryGB: 288, memBandwidthGBps: 8000, flopsPeak: 2.3e15, wattsW: 1000,
      peakTflops: { fp64: 72, fp32: 144, bf16: 2300, fp8: 4600, fp4: 9200 },
      scaleUp: xgmi(153.6, 7), accelerator: { vendor: 'AMD', family: 'CDNA 4', formFactor: 'oam' },
    },
    nics: amdNics(),
    cost: { capexUSD: 360_000, installHours: 6, leadTimeWeeks: 12 }, source: 'public-spec', links: AMD_LINKS.mi350,
    notes: 'OAM: max TBP 1,000 W, 288 GB HBM3E 8 TB/s, 7 × 153.6 GB/s Infinity Fabric (MI350X brochure); dense bf16 2.3 PF / fp8 4.6 PF / fp4 9.2 PF (AMD). "Up to 10U air-cooled" per AMD. Node kW and price are estimates.',
  },
  {
    id: 'amd-mi355x-dlc-node', vendor: 'AMD / OEM', model: 'MI355X 8-OAM DLC (UBB 2.0 / UBB8)', name: 'MI355X 8-OAM node (4U, DLC)', role: 'gpu',
    description: '8 × Instinct MI355X (1,400 W OAM, 288 GB HBM3E, CDNA 4) on UBB 2.0 (UBB8) with cold plates, 2 × EPYC 9005 (liquid), 8 × 400G backend NICs; 4U DLC (Supermicro AS-4126GS-NMR-LCC / Dell XE9785L class). PG-25 coolant, max inlet 43 °C.',
    rackUnits: 4, weightKg: 120,
    power: { nameplateKW: 14.5, typicalKW: 14.0, idleKW: 3.5, peakKW: 16.0 },
    cooling: { kind: 'dlc', liquidFraction: 0.87, airflowM3s: 0.12, liquidFlowLpm: 20, maxInletC: 35, maxCoolantSupplyC: 43 },
    cpu: { count: 2, model: 'EPYC 9005 64C' }, memoryGB: 2304,
    gpu: {
      count: 8, model: 'Instinct MI355X', memoryGB: 288, memBandwidthGBps: 8000, flopsPeak: 2.5e15, wattsW: 1400,
      peakTflops: { fp64: 78.6, fp32: 157.3, bf16: 2516.6, fp8: 5033.2, fp4: 10066.3 },
      scaleUp: xgmi(153.6, 7), accelerator: { vendor: 'AMD', family: 'CDNA 4', formFactor: 'oam' },
    },
    nics: amdNics(),
    cost: { capexUSD: 400_000, installHours: 8, leadTimeWeeks: 12 }, source: 'public-spec', links: AMD_LINKS.mi355x,
    notes: '~14 kW average per DLC system = AMD MI3XX RA design assumption (256 systems ≈ 3.584 MW); nameplate/peak/idle are estimates. OAM: max TBP 1,400 W, 288 GB HBM3E 8 TB/s, dense bf16 2.5166 PF / fp8 5.0332 PF / MXFP4 10.07 PF, 7 × 153.6 GB/s xGMI (DriveNets RA Table 1 — 153 GB/s on p.20, "160 GB/s bidirectional" on p.11; gbpsPerGpu here is the 7-link bidirectional sum = 8.6 Tb/s). Brochure: PG-25, max liquid inlet 43 °C, 2.1 L/min per OAM (16.8 L/min + CPU ≈ 20 L/min per node, estimate). Liquid fraction 0.87 = GPUs + CPUs on cold plates; memory/NICs/drives to air.',
  },
  {
    id: 'amd-mi355x-air-node', vendor: 'AMD / OEM', model: 'MI355X 8-OAM air (UBB 2.0 / UBB8)', name: 'MI355X 8-OAM node (10U, air)', role: 'gpu',
    description: 'Air-cooled variant of the MI355X 8-OAM platform (AMD: air option, up to 10U). Same compute; higher fan power and inlet-temperature sensitivity.',
    rackUnits: 10, weightKg: 140,
    power: { nameplateKW: 15.0, typicalKW: 14.2, idleKW: 3.6, peakKW: 16.5 },
    cooling: { kind: 'air', liquidFraction: 0, airflowM3s: 0.85, liquidFlowLpm: 0, maxInletC: 30 },
    cpu: { count: 2, model: 'EPYC 9005 64C' }, memoryGB: 2304,
    gpu: {
      count: 8, model: 'Instinct MI355X', memoryGB: 288, memBandwidthGBps: 8000, flopsPeak: 2.5e15, wattsW: 1400,
      peakTflops: { fp64: 78.6, fp32: 157.3, bf16: 2516.6, fp8: 5033.2, fp4: 10066.3 },
      scaleUp: xgmi(153.6, 7), accelerator: { vendor: 'AMD', family: 'CDNA 4', formFactor: 'oam' },
    },
    nics: amdNics(),
    cost: { capexUSD: 395_000, installHours: 6, leadTimeWeeks: 12 }, source: 'estimate', links: AMD_LINKS.mi355x,
    notes: 'Air variant: chassis height, fan power (+0.5 kW), 30 °C max inlet and weight are estimates; OAM values are public spec (see DLC node).',
  },
];

const node = (id: string) => AMD_NODES.find((n) => n.id === id)!;

const amdRack = (nodeId: string, n: number, id: string, name: string, extraNote: string): CatalogItem => {
  const r = composeRack({ node: node(nodeId), nodesPerRack: n, rackModel: 'rack-48u-600x1200', id, name, color: '#3b2f33', source: 'estimate' });
  r.vendor = 'AMD / OEM';
  r.links = [...(node(nodeId).links ?? []), ...AMD_LINKS.dc];
  r.notes = `${r.notes} ${extraNote}`;
  return r;
};

export const AMD_CATALOG: CatalogItem[] = [
  amdRack('amd-mi300x-node', 4, 'amd-mi300x-air-4x', 'MI300X UBB8 Air-cooled Rack (4×8 OAM)', 'Nodes per rack (4, ~42 kW air) is an estimate: air-cooled MI300X/MI325X racks are typically 2–4 × 8U servers (AMD × DriveNets RA §12).'),
  amdRack('amd-mi325x-node', 3, 'amd-mi325x-air-3x', 'MI325X UBB8 Air-cooled Rack (3×8 OAM)', 'Nodes per rack (3, ~36 kW air) is an estimate within the AMD DC guide "hot/cold-aisle containment 30–50 kW" band; 4 nodes (~48 kW) needs RDHx.'),
  amdRack('amd-mi350x-node', 3, 'amd-mi350x-air-3x', 'MI350X UBB8 Air-cooled Rack (3×8 OAM)', 'Nodes per rack (3 × 10U, ~36 kW air) is an estimate; 4 × 10U would exceed 42–48U with a ToR switch.'),
  amdRack('amd-mi355x-dlc-node', 4, 'amd-mi355x-dlc-4x', 'MI355X UBB8 DLC Rack (4×8 OAM, ~58 kW)', '4 nodes per rack per the AMD × DriveNets RA Fig 10 / Fig 20 annotation "8-GPU server; ×4 per rack" (estimate: the RA gives no rack kW). Liquid-cooled analogue of hgx-b200-air-4x at nearly identical density; add a DriveNets 5300R ToR (2U, 1.14 kW) for the TOR-optimized FSE variant.'),
  amdRack('amd-mi355x-air-node', 2, 'amd-mi355x-air-2x', 'MI355X UBB8 Air-cooled Rack (2×8 OAM)', '2 air-cooled nodes per rack (~30 kW) is an estimate; the AMD DC guide recommends DLC above ~45–50 kW/rack.'),
];
