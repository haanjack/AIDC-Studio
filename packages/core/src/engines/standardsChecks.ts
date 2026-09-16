// Stream C (P3) — standards parameter checks: rack (RK), rack power (PW) and network (NW) rules, plus the aggregator that adds the
// liquid rules (cooling.ts CL-*) and the facility pre-check (facilityPrecheck.ts FC-*). OCP-DESIGN-PROPOSAL §5; P0 defaults from the
// proposal's "P0 impacts" box (standards/registry.ts NEUTRAL_REFERENCE_BASIS).
//
// Data flow: every rule reads the hall's effective standards profile (Project default + Hall override) and the DECLARED interfaces of
// the placed catalog items (`formFactor`, `rackPower`, `powerShelf`, `bbu`, `powerRack`, `liquidInterface`, `cdu`, `accelModule`,
// `baseboard`). Rack classification never compares vendor ids: rack form = item.formFactor.rack ?? meta.rackForm (alias) ?? profile.
// A project without a profile gets no standards results; an inferred profile gets its findings as `info` (standardsBasis.capSeverity).
//
// Rules (hand-checkable; limits cite registry ids, values from the proposal §3.1 / §5, P0 closure log):
//   RK-01  Σ occupied units ≤ usable units (Meta ORv3 frame 1.3 / ORW 44 OU; HPR v1 power zone 9 OU = 3 × 1 OU PSU + 3 × 2 OU BBU)
//   RK-02  rack mass ≤ frame rating (Meta 1.3: 1400 kg payload excl. frame, cross brace above 800 kg; ORW 1.0.0: 4700 kg braced;
//          Google impl. 0.2: 816.5 kg total, not for HPR / DLC racks)
//   RK-03  node mass per IT support shelf set ≤ 80 kg (Meta 1.3) / 125 kg (ORW); skipped with own rails
//   PW-01  rack kW ≤ shelves × N+1 rating (HPR v1 27.5 kW, ≤ 93.5 kW for three sets; ORv3 v1 15 kW; HPR V2 60 kW)
//   PW-02  shelf current = shelf kW / full-load V ≤ output connector (HPR v1 700 A; ORv3 360 A still air, 500 A at ≥ 300 LFM; 2000 A)
//   PW-03  parallel shelf sets (HPR v1 ≤ 3) and generation compatibility (HPR V2 shelves need an HPRv3 power-rack busbar)
//   PW-04  busbar roofline (HPR air ≈ 155 kW, roadmap) / rating not specified (ORv3, ORW) → info
//   PW-05  shelf output voltage range within the IT input window (51 V option 46–52 V)
//   PW-06  BBU ride-through ≥ generator acceptance + transfer margin (HPR v1 curve; ORv3 end-of-life 90 s, 240 s beginning-of-life
//          shown as info; sidecar 45 s)
//   PW-07  PSU input current per phase ≤ whip continuous limit (NEC 80 % / IEC 100 %; HPR V2 55.7 A at 230 V, 46.3 A at 277 V)
//   PW-08  Σ sidecar-fed IT kW ≤ power racks × rating at the input voltage (1.1 MW at 480 / 415 V, 718 kW at 400 V; draft)
//   PW-09  sidecar conversion loss (≤ 3 % at 480 V, ≤ 3.5 % at 415 / 400 V) → info
//   PW-10  in-rack BBU covers IT only: CDU pumps without UPS → warning
//   NW-01  scale-out size vs the published pod / cluster architectures (beyond 1,024 xPUs the spine layer is an estimate; two-tier 51.2T
//          ceiling 8,192 xPUs; ≥ ceil(xPUs / 128) spines non-blocking)
//   NW-02  switched scale-up domain ≤ 1,024 accelerators (UALink 200G 1.0); inter-rack scale-up cabling not generated → info
//   NW-03  rails from instance data (railsPerNode); the domain heuristic is flagged as an estimate
//   NW-04  default switch per Ethernet fabric = generic classes (engines/network.ts FABRIC_SWITCH), not a runtime check
import { rackFormFromMeta } from '../catalog/aliases.ts';
import { findCatalogItem } from '../catalog/catalog.ts';
import { findNodeSpec } from '../catalog/seeds/index.ts';
import type { CatalogItem, EquipmentInstance, NetworkAnalysis, Project, Severity } from '../model/types.ts';
import { NEUTRAL_REFERENCE_BASIS } from '../standards/registry.ts';
import type { RackFormKey, RackPowerKey, ShelfClassKey, StandardsProfile } from '../standards/types.ts';
import { IT_LOAD_CATEGORIES, type Ctx, type Placed } from './context.ts';
import { evaluateLiquidChecks } from './cooling.ts';
import { FABRIC_LB_DEFAULT } from './network.ts';
import { evaluateFacilityChecks, type FacilityPrecheckReport } from './facilityPrecheck.ts';
import { fmt, hallProfile, isNecConvention, makeResult, num, phaseVoltage, type ResultInput, resultsToIssues, type StandardsCheckResult } from './standardsBasis.ts';

// ───────────────────────────── basis data ─────────────────────────────

export interface ShelfBasis {
  key: ShelfClassKey;
  /** rating document */
  standardId: string;
  shelfKW: number;
  nPlus1KW: number;
  outputNoLoadV: number;
  outputFullLoadV: number;
  /** lowest output voltage in operation (BBU discharge) for the IT window check */
  outputMinV: number;
  connectorA: number;
  airflowA?: number;
  airflowLFM?: number;
  connectorStandardId: string;
  /** shelf sets that may run in parallel and their stated total (HPR v1) */
  maxSets?: number;
  setsTotalKW?: number;
  /** stated minimum parallel capability (HPR V2) */
  parallelAtLeast?: number;
  psuKW: number;
  psuStandardId: string;
  /** stated PSU input current per phase at a phase voltage (A) */
  psuInputA?: Readonly<Record<number, number>>;
  /** PF × efficiency used for derived input currents */
  psuInputFactor: number;
  whipNecA: number;
  whipIecA: number;
  heightOU: number;
  bbuHeightOU?: number;
  defaultShelves?: number;
  bbu?: { standardId: string; curve?: readonly { kw: number; s: number }[]; eolS?: number; bolS?: number; bolKW?: number };
  /** busbar interface the shelf mounts to */
  busbar: 'orv3-clip' | 'hpr-v1-clip' | 'hprv3-power-rack-bolted';
}

