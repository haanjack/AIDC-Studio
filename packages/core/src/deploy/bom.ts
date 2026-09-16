import { computeCountsOf, isAcceleratorSlotRack } from '../catalog/checks.ts';
import { cableTypes, findCatalogItem } from '../catalog/catalog.ts';
import type { BomLine, EquipmentInstance, Locale, Project, ProjectAnalysis, SpecSource } from '../model/types.ts';
import { makeFormatters, mdTable } from '../docs/index.ts';
import { itemStandardsFields } from '../docs/standardsBasis.ts';
import { deployStrings } from './strings.ts';

export type BomGroup = 'racks' | 'switches' | 'cables' | 'transceivers' | 'trays' | 'busways' | 'tapoffs' | 'cooling' | 'pdus';

export interface WaveBomLine {
  waveId: string;
  waveName: string;
  group: BomGroup;
  itemId: string;
  description: string;
  /** cables only */
  lengthBin?: string;
  qty: number;
  unit: 'ea' | 'm';
  /** cables only — metres in this bin */
  totalLengthM?: number;
  source: SpecSource;
  /** stream E (P5, proposal §6.3): display text of the item's cited standard, status, implementation level and verification (never internal keys) */
  standard?: string;
  standardVersion?: string;
  specStatus?: string;
  implementationLevel?: string;
  verification?: string;
}

export interface WaveBom {
  waves: { id: string; name: string; podIds: string[]; targetReadyDate?: string }[];
  lines: WaveBomLine[];
  notes: string[];
}

export const COMMON_WAVE = 'common';
export const RACK_CATS: ReadonlySet<string> = new Set(['gpu-rack', 'cpu-rack', 'storage-rack', 'network-rack', 'mgmt-rack']);

/** Length bins (m) for the cable list — deterministic boundaries matching common reach classes. */
export const LENGTH_BINS: { max: number; label: string }[] = [
  { max: 3, label: '≤3 m' }, { max: 10, label: '3–10 m' }, { max: 30, label: '10–30 m' }, { max: 50, label: '30–50 m' },
  { max: 100, label: '50–100 m' }, { max: 500, label: '100–500 m' }, { max: Infinity, label: '>500 m' },
];
export const lengthBin = (m: number) => LENGTH_BINS.find((b) => m <= b.max)!.label;

const polylineLength = (pts: { x: number; y: number; z: number }[]) => {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y, pts[i].z - pts[i - 1].z);
  return s;
};

/** wave id of an equipment instance: explicit waveId → wave containing its pod → common */
export function waveOf(e: EquipmentInstance | undefined, project: Project): string {
  if (!e) return COMMON_WAVE;
  const waves = project.schedule.waves;
  if (e.waveId && waves.some((w) => w.id === e.waveId)) return e.waveId;
  if (e.podId) {
    const w = waves.find((x) => x.podIds.includes(e.podId!));
    if (w) return w.id;
  }
  if (e.waveId) return e.waveId;
  return COMMON_WAVE;
}

