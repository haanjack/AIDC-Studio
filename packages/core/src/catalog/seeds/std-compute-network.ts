import type { CatalogItem, FabricTech } from '../../model/types.ts';
import { NEUTRAL_REFERENCE_BASIS } from '../../standards/registry.ts';
import { composeRack, type NodeSpec, type UMapEntry } from '../compose.ts';
import { block, D, E, PSI_TO_KPA, round, std, U, V } from './std-helpers.ts';
import { RACK_MODEL_DATA } from './std-racks.ts';

/**
 * Compute, network and management archetypes (stream B / P2; OCP-DESIGN-PROPOSAL §3.3, P0 impacts box).
 *
 * The generic DLC node is capped at the module power envelope in `NEUTRAL_REFERENCE_BASIS.dlcNode` (1000 W), declares its
 * height (≤ 6 OU) and its own rails (mass above one IT support shelf set). Rack kW is recomputed from the capped module and
 * tagged estimate. Accelerator memory / FLOPS on generic nodes are placeholders (estimate) — vendor instances replace them.
 * Network pod archetypes are facts only (counts and switch classes); no connection maps or port tables.
 */

const OAM = 'oam-base@2.0-1.0';
const UBB = 'ubb-base@2.0-1.0';
const DLC = NEUTRAL_REFERENCE_BASIS.dlcNode;
const psi = (x: number) => round(x * PSI_TO_KPA, 1);

// ───────────────────────────── NIC form factors ─────────────────────────────

const nic3 = (o: { id: string; ff: 'nic3-sff' | 'nic3-tsff' | 'nic3-dsff' | 'nic3-tdsff' | 'nic3-lff'; label: string; wMm: number; zMm: number; lanes: 16 | 32; ports: number; gbps: number; maxW: number; deprecated?: boolean }) =>
  block({
    id: o.id, category: 'nic', model: `${o.label} NIC adapter`, name: `NIC adapter, ${o.label.toLowerCase()} (x${o.lanes}, ${o.maxW} W${o.deprecated ? ', deprecated' : ''})`,
    description: `Generic network adapter in the ${o.label.toLowerCase()} outline (${o.wMm} × 115 mm${o.zMm ? `, Z ${o.zMm} mm` : ''}): up to PCIe Gen5 x${o.lanes}, slot power envelope ${o.maxW} W; ${o.ports} × ${o.gbps}GbE as a planning configuration.${o.deprecated ? ' The outline is deprecated in the cited revision.' : ''}`,
    dims: { w: o.wMm / 1000, d: 0.115, h: (o.zMm || 11.5) / 1000 }, weightKg: 0.3,
    nic: { ports: o.ports, portGbps: o.gbps, totalGbps: o.ports * o.gbps, formFactor: o.ff, hostInterface: `PCIe Gen5 x${o.lanes}`, transports: ['roce', 'uec'], wattsTypical: round(o.maxW * 0.35, 0), wattsMax: o.maxW },
    cost: { capexUSD: o.lanes === 32 ? 2_600 : 1_500, installHours: 0.2, leadTimeWeeks: 8 },
    source: 'open-standard',
    standards: [std('nic3@1.6.0', 'open-spec', 'nic', 'verified', o.deprecated ? { note: 'outline deprecated in this revision' } : {})],
    paramSources: {
      dims: V('nic3@1.6.0', '§1.4', o.zMm ? undefined : 'Z height not recorded; 11.5 mm assumed'),
      'nic.wattsMax': V('nic3@1.6.0', 'Table 5', 'slot power envelope'),
      'nic.hostInterface': V('nic3@1.6.0', undefined, `up to x${o.lanes}, PCIe Gen5`),
      'nic.ports': E('generic port configuration within the lane budget'),
      'nic.wattsTypical': E('typical adapter draw'),
      'cost.capexUSD': E('price assumption'),
    },
    notes: `Generic form-factor block; port configuration, typical power and price are estimates.${o.id === 'nic3-dsff' || o.id === 'nic3-tdsff' ? ' Compatible with the full-width host processor module outline.' : ''}`,
    meta: o.deprecated ? { deprecated: true } : {},
  });

export const NIC_FORM_FACTOR_BLOCKS: CatalogItem[] = [
  nic3({ id: 'nic3-sff', ff: 'nic3-sff', label: 'Small form factor', wMm: 76, zMm: 11.5, lanes: 16, ports: 1, gbps: 400, maxW: 80 }),
  nic3({ id: 'nic3-tsff', ff: 'nic3-tsff', label: 'Tall small form factor', wMm: 76, zMm: 14.2, lanes: 16, ports: 1, gbps: 400, maxW: 80 }),
  nic3({ id: 'nic3-dsff', ff: 'nic3-dsff', label: 'Double-wide small form factor', wMm: 157.55, zMm: 0, lanes: 32, ports: 2, gbps: 400, maxW: 160 }),
  nic3({ id: 'nic3-tdsff', ff: 'nic3-tdsff', label: 'Tall double-wide small form factor', wMm: 157.55, zMm: 0, lanes: 32, ports: 2, gbps: 400, maxW: 160 }),
  nic3({ id: 'nic3-lff', ff: 'nic3-lff', label: 'Large form factor', wMm: 139, zMm: 0, lanes: 32, ports: 2, gbps: 400, maxW: 150, deprecated: true }),
];

// ───────────────────────────── generic switch classes ─────────────────────────────

const PLANNING = 'planning value from the pod / cluster architecture equipment tables';

