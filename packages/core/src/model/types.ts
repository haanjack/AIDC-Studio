/**
 * AIDC Studio — canonical domain model (the shared contract between all modules).
 *
 * Conventions
 *  - Lengths: meters (m). Areas: m². Mass: kg.
 *  - Power: kW (electrical) / kW (thermal). Energy: MWh.
 *  - Temperature: °C. Air flow: m³/s. Liquid flow: L/min (LPM).
 *  - Money: USD (indicative, editable through Project.pricing).
 *  - Coordinates: hall-local, right-handed, Z-up (same as a Z-up OpenUSD stage, metersPerUnit=1).
 *      origin = hall's min corner at finished-floor level; x ∈ [0, hall.width], y ∈ [0, hall.depth].
 *  - Equipment position = center of the footprint on the floor (z = 0 unless mounted).
 *  - rotationDeg rotates CCW about +Z. At 0° the equipment FRONT (cold-air inlet / service side) faces +Y.
 *      front direction = (-sin θ, cos θ). Rear (exhaust) is the opposite.
 */

import type {
  HallStandardsOverride,
  ItemAccelModule,
  ItemBaseboard,
  ItemBbu,
  ItemCdu,
  ItemDoorHx,
  ItemFormFactor,
  ItemLiquidInterface,
  ItemPowerRack,
  ItemPowerShelf,
  ItemRackPower,
  ItemStandard,
  NicFormFactor,
  ParamProvenance,
  SpecStatus,
  StandardsProfile,
  Verification,
} from '../standards/types.ts';

export type Id = string;
export type ISODate = string; // YYYY-MM-DD

export interface Vec2 { x: number; y: number }
export interface Vec3 { x: number; y: number; z: number }
export interface Rect { x: number; y: number; w: number; d: number } // min corner + size (plan view)
export interface Dims { w: number; d: number; h: number } // width (local x), depth (local y), height (z)

// ───────────────────────────── Catalog ─────────────────────────────

export type EquipmentCategory =
  | 'gpu-rack'
  | 'cpu-rack'
  | 'storage-rack'
  | 'network-rack'
  | 'mgmt-rack'
  | 'switch' // housed inside network racks, not placed on the floor
  | 'nic' // network adapters (node composer / BOM only, never placed on the floor) — v2 S3
  | 'cdu'
  | 'crah'
  | 'fan-wall'
  | 'rpp'
  | 'busway-tapoff'
  | 'ups'
  | 'battery'
  | 'transformer'
  | 'generator'
  | 'switchgear'
  | 'chiller'
  | 'dry-cooler'
  | 'cooling-tower'
  | 'column'
  | 'other';

/** Where a spec value came from — shown in the UI so consultants know what to trust. */
/** Stored legacy values are mapped by `catalog/aliases.ts canonicalSpecSource` (applied once in `upgradeProject`). `open-standard` = value from a cited standard (registry id in `paramSources`). */
export type SpecSource = 'open-standard' | 'vendor-datasheet' | 'public-spec' | 'estimate' | 'announced' | 'user';

// ───────────────────────────── v2 shared unions ─────────────────────────────

/** Build-out strategy — drives default spine placement (DECISIONS-v2 #1). */
export type GrowthPattern = 'phased' | 'single-build';
/** Where leaf switches live relative to the compute rows. */
export type LeafPlacement = 'tor' | 'mid-row' | 'end-of-row';
/** Where spine/core switches live (comparator evaluates every candidate). */
export type SpinePlacement = 'distributed' | 'central-end' | 'central-center' | 'separate-room';
/** Electrical code / voltage profile of the site (DECISIONS-v2 #4). */
export type PowerProfile = 'iec' | 'nec' | 'kr';
/** Deliverable language (DECISIONS-v2 #10). */
export type Locale = 'en' | 'ko';

export interface ComputeSpec {
  gpus: number;
  gpuModel: string;
  cpus: number;
  cpuModel: string;
  /** Native accelerator scale-up fabric. This is not a deployment/scalable unit (SU). */
  scaleUp: {
    kind: 'nvlink' | 'ualink' | 'esun-ethernet' | 'vendor-proprietary' | 'pcie' | 'none';
    domainSize: number;
    /** Bidirectional bandwidth per accelerator (Gb/s). */
    gbpsPerGpu: number;
    family?: string;
    /** True only when the published scale-up domain crosses physical rack boundaries. */
    spansRacks?: boolean;
  };
  /** Scale-out (east-west) NIC ports per GPU and speed. */
  scaleOutPortsPerGpu: number;
  scaleOutPortGbps: number;
  /** Front-end (north-south) ports for the whole rack and their speed. */
  frontendPorts: number;
  frontendPortGbps: number;
  /** Storage network ports for the whole rack (0 = converged on front-end). */
  storagePorts: number;
  storagePortGbps: number;
  /** BMC / OOB 1GbE ports. */
  oobPorts: number;
  /** Per-GPU compute capability used by the workload simulator. */
  gpuMemoryGB: number;
  gpuFlopsPeak: number; // FLOPS at FP8/BF16 mixed (theoretical peak per GPU)
  // ── v2 accelerator abstraction (all optional; engines fall back to the fields above) ──
  /** HBM bandwidth per GPU (GB/s). Used by the inference decode model instead of the FLOPS-scaled proxy. */
  memBandwidthGBps?: number;
  /** Peak dense TFLOPS per GPU by precision (preferred over gpuFlopsPeak × multiplier when present). */
  peakTflops?: Partial<Record<'fp64' | 'fp32' | 'tf32' | 'bf16' | 'fp8' | 'fp4', number>>;
  /** Scale-out rails per node (NICs per node participating in the rail-optimized fabric). */
  railsPerNode?: number;
  nodesPerRack?: number;
  gpusPerNode?: number;
  accelerator?: { vendor: string; family: string; formFactor: 'oam' | 'sxm' | 'pcie' | 'wafer' | 'card' | 'custom' };
}

export interface NetworkSwitchSpec {
  fabric: FabricTech;
  ports: number; // logical ports at portGbps
  portGbps: number;
  rackUnits: number;
  role: 'leaf' | 'spine' | 'core' | 'any' | 'mgmt';
  // ── v2 (optional) — DDC / scheduled-fabric boxes with a fixed network-vs-fabric port split (DriveNets 5300R) ──
  /** endpoint-facing ports (NCP "network" ports); `ports` stays the total */
  netPorts?: number;
  /** fabric-facing ports toward NCF / spine */
  fabricPorts?: number;
  /** dedicated uplink ports beyond the access radix (management switches, e.g. SN2201 48 × 1G + 4 × 100G → 4) */
  uplinkPorts?: number;
}

/** Network adapter (category 'nic') — used by the node → rack composer and the BOM, never placed on the floor. */
export interface NicSpec {
  ports: number;
  portGbps: number;
  /** aggregate host-facing bandwidth per adapter (Gb/s) */
  totalGbps: number;
  /** NIC 3.0 outlines use `nic3-*` keys; the stored legacy key maps through catalog/aliases.ts canonicalNicFormFactor. */
  formFactor: NicFormFactor;
  hostInterface: string; // e.g. 'PCIe Gen5 x16', 'PCIe Gen6 x16'
  /** transport(s) the adapter is validated for */
  transports: ('ib' | 'roce' | 'uec' | 'spectrum-x')[];
  wattsTypical: number;
  wattsMax: number;
}

export interface StorageSpec {
  rawTB: number;
  usableTB: number;
  throughputGBps: number; // sustained read GB/s
}

export interface PowerSpec {
  nameplateKW: number; // design / TDP-based load
  typicalKW: number; // typical utilization load
  idleKW: number;
  peakKW: number; // short-term excursion (EDPP etc.)
  rampUpKWps?: number; // kW per second
  rampDownKWps?: number;
  feeds: number; // A/B feeds
  voltageV: number;
}

export interface CoolingSpec {
  /** Fraction of heat captured by liquid (0..1). 0 for air-cooled. */
  liquidFraction: number;
  /** Required airflow (m³/s) at nameplate. */
  airflowM3s: number;
  /** Required TCS liquid flow (LPM) at nameplate. */
  liquidFlowLpm: number;
  /** Max allowed inlet air temperature (°C). */
  maxInletC: number;
  /** Max allowed coolant supply temperature (°C). */
  maxCoolantSupplyC?: number;
  /** [inletC, m³/s] required airflow vs inlet temperature */
  airflowCurve?: [number, number][];
  /** [supplyC, LPM] required TCS flow vs coolant supply temperature */
  liquidFlowCurve?: [number, number][];
}

/** Capacity provided by infrastructure equipment. */
export interface CapacitySpec {
  coolingKW?: number; // CDU / CRAH / chiller thermal capacity
  airflowM3s?: number; // CRAH / fan wall airflow
  liquidFlowLpm?: number; // CDU secondary flow
  powerKVA?: number; // UPS / transformer / generator / RPP
  powerKW?: number;
  currentA?: number;
  inputVoltageV?: number;
  outputVoltageV?: number;
  batteryMinutes?: number;
}

export interface CostSpec {
  capexUSD: number; // equipment price
  installHours: number; // labor hours to install/commission one unit
  leadTimeWeeks: number;
}

export interface CatalogItem {
  id: string;
  category: EquipmentCategory;
  vendor: string;
  model: string;
  name: string;
  description: string;
  dims: Dims;
  weightKg: number;
  clearance: { front: number; rear: number; sides: number };
  power?: PowerSpec;
  cooling?: CoolingSpec;
  capacity?: CapacitySpec;
  compute?: ComputeSpec;
  storage?: StorageSpec;
  switch?: NetworkSwitchSpec;
  cost: CostSpec;
  /** Rack units available (for network/mgmt racks). */
  rackUnits?: number;
  asset?: {
    /** web GLB path relative to /assets/models (AIDC-generated models only). */
    glb?: string;
    /** USD path of an AIDC-generated asset (`usd/…`, relative to the exporter's generatedAssetRoot); any other path exports as a sized box. */
    usd?: string;
    /** fallback procedural look */
    color?: string;
  };
  source: SpecSource;
  notes?: string;
  /** Which registry layer the item came from (tagged by resolveCatalog). */
  origin?: 'builtin' | 'project' | 'library';
  /** Product / datasheet links shown in the catalog panel. */
  links?: { label: string; url: string }[];
  // ── v2 S3 ──
  /** network adapter spec (category 'nic'). */
  nic?: NicSpec;
  /** free-form structured metadata: composer U-map (`umap`), CDU rating tuples (`ratings`), node spec (`node`) … */
  meta?: Record<string, unknown>;
  // ── v2 2차 (T5) ──
  /** catalog image: rendered 3D thumbnail, front schematic generated from the U-map / dims, or a user attachment (vendor photos are linked, never embedded) */
  image?: { kind: 'thumbnail' | 'schematic' | 'user'; src?: string; dataUrl?: string; credit?: string };
  // ── v2 2차 (D2) ──
  /** rack static (stationary) load rating, kg; absent = layout/rackContents.ts RACK_STATIC_LOAD_SEEDS (estimate) */
  rackStaticLoadKg?: number;
  rackStaticLoadSource?: SpecSource;
  // ── standards (stream A / P1, OCP-DESIGN-PROPOSAL §2.3; all optional) ──
  /** which cited standards the item implements and at what level (drives chips, slot eligibility, filters) */
  standards?: ItemStandard[];
  /** rack / tray / node / shelf geometry and ratings (replaces `meta.rackForm`; `rackUnits` stays as an alias) */
  formFactor?: ItemFormFactor;
  rackPower?: ItemRackPower;
  powerShelf?: ItemPowerShelf;
  bbu?: ItemBbu;
  powerRack?: ItemPowerRack;
  liquidInterface?: ItemLiquidInterface;
  cdu?: ItemCdu;
  doorHx?: ItemDoorHx;
  accelModule?: ItemAccelModule;
  baseboard?: ItemBaseboard;
  /** vendor-neutral management identity, e.g. Redfish profile names */
  mgmtProfiles?: string[];
  /** weakest status of `standards` (derived; shown as a chip) */
  specStatus?: SpecStatus;
  /** per-field provenance, keyed by dotted path (e.g. 'powerShelf.shelfKW') */
  paramSources?: Record<string, ParamProvenance>;
  /** plain-text recognition line; only from a public marketplace listing (DO-8: not displayed at launch) */
  recognition?: { text: string; sourceUrl: string; accessed: string };
}