export const SHELF_BASIS: Readonly<Record<ShelfClassKey, ShelfBasis>> = {
  'hpr-33kw': {
    key: 'hpr-33kw', standardId: 'orv3-hpr-shelf-33kw@0.3', shelfKW: 33, nPlus1KW: 27.5, outputNoLoadV: 50, outputFullLoadV: 49, outputMinV: 46,
    connectorA: 700, connectorStandardId: 'orv3-hpr-shelf-33kw@0.3', maxSets: 3, setsTotalKW: 93.5,
    psuKW: 5.5, psuStandardId: 'orv3-hpr-shelf-33kw@0.3', psuInputFactor: 0.975, whipNecA: 30, whipIecA: 32, heightOU: 1, bbuHeightOU: 2, defaultShelves: 3,
    // Finish (QA standards §10 item 3): the class basis uses the 5+0 curve (one of six 5.5 kW modules redundant), the same posture as
    // PW-01's 27.5 kW N+1 and the seeded `bbu-shelf-hpr-33kw` block; the 6+0 curve (24 kW 240 s / 33 kW 90 s) stays item data only.
    bbu: { standardId: 'orv3-hpr-bbu-shelf-33kw@0.5', curve: [{ kw: 20, s: 240 }, { kw: 27.5, s: 90 }] },
    busbar: 'hpr-v1-clip',
  },
  'orv3-18kw': {
    key: 'orv3-18kw', standardId: 'orv3-bbu-shelf@1.1', shelfKW: 18, nPlus1KW: 15, outputNoLoadV: 51, outputFullLoadV: 47.5, outputMinV: 46,
    connectorA: 360, airflowA: 500, airflowLFM: 300, connectorStandardId: 'orv3-output-connector@2.0',
    psuKW: 3, psuStandardId: 'orv3-psu-48v@1.0', psuInputFactor: 0.975, whipNecA: 20, whipIecA: 32, heightOU: 1, bbuHeightOU: 2, defaultShelves: 2,
    bbu: { standardId: 'orv3-bbu-module@1.4', eolS: NEUTRAL_REFERENCE_BASIS.bbu.eolBackupS, bolS: NEUTRAL_REFERENCE_BASIS.bbu.bolBackupS, bolKW: 15 },
    busbar: 'orv3-clip',
  },
  'hpr-v2-72kw': {
    key: 'hpr-v2-72kw', standardId: 'hpr-v2-shelf-72kw@1.0', shelfKW: 72, nPlus1KW: 60, outputNoLoadV: 50, outputFullLoadV: 49, outputMinV: 48.5,
    connectorA: 2000, connectorStandardId: 'hpr-2000a-output-connector@1.0.0', parallelAtLeast: 10,
    psuKW: 12, psuStandardId: 'hpr-v2-psu-12kw@1.0.0', psuInputA: { 230: 55.7, 277: 46.3 }, psuInputFactor: 0.936, whipNecA: 60, whipIecA: 60, heightOU: 1,
    busbar: 'hprv3-power-rack-bolted',
  },
};

/** IT gear input window of the 51 V option (ORv3 Base Rev 1.1). */
export const IT_INPUT_WINDOW_V: readonly [number, number] = [46, 52];
/** HPR busbar air-cooled roofline (roadmap deck, not a rating). */
export const HPR_AIR_BUSBAR_ROOFLINE_KW = 155;
/** Transfer margin added to the generator acceptance time for PW-06 (s, planner estimate). */
export const BBU_TRANSFER_MARGIN_S = 10;
/** ±400 VDC power rack minimum capability by AC input voltage (Diablo 400 0.7.0; 380 V not listed → the 400 V value). */
export const SIDECAR_RATING_KW: Readonly<Record<number, number>> = { 480: 1100, 415: 1100, 400: 718, 380: 718 };
export const SIDECAR_BBU_S = 45;
/** Frame ratings by rack form when the item declares none. */
export const FRAME_BASIS = {
  metaOrv3: { standardId: NEUTRAL_REFERENCE_BASIS.frame.standardId, usableUnits: NEUTRAL_REFERENCE_BASIS.frame.heightUnits, payloadKg: NEUTRAL_REFERENCE_BASIS.frame.payloadKg, excludesFrame: true, braceAboveKg: NEUTRAL_REFERENCE_BASIS.frame.crossBraceAboveKg, itShelfKg: NEUTRAL_REFERENCE_BASIS.frame.itShelfKgPerSet },
  googleOrv3: { standardId: 'orv3-frame-google@0.2', usableUnits: 39, totalMaxKg: 816.5 },
  orw: { standardId: 'orw-meta-design@1.0.0', usableUnits: 44, payloadKg: 4700, excludesFrame: true, braceRequired: true, itShelfKg: 125 },
} as const;

// ───────────────────────────── rack classification (declared data first, never vendor ids) ─────────────────────────────

/** Rack form of an item: declared form factor, legacy `meta.rackForm` via alias, else the profile's form (unless `mixed`). */
export function rackFormOf(item: CatalogItem, profile?: StandardsProfile): RackFormKey | undefined {
  const declared = item.formFactor?.rack ?? rackFormFromMeta(item.meta?.rackForm);
  if (declared) return declared;
  return profile && profile.rackForm !== 'mixed' ? profile.rackForm : undefined;
}

/** Rack power interface of an item: declared `rackPower`, else implied by the declared form, else the profile's. */
export function rackPowerOf(item: CatalogItem, profile?: StandardsProfile): RackPowerKey | undefined {
  const form = item.formFactor?.rack ?? rackFormFromMeta(item.meta?.rackForm);
  const rp = item.rackPower;
  const profBusbar = profile?.rackPower === 'dc-busbar-50v-hpr' || profile?.rackPower === 'dc-busbar-48-54v' ? profile.rackPower : undefined;
  if (rp) {
    if (rp.interface === 'ac-pdu') return 'ac-pdu';
    if (rp.interface === 'hvdc-cable') return 'hvdc-pm400-sidecar';
    if (item.powerShelf?.busbarInterface === 'orv3-clip') return 'dc-busbar-48-54v';
    if (item.powerShelf?.busbarInterface) return 'dc-busbar-50v-hpr';
    if (profBusbar) return profBusbar;
    return form === 'orv3' ? 'dc-busbar-48-54v' : form === 'orv3-hpr' || form === 'orw' ? 'dc-busbar-50v-hpr' : 'vendor-busbar';
  }
  if (form === 'eia-310-19') return 'ac-pdu';
  if (form === 'orv3-mgx') return 'vendor-busbar';
  return profile?.rackPower;
}

/** Shelf class for a busbar rack: declared on the item's shelf interface, else the profile's (when it matches the busbar), else the class default. */
export function shelfClassOf(item: CatalogItem, profile: StandardsProfile | undefined, power: RackPowerKey | undefined): ShelfClassKey | undefined {
  const bi = item.powerShelf?.busbarInterface;
  if (bi === 'hprv3-power-rack-bolted') return 'hpr-v2-72kw';
  if (bi === 'hpr-v1-clip') return 'hpr-33kw';
  if (bi === 'orv3-clip') return 'orv3-18kw';
  if (power === 'dc-busbar-50v-hpr') return profile?.shelfClass === 'hpr-v2-72kw' || profile?.shelfClass === 'hpr-33kw' ? profile.shelfClass : 'hpr-33kw';
  if (power === 'dc-busbar-48-54v') return 'orv3-18kw';
  return undefined;
}

/** Shelf basis with the item's declared shelf values applied over the class values. */
export function shelfBasisFor(item: CatalogItem, key: ShelfClassKey): ShelfBasis {
  const b = SHELF_BASIS[key];
  const s = item.powerShelf;
  if (!s) return b;
  return {
    ...b,
    shelfKW: s.shelfKW, nPlus1KW: s.ratedKWAtRedundancy, outputNoLoadV: s.outputV[0], outputFullLoadV: s.outputV[1], connectorA: s.outputConnector.stillAirA,
    airflowA: s.outputConnector.airflowA ?? b.airflowA, airflowLFM: s.outputConnector.airflowLFM ?? b.airflowLFM, psuKW: s.psuKW, heightOU: s.heightOU,
    ...(s.parallelMax !== undefined ? { maxSets: s.parallelMax } : {}),
  };
}

