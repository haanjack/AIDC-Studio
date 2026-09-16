import type { CatalogItem, ComputeSpec, CostSpec, Dims, EquipmentCategory, NetworkSwitchSpec, SpecSource } from '../model/types.ts';
import type { ItemAccelModule, ItemBaseboard, ItemFormFactor, ItemLiquidInterface, ItemRackPower, ItemStandard, ParamProvenance } from '../standards/types.ts';
import { catalogAliasTarget } from './aliases.ts';
import { itemSpecStatus } from './seeds/std-helpers.ts';
import { RACK_MODEL_DATA } from './seeds/std-racks.ts';

/**
 * Node → rack composer (v2 S3, proposal §3.7).
 *
 * A `NodeSpec` describes one chassis (GPU node or service node — head / login / mgmt / storage / oob / cpu) with its
 * U-height, power, cooling, CPUs, accelerators and NICs. `composeRack` stacks `nodesPerRack` copies of it (plus optional
 * switches / PDU) into a `RackModel` and derives a regular `CatalogItem` (rack category, dims, weight, kW, cooling
 * totals, ComputeSpec totals, cost) so every engine keeps working rack-based. The U-map goes to `item.meta.umap`.
 *
 * All arithmetic is deterministic sums / minimums; nothing is fitted. Every derived item inherits the *weakest* source
 * tag of its inputs (announced < public-spec < vendor-datasheet …) unless the caller sets `source` explicitly.
 */

export type NodeRole = 'gpu' | 'cpu' | 'head' | 'login' | 'mgmt' | 'storage' | 'oob';
export type NodeCooling = 'air' | 'dlc' | 'hybrid';
export type NicRole = 'scale-out' | 'frontend' | 'storage' | 'oob';

export interface NodeNic {
  role: NicRole;
  /** adapters of this role per node */
  count: number;
  /** ports per adapter */
  portsPerNic: number;
  portGbps: number;
  /** optional catalog id of the adapter (category 'nic') */
  catalogId?: string;
}

export interface NodeAccelerator {
  count: number;
  model: string;
  memoryGB: number;
  memBandwidthGBps: number;
  /** FLOPS used by the workload simulator (FP8/BF16 mixed convention of ComputeSpec.gpuFlopsPeak) */
  flopsPeak: number;
  peakTflops?: ComputeSpec['peakTflops'];
  /** per-accelerator power (W) — informational; node power is the authority */
  wattsW: number;
  scaleUp: NonNullable<ComputeSpec['scaleUp']>;
  accelerator: NonNullable<ComputeSpec['accelerator']>;
}

export interface NodeSpec {
  id: string;
  vendor: string;
  model: string;
  name: string;
  description?: string;
  role: NodeRole;
  rackUnits: number;
  weightKg: number;
  power: { nameplateKW: number; typicalKW: number; idleKW: number; peakKW: number; feeds?: number; voltageV?: number };
  cooling: {
    kind: NodeCooling;
    /** heat fraction captured by liquid (0 for air) */
    liquidFraction: number;
    airflowM3s: number;
    liquidFlowLpm: number;
    maxInletC: number;
    maxCoolantSupplyC?: number;
  };
  cpu: { count: number; model: string };
  memoryGB: number;
  gpu?: NodeAccelerator;
  /** raw local storage (TB) — storage nodes */
  storageTB?: number;
  storageThroughputGBps?: number;
  nics: NodeNic[];
  cost: CostSpec;
  source: SpecSource;
  notes?: string;
  links?: { label: string; url: string }[];
  // ── standards (stream B / P2; all optional, carried into composed racks) ──
  standards?: ItemStandard[];
  /** node height / pitch / own rails (RK-01, RK-03) */
  formFactor?: Partial<ItemFormFactor>;
  accelModule?: ItemAccelModule;
  baseboard?: ItemBaseboard;
  liquidInterface?: ItemLiquidInterface;
  /** per-field provenance of the node spec (copied into composed racks under `node.`) */
  paramSources?: Record<string, ParamProvenance>;
  /** e.g. `rackClass` (copied into composed racks) */
  meta?: Record<string, unknown>;
}