const sw = (o: { id: string; name: string; model: string; description: string; fabric: FabricTech; ports: number; gbps: number; ru: number; kw: number; kg: number; capex: number; role?: 'leaf' | 'spine' | 'any' | 'mgmt'; uplinkPorts?: number; verified: ('power' | 'rackUnits' | 'weight')[]; notes: string }) =>
  block({
    id: o.id, category: 'switch', model: o.model, name: o.name, description: o.description,
    dims: { w: 0.44, d: o.ru >= 2 ? 0.66 : 0.6, h: round(o.ru * 0.04445, 3) }, weightKg: o.kg,
    power: { nameplateKW: o.kw, typicalKW: round(o.kw * 0.75, 2), idleKW: round(o.kw * 0.4, 2), peakKW: round(o.kw * 1.05, 2), feeds: 2, voltageV: 230 },
    cooling: { liquidFraction: 0, airflowM3s: round(o.kw * 0.07, 3), liquidFlowLpm: 0, maxInletC: 35 },
    switch: { fabric: o.fabric, ports: o.ports, portGbps: o.gbps, rackUnits: o.ru, role: o.role ?? 'any', ...(o.uplinkPorts ? { uplinkPorts: o.uplinkPorts } : {}) },
    cost: { capexUSD: o.capex, installHours: o.ru >= 2 ? 4 : 3, leadTimeWeeks: 10 },
    source: 'estimate',
    standards: [std('eia-310@e', 'eia', 'rack', 'estimate'), std('sai@1.19.0', 'open-spec', 'network', 'unverified', { note: 'switch API; support per SKU not verified' })],
    paramSources: {
      'power.nameplateKW': o.verified.includes('power') ? V('opg-m@1.0', undefined, PLANNING) : E('class power'),
      'switch.rackUnits': o.verified.includes('rackUnits') ? V('opg-m@1.0', undefined, PLANNING) : E('class height'),
      weightKg: o.verified.includes('weight') ? V('opg-m@1.0', undefined, PLANNING) : E('class mass'),
      'power.typicalKW': E('typical / idle / peak from nameplate'),
      'cooling.airflowM3s': E('≈0.07 m³/s per kW'),
      'cost.capexUSD': E('price assumption'),
    },
    notes: o.notes,
    meta: { nos: ['sonic', 'fboss', 'vendor'], api: 'sai' },
  });

export const SWITCH_CLASS_BLOCKS: CatalogItem[] = [
  sw({ id: 'switch-eth-51t-64x800', model: '51.2T Ethernet, 64 × 800G OSFP', name: 'Ethernet switch class, 51.2T (64 × 800GbE)', description: 'Merchant-silicon 51.2 Tb/s Ethernet switch class, 64 × 800G OSFP, 2 OU.', fabric: 'roce-generic-800', ports: 64, gbps: 800, ru: 2, kw: 3.2, kg: 24, capex: 60_000, verified: ['power', 'rackUnits', 'weight'], notes: 'Power (3.2 kW), height and mass are planning values from the pod architecture document; typical/idle power, airflow and price are estimates.' }),
  sw({ id: 'switch-eth-26t-32x800', model: '25.6T Ethernet, 32 × 800G', name: 'Ethernet switch class, 25.6T (32 × 800GbE)', description: '25.6 Tb/s Ethernet switch class, 32 × 800G; rail-optimised leaf of the pod architecture (four leaves, two NIC links per node each).', fabric: 'roce-generic-800', ports: 32, gbps: 800, ru: 1, kw: 1.9, kg: 15, capex: 32_000, verified: ['weight'], notes: 'Pod document: 1.8–2.0 kW (midpoint used, derived), 1–2 OU (1 used), 15 kg. Typical/idle power, airflow and price are estimates.' }),
  sw({ id: 'switch-eth-13t-32x400', model: '12.8T Ethernet, 32 × 400G', name: 'Ethernet switch class, 12.8T (32 × 400GbE)', description: '12.8 Tb/s Ethernet switch class, 32 × 400G, 1 OU.', fabric: 'roce-generic-400', ports: 32, gbps: 400, ru: 1, kw: 1.4, kg: 10, capex: 18_000, verified: ['power', 'rackUnits'], notes: 'Power and height are planning values from the pod architecture document; mass, typical/idle power, airflow and price are estimates.' }),
  sw({ id: 'switch-eth-102t-128x800', model: '102.4T Ethernet, 128 × 800G', name: 'Ethernet switch class, 102.4T (128 × 800GbE)', description: '102.4 Tb/s Ethernet switch class, 128 × 800G.', fabric: 'roce-generic-800', ports: 128, gbps: 800, ru: 4, kw: 5.0, kg: 45, capex: 140_000, verified: [], notes: 'All values are estimates (no open planning value for this class).' }),
  sw({ id: 'switch-eth-25g-48', model: '48 × 25G + 8 × 100G', name: 'Ethernet switch class, in-band management (48 × 25GbE + 8 × 100GbE)', description: 'In-band management leaf class: 48 × 25GbE access, 8 × 100GbE uplinks, 1 OU.', fabric: 'ethernet-100', ports: 48, gbps: 25, ru: 1, kw: 0.3, kg: 9, capex: 6_000, role: 'leaf', uplinkPorts: 8, verified: ['power'], notes: 'Power is a planning value from the pod architecture document; height, mass, airflow and price are estimates.' }),
  sw({ id: 'switch-oob-1g-48', model: '48 × 1G + 4 × 10G', name: 'Ethernet switch class, out-of-band (48 × 1GbE + 4 × 10GbE)', description: 'Out-of-band management switch class: 48 × 1GbE, 4 × 10GbE uplinks, 1 OU.', fabric: 'ethernet-1g', ports: 48, gbps: 1, ru: 1, kw: 0.1, kg: 6, capex: 3_500, role: 'mgmt', uplinkPorts: 4, verified: ['power'], notes: 'Power is a planning value from the pod architecture document; height, mass, airflow and price are estimates.' }),
];

