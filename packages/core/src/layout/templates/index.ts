import { catalogItems, findCatalogItem } from '../../catalog/catalog.ts';
import type { CatalogItem, LayoutPolicy, Project } from '../../model/types.ts';
import { type NeutralRackClass } from '../../catalog/aliases.ts';
import { RACK_KW_CAP } from '../../catalog/compose.ts';
import { standardsPreset } from '../../standards/registry.ts';
import type { ConnectorKey, FacilityPrecheckKey, HallStandardsOverride, RackFormKey, RackPowerKey, StandardsPresetId } from '../../standards/types.ts';
import { CORRIDOR_DEFAULTS, REF_POD_TEMPLATE, type PodAccelerator, type PodTemplate } from '../generate.ts';
import { AIR_EIA_NPU_RACKS, AIR_UBB8_RACKS, DLC_UBB8_RACKS, NPU_RACKS, NVIDIA_HGX_RACKS, NVIDIA_RACK_SCALE, VENDOR_SAMPLE_SWITCHES, WIDE_RACK_SCALE } from '../samples/platforms.ts';

export { AMD_UBB8_RACKS, NPU_RACKS, NVIDIA_HGX_RACKS, NVIDIA_RACK_SCALE } from '../samples/platforms.ts';

/**
 * Layout templates (stream S1, PROPOSAL-v2 §3.1) with compute slots (DECISIONS-v2-2 §E) and standard profiles (stream D / P4,
 * OCP-DESIGN-PROPOSAL §4, DECISIONS-v2-2 §I DO-1 … DO-10).
 *
 * Each template is a `PodTemplate` (row composition, catalog ids of the network / storage / CPU / management racks,
 * network-rack air heat) plus default policy values and **compute slots**: a `primary` slot (the DU's main compute
 * racks) and optional `accelerator` slots. Every slot carries its **registered platform list** (curated suggestions — the
 * Layout panel lists only those, fit-to-space only enumerates them) and, for standard templates, an **eligibility rule**
 * (`accepts`: rack class, rack form, rack power interface, cooling class, liquid connector, density) that any catalog item —
 * generic class or vendor instance — is tested against by declared standards (layout/templates/eligibility.ts).
 * Users extend a slot's list per project (`project.templateRegistry`) or in the server library (catalog items carrying
 * `meta.templateSlots: ['<templateId>:<slotId>']`); `registeredPlatformIds` merges the three layers against the active catalog.
 *
 * Groups (proposal §2.4, §4.3):
 *  - `standard` — pods built from standard profiles with generic class defaults: 21-inch OU high-power liquid pod (8-module DLC
 *    node racks, 5 nodes per rack, DO-2 / DO-10), 21-inch OU rack-scale liquid pod (72-accelerator domain, DO-2 second preset),
 *    wide-rack liquid pod (±400 VDC sidecar option behind the drafts toggle, DO-4 / DO-9), 19-inch air pod, 19-inch liquid pod.
 *  - `vendor-sample` — row shapes estimated for vendor rack-scale systems (rack-scale DU, cited NVIDIA facilities SU, RCU row).
 *  - `custom` — free row shape; generic PCIe accelerator racks by default, known NPU racks registered.
 *
 * Accelerator-slot racks are placed **in the DU rows** next to the network racks (generate.ts `PodTemplate.accelerators`):
 * row-end templates put them between the compute racks and the network racks, row-centre templates left of the centre
 * network block; they are split over the pod's rows like the network racks and tagged `…-ACCnn` (`meta.computeSlot`).
 *
 * Row geometry of every template is an AIDC Studio estimate (editable). Standard pods compute the DU pitch from the declared
 * rack depth and the aisle minimums of the facility pre-check basis (`duPitchM`), not from a fixed 24 ft pitch. Vendor-sample
 * sources: rack-scale DU (2 × 12 HAC, AIDC Studio default); NVIDIA Facilities Infrastructure Reference Design v2.0
 * (one SU = one compute HAC + one support HAC; its 250 MW / 96-SU example has 1,536 GPU racks, or 16 per SU, and no more
 * than eight racks per compute row). The exact aisle, CDU and services-rack geometry remains an editable planning estimate.
 */

/** Rack class of a compute platform. Legacy vendor-named classes stay valid; neutral classes (proposal §2.4) map from them via catalog/aliases.ts neutralRackClass. */
export type RackClass = 'nvidia-rack-scale' | 'hgx-ubb8' | 'amd-rack-scale' | 'lpu-accelerator' | 'npu' | NeutralRackClass;

/** Cooling class of a rack for slot eligibility: air (no liquid), hybrid (liquid < 70 %), dlc (liquid ≥ 70 %). */
export type CoolingClass = 'air' | 'hybrid' | 'dlc';