/** Cables and optics priced/selected by the cabling engine. */
export interface CableType {
  id: string;
  kind: 'dac' | 'acc' | 'aec' | 'aoc' | 'mmf' | 'smf' | 'cat6a' | 'power';
  name: string;
  gbps: number; // 0 for power
  maxReachM: number;
  minReachM: number;
  /** price of the cable itself: fixed + per meter */
  cableUSD: number;
  cableUSDPerM: number;
  /** transceiver price per end (0 for DAC/ACC/AEC/AOC — integrated) */
  transceiverUSD: number;
  transceiverW: number; // power per transceiver end
  latencyNsPerM: number;
  source: SpecSource;
  // ── v2 (optional; the engine keeps using the fields above when absent) ──
  /** physical medium (copper twinax, OM4 multimode, single-mode, active optical) */
  medium?: 'copper' | 'mmf' | 'smf' | 'aoc';
  /** power per cable end incl. optics/retimers (W) — alias for transceiverW when optics are integrated */
  wattsPerEnd?: number;
  /** fixed price per cable (USD) — alias for cableUSD */
  priceFixedUSD?: number;
  /** price per metre (USD/m) — alias for cableUSDPerM */
  pricePerMUSD?: number;
  origin?: 'builtin' | 'project' | 'library';
}

// ───────────────────────────── Project ─────────────────────────────

export interface Project {
  schemaVersion: 1;
  id: Id;
  name: string;
  description: string;
  client?: string;
  author?: string;
  createdAt: string;
  updatedAt: string;
  site: Site;
  halls: Hall[];
  equipment: EquipmentInstance[];
  containments: Containment[];
  power: PowerDesign;
  cooling: CoolingDesign;
  network: NetworkDesign;
  workloads: WorkloadBlueprint[];
  schedule: ScheduleSettings;
  pricing: PricingSettings;
  /** Free-form technical notes rendered into the design document (markdown). */
  notes: DesignNote[];
  /** 'reference-cfd' = geometry rebuilt from a reference CFD case (design-only validation is skipped). Default 'design'. */
  purpose?: 'design' | 'reference-cfd';
  // ── v2 (all optional, schemaVersion stays 1) ──
  /** phased build-out vs single build (DECISIONS-v2 #1). Default 'phased'. */
  growth?: GrowthPattern;
  /** deliverable language. Default 'en'. */
  locale?: Locale;
  /** project-scoped catalog items (merged over builtin ∪ library by resolveCatalog). */
  catalogExtensions?: CatalogItem[];
  cableExtensions?: CableType[];
  /** cable-tray polylines generated by the layout engine (hall-local, Z-up). */
  trays?: CableTray[];
  /** A/B busway runs generated by the layout / power engines. */
  busways?: Busway[];
  // ── v2 2차 ──
  /** cluster scope (T2, DECISIONS-v2-2 F2). Absent = one independent fabric per populated hall. */
  clusters?: ClusterDef[];
  /** T1: reserve / expansion floor positions (and separate-room partitions) generated inside services zones (hall-local). */
  reservations?: LayoutReservation[];
  /** T1: services zone of each generated hall (plan rect, rows, positions, reserve count). */
  servicesZones?: ServicesZoneRecord[];
  /** D2: per-hall CFD-lite snapshots appended when a thermal run completes (rack elevations read inlet bands). */
  thermalSnapshots?: ThermalSnapshot[];
  // ── v2 2차 §E (templates registry) ──
  /** project-scoped compute-platform registrations: catalog item `catalogId` is listed in slot `slotId` of layout template `templateId` (on top of the template's built-in list). */
  templateRegistry?: { templateId: string; slotId: string; catalogId: string }[];
  // ── r4 (2D drawings contract) ──
  /** S6: sheet and 2D-view length units. Absent = 'metric' (today's output). */
  drawingUnits?: DrawingUnits;
  /** user section cuts (type in P0; persisted from the 2D view in P1). Generated default cuts (301/302) are not stored. */
  drawingCuts?: DrawingCut[];
  // ── standards profile (stream A / P1, OCP-DESIGN-PROPOSAL §2.2) ──
  /** project default standards profile; halls override field by field. Filled by `upgradeProject` (inferred) for legacy projects. */
  standards?: StandardsProfile;
}

/** D2: per-hall CFD-lite snapshot (packages/thermal result extraction); stale when the hall layout hash changed. */
export interface ThermalSnapshot {
  id: Id;
  hallId: Id;
  /** ISO time of the run */
  at: string;
  /** layout/rackContents.ts hallLayoutHash at run time */
  layoutHash: string;
  cellM?: number;
  maxInletC: number;
  /** inletBandsC = inlet-face samples at 0.5 / 1.2 / 1.9 m (bottom / middle / top), simulated */
  racks: { id: Id; tag: string; inletBandsC?: [number, number, number]; inletAvgC: number; inletMaxC: number; exhaustC: number; airflowM3s: number }[];
}

export interface DesignNote { id: Id; section: DocSection; title: string; body: string }
export type DocSection = 'overview' | 'site' | 'space' | 'power' | 'cooling' | 'network' | 'workload' | 'cost' | 'schedule' | 'risk';

export interface Site {
  name: string;
  location: string;
  /** backlog T1a (DECISIONS-v2-2 §H): target topology tier of the design (Uptime-style I–IV). Undefined = not stated (treated as below IV).
   *  Tier IV keeps electrical rooms A / B on opposite hall sides (side-by-side rooms become a warning instead of an info note). */
  targetTier?: 'I' | 'II' | 'III' | 'IV';
  latitude?: number;
  longitude?: number;
  elevationM: number;
  climate: {
    designDryBulbC: number; // ASHRAE 0.4% design
    designWetBulbC: number;
    annualMeanC: number;
    /** hours/year below the economizer threshold (free-cooling potential) */
    economizerHours: number;
  };
  utility: UtilityFeed[];
  /** Grid electricity price used for OPEX. */
  electricityUSDPerKWh: number;
  carbonKgPerKWh: number;
  waterUSDPerM3: number;
  /** electrical code / distribution voltage profile (DECISIONS-v2 #4). Default 'iec' (415 V). */
  powerProfile?: PowerProfile;
}

export interface UtilityFeed {
  id: Id;
  name: string;
  voltageKV: number;
  capacityMVA: number;
  /** feeds in the same group are NOT independent (single substation) */
  substation: string;
  availableFrom: ISODate;
}

/** A white-space (상면) area. */
export interface Hall {
  id: Id;
  name: string;
  /** hall origin in site coordinates (m) */
  origin: Vec2;
  width: number; // x
  depth: number; // y
  clearHeight: number; // floor to underside of ceiling / structure
  raisedFloorHeight: number; // 0 = slab-on-grade
  ceilingPlenumHeight: number; // 0 = no return plenum
  floorLoadingKgPerM2: number; // allowable distributed load
  tileSize: number; // planning grid (0.6 m typical)
  /** IT power allocated to this hall from site utility (kW) — the "공급 가능한 수전" for the space. */
  itPowerBudgetKW: number;
  /** Facility water available for liquid cooling (kW thermal). */
  liquidCoolingBudgetKW: number;
  airCoolingBudgetKW: number;
  keepouts: Keepout[];
  /** Where cable trays run (m above floor). */
  trayHeight: number;
  /** v2 layout policy (template · grid · corridors · CRAH strategy · objective). Absent = hand-placed / v1 generator. */
  layoutPolicy?: LayoutPolicy;
  /** non-rectangular hall outline (hall-local plan polygon). Absent = rectangle [0,width]×[0,depth]. */
  outline?: { x: number; y: number }[];
  /** v2 2차 (T1/T4): cooling-equipment placement options used by "regenerate cooling only" (DECISIONS-v2-2 F8) */
  coolingPlacement?: CoolingPlacementOptions;
  // ── r4 (2D drawings contract) ──
  /** vertical stack: slab, stack order, overhead service tiers, top clearance. Absent = today's heights. */
  verticals?: HallVerticals;
  /** structural grid axes (read-only in P0). Absent = derived from aligned column keepouts, else the planning grid. */
  structuralGrid?: StructuralGrid;
  /** standards profile override (field by field over `Project.standards`; see standards/profile.ts) */
  standards?: HallStandardsOverride;
  /** stream C (P3): facility inputs for the informational facility pre-check and PW-06 / CL-05 (all optional) */
  facility?: HallFacilityInputs;
}

// ───────────────────────────── v2 layout objects ─────────────────────────────

/** Where hall-shared services (T2 tier: storage, CPU, mgmt, network core) live (DECISIONS-v2-2 F3b). */
export type ServicesZoneMode = 'end-band' | 'center-band' | 'support-hac' | 'separate-room';

/** Cooling-equipment placement options (DECISIONS-v2-2 F8; r2-layout.md CDU/CRAH rules). */
export interface CoolingPlacementOptions {
  cduPerPod: number | 'auto';
  cduPlacement: 'row-ends' | 'ends-center' | 'gallery';
  crahCount: number | 'auto';
  crahStrategy: LayoutPolicy['crahStrategy'];
  crahWalls?: ('N' | 'S' | 'E' | 'W')[];
  /** redundancy label, e.g. 'N+1' (per pod) / '2N' */
  cduRedundancy?: string;
  crahRedundancy?: string;
  /** T1: wall that holds the mechanical-gallery CDU strip (cduPlacement 'gallery'); default = the first row-end wall */
  cduGalleryWall?: 'N' | 'S' | 'E' | 'W';
  /** polish v2 2차: CRAH / fan-wall catalog model placed by regenerateCooling (default project.cooling.crahCatalogId) — lets the cooling panel place the unit it compares */
  crahCatalogId?: string;
}

/** T1: reserve / expansion positions inside a services zone, or a separate-room partition (DECISIONS-v2-2 F3b, r2-layout.md §1.4). */
export interface LayoutReservation {
  id: Id;
  hallId: Id;
  kind: 'reserve' | 'room-partition';
  /** plan rectangle (hall-local); for 'reserve' it covers `positions` rack positions along `axis` */
  rect: Rect;
  positions: number;
  /** axis the reserved row runs along */
  axis: 'x' | 'y';
  zone: ServicesZoneMode;
  rowId?: Id;
  waveId?: Id;
}

/** T1: generated services zone of a hall (servicesZoneRect reads `rect`). */
export interface ServicesZoneRecord {
  hallId: Id;
  mode: ServicesZoneMode;
  /** band / room / support-HAC envelope (hall-local plan rect) */
  rect: Rect;
  rows: number;
  positionsPerRow: number;
  racks: number;
  reservePositions: number;
  interHallCoreRacks?: number;
}