export function buildWaveBom(project: Project, analysis: ProjectAnalysis | null, locale: Locale = 'en'): WaveBom {
  const S = deployStrings(locale);
  const waves = project.schedule.waves.map((w) => ({ id: w.id, name: w.name, podIds: w.podIds, targetReadyDate: w.targetReadyDate }));
  const waveName = (id: string) => (id === COMMON_WAVE ? S.common : waves.find((w) => w.id === id)?.name ?? id);
  const lines = new Map<string, WaveBomLine>();
  const add = (waveId: string, group: BomGroup, itemId: string, description: string, qty: number, unit: 'ea' | 'm', source: SpecSource, extra: { lengthBin?: string; totalLengthM?: number; variant?: string } = {}) => {
    if (!(qty > 0)) return;
    const key = `${waveId}|${group}|${itemId}|${extra.lengthBin ?? ''}${extra.variant ? `|${extra.variant}` : ''}`;
    const cur = lines.get(key);
    if (cur) {
      cur.qty += qty;
      if (extra.totalLengthM) cur.totalLengthM = (cur.totalLengthM ?? 0) + extra.totalLengthM;
      return;
    }
    lines.set(key, { waveId, waveName: waveName(waveId), group, itemId, description, qty, unit, source, ...(extra.lengthBin ? { lengthBin: extra.lengthBin } : {}), ...(extra.totalLengthM !== undefined ? { totalLengthM: extra.totalLengthM } : {}) });
  };
  const eqById = new Map(project.equipment.map((e) => [e.id, e]));
  const notes: string[] = [];

  // racks by class and cooling units (placed)
  const placedByCat = new Map<string, number>();
  for (const e of project.equipment) {
    const item = findCatalogItem(e.catalogId);
    if (!item || !project.halls.some((h) => h.id === e.hallId)) continue;
    const w = waveOf(e, project);
    // stream T4 (#2): accelerator compute-slot racks get their own line (chips stated; not counted as GPUs)
    if (RACK_CATS.has(item.category) && item.category === 'gpu-rack' && isAcceleratorSlotRack(e)) add(w, 'racks', item.id, S.acceleratorLine(item.name, item.compute?.gpus ?? 0), 1, 'ea', item.source, { variant: 'accelerator' });
    else if (RACK_CATS.has(item.category)) add(w, 'racks', item.id, item.name, 1, 'ea', item.source);
    else if (item.category === 'cdu' || item.category === 'crah' || item.category === 'fan-wall') {
      add(w, 'cooling', item.id, item.name, 1, 'ea', item.source);
      placedByCat.set(item.category === 'fan-wall' ? 'crah' : item.category, (placedByCat.get(item.category === 'fan-wall' ? 'crah' : item.category) ?? 0) + 1);
    } else if (item.category === 'rpp') add(w, 'pdus', item.id, item.name, 1, 'ea', item.source);
  }

  if (analysis) {
    const net = analysis.network;
    // switches: placed per rack (rackLoads) + unplaced
    for (const rl of net.rackLoads ?? []) {
      const w = waveOf(eqById.get(rl.rackId), project);
      for (const sw of rl.switches) {
        const item = findCatalogItem(sw.catalogId);
        add(w, 'switches', sw.catalogId, `${item?.name ?? sw.catalogId} — ${sw.role} (${sw.fabric})`, sw.count, 'ea', item?.source ?? 'estimate');
      }
    }
    for (const sw of net.unplacedSwitches ?? []) {
      const podEq = sw.podId ? project.equipment.find((e) => e.podId === sw.podId) : undefined;
      const w = waveOf(podEq, project);
      const item = findCatalogItem(sw.catalogId);
      add(w, 'switches', sw.catalogId, `${item?.name ?? sw.catalogId} — ${sw.role} (${sw.fabric}) ${S.unplaced}`, sw.count, 'ea', item?.source ?? 'estimate');
    }
    // cables by type and length bin; transceivers per type (2 per cable when optics are separate — mirrors the network engine)
    const types = new Map(cableTypes().map((t) => [t.id, t]));
    for (const r of net.cableRuns) {
      const from = eqById.get(r.fromId);
      const to = eqById.get(r.toId);
      const w = waveOf(from, project) !== COMMON_WAVE ? waveOf(from, project) : waveOf(to, project);
      const t = types.get(r.cableTypeId);
      const desc = t?.name ?? r.cableTypeId;
      add(w, 'cables', r.cableTypeId, desc, r.count, 'ea', t?.source ?? 'estimate', { lengthBin: lengthBin(r.lengthM), totalLengthM: r.count * r.lengthM });
      if (t && t.transceiverUSD > 0) add(w, 'transceivers', `${r.cableTypeId}-optic`, `${desc} — transceivers`, 2 * r.count, 'ea', t.source);
    }
    // unplaced CDU / CRAH units the cooling analysis still requires
    const ca = analysis.cooling;
    const cduItem = findCatalogItem(project.cooling.cduCatalogId);
    const crahItem = findCatalogItem(project.cooling.crahCatalogId);
    const cduExtra = ca.cdus.units - (placedByCat.get('cdu') ?? 0);
    const crahExtra = ca.crahs.units - (placedByCat.get('crah') ?? 0);
    if (cduItem && cduExtra > 0) add(COMMON_WAVE, 'cooling', cduItem.id, `${cduItem.name} ${S.unplaced}`, cduExtra, 'ea', cduItem.source);
    if (crahItem && crahExtra > 0) add(COMMON_WAVE, 'cooling', crahItem.id, `${crahItem.name} ${S.unplaced}`, crahExtra, 'ea', crahItem.source);
    // PDUs / RPPs from the power analysis (not placed on the floor in v1 layouts)
    const rppItem = findCatalogItem(project.power.rppCatalogId);
    const rppPlaced = [...lines.values()].filter((l) => l.group === 'pdus').reduce((s, l) => s + l.qty, 0);
    if (rppItem && analysis.power.rpps.units > rppPlaced) {
      const perPod = analysis.power.rppPerPod ?? [];
      let assigned = 0;
      for (const pp of perPod) {
        const podEq = project.equipment.find((e) => e.podId === pp.podId);
        const units = pp.runsPerPath * 2;
        add(waveOf(podEq, project), 'pdus', rppItem.id, rppItem.name, units, 'ea', rppItem.source);
        assigned += units;
      }
      const rest = analysis.power.rpps.units - rppPlaced - assigned;
      if (rest > 0) add(COMMON_WAVE, 'pdus', rppItem.id, rppItem.name, rest, 'ea', rppItem.source);
    }
  }

  // trays (metres) — only when the layout engine produced polylines
  if (project.trays?.length) {
    for (const t of project.trays) {
      const len = polylineLength(t.points);
      add(COMMON_WAVE, 'trays', `tray-${t.kind}-${t.widthM}`, S.tray(t.kind, String(t.widthM)), Math.round(len * 10) / 10, 'm', 'estimate');
    }
  } else notes.push(S.noTrays);

  // busways (metres) + tap-offs
  if (project.busways?.length) {
    for (const b of project.busways) {
      add(COMMON_WAVE, 'busways', `busway-${b.path}-${b.ampacityA}A`, `${S.busRun(b.path)} · ${b.ampacityA} A`, Math.round(polylineLength(b.points) * 10) / 10, 'm', 'estimate');
      for (const tap of b.tapoffs) add(waveOf(eqById.get(tap.equipmentId), project), 'tapoffs', 'busway-tapoff', S.tapoff, 1, 'ea', 'estimate');
    }
  } else if (project.power.distribution !== 'rpp') {
    notes.push(S.noBusways);
    for (const e of project.equipment) {
      const item = findCatalogItem(e.catalogId);
      if (item && RACK_CATS.has(item.category)) add(waveOf(e, project), 'tapoffs', 'busway-tapoff', S.tapoff, 2, 'ea', 'estimate');
    }
  }

  const groupOrder: BomGroup[] = ['racks', 'switches', 'cables', 'transceivers', 'trays', 'busways', 'tapoffs', 'cooling', 'pdus'];
  const waveOrder = [...waves.map((w) => w.id), COMMON_WAVE];
  const sorted = [...lines.values()].sort((a, b) =>
    (waveOrder.indexOf(a.waveId) - waveOrder.indexOf(b.waveId))
    || (groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group))
    || a.itemId.localeCompare(b.itemId)
    || (LENGTH_BINS.findIndex((x) => x.label === a.lengthBin) - LENGTH_BINS.findIndex((x) => x.label === b.lengthBin)),
  );
  // stream E (P5): standards columns from the catalog item (cables and synthetic lines carry none)
  for (const l of sorted) {
    if (l.group === 'cables' || l.group === 'transceivers') continue;
    const f = itemStandardsFields(findCatalogItem(l.itemId), locale);
    if (f.standard || f.implementationLevel) Object.assign(l, f);
  }
  return { waves, lines: sorted, notes };
}