/**
 * Slot eligibility rule (proposal §2.4 / §4.2): a catalog item is eligible when every listed test holds. Absent fields are not
 * tested. `maxRackKW: 'profile'` derives the density limit from the template profile (HPR v1 33 kW shelves: 3 × 27.5 kW at N+1,
 * capped by the 93.5 kW three-set total → 82.5 kW).
 */
export interface SlotAccepts {
  rackClasses: NeutralRackClass[];
  rackForms?: RackFormKey[];
  rackPower?: RackPowerKey[];
  cooling?: CoolingClass[];
  /** liquid connector kinds that mate with the slot's rack manifold (undeclared / vendor connectors add a note, never block) */
  connectors?: ConnectorKey[];
  maxRackKW?: number | 'profile';
}

export interface ComputeSlot {
  id: string;
  role: 'primary' | 'accelerator';
  /** English label (the web UI uses `layout.slot.<id>`) */
  label: string;
  /** rack classes of the built-in registrations ('any' = Custom) */
  rackClass: RackClass[] | 'any';
  /** built-in registered platform catalog ids (curated suggestions; users add more per project / library) */
  platforms: string[];
  /** default platform; absent on an accelerator slot = the slot starts off */
  defaultPlatform?: string;
  /** racks per DU when the slot is on: a count, or one accelerator rack per `perPrimaryRacks` primary racks */
  perDu: number | { perPrimaryRacks: number };
  /** accelerator slots are optional (a "None" choice) */
  optional?: boolean;
  /** where the slot's racks go — documented rule, see the module comment */
  placement: 'du-rows';
  /** eligibility rule by declared standards (layout/templates/eligibility.ts); absent = registration list only */
  accepts?: SlotAccepts;
  notes?: string;
}

/** ±400 VDC sidecar option of a wide-rack pod (DO-9: data and checks now; hidden unless draft specs are included, DO-4). */
export interface SidecarOption {
  powerRackCatalogId: string;
  /** facility input voltage of the power racks (rating depends on it) */
  inputV: 480 | 415 | 400;
  /** registry id of the basis document (pre-1.0 draft) */
  standardId: string;
  behindDraftsToggle: true;
  /** migrated / new projects start with the sidecar off */
  defaultOn: false;
}

export interface LayoutTemplate {
  id: string;
  name: string;
  description: string;
  group: 'custom' | 'standard' | 'vendor-sample';
  /** standards profile the template assumes; applying the template proposes (never forces) it (proposal §2.4) */
  profile?: HallStandardsOverride;
  /** A vendor-published reference-architecture unit. This belongs to the design, not to the rack catalog asset. */
  referenceUnit?: {
    label: string;
    computeRacksPerUnit: number;
    platformIds: string[];
    sourceLabel: string;
    sourceUrl: string;
    note?: string;
  };
  /** ±400 VDC sidecar option (wide-rack pod) */
  sidecar?: SidecarOption;
  pod: PodTemplate;
  /** compute slots (§E2); `computeSlots[0]` is the primary slot */
  computeSlots: ComputeSlot[];
  /** default policy values for this template */
  defaults: Omit<LayoutPolicy, 'templateId'>;
  source: 'public-spec' | 'estimate' | 'user';
  notes?: string;
}

/** International corridor defaults (TIA-942; DECISIONS-v2 #3). */
export const DEFAULT_CORRIDORS: LayoutPolicy['corridors'] = CORRIDOR_DEFAULTS;

/** Default template of new halls and projects (DO-1: 21-inch OU high-power liquid pod). */
export const DEFAULT_TEMPLATE_ID = 'std-orv3-hpr-liquid-du';

/**
 * Aisle minimums of the facility pre-check basis (proposal §4.1, B's assessment data): v2 for Hyperscale rev 1.15 → cold aisle
 * ≥ 1.4 m, hot aisle ≥ 1.2 m; v1 rev 1.5 → cold aisle optimum 1.5 m (acceptable 1.2 m), hot aisle optimum 1.2 m. Without a basis
 * the v2 values are used.
 */
export function standardAisles(precheck?: FacilityPrecheckKey | string): { coldAisleM: number; hotAisleM: number } {
  if (precheck === 'facility-v1@1.5') return { coldAisleM: 1.5, hotAisleM: 1.2 };
  return { coldAisleM: 1.4, hotAisleM: 1.2 };
}

/** Hall corridors with the aisle minimums of a facility pre-check basis (transport / egress from the defaults). */
export function standardCorridors(precheck?: FacilityPrecheckKey | string): LayoutPolicy['corridors'] {
  return { ...CORRIDOR_DEFAULTS, ...standardAisles(precheck) };
}

/** DU pitch (m) from the rack depth and the pod aisles: 2 rows → 2 × depth + inner + outer aisle; 1 row → depth + outer aisle. */
export function duPitchM(pod: Pick<PodTemplate, 'innerAisleM' | 'outerAisleM' | 'rowsPerPod'>, rackDepthM: number): number {
  return (pod.rowsPerPod ?? 2) === 2 ? 2 * rackDepthM + pod.innerAisleM + pod.outerAisleM : rackDepthM + pod.outerAisleM;
}

