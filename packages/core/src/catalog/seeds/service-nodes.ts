import type { NodeSpec } from '../compose.ts';

/**
 * Service nodes for the node → rack composer (head / login / management / storage / OOB / generic CPU).
 * All values are planning estimates for 2-socket x86 platforms of the 2025–2026 generation.
 */
export const SERVICE_NODES: NodeSpec[] = [
  {
    id: 'node-head-2s', vendor: 'OEM', model: '2S head node', name: 'Head / control node (2U, 2S x86)', role: 'head',
    description: 'Cluster head / controller node (Slurm ctl, BCM, provisioning) — 2 × 64-core x86, 1 TB DDR5, 4 × NVMe.',
    rackUnits: 2, weightKg: 32,
    power: { nameplateKW: 1.4, typicalKW: 0.8, idleKW: 0.35, peakKW: 1.6 },
    cooling: { kind: 'air', liquidFraction: 0, airflowM3s: 0.09, liquidFlowLpm: 0, maxInletC: 35 },
    cpu: { count: 2, model: 'x86 64C' }, memoryGB: 1024,
    nics: [{ role: 'frontend', count: 1, portsPerNic: 2, portGbps: 100 }, { role: 'oob', count: 1, portsPerNic: 1, portGbps: 1 }],
    cost: { capexUSD: 28_000, installHours: 3, leadTimeWeeks: 8 }, source: 'estimate',
  },
  {
    id: 'node-login-2s', vendor: 'OEM', model: '2S login node', name: 'Login node (1U, 2S x86)', role: 'login',
    rackUnits: 1, weightKg: 20,
    power: { nameplateKW: 1.0, typicalKW: 0.55, idleKW: 0.25, peakKW: 1.1 },
    cooling: { kind: 'air', liquidFraction: 0, airflowM3s: 0.07, liquidFlowLpm: 0, maxInletC: 35 },
    cpu: { count: 2, model: 'x86 32C' }, memoryGB: 512,
    nics: [{ role: 'frontend', count: 1, portsPerNic: 2, portGbps: 100 }, { role: 'oob', count: 1, portsPerNic: 1, portGbps: 1 }],
    cost: { capexUSD: 16_000, installHours: 2, leadTimeWeeks: 8 }, source: 'estimate',
  },
  {
    id: 'node-mgmt-1s', vendor: 'OEM', model: '1S mgmt node', name: 'Management node (1U, 1S x86)', role: 'mgmt',
    description: 'Monitoring / telemetry / DCIM / NOS management VMs.',
    rackUnits: 1, weightKg: 18,
    power: { nameplateKW: 0.7, typicalKW: 0.4, idleKW: 0.18, peakKW: 0.8 },
    cooling: { kind: 'air', liquidFraction: 0, airflowM3s: 0.05, liquidFlowLpm: 0, maxInletC: 35 },
    cpu: { count: 1, model: 'x86 32C' }, memoryGB: 256,
    nics: [{ role: 'frontend', count: 1, portsPerNic: 2, portGbps: 25 }, { role: 'oob', count: 1, portsPerNic: 1, portGbps: 1 }],
    cost: { capexUSD: 9_000, installHours: 2, leadTimeWeeks: 6 }, source: 'estimate',
  },
  {
    id: 'node-storage-nvme-24', vendor: 'OEM', model: '2U 24-bay NVMe', name: 'Storage node (2U, 24 × 30 TB NVMe)', role: 'storage',
    description: 'Parallel-file-system storage node, 24 × 30.72 TB NVMe (737 TB raw), 2 × 400G storage fabric.',
    rackUnits: 2, weightKg: 36,
    power: { nameplateKW: 1.75, typicalKW: 1.3, idleKW: 0.8, peakKW: 1.9 },
    cooling: { kind: 'air', liquidFraction: 0, airflowM3s: 0.14, liquidFlowLpm: 0, maxInletC: 35 },
    cpu: { count: 2, model: 'x86 32C' }, memoryGB: 512, storageTB: 737, storageThroughputGBps: 8,
    nics: [{ role: 'storage', count: 1, portsPerNic: 2, portGbps: 400 }, { role: 'frontend', count: 1, portsPerNic: 2, portGbps: 100 }, { role: 'oob', count: 1, portsPerNic: 1, portGbps: 1 }],
    cost: { capexUSD: 285_000, installHours: 4, leadTimeWeeks: 12 }, source: 'estimate',
  },
  {
    id: 'node-oob-console', vendor: 'OEM', model: '48-port console server', name: 'OOB console / serial server (1U)', role: 'oob',
    rackUnits: 1, weightKg: 6,
    power: { nameplateKW: 0.12, typicalKW: 0.07, idleKW: 0.05, peakKW: 0.12 },
    cooling: { kind: 'air', liquidFraction: 0, airflowM3s: 0.01, liquidFlowLpm: 0, maxInletC: 40 },
    cpu: { count: 1, model: 'embedded' }, memoryGB: 8,
    nics: [{ role: 'oob', count: 1, portsPerNic: 2, portGbps: 1 }],
    cost: { capexUSD: 4_500, installHours: 1, leadTimeWeeks: 6 }, source: 'estimate',
  },
  {
    id: 'node-cpu-2s', vendor: 'OEM', model: '2S compute node', name: 'CPU compute node (2U, 2S x86, data prep)', role: 'cpu',
    rackUnits: 2, weightKg: 30,
    power: { nameplateKW: 1.2, typicalKW: 0.75, idleKW: 0.3, peakKW: 1.35 },
    cooling: { kind: 'air', liquidFraction: 0, airflowM3s: 0.09, liquidFlowLpm: 0, maxInletC: 35 },
    cpu: { count: 2, model: 'x86 96C' }, memoryGB: 1536,
    nics: [{ role: 'frontend', count: 1, portsPerNic: 2, portGbps: 100 }, { role: 'oob', count: 1, portsPerNic: 1, portGbps: 1 }],
    cost: { capexUSD: 24_000, installHours: 2, leadTimeWeeks: 8 }, source: 'estimate',
  },
];
