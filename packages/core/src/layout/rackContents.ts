// Shared rack U-map resolver (area D2, DECISIONS-v2-2 §D "랙 입면도").
//
// ONE function decides where every device sits in a rack. drawings/elevation.ts (rackUMap), deploy/rackplan.ts
// (umapFor), engines/links.ts (nodeU / buildSwitchUnits → cable-schedule fromU/toU) and the per-DU rack elevation
// sheets + CSVs are views over `rackSlotMap`. Precedence:
//   1. composer `meta.umap` (explicit U, source 'user')
//   2. public rack composition: NVIDIA NVL72 class = NVIDIA DGX GB rack scale systems user guide, Hardware
//      (https://docs.nvidia.com/dgx/dgxgb200-user-guide/hardware.html: 18 × 1RU compute trays, 9 × 1RU NVLink switch trays,
//      2 × management ToR switches, power shelves); the unit ORDER (power shelves top and bottom, switch trays in the
//      middle, management positions at the top, stiffeners) is an AIDC Studio layout; AMD Helios ORW 44 OU (AMD product page)
//   3. category estimates (HGX / UBB8 nodes, CPU, storage, management racks)
//   4. network racks: switches from the network placement analysis, stacked from the top in buildSwitchUnits order
// Free units are auto-filled with blanking panels (D-8) so Σ slot units = rack units. U numbering is bottom-up
// (U1 at the bottom; OU for ORV3 / ORW racks). Pure and deterministic.
import { rackFormFromMeta } from '../catalog/aliases.ts';
import type { CatalogItem, EquipmentInstance, Project, SpecSource } from '../model/types.ts';
import type { RackFormKey } from '../standards/types.ts';

export type RackSlotCategory =
  | 'compute-tray' | 'gpu-node' | 'scaleup-switch-tray' | 'power-shelf' | 'switch' | 'storage-shelf' | 'storage-controller'
  | 'cpu-server' | 'mgmt-server' | 'patch-panel' | 'cable-manager' | 'stiffener' | 'reserved' | 'blank' | 'other';

export interface RackSlot {
  /** lowest unit (1-based, bottom-up) */
  uStart: number;
  uEnd: number;
  units: number;
  category: RackSlotCategory;
  /** short slot label: CT07 · NVS3 · PS-A2 · SW1 · Blank */
  label: string;
  /** device description (model / role) */
  model: string;
  catalogId?: string;
  role?: 'leaf' | 'spine' | 'core';
  fabric?: string;
  fabricKey?: string;
  ports?: number;
  source: SpecSource;
  /** blanking panel added by the resolver for a free run */
  auto?: boolean;
  /** endpoint node index (0-based) in cable-schedule order (engines/links.ts nodeU) */
  nodeIndex?: number;
  /** explicit composer kW */
  kw?: number;
  /** power shelf side */
  side?: 'A' | 'B';
}

export interface RackSlotMap {
  totalU: number;
  unit: 'U' | 'OU';
  /** sorted top-down (highest uStart first) */
  slots: RackSlot[];
  source: SpecSource;
  note: string;
}

export interface RackSwitchInput {
  catalogId: string;
  role: 'leaf' | 'spine' | 'core';
  fabric: string;
  count: number;
  fabricKey?: string;
}

type Lookup = (id: string) => CatalogItem | undefined;

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Declared rack form of an item (stream C, P3): `formFactor.rack`, else the legacy `meta.rackForm` through the alias table. */
export function declaredRackForm(item: CatalogItem | undefined): RackFormKey | undefined {
  return item?.formFactor?.rack ?? rackFormFromMeta(item?.meta?.rackForm);
}

/** Frame implementation whose usable units apply by default (Google ORv3 implementation Rev 0.2: 39.5 OU → 39 usable). */
const GOOGLE_ORV3_IMPLEMENTATION = 'orv3-frame-google@0.2';

