import type { CableType, CatalogItem } from '../model/types.ts';
import { getActiveCatalog } from './registry.ts';
import { EXTRA_CABLE_TYPES, EXTRA_CATALOG } from './seeds/index.ts';
import { ACCELERATOR_FLOPS } from './flops.ts';
import { catalogAliasTarget } from './aliases.ts';
import { applyStandardsClassification } from './seeds/std-classification.ts';

/**
 * Equipment catalog.
 *
 * Every value is a public specification (vendor product page or datasheet, cited in `links` / `notes` with the retrieval
 * date) or an indicative estimate — every price is an editable assumption. No value is taken from third-party asset
 * packs; the legacy third-party asset tag stays parseable for stored catalog extensions only (catalog/aliases.ts). Vendor and product names are nominative references to the vendors' public material.
 */

const rack = (o: Partial<CatalogItem> & Pick<CatalogItem, 'id' | 'category' | 'vendor' | 'model' | 'name' | 'description' | 'cost' | 'source'>): CatalogItem => ({
  dims: { w: 0.6, d: 1.2, h: 2.3 },
  weightKg: 1000,
  clearance: { front: 1.2, rear: 0.9, sides: 0 },
  ...o,
});

const BUILTIN_CATALOG: CatalogItem[] = [
  // ─────────────── GPU racks ───────────────
  rack({
    id: 'nvidia-gb300-nvl72',
    category: 'gpu-rack',
    vendor: 'NVIDIA',
    model: 'GB300 NVL72',
    name: 'GB300 NVL72',
    description: 'NVIDIA GB300 NVL72 — 72 Blackwell GPUs, 36 Grace CPUs, liquid-cooled rack-scale system (Oberon MGX rack).',
    dims: { w: 0.6, d: 1.2, h: 2.3 },
    weightKg: 1500,
    clearance: { front: 1.2, rear: 0.9, sides: 0 },
    power: { nameplateKW: 136, typicalKW: 115, idleKW: 40.8, peakKW: 204, rampUpKWps: 20, rampDownKWps: 20, feeds: 2, voltageV: 415 },
    cooling: {
      liquidFraction: 116 / (116 + 19.3),
      airflowM3s: 0.98165,
      liquidFlowLpm: 92.6,
      maxInletC: 35,
      maxCoolantSupplyC: 45,
      airflowCurve: [[20, 0.7315], [25, 0.8495], [30, 0.98165], [35, 1.18175]],
      liquidFlowCurve: [[25, 65.1], [30, 76.5], [35, 92.6], [40, 117.5], [45, 160]],
    },
    compute: {
      gpus: 72, gpuModel: 'Blackwell (GB300)', cpus: 36, cpuModel: 'Grace',
      scaleOutPortsPerGpu: 1, scaleOutPortGbps: 800, frontendPorts: 18, frontendPortGbps: 400,
      storagePorts: 0, storagePortGbps: 400, oobPorts: 32,
      gpuMemoryGB: 288, gpuFlopsPeak: 2.3e15,
      memBandwidthGBps: 8000, railsPerNode: 4, nodesPerRack: 18, gpusPerNode: 4,
      scaleUp: { kind: 'nvlink', domainSize: 72, gbpsPerGpu: 14400 },
      // T5 MFU basis: dense per-GPU peaks of the B300 family (catalog/flops.ts; DGX B300 page, vendor-claim / derived)
      peakTflops: { ...ACCELERATOR_FLOPS.b300.peakTflops },
      accelerator: { vendor: 'NVIDIA', family: 'Blackwell Ultra', formFactor: 'custom' },
    },
    cost: { capexUSD: 3_900_000, installHours: 60, leadTimeWeeks: 26 },
    asset: { glb: 'generic_rack_eia48_dlc.glb', usd: 'usd/Generic/generic_rack_eia48_dlc.usd', color: '#3a3f44' },
    source: 'estimate',
    links: [{ label: 'NVIDIA GB300 NVL72 (product page)', url: 'https://www.nvidia.com/en-us/data-center/gb300-nvl72/' }, { label: 'NVIDIA DGX GB rack scale systems user guide — hardware', url: 'https://docs.nvidia.com/dgx/dgxgb200-user-guide/hardware.html' }],
    notes: 'public-spec (NVIDIA GB300 NVL72 page, retrieved 2026-09-15): 72 Blackwell Ultra GPUs, 36 Grace CPUs, 20 TB GPU memory, up to 576 TB/s GPU memory bandwidth (8 TB/s = memBandwidthGBps 8000 per GPU), 130 TB/s NVLink (1.8 TB/s = 14,400 Gb/s per GPU), 800 Gb/s scale-out per GPU (ConnectX-8); 18 × 1RU compute trays with 4 GPUs each (DGX GB user guide). estimate (not published by the vendor; values unchanged so stored projects keep their totals): nameplate / typical / idle / peak power and ramp, liquid / air heat split, airflow and liquid-flow curves, inlet and coolant limits, dimensions, weight, gpuMemoryGB 288 (public 20 TB ÷ 72 ≈ 278 GB), price.',
  }),
  rack({
    id: 'nvidia-gb200-nvl72',
    category: 'gpu-rack',
    vendor: 'NVIDIA',
    model: 'GB200 NVL72',
    name: 'GB200 NVL72',
    description: 'NVIDIA GB200 NVL72 — 72 B200 GPUs, 36 Grace CPUs, liquid-cooled rack-scale system.',
    weightKg: 1360,
    power: { nameplateKW: 125, typicalKW: 105, idleKW: 38, peakKW: 180, rampUpKWps: 20, rampDownKWps: 20, feeds: 2, voltageV: 415 },
    cooling: { liquidFraction: 0.85, airflowM3s: 0.92, liquidFlowLpm: 85, maxInletC: 35, maxCoolantSupplyC: 45 },
    compute: {
      gpus: 72, gpuModel: 'B200', cpus: 36, cpuModel: 'Grace',
      scaleOutPortsPerGpu: 1, scaleOutPortGbps: 400, frontendPorts: 18, frontendPortGbps: 400,
      storagePorts: 0, storagePortGbps: 400, oobPorts: 32,
      gpuMemoryGB: 186, gpuFlopsPeak: 2.0e15,
      memBandwidthGBps: 8000, railsPerNode: 4, nodesPerRack: 18, gpusPerNode: 4,
      scaleUp: { kind: 'nvlink', domainSize: 72, gbpsPerGpu: 14400 },
      // T5 MFU basis: dense per-GPU peaks of the B200 family (catalog/flops.ts; GB200 NVL72 page)
      peakTflops: { ...ACCELERATOR_FLOPS.b200.peakTflops },
      accelerator: { vendor: 'NVIDIA', family: 'Blackwell', formFactor: 'custom' },
    },
    cost: { capexUSD: 3_100_000, installHours: 60, leadTimeWeeks: 20 },
    asset: { glb: 'generic_rack_eia48_dlc.glb', usd: 'usd/Generic/generic_rack_eia48_dlc.usd', color: '#3a3f44' },
    source: 'public-spec',
    notes: 'memBandwidthGBps 8000 = public spec (B200: 8 TB/s HBM3e per GPU).',
  }),
  rack({
    id: 'hgx-b200-air-4x',
    category: 'gpu-rack',
    vendor: 'OEM',
    model: 'HGX B200 8-GPU ×4',
    name: 'HGX B200 Air-cooled Rack (4×8 GPU)',
    description: 'Four air-cooled HGX B200 8-GPU servers (10U each) in a 48U rack.',
    weightKg: 1250,
    power: { nameplateKW: 57.2, typicalKW: 46, idleKW: 12, peakKW: 64, rampUpKWps: 8, rampDownKWps: 8, feeds: 2, voltageV: 415 },
    cooling: { liquidFraction: 0, airflowM3s: 2.1, liquidFlowLpm: 0, maxInletC: 35 },
    compute: {
      gpus: 32, gpuModel: 'B200', cpus: 8, cpuModel: 'x86',
      scaleOutPortsPerGpu: 1, scaleOutPortGbps: 400, frontendPorts: 8, frontendPortGbps: 200,
      storagePorts: 8, storagePortGbps: 400, oobPorts: 6,
      gpuMemoryGB: 180, gpuFlopsPeak: 2.0e15,
      memBandwidthGBps: 8000, railsPerNode: 8, nodesPerRack: 4, gpusPerNode: 8,
      scaleUp: { kind: 'nvlink', domainSize: 8, gbpsPerGpu: 14400 },
      peakTflops: { ...ACCELERATOR_FLOPS.b200.peakTflops },
      accelerator: { vendor: 'NVIDIA', family: 'Blackwell', formFactor: 'sxm' },
    },
    cost: { capexUSD: 1_900_000, installHours: 40, leadTimeWeeks: 16 },
    asset: { color: '#2b2f33' },
    source: 'public-spec',
    notes: 'memBandwidthGBps 8000 = public spec (HGX B200: 8 TB/s HBM3e per GPU). Reference values for seeds: HGX B300 8000, HGX H200 4800, HGX H100 3350 GB/s.',
  }),
  // ─────────────── CPU / storage / network racks ───────────────
  rack({
    id: 'cpu-rack-2s-20',
    category: 'cpu-rack',
    vendor: 'OEM',
    model: '2S x86 ×20',
    name: 'CPU Compute Rack (20× dual-socket)',
    description: 'General-purpose CPU rack — 20 × 2U dual-socket servers (control plane, data prep, orchestration).',
    weightKg: 900,
    power: { nameplateKW: 18, typicalKW: 12, idleKW: 5, peakKW: 20, feeds: 2, voltageV: 415 },
    cooling: { liquidFraction: 0, airflowM3s: 1.4, liquidFlowLpm: 0, maxInletC: 35 },
    compute: {
      gpus: 0, gpuModel: '-', cpus: 40, cpuModel: 'x86', scaleUp: { kind: 'none', domainSize: 0, gbpsPerGpu: 0 },
      scaleOutPortsPerGpu: 0, scaleOutPortGbps: 0, frontendPorts: 40, frontendPortGbps: 100,
      storagePorts: 0, storagePortGbps: 0, oobPorts: 22,
      gpuMemoryGB: 0, gpuFlopsPeak: 0,
    },
    cost: { capexUSD: 420_000, installHours: 24, leadTimeWeeks: 10 },
    asset: { color: '#30353a' },
    source: 'estimate', notes: 'Estimate. AIDC Studio planning archetype; power, airflow, mass and price are estimates, not datasheet values.',
  }),
  rack({
    id: 'storage-rack-afa',
    category: 'storage-rack',
    vendor: 'OEM',
    model: 'All-flash ×8 nodes',
    name: 'All-Flash Storage Rack',
    description: 'Parallel file / object storage — 8 × 2U NVMe nodes (24 × 30 TB), 400G storage fabric.',
    weightKg: 1100,
    power: { nameplateKW: 14, typicalKW: 11, idleKW: 7, peakKW: 15, feeds: 2, voltageV: 415 },
    cooling: { liquidFraction: 0, airflowM3s: 1.1, liquidFlowLpm: 0, maxInletC: 35 },
    storage: { rawTB: 5760, usableTB: 4600, throughputGBps: 64 },
    compute: {
      gpus: 0, gpuModel: '-', cpus: 8, cpuModel: 'x86', scaleUp: { kind: 'none', domainSize: 0, gbpsPerGpu: 0 },
      scaleOutPortsPerGpu: 0, scaleOutPortGbps: 0, frontendPorts: 8, frontendPortGbps: 100,
      storagePorts: 16, storagePortGbps: 400, oobPorts: 10,
      gpuMemoryGB: 0, gpuFlopsPeak: 0,
    },
    cost: { capexUSD: 2_300_000, installHours: 30, leadTimeWeeks: 12 },
    asset: { color: '#26435a' },
    source: 'estimate', notes: 'Estimate. AIDC Studio planning archetype; capacity, power, airflow, mass and price are estimates, not datasheet values.',
  }),
  rack({
    id: 'network-rack-48u',
    category: 'network-rack',
    vendor: 'OEM',
    model: '48U Network Rack',
    name: 'Network Rack (48U frame, 42U for switches)',
    description: '48U × 600 × 1200 network rack; 42U usable for switches, the rest kept for overhead fiber management and patch panels; switch power & heat are derived from contents.',
    notes: 'Estimate. rackUnits = 42 is the usable switch space of a 48U frame (label fixed 2026-09-15; the number is unchanged so stored network-rack counts stay the same).',
    weightKg: 350,
    rackUnits: 42,
    power: { nameplateKW: 0, typicalKW: 0, idleKW: 0, peakKW: 0, feeds: 2, voltageV: 415 },
    cooling: { liquidFraction: 0, airflowM3s: 0, liquidFlowLpm: 0, maxInletC: 35 },
    cost: { capexUSD: 9_000, installHours: 16, leadTimeWeeks: 6 },
    asset: { color: '#1f3b2b' },
    source: 'estimate',
  }),
  rack({
    id: 'mgmt-rack-42u',
    category: 'mgmt-rack',
    vendor: 'OEM',
    model: '42U Management Rack',
    name: 'Management / OOB Rack',
    description: 'OOB & management switches, console servers, head nodes.',
    weightKg: 600,
    rackUnits: 42,
    power: { nameplateKW: 6, typicalKW: 4, idleKW: 2, peakKW: 7, feeds: 2, voltageV: 415 },
    cooling: { liquidFraction: 0, airflowM3s: 0.5, liquidFlowLpm: 0, maxInletC: 35 },
    cost: { capexUSD: 60_000, installHours: 16, leadTimeWeeks: 6 },
    asset: { color: '#3b3320' },
    source: 'estimate', notes: 'Estimate. AIDC Studio planning archetype; power, airflow, mass and price are estimates, not datasheet values.',
  }),

  // ─────────────── Switches (inside network racks) ───────────────
  {
    id: 'nvidia-q3400', category: 'switch', vendor: 'NVIDIA', model: 'Quantum-X800 Q3400', name: 'Quantum-X800 Q3400 (XDR 800G ×144)',
    description: 'InfiniBand XDR switch, 144 × 800 Gb/s ports (72 twin-port OSFP 1.6T cages), 4U.',
    dims: { w: 0.44, d: 0.8, h: 0.178 }, weightKg: 45, clearance: { front: 0, rear: 0, sides: 0 },
    power: { nameplateKW: 4.2, typicalKW: 3.2, idleKW: 1.5, peakKW: 4.4, feeds: 2, voltageV: 230 },
    cooling: { liquidFraction: 0, airflowM3s: 0.28, liquidFlowLpm: 0, maxInletC: 35 },
    switch: { fabric: 'ib-xdr-800', ports: 144, portGbps: 800, rackUnits: 4, role: 'any' },
    cost: { capexUSD: 190_000, installHours: 6, leadTimeWeeks: 20 }, source: 'estimate', notes: 'Estimate. Port count, speed and height describe the product class; power, airflow, mass and price are planning estimates, not datasheet values.',
  },
  {
    id: 'nvidia-qm9700', category: 'switch', vendor: 'NVIDIA', model: 'Quantum-2 QM9700', name: 'Quantum-2 QM9700 (NDR 400G ×64)',
    description: 'InfiniBand NDR switch, 64 × 400 Gb/s ports (32 twin-port OSFP), 1U.',
    dims: { w: 0.44, d: 0.66, h: 0.044 }, weightKg: 15, clearance: { front: 0, rear: 0, sides: 0 },
    power: { nameplateKW: 1.72, typicalKW: 1.1, idleKW: 0.6, peakKW: 1.72, feeds: 2, voltageV: 230 },
    cooling: { liquidFraction: 0, airflowM3s: 0.12, liquidFlowLpm: 0, maxInletC: 35 },
    switch: { fabric: 'ib-ndr-400', ports: 64, portGbps: 400, rackUnits: 1, role: 'any' },
    cost: { capexUSD: 38_000, installHours: 3, leadTimeWeeks: 12 }, source: 'public-spec',
  },
  {
    id: 'nvidia-sn5600', category: 'switch', vendor: 'NVIDIA', model: 'Spectrum-X SN5600', name: 'Spectrum-X SN5600 (800GbE ×64)',
    description: 'Spectrum-4 Ethernet switch for Spectrum-X RoCE fabrics, 64 × 800GbE OSFP, 2U.',
    dims: { w: 0.44, d: 0.66, h: 0.089 }, weightKg: 22, clearance: { front: 0, rear: 0, sides: 0 },
    power: { nameplateKW: 2.3, typicalKW: 1.7, idleKW: 0.8, peakKW: 2.4, feeds: 2, voltageV: 230 },
    cooling: { liquidFraction: 0, airflowM3s: 0.16, liquidFlowLpm: 0, maxInletC: 35 },
    switch: { fabric: 'spectrumx-800', ports: 64, portGbps: 800, rackUnits: 2, role: 'any' },
    cost: { capexUSD: 70_000, installHours: 4, leadTimeWeeks: 14 }, source: 'estimate', notes: 'Estimate. Port count, speed and height describe the product class; power, airflow, mass and price are planning estimates, not datasheet values.',
  },
  {
    id: 'nvidia-sn5400', category: 'switch', vendor: 'NVIDIA', model: 'Spectrum-4 SN5400', name: 'Spectrum-4 SN5400 (400GbE ×64)',
    description: 'Ethernet switch, 64 × 400GbE, 2U — front-end / storage / Spectrum-X 400G.',
    dims: { w: 0.44, d: 0.66, h: 0.089 }, weightKg: 20, clearance: { front: 0, rear: 0, sides: 0 },
    power: { nameplateKW: 1.6, typicalKW: 1.2, idleKW: 0.6, peakKW: 1.7, feeds: 2, voltageV: 230 },
    cooling: { liquidFraction: 0, airflowM3s: 0.12, liquidFlowLpm: 0, maxInletC: 35 },
    switch: { fabric: 'ethernet-400', ports: 64, portGbps: 400, rackUnits: 2, role: 'any' },
    cost: { capexUSD: 45_000, installHours: 4, leadTimeWeeks: 10 }, source: 'estimate', notes: 'Estimate. Port count, speed and height describe the product class; power, airflow, mass and price are planning estimates, not datasheet values.',
  },
  {
    id: 'generic-roce-400', category: 'switch', vendor: 'Generic', model: '51.2T 400G ×128', name: 'Generic 51.2T Ethernet (400GbE ×128)',
    description: 'Merchant-silicon 51.2 Tb/s Ethernet switch, 128 × 400GbE, RoCEv2 with standard congestion control.',
    dims: { w: 0.44, d: 0.66, h: 0.089 }, weightKg: 22, clearance: { front: 0, rear: 0, sides: 0 },
    power: { nameplateKW: 2.2, typicalKW: 1.6, idleKW: 0.8, peakKW: 2.3, feeds: 2, voltageV: 230 },
    cooling: { liquidFraction: 0, airflowM3s: 0.16, liquidFlowLpm: 0, maxInletC: 35 },
    switch: { fabric: 'roce-generic-400', ports: 128, portGbps: 400, rackUnits: 2, role: 'any' },
    cost: { capexUSD: 55_000, installHours: 4, leadTimeWeeks: 10 }, source: 'estimate', notes: 'Estimate. Generic merchant-silicon 51.2 Tb/s class; power, airflow, mass and price are planning estimates.',
  },
  {
    id: 'nvidia-sn2201', category: 'switch', vendor: 'NVIDIA', model: 'SN2201', name: 'SN2201 (1GbE ×48 OOB)',
    description: 'Out-of-band management switch, 48 × 1GbE + 4 × 100GbE uplinks, 1U.',
    dims: { w: 0.44, d: 0.4, h: 0.044 }, weightKg: 7, clearance: { front: 0, rear: 0, sides: 0 },
    power: { nameplateKW: 0.1, typicalKW: 0.08, idleKW: 0.05, peakKW: 0.1, feeds: 2, voltageV: 230 },
    cooling: { liquidFraction: 0, airflowM3s: 0.02, liquidFlowLpm: 0, maxInletC: 40 },
    switch: { fabric: 'ethernet-1g', ports: 48, portGbps: 1, rackUnits: 1, role: 'mgmt', uplinkPorts: 4 },
    cost: { capexUSD: 6_500, installHours: 2, leadTimeWeeks: 8 }, source: 'public-spec',
  },

  // ─────────────── Cooling ───────────────
  {
    id: 'vertiv-xdu1350', category: 'cdu', vendor: 'Vertiv', model: 'CoolChip CDU 1350', name: 'Vertiv CoolChip CDU 1350 (1.35 MW)',
    description: 'In-row / perimeter liquid-to-liquid coolant distribution unit, 1,350 kW at 4 °C approach, redundant pumps, chilled-water or glycol primary.',
    dims: { w: 0.9, d: 1.243, h: 2.122 }, weightKg: 1086, clearance: { front: 0.914, rear: 0.914, sides: 0 },
    power: { nameplateKW: 20.5, typicalKW: 13.7, idleKW: 5, peakKW: 20.5, feeds: 2, voltageV: 480 },
    capacity: { coolingKW: 1350, liquidFlowLpm: 1960 },
    cost: { capexUSD: 185_000, installHours: 80, leadTimeWeeks: 22 },
    asset: { glb: 'generic_cdu_900x2122.glb', usd: 'usd/Generic/generic_cdu_900x2122.usd', color: '#d9dadb' },
    source: 'vendor-datasheet',
    links: [{ label: 'Vertiv CoolChip CDU family data sheet SL-80005 (PDF)', url: 'https://www.vertiv.com/4a49da/globalassets/shared/vertiv-coolchip-cdu-family-data-sheet-sl-80005.pdf' }, { label: 'Vertiv CoolChip CDU', url: 'https://www.vertiv.com/en-us/products-catalog/thermal-management/high-density-solutions/vertiv-coolchip-cdu/' }],
    notes: 'Datasheet SL-80005 (05/26, retrieved 2026-09-15): 1,350 kW @ 4 °C ATD, 2122 × 900 × 1243 mm (H × W × D), 1,086 kg wet, 20.5 kW nominal power, 400 V / 480 V. estimate: secondary flow 1,960 LPM, typical / idle power, price.',
  },
  {
    id: 'vertiv-xdu2300', category: 'cdu', vendor: 'Vertiv', model: 'CoolChip XDU2300', name: 'Vertiv XDU2300 CDU (2.3 MW)',
    description: 'In-row / perimeter liquid-to-liquid coolant distribution unit, 2,300 kW at 4 °C approach, treated-water or PG-25 secondary loop.',
    dims: { w: 1.2, d: 1.2, h: 2.4 }, weightKg: 1793, clearance: { front: 2.0, rear: 0.9, sides: 0 },
    power: { nameplateKW: 47.8, typicalKW: 22, idleKW: 8, peakKW: 47.8, feeds: 2, voltageV: 480 },
    capacity: { coolingKW: 2300, liquidFlowLpm: 3300 },
    cost: { capexUSD: 290_000, installHours: 110, leadTimeWeeks: 26 },
    asset: { glb: 'generic_cdu_1200x2400.glb', usd: 'usd/Generic/generic_cdu_1200x2400.usd', color: '#d9dadb' },
    source: 'vendor-datasheet',
    links: [{ label: 'Vertiv CoolChip CDU 2300 data sheet SL-80607 (PDF)', url: 'https://www.vertiv.com/4a480e/globalassets/shared/vertiv-coolchipcdu-2300kw-_datasheet_global-english_sl-80607.pdf' }, { label: 'Vertiv CoolChip CDU family data sheet SL-80005 (PDF)', url: 'https://www.vertiv.com/4a49da/globalassets/shared/vertiv-coolchip-cdu-family-data-sheet-sl-80005.pdf' }],
    notes: 'Datasheets SL-80607 / SL-80005 (retrieved 2026-09-15): 2,300 kW @ 4 °C ATD (coolingKW 2300), 2400 × 1200 × 1200 mm (H × W × D), 47.8 kW nominal power, 1,793 kg wet. The datasheet power and mass were adopted on 2026-09-15 (earlier planning values 32 kW / 1,569 kg); stored projects show a one-time notice (catalog/dataChanges.ts). estimate: typical / idle power, secondary flow 3,300 LPM, price.',
  },
  {
    id: 'vertiv-cw084', category: 'crah', vendor: 'Vertiv', model: 'Liebert CW 084', name: 'Vertiv CW084 CRAH (84 kW)',
    description: 'Chilled-water computer room air handler (Liebert CW class), EC fans, 12,400 m³/h.',
    dims: { w: 2.515, d: 0.889, h: 1.829 }, weightKg: 690, clearance: { front: 1.0, rear: 0.2, sides: 0 },
    power: { nameplateKW: 4.5, typicalKW: 3, idleKW: 1, peakKW: 4.5, feeds: 1, voltageV: 480 },
    capacity: { coolingKW: 84, airflowM3s: 12400 / 3600 },
    cost: { capexUSD: 38_000, installHours: 40, leadTimeWeeks: 14 },
    asset: { glb: 'generic_crah_2515x1829.glb', usd: 'usd/Generic/generic_crah_2515x1829.usd', color: '#e3e4e6' },
    source: 'estimate',
    notes: 'Planning values for a Liebert CW-class chilled-water unit (84 kW, 12,400 m³/h). No model-level public datasheet was retrieved (2026-09-15); dimensions, weight, fan power and price are estimates — replace with the vendor submittal.',
  },
  {
    id: 'vertiv-cw181', category: 'crah', vendor: 'Vertiv', model: 'Liebert CW 181', name: 'Vertiv CW181 CRAH (181 kW)',
    description: 'Chilled-water computer room air handler (Liebert CW class), 24,000 m³/h.',
    dims: { w: 3.099, d: 1.067, h: 2.388 }, weightKg: 1143, clearance: { front: 1.0, rear: 0.2, sides: 0 },
    power: { nameplateKW: 7.5, typicalKW: 5, idleKW: 1.5, peakKW: 7.5, feeds: 1, voltageV: 480 },
    capacity: { coolingKW: 181, airflowM3s: 24000 / 3600 },
    cost: { capexUSD: 62_000, installHours: 48, leadTimeWeeks: 14 },
    asset: { glb: 'generic_crah_3099x2388.glb', usd: 'usd/Generic/generic_crah_3099x2388.usd', color: '#e3e4e6' },
    source: 'estimate',
    notes: 'Planning values for a Liebert CW-class chilled-water unit (181 kW, 24,000 m³/h). No model-level public datasheet was retrieved (2026-09-15); dimensions, weight, fan power and price are estimates — replace with the vendor submittal.',
  },
  {
    id: 'vertiv-cw375', category: 'crah', vendor: 'Vertiv', model: 'Liebert CW 375', name: 'Vertiv CW375 CRAH (375 kW)',
    description: 'Large chilled-water air handler (Liebert CW class), EC fans, 375 kW nominal, 27.1 m³/s.',
    dims: { w: 3.05, d: 1.15, h: 3.407 }, weightKg: 3300, clearance: { front: 1.2, rear: 0.3, sides: 0 },
    power: { nameplateKW: 8.8, typicalKW: 6, idleKW: 2, peakKW: 8.8, feeds: 1, voltageV: 480 },
    capacity: { coolingKW: 375, airflowM3s: 27.14 },
    cost: { capexUSD: 120_000, installHours: 64, leadTimeWeeks: 18 },
    asset: { glb: 'generic_crah_3050x3407.glb', usd: 'usd/Generic/generic_crah_3050x3407.usd', color: '#e3e4e6' },
    source: 'estimate',
    notes: 'Planning values for a large Liebert CW-class chilled-water unit (375 kW, 27.14 m³/s). No model-level public datasheet was retrieved (2026-09-15); capacity, airflow, dimensions, weight, fan power and price are estimates kept unchanged so stored projects keep their CRAH counts — replace with the vendor submittal.',
  },
  {
    id: 'chiller-ac-1500', category: 'chiller', vendor: 'Generic', model: 'Air-cooled chiller 1.5 MW', name: 'Air-cooled Chiller w/ Free-cooling (1.5 MW)',
    description: 'Air-cooled screw/centrifugal chiller with integrated free-cooling coils, warm-water optimized.',
    dims: { w: 12.2, d: 2.3, h: 2.6 }, weightKg: 14000, clearance: { front: 1.5, rear: 1.5, sides: 2 },
    power: { nameplateKW: 330, typicalKW: 180, idleKW: 20, peakKW: 360, feeds: 1, voltageV: 480 },
    capacity: { coolingKW: 1500 },
    cost: { capexUSD: 640_000, installHours: 240, leadTimeWeeks: 30 },
    asset: { color: '#c7cacc' }, source: 'estimate', notes: 'Estimate. Generic facility plant archetype; capacity, power, dimensions, mass and price are planning estimates.',
  },
  {
    id: 'drycooler-2000', category: 'dry-cooler', vendor: 'Generic', model: 'Adiabatic dry cooler 2 MW', name: 'Adiabatic Dry Cooler (2 MW)',
    description: 'Adiabatic dry cooler for warm-water (≥30 °C FWS) liquid cooling heat rejection.',
    dims: { w: 12.2, d: 2.4, h: 2.8 }, weightKg: 9000, clearance: { front: 1.5, rear: 1.5, sides: 2 },
    power: { nameplateKW: 45, typicalKW: 25, idleKW: 3, peakKW: 48, feeds: 1, voltageV: 480 },
    capacity: { coolingKW: 2000 },
    cost: { capexUSD: 260_000, installHours: 160, leadTimeWeeks: 24 },
    asset: { color: '#c7cacc' }, source: 'estimate', notes: 'Estimate. Generic facility plant archetype; capacity, power, dimensions, mass and price are planning estimates.',
  },

  // ─────────────── Power ───────────────
  {
    id: 'vertiv-exl-s1-1200', category: 'ups', vendor: 'Vertiv', model: 'Liebert EXL S1 1200', name: 'Vertiv EXL S1 UPS (1,200 kVA)',
    description: 'Transformer-free double-conversion UPS, 1,200 kVA, 97%+ efficiency (Li-ion battery cabinets separate).',
    dims: { w: 3.2, d: 1.0, h: 1.95 }, weightKg: 3200, clearance: { front: 1.2, rear: 0.1, sides: 0 },
    capacity: { powerKVA: 1200, powerKW: 1200, inputVoltageV: 480, outputVoltageV: 480 },
    cost: { capexUSD: 420_000, installHours: 120, leadTimeWeeks: 28 },
    asset: { color: '#e6e7e8' },
    source: 'estimate', notes: 'Planning values for a 1,200 kVA transformer-free UPS line-up; no 3D model — procedural box used.',
  },
  {
    id: 'vertiv-apm2-150', category: 'ups', vendor: 'Vertiv', model: 'Liebert APM2', name: 'Vertiv APM2 Modular UPS (150 kVA)',
    description: 'Modular high-density UPS, hot-swappable modules (row-level / small loads).',
    dims: { w: 0.8, d: 0.95, h: 2.0 }, weightKg: 600, clearance: { front: 1.0, rear: 0.1, sides: 0 },
    capacity: { powerKVA: 150, powerKW: 150, inputVoltageV: 208, outputVoltageV: 208 },
    cost: { capexUSD: 85_000, installHours: 24, leadTimeWeeks: 12 },
    asset: { color: '#e6e7e8' },
    source: 'estimate',
    notes: 'Planning values for a modular row-level UPS (Liebert APM2 class, 150 kVA frame). No model-level public datasheet was retrieved (2026-09-15); dimensions, weight and price are estimates.',
  },
  {
    id: 'genset-2500', category: 'generator', vendor: 'Generic', model: 'Diesel genset 2.5 MW', name: 'Diesel Generator (2.5 MW, containerized)',
    description: 'Containerized standby diesel generator, 2,500 kWe, 48 h fuel autonomy with day tanks + bulk storage.',
    dims: { w: 12.2, d: 2.9, h: 3.6 }, weightKg: 32000, clearance: { front: 2, rear: 2, sides: 2 },
    capacity: { powerKW: 2500, powerKVA: 3125 },
    cost: { capexUSD: 1_350_000, installHours: 320, leadTimeWeeks: 52 },
    asset: { color: '#d8c35a' }, source: 'estimate', notes: 'Estimate. Generic facility plant archetype; capacity, power, dimensions, mass and price are planning estimates.',
  },
  {
    id: 'xfmr-3000', category: 'transformer', vendor: 'Generic', model: 'Cast-resin 3,000 kVA', name: 'MV/LV Transformer (3,000 kVA 22.9 kV/415 V)',
    description: 'Cast-resin distribution transformer, 22.9 kV / 415-480 V, 99% efficiency at design load.',
    dims: { w: 3.0, d: 2.0, h: 2.6 }, weightKg: 8000, clearance: { front: 1.2, rear: 1.0, sides: 1 },
    capacity: { powerKVA: 3000, inputVoltageV: 22900, outputVoltageV: 415 },
    cost: { capexUSD: 190_000, installHours: 120, leadTimeWeeks: 44 },
    asset: { color: '#8a9096' }, source: 'estimate', notes: 'Estimate. Generic facility plant archetype; capacity, power, dimensions, mass and price are planning estimates.',
  },
  {
    id: 'rpp-800a', category: 'rpp', vendor: 'Generic', model: 'RPP 800 A 415 V', name: 'Remote Power Panel / Busway Run (800 A)',
    description: 'Remote power panel or overhead busway run, 800 A @ 415 V (575 kVA), 80% continuous rating.',
    dims: { w: 0.8, d: 0.8, h: 2.0 }, weightKg: 450, clearance: { front: 1.2, rear: 0, sides: 0 },
    capacity: { powerKVA: 575, currentA: 800, outputVoltageV: 415 },
    cost: { capexUSD: 42_000, installHours: 40, leadTimeWeeks: 16 },
    asset: { color: '#5a6b7a' }, source: 'estimate', notes: 'Estimate. Generic facility plant archetype; capacity, power, dimensions, mass and price are planning estimates.',
  },
  {
    id: 'bess-2mw', category: 'battery', vendor: 'Generic', model: 'BESS 2 MW / 4 MWh', name: 'Battery Energy Storage (2 MW / 4 MWh)',
    description: 'Containerized Li-ion BESS for AI training load smoothing and peak shaving.',
    dims: { w: 12.2, d: 2.4, h: 2.9 }, weightKg: 36000, clearance: { front: 1.5, rear: 1.5, sides: 2 },
    capacity: { powerKW: 2000, batteryMinutes: 120 },
    cost: { capexUSD: 1_700_000, installHours: 200, leadTimeWeeks: 30 },
    asset: { color: '#4a7a5a' }, source: 'estimate', notes: 'Estimate. Generic facility plant archetype; capacity, power, dimensions, mass and price are planning estimates.',
  },
];

