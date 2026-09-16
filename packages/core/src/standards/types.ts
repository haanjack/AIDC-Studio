/**
 * Standards registry and standards profile types (stream A / P1, docs/research/ocp/OCP-DESIGN-PROPOSAL.md §2).
 *
 * Wording rules (proposal §1 P5, §6.2–6.3): enum values and ids here are internal keys. They never carry an organisation's
 * mark and are never printed as-is in the UI or deliverables — render labels from i18n / docs strings instead.
 * Legacy spellings (e.g. the pre-P1 level enum, `'lqc-dn25'`) are accepted only through `catalog/aliases.ts`.
 */

/** Publication status of a cited document. `external` = another body (ASHRAE, EIA, UEC, UALink …). */
export type SpecStatus = 'accepted' | 'contributed' | 'draft' | 'review' | 'roadmap' | 'external';
export type DocType = 'base-spec' | 'design-spec' | 'requirements' | 'guideline' | 'white-paper' | 'assessment' | 'consortium-spec' | 'industry-standard' | 'vendor-publication';
/** How a parameter was obtained: read from the document, arithmetic on read values, planner estimate, or not confirmed. */
export type Verification = 'verified' | 'derived' | 'estimate' | 'unverified';
export type StandardFamily = 'rack' | 'rack-power' | 'liquid' | 'air' | 'compute' | 'nic' | 'network' | 'mgmt' | 'facility';
export type StandardLicence =
  | 'owfa-0.9-mod'
  | 'owfa-1.0'
  | 'owfa-1.0-mod'
  | 'hw-permissive'
  | 'cc-by-4.0'
  | 'cc-by-sa-4.0'
  | 'all-rights-reserved'
  | 'proprietary'
  | 'unknown';

/** One cited document revision. Entries are immutable: a newer revision is a new entry (`supersedes`), never an edit. */
export interface StandardRef {
  /** `<key>@<version>`, e.g. 'orv3-base@1.1' */
  id: string;
  family: StandardFamily;
  /** document title as published (nominative citation) */
  title: string;
  version: string;
  /** publication / effective date (ISO, `YYYY-MM` when only the month is known, '' when unknown) */
  date: string;
  /** public URL of the document or its listing page */
  url: string;
  licence: StandardLicence;
  status: SpecStatus;
  docType: DocType;
  supersedes?: string;
  /** short note (never document text) */
  notes?: string;
}

/** Per-field provenance of a catalog value. */
export interface ParamProvenance {
  standardId?: string;
  clause?: string;
  verification: Verification;
  note?: string;
}

// ───────────────────────────── standards profile ─────────────────────────────

export type RackFormKey = 'eia-310-19' | 'orv3' | 'orv3-hpr' | 'orv3-mgx' | 'orw' | 'mixed';
export type RackPowerKey = 'ac-pdu' | 'dc-busbar-48-54v' | 'dc-busbar-50v-hpr' | 'hvdc-pm400-sidecar' | 'vendor-busbar';
export type ShelfClassKey = 'orv3-18kw' | 'hpr-33kw' | 'hpr-v2-72kw';
export type ConnectorKey = 'uqd' | 'uqdb' | 'bmqc' | 'pbmc' | 'lqc' | 'vendor' | 'none';
export type RackManifoldKey = 'eia-vertical' | 'orv3-blindmate' | 'vendor' | 'none';
export type CduClassKey = 'none' | 'in-rack-rpu' | 'row-l2l' | 'facility-2mw';
export type CduRatingBasis = 'l-lcdu-wp-r1' | 'loop-reqs-4k' | 'vendor';
export type FluidKey = 'pg25' | 'treated-water' | 'dielectric-1p';
export type FwsClass = 'W17' | 'W27' | 'W32' | 'W40' | 'W45' | 'W+';
export type IteCoolingClass = 'hybrid-basic' | 'hybrid-intermediate' | 'full-liquid';
export type AirSideKey = 'crah-perimeter' | 'fan-wall' | 'door-hx' | 'in-row' | 'none';
/** Facility pre-check basis (informational only): `off`, or the facility assessment revision the values come from. */
export type FacilityPrecheckKey = 'off' | 'facility-v1@1.5' | 'facility-v2hs@1.15';
export type StandardsPresetId = 'orv3-hpr-liquid' | 'orw-liquid-sidecar' | 'orv3-air-dhx' | 'eia-air' | 'eia-liquid-uqd';