/**
 * Rack unit count used by every consumer (stream C, P3 — OU-aware): composer ruCap → declared form factor (usable, then height units) →
 * rackUnits → rack-standard default for GPU racks without a count (Meta ORv3 frame 1.3 / ORv3 HPR / ORW 44 OU; Google ORv3 implementation
 * 39 OU; EIA-310 and vendor rack-scale frames 48 U) → network load capacity → 42.
 */
export function rackTotalU(item: CatalogItem | undefined, ruCapacity?: number): number {
  const cap = Number(item?.meta?.ruCap ?? item?.formFactor?.usableUnits ?? item?.formFactor?.heightUnits ?? item?.rackUnits ?? 0);
  if (cap > 0) return cap;
  if (item?.category === 'gpu-rack') {
    const form = declaredRackForm(item);
    if (item.formFactor?.implementation === GOOGLE_ORV3_IMPLEMENTATION) return 39;
    if (form === 'orv3' || form === 'orv3-hpr' || form === 'orw') return 44;
    return 48;
  }
  return ruCapacity && ruCapacity > 0 ? ruCapacity : 42;
}

/** Unit label of a rack: OU (48 mm pitch: ORv3 / ORv3 HPR / ORW) or U (44.45 mm: EIA-310, vendor rack-scale frames). */
export function rackUnitLabel(item: CatalogItem | undefined): 'U' | 'OU' {
  const pitch = item?.formFactor?.unitPitchMm;
  if (pitch === 48) return 'OU';
  if (pitch === 44.45) return 'U';
  const form = declaredRackForm(item);
  return form === 'orv3' || form === 'orv3-hpr' || form === 'orw' ? 'OU' : 'U';
}

export const isRackScale = (item: CatalogItem): boolean => {
  const c = item.compute;
  if (!c || item.category !== 'gpu-rack') return false;
  return (c.scaleUp?.domainSize ?? 0) >= 36 && c.gpus >= 36;
};

/** Switched-scale-up rack-scale systems on an ORW-class frame (data only, never the catalog id). */
const isHelios = (item: CatalogItem) => item.compute?.scaleUp?.kind === 'ualink';
/** NVLink rack-scale systems (the NVL72 rack composition applies only to these; classified by the declared scale-up kind). */
const isNvlinkClass = (item: CatalogItem) => item.compute?.scaleUp?.kind === 'nvlink';

/** Network-rack switch order shared with engines/links.ts buildSwitchUnits (role name, then catalog id). */
export function orderRackSwitches<T extends { role: string; catalogId: string }>(switches: T[], networkRack: boolean): T[] {
  return networkRack ? [...switches].sort((a, b) => (a.role > b.role ? 1 : a.role < b.role ? -1 : a.catalogId.localeCompare(b.catalogId))) : [...switches];
}

class Stack {
  slots: RackSlot[] = [];
  constructor(public totalU: number) {}
  used(u: number) { return this.slots.some((s) => u >= s.uStart && u <= s.uEnd); }
  put(uStart: number, s: Omit<RackSlot, 'uStart' | 'uEnd'>): boolean {
    const uEnd = uStart + s.units - 1;
    if (uStart < 1 || uEnd > this.totalU) return false;
    for (let u = uStart; u <= uEnd; u++) if (this.used(u)) return false;
    this.slots.push({ ...s, uStart, uEnd });
    return true;
  }
  fillBlanks(label: string, model: string) {
    let run = 0;
    for (let u = 1; u <= this.totalU + 1; u++) {
      if (u <= this.totalU && !this.used(u)) { run++; continue; }
      if (run > 0) this.slots.push({ uStart: u - run, uEnd: u - 1, units: run, category: 'blank', label, model, source: 'estimate', auto: true });
      run = 0;
    }
    this.slots.sort((a, b) => b.uStart - a.uStart);
  }
}