// ───────────── reconciliation with the cost BOM (polish v2 2차, QA docs #3) ─────────────

/** why a line exists on one side only */
export type BomReconScope = 'shared' | 'facility-plant' | 'power-plant' | 'cooling-plant' | 'labour' | 'contingency' | 'allowance' | 'wave-only';

export interface BomReconRow {
  itemId: string;
  description: string;
  /** cost BOM domain (absent for wave-only lines) */
  domain?: BomLine['domain'];
  /** wave BOM group (absent for cost-only lines) */
  group?: BomGroup;
  unit: string;
  costQty?: number;
  waveQty?: number;
  costUSD: number;
  scope: BomReconScope;
}

export interface BomReconciliation {
  rows: BomReconRow[];
  /** Σ cost USD per scope; Σ over scopes = Σ analysis.cost.bom totalUSD */
  usdByScope: Partial<Record<BomReconScope, number>>;
  costTotalUSD: number;
  /** shared lines whose quantities differ */
  qtyMismatches: number;
}

const COST_SCOPE: Record<BomLine['domain'], BomReconScope> = { it: 'shared', network: 'shared', cabling: 'shared', power: 'power-plant', cooling: 'cooling-plant', facility: 'facility-plant', labor: 'labour', contingency: 'contingency' };
/** cost lines that price what the wave BOM itemises in metres / boxes (trays, busway, tap-offs) */
const ALLOWANCE_IDS = new Set(['cable-tray', 'elec-bos']);