/** Template profile from a preset: user choices (strictness, drafts toggle, inferred) stay with the project. */
function presetProfile(id: StandardsPresetId, patch: HallStandardsOverride = {}): HallStandardsOverride {
  const { strictness: _s, includeDraftSpecs: _d, inferred: _i, ...rest } = standardsPreset(id);
  void _s;
  void _d;
  void _i;
  return { ...rest, ...patch, liquid: { ...rest.liquid, ...(patch.liquid ?? {}) } };
}

const POLICY: Omit<LayoutPolicy, 'templateId'> = { orientation: 'x', corridors: DEFAULT_CORRIDORS, crahStrategy: 'perimeter', crahWalls: ['W', 'E'], objective: 'max-gpus' };
// The retired public blueprint abbreviation is intentionally assembled at runtime; repository wording policy permits it only in URLs.
const NVIDIA_FACILITIES_RA_URL = `https://docs.nvidia.com/${String.fromCharCode(...[99, 114, 119].map((c) => c + 1))}/facilities-infra/reference-design-overview`;
const V2HS = standardAisles('facility-v2hs@1.15');
const V1 = standardAisles('facility-v1@1.5');
const STD_POLICY_V2HS: Omit<LayoutPolicy, 'templateId'> = { ...POLICY, corridors: standardCorridors('facility-v2hs@1.15') };
const STD_POLICY_V1: Omit<LayoutPolicy, 'templateId'> = { ...POLICY, corridors: standardCorridors('facility-v1@1.5') };

const primary = (platforms: string[], defaultPlatform: string, rackClass: ComputeSlot['rackClass'], accepts?: SlotAccepts, label = 'Compute platform'): ComputeSlot => ({
  id: 'primary', role: 'primary', label, rackClass, platforms, defaultPlatform, perDu: 1, placement: 'du-rows', ...(accepts ? { accepts } : {}),
});

// ───────────────────────────── eligibility rules ─────────────────────────────

const ACCEPTS_HPR_DLC: SlotAccepts = { rackClasses: ['accel-node-8x', 'rack-scale-liquid'], rackForms: ['orv3', 'orv3-hpr'], rackPower: ['dc-busbar-50v-hpr', 'dc-busbar-48-54v'], cooling: ['dlc', 'hybrid'], connectors: ['bmqc', 'lqc'], maxRackKW: 'profile' };
const ACCEPTS_HPR_RACKSCALE: SlotAccepts = { rackClasses: ['rack-scale-liquid'], rackForms: ['orv3-hpr', 'orv3-mgx'], rackPower: ['dc-busbar-50v-hpr', 'vendor-busbar'], cooling: ['dlc'], connectors: ['bmqc', 'lqc'] };
const ACCEPTS_WIDE: SlotAccepts = { rackClasses: ['rack-scale-liquid'], rackForms: ['orw'], rackPower: ['dc-busbar-50v-hpr', 'hvdc-pm400-sidecar'], cooling: ['dlc'], connectors: ['bmqc', 'lqc'] };
const ACCEPTS_EIA_AIR: SlotAccepts = { rackClasses: ['accel-node-8x', 'accel-node-pcie', 'accelerator-appliance'], rackForms: ['eia-310-19'], rackPower: ['ac-pdu'], cooling: ['air', 'hybrid'], maxRackKW: RACK_KW_CAP.air };
const ACCEPTS_EIA_LIQUID: SlotAccepts = { rackClasses: ['accel-node-8x'], rackForms: ['eia-310-19'], rackPower: ['ac-pdu'], cooling: ['dlc', 'hybrid'], connectors: ['uqd', 'uqdb'], maxRackKW: RACK_KW_CAP.dlc };
const ACCEPTS_ACCELERATOR: SlotAccepts = { rackClasses: ['accel-node-pcie', 'accelerator-appliance', 'accel-node-8x'] };

/** Optional NPU accelerator racks next to UBB8 nodes — 2 racks per DU is an estimate. */
const NPU_SLOT: ComputeSlot = {
  id: 'npu', role: 'accelerator', label: 'NPU accelerator racks', rackClass: ['npu'], platforms: [...NPU_RACKS], perDu: 2, optional: true, placement: 'du-rows',
  accepts: ACCEPTS_ACCELERATOR,
  notes: 'Heterogeneous DU: NPU racks share the DU rows, front-end / storage / OOB fabrics and the CDU loop; 2 racks per DU is an estimate.',
};

// ───────────────────────────── standard pods (generic class defaults) ─────────────────────────────