export interface LayoutPolicy {
  /** layout template id (e.g. 'std-orw-liquid-sidecar-du', 'nvidia-facilities-su', 'rcu-row', 'custom') */
  templateId: string;
  /** axis along which rack rows run */
  orientation: 'x' | 'y';
  /** pod grid (columns × rows); absent = single column */
  grid?: { columns: number; rows: number };
  /** corridor widths (m) — defaults from TIA-942 / SuperPOD guidance (DECISIONS-v2 #3) */
  corridors: { coldAisleM: number; hotAisleM: number; transportM: number; egressM: number };
  crahStrategy: 'perimeter' | 'in-row' | 'per-pod' | 'gallery-fan-wall';
  /** which perimeter walls host CRAHs / fan walls when crahStrategy is perimeter or gallery */
  crahWalls?: ('N' | 'S' | 'E' | 'W')[];
  objective: 'max-gpus' | 'min-cable' | 'tokens-per-mw';
  /** dedicated MMR / network room for spines & cores (DECISIONS-v2 #2, default false) */
  separateNetworkRoom?: boolean;
  // ── v2 2차 (T1) ──
  /** services zone mode; absent = default from project.growth (phased → 'end-band', single-build → 'center-band') */
  servicesZone?: ServicesZoneMode;
  /** auto-size mode picks orientation + columns (min area, then aspect ≤ targetAspect); fixed halls run rows along the long side */
  autoOrientation?: boolean;
  /** hall aspect-ratio constraint for auto-size (default 2.0) */
  targetAspect?: number;
}

/** A physical row of equipment (compute pod row, services row or network-core row). */
export interface RowGroup {
  id: Id;
  hallId: Id;
  podId?: Id;
  kind: 'compute' | 'services' | 'network-core';
  /** axis the row runs along */
  axis: 'x' | 'y';
  /** row extent along `axis` (m) */
  a0: number;
  a1: number;
  /** row centre-line on the perpendicular axis (m) */
  center: number;
  /** +1 when fronts face the positive perpendicular direction, −1 otherwise */
  frontSign: 1 | -1;
  memberIds: Id[];
}

export interface CableTray {
  id: Id;
  hallId: Id;
  kind: 'row' | 'main' | 'drop';
  points: Vec3[];
  widthM: number;
  /** 0..1 fraction of the cross-section used */
  fillRatio?: number;
  cableCount?: number;
  /** T1b: service tier of a per-tier tray (Hall.verticals tiers 'T2' / 'T3'); absent = the T1 / main tray set the network routes on */
  tier?: string;
  /** T1b: fabrics / systems the tier tray carries (e.g. 'frontend', 'storage', 'oob') */
  carries?: string[];
}

export interface Busway {
  id: Id;
  hallId: Id;
  path: 'A' | 'B';
  points: Vec3[];
  ampacityA: number;
  tapoffs: { x: number; y: number; equipmentId: Id }[];
}

export interface PowerPath {
  id: Id;
  kind: 'feeder' | 'busway' | 'tapoff';
  fromId: Id;
  toId: Id;
  points: Vec3[];
  lengthM: number;
  /** 0..1 loading of the segment */
  loading?: number;
  // ── v2 2차 (T3) power-plane detail (optional) ──
  hallId?: Id;
  side?: 'A' | 'B';
  /** busway (row side) this circuit / tap-off / feeder belongs to */
  buswayId?: Id;
  rowId?: Id;
  /** 1-based circuit index within the busway */
  circuit?: number;
  /** connected load in the normal state (kW) */
  connectedKW?: number;
  /** √3·V·I·PF rating of the run (kW) */
  ratedKW?: number;
  /** continuous limit = rating × profile factor (kW); `loading` = connectedKW / limitKW */
  limitKW?: number;
  /** racks fed by this circuit (busway) or the rack at the end of the tap-off */
  equipmentIds?: Id[];
}

export interface Keepout {
  id: Id;
  kind: 'column' | 'door' | 'egress' | 'ramp' | 'shaft' | 'other';
  rect: Rect;
  label?: string;
  /** r4: door leaves / swing / clear height for kind 'door' (absent = estimate defaults, see KeepoutDoor) */
  door?: KeepoutDoor;
}

export interface EquipmentInstance {
  id: Id;
  catalogId: string;
  hallId: Id;
  /** human tag e.g. "DU01-A-07" */
  tag: string;
  position: Vec2; // footprint center, hall-local m
  elevation?: number; // z of the base (default 0)
  rotationDeg: 0 | 90 | 180 | 270;
  /** logical grouping (deployment unit / pod) */
  podId?: Id;
  rowId?: Id;
  /** deployment wave (schedule) */
  waveId?: Id;
  /** 0..1 utilization override for thermal/power sims (default from scenario) */
  loadFactor?: number;
  /** for network racks: which fabric role this rack hosts */
  networkRole?: 'scale-out-leaf' | 'scale-out-spine' | 'scale-out-core' | 'frontend' | 'storage' | 'oob' | 'mixed' | 'inter-hall-core';
  /** blanking panels installed (affects recirculation) */
  blanking?: boolean;
  meta?: Record<string, string | number | boolean>;
}

export interface Containment {
  id: Id;
  hallId: Id;
  kind: 'hot-aisle' | 'cold-aisle';
  rect: Rect; // plan area of the contained aisle
  height: number; // containment wall/door height (≈ rack height)
  roof: boolean; // aisle roof panels
  endDoors: boolean;
  /** HAC: exhaust ducted to ceiling plenum through chimney */
  ductedToPlenum: boolean;
  podId?: Id;
  /** r4: aisle end door type. Absent = 'sliding' (existing viewer); 'swing-double' is the alternative. */
  doorType?: 'sliding' | 'swing-double';
}

// ───────────────────────────── Power ─────────────────────────────

export type Redundancy = 'N' | 'N+1' | 'N+2' | '2N' | '2N+1' | 'DR' | 'block-redundant';

export interface PowerDesign {
  distributionVoltageV: 415 | 480 | 400 | 380;
  distribution: 'busway' | 'rpp' | 'hybrid';
  upsRedundancy: Redundancy;
  generatorRedundancy: Redundancy;
  transformerRedundancy: Redundancy;
  upsCatalogId: string;
  generatorCatalogId: string;
  transformerCatalogId: string;
  rppCatalogId: string;
  batteryMinutes: number;
  powerFactor: number; // IT load PF
  /** continuous-load derating (NEC 80%) */
  deratingFactor: number;
  /** size to nameplate or to a diversity factor (0..1) */
  diversityFactor: number;
  /** support non-IT loads through UPS (CDU pumps etc.) */
  mechanicalOnUps: boolean;
  /** Power smoothing / BESS for training load swings (GB300 supports rack-level smoothing) */
  powerSmoothing: 'none' | 'rack-level' | 'bess';
  /** v2 2차 (T3): Max-Q model options — Vera Rubin allocation basis (MaxLPS docs 227 kW vs blog 136/101 kW), draw basis, reserve */
  maxq?: {
    vrBasis?: 'maxlps-docs' | 'maxlps-blog'; drawBasis?: 'peak' | 'avg'; reserveFraction?: number;
    /** polish v2 2차: budget B of the dynamic model — Σ rack allocation (default), the halls' IT power budget
     *  minus their non-GPU IT load, or a custom kW value */
    budgetBasis?: 'allocation' | 'hall-budget' | 'custom';
    budgetKW?: number;
  };
  /** polish v2 2차: user override of the block-redundant / DR UPS arrangement (absent = sized from the N-1 contingency set) */
  upsBlocks?: { blockModules: number; activeBlocks: number };
}

// ───────────────────────────── Cooling ─────────────────────────────

export interface CoolingDesign {
  /** facility water system (FWS) supply/return °C */
  fwsSupplyC: number;
  fwsReturnC: number;
  /** technology cooling system (TCS / secondary) supply °C */
  tcsSupplyC: number;
  /** stream C (P3): TCS design temperature rise across the racks, K (CL-01 flow per kW, CL-04/06/08). Absent = 10 K. */
  tcsDeltaTK?: number;
  /** supply air to cold aisle °C */
  supplyAirC: number;
  cduCatalogId: string;
  crahCatalogId: string;
  chillerCatalogId: string;
  heatRejection: 'air-cooled-chiller' | 'water-cooled-chiller' | 'dry-cooler' | 'hybrid';
  cduRedundancy: Redundancy;
  crahRedundancy: Redundancy;
  chillerRedundancy: Redundancy;
  economizer: boolean;
}

// ───────────────────────────── Network ─────────────────────────────

export type FabricTech =
  | 'ib-xdr-800' // Quantum-X800
  | 'ib-ndr-400' // Quantum-2
  | 'spectrumx-800' // Spectrum-X SN5600 + SuperNIC (RoCE)
  | 'spectrumx-400'
  | 'roce-generic-400'
  | 'roce-generic-800' // v2 (integration): generic 800GbE RoCEv2 (TH5/TH6/Silicon One merchant boxes — Cisco, Dell, Juniper, Arista DES)
  | 'ethernet-400'
  | 'ethernet-200'
  | 'ethernet-100'
  | 'ethernet-1g'
  // ── v2 (S2): DDC scheduled fabric (DriveNets FSE: 5300R NCP + 9300F NCF) and DriveNets ESE Ethernet + UEC-style NICs ──
  | 'drivenets-fse'
  | 'ese-uec-400';

export type FabricTopology = 'rail-optimized' | 'fat-tree' | 'leaf-spine';

/** Load-balancing class of the scale-out fabric — sets the default efficiency η used by the traffic engine (PROPOSAL-v2 §3.3). */
export type LoadBalancing = 'ecmp' | 'qp-scaling' | 'adaptive' | 'ddc' | 'te';

// ── v2 2차 (T2): cluster scope + measurable η (DECISIONS-v2-2 F1/F2, r2-eta.md) ──

/** A cluster = one scale-out fabric spanning `hallIds`. Multi-hall clusters connect through an inter-hall core (super-spines + SMF trunks). */
export interface ClusterDef {
  id: Id;
  name: string;
  hallIds: Id[];
  interHallCore?: { spineCatalogId?: string; mediumCableTypeId?: string; zoneHallId?: Id };
}

/** Evidence class of an η default (shown as a badge). 'nominal' = no public measurement (η = 1.0, warning). */
export type EtaSourceType = 'measured-paper' | 'derived' | 'vendor-claim' | 'acceptance-threshold' | 'nominal' | 'user-measured' | 'user';

export interface EtaSource {
  id: string;
  lbClass: LoadBalancing;
  value: number;
  sourceType: EtaSourceType;
  citation: string;
  url?: string;
  /** conditions under which the value was measured / claimed */
  conditions: string;
}

/** Parsed nccl-tests / rccl-tests output (one table per collective). Units: bytes, decimal GB/s. */
export interface CollectiveMeasurement {
  tool: 'nccl-tests' | 'rccl-tests';
  collective: 'all_reduce' | 'all_gather' | 'reduce_scatter' | 'alltoall' | 'broadcast' | 'other';
  ranks?: number;
  nodes?: number;
  rows: { sizeB: number; algbwGBps: number; busbwGBps: number; inPlace?: boolean }[];
  /** the '# Avg bus bandwidth' footer (mean over ALL sizes — never used as η) */
  avgBusbwGBps?: number;
  /** T2: ranks per node (max device index + 1 of the rank list) */
  ranksPerNode?: number;
  /** T2: the pasted rank list was truncated ('......') — nodes derived from ranks ÷ ranks per node */
  rankListTruncated?: boolean;
  /** integration v2 2차: the AIDC test kit's '# AIDC-KIT eta …' header (deploy/tests eta_mpirun.sh / _eta_srun.sh) */
  kit?: { scope?: string; collective?: string; split?: number; nicGbps?: number; nicsPerRank?: number; nodes?: number };
  /** polish v2 2차: communicator groups in the rank list ('# Rank … Group G …'); > 1 means an NCCL_TESTS_SPLIT run */
  groups?: number;
}

