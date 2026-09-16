import type { CatalogItem } from '../../model/types.ts';
import { composeRack, type NodeSpec } from '../compose.ts';
import { ACCELERATOR_FLOPS } from '../flops.ts';

/**
 * NVIDIA items missing from the curated catalog: HGX H100 / H200 / B300 8-GPU nodes (+ 4-node air racks composed
 * through the node → rack composer), Vera Rubin NVL72 (announced spec, NVIDIA product page and technical blog) and Spectrum-6
 * SN6600 / SN6800 switches. HGX B200 ×4 (`hgx-b200-air-4x`) already exists in catalog.ts.
 *
 * Per-GPU numbers are public datasheet values (dense TFLOPS); node power is the DGX datasheet maximum of the same
 * generation (public-spec); rack composition (4 nodes, 48U, air) is an estimate.
 */

const NV_LINKS = {
  h100: [{ label: 'NVIDIA H100 (product page)', url: 'https://www.nvidia.com/en-us/data-center/h100/' }, { label: 'DGX SuperPOD (RA)', url: 'https://www.nvidia.com/en-us/data-center/dgx-superpod/' }],
  h200: [{ label: 'NVIDIA H200 (product page)', url: 'https://www.nvidia.com/en-us/data-center/h200/' }],
  b300: [{ label: 'NVIDIA DGX B300', url: 'https://www.nvidia.com/en-us/data-center/dgx-b300/' }, { label: 'GB300 NVL72', url: 'https://www.nvidia.com/en-us/data-center/gb300-nvl72/' }],
  vr: [{ label: 'NVIDIA Vera Rubin (blog)', url: 'https://developer.nvidia.com/blog/nvidia-vera-rubin-pod-seven-chips-five-rack-scale-systems-one-ai-supercomputer/' }, { label: 'NVIDIA Vera Rubin NVL72 (product page)', url: 'https://www.nvidia.com/en-us/data-center/vera-rubin-nvl72/' }],
  sx: [{ label: 'Spectrum-X Ethernet', url: 'https://www.nvidia.com/en-us/networking/spectrumx/' }],
};

const hgxNics = (soGbps: number, feGbps: number): NodeSpec['nics'] => [
  { role: 'scale-out', count: 8, portsPerNic: 1, portGbps: soGbps },
  { role: 'frontend', count: 1, portsPerNic: 2, portGbps: feGbps },
  { role: 'storage', count: 1, portsPerNic: 2, portGbps: feGbps },
  { role: 'oob', count: 1, portsPerNic: 1, portGbps: 1 },
];