export const SWITCH_TRAY_BLOCK: CatalogItem = block({
  id: 'tray-switch-1ou', category: 'other', blockKind: 'switch-tray', model: 'Scale-up / fabric switch tray, 1 OU', name: 'Scale-up / fabric switch tray (1 OU, liquid-cooled)',
  description: 'Switch tray archetype for rack-scale OU racks (48 mm pitch): ports, fabric and power are instance data; defaults are planning estimates.',
  dims: { w: 0.537, d: 0.8, h: 0.048 }, weightKg: 30, power: { nameplateKW: 1.2, typicalKW: 0.9, idleKW: 0.4, peakKW: 1.3, feeds: 2, voltageV: 50 },
  cost: { capexUSD: 40_000, installHours: 2, leadTimeWeeks: 16 }, source: 'estimate',
  standards: [std('orv3-base@1.1', 'open-spec', 'host', 'verified', { note: '48 mm OU pitch' })],
  paramSources: { 'formFactor.unitPitchMm': V('orv3-base@1.1', '§6.1.2'), power: E('instance value'), weightKg: E('instance value'), 'cost.capexUSD': E('price assumption') },
  formFactor: { unitPitchMm: 48, nodeHeightUnits: 1 },
  notes: 'Archetype only; ports, fabric, power, mass and price come from the instance (estimates here).',
});

// ───────────────────────────── node archetypes ─────────────────────────────

/** Generic placeholder accelerator performance (estimate; vendor instances replace it). */
const genericAccel = (count: number, wattsW: number, scaleUp: NodeSpec['gpu'] extends infer G ? (G extends { scaleUp: infer S } ? S : never) : never, formFactor: 'oam' | 'sxm' | 'pcie' = 'oam', family = 'OAM 2.0 class module') => ({
  count, model: `${family} (${wattsW} W)`, memoryGB: formFactor === 'pcie' ? 64 : 141, memBandwidthGBps: formFactor === 'pcie' ? 1024 : 4800,
  flopsPeak: formFactor === 'pcie' ? 2.5e14 : 1.0e15, peakTflops: formFactor === 'pcie' ? { bf16: 250, fp8: 500 } : { bf16: 1000, fp8: 2000 }, wattsW,
  scaleUp, accelerator: { vendor: 'Generic', family, formFactor },
});

const ubbNics: NodeSpec['nics'] = [
  { role: 'scale-out', count: 8, portsPerNic: 1, portGbps: 400, catalogId: 'nic3-sff' },
  { role: 'frontend', count: 1, portsPerNic: 2, portGbps: 100 },
  { role: 'storage', count: 1, portsPerNic: 2, portGbps: 100 },
  { role: 'oob', count: 1, portsPerNic: 1, portGbps: 1 },
];

const ubbBaseboard = { standard: 'ubb-2.0' as const, modules: 8, inputV: 54 as const, opt12VPerModuleW: 50, outlineMm: [417, 655] as [number, number], maxBoardW: 12000, chassis: ['19in', '21in'] as ('19in' | '21in')[] };
const ubbSources = {
  'baseboard.maxBoardW': V(UBB, '§6.5', '8 × 1000 W modules + 8 × 50 W optional 12 V + 3200 W expansion'),
  'baseboard.outlineMm': V(UBB, 'Table 1'),
  'baseboard.inputV': V(UBB, undefined, '54 V / 48 V nominal main'),
  'baseboard.chassis': V(UBB, undefined, '19-inch and 21-inch chassis'),
  gpu: E('generic placeholder memory / bandwidth / FLOPS — replace with an instance'),
  'cost.capexUSD': E('price assumption'),
};
const ubbScaleUp = { kind: 'vendor-proprietary' as const, family: 'baseboard module-to-module links', domainSize: 8, gbpsPerGpu: 3200 };

const dlcNodeKW = round(DLC.modules * (DLC.moduleCapW / 1000) + 2.6, 2);
const dlcLiquidKW = round(dlcNodeKW * 0.8, 2);