export interface RackModel {
  id: string;
  vendor: string;
  model: string;
  name: string;
  dims: Dims;
  weightKg: number;
  rackUnits: number;
  clearance: { front: number; rear: number; sides: number };
  /** rack style — drives the procedural look and the floor-loading note */
  form: 'eia-19' | 'orv3-21' | 'orw-double-wide';
  cost: CostSpec;
  source: SpecSource;
  notes?: string;
  // ── standards (stream B / P2): frame form factor and ratings, rack power interface, provenance ──
  formFactor?: ItemFormFactor;
  rackPower?: ItemRackPower;
  standards?: ItemStandard[];
  paramSources?: Record<string, ParamProvenance>;
  meta?: Record<string, unknown>;
}

/** Indicative per-rack kW ceilings by cooling type (estimate; AMD DC design guide density bands + ORW roadmap). */
export const RACK_KW_CAP: Record<NodeCooling, number> = { air: 60, hybrid: 120, dlc: 200 };
export const RACK_KW_CAP_SOURCE: SpecSource = 'estimate';

/**
 * Rack chassis the composer can target (stream B / P2: data in seeds/std-racks.ts with standards and provenance). Legacy ids
 * (`rack-42u-600x1200`, `rack-48u-600x1200`, `rack-orv3-44ou`, `rack-orw-44ou`) resolve through catalog/aliases.ts.
 */
export const RACK_MODELS: RackModel[] = RACK_MODEL_DATA;

export function findRackModel(id: string): RackModel | undefined {
  const hit = RACK_MODELS.find((r) => r.id === id);
  if (hit) return hit;
  const target = catalogAliasTarget(id);
  return target ? RACK_MODELS.find((r) => r.id === target) : undefined;
}

/** Source ranking used to pick the weakest tag of a composition (lower = weaker). */
const SOURCE_RANK: Record<SpecSource, number> = { user: 0, estimate: 1, announced: 2, 'public-spec': 3, 'vendor-datasheet': 4, 'open-standard': 5 };
export function weakestSource(...tags: SpecSource[]): SpecSource {
  return tags.reduce((a, b) => (SOURCE_RANK[b] < SOURCE_RANK[a] ? b : a), tags[0] ?? 'estimate');
}

export interface UMapEntry {
  /** first rack unit (1 = bottom) */
  u: number;
  units: number;
  label: string;
  kind: 'node' | 'switch' | 'pdu' | 'power-shelf' | 'blank' | 'free' | 'other';
  ref?: string;
  /** component id inside the composition (T5 rack blueprint) */
  id?: string;
  /** IT kW of this block (nameplate; 0 for shelves / blanks) */
  kw?: number;
}

export interface ComposeSwitch {
  /** a switch catalog item (category 'switch') */
  item: CatalogItem;
  count: number;
}

// ───────────── T5: rack components with explicit U positions (DECISIONS-v2-2 F7) ─────────────

export type RackComponentKind = 'node' | 'switch' | 'power-shelf' | 'pdu' | 'blank';

/** One U-occupying block of a composition. `u` = lowest unit (1 = bottom); absent = auto-placed. */
export interface RackComponent {
  id: string;
  kind: RackComponentKind;
  label: string;
  units: number;
  u?: number;
  ref?: string;
  kw?: number;
}

export interface PlacedRackComponent extends RackComponent {
  /** resolved lowest unit, undefined when the block does not fit anywhere (overflow) */
  u?: number;
  conflict?: 'overflow' | 'overlap';
}

export interface RackPlacementIssue {
  kind: 'overflow' | 'overlap';
  ids: string[];
  message: string;
}

export interface RackPlacement {
  ruCap: number;
  placed: PlacedRackComponent[];
  /** contiguous empty unit ranges (blank plates in the blueprint), bottom-up */
  free: { u: number; units: number }[];
  usedU: number;
  issues: RackPlacementIssue[];
}

const AUTO_ORDER: Record<RackComponentKind, number> = { 'power-shelf': 0, pdu: 1, switch: 2, node: 3, blank: 4 };
const NODES_FIRST_ORDER: Record<RackComponentKind, number> = { 'power-shelf': 0, pdu: 1, node: 2, switch: 3, blank: 4 };