export const NVIDIA_NODES: NodeSpec[] = [
  {
    id: 'hgx-h100-node', vendor: 'OEM', model: 'HGX H100 8-GPU', name: 'HGX H100 8-GPU node (8U, air)', role: 'gpu',
    description: '8 × H100 SXM5 (700 W) on HGX baseboard, 2 × x86, 8 × 400G NICs, 8U air-cooled (DGX H100 class).',
    rackUnits: 8, weightKg: 130,
    power: { nameplateKW: 10.2, typicalKW: 8.2, idleKW: 2.0, peakKW: 10.2 },
    cooling: { kind: 'air', liquidFraction: 0, airflowM3s: 0.52, liquidFlowLpm: 0, maxInletC: 30 },
    cpu: { count: 2, model: 'x86 56C' }, memoryGB: 2048,
    gpu: {
      count: 8, model: 'H100 SXM5', memoryGB: 80, memBandwidthGBps: 3350, flopsPeak: 1.979e15, wattsW: 700,
      peakTflops: { fp64: 67, tf32: 495, bf16: 989, fp8: 1979 },
      scaleUp: { kind: 'nvlink', domainSize: 8, gbpsPerGpu: 7200 }, accelerator: { vendor: 'NVIDIA', family: 'Hopper', formFactor: 'sxm' },
    },
    nics: hgxNics(400, 200),
    cost: { capexUSD: 300_000, installHours: 6, leadTimeWeeks: 12 }, source: 'public-spec', links: NV_LINKS.h100,
    notes: 'DGX H100 max system power 10.2 kW, 130 kg (datasheet). H100 SXM: 80 GB HBM3 3.35 TB/s, 900 GB/s NVLink, dense TFLOPS fp8 1979 / bf16 989 / tf32 495 / fp64 67. Price estimate.',
  },
  {
    id: 'hgx-h200-node', vendor: 'OEM', model: 'HGX H200 8-GPU', name: 'HGX H200 8-GPU node (8U, air)', role: 'gpu',
    description: '8 × H200 SXM (700 W, 141 GB HBM3e) on HGX baseboard, 2 × x86, 8 × 400G NICs, 8U air-cooled.',
    rackUnits: 8, weightKg: 130,
    power: { nameplateKW: 10.2, typicalKW: 8.2, idleKW: 2.0, peakKW: 10.2 },
    cooling: { kind: 'air', liquidFraction: 0, airflowM3s: 0.52, liquidFlowLpm: 0, maxInletC: 30 },
    cpu: { count: 2, model: 'x86 56C' }, memoryGB: 2048,
    gpu: {
      count: 8, model: 'H200 SXM', memoryGB: 141, memBandwidthGBps: 4800, flopsPeak: 1.979e15, wattsW: 700,
      peakTflops: { fp64: 67, tf32: 495, bf16: 989, fp8: 1979 },
      scaleUp: { kind: 'nvlink', domainSize: 8, gbpsPerGpu: 7200 }, accelerator: { vendor: 'NVIDIA', family: 'Hopper', formFactor: 'sxm' },
    },
    nics: hgxNics(400, 200),
    cost: { capexUSD: 330_000, installHours: 6, leadTimeWeeks: 12 }, source: 'public-spec', links: NV_LINKS.h200,
    notes: 'Same compute as H100; 141 GB HBM3e at 4.8 TB/s (public spec). Node power as DGX H200 (10.2 kW). Price estimate.',
  },
  {
    id: 'hgx-b300-node', vendor: 'OEM', model: 'HGX B300 8-GPU', name: 'HGX B300 8-GPU node (10U, air)', role: 'gpu',
    description: '8 × Blackwell Ultra B300 (288 GB HBM3e) on HGX baseboard, 2 × x86, 8 × 800G (CX-8) NICs, 10U air-cooled (DGX B300 class).',
    rackUnits: 10, weightKg: 145,
    power: { nameplateKW: 14.3, typicalKW: 11.5, idleKW: 2.8, peakKW: 15.5 },
    cooling: { kind: 'air', liquidFraction: 0, airflowM3s: 0.72, liquidFlowLpm: 0, maxInletC: 30 },
    cpu: { count: 2, model: 'x86 64C' }, memoryGB: 4096,
    gpu: {
      count: 8, model: 'B300 (Blackwell Ultra)', memoryGB: 288, memBandwidthGBps: 8000, flopsPeak: 2.3e15, wattsW: 1400,
      peakTflops: { fp64: 1.2, tf32: 1100, ...ACCELERATOR_FLOPS.b300.peakTflops },
      scaleUp: { kind: 'nvlink', domainSize: 8, gbpsPerGpu: 14400 }, accelerator: { vendor: 'NVIDIA', family: 'Blackwell Ultra', formFactor: 'sxm' },
    },
    nics: hgxNics(800, 400),
    cost: { capexUSD: 520_000, installHours: 8, leadTimeWeeks: 20 }, source: 'public-spec', links: NV_LINKS.b300,
    notes: 'DGX B300 max 14.3 kW (datasheet). B300: 288 GB HBM3e 8 TB/s; bf16/fp8/fp4 = catalog/flops.ts B300 family (DGX B300 page: FP4 144 | 108 PFLOPS sparse | dense → 13.5 PF/GPU dense, vendor-claim; FP8 72 PF sparse → 4.5 PF dense, derived; BF16 2.25 PF estimate). tf32/fp64 estimates. gpuFlopsPeak 2.3e15 follows the GB300 convention of catalog.ts. Price estimate.',
  },
];