const BUILTIN_CABLE_TYPES: CableType[] = [
  { id: 'dac-100', kind: 'dac', name: '100G passive DAC', gbps: 100, minReachM: 0.5, maxReachM: 5, cableUSD: 60, cableUSDPerM: 18, transceiverUSD: 0, transceiverW: 0.1, latencyNsPerM: 4.3, source: 'estimate' },
  { id: 'aoc-100', kind: 'aoc', name: '100G active optical cable', gbps: 100, minReachM: 3, maxReachM: 100, cableUSD: 220, cableUSDPerM: 5, transceiverUSD: 0, transceiverW: 2.5, latencyNsPerM: 4.9, source: 'estimate' },
  { id: 'mmf-100-sr4', kind: 'mmf', name: '100G SR4 + OM4 MPO-12', gbps: 100, minReachM: 1, maxReachM: 100, cableUSD: 60, cableUSDPerM: 2.5, transceiverUSD: 180, transceiverW: 2.5, latencyNsPerM: 4.9, source: 'estimate' },
  { id: 'dac-400', kind: 'dac', name: '400G passive DAC', gbps: 400, minReachM: 0.5, maxReachM: 3, cableUSD: 150, cableUSDPerM: 55, transceiverUSD: 0, transceiverW: 0.1, latencyNsPerM: 4.3, source: 'estimate' },
  { id: 'dac-800', kind: 'dac', name: '800G passive DAC', gbps: 800, minReachM: 0.5, maxReachM: 2.5, cableUSD: 260, cableUSDPerM: 90, transceiverUSD: 0, transceiverW: 0.1, latencyNsPerM: 4.3, source: 'estimate' },
  { id: 'aec-400', kind: 'aec', name: '400G active electrical cable', gbps: 400, minReachM: 1, maxReachM: 7, cableUSD: 450, cableUSDPerM: 70, transceiverUSD: 0, transceiverW: 10, latencyNsPerM: 4.5, source: 'estimate' },
  { id: 'aec-800', kind: 'aec', name: '800G active electrical cable', gbps: 800, minReachM: 1, maxReachM: 7, cableUSD: 850, cableUSDPerM: 110, transceiverUSD: 0, transceiverW: 12, latencyNsPerM: 4.5, source: 'estimate' },
  { id: 'aoc-400', kind: 'aoc', name: '400G active optical cable', gbps: 400, minReachM: 3, maxReachM: 30, cableUSD: 650, cableUSDPerM: 14, transceiverUSD: 0, transceiverW: 8, latencyNsPerM: 4.9, source: 'estimate' },
  { id: 'mmf-400-sr4', kind: 'mmf', name: '400G SR4 + OM4 MPO-12', gbps: 400, minReachM: 1, maxReachM: 100, cableUSD: 70, cableUSDPerM: 2.5, transceiverUSD: 650, transceiverW: 8, latencyNsPerM: 4.9, source: 'estimate' },
  { id: 'mmf-800-sr8', kind: 'mmf', name: '800G 2×SR4 twin-port + OM4 MPO', gbps: 800, minReachM: 1, maxReachM: 50, cableUSD: 120, cableUSDPerM: 4.5, transceiverUSD: 1_250, transceiverW: 15, latencyNsPerM: 4.9, source: 'estimate' },
  { id: 'smf-400-dr4', kind: 'smf', name: '400G DR4 + SMF MPO-12', gbps: 400, minReachM: 1, maxReachM: 500, cableUSD: 60, cableUSDPerM: 1.6, transceiverUSD: 900, transceiverW: 9, latencyNsPerM: 4.9, source: 'estimate' },
  { id: 'smf-800-dr8', kind: 'smf', name: '800G DR8 (2×DR4) + SMF MPO', gbps: 800, minReachM: 1, maxReachM: 500, cableUSD: 140, cableUSDPerM: 2.2, transceiverUSD: 1_600, transceiverW: 17, latencyNsPerM: 4.9, source: 'estimate' },
  { id: 'smf-1600-dr8', kind: 'smf', name: '1.6T DR8 + SMF MPO-16', gbps: 1600, minReachM: 1, maxReachM: 500, cableUSD: 180, cableUSDPerM: 2.8, transceiverUSD: 2_900, transceiverW: 25, latencyNsPerM: 4.9, source: 'estimate' },
  { id: 'cat6a-1g', kind: 'cat6a', name: 'Cat6A copper (1GbE OOB)', gbps: 1, minReachM: 0.5, maxReachM: 100, cableUSD: 12, cableUSDPerM: 0.9, transceiverUSD: 0, transceiverW: 0.5, latencyNsPerM: 5.0, source: 'estimate' },
];