/**
 * Deterministic placement. Explicit positions (`positions[id]`, else `component.u`) are honoured first and flagged
 * when they leave the rack (overflow) or collide (overlap). The rest is auto-placed: power shelves alternate
 * bottom / top, U-occupying PDUs at the bottom, switches centred in the rack, nodes fill from the bottom, blanks
 * take the first free gap. Blocks that fit nowhere are reported as overflow with `u` undefined.
 */
export function placeRackComponents(components: RackComponent[], ruCap: number, positions: Record<string, number> = {}): RackPlacement {
  const first = placeRackComponentsWith(components, ruCap, positions, 'centred-switches');
  // fix v2 2차 (QA): the centred switch block can split the free space into gaps smaller than one node (42U: 3 × 10U nodes overflowed
  // with 15U free). When auto placement overflows although everything fits and nothing is pinned, place nodes first-fit from the
  // bottom, then switches in the free run nearest the centre, then the rest.
  const pinned = components.some((c) => positions[c.id] != null || c.u != null);
  const total = components.reduce((s, c) => s + Math.max(1, Math.round(c.units)), 0);
  if (!pinned && total <= Math.floor(ruCap) && first.issues.some((i) => i.kind === 'overflow')) {
    const second = placeRackComponentsWith(components, ruCap, positions, 'nodes-first');
    if (!second.issues.some((i) => i.kind === 'overflow')) return second;
  }
  return first;
}

function placeRackComponentsWith(components: RackComponent[], ruCap: number, positions: Record<string, number>, mode: 'centred-switches' | 'nodes-first'): RackPlacement {
  const cap = Math.max(1, Math.floor(ruCap));
  const occ: (string | null)[] = new Array(cap + 1).fill(null);
  const placed: PlacedRackComponent[] = components.map((c) => ({ ...c, units: Math.max(1, Math.round(c.units)), u: undefined, conflict: undefined }));
  const issues: RackPlacementIssue[] = [];
  const fits = (u: number, units: number) => {
    if (u < 1 || u + units - 1 > cap) return false;
    for (let k = u; k < u + units; k++) if (occ[k]) return false;
    return true;
  };
  const mark = (p: PlacedRackComponent, u: number) => {
    p.u = u;
    for (let k = u; k < u + p.units; k++) if (k >= 1 && k <= cap && !occ[k]) occ[k] = p.id;
  };

  // 1. explicit positions
  for (const p of placed) {
    const want = positions[p.id] ?? components.find((c) => c.id === p.id)?.u;
    if (want == null || !Number.isFinite(want)) continue;
    const u = Math.round(want);
    if (u < 1 || u + p.units - 1 > cap) {
      p.u = u;
      p.conflict = 'overflow';
      issues.push({ kind: 'overflow', ids: [p.id], message: `${p.label}: U${u}–U${u + p.units - 1} is outside the ${cap} U rack` });
      for (let k = Math.max(1, u); k <= Math.min(cap, u + p.units - 1); k++) if (!occ[k]) occ[k] = p.id;
      continue;
    }
    const clash = new Set<string>();
    for (let k = u; k < u + p.units; k++) if (occ[k]) clash.add(occ[k]!);
    if (clash.size) {
      p.conflict = 'overlap';
      for (const other of clash) {
        const o = placed.find((x) => x.id === other);
        if (o && !o.conflict) o.conflict = 'overlap';
      }
      issues.push({ kind: 'overlap', ids: [p.id, ...clash], message: `${p.label} overlaps ${[...clash].map((id) => placed.find((x) => x.id === id)?.label ?? id).join(', ')} at U${u}–U${u + p.units - 1}` });
    }
    mark(p, u);
  }

  // 2. auto placement (stable by kind, then input order)
  const order = mode === 'nodes-first' ? NODES_FIRST_ORDER : AUTO_ORDER;
  const auto = placed.map((p, i) => ({ p, i })).filter(({ p }) => p.u == null && !p.conflict).sort((a, b) => order[a.p.kind] - order[b.p.kind] || a.i - b.i).map(({ p }) => p);
  const firstFitUp = (units: number, from = 1) => { for (let u = Math.max(1, from); u + units - 1 <= cap; u++) if (fits(u, units)) return u; return undefined; };
  const firstFitDown = (units: number) => { for (let u = cap - units + 1; u >= 1; u--) if (fits(u, units)) return u; return undefined; };
  let shelfIdx = 0;
  const shelfTotal = auto.filter((p) => p.kind === 'power-shelf').length;
  const switchU = auto.filter((p) => p.kind === 'switch').reduce((s, p) => s + p.units, 0);
  let switchNext = Math.max(1, Math.floor((cap - switchU) / 2) + 1);
  for (const p of auto) {
    let u: number | undefined;
    if (p.kind === 'power-shelf') {
      u = shelfIdx < Math.ceil(shelfTotal / 2) ? firstFitUp(p.units) : firstFitDown(p.units);
      shelfIdx++;
    } else if (p.kind === 'pdu') {
      u = firstFitUp(p.units);
    } else if (p.kind === 'switch' && mode === 'nodes-first') {
      // free run nearest the rack centre that holds the switch
      const mid = (cap + 1) / 2;
      let best: number | undefined;
      for (let s = 1; s + p.units - 1 <= cap; s++) if (fits(s, p.units) && (best == null || Math.abs(s + p.units / 2 - mid) < Math.abs(best + p.units / 2 - mid))) best = s;
      u = best;
    } else if (p.kind === 'switch') {
      // centred block; search outward from the ideal slot
      for (let d = 0; d <= cap && u == null; d++) {
        if (fits(switchNext + d, p.units)) u = switchNext + d;
        else if (d > 0 && fits(switchNext - d, p.units)) u = switchNext - d;
      }
      if (u != null) switchNext = u + p.units;
    } else {
      u = firstFitUp(p.units);
    }
    if (u == null) {
      p.conflict = 'overflow';
      issues.push({ kind: 'overflow', ids: [p.id], message: `${p.label} (${p.units} U) does not fit — rack has ${cap} U` });
    } else mark(p, u);
  }

  const free: { u: number; units: number }[] = [];
  for (let k = 1; k <= cap; k++) {
    if (occ[k]) continue;
    const last = free[free.length - 1];
    if (last && last.u + last.units === k) last.units++;
    else free.push({ u: k, units: 1 });
  }
  const usedU = placed.reduce((s, p) => s + p.units, 0);
  return { ruCap: cap, placed, free, usedU, issues };
}