/** η calibrated from a pasted collective log: η = plateau busbw ÷ theoretical busbw (nominalGBps). */
export interface EtaCalibration {
  measuredAt?: string;
  nominalGBps: number;
  eta: number;
  basis: string;
  measurement: CollectiveMeasurement;
  // ── T2 detail (engines/eta.ts): η = η_host × η_fabric; the traffic engine uses η_fabric on spine/core tiers and η_host on the NIC ──
  /** plateau busbw ÷ nominal of the pasted (cross-spine) run */
  etaTotal?: number;
  /** single-leaf busbw ÷ nominal (measured when a packed log is given, else the 0.95 default) */
  etaHost?: number;
  /** cross-spine busbw ÷ single-leaf busbw (what the traffic engine applies on multipath tiers) */
  etaFabric?: number;
  busbwLargeGBps?: number;
  busbwMinGBps?: number;
  /** message sizes averaged (bytes) */
  sizesB?: number[];
  flags?: ('below-plateau' | 'not-plateaued' | 'unstable' | 'in-place-differs' | 'not-network-bound' | 'no-rows')[];
  source?: 'user-measured';
  /** single-leaf (packed) measurement used for η_host, when pasted */
  packed?: CollectiveMeasurement;
}

export interface ScaleOutNetwork {
  fabric: FabricTech;
  topology: FabricTopology;
  /** 'auto' picks the minimum tiers that satisfy the endpoint count */
  tiers: 'auto' | 2 | 3;
  /** downlink:uplink at the leaf (1 = non-blocking) */
  oversubscription: number;
  switchCatalogId: string;
  /** where leaf switches live (v1 literals: end-of-row → 'end-of-row', middle-of-row → 'mid-row', centralized → 'end-of-row') */
  leafPlacement: LeafPlacement;
  /** where spines/cores live (v1 literals: centralized → 'central-end', per-hall → 'distributed') */
  spinePlacement: SpinePlacement;
  /** spines/cores in a dedicated MMR / network room (DECISIONS-v2 #2, default false) */
  separateRoom?: boolean;
  // ── v2 (S2, traffic engine) — all optional; defaults derive from `fabric` ──
  /** load-balancing class (default: IB / Spectrum-X / UEC → 'adaptive', generic RoCE / Ethernet → 'ecmp', DDC → 'ddc') */
  loadBalancing?: LoadBalancing;
  /** user override of the load-balancing efficiency η (0..1); absent = class default */
  etaOverride?: number;
  /** v2 2차 (T2): η calibrated from a measured all_reduce log (DP/PP groups). Precedence in the traffic engine (engines/network.ts etaFor):
   *  etaCalibration (user-measured) > etaOverride > sourced class default (engines/eta.ts ETA_SOURCES) > nominal */
  etaCalibration?: EtaCalibration;
  /** v2 2차 (T2): η calibrated from a measured alltoall log (expert-parallel groups); absent = the all_reduce η */
  etaCalibrationA2a?: EtaCalibration;
}

export interface AuxNetwork {
  enabled: boolean;
  fabric: FabricTech;
  switchCatalogId: string;
  oversubscription: number;
}

/** Project-level address-plan inputs. Omitted fields use deterministic defaults in the IP-plan engine. */
export interface NetworkAddressing {
  /** IPv4 remains the routing / router-id family; dual-stack additionally assigns IPv6 to every IP endpoint. */
  mode?: 'ipv4' | 'dual-stack';
  /** First octet of the private IPv4 /8 used by the deterministic plan (default 10). */
  ipv4FirstOctet?: number;
  /** Site IPv6 /48. When omitted, a stable project-specific ULA /48 is generated. */
  ipv6Prefix?: string;
  /** Fabric transit links are unnumbered by default; numbered assigns IPv4 /31 and IPv6 /127 pairs. */
  fabricLinks?: 'unnumbered' | 'numbered';
  /** Number of backend address planes (default 1, maximum 8). */
  planes?: number;
}

export interface NetworkDesign {
  scaleOut: ScaleOutNetwork;
  frontend: AuxNetwork;
  storage: AuxNetwork;
  oob: AuxNetwork;
  /** Addressing is optional so schema-version-1 projects load without migration. */
  addressing?: NetworkAddressing;
  cabling: {
    /** max length for which passive copper is preferred */
    maxCopperM: number;
    /** allow active electrical cables (AEC/ACC) */
    allowActiveCopper: boolean;
    /** vertical drop + slack per cable end (m) */
    slackPerEndM: number;
    /** route factor (tray path vs Manhattan) */
    routeFactor: number;
    preferSingleMode: boolean;
  };
}

// ───────────────────────────── Workload blueprints ─────────────────────────────

export type WorkloadKind = 'llm-pretrain' | 'llm-finetune' | 'llm-inference' | 'hpc-simulation';

export interface WorkloadBlueprint {
  id: Id;
  name: string;
  kind: WorkloadKind;
  /** share of the cluster's GPUs used (0..1) */
  gpuShare: number;
  model: {
    name: string;
    paramsB: number; // total parameters (billions)
    activeParamsB: number; // active per token (MoE); = paramsB for dense
    layers: number;
    hiddenSize: number;
    seqLen: number;
    // ── v2 (optional; traffic engine inputs) ──
    numHeads?: number;
    kvHeads?: number;
    vocab?: number;
    moe?: {
      experts: number; topK: number; nodeLimit?: number;
      // ── v2 2차 (T6, r2-models.md §1.2; optional) ──
      /** shared experts per MoE layer (always local: active FLOPs, no EP bytes) */
      shared?: number;
      /** leading dense (non-MoE) layers — MoE layers = layers − denseLayers (DeepSeek-V3 3, Kimi K2 1, GLM-4.5 3) */
      denseLayers?: number;
      /** MoE every n-th layer (Llama 4 Maverick 2) — MoE layers = layers / moeLayerInterval */
      moeLayerInterval?: number;
    };
    /** MLA latent dims (DeepSeek-V2/V3: dLatent 512, dRope 64) — KV bytes/token = L·(dLatent+dRope)·B_kv; absent = GQA/MHA */
    mla?: { dLatent: number; dRope: number };
    // ── v2 2차 (T6, DECISIONS-v2-2 §C head_dim; filled from MODEL_PRESETS) ──
    /** attention head dim when ≠ hiddenSize / numHeads (Qwen3 128, gpt-oss 64, GLM-4.5 128, Gemma 3 128) — KV / CP bytes must use it */
    headDim?: number;
    /** local attention window or chunk size in tokens (gpt-oss 128, Gemma 3 1,024, Llama 4 chunk 8,192); absent = full attention on every layer */
    attentionWindow?: number;
    /** one global (full-attention) layer every n layers (gpt-oss 2, Gemma 3 6, Llama 4 4) — long-context KV grows only on global layers */
    globalLayerInterval?: number;
  };
  training?: {
    tokensB: number; // total training tokens (billions)
    globalBatchTokensM: number; // tokens per step (millions)
    precision: 'fp8' | 'bf16' | 'fp4';
    tp: number;
    pp: number;
    ep: number;
    /** data parallel is derived: gpus / (tp*pp) */
    checkpointEveryMin: number;
    checkpointDurationS: number;
    mtbfHoursPerGpu: number; // hardware failure model
    // ── v2 (optional) ──
    /** context parallel degree */
    cp?: number;
    /** ZeRO / FSDP sharding stage (0 = DDP) */
    zeroStage?: 0 | 1 | 2 | 3;
    /** sequences per micro-batch */
    microBatchSeqs?: number;
    /** activation recomputation on (Megatron 96·B·s·l·h² FLOP form) vs off (PaLM 6N + 12·L·h·s form). Default false. */
    activationRecompute?: boolean;
    /** assumed compute-path MFU incl. pipeline bubble (Llama 3 Tab.4: 0.43 BF16); absent = precision default */
    mfuAssumed?: number;
    /** v2 2차 (T2/T6): communication/compute overlap fractions per group (0..1), with a citation; absent = engine defaults */
    overlap?: {
      dp?: number;
      pp?: number;
      tp?: number;
      source?: string;
      /** T2: expert-parallel and context-parallel overlap fractions */
      ep?: number;
      cp?: number;
      /** T2: framework mode that sets the per-group defaults (engines/traffic.ts overlapDefaults; r2-eta.md §5.3). Default 'fsdp-prefetch'. */
      framework?: 'megatron-no-overlap' | 'fsdp-prefetch' | 'megascale-overlap' | 'dualpipe';
    };
  };
  inference?: {
    requestsPerSec: number;
    inputTokens: number;
    outputTokens: number;
    ttftSloMs: number;
    tpotSloMs: number;
    disaggregated: boolean; // prefill/decode split
    /** KV-cache precision (default fp8) */
    kvPrecision?: 'fp16' | 'bf16' | 'fp8' | 'fp4';
  };
  /** simulated days of the operating profile */
  durationDays: number;
  // ── v2 2차 (T6) ──
  /** model preset the architecture fields were filled from (workload/presets.ts MODEL_PRESETS id) */
  presetId?: string;
  /** benchmark calibration of throughput / MFU (DECISIONS-v2-2 F9) */
  calibration?: {
    benchmarkId?: string; measuredTokensPerSec?: number; gpus?: number; mfu?: number; source: string;
    // ── v2 2차 (T6, r2-models.md §4.1; optional) ──
    /** training → effective TFLOP/s per GPU + back-solved MFU; inference → output tokens/s per GPU at the stated interactivity */
    mode?: 'training' | 'inference';
    /** effective training TFLOP/s per GPU (basis-free; tokens/s · F_tok / G) — the stored calibration quantity */
    tflopsPerGpu?: number;
    /** inference: output tokens/s per GPU on this blueprint's accelerator (after transfer) — overrides the decode-capacity model */
    tokensPerSecPerGpu?: number;
    /** interactivity the inference figure holds at (tok/s per user); valid only for targets ≤ this */
    interactivityTokPerSecPerUser?: number;
    /** precision / accelerator / catalog item the source was measured at */
    precision?: string;
    accelerator?: string;
    acceleratorCatalogId?: string;
    /** evidence class of the source row (the stored value itself is 'derived' from it) */
    sourceType?: EvidenceSourceType | 'user';
    /** conditions (suite · round · system · G · parallelism · batch) and the transfer assumption, for display */
    conditions?: string;
    transfer?: string;
    warnings?: string[];
    appliedAt?: string;
  };
}

// ───────────────────────────── Schedule ─────────────────────────────

export interface DeploymentWave {
  id: Id;
  name: string;
  /** pods (DUs) included in this wave */
  podIds: Id[];
  targetReadyDate?: ISODate;
}

export interface ScheduleSettings {
  projectStart: ISODate;
  waves: DeploymentWave[];
  workDaysPerWeek: number;
  hoursPerDay: number;
  crews: { electrical: number; mechanical: number; rackAndStack: number; cabling: number; commissioning: number };
  /** people per crew */
  crewSize: number;
}

// ───────────────────────────── Pricing ─────────────────────────────

export interface PricingSettings {
  currency: 'USD' | 'KRW';
  fxKRWPerUSD: number;
  /** per catalog item price override (USD) */
  itemOverrides: Record<string, number>;
  cableOverrides: Record<string, number>;
  laborUSDPerHour: number;
  /** building/shell cost per m² of white space (if new build) */
  shellUSDPerM2: number;
  /** contingency 0..1 */
  contingency: number;
  depreciationYears: { it: number; facility: number };
}

// ───────────────────────────── Analysis results ─────────────────────────────

export type Severity = 'info' | 'warning' | 'error';

export interface Issue {
  id: string;
  severity: Severity;
  domain: 'space' | 'power' | 'cooling' | 'network' | 'thermal' | 'schedule' | 'cost' | 'workload' | 'layout';
  message: string;
  /** equipment/hall ids involved */
  refs?: Id[];
  suggestion?: string;
  /** English rendering of `message` / `suggestion` for the EN design document (engines emit Korean UI strings) */
  messageEn?: string;
  suggestionEn?: string;
  /** stream C (P3): present on standards parameter checks (engines/standardsChecks.ts, proposal §5) */
  check?: StandardsCheckDetail;
}