export interface LiquidProfile {
  connector: ConnectorKey;
  rackManifold: RackManifoldKey;
  cduClass: CduClassKey;
  cduRatingBasis?: CduRatingBasis;
  fluid: FluidKey;
  fwsClass?: FwsClass;
  iteCoolingClass?: IteCoolingClass;
}

export interface StandardsProfile {
  /** preset this profile started from (absent = custom / inferred without a matching preset) */
  id?: StandardsPresetId | string;
  rackForm: RackFormKey;
  rackPower: RackPowerKey;
  /** when rackPower is a busbar. `hpr-v2-72kw` only with an HPRv3 power-rack vertical busbar (P0). */
  shelfClass?: ShelfClassKey;
  bbu?: 'none' | 'in-rack';
  liquid: LiquidProfile;
  air: AirSideKey;
  facilityPrecheck?: FacilityPrecheckKey;
  /** DO-3: checks are advisory by default; `gate` lets non-draft checks raise errors */
  strictness: 'advisory' | 'gate';
  /** DO-4: draft / review / roadmap blocks behind a toggle */
  includeDraftSpecs: boolean;
  /** registry ids in force per family, e.g. rack: ['orv3-base@1.1', 'orv3-frame-meta@1.3'] */
  pinned: Partial<Record<StandardFamily, string[]>>;
  /** set by `upgradeProject()` for legacy projects: new standards checks stay `info` until the user confirms the profile */
  inferred?: boolean;
}

/** Hall override: field-by-field over the project profile (`liquid` merges per field). */
export type HallStandardsOverride = Partial<Omit<StandardsProfile, 'liquid'>> & { liquid?: Partial<LiquidProfile> };

// ───────────────────────────── catalog additions (all optional) ─────────────────────────────

/**
 * How an item implements a standard. Neutral internal keys (the P0 box asks for enum names without the mark):
 *  - `open-spec`          — implements a published open specification (e.g. OAM/UBB, ORv3)
 *  - `contributed-design` — a vendor design contributed to a standards body (e.g. a rack-scale frame)
 *  - `open-platform-host` — proprietary compute hosted on open rack / NIC / modular-hardware interfaces
 *  - `eia`                — generic 19-inch EIA-310
 *  - `proprietary`        — opaque equipment
 */
export type StandardLevel = 'open-spec' | 'contributed-design' | 'open-platform-host' | 'eia' | 'proprietary';
export type StandardScope = 'rack' | 'power' | 'liquid' | 'air' | 'module' | 'baseboard' | 'nic' | 'host' | 'network' | 'mgmt' | 'facility';

export interface ItemStandard {
  standardId: string;
  level: StandardLevel;
  scope: StandardScope;
  /** where a non-document claim comes from (stream B): a vendor blog or press release never yields `contributed-design` / `open-spec` as verified */
  evidence?: { kind?: 'standard-document' | 'vendor-datasheet' | 'product-page' | 'vendor-blog' | 'press-release'; label: string; url: string; accessed: string };
  verification: Verification;
  /** generic class (catalog id) a vendor instance maps to, e.g. 'cdu-facility-2mw' (stream B, proposal §3.4) */
  classId?: string;
  /** e.g. "above the cited module power envelope" (never blocks eligibility) */
  note?: string;
}

export interface ItemFormFactor {
  rack?: RackFormKey;
  unitPitchMm: 44.45 | 48;
  heightUnits?: number;
  usableUnits?: number;
  supportsMixedPitch?: boolean;
  /** frame implementation whose ratings apply, e.g. 'orv3-frame-meta@1.3' */
  implementation?: string;
  payloadKg?: number;
  payloadExcludesFrame?: boolean;
  crossBraceAboveKg?: number;
  itShelfKgPerSet?: number;
  /** node / tray height in the rack's unit (OU or U) */
  nodeHeightUnits?: number;
  /** the item mounts on its own rails (shelf-set load limit does not apply) */
  ownRails?: boolean;
}