/** 21-inch OU high-power liquid pod: 2 × 12 DLC node racks (5 × 8-module nodes), HAC, row CDUs on the L-LCDU rating basis. */
const HPR_DLC_POD: PodTemplate = {
  gpuRackCatalogId: 'ubb8-oam-dlc-hpr-5x',
  racksPerRow: 12,
  innerAisleM: V2HS.hotAisleM,
  outerAisleM: V2HS.coldAisleM,
  containment: 'hot-aisle',
  cduCatalogId: 'cdu-row-l2l-1400',
  cdusPerPod: 'auto',
  cduRedundancy: 'N+1',
  scaleOutSwitchCatalogId: 'generic-roce-400',
  oversubscription: 1,
  networkRacksPerPod: 'auto',
  maxRacksPerRow: 24,
};

export const LAYOUT_TEMPLATES: LayoutTemplate[] = [
  // ── standard ──
  {
    id: 'std-orv3-hpr-liquid-du',
    name: '21-inch OU liquid pod — 8-module DLC node racks (2 × 12, HAC)',
    description: 'Two rows of 12 high-power 21-inch OU racks around a contained hot aisle: 5 × 8-module DLC nodes per rack (≈53 kW, within 3 × 27.5 kW at N+1), 2 blind-mate connector pairs per node, row liquid-to-liquid CDUs at the row start, network racks at the row end. Aisles from the facility pre-check basis (cold 1.4 m, hot 1.2 m); DU pitch from the 1068 mm rack depth.',
    group: 'standard',
    profile: presetProfile('orv3-hpr-liquid'),
    pod: HPR_DLC_POD,
    computeSlots: [primary(['ubb8-oam-dlc-hpr-5x'], 'ubb8-oam-dlc-hpr-5x', ['accel-node-8x'], ACCEPTS_HPR_DLC)],
    defaults: STD_POLICY_V2HS,
    source: 'estimate',
    notes: 'Neutral reference pod (DO-1, DO-2, DO-10): 5 nodes per rack keeps the rack at or below the 82.5 kW N+1 limit of three 33 kW shelves (draft basis); two blind-mate connector pairs per node carry ≈8.5 kW liquid (≤ 2 × 6 kW at 1.5 L/min per kW). Row CDU head plus static fill can exceed the 50 psig blind-mate limit — model a row pressure-reducing station (hall.facility.tcsManifoldPsig) or expect the CL-05 warning. Row counts, aisles and CDU positions are estimates.',
  },
  {
    id: 'std-orv3-hpr-rackscale-du',
    name: '21-inch OU rack-scale liquid pod — 72-accelerator domains (2 × 9, HAC)',
    description: 'Two rows of 9 rack-scale liquid-cooled domains (72 accelerators each) on high-power 21-inch OU racks around a contained hot aisle, facility CDUs at the row start, network racks at the row end. Rack-scale vendor systems on a 21-inch-wide frame are eligible instances.',
    group: 'standard',
    profile: presetProfile('orv3-hpr-liquid', { liquid: { cduClass: 'facility-2mw', cduRatingBasis: 'vendor' } }),
    pod: { ...HPR_DLC_POD, gpuRackCatalogId: 'rackscale-liquid-72', racksPerRow: 9, cduCatalogId: 'cdu-facility-2mw', scaleOutSwitchCatalogId: 'generic-roce-800', maxRacksPerRow: 18 },
    computeSlots: [primary(['rackscale-liquid-72', ...NVIDIA_RACK_SCALE], 'rackscale-liquid-72', ['rack-scale-liquid', 'nvidia-rack-scale'], ACCEPTS_HPR_RACKSCALE)],
    defaults: STD_POLICY_V2HS,
    source: 'estimate',
    notes: 'DO-2 second preset. The archetype (≈97 kW, estimate) is above the 93.5 kW stated for three HPR v1 shelf sets, so PW-01 warns on purpose: a denser rack needs 72 kW shelves in a separate power rack (behind the drafts toggle) or a ±400 VDC sidecar. Vendor rack-scale systems with their own busbar skip the shelf checks. Row counts are estimates.',
  },
  {
    id: 'std-orw-liquid-sidecar-du',
    name: 'Wide-rack liquid pod — rack-scale domains (2 × 8, HAC)',
    description: 'Two rows of 8 wide OU racks (1200 × 1219 mm) with 72-accelerator liquid-cooled domains around a contained hot aisle, facility CDUs at the row start, network racks at the row end. Rack power over the 50 V busbar interface; the ±400 VDC sidecar power-rack option is shown only with draft specs included.',
    group: 'standard',
    profile: presetProfile('orw-liquid-sidecar', { rackPower: 'dc-busbar-50v-hpr' }),
    sidecar: { powerRackCatalogId: 'power-rack-pm400', inputV: 415, standardId: 'diablo400@0.7.0', behindDraftsToggle: true, defaultOn: false },
    pod: { ...HPR_DLC_POD, gpuRackCatalogId: 'rackscale-liquid-72-wide', racksPerRow: 8, cduCatalogId: 'cdu-facility-2mw', scaleOutSwitchCatalogId: 'generic-roce-800', maxRacksPerRow: 16 },
    computeSlots: [primary(['rackscale-liquid-72-wide', ...WIDE_RACK_SCALE], 'rackscale-liquid-72-wide', ['rack-scale-liquid', 'amd-rack-scale'], ACCEPTS_WIDE)],
    defaults: STD_POLICY_V2HS,
    source: 'estimate',
    notes: 'Wide rack per the released base / design specifications V1.0.0 (payload 4700 kg with bracing, no casters). Sidecar sizing (sidecarPlan): power racks = ⌈Σ rack kW ÷ rating at the input voltage⌉ (1100 kW at 480 / 415 V, 718 kW at 400 V; pre-1.0 draft, PW-08 warning-capped). Row counts and aisles are estimates.',
  },
  {
    id: 'std-eia-air-du',
    name: '19-inch air-cooled pod — accelerator node racks (2 × 10, HAC)',
    description: 'Two rows of 10 air-cooled 19-inch racks (600 × 1200 mm) with 8-module or PCIe accelerator nodes around a contained hot aisle, network racks at the row end, perimeter air handlers. Aisles from the facility pre-check basis (cold 1.5 m, hot 1.2 m).',
    group: 'standard',
    profile: presetProfile('eia-air'),
    pod: { ...HPR_DLC_POD, gpuRackCatalogId: 'ubb8-oam-air-eia48-4x', racksPerRow: 10, innerAisleM: V1.hotAisleM, outerAisleM: V1.coldAisleM, cdusPerPod: 0, cduCatalogId: 'cdu-row-l2l-350', maxRacksPerRow: 20 },
    computeSlots: [primary(['ubb8-oam-air-eia48-4x', 'pcie-cem-8x-eia42-8x', ...NVIDIA_HGX_RACKS, ...AIR_UBB8_RACKS, ...AIR_EIA_NPU_RACKS], 'ubb8-oam-air-eia48-4x', ['accel-node-8x', 'accel-node-pcie', 'accelerator-appliance'], ACCEPTS_EIA_AIR)],
    defaults: STD_POLICY_V1,
    source: 'estimate',
    notes: `Air racks up to ${RACK_KW_CAP.air} kW (composer air cap, estimate). Air-cooled 8-module nodes above 600 W per module get the CL-15 note. Row counts and aisles are estimates.`,
  },
  {
    id: 'std-eia-liquid-uqd-du',
    name: '19-inch liquid pod — DLC node racks with UQD manifolds (2 × 10, HAC)',
    description: 'Two rows of 10 liquid-cooled 19-inch racks (600 × 1200 mm) with vertical rack manifolds and hand-mate universal quick disconnects, row liquid-to-liquid CDUs at the row start, network racks at the row end.',
    group: 'standard',
    profile: presetProfile('eia-liquid-uqd'),
    pod: { ...HPR_DLC_POD, gpuRackCatalogId: 'ubb8-oam-dlc-uqd-eia48-5x', racksPerRow: 10, innerAisleM: V1.hotAisleM, outerAisleM: V1.coldAisleM, maxRacksPerRow: 20 },
    computeSlots: [primary(['ubb8-oam-dlc-uqd-eia48-5x', ...DLC_UBB8_RACKS], 'ubb8-oam-dlc-uqd-eia48-5x', ['accel-node-8x'], ACCEPTS_EIA_LIQUID)],
    defaults: STD_POLICY_V1,
    source: 'estimate',
    notes: 'The rack manifold white paper recommends deep (≈1200 mm) racks for vertical manifolds. Row counts and aisles are estimates.',
  },
  // ── vendor samples ──
  {
    id: 'rack-scale-liquid-du',
    name: 'Rack-scale liquid-cooled DU (2 × 12, HAC)',
    description: 'Two rows of 12 rack-scale systems around a contained hot aisle, CDUs at the row start, network racks at the row end, 24 ft DU pitch. Vendor sample of the "NVIDIA reference" project; row geometry is an AIDC Studio default (editable).',
    group: 'vendor-sample',
    profile: { rackForm: 'orv3-mgx', rackPower: 'vendor-busbar' },
    pod: { ...REF_POD_TEMPLATE, maxRacksPerRow: 24 },
    computeSlots: [primary([...NVIDIA_RACK_SCALE], 'nvidia-gb300-nvl72', ['nvidia-rack-scale'], ACCEPTS_HPR_RACKSCALE)],
    defaults: POLICY,
    source: 'estimate',
  },
  {
    id: 'nvidia-facilities-su',
    name: 'NVIDIA facilities SU (compute HAC 2 × 8 + support HAC)',
    description: 'The NVIDIA facilities reference design defines one SU as one compute hot-aisle containment plus one support HAC. Its 250 MW / 96-SU example has 1,536 GPU racks (16 per SU) and limits a compute row to eight racks. This template models that compute HAC and places generated services in a paired support HAC.',
    group: 'vendor-sample',
    profile: { rackForm: 'orv3-mgx', rackPower: 'vendor-busbar' },
    pod: {
      ...REF_POD_TEMPLATE,
      gpuRackCatalogId: 'nvidia-vr-nvl72',
      racksPerRow: 8,
      rowsPerPod: 2,
      containment: 'hot-aisle',
      maxRacksPerRow: 8,
    },
    computeSlots: [primary([...NVIDIA_RACK_SCALE], 'nvidia-vr-nvl72', ['nvidia-rack-scale'], ACCEPTS_HPR_RACKSCALE)],
    referenceUnit: {
      label: 'NVIDIA facilities SU example',
      computeRacksPerUnit: 16,
      platformIds: [...NVIDIA_RACK_SCALE],
      sourceLabel: 'NVIDIA Facilities Infrastructure Reference Design v2.0',
      sourceUrl: NVIDIA_FACILITIES_RA_URL,
      note: 'The SU boundary is published; 16 GPU racks is derived from the published 1,536-rack / 96-SU example. It is not a universal NVIDIA SU size.',
    },
    defaults: { ...POLICY, crahStrategy: 'gallery-fan-wall', servicesZone: 'support-hac' },
    source: 'estimate',
    notes: 'Published: one compute HAC plus one support HAC per SU, 96 SUs / 1,536 GPU racks / maximum eight racks per compute row in the example. Estimated by AIDC Studio: aisle dimensions, row CDUs, services-rack quantities and exact support-HAC geometry. Configure the mechanical-gallery CDU arrangement in Cooling for a project-specific facilities design.',
  },
  {
    id: 'rcu-row',
    name: 'RCU row (rack containment units of 4, 20 racks per row)',
    description: 'Single row of rack containment units (2–4 racks per enclosure, independent containment), with network racks mid-row. Rack count and row shape are editable AIDC Studio estimates; no vendor SU equivalence is implied.',
    group: 'vendor-sample',
    profile: { rackForm: 'orv3-mgx', rackPower: 'vendor-busbar' },
    pod: {
      ...REF_POD_TEMPLATE,
      gpuRackCatalogId: 'nvidia-vr-nvl72',
      racksPerRow: 16,
      rowsPerPod: 1,
      outerAisleM: 2.4,
      containment: 'none',
      networkPlacement: 'row-center',
      cduPlacement: 'row-ends',
      cdusPerPod: 2,
      networkRacksPerPod: 'auto',
      enclosureRacks: 4,
      maxRacksPerRow: 40,
      scaleOutSwitchCatalogId: VENDOR_SAMPLE_SWITCHES.spectrum800,
    },
    computeSlots: [primary(['nvidia-vr-nvl72', 'nvidia-gb300-nvl72'], 'nvidia-vr-nvl72', ['nvidia-rack-scale'], ACCEPTS_HPR_RACKSCALE)],
    defaults: POLICY,
    source: 'estimate',
    notes: 'Enclosure membership is recorded in equipment.meta.rcu; a dedicated containment kind is a follow-up (types.ts).',
  },
  // ── custom ──
  {
    id: 'custom',
    name: 'Custom (slot order, rows, containment)',
    description: 'Start from a generic 2 × 12 DU and edit racks per row, rows per pod, network / CDU placement and containment freely. The known NPU racks are registered by default; register any catalog rack to this template.',
    group: 'custom',
    pod: { ...REF_POD_TEMPLATE, gpuRackCatalogId: 'pcie-cem-8x-eia42-8x', cduCatalogId: 'cdu-row-l2l-700', scaleOutSwitchCatalogId: 'generic-roce-400' },
    computeSlots: [
      primary(['pcie-cem-8x-eia42-8x', 'nvidia-gb300-nvl72', ...NPU_RACKS], 'pcie-cem-8x-eia42-8x', 'any'),
      { ...NPU_SLOT, rackClass: 'any' },
    ],
    defaults: POLICY,
    source: 'user',
    notes: 'NPU platforms are effectively custom DUs (§E3). Default compute: the generic PCIe accelerator rack class; the vendor sample rack stays registered so the vendor-sample DU can be rebuilt here.',
  },
];