/**
 * Line-by-line reconciliation of the deployment BOM with `analysis.cost.bom`: items present in both (IT racks, switches, cables,
 * transceivers, CDU / CRAH, RPP) are matched by item id and must agree in quantity; cost-only lines are facility plant (shell, fire,
 * BMS, containment), power and cooling plant, labour and contingency; wave-only lines (tray metres, busway runs, tap-offs) are
 * priced in the cost BOM as allowances. Σ costUSD over all rows equals the cost BOM total.
 */
export function reconcileBom(bom: WaveBom, costBom: readonly BomLine[]): BomReconciliation {
  const wave = new Map<string, { qty: number; unit: string; group: BomGroup; description: string }>();
  for (const l of bom.lines) {
    const cur = wave.get(l.itemId) ?? { qty: 0, unit: l.unit, group: l.group, description: l.description };
    cur.qty += l.qty;
    wave.set(l.itemId, cur);
  }
  const cost = new Map<string, { qty: number; usd: number; unit: string; domain: BomLine['domain']; description: string }>();
  for (const l of costBom) {
    const cur = cost.get(l.itemId) ?? { qty: 0, usd: 0, unit: l.unit, domain: l.domain, description: l.description };
    cur.qty += l.qty;
    cur.usd += l.totalUSD;
    cost.set(l.itemId, cur);
  }
  const rows: BomReconRow[] = [];
  let qtyMismatches = 0;
  for (const [itemId, c] of cost) {
    const w = wave.get(itemId);
    const scope: BomReconScope = w ? 'shared' : ALLOWANCE_IDS.has(itemId) ? 'allowance' : COST_SCOPE[c.domain] === 'shared' ? 'shared' : COST_SCOPE[c.domain];
    if (w && Math.abs(w.qty - c.qty) > 1e-6) qtyMismatches++;
    rows.push({ itemId, description: c.description, domain: c.domain, ...(w ? { group: w.group, waveQty: w.qty } : {}), unit: c.unit, costQty: c.qty, costUSD: c.usd, scope });
  }
  for (const [itemId, w] of wave) {
    if (cost.has(itemId)) continue;
    rows.push({ itemId, description: w.description, group: w.group, unit: w.unit, waveQty: w.qty, costUSD: 0, scope: 'wave-only' });
  }
  const order: BomReconScope[] = ['shared', 'facility-plant', 'power-plant', 'cooling-plant', 'labour', 'contingency', 'allowance', 'wave-only'];
  rows.sort((a, b) => order.indexOf(a.scope) - order.indexOf(b.scope) || a.itemId.localeCompare(b.itemId));
  const usdByScope: Partial<Record<BomReconScope, number>> = {};
  for (const r of rows) usdByScope[r.scope] = (usdByScope[r.scope] ?? 0) + r.costUSD;
  return { rows, usdByScope, costTotalUSD: costBom.reduce((s, l) => s + l.totalUSD, 0), qtyMismatches };
}

