import type { CatalogItem } from '../../model/types.ts';

/**
 * AMD Helios rack-scale reference system (generic ORW variant, 72 × Instinct MI455X) — stream S5.
 *
 * Sources (public AMD product pages and press releases listed in `links`):
 *  - 'announced' (AMD product page / press releases / Hot Chips 2026 slides): 72 GPUs, 18 Venice CPUs, 216 Vulcano
 *    800 NICs (3 per GPU, 800 GbE), 31 TB HBM4, 1.4 PB/s HBM bandwidth (June-2025 preview figure kept as the
 *    brief's number; launch figure 1.7 PB/s in `notes`), 43 TB/s scale-out, 260 TB/s UALoE scale-up, 2.9 EF FP4,
 *    1.4 EF FP8, 225–245 kW rack power, 385 L/min coolant, OCP ORW frame 1200 × 1219 × 2390 mm / 44 OU.
 *  - 'estimate': weight 2,600 kg (bottom-up), liquid fraction 0.95, idle / peak / ramp, airflow residual, price,
 *    install hours and lead time (reference design — not a priced product).
 * The item is tagged `source: 'announced'`; every estimated field is listed in `notes`.
 */
export const HELIOS_CATALOG: CatalogItem[] = [
  {
    id: 'amd-helios-mi455x',
    category: 'gpu-rack',
    vendor: 'AMD',
    model: 'Helios (72× MI455X, ORW)',
    name: 'AMD Helios rackscale (72× Instinct MI455X)',
    description:
      'AMD Helios rack-scale AI system on the OCP Open Rack Wide (double-wide, 44 OU): 18 × 1 OU compute trays (EPYC 9006 Venice + 4 × Instinct MI455X), 6 × 1 OU UALoE switch trays (2 × Broadcom Tomahawk 6 each), 50 VDC liquid-cooled busbar, rear blind-mate quick disconnects. Generic AMD reference (not the Meta variant).',
    // OCP ORW frame: 1200 mm wide × 1219 mm deep × 2390 mm tall [announced — OCP ORW v1.0.1 via S10/S12/S23/S24]
    dims: { w: 1.2, d: 1.219, h: 2.39 },
    // estimate: bottom-up 18 × 77 kg trays + 6 × ~90 kg switch trays + 4 × ~60 kg cartridges + ~450 kg frame (press: 2,267–3,175 kg)
    weightKg: 2600,
    clearance: { front: 1.2, rear: 1.0, sides: 0 },
    power: {
      nameplateKW: 245, // announced (AMD: 225–245 kW depending on workload)
      typicalKW: 225, // announced (low end of the stated range)
      idleKW: 70, // estimate (~29 % of nameplate, NVL72-class idle ratio)
      peakKW: 260, // estimate (N+1 shelf / PDU sizing)
      rampUpKWps: 25, // estimate
      rampDownKWps: 25, // estimate
      feeds: 2,
      voltageV: 415,
    },
    cooling: {
      liquidFraction: 0.95, // estimate (busbar, compute and switch trays all DLC; ~12 kW residual to air)
      airflowM3s: 0.55, // estimate (PSU fans, DIMM / SSD / NIC edge cooling)
      liquidFlowLpm: 385, // announced (AMD via STH / StorageReview: 385 L/min removes up to 245 kW)
      maxInletC: 35,
      maxCoolantSupplyC: 40, // assumption (ASHRAE W40 class)
      liquidFlowCurve: [
        [30, 330],
        [35, 355],
        [40, 385],
      ], // estimate (ΔT ≈ 9–10 K at 245 kW)
    },
    compute: {
      gpus: 72, // announced
      gpuModel: 'Instinct MI455X (CDNA 5, 432 GB HBM4)',
      cpus: 18, // announced (1 × EPYC 9006 Venice per tray)
      cpuModel: 'EPYC 9006 Venice (96c)',
      scaleOutPortsPerGpu: 3, // announced (3 × Vulcano 800 per GPU; 2 per GPU optional)
      scaleOutPortGbps: 800,
      frontendPorts: 18, // announced (1 × Salina 400 DPU per tray)
      frontendPortGbps: 400,
      storagePorts: 0,
      storagePortGbps: 400,
      oobPorts: 26, // estimate (18 trays + 6 switch trays + RMC + TOR)
      gpuMemoryGB: 432, // announced
      gpuFlopsPeak: 5.0e15, // announced: 5 PFLOPS dense FP16/BF16 matrix per GPU (fp8 20.1 PF / fp4 40.3 PF in peakTflops; rack 1.4 EF FP8 / 2.9 EF FP4)
      memBandwidthGBps: 19600, // announced (June-2025 preview: 19.6 TB/s → rack 1.4 PB/s; launch spec 23.3 TB/s → 1.7 PB/s)
      peakTflops: { fp4: 40300, fp8: 20100, bf16: 5000, fp32: 315 }, // announced (MI455X product page: dense)
      railsPerNode: 12, // 3 NICs × 4 GPUs per tray
      nodesPerRack: 18,
      gpusPerNode: 4,
      scaleUp: { kind: 'ualink', domainSize: 72, gbpsPerGpu: 28800 },
      accelerator: { vendor: 'AMD', family: 'Instinct MI400 (CDNA 5)', formFactor: 'oam' },
    },
    cost: {
      capexUSD: 5_200_000, // estimate (press: US$5.0–5.5 M per rack, unverified; AMD does not publish pricing)
      installHours: 80, // estimate (double-wide rack, 4 cable cartridges, blind-mate QD)
      leadTimeWeeks: 30, // estimate (first shipments Q3 2026, volume 2H 2026 → H1 2027)
    },
    rackUnits: 44,
    asset: { glb: 'generic_rack_orw_44ou_dlc.glb', usd: 'usd/Generic/generic_rack_orw_44ou_dlc.usd', color: '#2b2d30' },
    source: 'announced',
    notes:
      'announced: 72 × MI455X, 18 × Venice, 216 × Vulcano 800 (3/GPU), 31 TB HBM4, 1.4 PB/s HBM (June-2025 preview; 1.7 PB/s at launch), 43 TB/s scale-out, 260 TB/s UALoE scale-up, 2.9 EF FP4 / 1.4 EF FP8, 225–245 kW, 385 L/min, ORW 1200 × 1219 × 2390 mm / 44 OU. estimate: weight 2,600 kg, liquid fraction 0.95, residual airflow, idle/peak/ramp, oobPorts, price, install hours, lead time. Reference design (blueprint for OEM/ODM partners); Meta variant and 64/128-GPU configurations not modelled. 3D model: generic wide OU rack (tools/asset-pipeline/generic_spec.json: frame values from the wide-rack base and design specifications V1.0.0, generic 72-accelerator tray layout; not the vendor tray arrangement).',
    links: [
      { label: 'AMD Helios product page', url: 'https://www.amd.com/en/products/rackscale-solutions/helios.html' },
      { label: 'AMD Instinct MI455X', url: 'https://www.amd.com/en/products/accelerators/instinct/mi400/mi455x.html' },
      { label: 'AMD press: Helios on OCP ORW (2025-10-14)', url: 'https://www.amd.com/en/newsroom/press-releases/2025-10-14-amd-showcases-helios-rack-scale-platform-built-o.html' },
    ],
  },
];