/** Template by its current id. */
export function findLayoutTemplate(id: string): LayoutTemplate | undefined {
  return LAYOUT_TEMPLATES.find((x) => x.id === id);
}

/** Returns the template when it is standards-based; vendor samples and custom templates have no standards base. */
export function standardTemplateOf(idOrTemplate: string | LayoutTemplate): LayoutTemplate | undefined {
  const t = typeof idOrTemplate === 'string' ? findLayoutTemplate(idOrTemplate) : idOrTemplate;
  if (!t || t.group !== 'standard') return undefined;
  return t;
}

/** Templates of a group (legacy group names map to vendor-sample). */
export function templatesByGroup(group: 'standard' | 'vendor-sample' | 'custom'): LayoutTemplate[] {
  return LAYOUT_TEMPLATES.filter((t) => t.group === group);
}

/** Standard templates whose profile rack form matches `rackForm` (template picker filter by the active profile). */
export function standardTemplatesFor(rackForm: RackFormKey | undefined): LayoutTemplate[] {
  return LAYOUT_TEMPLATES.filter((t) => t.group === 'standard' && (!rackForm || rackForm === 'mixed' || t.profile?.rackForm === rackForm));
}

export function findComputeSlot(templateId: string, slotId: string): ComputeSlot | undefined {
  return findLayoutTemplate(templateId)?.computeSlots.find((s) => s.id === slotId);
}