/** Switches stacked from the top, exactly as buildSwitchUnits assigns `u` (Math.max(1, top − ru + 1)). */
function stackSwitches(st: Stack, switches: RackSwitchInput[], lookup: Lookup, top: number): number {
  let k = 0;
  for (const sw of switches) {
    const it = lookup(sw.catalogId);
    const ru = it?.switch?.rackUnits ?? 1;
    for (let i = 0; i < sw.count; i++) {
      const u = Math.max(1, top - ru + 1);
      top = u - 1;
      k++;
      st.put(u, { units: ru, category: 'switch', label: `SW${k}`, model: `${it?.model ?? sw.catalogId} · ${sw.role} · ${sw.fabric}`, catalogId: sw.catalogId, role: sw.role, fabric: sw.fabric, fabricKey: sw.fabricKey, ports: it?.switch?.ports, source: it?.source ?? 'estimate' });
    }
  }
  return top;
}

/**
 * U-map of one rack. `switches` = the network analysis switches mounted in this rack instance (NetworkRackLoad.switches,
 * any order — network racks are re-ordered like buildSwitchUnits). Without switches the ToR positions of HGX / CPU /
 * storage racks stay 'reserved'.
 */
export function rackSlotMap(item: CatalogItem, switches: RackSwitchInput[] | undefined, lookup: Lookup, opts: { ruCapacity?: number } = {}): RackSlotMap {
  const totalU = rackTotalU(item, opts.ruCapacity);
  const st = new Stack(totalU);
  const c = item.compute;
  const blankL = 'Blank';
  const blankM = 'Blanking panel';
  const sws = orderRackSwitches(switches ?? [], item.category === 'network-rack');
  let source: SpecSource = 'estimate';
  let note = 'U-map is a planning estimate';
  let unit: 'U' | 'OU' = rackUnitLabel(item);
  const umap = item.meta?.umap as { u: number; units: number; kind: string; label: string; kw?: number }[] | undefined;

  if (Array.isArray(umap) && umap.length) {
    source = 'user';
    note = 'U-map from the rack composer (explicit U positions)';
    let node = 0;
    const nodes = [...umap].filter((e) => e.kind === 'node').sort((a, b) => a.u - b.u);
    let k = 0;
    for (const e of [...umap].sort((a, b) => b.u - a.u)) {
      k++;
      const cat: RackSlotCategory = e.kind === 'node' ? (item.category === 'gpu-rack' ? 'gpu-node' : item.category === 'storage-rack' ? 'storage-shelf' : 'cpu-server') : e.kind === 'switch' ? 'switch' : e.kind === 'power-shelf' ? 'power-shelf' : e.kind === 'blank' ? 'blank' : 'other';
      const nodeIndex = e.kind === 'node' ? nodes.indexOf(e) : undefined;
      if (e.kind === 'node') node++;
      st.put(e.u, { units: Math.max(1, e.units), category: cat, label: cat === 'blank' ? blankL : e.kind === 'node' ? `N${pad2((nodeIndex ?? 0) + 1)}` : `${e.kind === 'switch' ? 'SW' : e.kind === 'power-shelf' ? 'PS' : 'X'}${k}`, model: e.label, source: 'user', ...(nodeIndex !== undefined ? { nodeIndex } : {}), ...(e.kw != null ? { kw: e.kw } : {}) });
    }
    void node;
  } else if (item.category === 'gpu-rack' && c && isRackScale(item) && isHelios(item)) {
    // AMD Helios ORW 44 OU, top-down: mgmt 1, power 5 × 2, compute 9, switch 6, compute 9, power 4 × 2, filler 1
    unit = 'OU';
    source = 'announced';
    note = 'AMD Hot Chips 2026 slide 6 (18 + 6 trays announced; power block OU split estimated from the render)';
    const nodes = c.nodesPerRack ?? 18;
    const half = Math.ceil(nodes / 2);
    let top = totalU;
    const down = (units: number, s: Omit<RackSlot, 'uStart' | 'uEnd' | 'units'>) => { top -= units; st.put(top + 1, { ...s, units }); };
    down(1, { category: 'reserved', label: 'MGMT', model: 'Management position', source });
    for (let i = 0; i < 5; i++) down(2, { category: 'power-shelf', label: `PS-A${i + 1}`, model: 'Power shelf', side: 'A', source });
    for (let i = 0; i < half; i++) down(1, { category: 'compute-tray', label: `CT${pad2(i + 1)}`, model: `Compute tray (${c.gpusPerNode ?? 4}× GPU)`, nodeIndex: i, source });
    for (let i = 0; i < 6; i++) down(1, { category: 'scaleup-switch-tray', label: `SUS${i + 1}`, model: 'Scale-up switch tray', source });
    for (let i = half; i < nodes; i++) down(1, { category: 'compute-tray', label: `CT${pad2(i + 1)}`, model: `Compute tray (${c.gpusPerNode ?? 4}× GPU)`, nodeIndex: i, source });
    for (let i = 0; i < 4; i++) down(2, { category: 'power-shelf', label: `PS-B${i + 1}`, model: 'Power shelf', side: 'B', source });
  } else if (item.category === 'gpu-rack' && c && isRackScale(item) && isNvlinkClass(item)) {
    // NVIDIA NVL72 class — tray counts from the public DGX GB user guide; U positions are an AIDC Studio layout (bottom-up):
    // stiffener U1–2, power shelves U5–8, compute U11–18, NVLink switch trays U19–27, compute U29–38, power shelves U40–43,
    // stiffener U45–46, 2 × mgmt U47–48.
    source = 'public-spec';
    const trays = Math.max(1, Math.round(c.gpus / Math.max(1, c.gpusPerNode ?? 4)));
    const nvsw = Math.max(1, Math.round(c.gpus / 8));
    const upper = Math.ceil(trays * 0.55);
    const lower = trays - upper;
    const perTray = `Compute tray (${c.gpusPerNode ?? 4}× GPU)`;
    note = `NVIDIA NVL72 rack composition (DGX GB user guide) — ${trays} compute trays, ${nvsw} NVLink switch trays, 8 power shelves; U order is an AIDC Studio layout`;
    const needed = 2 + 2 + 4 + 2 + lower + nvsw + 1 + upper + 1 + 4 + 1 + 2 + 2;
    if (totalU >= needed) {
      let u = 1;
      st.put(u, { units: 2, category: 'stiffener', label: 'STF', model: 'Rack stiffener', source }); u += 4;
      for (let i = 0; i < 4; i++) st.put(u++, { units: 1, category: 'power-shelf', label: `PS-B${i + 1}`, model: 'Power shelf (1U, 33 kW)', side: 'B', source });
      u += 2;
      for (let i = 0; i < lower; i++) st.put(u + lower - 1 - i, { units: 1, category: 'compute-tray', label: `CT${pad2(upper + i + 1)}`, model: perTray, nodeIndex: upper + i, source });
      u += lower;
      for (let i = 0; i < nvsw; i++) st.put(u + nvsw - 1 - i, { units: 1, category: 'scaleup-switch-tray', label: `NVS${i + 1}`, model: 'NVLink switch tray', source });
      u += nvsw + 1;
      for (let i = 0; i < upper; i++) st.put(u + upper - 1 - i, { units: 1, category: 'compute-tray', label: `CT${pad2(i + 1)}`, model: perTray, nodeIndex: i, source });
      u += upper + 1;
      for (let i = 0; i < 4; i++) st.put(u + 3 - i, { units: 1, category: 'power-shelf', label: `PS-A${i + 1}`, model: 'Power shelf (1U, 33 kW)', side: 'A', source });
      st.put(totalU - 3, { units: 2, category: 'stiffener', label: 'STF', model: 'Rack stiffener / top spacer', source });
    } else {
      // short frame: compact stack top-down, same order
      let top = totalU - 2;
      const down = (s: Omit<RackSlot, 'uStart' | 'uEnd' | 'units'>) => { st.put(top, { ...s, units: 1 }); top--; };
      for (let i = 0; i < 4; i++) down({ category: 'power-shelf', label: `PS-A${i + 1}`, model: 'Power shelf', side: 'A', source });
      for (let i = 0; i < upper; i++) down({ category: 'compute-tray', label: `CT${pad2(i + 1)}`, model: perTray, nodeIndex: i, source });
      for (let i = 0; i < nvsw; i++) down({ category: 'scaleup-switch-tray', label: `NVS${i + 1}`, model: 'NVLink switch tray', source });
      for (let i = 0; i < lower; i++) down({ category: 'compute-tray', label: `CT${pad2(upper + i + 1)}`, model: perTray, nodeIndex: upper + i, source });
      for (let i = 0; i < 4; i++) down({ category: 'power-shelf', label: `PS-B${i + 1}`, model: 'Power shelf', side: 'B', source });
    }
    // top two units: switches mounted here by the network analysis, else the two management ToR positions
    if (sws.length) stackSwitches(st, sws, lookup, totalU);
    else for (let i = 0; i < 2; i++) st.put(totalU - i, { units: 1, category: 'reserved', label: `MG${i + 1}`, model: 'Management switch position (not in network analysis)', source });
  } else if (item.category === 'gpu-rack' && c && isRackScale(item)) {
    // finish v2 2차 (QA templates #3): rack-scale LPU / NPU systems (Groq 3 LPX, GroqRack …) have no public rack map — a generic tray /
    // node stack clipped to the rack's own U height, labelled by accelerator family (never NVLink trays or 33 kW power shelves)
    const perNode = c.gpusPerNode ?? 8;
    const nodes = c.nodesPerRack ?? Math.max(1, Math.round(c.gpus / perNode));
    const avail = Math.max(1, totalU - 4);
    const ru = Math.max(1, Math.min(4, Math.floor(avail / nodes)));
    const fit = Math.min(nodes, Math.floor(avail / ru));
    const fam = c.accelerator?.family ?? 'Accelerator';
    const chip = c.gpuModel ?? fam;
    source = 'estimate';
    note = `planning estimate — generic ${fam} stack (no public rack map): ${fit}${fit < nodes ? ` of ${nodes}` : ''} × ${ru}U ${ru === 1 ? 'trays' : 'nodes'} of ${perNode} × ${chip} in ${totalU}${unit}`;
    for (let i = 0; i < fit; i++) st.put(totalU - 2 - (i + 1) * ru + 1, { units: ru, category: 'gpu-node', label: `T${pad2(i + 1)}`, model: `${fam} ${ru === 1 ? 'tray' : 'node'} (${perNode}× ${chip})`, nodeIndex: i, source });
    topSwitchesOrReserved(st, sws, lookup, totalU, 2);
  } else if (item.category === 'gpu-rack' && c && (item.formFactor?.nodeHeightUnits ?? 0) > 0 && ['orv3', 'orv3-hpr', 'orw'].includes(declaredRackForm(item) ?? '')) {
    // stream C (P3): OU node rack archetype (e.g. 8-module DLC nodes in an ORv3 HPR frame). Power zone in the middle of the frame:
    // HPR v1 = 3 × 1 OU PSU shelves + 3 × 2 OU BBU shelves = 9 OU (HPR shelf Rev 0.3 / BBU shelf Rev 0.5, draft; D); ORv3 v1 = 2 × (1 OU PSU +
    // 2 OU BBU) (estimate). Nodes of the declared height below and above the zone, two ToR positions at the top when they fit.
    const form = declaredRackForm(item);
    const perNode = c.gpusPerNode ?? 8;
    const nodes = c.nodesPerRack ?? Math.max(1, Math.round(c.gpus / perNode));
    const nodeU = Math.max(1, Math.round(item.formFactor!.nodeHeightUnits!));
    const sets = form === 'orv3' ? 2 : 3;
    const shelfU = item.powerShelf?.heightOU ?? 1;
    const bbuU = 2;
    const zoneU = sets * (shelfU + bbuU);
    const torU = totalU - (nodes * nodeU + zoneU) >= 2 ? 2 : 0;
    const lower = Math.floor(nodes / 2);
    const accel = c.accelerator?.family ?? 'Accelerator';
    note = `planning estimate — ${nodes} × ${nodeU} OU nodes of ${perNode} × ${c.gpuModel ?? accel}; ${form === 'orv3' ? 'ORv3' : form === 'orw' ? 'ORW' : 'ORv3 HPR'} power zone ${zoneU} OU (${sets} × ${shelfU} OU PSU + ${sets} × ${bbuU} OU BBU shelves)`;
    let u = 1;
    let idx = 0;
    const node = () => {
      if (st.put(u, { units: nodeU, category: 'gpu-node', label: `N${pad2(idx + 1)}`, model: `${accel} node (${perNode}× ${c.gpuModel ?? 'accelerator'}, ${nodeU} OU)`, nodeIndex: idx, source })) idx++;
      u += nodeU;
    };
    for (let i = 0; i < lower; i++) node();
    for (let i = 0; i < sets; i++) {
      st.put(u, { units: shelfU, category: 'power-shelf', label: `PSU${i + 1}`, model: `Power shelf (${shelfU} OU)`, side: i % 2 === 0 ? 'A' : 'B', source: 'open-standard' });
      u += shelfU;
      st.put(u, { units: bbuU, category: 'power-shelf', label: `BBU${i + 1}`, model: `BBU shelf (${bbuU} OU)`, source: 'open-standard' });
      u += bbuU;
    }
    for (let i = lower; i < nodes; i++) node();
    if (torU) topSwitchesOrReserved(st, sws, lookup, totalU, 2);
  } else if (item.category === 'gpu-rack' && c) {
    // HGX / UBB8-style nodes: ToR positions (2 × 1U) at the top, nodes stacked below (engines/links.ts nodeU)
    const perNode = c.gpusPerNode ?? Math.max(1, c.scaleUp.domainSize || 8);
    const nodes = c.nodesPerRack ?? Math.max(1, Math.round(c.gpus / perNode));
    const ru = perNode >= 8 ? 8 : perNode >= 4 ? 4 : 2;
    note = `planning estimate — ${nodes} × ${ru}U ${perNode}-GPU nodes`;
    for (let i = 0; i < nodes; i++) st.put(totalU - 2 - (i + 1) * ru + 1, { units: ru, category: 'gpu-node', label: `N${pad2(i + 1)}`, model: perNode === 8 ? `GPU server HGX / UBB8 ${perNode}× GPU` : `${c.accelerator?.family ?? 'Accelerator'} node (${perNode}× ${c.gpuModel ?? 'accelerator'})`, nodeIndex: i, source });
    topSwitchesOrReserved(st, sws, lookup, totalU, 2);
  } else if (item.category === 'cpu-rack') {
    const count = Math.min(totalU - 2, Math.max(1, c?.cpus ? Math.round(c.cpus / 2) : 20));
    for (let i = 0; i < count; i++) st.put(totalU - 2 - i, { units: 1, category: 'cpu-server', label: `S${pad2(i + 1)}`, model: 'CPU server (1U)', nodeIndex: i, source });
    topSwitchesOrReserved(st, sws, lookup, totalU, 2);
  } else if (item.category === 'storage-rack') {
    const count = Math.min(Math.floor((totalU - 2) / 2), Math.max(1, Math.round((item.storage?.rawTB ?? 1000) / 500)));
    for (let i = 0; i < count; i++) st.put(totalU - 2 - (i + 1) * 2 + 1, { units: 2, category: 'storage-shelf', label: `ST${pad2(i + 1)}`, model: 'Storage node (2U)', nodeIndex: i, source });
    topSwitchesOrReserved(st, sws, lookup, totalU, 2);
  } else if (item.category === 'mgmt-rack') {
    const count = Math.min(totalU - 2, 12);
    for (let i = 0; i < count; i++) st.put(totalU - 2 - i, { units: 1, category: 'mgmt-server', label: `M${pad2(i + 1)}`, model: 'Management server (1U)', nodeIndex: i, source });
    topSwitchesOrReserved(st, sws, lookup, totalU, 2);
  } else if (item.category === 'network-rack') {
    note = sws.length ? 'switches from the network placement analysis (top-down, role then model)' : 'no switch placement analysis';
    stackSwitches(st, sws, lookup, totalU);
    st.put(1, { units: 2, category: 'patch-panel', label: 'PP1', model: 'Patch panel / trunk cassettes (2U)', source: 'estimate' });
  }
  st.fillBlanks(blankL, blankM);
  return { totalU, unit, slots: st.slots, source, note };
}