/**
 * Detail of one standards parameter check (stream C / P3, OCP-DESIGN-PROPOSAL §5). UI and deliverables render the wording from these
 * fields ("Parameter check (per <title> <version>): <value> vs <limit>") and never print internal enum keys.
 */
export interface StandardsCheckDetail {
  /** 'RK-01' … 'PW-10', 'CL-01' … 'CL-16', 'NW-01' … 'NW-04', 'FC-01' … 'FC-10' */
  ruleId: string;
  family: 'rack' | 'power' | 'liquid' | 'air' | 'compute' | 'network' | 'facility';
  designValue?: number;
  limit?: number;
  unit?: string;
  /** where the limit comes from: a cited document, a planner estimate, or a user value */
  basis: 'standard' | 'estimate' | 'user';
  /** registry id (standards/registry.ts), e.g. 'orv3-hpr-shelf-33kw@0.3' */
  standardId?: string;
  clause?: string;
  specStatus?: SpecStatus;
  verification: Verification;
  /** severity before the DO-3 cap (inferred profile → info; advisory → ≤ warning; draft / estimate basis → ≤ warning) */
  naturalSeverity: Severity;
}

/** Optional facility inputs of a hall used by the facility pre-check (FC-*) and PW-06 / CL-05 (stream C / P3, proposal §5.4). */
export interface HallFacilityInputs {
  /** generator load acceptance time, s (PW-06, FC-07) */
  generatorAcceptanceS?: number;
  /** white-space rolling load rating, kg (FC-06) */
  rollingLoadKg?: number;
  /** white-space concentrated (point) load rating, kg (FC-05) */
  concentratedLoadKg?: number;
  /** narrowest delivery path dock → white space, m (FC-06) */
  deliveryPath?: { h: number; w: number; d?: number };
  lift?: { capacityKg: number; doorH: number; doorW: number; cabinD: number };
  rampGradientPct?: number;
  /** circuits to each rack (FC-08) */
  circuits?: '1N' | '2N';
  receptacleLocation?: 'overhead' | 'underfloor';
  upsFeed?: 'ups-and-non-ups' | 'ups-only' | 'n-plus-n-ups';
  /** containment of the white space (facility attribute); absent = derived from the hall's containments */
  containment?: 'hot-aisle' | 'cold-aisle' | 'chimney' | 'rdhx' | 'none';
  rackBbuAllowed?: boolean;
  /** static fill pressure of the TCS at the rack manifold, psig (CL-05; default estimate 15 psig) */
  tcsStaticFillPsig?: number;
  /** design pressure at the rack manifold after any row pressure reduction, psig (CL-05; overrides static fill + CDU head) */
  tcsManifoldPsig?: number;
  /** airflow across the rack power shelves, LFM (PW-02 output connector airflow rating) */
  shelfAirflowLFM?: number;
}

export interface BomLine {
  id: string;
  domain: 'it' | 'network' | 'cabling' | 'power' | 'cooling' | 'facility' | 'labor' | 'contingency';
  itemId: string; // catalog/cable id or synthetic
  description: string;
  qty: number;
  unit: 'ea' | 'm' | 'lot' | 'h' | 'm2';
  unitUSD: number;
  totalUSD: number;
  leadTimeWeeks?: number;
  source: SpecSource;
}

export interface SpaceAnalysis {
  hallId: Id;
  areaM2: number;
  occupiedM2: number; // footprints
  whiteSpaceUtilization: number; // incl. clearances
  rackCount: number;
  gpuCount: number;
  itDensityKWPerM2: number;
  maxFloorLoadKgPerM2: number; // worst rack point load averaged over its footprint+clearance
  clearanceViolations: number;
}

export interface PowerAnalysis {
  itNameplateKW: number;
  itDesignKW: number; // × diversity
  itPeakKW: number;
  networkKW: number;
  mechanicalKW: number; // CDU pumps, CRAH fans, chillers
  lossesKW: number; // UPS/transformer losses
  facilityKW: number; // total at design
  pue: number;
  perHall: { hallId: Id; itKW: number; budgetKW: number; utilization: number }[];
  utilityRequiredMVA: number;
  utilityAvailableMVA: number;
  ups: { units: number; unitKVA: number; installedKVA: number; requiredKVA: number };
  generators: { units: number; unitKW: number; installedKW: number; requiredKW: number };
  transformers: { units: number; unitKVA: number; installedKVA: number; requiredKVA: number };
  /** busway circuits / RPP runs counted from the power plane (polish v2 2차: one circuit model with the profile limit);
   *  maxLoading = worst circuit sizing kW ÷ rating, limitFactor = profile continuous limit (fraction of rating) */
  rpps: { units: number; unitKW: number; maxLoading: number; limitFactor?: number };
  /** one-line diagram nodes/edges */
  oneLine: { nodes: OneLineNode[]; edges: { from: Id; to: Id }[] };
  /** PUE at design (peak ambient) conditions; `pue` is the annualized value */
  designPue?: number;
  /** annual-average facility draw at design IT load */
  avgFacilityKW?: number;
  /** sum of all feed capacities (utilityAvailableMVA is the firm N-1 capacity) */
  utilityTotalMVA?: number;
  /** lighting, BMS, security, offices (included in lossesKW) */
  ancillaryKW?: number;
  /** busway / RPP runs per pod, per A/B path */
  rppPerPod?: { podId: Id; kwPerPath: number; runsPerPath: number; loading: number }[];
  // ── v2 2차 (T3) ──
  /** physical power paths (feeder / busway / tap-off) for the 3D power plane and one-line ↔ 3D linking */
  paths?: PowerPath[];
  /** Max-Q stranded-power model */
  maxq?: MaxQReport;
  // ── polish v2 2차 ──
  /** block-redundant / DR UPS sizing from the worst single contingency (engines/powerPaths.ts sizeUpsBlocks) */
  upsSizing?: UpsBlockSizing;
  /** electrical rooms sized from the UPS block count and a footprint table (engines/powerPaths.ts sizeElectricalRooms) */
  rooms?: PowerRoom[];
  // ── finish v2 2차 (D1 / D5) ──
  /** feeder sleeves through hall walls (one per electrical room) and partition sleeves where feeders cross a separate-room partition */
  penetrations?: WallPenetration[];
}

/**
 * Finish v2 2차 (DECISIONS-v2-2 §D1 / D5): a declared, drawn opening in a hall wall or a separate-room partition. Every run that leaves
 * a hall (feeders → electrical room, inter-hall trunks) or crosses a partition must pass inside one. `along` is measured along the wall
 * (x for S / N walls, y for W / E walls; for a partition, along its long axis); `z` is the opening's bottom / top (m above the floor).
 */
export interface WallPenetration {
  id: Id;
  hallId: Id;
  wall: 'N' | 'S' | 'E' | 'W' | 'partition';
  reservationId?: Id;
  along: [number, number];
  z: [number, number];
  kind: 'feeder-sleeve' | 'trunk-sleeve' | 'partition-sleeve';
  /** electrical room id (feeder), peer hall id (trunk), 'feeders' / 'trays' (partition) or the ducted containment id (chimney wall) */
  targetId: Id;
  /** runs routed through the opening */
  runs?: number;
  /** partition / chimney openings: perpendicular coordinate of the wall plane and the axis the wall runs along (hall-local) */
  plane?: number;
  planeAxis?: 'x' | 'y';
}

/** Hall-side electrical room (switchboard + UPS / battery lineups), hall-local plan rectangle outside the wall. */
export interface PowerRoom {
  id: Id;
  hallId: Id;
  side: 'A' | 'B';
  rect: Rect;
  switchboardId: string;
  wall?: 'N' | 'S' | 'E' | 'W';
  depthM?: number;
  /** equipment in the room: UPS modules (hall share), battery cabinets, switchboard sections, lineup rows */
  upsModules?: number;
  batteryCabinets?: number;
  switchboardSections?: number;
  lineups?: number;
  /** wall conflict that could not be avoided (CRAH wall, CDU gallery, another hall) */
  conflict?: 'crah' | 'cdu-gallery' | 'hall' | 'room';
  /** preferred (row-end) wall was occupied and the room moved to this free wall */
  relocatedFrom?: 'N' | 'S' | 'E' | 'W';
  basis?: string;
}

export interface UpsBlockSizing {
  /** N modules from required kVA ÷ module kVA */
  baseModules: number;
  blockModules: number;
  activeBlocks: number;
  /** installed modules incl. the catcher block */
  modules: number;
  /** worst UPS block loading (%) over normal + every single busway circuit / row-side distribution failure */
  worstPct: number;
  worstContingency: string;
  contingencies: number;
  survives: boolean;
  /** arrangement taken from project.power.upsBlocks */
  override: boolean;
  rule: string;
}

export interface OneLineNode {
  id: Id;
  kind: 'utility' | 'transformer' | 'generator' | 'switchgear' | 'ups' | 'battery' | 'pdu' | 'rpp' | 'busway' | 'load' | 'mech';
  label: string;
  ratingKVA?: number;
  loadKW?: number;
  path?: 'A' | 'B' | 'C';
  /** physical objects this node represents (busway runs, rows, racks) for one-line ↔ 3D highlighting */
  refs?: Id[];
}

export interface CoolingAnalysis {
  liquidHeatKW: number;
  airHeatKW: number;
  cdus: { units: number; unitKW: number; requiredKW: number; tcsFlowLpm: number };
  crahs: { units: number; unitKW: number; requiredKW: number; airflowM3s: number; requiredAirflowM3s: number };
  chillers: { units: number; unitKW: number; requiredKW: number };
  fwsFlowLpm: number;
  pumpKW: number;
  fanKW: number;
  chillerKW: number;
  partialPue: number;
  wueLPerKWh: number;
  /** dry coolers (hybrid / dry-cooler heat rejection) */
  dryCoolers?: { units: number; unitKW: number; requiredKW: number };
  /** annual-average mechanical power (economizer-weighted) */
  annualMechanicalKW?: number;
  perPod?: { podId: Id; liquidKW: number; cdusPlaced: number; cdusRequired: number; cduCapacityKW: number }[];
  perHall?: {
    hallId: Id;
    liquidKW: number;
    airKW: number;
    crahsPlaced: number;
    crahsRequired: number;
    crahCapacityKW: number;
    airflowPlacedM3s: number;
    airflowRequiredM3s: number;
    /** polish v2 2차: rear doors attached to racks (EquipmentInstance.meta.rdhxDoorKW) and the air heat they remove (kW) */
    rdhxDoors?: number;
    rdhxDutyKW?: number;
  }[];
  /** v2 2차 (T4): deterministic cooling-topology comparison */
  topology?: CoolingTopologyRow[];
}

export interface NetworkTier {
  name: string; // leaf / spine / core
  switches: number;
  portsPerSwitch: number;
  downlinks: number;
  uplinks: number;
}

export interface FabricAnalysis {
  name: string; // "Scale-out (IB XDR)"
  fabric: FabricTech;
  endpoints: number;
  tiers: NetworkTier[];
  switchCatalogId: string;
  totalSwitches: number;
  bisectionGbps: number;
  oversubscription: number;
  maxHops: number;
  powerKW: number;
  racksNeeded: number;
  topology?: FabricTopology;
  /** negotiated link speed at the switch port */
  linkGbps?: number;
  /** logical endpoint links (after 800G→2×400G style breakout) */
  links?: number;
  /** false when the forced tier count cannot reach all endpoints (or a DDC exceeds the 2-tier FSE cap) */
  feasible?: boolean;
  /** DDC sized beyond the RA's validated base clusters — the NCF count is an extrapolation (estimate) */
  extrapolated?: boolean;
  /** v2 2차 (T2): cluster this fabric belongs to (engines/cluster.ts) */
  clusterId?: Id;
  /** fix v2 2차: rail count of a rail-optimized scale-out fabric whose leaves are rail-aligned (leaf i of a pod = rail i mod rails) */
  rails?: number;
}