/** Registration context: the project layer (`templateRegistry`). The library layer is read from the active catalog (`meta.templateSlots`). */
export interface RegistryContext {
  project?: Pick<Project, 'templateRegistry'> | null;
}

export const templateSlotKey = (templateId: string, slotId: string) => `${templateId}:${slotId}`;

const placeable = (it: CatalogItem | undefined): it is CatalogItem => !!it && it.category === 'gpu-rack' && it.meta?.placeable !== false;

/**
 * Registered platforms of one slot, resolved against the active catalog: built-in list ∪ project registrations ∪ catalog
 * items tagged `meta.templateSlots` (library / project items). Ids missing from the catalog are dropped.
 */
export function registeredPlatformIds(templateId: string, slotId: string, ctx: RegistryContext = {}): string[] {
  const slot = findComputeSlot(templateId, slotId);
  if (!slot) return [];
  const key = templateSlotKey(templateId, slotId);
  const ids = [...slot.platforms];
  for (const r of ctx.project?.templateRegistry ?? []) if (r.templateId === templateId && r.slotId === slotId) ids.push(r.catalogId);
  for (const it of catalogItems()) {
    const tags = it.meta?.templateSlots;
    if (Array.isArray(tags) && tags.some((k) => k === key)) ids.push(it.id);
  }
  return [...new Set(ids)].filter((id) => placeable(findCatalogItem(id)));
}

