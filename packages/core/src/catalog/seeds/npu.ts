import type { CatalogItem } from '../../model/types.ts';
import { composeRack, maxNodesPerRack, findRackModel, type NodeSpec } from '../compose.ts';

/**
 * NPU / alternative accelerator seeds (DECISIONS-v2 #6): Intel Gaudi 3, Cerebras CS-3, Groq GroqRack, SambaNova SN40L-16,
 * Rebellions ATOM-Max / REBEL-Quad, FuriosaAI RNGD, HyperAccel Orion / Bertha, Tenstorrent Galaxy; Google TPU as a
 * cloud-only reference (category 'other', not placeable).
 *
 * Node-level values come from vendor pages / briefs (public-spec) where they exist; rack composition uses
 * `composeRack` with a per-rack kW cap by cooling type (RACK_KW_CAP, estimate). Anything the vendor does not publish
 * (idle power, weight, airflow, price) is an estimate — see each item's notes.
 *
 * Sources: public vendor pages cited per item (links / notes), retrieved 2026-09.
 */

const oob = { role: 'oob' as const, count: 1, portsPerNic: 1, portGbps: 1 };

export const NPU_NODES: NodeSpec[] = [
  {
    id: 'intel-gaudi3-hlb325-node', vendor: 'Intel / OEM', model: 'Gaudi 3 HLB-325 8-OAM', name: 'Gaudi 3 HLB-325 8-OAM node (8U, air)', role: 'gpu',
    description: '8 × Gaudi 3 HL-325L OAM (900 W air) on the HLB-325 baseboard (7.6 kW TDP), 2 × Xeon, 24 × 200GbE scale-out ports (3 per OAM; 21 per OAM for all-to-all scale-up). 8U air-cooled.',
    rackUnits: 8, weightKg: 120,
    power: { nameplateKW: 10.5, typicalKW: 8.6, idleKW: 2.0, peakKW: 11.0 },
    cooling: { kind: 'air', liquidFraction: 0, airflowM3s: 0.55, liquidFlowLpm: 0, maxInletC: 35 },
    cpu: { count: 2, model: 'Xeon 6 48C' }, memoryGB: 1024,
    gpu: {
      count: 8, model: 'Gaudi 3 HL-325L', memoryGB: 128, memBandwidthGBps: 3700, flopsPeak: 1.835e15, wattsW: 900,
      peakTflops: { bf16: 1835, fp8: 1835 },
      scaleUp: { kind: 'esun-ethernet', family: 'Gaudi integrated RoCE', domainSize: 8, gbpsPerGpu: 4200 }, accelerator: { vendor: 'Intel', family: 'Gaudi 3', formFactor: 'oam' },
    },
    nics: [{ role: 'scale-out', count: 8, portsPerNic: 3, portGbps: 200 }, { role: 'frontend', count: 1, portsPerNic: 2, portGbps: 100 }, oob],
    cost: { capexUSD: 150_000, installHours: 6, leadTimeWeeks: 10 }, source: 'public-spec',
    links: [{ label: 'Intel Gaudi 3 HLB-325 product brief (PDF)', url: 'https://cdrdv2-public.intel.com/817489/gaudi-3-ai-accelerator-hlb-325-baseboard-product-brief.pdf' }, { label: 'Intel Gaudi', url: 'https://www.intel.com/content/www/us/en/products/details/processors/ai-accelerators/gaudi.html' }],
    notes: 'Baseboard TDP 7.6 kW, OAM 900 W air / up to 1,200 W liquid (Hot Chips 2024); 128 GB HBM2e 3.7 TB/s, 1,835 TFLOPS BF16/FP8 per OAM; Ethernet scale-up = 21 × 200GbE RoCE per OAM (4.2 Tb/s, on-package NICs), scale-out = 3 × 200GbE per OAM. Node ~10.5 kW incl. hosts (estimate); price estimate.',
  },
  {
    id: 'cerebras-cs3', vendor: 'Cerebras', model: 'CS-3', name: 'Cerebras CS-3 (15U, WSE-3)', role: 'gpu',
    description: 'Wafer-scale system: 1 × WSE-3 (900k cores, 44 GB on-wafer SRAM), 15U chassis with internal closed water loop (heat to facility water or fans), redundant pumps/PSUs, 12 × 100GbE.',
    rackUnits: 15, weightKg: 300,
    power: { nameplateKW: 23, typicalKW: 20, idleKW: 5, peakKW: 25 },
    cooling: { kind: 'hybrid', liquidFraction: 0.9, airflowM3s: 0.2, liquidFlowLpm: 40, maxInletC: 30, maxCoolantSupplyC: 30 },
    cpu: { count: 0, model: '- (host servers external)' }, memoryGB: 0,
    gpu: {
      count: 1, model: 'WSE-3', memoryGB: 44, memBandwidthGBps: 21_000_000, flopsPeak: 6.25e16, wattsW: 20000,
      peakTflops: { bf16: 62500 },
      scaleUp: { kind: 'none', domainSize: 1, gbpsPerGpu: 0 }, accelerator: { vendor: 'Cerebras', family: 'WSE-3', formFactor: 'wafer' },
    },
    nics: [{ role: 'scale-out', count: 12, portsPerNic: 1, portGbps: 100 }, oob],
    cost: { capexUSD: 2_500_000, installHours: 24, leadTimeWeeks: 20 }, source: 'estimate',
    links: [{ label: 'Cerebras CS-3', url: 'https://www.cerebras.ai/system' }],
    notes: '~23 kW / 15U from secondary sources (ServeTheHome, Introl) — the Cerebras page does not state kW → estimate. WSE-3: 125 PFLOPS FP16 with sparsity (62.5 PF dense assumed), 44 GB SRAM at 21 PB/s. Cooling: internal water loop rejecting to facility water (hybrid; can be fan-only). MemoryPerGPU is on-wafer SRAM (MemoryX weight streaming is external). Price estimate.',
  },
  {
    id: 'rebellions-atom-max-server', vendor: 'Rebellions', model: 'ATOM-Max Server', name: 'Rebellions ATOM-Max Server (4U, 8 × ATOM-Max PCIe)', role: 'gpu',
    description: '4U server with up to 8 × ATOM-Max PCIe cards (350 W, 64 GB GDDR6 each, 128 TFLOPS FP16); ~3.4 kW typical, 4.3 kW max, air-cooled.',
    rackUnits: 4, weightKg: 45,
    power: { nameplateKW: 4.3, typicalKW: 3.4, idleKW: 0.8, peakKW: 4.3 },
    cooling: { kind: 'air', liquidFraction: 0, airflowM3s: 0.2, liquidFlowLpm: 0, maxInletC: 35 },
    cpu: { count: 2, model: 'x86 32C' }, memoryGB: 512,
    gpu: {
      count: 8, model: 'ATOM-Max', memoryGB: 64, memBandwidthGBps: 1024, flopsPeak: 1.28e14, wattsW: 350,
      peakTflops: { bf16: 128, fp8: 256 },
      scaleUp: { kind: 'pcie', domainSize: 8, gbpsPerGpu: 512 }, accelerator: { vendor: 'Rebellions', family: 'ATOM-Max', formFactor: 'pcie' },
    },
    nics: [{ role: 'frontend', count: 1, portsPerNic: 2, portGbps: 100 }, oob],
    cost: { capexUSD: 120_000, installHours: 3, leadTimeWeeks: 10 }, source: 'public-spec',
    links: [{ label: 'Rebellions ATOM-Max Server', url: 'https://rebellions.ai/rebellions-product/atom-max-server/' }],
    notes: 'Vendor page: "~3.4 kW" typical, "4.3 kW" max, 4U, up to 8 cards, 512 GB GDDR6 total; 128 TFLOPS FP16 per card. GDDR6 bandwidth (1 TB/s), fp8 (2×), PCIe scale-up bandwidth, weight and price are estimates.',
  },
  {
    id: 'rebellions-rebel-quad-node', vendor: 'Rebellions / OEM', model: 'REBEL-Quad 8-card', name: 'Rebellions REBEL-Quad 8-card node (8U, air)', role: 'gpu',
    description: '8 × REBEL-Quad PCIe accelerator cards (4-chiplet UCIe-A SoC, 144 GB HBM3E 4.8 TB/s, 2,048 TFLOPS FP8, up to 600 W, 2 × PCIe Gen5 x16) in an 8-card server; ~6.5 kW, air (liquid TBD).',
    rackUnits: 8, weightKg: 110,
    power: { nameplateKW: 6.8, typicalKW: 5.5, idleKW: 1.4, peakKW: 7.2 },
    cooling: { kind: 'air', liquidFraction: 0, airflowM3s: 0.4, liquidFlowLpm: 0, maxInletC: 35 },
    cpu: { count: 2, model: 'x86 48C' }, memoryGB: 1024,
    gpu: {
      count: 8, model: 'REBEL-Quad', memoryGB: 144, memBandwidthGBps: 4800, flopsPeak: 1.024e15, wattsW: 600,
      peakTflops: { bf16: 1024, fp8: 2048 },
      scaleUp: { kind: 'pcie', domainSize: 8, gbpsPerGpu: 1024 }, accelerator: { vendor: 'Rebellions', family: 'REBEL', formFactor: 'pcie' },
    },
    nics: [{ role: 'scale-out', count: 8, portsPerNic: 1, portGbps: 400 }, { role: 'frontend', count: 1, portsPerNic: 2, portGbps: 100 }, oob],
    cost: { capexUSD: 220_000, installHours: 6, leadTimeWeeks: 16 }, source: 'estimate',
    links: [{ label: 'REBEL-Quad brochure (PDF)', url: 'https://rebellions.ai/wp-content/uploads/2025/08/RebellionsREBEL-Quad_brochure_v1.2.pdf' }],
    notes: 'Chip values from the REBEL-Quad brochure (public-spec): 144 GB HBM3E 4.8 TB/s, 2,048 TFLOPS FP8, up to 600 W, 2 × PCIe Gen5 x16. The 8-card node (≈6–7 kW, 8U, scale-up over PCIe/UCIe, NICs, price) is an estimate — no vendor server spec published; the brochure (v1.2) does not support an OAM module form factor (label fixed 2026-09-15).',
  },
  {
    id: 'furiosa-rngd-server', vendor: 'FuriosaAI', model: 'NXT RNGD Server', name: 'FuriosaAI NXT RNGD Server (4U, 8 × RNGD)', role: 'gpu',
    description: '4U rackmount with 8 × RNGD cards (48 GB HBM3 each, 384 GB total, 4,096 TFLOPS FP8 total), 3,000 W system TDP, 4 × 2,000 W Titanium PSUs, 45.3 kg, air-cooled 10–35 °C.',
    rackUnits: 4, weightKg: 45.3,
    power: { nameplateKW: 3.0, typicalKW: 2.4, idleKW: 0.6, peakKW: 3.0 },
    cooling: { kind: 'air', liquidFraction: 0, airflowM3s: 0.15, liquidFlowLpm: 0, maxInletC: 35 },
    cpu: { count: 2, model: 'x86 32C' }, memoryGB: 512,
    gpu: {
      count: 8, model: 'RNGD', memoryGB: 48, memBandwidthGBps: 1500, flopsPeak: 2.56e14, wattsW: 180,
      peakTflops: { bf16: 256, fp8: 512 },
      scaleUp: { kind: 'pcie', domainSize: 8, gbpsPerGpu: 512 }, accelerator: { vendor: 'FuriosaAI', family: 'RNGD', formFactor: 'pcie' },
    },
    nics: [{ role: 'frontend', count: 1, portsPerNic: 2, portGbps: 100 }, oob],
    cost: { capexUSD: 110_000, installHours: 3, leadTimeWeeks: 10 }, source: 'public-spec',
    links: [{ label: 'FuriosaAI RNGD Server', url: 'https://furiosa.ai/rngd-server' }],
    notes: 'Vendor page: 4U, 8 × RNGD, 384 GB HBM3, 4,096 TFLOPS FP8, 3,000 W, 4 × 2,000 W PSU, 45.3 kg, 10–35 °C. Per-card HBM bandwidth 1.5 TB/s and 180 W TDP from the RNGD card brief; bf16 (= fp8/2), typical/idle power and price are estimates.',
  },
  {
    id: 'hyperaccel-orion', vendor: 'HyperAccel', model: 'Orion (8 × LPU)', name: 'HyperAccel Orion 8 × LPU server (2U, air)', role: 'gpu',
    description: 'FPGA-based Latency Processing Unit server: 8 × LPU, 128 GB HBM total, ~3.3 TB/s effective; 1.4 kW max (16 × LPU: 2.9 kW).',
    rackUnits: 2, weightKg: 30,
    power: { nameplateKW: 1.4, typicalKW: 0.9, idleKW: 0.3, peakKW: 1.4 },
    cooling: { kind: 'air', liquidFraction: 0, airflowM3s: 0.08, liquidFlowLpm: 0, maxInletC: 35 },
    cpu: { count: 2, model: 'x86 32C' }, memoryGB: 256,
    gpu: {
      count: 8, model: 'LPU (FPGA)', memoryGB: 16, memBandwidthGBps: 460, flopsPeak: 2.0e13, wattsW: 120,
      peakTflops: { bf16: 20 },
      scaleUp: { kind: 'pcie', domainSize: 8, gbpsPerGpu: 256 }, accelerator: { vendor: 'HyperAccel', family: 'LPU', formFactor: 'pcie' },
    },
    nics: [{ role: 'frontend', count: 1, portsPerNic: 2, portGbps: 25 }, oob],
    cost: { capexUSD: 60_000, installHours: 2, leadTimeWeeks: 8 }, source: 'public-spec',
    links: [{ label: 'HyperAccel', url: 'https://hyperaccel.ai/' }, { label: 'LPU paper (arXiv 2408.07326)', url: 'https://arxiv.org/abs/2408.07326' }],
    notes: 'Public: 8 × LPU, 128 GB HBM, ~3.3 TB/s effective (90 % utilisation), 1.4 kW max system power (16 × LPU 2.9 kW), Orion-cloud 608 W typical (arXiv 2408.07326 / HyperAccel). Per-LPU FLOPS, 2U height, weight and price are estimates (FPGA-based, latency-optimised — TFLOPS is not the sizing metric).',
  },
  {
    id: 'hyperaccel-bertha500-8x-node', vendor: 'HyperAccel / OEM', model: 'Bertha 500 ×8', name: 'HyperAccel Bertha 500 8-card server (4U, air)', role: 'gpu',
    description: '8 × Bertha 500 (Samsung 4 nm LPU ASIC, dual-slot PCIe Gen5, 250 W TDP, 128–256 GB LPDDR5X 546 GB/s, 384 TFLOPS FP16 / 768 FP8) in a 4U PCIe server; ~3 kW, air-cooled.',
    rackUnits: 4, weightKg: 42,
    power: { nameplateKW: 3.0, typicalKW: 2.3, idleKW: 0.6, peakKW: 3.1 },
    cooling: { kind: 'air', liquidFraction: 0, airflowM3s: 0.16, liquidFlowLpm: 0, maxInletC: 35 },
    cpu: { count: 2, model: 'x86 32C' }, memoryGB: 512,
    gpu: {
      count: 8, model: 'Bertha 500', memoryGB: 128, memBandwidthGBps: 546, flopsPeak: 3.84e14, wattsW: 250,
      peakTflops: { bf16: 384, fp8: 768 },
      scaleUp: { kind: 'pcie', domainSize: 8, gbpsPerGpu: 512 }, accelerator: { vendor: 'HyperAccel', family: 'Bertha', formFactor: 'pcie' },
    },
    nics: [{ role: 'frontend', count: 1, portsPerNic: 2, portGbps: 100 }, oob],
    cost: { capexUSD: 90_000, installHours: 3, leadTimeWeeks: 12 }, source: 'estimate',
    links: [{ label: 'HyperAccel Bertha 500', url: 'https://hyperaccel.ai/ha_product/bertha-500/' }],
    notes: 'Card values are public (Bertha 500 page, mass production on Samsung 4 nm via SEMIFIVE, Sep 2026): 250 W, 384 TFLOPS FP16 / 768 FP8, 128 GB (to 256 GB) LPDDR5X 546 GB/s, 256 MB SRAM. The 8-card server (4U, ~3 kW, PCIe scale-up, price) is an estimate placeholder — no vendor server spec published.',
  },
  {
    id: 'tenstorrent-galaxy-blackhole', vendor: 'Tenstorrent', model: 'Galaxy Blackhole', name: 'Tenstorrent Galaxy Blackhole (6U, 32 × Blackhole)', role: 'gpu',
    description: '6U air-cooled server with 32 × Blackhole ASICs, 1 TB GDDR6, 6.2 GB SRAM; 8–10 kW average, 12 kW max (configurable to 14.5 kW); 4 × 2 × 200GbE + up to 56 × 800GbE.',
    rackUnits: 6, weightKg: 90,
    power: { nameplateKW: 12, typicalKW: 9, idleKW: 2, peakKW: 14.5 },
    cooling: { kind: 'air', liquidFraction: 0, airflowM3s: 0.6, liquidFlowLpm: 0, maxInletC: 35 },
    cpu: { count: 0, model: '- (RISC-V on-chip)' }, memoryGB: 0,
    gpu: {
      count: 32, model: 'Blackhole', memoryGB: 32, memBandwidthGBps: 512, flopsPeak: 7.74e14, wattsW: 300,
      peakTflops: { bf16: 194, fp8: 774 },
      scaleUp: { kind: 'esun-ethernet', family: 'Tenstorrent Ethernet mesh', domainSize: 32, gbpsPerGpu: 1600 }, accelerator: { vendor: 'Tenstorrent', family: 'Blackhole', formFactor: 'card' },
    },
    nics: [{ role: 'scale-out', count: 8, portsPerNic: 2, portGbps: 200 }, oob],
    cost: { capexUSD: 250_000, installHours: 5, leadTimeWeeks: 14 }, source: 'public-spec',
    links: [{ label: 'Tenstorrent Galaxy', url: 'https://tenstorrent.com/hardware/galaxy' }],
    notes: 'Vendor page: 32 × Blackhole, 1 TB GDDR6, 6.2 GB SRAM, "8–10 kW avg, 12 kW max", 6U, 4 × 2 × 200GbE (+ up to 56 × 800GbE for scale-out). Per-chip 32 GB / 512 GB/s / 774 TFLOPS FP8 (Blackhole p150 class); Ethernet mesh scale-up 1.6 Tb/s per chip, weight and price are estimates.',
  },
];