const hgxRack = (node: NodeSpec, id: string, name: string, color: string): CatalogItem => {
  const r = composeRack({ node, nodesPerRack: 4, rackModel: 'rack-48u-600x1200', id, name, color, source: 'public-spec' });
  r.notes = `${r.notes} Rack composition (4 nodes, 48U, air) is an estimate consistent with hgx-b200-air-4x; per-GPU values are public specs.`;
  r.links = node.links;
  return r;
};

const NVIDIA_RACKS: CatalogItem[] = [
  hgxRack(NVIDIA_NODES[0], 'hgx-h100-air-4x', 'HGX H100 Air-cooled Rack (4×8 GPU)', '#2b2f33'),
  hgxRack(NVIDIA_NODES[1], 'hgx-h200-air-4x', 'HGX H200 Air-cooled Rack (4×8 GPU)', '#2b2f33'),
  hgxRack(NVIDIA_NODES[2], 'hgx-b300-air-4x', 'HGX B300 Air-cooled Rack (4×8 GPU)', '#2b2f33'),
  {
    id: 'nvidia-vr-nvl72',
    category: 'gpu-rack',
    vendor: 'NVIDIA',
    model: 'Vera Rubin NVL72',
    name: 'Vera Rubin NVL72 (announced)',
    description: 'NVIDIA Vera Rubin NVL72 — 18 compute trays (72 Rubin GPUs, 36 Vera CPUs), 9 NVLink switch trays, 100% liquid-cooled MGX rack with power shelves and bus bar. Announced specification (NVIDIA product page).',
    dims: { w: 0.6, d: 1.2, h: 2.3 },
    weightKg: 1800,
    clearance: { front: 1.2, rear: 0.9, sides: 0 },
    power: { nameplateKW: 227, typicalKW: 190, idleKW: 60, peakKW: 260, rampUpKWps: 25, rampDownKWps: 25, feeds: 2, voltageV: 415 },
    cooling: { liquidFraction: 0.97, airflowM3s: 0.4, liquidFlowLpm: 160, maxInletC: 35, maxCoolantSupplyC: 45 },
    compute: {
      gpus: 72, gpuModel: 'Rubin', cpus: 36, cpuModel: 'Vera',
      scaleOutPortsPerGpu: 1, scaleOutPortGbps: 1600, frontendPorts: 18, frontendPortGbps: 800,
      storagePorts: 0, storagePortGbps: 800, oobPorts: 32,
      gpuMemoryGB: 288, gpuFlopsPeak: 8.3e15,
      memBandwidthGBps: 19444, railsPerNode: 4, nodesPerRack: 18, gpusPerNode: 4,
      // dense per-GPU basis (catalog/flops.ts): 3,600 PFLOPS NVFP4 / 1,260 PFLOPS FP8 rack headlines are sparse → ÷ 72 ÷ 2
      peakTflops: { ...ACCELERATOR_FLOPS.rubin.peakTflops },
      scaleUp: { kind: 'nvlink', domainSize: 72, gbpsPerGpu: 28900 },
      accelerator: { vendor: 'NVIDIA', family: 'Rubin', formFactor: 'custom' },
    },
    cost: { capexUSD: 6_500_000, installHours: 70, leadTimeWeeks: 36 },
    asset: { glb: 'generic_rack_eia48_dlc.glb', usd: 'usd/Generic/generic_rack_eia48_dlc.usd', color: '#2f3438' },
    source: 'announced',
    links: NV_LINKS.vr,
    notes: 'announced (NVIDIA Vera Rubin NVL72 product page, retrieved 2026-09-15): 72 Rubin GPUs / 36 Vera CPUs, 20.7 TB HBM4 (288 GB/GPU), 1,400 TB/s memory bandwidth (19.4 TB/s = memBandwidthGBps 19444 per GPU), NVFP4 inference 3,600 PFLOPS and FP8/FP6 training 1,260 PFLOPS per rack, inlet 45 °C; NVLink 6 scale-up 260 TB/s per rack (NVIDIA technical blog 2026-03-16; the product page lists 216 TB/s — scaleUp.gbpsPerGpu 28900 keeps the blog figure); ConnectX-9 SuperNIC 1.6 Tb/s class scale-out (announced). estimate (not published): rack power 227 kW nameplate / 260 kW peak and ramp, liquid fraction, flow, dimensions, weight, price.',
  },
  {
    // Optional Vera Rubin companion asset. No LPX : NVL72 deployment-unit ratio is published; it is not pre-wired into a template.
    id: 'nvidia-groq3-lpx',
    category: 'gpu-rack',
    vendor: 'NVIDIA',
    model: 'Groq 3 LPX',
    name: 'NVIDIA Groq 3 LPX (256 × LP30, announced)',
    description: 'NVIDIA Groq 3 LPX rack-scale inference accelerator (Groq LPU architecture), deployed beside Vera Rubin NVL72 for low-latency token generation. Announced: up to 256 LP30 accelerators per rack-scale deployment, full production (2026-08-24). Power, cooling, dimensions and I/O are not published — estimates.',
    dims: { w: 0.6, d: 1.2, h: 2.3 }, // estimate (assumed MGX-class frame like NVL72; not stated)
    weightKg: 1500, // estimate
    clearance: { front: 1.2, rear: 0.9, sides: 0 },
    power: { nameplateKW: 130, typicalKW: 110, idleKW: 35, peakKW: 140, rampUpKWps: 10, rampDownKWps: 10, feeds: 2, voltageV: 415 }, // estimate (not stated)
    cooling: { liquidFraction: 0.9, airflowM3s: 0.8, liquidFlowLpm: 100, maxInletC: 35, maxCoolantSupplyC: 45 }, // estimate (not stated)
    compute: {
      gpus: 256, // announced: "A rack-scale NVIDIA Groq 3 LPX deployment can include 256 LP30 accelerators"
      gpuModel: 'Groq LP30 (LPU)', cpus: 0, cpuModel: '-',
      scaleOutPortsPerGpu: 0, scaleOutPortGbps: 0, frontendPorts: 32, frontendPortGbps: 400, storagePorts: 0, storagePortGbps: 0, oobPorts: 34, // estimate
      // LP30 memory / bandwidth / FLOPs are unpublished: first-generation GroqChip values (GroqRack seed) as placeholders — estimate
      gpuMemoryGB: 0.23, gpuFlopsPeak: 1.88e14, memBandwidthGBps: 80000, railsPerNode: 0, peakTflops: { bf16: 188 },
      nodesPerRack: 32, gpusPerNode: 8, // estimate (tray split not stated; 32 × 8 = the announced 256)
      scaleUp: { kind: 'vendor-proprietary', family: 'Groq scale-up (details unpublished)', domainSize: 256, gbpsPerGpu: 0 },
      accelerator: { vendor: 'NVIDIA', family: 'Groq 3 LPU (LP30)', formFactor: 'custom' },
    },
    cost: { capexUSD: 3_000_000, installHours: 40, leadTimeWeeks: 26 }, // estimate
    asset: { color: '#3a2f22' },
    // item-level source is 'estimate' so the MFU basis never presents the placeholder FLOPs as a vendor claim; the stated figures are listed in meta.announcedFields
    source: 'estimate',
    meta: { rackClass: 'lpu-accelerator', specStatus: 'announced', announcedFields: ['compute.gpus (256 × LP30)', 'production status 2026-08-24', 'pairing with Vera Rubin NVL72'] },
    links: [
      { label: 'NVIDIA blog: Vera Rubin inference with Groq 3 LPX (2026-08-24)', url: 'https://blogs.nvidia.com/blog/vera-rubin-lpx-spectrum-x-nvlink-fusion/' },
      { label: 'NVIDIA news: Groq 3 LPX in full production (2026-08-24)', url: 'https://nvidianews.nvidia.com/news/nvidia-groq-3-lpx-now-in-full-production-with-world-class-speed-for-agentic-ai' },
      { label: 'NVIDIA Vera Rubin NVL72', url: 'https://www.nvidia.com/en-us/data-center/vera-rubin-nvl72/' },
    ],
    notes: 'announced: up to 256 LP30 accelerators per rack-scale LPX deployment (NVIDIA blog 2026-08-24); full production, Nebius first cloud (NVIDIA news 2026-08-24); 3,400 output tokens/s on Gemma 4 31B at 100k context (vendor claim); "up to 35x higher throughput per megawatt" when Vera Rubin NVL72 is paired with LPX (nvidia.com). NOT stated (estimates): rack power, cooling split, flow, dimensions, weight, front-end / OOB ports, price, lead time. LP30 memory, bandwidth and FLOPs are unpublished — the first-generation GroqChip values (0.23 GB SRAM, ~80 TB/s, 188 TFLOPS bf16) are placeholders, NOT LP30 figures; tray split 32 × 8 is an estimate. No recommended LPX : NVL72 ratio is published, so no default layout ratio is asserted.',
  },
];