export interface ItemRackPower {
  interface: 'ac-pdu' | 'dc-busbar' | 'hvdc-cable';
  nominalV: number;
  rangeV: [number, number];
  busbarRatingA?: number;
  busbarRatingKW?: number;
  busbarCooling?: 'air' | 'liquid';
  itConnectorA?: number;
}

export interface ItemPowerShelf {
  heightOU: number;
  slots: number;
  psuKW: number;
  redundancy: 'N+1' | 'N+N' | 'N+0';
  shelfKW: number;
  ratedKWAtRedundancy: number;
  outputV: [number, number];
  outputConnector: { stillAirA: number; airflowA?: number; airflowLFM?: number; ambientC?: number; spec: string };
  acInputs: { count: number; V: number; A: number; plug: string };
  availableFaultKA?: number;
  parallelMax?: number;
  busbarInterface?: 'orv3-clip' | 'hpr-v1-clip' | 'hprv3-power-rack-bolted';
}

export interface ItemBbu {
  moduleKW: number;
  modules: number;
  redundancy: string;
  backupCurve: { kw: number; seconds: number }[];
  /** end-of-life full-power backup threshold (P0 default 90 s) */
  eolBackupS?: number;
  /** beginning-of-life value shown as info (e.g. 240 s) */
  bolBackupS?: number;
  lifeYears?: number;
}

export interface ItemPowerRack {
  inputs: { count: number; A: number; V: number[] };
  ratingKWByInputV: Record<number, number>;
  linkKW: 50 | 100;
  linkA: 63 | 125;
  efficiency100?: number;
  bbuSeconds?: [number, number];
}

export interface ItemLiquidInterface {
  connector: ConnectorKey;
  ports?: number;
  portPitch?: 'U' | 'OU';
  mawpKPa: number;
  maxFluidC: number;
  ratedLpmPerPort?: number;
  branchDN?: 25 | 50 | 100 | 150;
  maxVelocityMs?: number;
  maxFlowSpreadPct?: number;
  connectMawpKPa?: number;
  hydrostaticKPa?: number;
}

export interface ItemCdu {
  class: 'in-rack-rpu' | 'row-l2l' | 'facility';
  ratedKW: number;
  ratedApproachK: number;
  tcsLpmPerKW?: number;
  availableDpKPa?: number;
  parasiticKW?: number;
  pumpRedundancy: string;
  filtrationUm?: number;
  dualFeed?: boolean;
  mgmtProfile?: string;
  ratingBasis: { convention: CduRatingBasis; approachK: number; lpmPerKW?: number; tcsHeadPsi?: number; fwsDpPsi?: number; fwsSupplyC?: number };
}

export interface ItemDoorHx {
  ratedKW: number;
  ratingPoint: { waterC: number; airInC: number; airOutC: number };
  depthMm: number;
  massKg: number;
  coolantDpKPa: number;
  minSupplyC: number;
  active: boolean;
  fanRedundancy?: string;
  aisleOpenMm: number;
}

export interface ItemAccelModule {
  standard: 'oam-1.x' | 'oam-2.0' | 'sxm' | 'pcie-cem' | 'wafer' | 'custom';
  tdpW: number;
  cooling: 'air' | 'liquid' | 'hybrid';
}

export interface ItemBaseboard {
  standard: 'ubb-2.0' | 'ubb-class' | 'none';
  modules: number;
  inputV: 54 | 48;
  opt12VPerModuleW?: number;
  outlineMm?: [number, number];
  maxBoardW?: number;
  chassis?: ('19in' | '21in')[];
}

/** NIC form factors (NIC 3.0 v1.6.0 outlines use neutral `nic3-*` keys; `nic3-lff` is deprecated in that revision). */
export type NicFormFactor = 'pcie-hhhl' | 'pcie-fhhl' | 'nic3-sff' | 'nic3-tsff' | 'nic3-dsff' | 'nic3-tdsff' | 'nic3-lff' | 'mezz' | 'custom';

export type ScaleUpKind = 'nvlink' | 'ualink' | 'esun-ethernet' | 'vendor-proprietary' | 'pcie' | 'none';