const nodeById = (id: string) => NPU_NODES.find((n) => n.id === id)!;

/** Compose with the per-rack kW cap by cooling type, leaving 2U for a ToR switch (`maxNodesPerRack`). */
function npuRack(nodeId: string, id: string, name: string, color: string, wanted?: number): CatalogItem {
  const node = nodeById(nodeId);
  const rack = findRackModel('rack-42u-600x1200')!;
  const fit = maxNodesPerRack(node, rack, 2);
  const n = Math.max(1, Math.min(wanted ?? fit.max, fit.max));
  const r = composeRack({ node, nodesPerRack: n, rackModel: rack, id, name, color, source: 'estimate' });
  r.vendor = node.vendor;
  r.links = node.links;
  r.notes = `${r.notes} Nodes per rack = min(by RU ${fit.byRU}, by ${node.cooling.kind} kW cap ${fit.kwCap} kW → ${fit.byKW})${wanted ? `, requested ${wanted}` : ''} — estimate.`;
  return r;
}

const NPU_RACKS: CatalogItem[] = [
  npuRack('intel-gaudi3-hlb325-node', 'intel-gaudi3-air-4x', 'Gaudi 3 Air-cooled Rack (4×8 OAM)', '#1f3550', 4),
  npuRack('cerebras-cs3', 'cerebras-cs3-2x', 'Cerebras CS-3 Rack (2 × CS-3, ~46 kW)', '#3a2a1f', 2),
  npuRack('rebellions-atom-max-server', 'rebellions-atom-max-8x', 'Rebellions ATOM-Max Rack (8 × 4U servers)', '#2d2f4a', 8),
  npuRack('rebellions-rebel-quad-node', 'rebellions-rebel-quad-4x', 'Rebellions REBEL-Quad Rack (4 × 8-card nodes)', '#2d2f4a', 4),
  npuRack('furiosa-rngd-server', 'furiosa-rngd-10x', 'FuriosaAI RNGD Rack (10 × 4U servers, 30 kW)', '#3b2438', 10),
  npuRack('hyperaccel-orion', 'hyperaccel-orion-8x', 'HyperAccel Orion Rack (8 × 2U)', '#243b3b', 8),
  npuRack('hyperaccel-bertha500-8x-node', 'hyperaccel-bertha500-8x', 'HyperAccel Bertha 500 Rack (8 × 4U servers)', '#243b3b', 8),
  npuRack('tenstorrent-galaxy-blackhole', 'tenstorrent-galaxy-4x', 'Tenstorrent Galaxy Rack (4 × 6U, 48 kW)', '#3b3a24', 4),
];