/** Power shelves in the rack: instance `meta.powerShelves` → item `meta.powerShelves` (number or composed `{ count }`) → item `meta.shelfSets` /
 *  `meta.powerShelfCount` → class default → sized from the load (HPR V2). */
export function shelvesInRack(e: EquipmentInstance, item: CatalogItem, b: ShelfBasis): { n: number; declared: boolean } {
  const composed = item.meta?.powerShelves as { count?: unknown } | undefined;
  const d = num(e.meta?.powerShelves) ?? num(item.meta?.powerShelves) ?? num(composed?.count) ?? num(item.meta?.shelfSets) ?? num(item.meta?.powerShelfCount);
  if (d !== undefined && d > 0) return { n: Math.round(d), declared: true };
  if (b.defaultShelves) return { n: b.defaultShelves, declared: false };
  return { n: Math.max(1, Math.ceil((item.power?.nameplateKW ?? 0) / b.nPlus1KW - 1e-9) + 1), declared: false };
}

/** BBU backup seconds of the HPR v1 shelf curve at `kwPerShelf` (linear between the stated points; beyond the top point = 0). */
export function interpBackupS(curve: readonly { kw: number; s: number }[], kwPerShelf: number): number {
  const pts = [...curve].sort((a, b) => a.kw - b.kw);
  if (!pts.length) return 0;
  if (kwPerShelf <= pts[0].kw + 1e-9) return pts[0].s;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const c = pts[i];
    if (kwPerShelf <= c.kw + 1e-9) return a.s + ((kwPerShelf - a.kw) * (c.s - a.s)) / (c.kw - a.kw);
  }
  return 0;
}

/** Frame ratings of a rack (declared form factor first, else by rack form). */
export function frameRatingOf(item: CatalogItem, form: RackFormKey | undefined): { standardId: string; usableUnits?: number; payloadKg?: number; excludesFrame?: boolean; braceAboveKg?: number; braceRequired?: boolean; totalMaxKg?: number; itShelfKg?: number; declared: boolean } | undefined {
  const ff = item.formFactor;
  if (ff?.implementation === FRAME_BASIS.googleOrv3.standardId) return { ...FRAME_BASIS.googleOrv3, usableUnits: ff.usableUnits ?? FRAME_BASIS.googleOrv3.usableUnits, declared: true };
  if (ff && (ff.payloadKg !== undefined || ff.itShelfKgPerSet !== undefined)) {
    const byForm = form === 'orw' ? FRAME_BASIS.orw : form === 'orv3' || form === 'orv3-hpr' ? FRAME_BASIS.metaOrv3 : undefined;
    return {
      standardId: ff.implementation ?? byForm?.standardId ?? 'orv3-base@1.1',
      usableUnits: ff.usableUnits ?? ff.heightUnits,
      payloadKg: ff.payloadKg,
      excludesFrame: ff.payloadExcludesFrame,
      braceAboveKg: ff.crossBraceAboveKg,
      braceRequired: form === 'orw' && ff.crossBraceAboveKg === undefined,
      itShelfKg: ff.itShelfKgPerSet,
      declared: true,
    };
  }
  if (form === 'orv3' || form === 'orv3-hpr') return { ...FRAME_BASIS.metaOrv3, usableUnits: ff?.usableUnits ?? ff?.heightUnits ?? FRAME_BASIS.metaOrv3.usableUnits, declared: false };
  if (form === 'orw') return { ...FRAME_BASIS.orw, usableUnits: ff?.usableUnits ?? ff?.heightUnits ?? FRAME_BASIS.orw.usableUnits, declared: false };
  return undefined;
}

/** Node mass (kg) from item data: `meta.nodeMassKg`, `meta.node.{massKg|weightKg}`, or the composer's node spec id (`meta.node`). */
export function nodeMassOf(item: CatalogItem): number | undefined {
  const node = item.meta?.node;
  if (typeof node === 'string') return num(item.meta?.nodeMassKg) ?? findNodeSpec(node)?.weightKg;
  const o = node as { massKg?: unknown; weightKg?: unknown } | undefined;
  return num(item.meta?.nodeMassKg) ?? num(o?.massKg) ?? num(o?.weightKg);
}

/** Frame (enclosure) mass of a rack item: `meta.frameMassKg`, else the composer's rack model (`meta.rackModel`) catalog mass. */
export function frameMassOf(item: CatalogItem): number | undefined {
  const declared = num(item.meta?.frameMassKg);
  if (declared !== undefined) return declared;
  const rackModel = item.meta?.rackModel;
  return typeof rackModel === 'string' && rackModel !== item.id ? findCatalogItem(rackModel)?.weightKg : undefined;
}

// ───────────────────────────── RK / PW ─────────────────────────────

interface Group {
  key: string;
  racks: Placed[];
}

function groupRacks(items: readonly Placed[]): Group[] {
  const m = new Map<string, Placed[]>();
  for (const p of items) {
    if (!IT_LOAD_CATEGORIES.has(p.item.category)) continue;
    const meta = p.e.meta ?? {};
    const key = `${p.item.id}|${meta.powerShelves ?? ''}|${meta.crossBrace ?? ''}|${meta.ownRails ?? ''}|${meta.supportShelfSets ?? ''}`;
    m.set(key, [...(m.get(key) ?? []), p]);
  }
  return [...m].map(([key, racks]) => ({ key, racks }));
}

const tagList = (g: readonly Placed[]) => `${g.slice(0, 3).map((x) => x.e.tag).join(', ')}${g.length > 3 ? ` +${g.length - 3}` : ''}`;
const safeId = (s: string) => s.replace(/[^A-Za-z0-9_.:-]+/g, '-');