function topSwitchesOrReserved(st: Stack, sws: RackSwitchInput[], lookup: Lookup, totalU: number, positions: number) {
  if (sws.length) {
    stackSwitches(st, sws, lookup, totalU);
    return;
  }
  for (let i = 0; i < positions; i++) st.put(totalU - i, { units: 1, category: 'reserved', label: `TOR${i + 1}`, model: 'ToR / patch position (no switch placed by the network analysis)', source: 'estimate' });
}

/** Lowest U of endpoint node `i` (cable-schedule fromU / toU); undefined when the rack has no such node. */
export function slotMapNodeU(map: RackSlotMap, i: number): number | undefined {
  return map.slots.find((s) => s.nodeIndex === i && s.category !== 'blank')?.uStart;
}

// ───────────── rack static load rating (catalog field, estimate seeds) ─────────────

/**
 * Rack static (stationary) load rating seeds, kg, used when the catalog item has no `rackStaticLoadKg`. All `estimate`:
 * typical enclosure ratings for 19" EIA racks (≈ 1,360 kg / 3,000 lb class), heavier-duty frames for rack-scale AI systems.
 */
export const RACK_STATIC_LOAD_SEEDS: { match: (item: CatalogItem) => boolean; kg: number; label: string }[] = [
  { match: (i) => declaredRackForm(i) === 'orw' || isHelios(i), kg: 2700, label: 'ORW double-wide (estimate)' },
  { match: (i) => declaredRackForm(i) === 'orv3' || declaredRackForm(i) === 'orv3-hpr', kg: 1600, label: 'ORV3 21" (estimate)' },
  { match: (i) => isRackScale(i), kg: 2000, label: 'MGX rack-scale frame (estimate)' },
  { match: (i) => /-rack$/.test(i.category), kg: 1360, label: '19" EIA enclosure (estimate)' },
];