export const STD_NODE_SPECS: NodeSpec[] = [
  {
    id: 'node-ubb8-oam-air', vendor: 'Generic', model: '8 × OAM on UBB, air', name: 'OAM / UBB 8-module node class (8U, air)', role: 'gpu',
    description: '8 accelerator modules (OAM outline, 102 × 170 mm) on a universal baseboard (417 × 655 mm, 12,000 W envelope), 2 host CPUs, 8 × 400G scale-out NICs; air-cooled, modules at the 600 W air recommendation.',
    rackUnits: 8, weightKg: 125,
    power: { nameplateKW: 6.8, typicalKW: 5.8, idleKW: 1.6, peakKW: 7.5 },
    cooling: { kind: 'air', liquidFraction: 0, airflowM3s: 0.45, liquidFlowLpm: 0, maxInletC: 35 },
    cpu: { count: 2, model: 'x86 host CPU' }, memoryGB: 2048,
    gpu: genericAccel(8, 600, ubbScaleUp),
    nics: ubbNics,
    cost: { capexUSD: 250_000, installHours: 6, leadTimeWeeks: 12 }, source: 'estimate',
    standards: [std(OAM, 'open-spec', 'module', 'verified'), std(UBB, 'open-spec', 'baseboard', 'verified')],
    accelModule: { standard: 'oam-2.0', tdpW: 600, cooling: 'air' },
    baseboard: ubbBaseboard,
    formFactor: { unitPitchMm: 44.45, nodeHeightUnits: 8 },
    paramSources: {
      ...ubbSources,
      'accelModule.tdpW': V(OAM, '§6.7', 'air-cooled module ≤600 W recommended'),
      rackUnits: U('8 U: the air-cooled 8-accelerator node height used by the pod architecture document; instances differ', 'opg-m@1.0'),
      power: D(undefined, '8 × 600 W + ≈2 kW host, NICs and fans (estimate)'),
      weightKg: E('node mass'),
    },
    notes: 'Generic class. Module power, board envelope and outlines from the cited base specifications; node height, host power, mass, accelerator memory / FLOPS and price are estimates.',
    meta: { rackClass: 'accel-node-8x' },
  },
  {
    id: 'node-ubb8-oam-dlc', vendor: 'Generic', model: '8 × OAM on UBB, direct liquid cooling', name: 'OAM / UBB 8-module node class (6 OU, DLC)', role: 'gpu',
    description: `8 accelerator modules capped at the ${DLC.moduleCapW} W module envelope on a universal baseboard, cold plates (supply 15–50 °C), 2 blind-mate quick connector pairs, 6 OU, own rails.`,
    rackUnits: DLC.maxHeightUnits, weightKg: 100,
    power: { nameplateKW: dlcNodeKW, typicalKW: round(dlcNodeKW * 0.9, 2), idleKW: 2.2, peakKW: round(dlcNodeKW * 1.08, 2) },
    cooling: { kind: 'dlc', liquidFraction: 0.8, airflowM3s: 0.12, liquidFlowLpm: round(dlcLiquidKW * 1.5, 1), maxInletC: 35, maxCoolantSupplyC: 50 },
    cpu: { count: 2, model: 'x86 host CPU' }, memoryGB: 2048,
    gpu: genericAccel(8, DLC.moduleCapW, ubbScaleUp),
    nics: ubbNics,
    cost: { capexUSD: 320_000, installHours: 8, leadTimeWeeks: 14 }, source: 'estimate',
    standards: [
      std(OAM, 'open-spec', 'module', 'verified', { note: `module power capped at the ${DLC.moduleCapW} W envelope` }),
      std(UBB, 'open-spec', 'baseboard', 'verified'),
      std('orv3-bmqc@1.0', 'open-spec', 'liquid', 'verified'),
      std('orv3-base@1.1', 'open-spec', 'host', 'verified', { note: '48 mm OU pitch' }),
    ],
    accelModule: { standard: 'oam-2.0', tdpW: DLC.moduleCapW, cooling: 'liquid' },
    baseboard: ubbBaseboard,
    liquidInterface: { connector: 'bmqc', ports: 4, portPitch: 'OU', mawpKPa: psi(50), maxFluidC: 60, ratedLpmPerPort: 9 },
    formFactor: { unitPitchMm: 48, nodeHeightUnits: DLC.maxHeightUnits, ownRails: true },
    paramSources: {
      ...ubbSources,
      'accelModule.tdpW': V(OAM, '§5', '≤1000 W at 44–59.5 V; generic archetype capped at the envelope'),
      'meta.coldPlateSupplyC': V(OAM, '§7.6', '15–50 °C, treated water or PG25'),
      power: D(undefined, `8 × ${DLC.moduleCapW} W + ≈2.6 kW host, NICs, pumps and fans (estimate); recomputed from the capped module (the earlier ≈13.8 kW assumed ~1.4 kW modules)`),
      'cooling.liquidFraction': D('cold-plate-loop-reqs@2', 'hybrid-intermediate ITE class, 0.80'),
      'cooling.liquidFlowLpm': D('l-lcdu-wp@1.0', 'liquid kW × 1.5 L/min per kW'),
      'meta.bmqcPairs': D('orv3-bmqc@1.0', `${dlcLiquidKW} kW liquid ≤ 2 pairs × 6 kW (9 L/min at 1.5 L/min per kW)`),
      rackUnits: E(`declared ≤${DLC.maxHeightUnits} OU so five nodes fit beside the 9 OU power zone (RK-01)`),
      weightKg: E('≈100 kg; above the 80 kg IT support shelf set, so the node declares its own rails (RK-03)'),
      'formFactor.ownRails': E('declared because the mass exceeds one IT support shelf set'),
    },
    notes: `Generic class for the neutral reference (DO-2 / DO-10). Rack kW is recomputed from the ${DLC.moduleCapW} W module cap: ${dlcNodeKW} kW per node (estimate). Height, own rails, host power, liquid fraction, mass, accelerator memory / FLOPS and price are estimates.`,
    meta: { rackClass: 'accel-node-8x', bmqcPairs: 2, coldPlateSupplyC: [15, 50] },
  },
  {
    id: 'node-ubb8-oam-dlc-uqd', vendor: 'Generic', model: '8 × OAM on UBB, DLC, 19-inch', name: 'OAM / UBB 8-module node class (6U, DLC, 19-inch)', role: 'gpu',
    description: `19-inch variant of the DLC node class: 8 modules capped at ${DLC.moduleCapW} W, two size-06 universal quick disconnect pairs to a vertical rack manifold.`,
    rackUnits: 6, weightKg: 100,
    power: { nameplateKW: dlcNodeKW, typicalKW: round(dlcNodeKW * 0.9, 2), idleKW: 2.2, peakKW: round(dlcNodeKW * 1.08, 2) },
    cooling: { kind: 'dlc', liquidFraction: 0.8, airflowM3s: 0.12, liquidFlowLpm: round(dlcLiquidKW * 1.5, 1), maxInletC: 35, maxCoolantSupplyC: 50 },
    cpu: { count: 2, model: 'x86 host CPU' }, memoryGB: 2048,
    gpu: genericAccel(8, DLC.moduleCapW, ubbScaleUp),
    nics: ubbNics,
    cost: { capexUSD: 320_000, installHours: 8, leadTimeWeeks: 14 }, source: 'estimate',
    standards: [std(OAM, 'open-spec', 'module', 'verified', { note: `module power capped at the ${DLC.moduleCapW} W envelope` }), std(UBB, 'open-spec', 'baseboard', 'verified'), std('uqd@1.0', 'open-spec', 'liquid', 'verified')],
    accelModule: { standard: 'oam-2.0', tdpW: DLC.moduleCapW, cooling: 'liquid' },
    baseboard: ubbBaseboard,
    liquidInterface: { connector: 'uqd', ports: 4, portPitch: 'U', mawpKPa: psi(100), maxFluidC: 65, ratedLpmPerPort: 11.4 },
    formFactor: { unitPitchMm: 44.45, nodeHeightUnits: 6, ownRails: true },
    paramSources: {
      ...ubbSources,
      'accelModule.tdpW': V(OAM, '§5', 'capped at the envelope'),
      'liquidInterface.ratedLpmPerPort': D('uqd@1.0', 'size 06: ≥3.0 GPM ≈ 11.4 L/min'),
      power: D(undefined, `8 × ${DLC.moduleCapW} W + ≈2.6 kW host (estimate)`),
      rackUnits: E('node height'), weightKg: E('node mass'),
    },
    notes: 'Generic class for 19-inch liquid-cooled racks. Height, host power, liquid fraction, mass, accelerator memory / FLOPS and price are estimates.',
    meta: { rackClass: 'accel-node-8x', uqdSize: '06', uqdPairs: 2 },
  },
  {
    id: 'node-ubb8-sxm', vendor: 'Generic', model: '8 × proprietary module on UBB-class baseboard', name: 'UBB-class 8-module node class, proprietary modules (8U, air)', role: 'gpu',
    description: '8 proprietary accelerator modules on a UBB-class vendor baseboard (management documents treat it as UBB-class); all power and geometry are instance data — defaults are estimates.',
    rackUnits: 8, weightKg: 130,
    power: { nameplateKW: 10.2, typicalKW: 8.2, idleKW: 2.0, peakKW: 10.2 },
    cooling: { kind: 'air', liquidFraction: 0, airflowM3s: 0.52, liquidFlowLpm: 0, maxInletC: 30 },
    cpu: { count: 2, model: 'x86 host CPU' }, memoryGB: 2048,
    gpu: genericAccel(8, 700, { kind: 'vendor-proprietary', family: 'proprietary baseboard scale-up', domainSize: 8, gbpsPerGpu: 7200 }, 'sxm', 'UBB-class proprietary module'),
    nics: ubbNics,
    cost: { capexUSD: 300_000, installHours: 6, leadTimeWeeks: 12 }, source: 'estimate',
    standards: [std('gpu-mgmt-interfaces@1.1', 'open-platform-host', 'host', 'unverified', { note: 'UBB-class for management; module and baseboard proprietary' })],
    accelModule: { standard: 'sxm', tdpW: 700, cooling: 'air' },
    baseboard: { standard: 'ubb-class', modules: 8, inputV: 54 },
    formFactor: { unitPitchMm: 44.45, nodeHeightUnits: 8 },
    paramSources: { power: E('instance value'), rackUnits: E('instance value'), weightKg: E('instance value'), gpu: E('generic placeholder'), 'cost.capexUSD': E('price assumption') },
    notes: 'Archetype of vendor 8-GPU baseboard servers; the vendor instances (their own catalog ids) carry the real values. Everything here is an estimate.',
    meta: { rackClass: 'accel-node-8x' },
  },
  {
    id: 'node-pcie-cem-8x', vendor: 'Generic', model: '8 × PCIe CEM accelerator server', name: 'PCIe accelerator server class (4U, 8 × CEM cards, air)', role: 'gpu',
    description: '19-inch 4U server with 8 PCIe CEM accelerator cards (350 W class), 2 host CPUs, 2 × 400G scale-out NICs; lanes and card power are instance data.',
    rackUnits: 4, weightKg: 45,
    power: { nameplateKW: 4.3, typicalKW: 3.4, idleKW: 0.9, peakKW: 4.5 },
    cooling: { kind: 'air', liquidFraction: 0, airflowM3s: 0.2, liquidFlowLpm: 0, maxInletC: 35 },
    cpu: { count: 2, model: 'x86 host CPU' }, memoryGB: 1024,
    gpu: genericAccel(8, 350, { kind: 'pcie', domainSize: 8, gbpsPerGpu: 512 }, 'pcie', 'PCIe CEM accelerator card'),
    nics: [{ role: 'scale-out', count: 2, portsPerNic: 1, portGbps: 400, catalogId: 'nic3-sff' }, { role: 'frontend', count: 1, portsPerNic: 2, portGbps: 100 }, { role: 'oob', count: 1, portsPerNic: 1, portGbps: 1 }],
    cost: { capexUSD: 120_000, installHours: 3, leadTimeWeeks: 10 }, source: 'estimate',
    standards: [std('eia-310@e', 'eia', 'host', 'estimate', { note: 'PCIe CEM cards (form factor outside the registry)' })],
    accelModule: { standard: 'pcie-cem', tdpW: 350, cooling: 'air' },
    formFactor: { unitPitchMm: 44.45, nodeHeightUnits: 4 },
    paramSources: { power: E('8 × 350 W + host'), rackUnits: E('server height'), weightKg: E('server mass'), gpu: E('generic placeholder'), 'cost.capexUSD': E('price assumption') },
    notes: 'Generic class for NPU / PCIe accelerator racks and the custom template default. Everything is an estimate.',
    meta: { rackClass: 'accel-node-pcie' },
  },
  {
    id: 'tray-compute-1ou-liquid', vendor: 'Generic', model: '1 OU liquid-cooled compute tray', name: 'Compute tray class (1 OU, 4 modules, liquid)', role: 'gpu',
    description: `Liquid-cooled 1 OU compute tray archetype for 21-inch OU and wide racks: 1 host CPU, 4 accelerator modules capped at ${DLC.moduleCapW} W, blind-mate liquid connection; counts and power are instance data.`,
    rackUnits: 1, weightKg: 45,
    power: { nameplateKW: 4.8, typicalKW: 4.3, idleKW: 1.0, peakKW: 5.2 },
    cooling: { kind: 'dlc', liquidFraction: 0.95, airflowM3s: 0.02, liquidFlowLpm: round(4.8 * 0.95 * 1.5, 1), maxInletC: 35, maxCoolantSupplyC: 45 },
    cpu: { count: 1, model: 'host CPU' }, memoryGB: 1024,
    gpu: genericAccel(4, DLC.moduleCapW, { kind: 'ualink', domainSize: 72, gbpsPerGpu: 800, spansRacks: false }),
    nics: [{ role: 'scale-out', count: 4, portsPerNic: 1, portGbps: 800 }, { role: 'frontend', count: 1, portsPerNic: 1, portGbps: 400 }, { role: 'oob', count: 1, portsPerNic: 1, portGbps: 1 }],
    cost: { capexUSD: 120_000, installHours: 1, leadTimeWeeks: 20 }, source: 'estimate',
    standards: [std('orv3-base@1.1', 'open-spec', 'host', 'verified', { note: '48 mm OU pitch' }), std(OAM, 'open-spec', 'module', 'estimate', { note: 'module class assumed; capped at the envelope' })],
    accelModule: { standard: 'oam-2.0', tdpW: DLC.moduleCapW, cooling: 'liquid' },
    liquidInterface: { connector: 'bmqc', ports: 2, portPitch: 'OU', mawpKPa: psi(50), maxFluidC: 60, ratedLpmPerPort: 9 },
    formFactor: { unitPitchMm: 48, nodeHeightUnits: 1 },
    paramSources: { 'formFactor.unitPitchMm': V('orv3-base@1.1', '§6.1.2'), power: E('4 × 1000 W + host'), 'cooling.liquidFlowLpm': D('l-lcdu-wp@1.0', 'liquid kW × 1.5 L/min per kW'), weightKg: E('tray mass'), gpu: E('generic placeholder'), 'cost.capexUSD': E('price assumption') },
    notes: 'Archetype for rack-scale racks (the wide-rack IT gear design guide is non-normative). Everything except the pitch is an estimate.',
    meta: { rackClass: 'rack-scale-liquid' },
  },
];