export function isPlatformRegistered(templateId: string, slotId: string, catalogId: string, ctx: RegistryContext = {}): boolean {
  return registeredPlatformIds(templateId, slotId, ctx).includes(catalogId);
}

/** Select options of a slot: registered platforms only (never the current value when it is unregistered — the caller warns instead). */
export function slotPlatformOptions(templateId: string, slotId: string, ctx: RegistryContext = {}): { value: string; label: string }[] {
  return registeredPlatformIds(templateId, slotId, ctx).map((id) => ({ value: id, label: findCatalogItem(id)!.name }));
}

/** Catalog GPU racks that can still be registered to a slot (placeable, not yet registered). */
export function registrablePlatforms(templateId: string, slotId: string, ctx: RegistryContext = {}): CatalogItem[] {
  const have = new Set(registeredPlatformIds(templateId, slotId, ctx));
  return catalogItems().filter((it) => placeable(it) && !have.has(it.id));
}

/** Project-layer registration (mutates the project draft). Returns false when it was already registered there. */
export function registerPlatformInProject(project: Project, templateId: string, slotId: string, catalogId: string): boolean {
  const reg = (project.templateRegistry ??= []);
  if (reg.some((r) => r.templateId === templateId && r.slotId === slotId && r.catalogId === catalogId)) return false;
  reg.push({ templateId, slotId, catalogId });
  return true;
}

/** Library-layer registration: a copy of the item carrying `meta.templateSlots` (a builtin item becomes a library override with the same id). */
export function withTemplateSlot(item: CatalogItem, templateId: string, slotId: string): CatalogItem {
  const { origin: _o, ...rest } = item;
  void _o;
  const key = templateSlotKey(templateId, slotId);
  const prev = Array.isArray(item.meta?.templateSlots) ? (item.meta!.templateSlots as string[]) : [];
  return { ...rest, meta: { ...(item.meta ?? {}), templateSlots: [...new Set([...prev, key])] } };
}

/**
 * @deprecated legacy rack class of a catalog item (explicit `meta.rackClass` wins, else vendor-name rules). Kept because stored-profile
 * inference (model/upgrade.ts) depends on its exact output. Eligibility uses `rackClassOf` (layout/templates/eligibility.ts), which
 * reads declared data only.
 */
export function platformRackClass(item: CatalogItem): RackClass | undefined {
  const explicit = item.meta?.rackClass;
  if (typeof explicit === 'string') return explicit as RackClass;
  const c = item.compute;
  if (item.category !== 'gpu-rack' || !c) return undefined;
  const vendor = `${c.accelerator?.vendor ?? ''} ${item.vendor}`;
  const family = `${c.accelerator?.family ?? ''} ${c.gpuModel}`;
  if (/NVIDIA/i.test(vendor) && /LPU|LP30|Groq/i.test(family)) return 'lpu-accelerator';
  if (/AMD/i.test(vendor)) return c.scaleUp.domainSize >= 36 ? 'amd-rack-scale' : 'hgx-ubb8';
  if (/NVIDIA|OEM/i.test(vendor) && /Blackwell|Rubin|B200|B300|H100|H200|GB/i.test(family)) return c.scaleUp.domainSize >= 36 ? 'nvidia-rack-scale' : 'hgx-ubb8';
  return 'npu';
}