/** Whole-rack products (no node → rack composition). */
const NPU_FULL_RACKS: CatalogItem[] = [
  {
    id: 'groq-groqrack', category: 'gpu-rack', vendor: 'Groq', model: 'GroqRack', name: 'GroqRack (64 LPU, 42U)', rackUnits: 42,
    description: 'Groq inference rack: 8 GroqNode servers (+1 redundant) × 8 LPUs = 64 LPUs, 4 × 17.2 kW PSUs (2 redundant), air-cooled.',
    dims: { w: 0.6, d: 1.2, h: 2.0 }, weightKg: 900, clearance: { front: 1.2, rear: 0.9, sides: 0 },
    power: { nameplateKW: 34.4, typicalKW: 24, idleKW: 6, peakKW: 34.4, feeds: 2, voltageV: 415 },
    cooling: { liquidFraction: 0, airflowM3s: 1.8, liquidFlowLpm: 0, maxInletC: 30 },
    compute: {
      gpus: 64, gpuModel: 'GroqChip LPU', cpus: 18, cpuModel: 'x86',
      scaleOutPortsPerGpu: 0, scaleOutPortGbps: 0, frontendPorts: 18, frontendPortGbps: 100, storagePorts: 0, storagePortGbps: 0, oobPorts: 9,
      gpuMemoryGB: 0.23, gpuFlopsPeak: 1.88e14,
      memBandwidthGBps: 80000, railsPerNode: 0, nodesPerRack: 8, gpusPerNode: 8, peakTflops: { bf16: 188 },
      scaleUp: { kind: 'vendor-proprietary', family: 'Groq RealScale', domainSize: 64, gbpsPerGpu: 0 }, accelerator: { vendor: 'Groq', family: 'LPU', formFactor: 'card' },
    },
    cost: { capexUSD: 1_800_000, installHours: 24, leadTimeWeeks: 16 },
    asset: { color: '#4a2f1f' }, source: 'public-spec',
    links: [{ label: 'GroqRack', url: 'https://groq.com/groqrack' }],
    notes: 'Public: 42U, 8 (+1) GroqNode, 64 LPUs, 4 × 17.2 kW PSUs (2 redundant) → nameplate = 2 × 17.2 kW usable; LPU max 375 W / avg 240 W; 230 MB SRAM at ~80 TB/s per LPU. Proprietary RealScale chip-to-chip interconnect (domain 64; per-LPU fabric bandwidth is not declared). Typical/idle kW, weight, airflow and price are estimates.',
  },
  {
    id: 'sambanova-sn40l-16', category: 'gpu-rack', vendor: 'SambaNova', model: 'SambaRack SN40L-16', name: 'SambaNova SN40L-16 rack (16 RDU, ~10 kW)',
    description: 'SambaNova DataScale rack with 16 × SN40L RDUs (3-tier memory: 520 MB SRAM, 64 GB HBM, 1.5 TB DDR per RDU); ~10 kW typical (7–14.5 kW), air-cooled. SN50 successor lists the same 16-chip rack.',
    dims: { w: 0.6, d: 1.2, h: 2.0 }, weightKg: 800, clearance: { front: 1.2, rear: 0.9, sides: 0 },
    power: { nameplateKW: 14.5, typicalKW: 10, idleKW: 3, peakKW: 14.5, feeds: 2, voltageV: 415 },
    cooling: { liquidFraction: 0, airflowM3s: 0.9, liquidFlowLpm: 0, maxInletC: 32 },
    compute: {
      gpus: 16, gpuModel: 'SN40L RDU', cpus: 8, cpuModel: 'x86',
      scaleOutPortsPerGpu: 0, scaleOutPortGbps: 0, frontendPorts: 8, frontendPortGbps: 100, storagePorts: 0, storagePortGbps: 0, oobPorts: 8,
      gpuMemoryGB: 64, gpuFlopsPeak: 6.38e14,
      memBandwidthGBps: 1640, railsPerNode: 0, nodesPerRack: 8, gpusPerNode: 2, peakTflops: { bf16: 638 },
      scaleUp: { kind: 'vendor-proprietary', family: 'SambaNova DataScale fabric', domainSize: 16, gbpsPerGpu: 0 }, accelerator: { vendor: 'SambaNova', family: 'SN40L', formFactor: 'custom' },
    },
    cost: { capexUSD: 1_500_000, installHours: 24, leadTimeWeeks: 16 },
    asset: { color: '#1f3a4a' }, source: 'estimate',
    links: [{ label: 'SambaNova DataScale', url: 'https://sambanova.ai/products/datascale' }],
    notes: '~10 kW typical (7–14.5 kW) from SambaNova / press (secondary) → estimate; 16 RDUs per rack (vendor page). RDU: 638 TFLOPS BF16, 64 GB HBM (~1.64 TB/s), 1.5 TB DDR. Weight, airflow, node split and price are estimates.',
  },
  {
    id: 'google-tpu7x-cloud', category: 'other', vendor: 'Google', model: 'TPU7x (Ironwood)', name: 'Google TPU7x pod — cloud-only reference (not placeable)',
    description: 'Cloud-only reference for comparisons: TPU7x (Ironwood) pods of 9,216 chips (~10 MW, liquid-cooled), 192 GB HBM ~7.37 TB/s and 4,614 TFLOPS FP8 per chip, 3D torus ICI. Not purchasable — cannot be placed on the floor.',
    dims: { w: 0.6, d: 1.2, h: 2.0 }, weightKg: 0, clearance: { front: 0, rear: 0, sides: 0 },
    compute: {
      gpus: 0, gpuModel: 'TPU7x', cpus: 0, cpuModel: '-', scaleUp: { kind: 'none', domainSize: 0, gbpsPerGpu: 0 },
      scaleOutPortsPerGpu: 0, scaleOutPortGbps: 0, frontendPorts: 0, frontendPortGbps: 0, storagePorts: 0, storagePortGbps: 0, oobPorts: 0,
      gpuMemoryGB: 192, gpuFlopsPeak: 4.614e15, memBandwidthGBps: 7370, peakTflops: { fp8: 4614 },
      accelerator: { vendor: 'Google', family: 'TPU v7', formFactor: 'custom' },
    },
    cost: { capexUSD: 0, installHours: 0, leadTimeWeeks: 0 },
    asset: { color: '#4285f4' }, source: 'public-spec',
    links: [{ label: 'Cloud TPU7x docs', url: 'https://docs.cloud.google.com/tpu/docs/tpu7x' }],
    notes: 'Cloud-only (GKE / Compute Engine). Kept as an "other" item with gpus = 0 so it never contributes to space/power/network; per-chip values are Google public specs for workload comparisons. meta.cloudOnly = true.',
    meta: { cloudOnly: true, placeable: false },
  },
];

export const NPU_CATALOG: CatalogItem[] = [...NPU_RACKS, ...NPU_FULL_RACKS];