const node = (id: string) => STD_NODE_SPECS.find((n) => n.id === id)!;

// ───────────────────────────── composed generic racks ─────────────────────────────

const genericRack = (r: CatalogItem, rackClass: string, extra: string): CatalogItem => {
  r.vendor = 'Generic';
  r.meta = { ...(r.meta ?? {}), rackClass, generic: true };
  r.notes = `${r.notes} ${extra}`;
  return r;
};

export const GENERIC_COMPUTE_RACKS: CatalogItem[] = [
  genericRack(
    composeRack({
      node: node('node-ubb8-oam-dlc'), nodesPerRack: 5, rackModel: 'rack-orv3-hpr', id: 'ubb8-oam-dlc-hpr-5x', name: 'OAM / UBB DLC rack class (5 × 8-module nodes, high-power 21-inch OU rack)',
      powerShelves: { count: 3, ratingKW: 27.5, rackUnits: 1, weightKg: 22, capexUSD: 9_000 }, bbuShelves: { count: 3, rackUnits: 2, weightKg: 75, capexUSD: 18_000 },
      color: '#34404a', source: 'estimate',
    }),
    'accel-node-8x',
    `Neutral reference compute rack (DO-2 / DO-10): 5 nodes × ${dlcNodeKW} kW = ${round(5 * dlcNodeKW, 1)} kW (estimate) ≤ 82.5 kW at N+1 (3 × 27.5 kW); power zone 3 × 1 OU PSU + 3 × 2 OU BBU shelves = 9 OU; 5 × 6 OU nodes; payload excluding the frame stays below the 800 kg cross-brace point. Two blind-mate connector pairs per node.`,
  ),
  genericRack(
    composeRack({ node: node('node-ubb8-oam-air'), nodesPerRack: 4, rackModel: 'rack-eia310-48u', id: 'ubb8-oam-air-eia48-4x', name: 'OAM / UBB air rack class (4 × 8-module nodes, 48U)', color: '#34404a', source: 'estimate' }),
    'accel-node-8x',
    'Generic air-cooled accelerator rack for 19-inch air templates (estimate).',
  ),
  genericRack(
    composeRack({ node: node('node-ubb8-oam-dlc-uqd'), nodesPerRack: 5, rackModel: 'rack-eia310-48u', id: 'ubb8-oam-dlc-uqd-eia48-5x', name: 'OAM / UBB DLC rack class (5 × 8-module nodes, 48U, UQD manifold)', color: '#34404a', source: 'estimate' }),
    'accel-node-8x',
    'Generic liquid-cooled accelerator rack for 19-inch liquid templates with a vertical UQD manifold (estimate).',
  ),
  genericRack(
    composeRack({ node: node('node-pcie-cem-8x'), nodesPerRack: 8, rackModel: 'rack-eia310-42u', id: 'pcie-cem-8x-eia42-8x', name: 'PCIe accelerator rack class (8 × 4U servers, 42U)', color: '#343a44', source: 'estimate' }),
    'accel-node-pcie',
    'Generic PCIe accelerator rack (custom template default; estimate).',
  ),
];