export interface NetworkRackLoad {
  rackId: Id;
  ru: number;
  ruCapacity: number;
  kw: number;
  kwCapacity: number;
  /** v2 2차 (T2): fabricKey = scale-out | frontend | storage | oob (labels can repeat); interHall = super-spine of a joined cluster */
  switches: { fabric: string; role: 'leaf' | 'spine' | 'core'; catalogId: string; count: number; podId?: Id; fabricKey?: string; interHall?: boolean; clusterId?: Id }[];
}

export interface CableRun {
  id: string;
  fabric: string;
  fromId: Id; // equipment instance
  toId: Id;
  lengthM: number;
  cableTypeId: string;
  count: number; // parallel identical cables in this bundle
  speedGbps?: number;
  /** v2 2차 (T2): 'inter-hall' = SMF trunk from a hall's top tier to the super-spines of a joined cluster */
  tier?: 'endpoint-leaf' | 'leaf-spine' | 'spine-core' | 'uplink' | 'inter-hall';
  /** v2 2차 (T2) */
  fabricKey?: string;
  clusterId?: Id;
  /** fix v2 2차: rail-aligned endpoint → leaf bundles — cables per rail (index = rail); Σ = count */
  railCounts?: number[];
}

/** v2 2차 (T2): one cluster's network scope (engines/cluster.ts + network.ts). */
export interface ClusterNetworkSummary {
  id: Id;
  name: string;
  hallIds: Id[];
  gpus: number;
  /** FabricAnalysis names sized for this cluster */
  fabrics: string[];
  switches: number;
  cables: number;
  /** joined clusters only: inter-hall super-spine tier and trunks */
  interHall?: {
    zoneHallId: Id;
    superSpineCatalogId: string;
    superSpines: number;
    placedSuperSpines: number;
    trunks: number;
    cableTypeId?: string;
    maxTrunkM: number;
    meanTrunkM: number;
    /** reach of the trunk cable type (m) and the DU-10438 90 % planning limit */
    reachM?: number;
    overReach: number;
    nearReach: number;
    /** hall → inter-hall distance between origins (m) */
    hallDistancesM: { hallId: Id; distanceM: number }[];
  };
}

export interface NetworkAnalysis {
  fabrics: FabricAnalysis[];
  cableRuns: CableRun[];
  cablesByType: { cableTypeId: string; count: number; totalLengthM: number; transceivers: number }[];
  transceiverKW: number;
  /** relative collective-communication efficiency vs ideal non-blocking IB XDR (0..1) */
  commEfficiency: number;
  costUSD: number;
  /** switch placement per network rack */
  rackLoads?: NetworkRackLoad[];
  /** switches that did not fit into any network rack */
  unplacedSwitches?: { fabric: string; role: 'leaf' | 'spine' | 'core'; catalogId: string; count: number; podId?: Id }[];
  /** endpoint/uplink links without a placed switch to terminate on */
  unconnectedLinks?: number;
  /** backlog #10 (stream C): OOB leaf uplinks beyond the free front-end spine / leaf lanes (they end at '?' in the cable schedule); absent = 0 */
  oobUplinksUnterminated?: number;
  /** cable runs longer than any available cable type */
  unreachableRuns?: string[];
  // ── v2 (optional; filled by engines/traffic.ts, engines/placement.ts and the port-level network model) ──
  traffic?: TrafficReport;
  placement?: PlacementReport;
  switchInstances?: SwitchInstance[];
  portLinks?: PortLink[];
  /** v2 2차 (T2): network scope per cluster (default one per populated hall; joined clusters carry the inter-hall tier) */
  clusters?: ClusterNetworkSummary[];
  /** finish v2 2차 (D5): trunk sleeves on the facing walls of joined halls + partition sleeves where trays cross a separate-room partition */
  penetrations?: WallPenetration[];
  /** finish v2 2차 (D5): site pathway between the trunk sleeves of two joined halls (site coordinates) */
  interHallPathways?: { id: Id; hallIds: [Id, Id]; points: Vec3[]; lengthM: number; runs: number; cables: number }[];
}

// ───────────────────────────── v2 network objects ─────────────────────────────

/** A concrete switch placed at a rack U position. */
export interface SwitchInstance {
  id: Id;
  catalogId: string;
  rackId: Id;
  /** lowest rack unit occupied (1-based) */
  u: number;
  role: 'leaf' | 'spine' | 'core' | 'mgmt';
  podId?: Id;
  /** fabric key: scale-out | frontend | storage | oob */
  fabric: string;
}

/** A compute / service node inside a rack with its NICs. */
export interface NodeInstance {
  id: Id;
  rackId: Id;
  /** position index within the rack (0-based) */
  index: number;
  hostname?: string;
  nics: { name: string; gbps: number; fabric: string }[];
}

/** A single port-to-port link (expanded from CableRun bundles). */
export interface PortLink {
  id: Id;
  fromId: Id;
  fromPort: string;
  toId: Id;
  toPort: string;
  cableTypeId: string;
  lengthM: number;
  fabric: string;
}

export interface TrafficReport {
  perTier: { tier: 'scale-up' | 'leaf' | 'spine' | 'core'; bytesPerStepGB: number; utilization: number; headroom: number; utilizationAvg?: number; capacityGBps?: number }[];
  bytesPerStepByGroup: { tp: number; pp: number; dp: number; ep: number; cp: number };
  /** smallest oversubscription with headroom ≥ 0 on every tier */
  minOversubscription: number;
  l2l3: { recommendation: 'l2' | 'l3'; reason: string };
  /** effective communication efficiency fed back into workload.ts */
  commEfficiencyEffective: number;
  stepTimeS: number;
  notes: string[];
  /** blueprint the report was computed for (workload.ts consumes the report only for this blueprint) */
  workloadId?: Id;
  // ── v2 (S2) optional detail — all derived values carry their SpecSource in `sources` ──
  /** load-balancing efficiency η actually used, its class and where the number comes from */
  eta?: {
    value: number;
    class: LoadBalancing;
    source: SpecSource;
    citation: string;
    overridden: boolean;
    // ── v2 2차 (T2, engines/eta.ts): provenance for the badge ──
    sourceType?: EtaSourceType;
    url?: string;
    conditions?: string;
    /** unmeasured nominal value (1.0) when `value` is the 0.95 rank lower bound */
    nominalValue?: number;
    measuredAt?: string;
    hostSourceType?: EtaSourceType;
    hostCitation?: string;
  };
  computeTimeS?: number;
  /** exposed (non-overlapped) communication time per step */
  exposedCommS?: number;
  /** total communication time per step before overlap */
  commTimeS?: number;
  /** v2 2차 (T2): scale-out (NIC) part of commTimeS — the part the overlap formula exposes */
  nicCommTimeS?: number;
  /** v2 2차 (T2): per-group overlap: exposed = T_nic − min(f·T_nic, W) (r2-eta.md §5.2) */
  overlap?: Record<'tp' | 'cp' | 'pp' | 'dp' | 'ep', { f: number; windowS: number; nicCommS: number; exposedS: number; sourceType: EvidenceSourceType | 'user'; citation: string; url?: string; measureIt?: boolean }>;
  overlapFramework?: 'megatron-no-overlap' | 'fsdp-prefetch' | 'megascale-overlap' | 'dualpipe';
  /** v2 2차 (T2): NIC busbw factor η_host used */
  etaHost?: number;
  /** v2 2차 (T2): η used for expert-parallel all-to-all when it differs from η_fabric */
  etaA2a?: number;
  mfuEffective?: number;
  /** placement of each parallel group: which tier its collectives run on */
  groupTier?: { tp: string; cp: string; pp: string; dp: string; ep: string };
  /** minimal inference traffic block (KV bytes/token, P/D KV transfer, EP all-to-all decode bound) */
  inference?: { kvBytesPerToken: number; kvTransferGbps: number; epDecodeTokPerSPerUser: number; attention: 'gqa' | 'mla' };
}

export interface PlacementCandidate {
  spinePlacement: SpinePlacement;
  meanLinkM: number;
  maxLinkM: number;
  fiberKm: number;
  /** peak tray cross-section demand (mm²) */
  trayPeakMm2: number;
  transceivers: number;
  /** rack positions lost to network-core racks inside the compute area */
  lostPositions: number;
  interconnectUSD: number;
  /** links longer than the selected medium's reach */
  overLimitLinks: number;
  // ── v2 (S2) optional detail ──
  /** leaf→spine (+ spine→core) links evaluated */
  links?: number;
  /** switch-side optics power (kW) of the evaluated links */
  transceiverKW?: number;
  /** 'relayout' = geometry from layout/fit.ts relayoutForPlacement; 'approximation' = spine racks moved by the comparator; 'current' = project as-is */
  basis?: 'current' | 'relayout' | 'approximation';
  notes?: string[];
}

export interface PlacementReport {
  candidates: PlacementCandidate[];
  chosen: SpinePlacement;
  // ── v2 (S2) optional ──
  /** cheapest candidate with no over-limit links (ties → shorter max link) */
  recommended?: SpinePlacement;
  /** tray fill ratio used for trayPeakMm2 (0.5 NEC 392.22 / 0.4 TIA-569) */
  fillRatio?: number;
  notes?: string[];
}

/** Workload-first sizing suggestion (WorkloadPanel '규모 산정' → Layout panel). Store-level object, not persisted in the project. */
export interface SizingSuggestion {
  workloadId: Id;
  workloadName: string;
  gpuRackCatalogId: string;
  gpus: number;
  racks: number;
  /** user-defined hall deployment units of `racksPerPod` racks (not vendor SUs) */
  pods: number;
  racksPerPod: number;
  itMW: number;
  /** white-space estimate incl. aisles and CRAH zones (m²) */
  areaM2: number;
  target: { kind: 'train-days'; days: number } | { kind: 'tokens-per-s'; tokensPerS: number };
  mfu: number;
  source: SpecSource;
  createdAt: string;
}

// ───────────────────────────── v2 deliverables ─────────────────────────────

export interface DrawingSheet {
  id: Id;
  /** sheet number, e.g. 'A-101' */
  number: string;
  title: string;
  kind: DrawingSheetKind;
  svg: string;
  /** e.g. '1:100' */
  scale?: string;
  /** D2 rack elevation sheets: filter keys for the Drawings panel */
  group?: { hallId: Id; zone: 'du' | 'services' | 'network-core' | 'unassigned' | 'type'; groupKey?: string; podId?: Id; rowId?: string; face?: 'front' | 'rear' | 'both' };
  // ── r4 (2D drawings contract, docs/research/r4-2d-drawings-spec.md §2.4) ──
  /** paper size (mm) = the root svg width / height. Filled by generateDrawings / buildDrawing for every sheet. */
  paper?: { w: number; h: number };
  /** model viewports drawn on the sheet (world ↔ paper maps for "Open in 2D" and the T3 inverse-map checks) */
  viewports?: DrawingViewport[];
}

// ───────────────────────────── r4: 2D drawings / 2D view (contract) ─────────────────────────────

/** Every sheet kind. Only 'plan' · 'rack-elevation' · 'iso-systems' are generated by default; the rest are opt-in via DrawingOptions.sheets. */
export type DrawingSheetKind =
  | 'plan' | 'iso-systems' | 'rack-elevation' | 'site'
  | 'index' | 'services-plan' | 'enlarged-plan' | 'section' | 'elevation' | 'mep-iso' | 'row-schematic' | 'one-line' | 'detail';