/**
 * Move one component up (+1) or down (−1): into an adjacent free U, else swap with the block directly above / below.
 * Returns explicit positions for every placed component (the layout is frozen so later auto-placement cannot reshuffle it).
 */
export function moveRackComponent(components: RackComponent[], ruCap: number, positions: Record<string, number>, id: string, dir: 1 | -1): Record<string, number> {
  const pl = placeRackComponents(components, ruCap, positions);
  const next: Record<string, number> = {};
  for (const p of pl.placed) if (p.u != null) next[p.id] = p.u;
  const me = pl.placed.find((p) => p.id === id);
  if (!me || me.u == null) return next;
  const top = me.u + me.units - 1;
  const at = (u: number) => pl.placed.find((p) => p.u != null && p.id !== id && u >= p.u && u <= p.u + p.units - 1);
  if (dir === 1) {
    if (top >= pl.ruCap) return next;
    const nb = at(top + 1);
    if (!nb) next[id] = me.u + 1;
    else { next[nb.id] = me.u; next[id] = me.u + nb.units; }
  } else {
    if (me.u <= 1) return next;
    const nb = at(me.u - 1);
    if (!nb) next[id] = me.u - 1;
    else { next[id] = nb.u!; next[nb.id] = nb.u! + me.units; }
  }
  return next;
}