const NVIDIA_SWITCHES: CatalogItem[] = [
  {
    id: 'nvidia-sn6600', category: 'switch', vendor: 'NVIDIA', model: 'Spectrum-6 SN6600', name: 'Spectrum-6 SN6600 (800GbE ×128, liquid)',
    description: 'Spectrum-6 Ethernet switch for Spectrum-X, 102.4 Tb/s, 128 × 800GbE, liquid-cooled (announced; SN6810 = CPO variant).',
    dims: { w: 0.44, d: 0.8, h: 0.178 }, weightKg: 50, clearance: { front: 0, rear: 0, sides: 0 },
    power: { nameplateKW: 5.0, typicalKW: 3.8, idleKW: 1.6, peakKW: 5.2, feeds: 2, voltageV: 230 },
    cooling: { liquidFraction: 0.8, airflowM3s: 0.1, liquidFlowLpm: 6, maxInletC: 35, maxCoolantSupplyC: 40 },
    switch: { fabric: 'spectrumx-800', ports: 128, portGbps: 800, rackUnits: 4, role: 'any' },
    cost: { capexUSD: 160_000, installHours: 6, leadTimeWeeks: 24 }, source: 'announced', links: NV_LINKS.sx,
    notes: 'Announced (NVIDIA Vera Rubin POD technical blog, 2026-03-16, retrieved 2026-09-15): 102.4 Tb/s Spectrum-6 switch with 512 lanes of 200 Gb/s (= 128 × 800G). Liquid cooling, power, RU, weight, flow and price are estimates (102.4T-class ASIC + optics).',
  },
  {
    id: 'nvidia-sn6800', category: 'switch', vendor: 'NVIDIA', model: 'Spectrum-6 SN6800', name: 'Spectrum-6 SN6800 (800GbE ×512, chassis, liquid)',
    description: 'Spectrum-6 chassis switch, 409.6 Tb/s, 512 × 800GbE, liquid-cooled (announced).',
    dims: { w: 0.44, d: 0.9, h: 0.71 }, weightKg: 220, clearance: { front: 0, rear: 0, sides: 0 },
    power: { nameplateKW: 20, typicalKW: 15, idleKW: 6, peakKW: 21, feeds: 2, voltageV: 230 },
    cooling: { liquidFraction: 0.8, airflowM3s: 0.4, liquidFlowLpm: 24, maxInletC: 35, maxCoolantSupplyC: 40 },
    switch: { fabric: 'spectrumx-800', ports: 512, portGbps: 800, rackUnits: 16, role: 'spine' },
    cost: { capexUSD: 700_000, installHours: 16, leadTimeWeeks: 28 }, source: 'announced', links: NV_LINKS.sx,
    notes: 'Spectrum-6 chassis class, 409.6 Tb/s / 512 × 800G (NVIDIA announcement; not re-verified on a public spec page 2026-09-15). Liquid cooling, 16 RU, 20 kW and price are estimates.',
  },
];

export const NVIDIA_EXTRA_CATALOG: CatalogItem[] = [...NVIDIA_RACKS, ...NVIDIA_SWITCHES];