/** RK-01 … RK-03 and PW-01 … PW-10 for every hall with a profile. Pure. */
export function evaluateRackPowerChecks(ctx: Ctx): StandardsCheckResult[] {
  const { project } = ctx;
  const out: StandardsCheckResult[] = [];
  let pw10Done = false;
  for (const hall of project.halls) {
    const profile = hallProfile(project, hall);
    if (!profile) continue;
    const confirmed = profile.inferred !== true;
    const items = ctx.byHall.get(hall.id) ?? [];
    const add = (r: Omit<ResultInput, 'hallId' | 'domain' | 'family'> & { domain?: ResultInput['domain']; family?: ResultInput['family'] }) =>
      out.push(makeResult(profile, { domain: 'power', family: 'power', hallId: hall.id, ...r }));
    const sidecar: Placed[] = [];
    let busbarInfoDone = false;

    for (const g of groupRacks(items)) {
      const p = g.racks[0];
      const item = p.item;
      const e = p.e;
      const gid = safeId(`${hall.id}-${g.key}`);
      const refs = [hall.id, ...g.racks.slice(0, 6).map((x) => x.e.id)];
      const tag = `${item.name} (${tagList(g.racks)})`;
      const kw = item.power?.nameplateKW ?? 0;
      const form = rackFormOf(item, profile);
      const power = rackPowerOf(item, profile);
      const estimate = item.source === 'estimate';
      if (power === 'hvdc-pm400-sidecar') sidecar.push(...g.racks);
      const frame = frameRatingOf(item, form);

      // ── RK-01 units ──
      const umap = Array.isArray(item.meta?.umap) ? (item.meta!.umap as { units?: number; kind?: string }[]) : undefined;
      const nodes = item.compute?.nodesPerRack;
      const nodeU = item.formFactor?.nodeHeightUnits;
      const shelfKey = power === 'dc-busbar-50v-hpr' || power === 'dc-busbar-48-54v' ? shelfClassOf(item, profile, power) : undefined;
      const shelf = shelfKey ? shelfBasisFor(item, shelfKey) : undefined;
      const shelves = shelf ? shelvesInRack(e, item, shelf) : undefined;
      if (frame?.usableUnits !== undefined && (umap?.length || (nodes && nodeU))) {
        let occupied: number;
        let zone = 0;
        let parts: string;
        let zoneStd: string | undefined;
        if (umap?.length) {
          occupied = umap.filter((u) => u.kind !== 'blank' && u.kind !== 'free').reduce((s, u) => s + Math.max(1, num(u.units) ?? 1), 0);
          parts = 'U-map';
        } else {
          if (shelf && shelves) {
            const bbuIn = profile.bbu === 'in-rack' || !!item.bbu || num((item.meta?.bbuShelves as { count?: unknown } | undefined)?.count) !== undefined;
            zone = num(item.meta?.powerZoneUnits) ?? (shelfKey === 'hpr-33kw' && !item.powerShelf && shelves.n === 3 && bbuIn ? NEUTRAL_REFERENCE_BASIS.hprPowerZoneUnits : shelves.n * shelf.heightOU + (bbuIn ? shelves.n * (shelf.bbuHeightOU ?? 0) : 0));
            zoneStd = shelf.standardId;
          }
          const tor = num(item.meta?.torUnits) ?? 0;
          occupied = nodes! * nodeU! + zone + tor;
          parts = `${nodes} × ${nodeU} + ${zone}${tor ? ` + ${tor}` : ''}`;
        }
        const f = occupied > frame.usableUnits + 1e-9;
        add({
          id: `std-rk01-${gid}`, ruleId: 'RK-01', family: 'rack', domain: 'space', status: f ? 'finding' : 'pass', naturalSeverity: 'error', refs,
          designValue: occupied, limit: frame.usableUnits, unit: form === 'eia-310-19' ? 'U' : 'OU', basis: estimate ? 'estimate' : 'standard', standardId: zone > 0 && zoneStd ? zoneStd : frame.standardId, verification: zone > 0 ? 'derived' : 'verified',
          ko: `${tag}: 사용 유닛 ${fmt(occupied)} (${parts}) / 가용 ${frame.usableUnits}.${zone > 0 ? ` 전원 구역 ${zone} OU 포함.` : ''}`,
          en: `${tag}: occupied units ${fmt(occupied)} (${parts}) vs usable ${frame.usableUnits}.${zone > 0 ? ` Includes a ${zone} OU power zone.` : ''}`,
          ...(f ? { suggestion: '랙당 노드 수를 줄이거나 노드 높이를 확인하세요.', suggestionEn: 'Reduce nodes per rack or confirm the node height.' } : {}),
        });
      } else if (confirmed && frame && nodes && !nodeU && item.category === 'gpu-rack' && !umap?.length) {
        add({ id: `std-rk01-${gid}`, ruleId: 'RK-01', family: 'rack', domain: 'space', status: 'not-modelled', naturalSeverity: 'info', refs, basis: 'standard', standardId: frame.standardId, verification: 'unverified',
          ko: `${tag}: 노드 높이가 선언되지 않아 유닛 점검을 하지 않았습니다(최대 ${NEUTRAL_REFERENCE_BASIS.dlcNode.maxHeightUnits} OU 권장).`, en: `${tag}: node height not declared; unit budget not checked (≤ ${NEUTRAL_REFERENCE_BASIS.dlcNode.maxHeightUnits} OU recommended).` });
      }

      // ── RK-02 mass ──
      if (frame) {
        const braced = e.meta?.crossBrace === true || item.meta?.crossBrace === true;
        const frameMass = frameMassOf(item);
        const mass = (item.weightKg ?? 0) - (frame.excludesFrame ? (frameMass ?? 0) : 0);
        const massNote = frame.excludesFrame && frameMass === undefined ? { ko: ' 프레임 질량이 없어 랙 총질량으로 비교(보수적).', en: ' Frame mass not modelled; the rack total is compared (conservative).' } : { ko: '', en: '' };
        if (frame.totalMaxKg !== undefined) {
          const f = mass > frame.totalMaxKg + 1e-9;
          add({ id: `std-rk02-${gid}`, ruleId: 'RK-02', family: 'rack', domain: 'space', status: f ? 'finding' : 'pass', naturalSeverity: 'error', refs, designValue: Math.round(mass), limit: frame.totalMaxKg, unit: 'kg', basis: estimate ? 'estimate' : 'standard', standardId: frame.standardId, verification: 'verified',
            ko: `${tag}: 랙 총질량 ${fmt(mass, 0)} kg / 프레임 최대 총중량 ${fmt(frame.totalMaxKg)} kg${form === 'orv3-hpr' ? ' (이 등급은 고전력 액체냉각 랙에 적용하지 않습니다)' : ''}.`,
            en: `${tag}: rack total ${fmt(mass, 0)} kg vs frame maximum total ${fmt(frame.totalMaxKg)} kg${form === 'orv3-hpr' ? ' (this rating does not apply to high-power liquid-cooled racks)' : ''}.` });
        } else if (frame.payloadKg !== undefined) {
          const over = mass > frame.payloadKg + 1e-9;
          const braceNeeded = !braced && ((frame.braceAboveKg !== undefined && mass > frame.braceAboveKg + 1e-9) || frame.braceRequired === true);
          const status = over || braceNeeded ? 'finding' : 'pass';
          const natural: Severity = over ? 'error' : 'warning';
          add({
            id: `std-rk02-${gid}`, ruleId: 'RK-02', family: 'rack', domain: 'space', status, naturalSeverity: natural, refs,
            designValue: Math.round(mass), limit: over || !braceNeeded || frame.braceRequired ? frame.payloadKg : frame.braceAboveKg, unit: 'kg', basis: estimate ? 'estimate' : 'standard', standardId: frame.standardId, verification: frameMass === undefined && frame.excludesFrame ? 'derived' : 'verified',
            ko: `${tag}: 탑재 질량 ${fmt(mass, 0)} kg / 프레임 탑재 한도 ${fmt(frame.payloadKg)} kg${frame.excludesFrame ? '(프레임 제외)' : ''}.${braceNeeded ? (frame.braceRequired ? ' 이 한도는 보강재 설치를 전제로 하며 보강재가 모델에 없습니다.' : ` ${fmt(frame.braceAboveKg!)} kg 초과 구성은 교차 보강재가 필요하지만 모델에 없습니다.`) : ''}${massNote.ko}`,
            en: `${tag}: payload ${fmt(mass, 0)} kg vs frame payload rating ${fmt(frame.payloadKg)} kg${frame.excludesFrame ? ' (excluding the frame)' : ''}.${braceNeeded ? (frame.braceRequired ? ' The rating assumes support bracing, which is not modelled.' : ` Configurations above ${fmt(frame.braceAboveKg!)} kg need a cross brace, which is not modelled.`) : ''}${massNote.en}`,
            ...(braceNeeded && !over ? { suggestion: '랙 인스턴스에 교차 보강재(meta.crossBrace)를 모델링하세요.', suggestionEn: 'Model the cross brace on the rack (meta.crossBrace).' } : {}),
          });
        }
        // ── RK-03 IT support shelf per set ──
        const nm = nodeMassOf(item);
        const ownRails = item.formFactor?.ownRails === true || e.meta?.ownRails === true;
        if (nm !== undefined && frame.itShelfKg !== undefined) {
          const sets = Math.max(1, num(e.meta?.supportShelfSets) ?? num(item.meta?.supportShelfSetsPerNode) ?? 1);
          const perSet = nm / sets;
          const f = !ownRails && perSet > frame.itShelfKg + 1e-9;
          add({ id: `std-rk03-${gid}`, ruleId: 'RK-03', family: 'rack', domain: 'space', status: ownRails ? 'pass' : f ? 'finding' : 'pass', naturalSeverity: 'warning', refs, designValue: Math.round(perSet), limit: frame.itShelfKg, unit: 'kg', basis: estimate ? 'estimate' : 'standard', standardId: frame.standardId, verification: 'verified',
            ko: `${tag}: 노드 ${fmt(nm, 0)} kg · 선반 세트 ${sets}개 → 세트당 ${fmt(perSet, 0)} kg / 한도 ${frame.itShelfKg} kg${ownRails ? ' (자체 레일, 적용 제외)' : ''}.`,
            en: `${tag}: node ${fmt(nm, 0)} kg on ${sets} support shelf set${sets === 1 ? '' : 's'} → ${fmt(perSet, 0)} kg per set vs ${frame.itShelfKg} kg${ownRails ? ' (own rails; not applicable)' : ''}.`,
            ...(f ? { suggestion: '노드에 자체 레일을 선언하거나(formFactor.ownRails) 선반 세트를 추가하세요.', suggestionEn: 'Declare own rails for the node (formFactor.ownRails) or add support shelf sets.' } : {}) });
        }
      }

      if (!(kw > 0)) continue;

      // ── PW-04 (info) busbar rating not specified: ORv3 base / ORW ──
      if ((power === 'dc-busbar-48-54v' || (power === 'dc-busbar-50v-hpr' && form === 'orw')) && !busbarInfoDone && confirmed) {
        busbarInfoDone = true;
        const std = form === 'orw' ? 'orw-base@1.0.0' : 'orv3-base@1.1';
        add({ id: `std-pw04-rating-${hall.id}`, ruleId: 'PW-04', status: 'finding', naturalSeverity: 'info', refs: [hall.id], basis: 'standard', standardId: std, verification: 'verified',
          ko: `${hall.name}: 버스바 전류 정격은 기본 사양에 정해져 있지 않습니다. 랙 공급사의 정격을 확인하세요.`, en: `${hall.name}: the busbar current rating is not specified in the base specification; confirm the rack vendor's rating.` });
      }
      if (!shelf || !shelves || !shelfKey) continue;

      // ── PW-01 shelf capacity ──
      const n = shelfKey === 'hpr-33kw' ? Math.min(shelves.n, shelf.maxSets ?? shelves.n) : shelves.n;
      const n1 = n * shelf.nPlus1KW;
      const total = shelf.setsTotalKW !== undefined && n >= (shelf.maxSets ?? Infinity) ? Math.min(shelf.setsTotalKW, n * shelf.shelfKW) : n * shelf.shelfKW;
      const limN1 = shelf.setsTotalKW !== undefined ? Math.min(n1, shelf.setsTotalKW) : n1;
      const overTotal = kw > total + 1e-9;
      const overN1 = kw > limN1 + 1e-9;
      const v2Hint = shelfKey === 'hpr-33kw' && overTotal;
      add({
        id: `std-pw01-${gid}`, ruleId: 'PW-01', status: overTotal || overN1 ? 'finding' : 'pass', naturalSeverity: overTotal ? 'error' : 'warning', refs,
        designValue: kw, limit: overTotal ? total : limN1, unit: 'kW', basis: shelves.declared ? 'standard' : 'estimate', standardId: shelf.standardId, verification: shelfKey === 'hpr-v2-72kw' ? 'derived' : 'verified',
        ko: `${tag}: 랙 ${fmt(kw)} kW / 전원 셸프 ${n}대의 N+1 용량 ${fmt(limN1)} kW (최대 ${fmt(total)} kW)${shelves.declared ? '' : ', 셸프 수 기본값'}.${v2Hint ? ' HPR v1 셸프 세트 한도를 넘습니다. HPRv3 파워랙의 HPR V2 72 kW 셸프(검토 중) 또는 ±400 VDC 파워랙이 필요합니다.' : ''}`,
        en: `${tag}: rack ${fmt(kw)} kW vs N+1 capacity ${fmt(limN1)} kW of ${n} power shelves (${fmt(total)} kW maximum)${shelves.declared ? '' : ', default shelf count'}.${v2Hint ? ' Beyond the HPR v1 shelf sets: needs HPR V2 72 kW shelves in an HPRv3 power rack (under review) or a ±400 VDC power rack.' : ''}`,
        ...(overN1 && !overTotal ? { suggestion: '랙 kW를 N+1 용량 이하로 낮추거나 셸프를 추가하세요.', suggestionEn: 'Lower the rack kW to the N+1 capacity or add shelves.' } : {}),
      });

      // ── PW-02 output connector ──
      const amps = (shelf.shelfKW * 1000) / shelf.outputFullLoadV;
      const lfm = hall.facility?.shelfAirflowLFM;
      const airflowOk = shelf.airflowA !== undefined && shelf.airflowLFM !== undefined && lfm !== undefined && lfm + 1e-9 >= shelf.airflowLFM;
      const connA = airflowOk ? shelf.airflowA! : shelf.connectorA;
      const f2 = amps > connA + 1e-9;
      add({
        id: `std-pw02-${gid}`, ruleId: 'PW-02', status: f2 ? 'finding' : 'pass', naturalSeverity: 'warning', refs, designValue: Math.round(amps * 10) / 10, limit: connA, unit: 'A', basis: 'standard', standardId: shelf.connectorStandardId, verification: 'derived',
        ko: `${tag}: 셸프 출력 ${fmt(shelf.shelfKW)} kW / ${fmt(shelf.outputFullLoadV)} V = ${fmt(amps)} A / 출력 커넥터 ${fmt(connA)} A${airflowOk ? ` (${fmt(lfm)} LFM 풍량)` : shelf.airflowA ? ' (정지 공기)' : ''}.`,
        en: `${tag}: shelf output ${fmt(shelf.shelfKW)} kW / ${fmt(shelf.outputFullLoadV)} V = ${fmt(amps)} A vs output connector ${fmt(connA)} A${airflowOk ? ` (at ${fmt(lfm)} LFM)` : shelf.airflowA ? ' (still air)' : ''}.`,
        ...(f2 && shelf.airflowA ? { suggestion: `셸프 풍량 ≥ ${shelf.airflowLFM} LFM을 모델링하면(홀 시설 입력) ${shelf.airflowA} A 정격이 적용됩니다.`, suggestionEn: `Model shelf airflow of at least ${shelf.airflowLFM} LFM (hall facility inputs) to use the ${shelf.airflowA} A rating.` } : {}),
      });

      // ── PW-03 parallel sets / generation compatibility ──
      if (shelf.maxSets !== undefined && shelves.n > shelf.maxSets)
        add({ id: `std-pw03-${gid}`, ruleId: 'PW-03', status: 'finding', naturalSeverity: 'error', refs, designValue: shelves.n, limit: shelf.maxSets, unit: 'sets', basis: 'standard', standardId: shelf.standardId, verification: 'verified',
          ko: `${tag}: 병렬 셸프 세트 ${shelves.n}개 / 최대 ${shelf.maxSets}개(합계 ${fmt(shelf.setsTotalKW)} kW).`, en: `${tag}: ${shelves.n} parallel shelf sets vs a maximum of ${shelf.maxSets} (${fmt(shelf.setsTotalKW)} kW total).` });
      if (shelfKey === 'hpr-v2-72kw' && item.powerShelf?.busbarInterface !== 'hprv3-power-rack-bolted')
        add({ id: `std-pw03-gen-${gid}`, ruleId: 'PW-03', status: 'finding', naturalSeverity: 'warning', refs, basis: 'standard', standardId: 'hpr-2000a-output-connector@1.0.0', verification: 'verified',
          ko: `${tag}: HPR V2 72 kW 셸프는 HPRv3 파워랙 수직 버스바(2000 A 볼트 체결)용이며 HPR v1 IT 랙 버스바(700 A 클립)에 바로 꽂을 수 없습니다.${profile.includeDraftSpecs ? '' : ' 이 셸프는 "초안 포함" 설정 뒤에 있습니다.'}`,
          en: `${tag}: HPR V2 72 kW shelves mount on an HPRv3 power-rack vertical busbar (2000 A bolted), not on the HPR v1 IT-rack busbar (700 A clip).${profile.includeDraftSpecs ? '' : ' This shelf is behind the "include draft specs" setting.'}` });

      // ── PW-04 HPR air-cooled busbar roofline (roadmap) ──
      if (power === 'dc-busbar-50v-hpr' && kw > HPR_AIR_BUSBAR_ROOFLINE_KW + 1e-9)
        add({ id: `std-pw04-${gid}`, ruleId: 'PW-04', status: 'finding', naturalSeverity: 'warning', refs, designValue: kw, limit: HPR_AIR_BUSBAR_ROOFLINE_KW, unit: 'kW', basis: 'estimate', verification: 'unverified',
          ko: `${tag}: 랙 ${fmt(kw)} kW가 공랭 HPR 버스바의 로드맵 한계 약 ${HPR_AIR_BUSBAR_ROOFLINE_KW} kW를 넘습니다(정격 아님).`, en: `${tag}: rack ${fmt(kw)} kW is above the roadmap roofline of the air-cooled HPR busbar, about ${HPR_AIR_BUSBAR_ROOFLINE_KW} kW (not a rating).` });

      // ── PW-05 voltage window ──
      const win = item.rackPower?.rangeV ?? IT_INPUT_WINDOW_V;
      const lo = Math.min(shelf.outputMinV, shelf.outputFullLoadV);
      const hi = shelf.outputNoLoadV;
      const f5 = lo < win[0] - 1e-9 || hi > win[1] + 1e-9;
      add({ id: `std-pw05-${gid}`, ruleId: 'PW-05', status: f5 ? 'finding' : 'pass', naturalSeverity: 'error', refs, designValue: f5 ? (hi > win[1] ? hi : lo) : hi, limit: hi > win[1] ? win[1] : win[0], unit: 'V', basis: 'standard', standardId: 'orv3-base@1.1', verification: 'verified',
        ko: `${tag}: 셸프 출력 ${fmt(lo)}–${fmt(hi)} V / IT 입력 범위 ${fmt(win[0])}–${fmt(win[1])} V.`, en: `${tag}: shelf output ${fmt(lo)}–${fmt(hi)} V vs IT input window ${fmt(win[0])}–${fmt(win[1])} V.` });

      // ── PW-06 BBU ride-through ──
      const bbuIn = profile.bbu === 'in-rack' || !!item.bbu;
      if (bbuIn) {
        const gen = hall.facility?.generatorAcceptanceS;
        let backup: number | undefined;
        let bbuStd = shelf.bbu?.standardId;
        let note = { ko: '', en: '' };
        const perShelf = kw / Math.max(1, n);
        if (item.bbu) {
          backup = item.bbu.eolBackupS ?? interpBackupS(item.bbu.backupCurve.map((c) => ({ kw: c.kw, s: c.seconds })), perShelf);
          if (item.bbu.bolBackupS) note = { ko: ` (수명 초기 ${item.bbu.bolBackupS} s는 참고)`, en: ` (beginning of life ${item.bbu.bolBackupS} s, info)` };
        } else if (shelf.bbu?.curve) backup = interpBackupS(shelf.bbu.curve, perShelf);
        else if (shelf.bbu?.eolS !== undefined) {
          backup = perShelf <= shelf.shelfKW + 1e-9 ? shelf.bbu.eolS : 0;
          note = { ko: ` (수명 말 기준. 수명 초기 ${shelf.bbu.bolS} s @ ${shelf.bbu.bolKW} kW는 참고)`, en: ` (end-of-life value; beginning of life ${shelf.bbu.bolS} s at ${shelf.bbu.bolKW} kW shown for information)` };
        } else bbuStd = undefined;
        if (gen === undefined || backup === undefined) {
          add({ id: `std-pw06-${gid}`, ruleId: 'PW-06', status: 'not-modelled', naturalSeverity: 'info', refs, basis: 'standard', standardId: bbuStd, verification: 'unverified',
            ko: `${tag}: ${gen === undefined ? '발전기 부하 수용 시간이 홀 시설 입력에 없어' : 'BBU 백업 곡선이 없어'} BBU 유지 시간을 점검하지 않았습니다.`, en: `${tag}: BBU ride-through not checked — ${gen === undefined ? 'no generator acceptance time in the hall facility inputs' : 'no BBU backup curve'}.` });
        } else {
          const need = gen + BBU_TRANSFER_MARGIN_S;
          const f6 = backup + 1e-9 < need;
          add({ id: `std-pw06-${gid}`, ruleId: 'PW-06', status: f6 ? 'finding' : 'pass', naturalSeverity: 'error', refs, designValue: Math.round(backup), limit: need, unit: 's', basis: 'standard', standardId: bbuStd, verification: shelf.bbu?.curve ? 'derived' : 'verified',
            ko: `${tag}: BBU 유지 ${fmt(backup, 0)} s (셸프당 ${fmt(perShelf)} kW)${note.ko} / 발전기 수용 ${fmt(gen, 0)} s + 전환 여유 ${BBU_TRANSFER_MARGIN_S} s(추정) = ${fmt(need, 0)} s.`,
            en: `${tag}: BBU ride-through ${fmt(backup, 0)} s (${fmt(perShelf)} kW per shelf)${note.en} vs generator acceptance ${fmt(gen, 0)} s + transfer margin ${BBU_TRANSFER_MARGIN_S} s (estimate) = ${fmt(need, 0)} s.` });
        }
      }

      // ── PW-07 PSU input current per phase vs whip continuous limit ──
      const V = phaseVoltage(project.power.distributionVoltageV);
      const nec = isNecConvention(project.power.deratingFactor);
      const stated = shelf.psuInputA?.[V];
      const inputA = stated ?? (shelf.psuKW * 1000) / (V * shelf.psuInputFactor);
      const limA = nec ? shelf.whipNecA * 0.8 : shelf.whipIecA;
      const f7 = inputA > limA + 1e-9;
      add({ id: `std-pw07-${gid}`, ruleId: 'PW-07', status: f7 ? 'finding' : 'pass', naturalSeverity: 'warning', refs, designValue: Math.round(inputA * 10) / 10, limit: limA, unit: 'A', basis: 'standard', standardId: shelf.psuStandardId, verification: stated !== undefined ? 'verified' : 'derived',
        ko: `${tag}: PSU ${fmt(shelf.psuKW)} kW 상당 입력 전류 ${fmt(inputA)} A @ ${V} V / 연속 한도 ${fmt(limA)} A (${nec ? `NEC ${shelf.whipNecA} A × 80 %` : `IEC ${shelf.whipIecA} A`}).`,
        en: `${tag}: PSU ${fmt(shelf.psuKW)} kW input ${fmt(inputA)} A per phase at ${V} V vs continuous limit ${fmt(limA)} A (${nec ? `NEC ${shelf.whipNecA} A × 80 %` : `IEC ${shelf.whipIecA} A`}).`,
        ...(f7 ? { suggestion: '상전압을 높이거나(예: 277 V) IEC 100 % 정격 회로를 쓰세요.', suggestionEn: 'Use a higher phase voltage (e.g. 277 V) or IEC circuits rated for 100 % continuous load.' } : {}) });

      // ── PW-10 in-rack BBU and mechanical loads ──
      if (!pw10Done && bbuIn && confirmed && !project.power.mechanicalOnUps && ctx.placed.some((x) => x.item.category === 'cdu')) {
        pw10Done = true;
        add({ id: 'std-pw10', ruleId: 'PW-10', status: 'finding', naturalSeverity: 'warning', refs: [hall.id], basis: 'estimate', verification: 'estimate',
          ko: '랙 BBU는 IT 부하만 유지합니다. CDU 펌프가 UPS에 연결되어 있지 않아 발전기 전환 동안 액체 냉각이 멈출 수 있습니다.', en: 'In-rack BBUs carry the IT load only; CDU pumps are not UPS-backed, so liquid cooling can stop during the generator transfer.',
          suggestion: '전력 설계에서 기계 부하 UPS 연결(mechanicalOnUps)을 켜세요.', suggestionEn: 'Enable UPS support for mechanical loads (mechanicalOnUps) in the power design.' });
      }
    }

    // ── PW-08 / PW-09 ±400 VDC power racks ──
    if (sidecar.length) {
      const totalKW = sidecar.reduce((s, p) => s + (p.item.power?.nameplateKW ?? 0), 0);
      const powerRacks = items.filter((p) => !!p.item.powerRack);
      const V = project.power.distributionVoltageV;
      const rating = powerRacks[0]?.item.powerRack?.ratingKWByInputV[V] ?? SIDECAR_RATING_KW[V] ?? SIDECAR_RATING_KW[400];
      const linkKW = powerRacks[0]?.item.powerRack?.linkKW ?? 100;
      const links = sidecar.reduce((s, p) => s + Math.ceil((p.item.power?.nameplateKW ?? 0) / linkKW - 1e-9), 0);
      const cap = powerRacks.length * rating;
      const need = Math.ceil(totalKW / rating - 1e-9);
      const f8 = totalKW > cap + 1e-9;
      add({ id: `std-pw08-${hall.id}`, ruleId: 'PW-08', status: f8 ? 'finding' : 'pass', naturalSeverity: powerRacks.length ? 'error' : 'warning', refs: [hall.id, ...powerRacks.slice(0, 4).map((p) => p.e.id)], designValue: Math.round(totalKW), limit: cap, unit: 'kW', basis: 'standard', standardId: 'diablo400@0.7.0', verification: 'verified',
        ko: `${hall.name}: ±400 VDC 급전 IT ${fmt(totalKW, 0)} kW / 파워랙 ${powerRacks.length}대 × ${fmt(rating, 0)} kW @ ${V} V = ${fmt(cap, 0)} kW (필요 ${need}대, 링크 ${links}개 × ${linkKW} kW).`,
        en: `${hall.name}: ±400 VDC fed IT ${fmt(totalKW, 0)} kW vs ${powerRacks.length} power rack${powerRacks.length === 1 ? '' : 's'} × ${fmt(rating, 0)} kW at ${V} V = ${fmt(cap, 0)} kW (${need} needed; ${links} links × ${linkKW} kW).` });
      const eff = V === 480 ? 0.97 : 0.965;
      add({ id: `std-pw09-${hall.id}`, ruleId: 'PW-09', status: 'finding', naturalSeverity: 'info', refs: [hall.id], designValue: Math.round(totalKW * (1 - eff)), unit: 'kW', basis: 'standard', standardId: 'diablo400@0.7.0', verification: 'derived',
        ko: `${hall.name}: 파워랙 변환 손실 약 ${fmt(totalKW * (1 - eff), 0)} kW (100 % 부하 효율 ${fmt(eff * 100)} % 이상 기준, PUE에는 아직 반영하지 않음).`, en: `${hall.name}: power-rack conversion loss about ${fmt(totalKW * (1 - eff), 0)} kW (at > ${fmt(eff * 100)} % efficiency at 100 % load; not yet added to PUE).` });
    }
  }
  return out;
}