export function rackStaticLoadRating(item: CatalogItem): { kg: number; source: SpecSource; label: string } | undefined {
  if (item.rackStaticLoadKg && item.rackStaticLoadKg > 0) return { kg: item.rackStaticLoadKg, source: item.rackStaticLoadSource ?? item.source, label: 'catalog' };
  // stream C (P3): a declared frame payload rating (e.g. Meta ORv3 frame 1.3: 1400 kg excluding the frame; ORW 1.0.0: 4700 kg braced)
  const ff = item.formFactor;
  if (ff?.payloadKg && ff.payloadKg > 0) return { kg: ff.payloadKg, source: 'open-standard', label: `frame payload rating${ff.payloadExcludesFrame ? ' (excluding the frame)' : ''}` };
  const seed = RACK_STATIC_LOAD_SEEDS.find((s) => s.match(item));
  return seed ? { kg: seed.kg, source: 'estimate', label: seed.label } : undefined;
}

// ───────────── layout hash (thermal snapshots) ─────────────

/** FNV-1a hash of the hall's equipment ids, catalog ids, positions, rotations and load factors (stale-snapshot check). */
export function hallLayoutHash(project: Project, hallId: string): string {
  let h = 0x811c9dc5;
  const eat = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  };
  const eq: EquipmentInstance[] = project.equipment.filter((e) => e.hallId === hallId).sort((a, b) => a.id.localeCompare(b.id));
  for (const e of eq) eat(`${e.id}|${e.catalogId}|${e.position.x.toFixed(2)}|${e.position.y.toFixed(2)}|${e.rotationDeg}|${e.loadFactor ?? 1};`);
  // finish v2 2차 (QA rack-elevations m2): the cooling inputs of the run are part of the hash (a changed supply air temperature used to keep
  // the old simulated values current)
  eat(`cooling|${project.cooling.supplyAirC}|${project.cooling.cduCatalogId ?? ''}`);
  return h.toString(16).padStart(8, '0');
}