/** 72-accelerator liquid-cooled rack-scale domain (parametric archetype; vendor rack-scale systems are instances with their own ids). */
function rackscale72(rackModelId = 'rack-orv3-hpr', id = 'rackscale-liquid-72', rackLabel = 'high-power 21-inch OU rack'): CatalogItem {
  // stream D (P4, localized): the same archetype on the wide OU rack for the wide-rack liquid pod template
  const hpr = RACK_MODEL_DATA.find((r) => r.id === rackModelId)!;
  const trayKW = 4.8;
  const switchTrayKW = 1.2;
  const umap: UMapEntry[] = [];
  let u = 1;
  const put = (units: number, kind: UMapEntry['kind'], label: string, kw = 0) => { umap.push({ u, units, kind, label, kw }); u += units; };
  for (let i = 1; i <= 3; i++) put(1, 'power-shelf', `Power shelf #${i} (27.5 kW N+1)`);
  for (let i = 1; i <= 3; i++) put(2, 'power-shelf', `BBU shelf #${i}`);
  for (let i = 1; i <= 9; i++) put(1, 'node', `Compute tray #${i}`, trayKW);
  for (let i = 1; i <= 9; i++) put(1, 'switch', `Scale-up switch tray #${i}`, switchTrayKW);
  for (let i = 10; i <= 18; i++) put(1, 'node', `Compute tray #${i}`, trayKW);
  put(1, 'switch', 'Management switch', 0.15);
  umap.push({ u, units: hpr.rackUnits - u + 1, kind: 'free', label: 'free' });
  const nameplateKW = round(18 * trayKW + 9 * switchTrayKW + 0.15, 2);
  const liquidKW = 18 * trayKW * 0.95 + 9 * switchTrayKW * 0.8;
  return {
    id, category: 'gpu-rack', vendor: 'Generic', model: '72-accelerator rack-scale domain', name: `Rack-scale liquid-cooled domain class (72 accelerators, ${rackLabel})`,
    description: `72-accelerator liquid-cooled rack-scale domain: 18 × 1 OU compute trays (4 modules each), 9 × 1 OU scale-up switch trays, 9 OU power zone, on a ${rackLabel}. Parametric archetype — tray counts, kW and mass are editable estimates; vendor rack-scale systems are instances.`,
    dims: { ...hpr.dims }, weightKg: round(hpr.weightKg + 18 * 45 + 9 * 30 + 3 * 22 + 3 * 75, 0), clearance: { ...hpr.clearance },
    power: { nameplateKW, typicalKW: round(nameplateKW * 0.9, 1), idleKW: round(nameplateKW * 0.26, 1), peakKW: round(nameplateKW * 1.08, 1), rampUpKWps: 20, rampDownKWps: 20, feeds: 2, voltageV: 415 },
    cooling: { liquidFraction: round(liquidKW / nameplateKW, 4), airflowM3s: 0.35, liquidFlowLpm: round(liquidKW * 1.5, 1), maxInletC: 35, maxCoolantSupplyC: 45 },
    compute: {
      gpus: 72, gpuModel: `OAM 2.0 class module (${DLC.moduleCapW} W)`, cpus: 18, cpuModel: 'host CPU',
      scaleOutPortsPerGpu: 1, scaleOutPortGbps: 800, frontendPorts: 18, frontendPortGbps: 400, storagePorts: 0, storagePortGbps: 400, oobPorts: 28,
      gpuMemoryGB: 141, gpuFlopsPeak: 1.0e15, memBandwidthGBps: 4800, railsPerNode: 4, nodesPerRack: 18, gpusPerNode: 4,
      peakTflops: { bf16: 1000, fp8: 2000 },
      scaleUp: { kind: 'ualink', domainSize: 72, gbpsPerGpu: 800, spansRacks: false },
      accelerator: { vendor: 'Generic', family: 'OAM 2.0 class', formFactor: 'oam' },
    },
    cost: { capexUSD: 2_600_000, installHours: 60, leadTimeWeeks: 26 },
    rackUnits: hpr.rackUnits,
    asset: { color: '#2f3a44' },
    source: 'estimate',
    formFactor: { ...hpr.formFactor!, nodeHeightUnits: 1 },
    rackPower: hpr.rackPower,
    accelModule: { standard: 'oam-2.0', tdpW: DLC.moduleCapW, cooling: 'liquid' },
    standards: [
      ...(hpr.standards ?? []),
      std(OAM, 'open-spec', 'module', 'estimate', { note: 'module class assumed; capped at the envelope' }),
      std('ualink-200g@1.0', 'open-spec', 'network', 'unverified', { note: 'scale-up family is instance data' }),
    ],
    paramSources: {
      power: D(undefined, `18 trays × ${trayKW} kW + 9 switch trays × ${switchTrayKW} kW + management (all estimates)`),
      'meta.umap': E('tray positions'),
      weightKg: E('frame + trays + shelves'),
      'cost.capexUSD': E('price assumption'),
      compute: E('generic placeholder accelerator values'),
    },
    notes: `Parametric archetype (DO-2 second preset). ${nameplateKW} kW (estimate) is above the 93.5 kW stated for three HPR v1 shelf sets, so PW-01 warns on purpose: a denser rack needs 72 kW shelves in a separate power rack or a ±400 VDC sidecar. Payload excluding the frame is above the 800 kg cross-brace point (RK-02 note). All values except the frame and pitch are estimates.`,
    meta: { rackClass: 'rack-scale-liquid', rackForm: hpr.form, rackModel: hpr.id, archetype: true, umap, ruUsed: u - 1, ruCap: hpr.rackUnits },
  };
}