// ───────────────────────────── NW ─────────────────────────────

/** Published pod / cluster sizes: pod = 128 xPUs, cluster = 8 pods = 1,024 xPUs; 51.2T spine = 128 × 400G ports. */
export const NW_BASIS = { podXpus: 128, clusterXpus: 1024, spinePorts400G: 128, twoTierCeiling: 8192, railLeavesPerPod: 4, closLeavesPerPod: 2, ualinkDomainMax: 1024 } as const;

/** Non-blocking two-tier 51.2T spines for `xpus` single-400G-link endpoints (even split). */
export function twoTierSpinesFor(xpus: number): { min: number; even: number } {
  const min = Math.ceil(xpus / NW_BASIS.spinePorts400G - 1e-9);
  return { min, even: min % 2 === 0 ? min : min + 1 };
}

export function evaluateNetworkChecks(ctx: Ctx, network?: NetworkAnalysis): StandardsCheckResult[] {
  const { project } = ctx;
  const out: StandardsCheckResult[] = [];
  const gpuHall = project.halls.find((h) => (ctx.byHall.get(h.id) ?? []).some((p) => p.item.category === 'gpu-rack'));
  const profile = gpuHall ? hallProfile(project, gpuHall) : undefined;
  if (!profile) return out;
  const confirmed = profile.inferred !== true;
  const add = (r: Omit<ResultInput, 'domain' | 'family'>) => out.push(makeResult(profile, { domain: 'network', family: 'network', ...r }));

  // NW-01
  const so = network?.fabrics.find((f) => f.name.startsWith('Scale-out'));
  // Ethernet-class scale-out: not InfiniBand and not a scheduled-cell (DDC) fabric — classified by the load-balancing class, not a vendor key
  const ethernet = !!so && !so.fabric.startsWith('ib-') && FABRIC_LB_DEFAULT[so.fabric] !== 'ddc';
  const xpus = ctx.gpus;
  if (so && ethernet && xpus > NW_BASIS.clusterXpus) {
    const sp = twoTierSpinesFor(xpus);
    const spines = so.tiers.find((t) => t.name.toLowerCase().startsWith('spine'))?.switches ?? 0;
    add({ id: 'std-nw01-cluster', ruleId: 'NW-01', status: 'finding', naturalSeverity: 'info', refs: [], designValue: xpus, limit: NW_BASIS.clusterXpus, unit: 'xPU', basis: 'standard', standardId: 'xoc-n@1.0', verification: 'derived',
      ko: `가속기 ${fmt(xpus, 0)}개가 공개 클러스터 구성(${fmt(NW_BASIS.clusterXpus, 0)}개)을 넘어 스파인 계층은 추정입니다. 51.2T 2계층 논블로킹에는 스파인 ${sp.min}대 이상(균등 ${sp.even}대)이 필요하고, 현재 설계는 ${spines}대입니다. 2계층 상한은 ${fmt(NW_BASIS.twoTierCeiling, 0)}개입니다.`,
      en: `${fmt(xpus, 0)} accelerators exceed the published cluster architecture (${fmt(NW_BASIS.clusterXpus, 0)}), so the spine layer is an estimate. A non-blocking two-tier 51.2T scale-out needs at least ${sp.min} spines (${sp.even} for an even split); the design has ${spines}. The two-tier ceiling is ${fmt(NW_BASIS.twoTierCeiling, 0)} xPUs.` });
    if (xpus > NW_BASIS.twoTierCeiling && so.tiers.length <= 2)
      add({ id: 'std-nw01-ceiling', ruleId: 'NW-01', status: 'finding', naturalSeverity: 'warning', refs: [], designValue: xpus, limit: NW_BASIS.twoTierCeiling, unit: 'xPU', basis: 'standard', standardId: 'xoc-n@1.0', verification: 'derived',
        ko: `가속기 ${fmt(xpus, 0)}개가 51.2T 2계층 상한 ${fmt(NW_BASIS.twoTierCeiling, 0)}개를 넘지만 스케일아웃이 ${so.tiers.length}계층입니다.`, en: `${fmt(xpus, 0)} accelerators exceed the two-tier 51.2T ceiling of ${fmt(NW_BASIS.twoTierCeiling, 0)} while the scale-out has ${so.tiers.length} tiers.` });
  }
  if (so && ethernet && confirmed && so.topology === 'rail-optimized' && xpus >= NW_BASIS.podXpus) {
    const leaves = so.tiers.find((t) => t.name.toLowerCase().startsWith('leaf'))?.switches ?? 0;
    const perPod = (leaves * NW_BASIS.podXpus) / xpus;
    add({ id: 'std-nw01-pod', ruleId: 'NW-01', status: 'finding', naturalSeverity: 'info', refs: [], designValue: Math.round(perPod * 10) / 10, limit: NW_BASIS.railLeavesPerPod, unit: 'leaves / 128 xPU', basis: 'standard', standardId: 'opg-m@1.0', verification: 'verified',
      ko: `레일 최적화 스케일아웃: 가속기 128개당 리프 ${fmt(perPod)}대 / 공개 128-xPU 포드 구성은 26T 리프 4대(리프마다 노드당 NIC 링크 2개) 또는 51T Clos 리프 2대입니다.`, en: `Rail-optimised scale-out: ${fmt(perPod)} leaves per 128 accelerators vs the published 128-xPU pod — 4 × 26T rail leaves (2 NIC links per node each) or 2 × 51T Clos leaves.` });
  }

  // NW-02 / NW-03 per compute model
  const models = new Map<string, Placed[]>();
  for (const p of ctx.placed) if (p.item.category === 'gpu-rack' && p.item.compute) models.set(p.item.id, [...(models.get(p.item.id) ?? []), p]);
  for (const [id, g] of models) {
    const c = g[0].item.compute!;
    const tag = `${g[0].item.name} (${tagList(g)})`;
    const refs = g.slice(0, 6).map((x) => x.e.id);
    const su = c.scaleUp;
    if (su?.kind === 'ualink' && su.domainSize > NW_BASIS.ualinkDomainMax)
      add({ id: `std-nw02-${safeId(id)}`, ruleId: 'NW-02', status: 'finding', naturalSeverity: 'error', refs, designValue: su.domainSize, limit: NW_BASIS.ualinkDomainMax, unit: 'accelerators', basis: 'standard', standardId: 'ualink-200g@1.0', verification: 'verified',
        ko: `${tag}: 스위치형 스케일업 도메인 ${su.domainSize} / 최대 ${NW_BASIS.ualinkDomainMax}.`, en: `${tag}: switched scale-up domain ${su.domainSize} vs a maximum of ${NW_BASIS.ualinkDomainMax}.` });
    if (su?.spansRacks === true && confirmed)
      add({ id: `std-nw02-span-${safeId(id)}`, ruleId: 'NW-02', status: 'finding', naturalSeverity: 'info', refs, basis: 'estimate', verification: 'unverified',
        ko: `${tag}: 스케일업 도메인이 여러 랙에 걸칩니다. 랙 간 스케일업 케이블은 케이블 스케줄에 아직 생성되지 않습니다.`, en: `${tag}: the scale-up domain spans racks; inter-rack scale-up cables are not generated in the cable schedule yet.` });
    const domain = su?.domainSize ?? 0;
    if (confirmed && !(c.railsPerNode && c.railsPerNode > 0) && domain >= 36)
      add({ id: `std-nw03-${safeId(id)}`, ruleId: 'NW-03', status: 'finding', naturalSeverity: 'info', refs, basis: 'estimate', verification: 'estimate',
        ko: `${tag}: 레일 수를 도메인 크기에서 추정했습니다. 노드당 레일 수(railsPerNode)를 인스턴스 데이터로 선언하세요.`, en: `${tag}: the rail count is estimated from the domain size; declare rails per node (railsPerNode) in the instance data.` });
  }
  return out;
}

// ───────────────────────────── aggregator ─────────────────────────────

export interface StandardsCheckReport {
  results: StandardsCheckResult[];
  facility: FacilityPrecheckReport[];
}

/** Every standards parameter check of the project (RK, PW, CL, NW, FC). Empty when the project carries no standards profile. */
export function evaluateStandardsChecks(ctx: Ctx, inputs: { network?: NetworkAnalysis } = {}): StandardsCheckReport {
  if (!ctx.project.standards) return { results: [], facility: [] };
  const results = [...evaluateRackPowerChecks(ctx), ...evaluateLiquidChecks(ctx, inputs), ...evaluateNetworkChecks(ctx, inputs.network)];
  const fac = evaluateFacilityChecks(ctx);
  results.push(...fac.results);
  return { results, facility: fac.reports };
}

/** Findings of `evaluateStandardsChecks` as issues (validate.ts). */
export function standardsCheckIssues(ctx: Ctx, inputs: { network?: NetworkAnalysis } = {}): ReturnType<typeof resultsToIssues> {
  return resultsToIssues(evaluateStandardsChecks(ctx, inputs).results);
}