/** Builtin catalog = curated items above ∪ seed files (catalog/seeds). Read-only constant; use `catalogItems()` for the effective list. */
export const CATALOG: CatalogItem[] = applyStandardsClassification([...BUILTIN_CATALOG, ...EXTRA_CATALOG]);
/** Builtin cable types (∪ seeds). Use `cableTypes()` for the effective list. */
export const CABLE_TYPES: CableType[] = [...BUILTIN_CABLE_TYPES, ...EXTRA_CABLE_TYPES];

// ───────────── lookups (read the ACTIVE registry index; default = builtin) ─────────────

export function getCatalogItem(id: string): CatalogItem {
  const item = getActiveCatalog().items.get(id);
  if (!item) throw new Error(`Unknown catalog item: ${id}`);
  return item;
}

export function findCatalogItem(id: string): CatalogItem | undefined {
  const index = getActiveCatalog();
  const hit = index.items.get(id);
  if (hit) return hit;
  // stream A (P1): renamed ids redirect only when the exact id is gone (catalog/aliases.ts)
  const target = catalogAliasTarget(id);
  return target ? index.items.get(target) : undefined;
}

export function getCableType(id: string): CableType {
  const c = getActiveCatalog().cables.get(id);
  if (!c) throw new Error(`Unknown cable type: ${id}`);
  return c;
}

export function findCableType(id: string): CableType | undefined {
  return getActiveCatalog().cables.get(id);
}

/** Effective catalog items (builtin ∪ library ∪ project extensions of the active index). */
export function catalogItems(): CatalogItem[] {
  return getActiveCatalog().list();
}

/** Effective cable types of the active index. */
export function cableTypes(): CableType[] {
  return getActiveCatalog().cableList();
}

export function catalogByCategory(category: CatalogItem['category']): CatalogItem[] {
  return catalogItems().filter((c) => c.category === category);
}

/** Linear interpolation over a [x, y][] curve, clamped at the ends. */
export function interpCurve(curve: [number, number][] | undefined, x: number, fallback: number): number {
  if (!curve || curve.length === 0) return fallback;
  if (x <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    const [x1, y1] = curve[i];
    if (x <= x1) {
      const [x0, y0] = curve[i - 1];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return curve[curve.length - 1][1];
}