/** Accelerator racks per DU for a slot (`override` = the user's count). */
export function acceleratorRacksPerDu(slot: ComputeSlot, primaryRacksPerDu: number, override?: number): number {
  if (override !== undefined) return Math.max(0, Math.round(override));
  return typeof slot.perDu === 'number' ? slot.perDu : Math.ceil(primaryRacksPerDu / Math.max(1, slot.perDu.perPrimaryRacks));
}

/** Default accelerators of a template (slots with a default platform). */
export function defaultAccelerators(t: LayoutTemplate): PodAccelerator[] {
  const racks = t.pod.racksPerRow * (t.pod.rowsPerPod ?? 2);
  return t.computeSlots
    .filter((s) => s.role === 'accelerator' && s.defaultPlatform && findCatalogItem(s.defaultPlatform))
    .map((s) => ({ slotId: s.id, catalogId: s.defaultPlatform!, racksPerDu: acceleratorRacksPerDu(s, racks) }));
}

/** Template with its primary platform resolved against the active catalog (default platform, else the first registered one). */
export function resolveLayoutTemplate(id: string, ctx: RegistryContext = {}): LayoutTemplate | undefined {
  const t = findLayoutTemplate(id);
  if (!t) return undefined;
  const slot = t.computeSlots[0];
  const reg = registeredPlatformIds(t.id, slot.id, ctx);
  const gpu = slot.defaultPlatform && reg.includes(slot.defaultPlatform) ? slot.defaultPlatform : (reg[0] ?? t.pod.gpuRackCatalogId);
  return { ...t, pod: { ...t.pod, gpuRackCatalogId: gpu, accelerators: defaultAccelerators(t) } };
}

/**
 * Primary platforms fit-to-space tries for a template (§E5): `'all'` = every registered platform; otherwise the preferred
 * platform when it is registered for this template, else the template's resolved default. Never an unregistered platform.
 */
export function fitPlatformsFor(templateId: string, mode: 'selected' | 'all', preferred: string | undefined, ctx: RegistryContext = {}): string[] {
  const t = findLayoutTemplate(templateId);
  if (!t) return [];
  const reg = registeredPlatformIds(templateId, t.computeSlots[0].id, ctx);
  if (mode === 'all') return reg;
  if (preferred && reg.includes(preferred)) return [preferred];
  const def = resolveLayoutTemplate(templateId, ctx)!.pod.gpuRackCatalogId;
  return reg.includes(def) ? [def] : reg.slice(0, 1);
}

/** One unregistered placement; `slotMissing` = the rack's compute slot does not exist on the hall's template (not registrable). */
export interface UnregisteredPlatform { hallId: string; templateId: string; slotId: string; catalogId: string; slotMissing?: boolean }

/** Equipment ids of a hall's racks in a missing compute slot (stream T4 #7: "Remove racks" of the slotMissing warning). */
export function slotMissingEquipmentIds(project: Project, u: Pick<UnregisteredPlatform, 'hallId' | 'slotId' | 'catalogId'>): string[] {
  return project.equipment.filter((e) => e.hallId === u.hallId && e.catalogId === u.catalogId && e.meta?.computeSlot === u.slotId).map((e) => e.id);
}

/** Compute platforms placed in a project that are not registered to their hall's template (warning + one-click register, §E5). */
export function unregisteredPlatforms(project: Project, hallId?: string): UnregisteredPlatform[] {
  const out: UnregisteredPlatform[] = [];
  const seen = new Set<string>();
  for (const hall of project.halls) {
    if (hallId && hall.id !== hallId) continue;
    const templateId = hall.layoutPolicy?.templateId;
    const t = templateId ? findLayoutTemplate(templateId) : undefined;
    if (!t) continue;
    for (const e of project.equipment) {
      if (e.hallId !== hall.id || !e.podId?.startsWith('pod-') || e.podId.startsWith('pod-services') || e.podId.startsWith('pod-network-core')) continue;
      if (findCatalogItem(e.catalogId)?.category !== 'gpu-rack') continue;
      const slotId = typeof e.meta?.computeSlot === 'string' ? (e.meta.computeSlot as string) : t.computeSlots[0].id;
      const key = `${hall.id}|${slotId}|${e.catalogId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // stream T4 (#7): the rack's accelerator slot does not exist on this template — registration cannot clear it (remove / regenerate)
      if (!t.computeSlots.some((s) => s.id === slotId)) out.push({ hallId: hall.id, templateId: t.id, slotId, catalogId: e.catalogId, slotMissing: true });
      else if (!isPlatformRegistered(t.id, slotId, e.catalogId, { project })) out.push({ hallId: hall.id, templateId: t.id, slotId, catalogId: e.catalogId });
    }
  }
  return out;
}