export const RACKSCALE_ARCHETYPE: CatalogItem = (() => {
  const it = rackscale72();
  return { ...it, specStatus: block({ id: it.id, category: 'other', name: '', model: '', description: '', notes: '', standards: it.standards }).specStatus };
})();

/** The rack-scale archetype on the wide OU rack (stream D / P4: default platform of the wide-rack liquid pod). */
export const RACKSCALE_ARCHETYPE_WIDE: CatalogItem = (() => {
  const it = rackscale72('rack-orw', 'rackscale-liquid-72-wide', 'wide OU rack');
  return { ...it, specStatus: block({ id: it.id, category: 'other', name: '', model: '', description: '', notes: '', standards: it.standards }).specStatus };
})();

// ───────────────────────────── network pod archetypes (facts only) ─────────────────────────────

/**
 * Network building blocks from the pod / cluster architecture documents (v1.0, 2026-01-14, CC BY-SA 4.0 — facts restated, no
 * connection maps or port tables). `basis: 'document'` sizes are defined in the documents; `'repository'` sizes exist only in the
 * reference-architecture repository and are labelled as such.
 */
export const NETWORK_POD_ARCHETYPES = [
  {
    id: 'pod-opg-128', basis: 'document' as const, standardId: 'opg-m@1.0', xpus: 128, nodes: 16, xpusPerNode: 8,
    nodeNics: { scaleOut: { count: 8, gbps: 400, portsPerNic: 1 }, cpu: { count: 2, gbps: 100, portsPerNic: 2 } },
    scaleOut: {
      clos: { leaves: 2, switchClass: 'switch-eth-51t-64x800' },
      railOptimised: { leaves: 4, switchClass: 'switch-eth-26t-32x800', nicLinksPerNodePerLeaf: 2 },
      leafPortSplit: 'half down / half up', spineInsidePod: false,
    },
    otherFabrics: { scaleOutCpu: { count: 1, switchClass: 'switch-eth-26t-32x800' }, storage: { count: 1, switchClass: 'switch-eth-51t-64x800' }, inBand: { count: 1, switchClass: 'switch-eth-25g-48' }, outOfBand: { count: 2, switchClass: 'switch-oob-1g-48' } },
    optics: '800G OSFP single-mode modules in 2 × 400G mode (500 m) and OSFP-to-2 × 400G direct-attach cables',
    airPodRacks: { racks: 9, pduKW: 23.2, deratedKW: [17, 18] },
    scope: 'air-cooled nodes with ≤8 accelerators and 400GbE scale-out only; the rack / PDU layout is not reused in liquid-cooled halls',
    verification: 'verified' as const,
    notes: '"8 rails" is contradicted by the document (4 rail leaves × 2 NIC links per node). A liquid-cooled 800G variant is unpublished.',
  },
  { id: 'cluster-xoc-1k', basis: 'document' as const, standardId: 'xoc-n@1.0', xpus: 1024, pods: { id: 'pod-opg-128', count: 8 }, scaleOutSpines: { count: 8, switchClass: 'switch-eth-51t-64x800' }, verification: 'verified' as const, notes: 'Above this size the documents give guidance only; hall spine layers stay estimates.' },
  { id: 'pod-opg-64', basis: 'repository' as const, standardId: 'training-fabric-ra@2026-08-23', xpus: 64, verification: 'unverified' as const, notes: 'Size exists only in the reference-architecture repository; its bill of materials differs from the document.' },
  { id: 'pod-opg-256', basis: 'repository' as const, standardId: 'training-fabric-ra@2026-08-23', xpus: 256, verification: 'unverified' as const, notes: 'Repository-only size.' },
  { id: 'pod-opg-512', basis: 'repository' as const, standardId: 'training-fabric-ra@2026-08-23', xpus: 512, verification: 'unverified' as const, notes: 'Repository-only size (4 × 128 is the cluster composition, not a pod).' },
  { id: 'cluster-xoc-256', basis: 'repository' as const, standardId: 'training-fabric-ra@2026-08-23', xpus: 256, verification: 'unverified' as const, notes: 'Repository-only size.' },
  { id: 'cluster-xoc-512', basis: 'repository' as const, standardId: 'training-fabric-ra@2026-08-23', xpus: 512, verification: 'unverified' as const, notes: 'Repository-only size.' },
] as const;

/** Redfish profile names published for infrastructure and host devices (vendor-neutral management identity; names as published). */
export const MGMT_PROFILE_TAGS = {
  standardId: 'hwmgmt-profiles@2026-09-01',
  profiles: ['OCPCoolantDistributionUnit.v1_0_0', 'OCPRearDoorHeatExchanger.v1_0_0', 'OCPPowerShelf.v1_0_0', 'OCPRackPDU.v1_0_0', 'OCPRackManagerController.v1_1_0'],
  note: 'Profile identifiers are external names; they are data, never feature names.',
} as const;

export const STD_COMPUTE_NETWORK_CATALOG: CatalogItem[] = [...NIC_FORM_FACTOR_BLOCKS, ...SWITCH_CLASS_BLOCKS, SWITCH_TRAY_BLOCK, ...GENERIC_COMPUTE_RACKS, RACKSCALE_ARCHETYPE, RACKSCALE_ARCHETYPE_WIDE];