/** The component list `composeRack` places (ids are stable: node-1…, sw-<item>-1…, ps-1…, pdu-1, blank-1…). */
export function rackComponentsFor(o: Pick<ComposeOptions, 'node' | 'nodesPerRack' | 'switches' | 'pdu' | 'powerShelves' | 'blanks' | 'bbuShelves'>): RackComponent[] {
  const n = Math.max(1, Math.floor(o.nodesPerRack));
  const out: RackComponent[] = [];
  for (let i = 0; i < n; i++) out.push({ id: `node-${i + 1}`, kind: 'node', label: `${o.node.name} #${i + 1}`, units: o.node.rackUnits, ref: o.node.id, kw: o.node.power.nameplateKW });
  // fix v2 2차 (QA): running index per catalog item across rows — two SN2201 rows both produced sw-nvidia-sn2201-1
  const swNo = new Map<string, number>();
  for (const s of o.switches ?? []) {
    for (let i = 0; i < s.count; i++) {
      const k = (swNo.get(s.item.id) ?? 0) + 1;
      swNo.set(s.item.id, k);
      out.push({ id: `sw-${s.item.id}-${k}`, kind: 'switch', label: s.item.name, units: s.item.switch?.rackUnits ?? 1, ref: s.item.id, kw: s.item.power?.nameplateKW ?? 0 });
    }
  }
  const ps = o.powerShelves;
  if (ps && ps.count > 0) for (let i = 0; i < ps.count; i++) out.push({ id: `ps-${i + 1}`, kind: 'power-shelf', label: `Power shelf #${i + 1} (${ps.ratingKW} kW)`, units: ps.rackUnits ?? 1, kw: 0 });
  const bbu = o.bbuShelves;
  if (bbu && bbu.count > 0) for (let i = 0; i < bbu.count; i++) out.push({ id: `bbu-${i + 1}`, kind: 'power-shelf', label: `BBU shelf #${i + 1}`, units: bbu.rackUnits ?? 2, kw: 0 });
  if (o.pdu && o.pdu.rackUnits && o.pdu.count) out.push({ id: 'pdu-1', kind: 'pdu', label: `PDU ×${o.pdu.count} (${o.pdu.ratingKW} kW)`, units: o.pdu.rackUnits * o.pdu.count, kw: 0 });
  for (let i = 0; i < (o.blanks ?? 0); i++) out.push({ id: `blank-${i + 1}`, kind: 'blank', label: `Blank #${i + 1}`, units: 1, kw: 0 });
  return out;
}

export interface ComposeOptions {
  node: NodeSpec;
  nodesPerRack: number;
  /** RackModel or its id (default 'rack-eia310-48u') */
  rackModel?: RackModel | string;
  /** in-rack switches (ToR leaf, OOB) */
  switches?: ComposeSwitch[];
  /** vertical PDUs: 0 U by default; kW is the PDU rating (informational) */
  pdu?: { count: number; ratingKW: number; rackUnits?: number; capexUSD?: number };
  /** T5: in-rack power shelves (U-occupying; rating is informational, 0 IT kW). Defaults: 1 U, no weight/cost. */
  powerShelves?: { count: number; ratingKW: number; rackUnits?: number; weightKg?: number; capexUSD?: number };
  /** stream B: in-rack battery backup shelves (U-occupying, placed like power shelves). Defaults: 2 U, no weight/cost. */
  bbuShelves?: { count: number; rackUnits?: number; weightKg?: number; capexUSD?: number };
  /** T5: explicit blank plates (1 U each); empty U are blanks anyway */
  blanks?: number;
  /** T5: explicit lowest U per component id (see rackComponentsFor); missing ids are auto-placed */
  positions?: Record<string, number>;
  id?: string;
  name?: string;
  category?: EquipmentCategory;
  source?: SpecSource;
  /** procedural colour for the viewer */
  color?: string;
}

const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

export function categoryForRole(role: NodeRole): EquipmentCategory {
  switch (role) {
    case 'gpu': return 'gpu-rack';
    case 'storage': return 'storage-rack';
    case 'mgmt': case 'oob': return 'mgmt-rack';
    default: return 'cpu-rack';
  }
}

/** Max nodes of `node` that fit `rack` by rack units and by the cooling-type kW cap. */
export function maxNodesPerRack(node: NodeSpec, rack: RackModel, reservedRU = 0): { byRU: number; byKW: number; max: number; kwCap: number } {
  const byRU = Math.max(0, Math.floor((rack.rackUnits - reservedRU) / Math.max(1, node.rackUnits)));
  const kwCap = RACK_KW_CAP[node.cooling.kind];
  const byKW = node.power.nameplateKW > 0 ? Math.max(0, Math.floor(kwCap / node.power.nameplateKW + 1e-9)) : byRU;
  return { byRU, byKW, max: Math.min(byRU, byKW), kwCap };
}