/** 2D projection space: plan = hall-local (x, y); section / elevation = (u along the cut, z). */
export type DrawingSpace = 'plan' | 'section' | 'elevation';

/** Drawing length units (S6). Absent on the project = 'metric'. */
export type DrawingUnits = 'metric' | 'imperial';

/**
 * Section cut (spec §2.4). The cut plane is perpendicular to `axis` at `axis = at` (hall-local m). The viewer looks along
 * `look` (+1 = towards +axis); prims in (at, at + look·depthM] are drawn "beyond". `u` is the horizontal paper axis, increasing to
 * the viewer's right: axis 'y' → u = look·x; axis 'x' → u = −look·y (so flipping `look` mirrors u). `window` limits u (m, in u).
 */
export interface DrawingCut {
  id: Id;
  label: string;
  hallId: Id;
  /** semantic purpose; absent on old/free cuts */
  kind?: 'free' | 'pod-transverse' | 'row-longitudinal' | 'aisle-longitudinal';
  /** pod/DU id for a transverse cut, row id for a row-longitudinal cut */
  refId?: Id;
  /** equipment that established the cut station (normally the selected rack) */
  anchorId?: Id;
  axis: 'x' | 'y';
  at: number;
  look: 1 | -1;
  depthM: number;
  window?: { u0: number; u1: number };
}

/** Elevation target (spec §2.3): hall wall, row face, or containment aisle end. */
export type ElevationTarget =
  | { kind: 'wall'; wall: 'N' | 'E' | 'S' | 'W' }
  | { kind: 'row-face'; rowId: string; face: 'front' | 'rear' }
  | { kind: 'aisle-end'; containmentId: string; end: 0 | 1 };

/**
 * A model viewport placed on a sheet. Convention: `paperRect` (mm, sheet coordinates, y down) shows `worldRect` at `mmPerM`
 * (paperRect.w = worldRect.w·mmPerM, paperRect.h = worldRect.d·mmPerM); world y (plan) or z (section / elevation) points up:
 *   paperX = paperRect.x + (wx − worldRect.x)·mmPerM,  paperY = paperRect.y + paperRect.h − (wy − worldRect.y)·mmPerM.
 * Helpers: drawings/context.ts viewportWorldToPaper / viewportPaperToWorld.
 */
export interface DrawingViewport {
  paperRect: { x: number; y: number; w: number; h: number };
  hallId: Id;
  space: DrawingSpace;
  /** plan: hall-local {x, y, w, d}; section / elevation: {x: u0, y: z0, w: Δu, d: Δz} */
  worldRect?: Rect;
  /** stored cut (project.drawingCuts) or generated cut id */
  cutId?: string;
  /** generated cuts are not stored: the cut itself travels with the viewport */
  cut?: DrawingCut;
  elevation?: ElevationTarget;
  mmPerM: number;
}

/** Stored 2D view → sheet ("Send to sheet", P1 — type only in this round). */
export interface DrawingView {
  id: Id;
  kind: DrawingSpace;
  hallId: Id;
  window?: Rect;
  cutId?: Id;
  elevation?: ElevationTarget;
  layers: string[];
  paper: { w: number; h: number };
  scale: string;
  number: string;
  title: string;
  /** callout bubble + boundary drawn on the parent plan */
  callout?: { parentSheetId?: string; bubble?: string };
}

/** One overhead service level above the racks (spec §2.4 Hall.verticals.tiers). */
export interface ServiceTier {
  id: string;
  kind: 'pipe' | 'busway' | 'tray' | 'light';
  /** what the tier carries: fabric / system ids (e.g. 'scale-out', 'frontend', 'storage', 'oob', 'tcs') */
  carries: string[];
  /** centre-line height above FFL (m) */
  z: number;
  heightM: number;
  widthM?: number;
}

/** Vertical stack of a hall (spec §2.4). Every field optional; absent = today's defaults (see scene/datums.ts). */
export interface HallVerticals {
  /** graphic slab thickness (m), default 0.30 (estimate) */
  slabThicknessM?: number;
  /** S8: default 'pipe-busway-trays' (repo order); 'trays-busway' = trays below the busway */
  stackOrder?: 'pipe-busway-trays' | 'trays-busway';
  /** explicit tiers; absent = pipe rackH+0.22 · busway min(trayHeight−0.22, rackH+0.4) · T1 trayHeight · T2 +0.35 · T3 +0.70 */
  tiers?: ServiceTier[];
  /** clearance above the top service (m), default 0.30 (TIA-942-B, verify) */
  topClearanceM?: number;
}

/** Structural grid axes (spec §2.4, P0 read-only). Absent = axes through aligned column keepouts, else the planning grid. */
export interface StructuralGrid {
  x?: { at: number[]; labels?: string[] };
  y?: { at: number[]; labels?: string[] };
  columnSizeM?: number;
}

/** Door data on a 'door' keepout (spec §2.4). Absent = 2 leaves if w ≥ 1.2 m else 1 · swing 'in' · 2.4 m (estimate). */
export interface KeepoutDoor {
  leaves: 1 | 2;
  swing: 'in' | 'out' | 'sliding';
  clearHeightM?: number;
}

/** Derived liquid-cooling pipe run (layout/pipes.ts buildPipes, P1; never stored). Sizes are estimates. */
export interface PipeRun {
  id: string;
  hallId: Id;
  system: 'tcs-supply' | 'tcs-return';
  kind: 'header' | 'riser' | 'branch' | 'drop';
  /** hall-local centre-line (m, Z-up) */
  points: Vec3[];
  /** nominal diameter (mm, estimate: smallest DN with v ≤ 2.4 m/s at 1.5 LPM/kW) */
  dnMM: number;
  cduIds: Id[];
  rowId?: Id;
  podId?: Id;
  /** RCU / CDU loop the run belongs to (headers split per loop) */
  loopId?: string;
  /** r4 B2: design flow carried by the run (L/min, derived from 1.5 LPM/kW) */
  flowLpm?: number;
  /** r4 B2: header role — 'cross' (pod distribution across the rows) · 'row' (along a row / RCU loop) · 'link' (CDU riser top → cross header) */
  part?: 'cross' | 'row' | 'link';
}

/** Derived pipe fitting (valve / strainer / manifold) at a point of a PipeRun. */
export interface PipeFitting {
  id: string;
  kind: 'epiv' | 'isolation-valve' | 'strainer' | 'qd-manifold';
  at: Vec3;
  equipmentId?: Id;
  runId?: string;
}

/** buildPipes result for one hall. */
export interface PipeNetwork {
  hallId: Id;
  runs: PipeRun[];
  fittings: PipeFitting[];
}

export interface GlossaryTerm {
  id: Id;
  term: Record<Locale, string>;
  short: Record<Locale, string>;
  long?: Record<Locale, string>;
  related?: string[];
  sources?: string[];
  // ── v2 S4 (optional) ──
  /** alternative spellings / acronyms resolved by findTermByAlias (case-insensitive) */
  aliases?: string[];
  /** topic bucket used by the help drawer (network · cooling · power · layout · workload · optics · ops) */
  domain?: 'general' | 'layout' | 'network' | 'optics' | 'cooling' | 'power' | 'workload' | 'ops';
}

export interface CostAnalysis {
  bom: BomLine[];
  capexUSD: number;
  byDomain: Record<BomLine['domain'], number>;
  opexUSDPerYear: number; // energy + maintenance
  energyMWhPerYear: number;
  tcoUSD5y: number;
  usdPerGpu: number;
  usdPerMWIT: number;
}

export interface ScheduleTask {
  id: Id;
  name: string;
  phase: 'procurement' | 'site' | 'power' | 'cooling' | 'it' | 'network' | 'commissioning' | 'handover';
  waveId?: Id;
  start: ISODate;
  end: ISODate;
  durationDays: number;
  dependsOn: Id[];
  critical: boolean;
  crew?: keyof ScheduleSettings['crews'];
  qty?: number;
  laborHours?: number;
  slackDays?: number;
}

export interface ScheduleAnalysis {
  tasks: ScheduleTask[];
  milestones: { id: Id; name: string; date: ISODate }[];
  readyForServiceDate: ISODate;
  /** cumulative GPUs online by date */
  capacityRamp: { date: ISODate; gpus: number; itKW: number }[];
  totalLaborHours: number;
}

export interface WorkloadTimePoint { t: number; powerKW: number; utilization: number }

export interface WorkloadAnalysis {
  workloadId: Id;
  gpus: number;
  // training
  stepTimeS?: number;
  computeTimeS?: number;
  commTimeS?: number;
  tokensPerSec?: number;
  mfu?: number;
  timeToTrainDays?: number;
  goodput?: number; // after failures & checkpoints
  // inference
  maxRequestsPerSec?: number;
  ttftMs?: number;
  tpotMs?: number;
  gpusRequired?: number;
  // energy
  avgPowerKW: number;
  peakPowerKW: number;
  energyMWh: number;
  energyCostUSD: number;
  tokensPerKWh?: number;
  /** 1-second resolution sample (downsampled) of the power profile for the first window */
  powerTrace: WorkloadTimePoint[];
  notes: string[];
  /** English notes for the EN design document */
  notesEn?: string[];
  /** model-specific intermediate values (dp, bubble, instance size, …) */
  details?: Record<string, number | string>;
}

export interface ProjectAnalysis {
  generatedAt: string;
  summary: {
    halls: number;
    racks: number;
    gpuRacks: number;
    gpus: number;
    /** stream T4: chips in accelerator compute-slot racks (LPX / NPU), not included in `gpus`; optional for stored analyses */
    acceleratorChips?: number;
    itMW: number;
    facilityMW: number;
    pue: number;
    capexUSD: number;
    readyForService: ISODate;
    errors: number;
    warnings: number;
  };
  space: SpaceAnalysis[];
  power: PowerAnalysis;
  cooling: CoolingAnalysis;
  network: NetworkAnalysis;
  cost: CostAnalysis;
  schedule: ScheduleAnalysis;
  workloads: WorkloadAnalysis[];
  issues: Issue[];
}

// ───────────────────────────── v2 2차 contract ─────────────────────────────

// ── network deliverables (T2 data, T7 formatting) ──

/** One port-to-port cable in the cable schedule (TIA-606-shaped labels, both ends). */
export interface CableScheduleRow {
  cableId: string;
  fabric: string;
  fromRack: string;
  fromU?: number;
  fromPort: string;
  toRack: string;
  toU?: number;
  toPort: string;
  cableTypeId: string;
  lengthM: number;
  labelA: string;
  labelB: string;
  /** deployment wave id */
  wave?: string;
  // ── T2 detail (engines/links.ts) ──
  /** Bundling Sequence Number (NVIDIA DU-10438 §5.2.3): index of the (source rack, destination rack, cable type, length) bundle */
  bsn?: number;
  tier?: 'endpoint-leaf' | 'leaf-spine' | 'spine-core' | 'uplink' | 'inter-hall';
  /** scale-out | frontend | storage | oob */
  fabricKey?: string;
  speedGbps?: number;
  fromHallId?: string;
  toHallId?: string;
  /** analysis CableRun this cable was expanded from */
  runId?: string;
}