const csvCell = (v: string | number | undefined) => {
  if (v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function waveBomCsv(bom: WaveBom): string {
  const header = ['wave', 'waveName', 'group', 'itemId', 'description', 'lengthBin', 'qty', 'unit', 'totalLengthM', 'source', 'standard', 'standardVersion', 'specStatus', 'implementationLevel', 'verification'];
  return [header.join(','), ...bom.lines.map((l) => [l.waveId, l.waveName, l.group, l.itemId, l.description, l.lengthBin, l.qty, l.unit, l.totalLengthM !== undefined ? Math.round(l.totalLengthM) : '', l.source, l.standard, l.standardVersion, l.specStatus, l.implementationLevel, l.verification].map(csvCell).join(','))].join('\n') + '\n';
}

export function waveBomMarkdown(project: Project, analysis: ProjectAnalysis | null, bom: WaveBom, locale: Locale = 'en'): string {
  const S = deployStrings(locale);
  const { n } = makeFormatters(locale);
  const out: string[] = [`# ${S.bomTitle(project.name)}`, '', S.bomIntro, ''];
  const src = (s: SpecSource) => S.sourceLabel[s] ?? s;
  const eqById = new Map(project.equipment.map((e) => [e.id, e]));
  // summary
  const waveIds = [...bom.waves.map((w) => w.id), COMMON_WAVE];
  const sumRows = waveIds.map((wid) => {
    const ls = bom.lines.filter((l) => l.waveId === wid);
    const q = (g: BomGroup) => ls.filter((l) => l.group === g).reduce((s, l) => s + l.qty, 0);
    const eqs = project.equipment.filter((e) => waveOf(e, project) === wid);
    const counts = eqs.reduce((s, e) => { const c = computeCountsOf(e, findCatalogItem(e.catalogId)); return { gpus: s.gpus + c.gpus, acc: s.acc + c.accelerators }; }, { gpus: 0, acc: 0 });
    const kw = eqs.reduce((s, e) => { const it = findCatalogItem(e.catalogId); return s + (it && RACK_CATS.has(it.category) ? (it.power?.nameplateKW ?? 0) * (e.loadFactor ?? 1) : 0); }, 0);
    return [wid === COMMON_WAVE ? S.common : bom.waves.find((w) => w.id === wid)?.name ?? wid, n(q('racks')), n(counts.gpus), n(counts.acc), n(q('switches')), n(q('cables')), n(q('transceivers')), n(q('cooling')), n(kw)];
  });
  const C = S.summaryCols;
  out.push(`## ${S.summaryTitle}`, '', mdTable([C.wave, C.racks, C.gpus, C.accelerators, C.switches, C.cables, C.optics, C.cooling, C.kw], sumRows), '');
  for (const wid of waveIds) {
    const ls = bom.lines.filter((l) => l.waveId === wid);
    if (!ls.length) continue;
    const w = bom.waves.find((x) => x.id === wid);
    out.push(`## ${w ? w.name : S.common}`, '');
    if (w) out.push(`- ${S.pods}: ${w.podIds.join(', ') || '-'}`, `- ${S.target}: ${w.targetReadyDate ?? '-'}`, '');
    const groups = [...new Set(ls.map((l) => l.group))];
    for (const g of groups) {
      const gl = ls.filter((l) => l.group === g);
      out.push(`### ${S.groups[g]}`, '');
      if (g === 'cables') out.push(mdTable([S.item, S.lengthBin, S.qty, S.totalLength, S.source], gl.map((l) => [l.description, l.lengthBin ?? '', n(l.qty), `${n(l.totalLengthM ?? 0)} m`, src(l.source)])), '');
      else out.push(mdTable([S.item, S.qty, S.unit, S.source], gl.map((l) => [l.description, n(l.qty, l.unit === 'm' ? 1 : 0), l.unit, src(l.source)])), '');
    }
  }
  // totals
  const totals = new Map<string, { description: string; qty: number; unit: string; group: BomGroup }>();
  for (const l of bom.lines) {
    const k = `${l.group}|${l.itemId}`;
    const cur = totals.get(k) ?? { description: l.description.replace(` ${S.unplaced}`, ''), qty: 0, unit: l.unit, group: l.group };
    cur.qty += l.qty;
    totals.set(k, cur);
  }
  out.push(`## ${S.totalsTitle}`, '', mdTable([S.group, S.item, S.qty, S.unit], [...totals.values()].map((t) => [S.groups[t.group], t.description, n(t.qty, t.unit === 'm' ? 1 : 0), t.unit])), '');
  if (bom.notes.length) out.push(...bom.notes.map((x) => `> ${x}`), '');
  void eqById;
  void analysis;
  return out.join('\n');
}