function nicPorts(node: NodeSpec, role: NicRole): { ports: number; gbps: number; nics: number } {
  const xs = node.nics.filter((n) => n.role === role);
  const ports = xs.reduce((s, n) => s + n.count * n.portsPerNic, 0);
  const nics = xs.reduce((s, n) => s + n.count, 0);
  const gbps = xs.length ? Math.max(...xs.map((n) => n.portGbps)) : 0;
  return { ports, gbps, nics };
}

/**
 * Compose a rack catalog item from a node spec.
 * Throws when the rack units are exceeded (the UI shows the message); kW above the cooling cap is a note, not an error.
 */
export function composeRack(o: ComposeOptions): CatalogItem {
  const node = o.node;
  const rack = typeof o.rackModel === 'string' ? findRackModel(o.rackModel) : o.rackModel ?? findRackModel('rack-eia310-48u');
  if (!rack) throw new Error(`Unknown rack model: ${String(o.rackModel)}`);
  const n = Math.max(1, Math.floor(o.nodesPerRack));
  const switches = o.switches ?? [];
  const pduRU = (o.pdu?.rackUnits ?? 0) * (o.pdu?.count ?? 0);
  const swRU = switches.reduce((s, x) => s + (x.item.switch?.rackUnits ?? 1) * x.count, 0);
  const psRU = (o.powerShelves?.rackUnits ?? 1) * (o.powerShelves?.count ?? 0) + (o.bbuShelves?.rackUnits ?? 2) * (o.bbuShelves?.count ?? 0);
  const blankRU = Math.max(0, o.blanks ?? 0);
  const ruUsed = n * node.rackUnits + swRU + pduRU + psRU + blankRU;
  if (ruUsed > rack.rackUnits) throw new Error(`${ruUsed} U required > ${rack.rackUnits} U available in ${rack.name} (${n} × ${node.rackUnits} U nodes + ${swRU + pduRU + psRU + blankRU} U switches/PDU/shelves/blanks)`);
  const components = rackComponentsFor({ ...o, nodesPerRack: n });
  const placement = placeRackComponents(components, rack.rackUnits, o.positions ?? {});
  if (placement.issues.length) throw new Error(`Rack layout: ${placement.issues.map((i) => i.message).join('; ')}`);

  // ── power ──
  const swKW = (k: keyof NonNullable<CatalogItem['power']>) => switches.reduce((s, x) => s + ((x.item.power?.[k] as number | undefined) ?? 0) * x.count, 0);
  const nameplateKW = round(n * node.power.nameplateKW + swKW('nameplateKW'));
  const typicalKW = round(n * node.power.typicalKW + swKW('typicalKW'));
  const idleKW = round(n * node.power.idleKW + swKW('idleKW'));
  const peakKW = round(n * node.power.peakKW + swKW('peakKW'));

  // ── cooling (liquid fraction weighted by nameplate; switches are air) ──
  const nodeLiquidKW = n * node.power.nameplateKW * node.cooling.liquidFraction;
  const liquidFraction = nameplateKW > 0 ? round(nodeLiquidKW / nameplateKW, 4) : 0;
  const airflowM3s = round(n * node.cooling.airflowM3s + switches.reduce((s, x) => s + (x.item.cooling?.airflowM3s ?? 0) * x.count, 0), 4);
  const liquidFlowLpm = round(n * node.cooling.liquidFlowLpm, 2);
  const maxInletC = Math.min(node.cooling.maxInletC, ...switches.map((x) => x.item.cooling?.maxInletC ?? 99));

  // ── weight / cost ──
  const psCount = o.powerShelves?.count ?? 0;
  const bbuCount = o.bbuShelves?.count ?? 0;
  const weightKg = round(rack.weightKg + n * node.weightKg + switches.reduce((s, x) => s + x.item.weightKg * x.count, 0) + (o.powerShelves?.weightKg ?? 0) * psCount + (o.bbuShelves?.weightKg ?? 0) * bbuCount, 1);
  const capexUSD = Math.round(rack.cost.capexUSD + n * node.cost.capexUSD + switches.reduce((s, x) => s + x.item.cost.capexUSD * x.count, 0) + (o.pdu?.capexUSD ?? 0) * (o.pdu?.count ?? 0) + (o.powerShelves?.capexUSD ?? 0) * psCount + (o.bbuShelves?.capexUSD ?? 0) * bbuCount);
  const installHours = Math.round(rack.cost.installHours + n * node.cost.installHours + switches.reduce((s, x) => s + x.item.cost.installHours * x.count, 0));
  const leadTimeWeeks = Math.max(rack.cost.leadTimeWeeks, node.cost.leadTimeWeeks, ...switches.map((x) => x.item.cost.leadTimeWeeks));

  // ── compute totals ──
  const so = nicPorts(node, 'scale-out');
  const fe = nicPorts(node, 'frontend');
  const st = nicPorts(node, 'storage');
  const oob = nicPorts(node, 'oob');
  const g = node.gpu;
  const gpus = g ? n * g.count : 0;
  const compute: ComputeSpec = {
    gpus,
    gpuModel: g?.model ?? '-',
    cpus: n * node.cpu.count,
    cpuModel: node.cpu.model,
    scaleUp: g?.scaleUp ?? { kind: 'none', domainSize: 0, gbpsPerGpu: 0 },
    scaleOutPortsPerGpu: g && g.count > 0 ? round(so.ports / g.count, 4) : 0,
    scaleOutPortGbps: so.gbps,
    frontendPorts: n * fe.ports,
    frontendPortGbps: fe.gbps,
    storagePorts: n * st.ports,
    storagePortGbps: st.gbps,
    oobPorts: n * Math.max(1, oob.ports) + switches.reduce((s, x) => s + x.count, 0),
    gpuMemoryGB: g?.memoryGB ?? 0,
    gpuFlopsPeak: g?.flopsPeak ?? 0,
    ...(g
      ? {
          memBandwidthGBps: g.memBandwidthGBps,
          peakTflops: g.peakTflops,
          railsPerNode: so.nics > 0 ? so.nics : so.ports,
          nodesPerRack: n,
          gpusPerNode: g.count,
          accelerator: g.accelerator,
        }
      : { nodesPerRack: n }),
  };

  // ── U-map from the deterministic placement (T5): shelves top/bottom, switches centred, nodes fill; gaps = free ──
  const umap: UMapEntry[] = [
    ...placement.placed.map((p): UMapEntry => ({ u: p.u!, units: p.units, label: p.label, kind: p.kind, ...(p.ref ? { ref: p.ref } : {}), id: p.id, kw: p.kw ?? 0 })),
    ...placement.free.map((f): UMapEntry => ({ u: f.u, units: f.units, label: 'free', kind: 'free' })),
  ].sort((a, b) => a.u - b.u);

  const category = o.category ?? categoryForRole(node.role);
  const kwCap = RACK_KW_CAP[node.cooling.kind];
  const capNote = nameplateKW > kwCap ? ` Rack nameplate ${nameplateKW} kW exceeds the ${node.cooling.kind} cap ${kwCap} kW (estimate) — plan RDHx / DLC or fewer nodes.` : '';
  const source = o.source ?? weakestSource(node.source, rack.source, ...switches.map((x) => x.item.source));
  const id = o.id ?? `${node.id}-${n}x`;
  // stream B (P2): standards of the rack chassis and the node (deduplicated), frame form factor with the node height
  const standards: ItemStandard[] = [];
  for (const st of [...(rack.standards ?? []), ...(node.standards ?? [])]) if (!standards.some((x) => x.standardId === st.standardId && x.scope === st.scope)) standards.push(st);
  const formFactor: ItemFormFactor = {
    ...(rack.formFactor ?? { unitPitchMm: rack.form === 'eia-19' ? 44.45 : 48, heightUnits: rack.rackUnits, usableUnits: rack.rackUnits }),
    nodeHeightUnits: node.formFactor?.nodeHeightUnits ?? node.rackUnits,
    ...(node.formFactor?.ownRails ? { ownRails: true } : {}),
  };
  const prefixed = (pfx: string, src?: Record<string, ParamProvenance>) => Object.fromEntries(Object.entries(src ?? {}).map(([k, v]) => [`${pfx}.${k}`, v]));
  const paramSources = { ...prefixed('rack', rack.paramSources), ...prefixed('node', node.paramSources) };
  const item: CatalogItem = {
    id,
    category,
    vendor: node.vendor,
    model: `${node.model} ×${n}`,
    name: o.name ?? `${node.name} ×${n} (${rack.model})`,
    description: `${n} × ${node.name} in a ${rack.name}${switches.length ? ` + ${switches.map((s) => `${s.count} × ${s.item.name}`).join(', ')}` : ''}. Composed rack (node → rack composer).`,
    dims: { ...rack.dims },
    weightKg,
    clearance: { ...rack.clearance },
    power: { nameplateKW, typicalKW, idleKW, peakKW, feeds: node.power.feeds ?? 2, voltageV: node.power.voltageV ?? 415 },
    cooling: { liquidFraction, airflowM3s, liquidFlowLpm, maxInletC, ...(node.cooling.maxCoolantSupplyC != null ? { maxCoolantSupplyC: node.cooling.maxCoolantSupplyC } : {}) },
    compute,
    ...(node.storageTB ? { storage: { rawTB: round(n * node.storageTB, 1), usableTB: round(n * node.storageTB * 0.8, 1), throughputGBps: round(n * (node.storageThroughputGBps ?? 0), 1) } } : {}),
    cost: { capexUSD, installHours, leadTimeWeeks },
    rackUnits: rack.rackUnits,
    asset: { color: o.color ?? (category === 'gpu-rack' ? '#3a3f44' : category === 'storage-rack' ? '#26435a' : category === 'mgmt-rack' ? '#3b3320' : '#30353a') },
    source,
    notes: `Composed: ${n} × ${node.name} (${node.rackUnits} U, ${node.power.nameplateKW} kW nameplate, ${node.cooling.kind}) in ${rack.name}; ${ruUsed}/${rack.rackUnits} U used.${capNote}${node.notes ? ` Node: ${node.notes}` : ''}`,
    links: node.links,
    meta: {
      composed: true,
      node: node.id,
      nodesPerRack: n,
      rackModel: rack.id,
      rackForm: rack.form,
      ruUsed,
      ruCap: rack.rackUnits,
      kwCap,
      kwCapSource: RACK_KW_CAP_SOURCE,
      switches: switches.map((s) => ({ id: s.item.id, count: s.count })),
      ...(o.powerShelves && o.powerShelves.count > 0 ? { powerShelves: { ...o.powerShelves } } : {}),
      ...(o.bbuShelves && o.bbuShelves.count > 0 ? { bbuShelves: { ...o.bbuShelves } } : {}),
      ...(typeof node.meta?.rackClass === 'string' ? { rackClass: node.meta.rackClass } : {}),
      ...(blankRU ? { blanks: blankRU } : {}),
      positions: Object.fromEntries(placement.placed.map((p) => [p.id, p.u!])),
      umap,
    },
    formFactor,
    ...(rack.rackPower ? { rackPower: rack.rackPower } : {}),
    ...(node.accelModule ? { accelModule: node.accelModule } : {}),
    ...(node.baseboard ? { baseboard: node.baseboard } : {}),
    ...(node.liquidInterface ? { liquidInterface: node.liquidInterface } : {}),
    ...(standards.length ? { standards, specStatus: itemSpecStatus(standards) } : {}),
    ...(Object.keys(paramSources).length ? { paramSources } : {}),
  };
  return item;
}

/** Convenience: a switch entry for `composeRack` from a catalog item (throws if it is not a switch). */
export function asComposeSwitch(item: CatalogItem, count = 1): ComposeSwitch {
  if (item.category !== 'switch') throw new Error(`${item.id} is not a switch`);
  return { item, count };
}

export type { NetworkSwitchSpec as ComposeSwitchSpec };