/** Deterministic IP / ASN plan (/31 p2p + eBGP unnumbered, OOB / in-band blocks). */
export interface IpPlan {
  blocks: { name: string; cidr: string; purpose: string }[];
  /** IPv6 uses its own hierarchy because a /64 cannot be meaningfully compared to IPv4 by raw address area. */
  ipv6Blocks?: { name: string; cidr: string; purpose: string }[];
  addressFamilies?: ('ipv4' | 'ipv6')[];
  ipv4Prefix?: string;
  ipv6Prefix?: string;
  fabricLinks?: 'unnumbered' | 'numbered';
  loopbacks: { deviceId: string; ip: string; ipv6?: string }[];
  asns: { deviceId: string; asn: number }[];
  p2p: {
    linkId: string; a: string; b: string; cidr?: string; ipv6Cidr?: string; ipv6A?: string; ipv6B?: string;
    unnumbered: boolean; hallId?: string; network?: string; rail?: number;
  }[];
  hosts: {
    nodeId: string; nic: string; ip: string; ipv6?: string; vlan?: number; gw?: string; ipv6Gw?: string;
    hallId?: string; network?: string; plane?: number; rail?: number; switchDevice?: string;
  }[];
  oob: { deviceId: string; ip: string; ipv6?: string; gw?: string; ipv6Gw?: string; hallId?: string; switchDevice?: string }[];
  /** T2: capacity / fabric notes (InfiniBand PKeys, overflow warnings, unnumbered fabric) */
  notes?: string[];
}

export type NosTarget = 'sonic' | 'cumulus-nvue' | 'arista-eos' | 'cisco-nxos' | 'dell-os10' | 'juniper-junos' | 'ib-ufm';

/** A generated text file (NOS config, test script, HTML/CSV deliverable). */
export interface GeneratedFile {
  path: string;
  content: string;
  mime?: string;
}

// ── power plane (T3) ──

export interface PowerScenario {
  kind: 'normal' | 'utility-loss' | 'generator-failure' | 'ups-module-failure' | 'rpp-failure' | 'busway-failure';
  /** number of failed elements (worst-case selection when targetIds is absent) */
  count?: number;
  targetIds?: string[];
  /** IT load factor (0..1+) applied to rack power */
  loadFactor?: number;
}

export interface PowerScenarioResult {
  scenario: PowerScenario;
  paths: { id: string; loadingPct: number; overloaded: boolean; kw?: number; warn?: boolean }[];
  droppedEquipmentIds: string[];
  notes: string[];
  // ── optional detail (T3) ──
  /** element ids failed by the scenario (chosen worst case when targetIds was absent) */
  failedIds?: string[];
  /** racks whose state is not 'normal' */
  racks?: PowerRackOutcome[];
  /** upstream elements (utility, generators, UPS systems, hall switchboards) */
  elements?: PowerElementResult[];
  summary?: PowerScenarioSummary;
}

/** r2-platform.md §1.3: end state of a rack in a power scenario. */
export type PowerRackState = 'normal' | 'single-path' | 'on-bypass' | 'capped' | 'dropped';

export interface PowerRackOutcome {
  id: string;
  state: PowerRackState;
  /** kW drawn from side A / B in the scenario */
  kwA: number;
  kwB: number;
  /** rack demand before capping (kW) */
  demandKW: number;
  reason?: string;
}

export interface PowerElementResult {
  id: string;
  kind: 'utility' | 'generator' | 'ups' | 'switchboard';
  label: string;
  side?: 'A' | 'B' | 'C';
  loadKW: number;
  capacityKW?: number;
  loadingPct?: number;
  overloaded: boolean;
  state: 'normal' | 'standby' | 'carrying' | 'reduced-redundancy' | 'transferred' | 'on-bypass' | 'lost' | 'shortfall';
}

export interface PowerScenarioSummary {
  profile: PowerProfile;
  /** continuous limit as a fraction of the rating (NEC 0.8 / IEC 1.0) */
  limitFactor: number;
  /** warning threshold as a fraction of the rating */
  warnAt: number;
  worstPathId?: string;
  worstLoadingPct: number;
  overloadedPaths: number;
  warnPaths: number;
  droppedRacks: number;
  droppedGpus: number;
  droppedKW: number;
  cappedRacks: number;
  cappedKW: number;
  singlePathRacks: number;
  bypassRacks: number;
  gensetMarginPct?: number;
  upsMarginPct?: number;
  utilityMarginPct?: number;
}

export interface MaxQReport {
  budgetKW: number;
  drawKW: number;
  strandedKW: number;
  extraRacks: number;
  gpusPerMWStatic: number;
  gpusPerMWDynamic: number;
  source: string;
  // ── optional detail (T3) ──
  racks?: number;
  gpus?: number;
  allocationKWPerRack?: number;
  drawKWPerRack?: number;
  newRackDrawKW?: number;
  /** B − reserve − Σdraw after admitting the extra racks */
  headroomKW?: number;
  /** worst-case cap depth if every rack peaks at its allocation simultaneously: 1 − B / (n_dynamic · A) */
  capDepth?: number;
  reserveKW?: number;
  allocationBasis?: string;
  drawBasis?: 'peak' | 'avg' | 'catalog-typical';
  /** static Max-Q setting (blog provisioning) for comparison */
  staticMaxQ?: { settingKW: number; maxpKW: number; racks: number; gainPct: number; /** setting scaled from the blog's Max-P basis to this allocation */ derived?: boolean; source: string };
  sources?: { label: string; url?: string; sourceType: EvidenceSourceType }[];
  // ── polish v2 2차 ──
  budgetBasis?: 'allocation' | 'hall-budget' | 'custom';
  /** Σ rack allocation (static Max-P) */
  allocatedKW?: number;
  /** GPU-weighted workload draw ÷ allocation after removing the network share (not clamped; > 1 = allocation below the draw) */
  utilization?: number;
  /** network (switch + optics) power removed from the workload draw before the per-GPU ratio */
  networkShareKW?: number;
}

// ── cooling topology (T4) ──

export type CoolingTopologyOption = 'gallery-fan-wall' | 'perimeter-crah' | 'in-row' | 'sidecar-l2a' | 'rdhx';

export interface CoolingTopologyRow {
  option: CoolingTopologyOption;
  units: number;
  installedKW: number;
  sparePct: number;
  positionsLost: number;
  galleryM2: number;
  fanKW: number;
  relativeCost: number;
  notes: string[];
  source: string;
  // ── optional detail (T4, r2-platform.md §2.2) ──
  /** hall the row was computed for (absent = project aggregate) */
  hallId?: Id;
  /** the hall's current air-side strategy maps to this option */
  current?: boolean;
  /** air-side heat the option's room / row units must carry (kW) */
  requiredKW?: number;
  /** units at N (before redundancy) */
  unitsN?: number;
  unitKW?: number;
  unitLabel?: string;
  redundancyGroup?: 'hall' | 'pod' | 'rack';
  /** largest single unit failed: (group capacity − that unit) ÷ requirement of the group it serves, weakest group (%) */
  worstFailureResidualPct?: number;
  /** polish v2 2차: product label of the unit failed in `worstFailureResidualPct` (the largest single unit of the row) */
  worstFailureUnit?: string;
  /** polish v2 2차: heat the rack devices actually remove at design load (RDHx door duty; `installedKW` counts rated capacity) */
  rackDutyKW?: number;
  /** IT kW displaced by the lost rack positions (positions × mean rack kW) */
  itKWDisplaced?: number;
  /** white-space floor area taken by units + service clearance (m²) */
  whiteSpaceM2?: number;
  /** facility-water joints inside the white space */
  waterJoints?: number;
  facilityWaterInHall?: boolean;
  /** rack-level devices (sidecars / doors) on top of the room units */
  rackUnits?: number;
  rackUnitKW?: number;
  /** 'catalog' = every unit price from the catalog; 'estimate' = at least one placeholder price */
  costBasis?: 'catalog' | 'estimate';
  coefficients?: CoolingTopologyCoefficient[];
  /** translatable notes: i18n key (cooling.* namespace) + params; `notes` carries the English text */
  noteIds?: { key: string; params?: Record<string, string | number> }[];
}

export interface CoolingTopologyCoefficient {
  key: string;
  label: string;
  value: number;
  unit: string;
  sourceType: EvidenceSourceType | 'user';
  source: string;
  url?: string;
}

// ── workload presets & benchmarks (T6) ──

/** Evidence class of research data (r2-model-presets.json). */
export type EvidenceSourceType = 'measured-paper' | 'vendor-claim' | 'acceptance-threshold' | 'standard' | 'official-config' | 'derived' | 'estimate';

/** Public model architecture preset (official config.json / model card). Architecture fields feed byte-exact traffic
 *  (all-to-all, KV); throughput / MFU must be calibrated against a benchmark (DECISIONS-v2-2 F9). */
export interface ModelPreset {
  id: string;
  name: string;
  org: string;
  kind: 'dense' | 'moe';
  paramsB: number;
  activeParamsB: number;
  layers: number;
  hiddenSize: number;
  numHeads: number;
  kvHeads: number;
  vocab: number;
  moe?: { experts: number; topK: number; shared?: number; denseLayers?: number; expertFfn?: number; denseFfn?: number; moeLayerInterval?: number };
  mla?: { dLatent: number; dRope: number; qLatent?: number; dNope?: number; dV?: number };
  contextLen: number;
  sourceUrl: string;
  sourceType: 'official-config';
  // ── optional detail from r2-model-presets.json ──
  /** attention head dim when ≠ hiddenSize / numHeads (Qwen3, gpt-oss, GLM-4.5, Gemma 3) — use it for KV bytes */
  headDim?: number;
  /** local / chunked attention (long-context KV counts only global layers) */
  attention?: { slidingWindow?: number; pattern?: string; chunkSize?: number; noRopeGlobalEvery?: number };
  denseFfn?: number;
  license?: string;
  notes?: string;
  cardUrl?: string;
  /** architecture taken from a mirror of a gated config (Llama 4) */
  archSourceUrl?: string;
  archSourceNote?: string;
  /** values derived by the research script (source type 'derived') */
  derived?: { paramsB: number; activeParamsB: number; kvBytesPerTokenBf16: number; kvBytesPerTokenBf16LongContext: number; epA2aBytesPerTokenPerMoeLayerFwd: number };
}

/** Public benchmark result usable for calibration (MLPerf Training/Inference, papers, InferenceX, vendor RAs). */
export interface BenchmarkRow {
  id: string;
  suite: string;
  round: string;
  task: string;
  model: string;
  system: string;
  accelerator: string;
  /** accelerator count; null when the source reports per-GPU figures only (InferenceX) */
  accelerators: number | null;
  metric: string;
  value: number;
  unit: string;
  derived?: {
    mfu?: number;
    tokensPerSecPerGpu?: number;
    outputTokensPerSecPerGpu?: number;
    tokensPerSec?: number;
    tflopsPerGpu?: number;
    flopsPerToken?: number;
    tokensToTarget?: number;
    mfuBasis?: string;
  };
  sourceUrl: string;
  sourceType: EvidenceSourceType;
  precision?: string;
  parallelism?: string;
  runsSec?: number[];
  seqLen?: number;
  globalBatchSeqs?: number;
  systemUrl?: string;
  apiUrl?: string;
  latencyConstraint?: { ttftP99Ms: number; tpotP99Ms: number; minInteractivityTokPerSecPerUser: number };
  interactivityTokPerSecPerUser?: number;
  concurrency?: number;
  framework?: string;
  /** MLCommons public result ID (e.g. '6.0-0013') when the row is an MLPerf result */
  resultId?: string;
  /** ISO date the source was retrieved */
  retrieved?: string;
  notes?: string;
}

// ── collaboration (T8) ──

export interface ProjectVersion {
  id: string;
  projectId: string;
  savedAt: string;
  savedBy?: string;
  note?: string;
  summary: { gpus: number; racks: number; itMW: number; capexUSD: number; rfs?: string };
}

export interface ProjectLock {
  projectId: string;
  /** display name (no accounts) */
  holder: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface VersionDiff {
  added: string[];
  removed: string[];
  moved: string[];
  changed: string[];
  summaryDelta: Record<string, number>;
}
