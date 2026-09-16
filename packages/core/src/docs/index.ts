// Technical design document generator — locale-aware structured blocks rendered to Markdown (internal / tests) and to
// printable HTML with core SVG diagrams (docs/html.ts, the user-facing deliverable — DECISIONS-v2-2 F5).
//
// Chapter order follows the structure common to public vendor data-center design guides (AMD, NVIDIA and others):
//   1 Overview / challenges / goals → 2 Site & floor system → 3 Physical layout & cooling strategy → 4 Network →
//   5 Control plane → 6 Storage → 7 Power supply → 8 Power resiliency → 9 BOM & power estimate →
//   10 Deployment & acceptance → 11 Assumptions & sources.
// Every section of the v0.1 Korean document is preserved and mapped into this order; strings live in
// strings.en.ts / strings.ko.ts (DECISIONS-v2 #10: English default, Korean selectable).
//
// `buildDesignDocumentBlocks` is the single source of content. `generateDesignDocument` renders the blocks to the
// same Markdown as before the block refactor (byte-identical, mermaid diagrams included); the HTML renderer swaps
// the diagram blocks for inline SVG and adds the drawing-sheet figures (blocks with no Markdown form).
import { cableTypes, findCatalogItem } from '../catalog/catalog.ts';
import type { CatalogItem, DocSection, Locale, Project, ProjectAnalysis, SpecSource } from '../model/types.ts';
import { EN, type DocStrings } from './strings.en.ts';
import { KO } from './strings.ko.ts';
import { standardsBasisBlocks } from './standardsBasis.ts';

export type { DocStrings } from './strings.en.ts';

export interface DesignDocOptions {
  /** deliverable language (default 'en'; falls back to project.locale when omitted) */
  locale?: Locale;
  includeBom?: boolean;
  thermal?: { maxInletC: number; rciHi: number; rti: number };
}

/** Chapter ids in document order (used by the docs panel outline and tests). */
export const DOC_CHAPTERS = ['overview', 'site', 'layout', 'network', 'control', 'storage', 'power', 'resiliency', 'bom', 'deploy', 'sources'] as const;
export type DocChapter = (typeof DOC_CHAPTERS)[number];

/** Where each v0.1 DesignNote section is rendered in the v2 chapter order. */
export const NOTE_CHAPTER: Record<DocSection, DocChapter> = {
  overview: 'overview', workload: 'overview', site: 'site', space: 'layout', cooling: 'layout', network: 'network',
  power: 'power', cost: 'bom', schedule: 'deploy', risk: 'deploy',
};

export function docStrings(locale: Locale = 'en'): DocStrings {
  return locale === 'ko' ? KO : EN;
}

/** Locale-aware number formatting shared by the document and deployment generators. */
export function makeFormatters(locale: Locale = 'en') {
  const tag = locale === 'ko' ? 'ko-KR' : 'en-US';
  const n = (v: number | undefined, digits = 0) => (v === undefined || !Number.isFinite(v) ? '-' : v.toLocaleString(tag, { maximumFractionDigits: digits, minimumFractionDigits: digits }));
  const usdM = (v: number) => `$${n(v / 1e6, 1)}M`;
  const pct = (v: number, digits = 0) => `${n(v * 100, digits)}%`;
  return { n, usdM, pct };
}

const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function mdTable(headers: string[], rows: (string | number)[][]): string {
  const head = `| ${headers.map(esc).join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${r.map((c) => esc(String(c))).join(' | ')} |`);
  return [head, sep, ...body].join('\n');
}

const mid = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_');
const mlabel = (s: string) => s.replace(/"/g, "'");
const ganttName = (s: string) => s.replace(/[:;#]/g, ' ').replace(/\s+/g, ' ').trim();

// ───────────────────────────── block model ─────────────────────────────

export type DocDiagramKind = 'topology' | 'one-line' | 'gantt';

export type DocBlock =
  | { k: 'blank' }
  | { k: 'h'; level: 1 | 2 | 3 | 4; text: string; chapter?: DocChapter }
  /** generator-authored paragraph (may carry **bold** / _italic_ / leading "> " note) */
  | { k: 'p'; text: string }
  /** author-written note body (plain text, may span lines) */
  | { k: 'user'; text: string }
  | { k: 'li'; text: string }
  | { k: 'table'; headers: string[]; rows: (string | number)[][] }
  | { k: 'diagram'; kind: DocDiagramKind; md: string[] }
  /** HTML-only: drawing sheets embedded as figures (no Markdown form) */
  | { k: 'sheets'; hallId?: string };

export interface DesignDocument {
  locale: Locale;
  title: string;
  blocks: DocBlock[];
}

/** Markdown rendering of the blocks (the pre-refactor generator output, byte for byte). */
export function renderBlocksMarkdown(blocks: DocBlock[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    switch (b.k) {
      case 'blank': out.push(''); break;
      case 'h': out.push(`${'#'.repeat(b.level)} ${b.text}`); break;
      case 'p': case 'user': out.push(b.text); break;
      case 'li': out.push(`- ${b.text}`); break;
      case 'table': out.push(mdTable(b.headers, b.rows)); break;
      case 'diagram': out.push(...b.md); break;
      case 'sheets': break;
    }
  }
  return out.join('\n') + '\n';
}

export function buildDesignDocumentBlocks(project: Project, analysis: ProjectAnalysis, opts: DesignDocOptions = {}): DesignDocument {
  const locale: Locale = opts.locale ?? project.locale ?? 'en';
  const S = docStrings(locale);
  const { n, usdM, pct } = makeFormatters(locale);
  const includeBom = opts.includeBom ?? true;
  const a = analysis;
  const B: DocBlock[] = [];
  const blank = () => B.push({ k: 'blank' });
  const h = (level: 1 | 2 | 3 | 4, text: string, chapter?: DocChapter) => B.push(chapter ? { k: 'h', level, text, chapter } : { k: 'h', level, text });
  const p = (text: string) => B.push({ k: 'p', text });
  const li = (text: string) => B.push({ k: 'li', text });
  const table = (headers: string[], rows: (string | number)[][]) => B.push({ k: 'table', headers, rows });
  const notes = (chapter: DocChapter) => {
    for (const note of project.notes.filter((x) => NOTE_CHAPTER[x.section] === chapter)) {
      blank();
      h(3, note.title);
      blank();
      B.push({ k: 'user', text: note.body });
    }
  };
  const hallName = (id: string) => project.halls.find((x) => x.id === id)?.name ?? id;
  const src = (s: SpecSource) => S.sourceLabel[s] ?? s;
  const catOf = (id: string) => findCatalogItem(id)?.category;
  const title = S.docTitle(project.name);

  h(1, title);
  blank();
  table([S.meta.item, S.meta.value], [
    [S.meta.client, project.client ?? S.meta.na],
    [S.meta.author, project.author ?? S.meta.na],
    [S.meta.generated, a.generatedAt.slice(0, 19).replace('T', ' ')],
    [S.meta.projectId, project.id],
  ]);

  // ───────── 1. Overview, challenges & goals ─────────
  blank(); h(2, S.chapters.overview, 'overview'); blank(); p(project.description); blank();
  table([S.overview.metric, S.overview.value], [
    [S.overview.halls, a.summary.halls],
    [S.overview.racks, `${n(a.summary.racks)} (${n(a.summary.gpuRacks)})`],
    [S.overview.gpus, n(a.summary.gpus)],
    [S.overview.itLoad, `${n(a.summary.itMW, 2)} MW`],
    [S.overview.facility, `${n(a.summary.facilityMW, 2)} MW`],
    [S.overview.pue, `${n(a.power.pue, 3)} / ${n(a.power.designPue, 3)}`],
    [S.overview.capex, usdM(a.summary.capexUSD)],
    [S.overview.capexPerGpu, `$${n(a.cost.usdPerGpu)}`],
    [S.overview.rfs, a.summary.readyForService],
    [S.overview.issues, S.overview.issuesVal(a.summary.errors, a.summary.warnings)],
  ]);
  // challenges (derived from the analysis)
  const maxRackKW = project.equipment.reduce((m, e) => Math.max(m, findCatalogItem(e.catalogId)?.power?.nameplateKW ?? 0), 0);
  const totalArea = project.halls.reduce((s, x) => s + x.width * x.depth, 0);
  const totalHeat = a.cooling.liquidHeatKW + a.cooling.airHeatKW;
  const liqShare = totalHeat > 0 ? a.cooling.liquidHeatKW / totalHeat : 0;
  const cableCount = a.network.cablesByType.reduce((s, x) => s + x.count, 0);
  const longest = a.network.cableRuns.reduce((m, r) => Math.max(m, r.lengthM), 0);
  const maxFloor = a.space.reduce((m, s) => Math.max(m, s.maxFloorLoadKgPerM2), 0);
  blank(); h(3, S.overview.challengesTitle); blank(); p(S.overview.challengesIntro); blank();
  li(S.overview.chDensity(n(maxRackKW), n(totalArea > 0 ? (a.power.itDesignKW / totalArea) : 0, 1)));
  li(S.overview.chCooling(pct(liqShare), pct(1 - liqShare)));
  li(S.overview.chSpace(a.summary.racks, n(maxFloor)));
  li(S.overview.chCable(n(cableCount), n(longest)));
  li(S.overview.chOps);
  // goals — target workloads (v0.1 §7)
  blank(); h(3, S.overview.goalsTitle); blank(); p(S.overview.goalsIntro); blank();
  const W = S.overview.wl;
  for (const wl of a.workloads) {
    const bp = project.workloads.find((w) => w.id === wl.workloadId);
    h(4, bp?.name ?? wl.workloadId); blank();
    const rows: (string | number)[][] = [[W.gpus, n(wl.gpus)]];
    if (wl.tokensPerSec !== undefined) {
      rows.push([W.step, `${n(wl.stepTimeS, 2)} s (${n(wl.computeTimeS, 2)} / ${n(wl.commTimeS, 2)})`]);
      rows.push([W.throughput, `${n(wl.tokensPerSec)} ${W.tps}`]);
      rows.push([W.mfu, pct(wl.mfu ?? 0, 1)]);
      rows.push([W.goodput, pct(wl.goodput ?? 0, 1)]);
      rows.push([W.ttt, `${n(wl.timeToTrainDays, 1)} ${W.days}`]);
    }
    if (wl.gpusRequired !== undefined) {
      rows.push([W.gpusReq, n(wl.gpusRequired)]);
      rows.push([W.maxReq, `${n(wl.maxRequestsPerSec)} ${W.rps}`]);
      rows.push([W.ttft, `${n(wl.ttftMs)} ms / ${n(wl.tpotMs, 1)} ms`]);
    }
    rows.push([W.power, `${n(wl.avgPowerKW)} / ${n(wl.peakPowerKW)} kW`]);
    rows.push([W.energy(bp?.durationDays ?? '-'), `${n(wl.energyMWh)} MWh · ${usdM(wl.energyCostUSD)}`]);
    if (wl.tokensPerKWh !== undefined) rows.push([W.eff, `${n(wl.tokensPerKWh)} ${W.tpkwh}`]);
    table([W.metric, W.value], rows); blank();
    for (const note of locale === 'ko' ? wl.notes : (wl.notesEn ?? wl.notes)) li(note);
    blank();
  }
  notes('overview');

  // ───────── 2. Site & floor system ─────────
  const s = project.site;
  blank(); h(2, S.chapters.site, 'site'); blank();
  table([S.site.item, S.site.value], [
    [S.site.site, `${s.name} (${s.location})`],
    [S.site.elevation, `${n(s.elevationM)} m`],
    [S.site.designAmbient, `${s.climate.designDryBulbC} °C / ${s.climate.designWetBulbC} °C`],
    [S.site.annualMean, `${s.climate.annualMeanC} °C`],
    [S.site.econHours, `${n(s.climate.economizerHours)} ${S.site.hPerYear}`],
    [S.site.tariff, `$${s.electricityUSDPerKWh}/kWh`],
    [S.site.carbon, `${s.carbonKgPerKWh} kgCO₂/kWh`],
    [S.site.profile, S.power.profileVal[s.powerProfile ?? 'iec']],
    [S.site.growth, S.site.growthVal[project.growth ?? 'phased']],
  ]);
  const floorOf = (x: Project['halls'][number]) => (x.raisedFloorHeight > 0 ? S.site.floorRaised(n(x.raisedFloorHeight, 2)) : S.site.floorSlab);
  blank(); h(3, S.site.floorTitle); blank(); p(S.site.floorIntro); blank();
  for (const x of project.halls) li(`${x.name}: ${floorOf(x)}`);
  blank(); h(3, S.site.hallsTitle); blank();
  table([S.site.hall, S.site.size, S.site.area, S.site.height, S.site.floorLoad, S.site.itBudget, S.site.coolingBudget, S.site.floorSystem], project.halls.map((x) => [
    x.name,
    `${n(x.width, 1)} × ${n(x.depth, 1)} m`,
    `${n(x.width * x.depth)} m²`,
    `${x.clearHeight} m / ${x.ceilingPlenumHeight} m`,
    `${n(x.floorLoadingKgPerM2)} kg/m²`,
    `${n(x.itPowerBudgetKW)} kW`,
    `${n(x.liquidCoolingBudgetKW)} / ${n(x.airCoolingBudgetKW)} kW`,
    floorOf(x),
  ]));
  blank(); h(3, S.site.spaceTitle); blank();
  table([S.site.hall, S.site.rackCount, S.site.gpuCount, S.site.occupied, S.site.utilisation, S.site.density, S.site.maxLoad, S.site.violations], a.space.map((sp) => [
    hallName(sp.hallId), n(sp.rackCount), n(sp.gpuCount), `${n(sp.occupiedM2)} m²`, pct(sp.whiteSpaceUtilization), `${n(sp.itDensityKWPerM2, 1)} kW/m²`, `${n(sp.maxFloorLoadKgPerM2)} kg/m²`, sp.clearanceViolations,
  ]));
  const keepouts = project.halls.flatMap((x) => x.keepouts.map((k) => [x.name, k.label ?? k.id, k.kind, `${n(k.rect.w, 1)} × ${n(k.rect.d, 1)} m @ (${n(k.rect.x, 1)}, ${n(k.rect.y, 1)})`]));
  if (keepouts.length) { blank(); h(3, S.site.keepoutTitle); blank(); table([S.site.hall, S.site.keepout, S.site.kind, S.site.sizePos], keepouts); }
  notes('site');

  // ───────── 3. Physical layout & cooling strategy ─────────
  blank(); h(2, S.chapters.layout, 'layout'); blank(); h(3, S.layout.patternTitle); blank();
  const hacs = project.containments.filter((x) => x.kind === 'hot-aisle');
  const cacs = project.containments.filter((x) => x.kind === 'cold-aisle');
  if (hacs.length) li(S.layout.patternHac(hacs.length, hacs.filter((x) => x.roof).length, hacs.filter((x) => x.ductedToPlenum).length));
  if (cacs.length) li(S.layout.patternCac(cacs.length));
  if (!project.containments.length) li(S.layout.patternNone);
  const sp = project.network.scaleOut.spinePlacement as keyof typeof S.layout.placementVal;
  li(S.layout.spinePlacement(S.layout.placementVal[sp] ?? String(sp), !!project.network.scaleOut.separateRoom));
  const counts = new Map<string, { item: CatalogItem | undefined; byHall: Map<string, number> }>();
  for (const e of project.equipment) {
    const cc = counts.get(e.catalogId) ?? { item: findCatalogItem(e.catalogId), byHall: new Map() };
    cc.byHall.set(e.hallId, (cc.byHall.get(e.hallId) ?? 0) + 1);
    counts.set(e.catalogId, cc);
  }
  blank(); h(3, S.layout.equipmentTitle); blank();
  table([S.layout.equipment, S.layout.category, ...project.halls.map((x) => x.name)], [...counts.entries()].map(([id, cc]) => [cc.item?.name ?? id, cc.item?.category ?? '-', ...project.halls.map((x) => cc.byHall.get(x.id) ?? 0)]));
  B.push({ k: 'sheets' });
  const c = a.cooling;
  const cd = project.cooling;
  blank(); h(3, S.layout.strategyTitle); blank(); p(S.layout.strategyIntro(n(c.liquidHeatKW), n(c.airHeatKW))); blank();
  table([S.layout.designTemp, S.site.value], [
    [S.layout.fws, `${cd.fwsSupplyC} / ${cd.fwsReturnC} °C`],
    [S.layout.tcs, `${cd.tcsSupplyC} °C`],
    [S.layout.supplyAir, `${cd.supplyAirC} °C`],
    [S.layout.rejection, `${S.layout.rejectionVal[cd.heatRejection] ?? cd.heatRejection}${cd.economizer ? S.layout.economizer : ''}`],
  ]);
  blank(); h(3, S.layout.balanceTitle); blank();
  table([S.site.item, S.site.value], [
    [S.layout.liquidHeat, `${n(c.liquidHeatKW)} kW`],
    [S.layout.airHeat, `${n(c.airHeatKW)} kW`],
    [S.layout.cdu, S.layout.cduVal(c.cdus.units, n(c.cdus.unitKW), cd.cduRedundancy, n(c.cdus.tcsFlowLpm))],
    [S.layout.crah, S.layout.crahVal(c.crahs.units, n(c.crahs.unitKW), cd.crahRedundancy, n(c.crahs.airflowM3s, 1), n(c.crahs.requiredAirflowM3s, 1))],
    [S.layout.chiller, S.layout.unitVal(c.chillers.units, n(c.chillers.unitKW), n(c.chillers.requiredKW))],
    [S.layout.dryCooler, c.dryCoolers ? S.layout.unitVal(c.dryCoolers.units, n(c.dryCoolers.unitKW), n(c.dryCoolers.requiredKW)) : '-'],
    [S.layout.fwsFlow, `${n(c.fwsFlowLpm)} LPM`],
    [S.layout.pumpFanComp, `${n(c.pumpKW)} / ${n(c.fanKW)} / ${n(c.chillerKW)} kW`],
    [S.layout.annualMech, `${n(c.annualMechanicalKW)} kW`],
    [S.layout.ppue, n(c.partialPue, 3)],
    [S.layout.wue, `${n(c.wueLPerKWh, 3)} L/kWh`],
  ]);
  if (c.perPod?.length) {
    blank();
    table([S.layout.pod, S.layout.podLiquid, S.layout.podCdu, S.layout.podCap], c.perPod.slice(0, 30).map((x) => [x.podId, `${n(x.liquidKW)} kW`, `${x.cdusPlaced} / ${x.cdusRequired}`, `${n(x.cduCapacityKW)} kW`]));
  }
  if (opts.thermal) {
    blank(); h(3, S.layout.cfdTitle); blank();
    table([S.overview.metric, S.overview.value], [
      [S.layout.maxInlet, `${n(opts.thermal.maxInletC, 1)} °C`],
      [S.layout.rci, pct(opts.thermal.rciHi / 100, 0)],
      [S.layout.rti, pct(opts.thermal.rti / 100, 0)],
    ]);
  }
  notes('layout');

  // ───────── 4. Network ─────────
  const net = a.network;
  const nd = project.network;
  blank(); h(2, S.chapters.network, 'network'); blank(); h(3, S.network.typesTitle); blank(); p(S.network.typesIntro); blank();
  li(S.network.scaleOut(nd.scaleOut.fabric, S.network.topoVal[nd.scaleOut.topology] ?? nd.scaleOut.topology, String(nd.scaleOut.oversubscription)));
  li(S.network.frontend(nd.frontend.fabric, String(nd.frontend.oversubscription), nd.frontend.enabled));
  li(S.network.storage(nd.storage.fabric, String(nd.storage.oversubscription), nd.storage.enabled));
  li(S.network.oob(nd.oob.fabric, nd.oob.enabled));
  blank(); h(3, S.network.topoTitle); blank(); p(nd.scaleOut.topology === 'rail-optimized' ? S.network.topoRail : S.network.topoTree); blank();
  {
    const md: string[] = ['```mermaid', 'flowchart BT'];
    net.fabrics.forEach((f, fi) => {
      const sw = findCatalogItem(f.switchCatalogId);
      md.push(`  subgraph F${fi}["${mlabel(f.name)}"]`);
      md.push(`    F${fi}_ep(["${mlabel(S.network.endpointLinks(n(f.endpoints)))}"])`);
      f.tiers.forEach((t, ti) => md.push(`    F${fi}_t${ti}["${mlabel(t.name)} × ${n(t.switches)}<br/>${mlabel(sw?.model ?? f.switchCatalogId)}"]`));
      if (f.tiers.length) md.push(`    F${fi}_ep --> F${fi}_t0`);
      for (let ti = 1; ti < f.tiers.length; ti++) md.push(`    F${fi}_t${ti - 1} --> F${fi}_t${ti}`);
      md.push('  end');
    });
    md.push('```');
    B.push({ k: 'diagram', kind: 'topology', md });
  }
  blank();
  const pods = new Set(project.equipment.filter((e) => e.podId && catOf(e.catalogId) === 'gpu-rack').map((e) => e.podId));
  h(3, S.network.suTitle); blank(); p(S.network.suIntro(pods.size, a.summary.gpuRacks, a.summary.gpus)); blank();
  h(3, S.network.osTitle); blank(); p(S.network.osIntro); blank(); p(S.network.osProject(nd.scaleOut.oversubscription, nd.frontend.oversubscription, nd.storage.oversubscription)); blank();
  table([S.network.fabric, S.network.endpoints, S.network.tiers, S.network.switches, S.network.os, S.network.bisection, S.network.hops, S.network.power, S.network.racks], net.fabrics.map((f) => [
    f.name, n(f.endpoints), f.tiers.map((t) => `${t.name} ${t.switches}`).join(' / '), n(f.totalSwitches), `${f.oversubscription}:1`, `${n(f.bisectionGbps / 1000, 1)} Tbps`, f.maxHops, `${n(f.powerKW, 1)} kW`, f.racksNeeded,
  ]));
  blank(); h(3, S.network.cableTitle); blank();
  table([S.network.cableType, S.network.qty, S.network.totalLen, S.network.avgLen, S.network.optics], net.cablesByType.map((x) => {
    const t = cableTypes().find((ct) => ct.id === x.cableTypeId);
    return [t?.name ?? x.cableTypeId, n(x.count), `${n(x.totalLengthM)} m`, `${n(x.totalLengthM / Math.max(1, x.count), 1)} m`, n(x.transceivers)];
  }));
  blank(); li(S.network.commEff(pct(net.commEfficiency)));
  li(S.network.optPower(n(net.transceiverKW, 1), usdM(net.costUSD)));
  notes('network');

  // ───────── 5. Control plane ─────────
  blank(); h(2, S.chapters.control, 'control'); blank(); p(S.control.intro); blank();
  for (const it of S.control.items) li(it);
  const mgmtRacks = project.equipment.filter((e) => catOf(e.catalogId) === 'mgmt-rack' || e.networkRole === 'oob').length;
  blank(); p(S.control.racks(mgmtRacks, nd.oob.enabled));
  notes('control');

  // ───────── 6. Storage ─────────
  blank(); h(2, S.chapters.storage, 'storage'); blank(); p(S.storage.intro); blank();
  const storageRacks = project.equipment.filter((e) => catOf(e.catalogId) === 'storage-rack');
  const usableTB = storageRacks.reduce((sum, e) => sum + (findCatalogItem(e.catalogId)?.storage?.usableTB ?? 0), 0);
  const storageGBps = storageRacks.reduce((sum, e) => sum + (findCatalogItem(e.catalogId)?.storage?.throughputGBps ?? 0), 0);
  li(S.storage.racks(storageRacks.length, n(usableTB), n(storageGBps)));
  if (a.summary.gpus > 0 && storageGBps > 0) li(S.storage.perGpu(n(storageGBps / a.summary.gpus, 1)));
  li(S.storage.network(nd.storage.enabled, nd.storage.fabric, nd.storage.oversubscription));
  li(S.storage.federated);
  notes('storage');

  // ───────── 7. Power supply ─────────
  const pw = a.power;
  blank(); h(2, S.chapters.power, 'power'); blank(); h(3, S.power.feedTitle); blank();
  table([S.power.feed, S.power.voltage, S.power.capacity, S.power.substation, S.power.available], s.utility.map((f) => [f.name, `${f.voltageKV} kV`, `${n(f.capacityMVA, 1)} MVA`, f.substation, f.availableFrom]));
  blank(); li(S.power.required(n(pw.utilityRequiredMVA, 1)));
  li(S.power.firm(n(pw.utilityTotalMVA, 1), n(pw.utilityAvailableMVA, 1)));
  blank(); h(3, S.power.loadTitle); blank();
  table([S.power.load, S.power.kw], [
    [S.power.nameplate, n(pw.itNameplateKW)],
    [S.power.design(project.power.diversityFactor), n(pw.itDesignKW)],
    [S.power.peak, n(pw.itPeakKW)],
    [S.power.network, n(pw.networkKW)],
    [S.power.mechanical, n(pw.mechanicalKW)],
    [S.power.losses, n(pw.lossesKW)],
    [S.power.total, `**${n(pw.facilityKW)}**`],
  ]);
  blank(); table([S.power.hall, S.power.itLoad, S.power.budget, S.power.util], pw.perHall.map((x) => [hallName(x.hallId), `${n(x.itKW)} kW`, `${n(x.budgetKW)} kW`, Number.isFinite(x.utilization) ? pct(x.utilization) : '∞']));
  blank(); h(3, S.power.distTitle); blank(); p(S.power.dist(project.power.distributionVoltageV, S.power.distVal[project.power.distribution], S.power.profileVal[s.powerProfile ?? 'iec'])); blank();
  h(4, S.power.oneLine); blank();
  {
    const md: string[] = ['```mermaid', 'flowchart TB'];
    for (const node of pw.oneLine.nodes) md.push(`  ${mid(node.id)}["${mlabel(node.label)}"]`);
    for (const e of pw.oneLine.edges) md.push(`  ${mid(e.from)} --> ${mid(e.to)}`);
    md.push('```');
    B.push({ k: 'diagram', kind: 'one-line', md });
  }
  notes('power');

  // ───────── 8. Power resiliency ─────────
  blank(); h(2, S.chapters.resiliency, 'resiliency'); blank(); p(S.resiliency.intro); blank();
  table([S.resiliency.system, S.resiliency.redundancy, S.resiliency.units, S.resiliency.unitCap, S.resiliency.installed, S.resiliency.required], [
    [S.resiliency.ups, project.power.upsRedundancy, pw.ups.units, `${n(pw.ups.unitKVA)} kVA`, `${n(pw.ups.installedKVA)} kVA`, `${n(pw.ups.requiredKVA)} kVA`],
    [S.resiliency.generator, project.power.generatorRedundancy, pw.generators.units, `${n(pw.generators.unitKW)} kW`, `${n(pw.generators.installedKW)} kW`, `${n(pw.generators.requiredKW)} kW`],
    [S.resiliency.transformer, project.power.transformerRedundancy, pw.transformers.units, `${n(pw.transformers.unitKVA)} kVA`, `${n(pw.transformers.installedKVA)} kVA`, `${n(pw.transformers.requiredKVA)} kVA`],
    [project.power.distribution === 'rpp' ? S.resiliency.rpp : S.resiliency.busway, 'A/B', pw.rpps.units, `${n(pw.rpps.unitKW)} kW`, '-', S.resiliency.maxLoading(pct(pw.rpps.maxLoading))],
  ]);
  blank(); h(3, S.resiliency.strategiesTitle); blank();
  li(S.resiliency.battery(project.power.batteryMinutes));
  li(S.resiliency.mechUps(project.power.mechanicalOnUps));
  li(S.resiliency.smoothing[project.power.powerSmoothing]);
  li(S.resiliency.peak(n(pw.itPeakKW), n(pw.itDesignKW)));
  li(S.resiliency.firm);
  notes('resiliency');

  // ───────── 9. BOM & power estimate ─────────
  const cost = a.cost;
  blank(); h(2, S.chapters.bom, 'bom'); blank();
  table([S.bom.domain, S.bom.amount, S.bom.share], Object.entries(cost.byDomain).map(([k, v]) => [S.bom.domainLabel[k as keyof typeof S.bom.domainLabel] ?? k, usdM(v), pct(cost.capexUSD > 0 ? v / cost.capexUSD : 0, 1)]));
  const krw = n((cost.capexUSD * project.pricing.fxKRWPerUSD) / 1e8, 0);
  blank();
  table([S.bom.metric, S.bom.value], [
    [S.bom.capex, usdM(cost.capexUSD)],
    [S.bom.opex, usdM(cost.opexUSDPerYear)],
    [S.bom.energy, `${n(cost.energyMWhPerYear)} MWh`],
    [S.bom.tco, usdM(cost.tcoUSD5y)],
    [S.bom.perGpu, `$${n(cost.usdPerGpu)}`],
    [S.bom.perMw, usdM(cost.usdPerMWIT)],
    [S.bom.fx, S.bom.fxVal(krw, project.pricing.fxKRWPerUSD, project.pricing.currency === 'KRW')],
  ]);
  blank(); h(3, S.bom.estimateTitle); blank(); p(S.bom.estimateIntro(n(pw.itDesignKW), n(pw.facilityKW), n((pw.avgFacilityKW ?? pw.facilityKW) * 0.85), n(cost.energyMWhPerYear)));
  if (includeBom) {
    blank(); h(3, S.bom.detailTitle); blank();
    table([S.bom.domain, S.bom.item, S.bom.qty, S.bom.unit, S.bom.unitPrice, S.bom.total, S.bom.leadTime, S.bom.source], cost.bom.map((l) => [
      S.bom.domainLabel[l.domain] ?? l.domain, l.description, n(l.qty, l.unit === 'lot' ? 2 : 0), l.unit, `$${n(l.unitUSD)}`, usdM(l.totalUSD), l.leadTimeWeeks ? `${l.leadTimeWeeks} ${S.bom.weeks}` : '-', src(l.source),
    ]));
  }
  blank(); p(S.bom.deployNote);
  notes('bom');

  // ───────── 10. Deployment & acceptance ─────────
  const sch = a.schedule;
  blank(); h(2, S.chapters.deploy, 'deploy'); blank();
  table([S.deploy.milestone, S.deploy.date], sch.milestones.map((m) => [m.name, m.date]));
  blank();
  {
    const md: string[] = ['```mermaid', 'gantt', '  dateFormat YYYY-MM-DD', `  title ${ganttName(project.name)}`, '  axisFormat %Y-%m'];
    const phases = [...new Set(sch.tasks.map((t) => t.phase))];
    for (const ph of phases) {
      md.push(`  section ${S.deploy.phase[ph]}`);
      for (const t of sch.tasks.filter((x) => x.phase === ph)) md.push(`  ${ganttName(t.name)} :${t.critical ? 'crit, ' : ''}${mid(t.id)}, ${t.start}, ${t.end}`);
    }
    md.push('```');
    B.push({ k: 'diagram', kind: 'gantt', md });
  }
  blank();
  h(4, S.deploy.ramp); blank(); table([S.deploy.date, S.deploy.cumGpus, S.deploy.cumIt], sch.capacityRamp.map((r) => [r.date, n(r.gpus), `${n(r.itKW)} kW`]));
  blank(); li(S.deploy.critical(sch.tasks.filter((t) => t.critical).map((t) => t.name).join(' → ') || '-'));
  li(S.deploy.labor(n(sch.totalLaborHours), Object.entries(project.schedule.crews).map(([k, v]) => `${k} ${v}`).join(', '), project.schedule.crewSize, project.schedule.workDaysPerWeek, project.schedule.hoursPerDay));
  blank(); h(3, S.deploy.issuesTitle); blank();
  if (a.issues.length === 0) p(S.deploy.noIssues);
  else {
    const en = locale !== 'ko';
    if (en && a.issues.some((i) => !i.messageEn)) { p(S.deploy.issuesLangNote); blank(); }
    table([S.deploy.severity, S.deploy.domain, S.deploy.message, S.deploy.suggestion], a.issues.map((i) => [S.deploy.sev[i.severity], i.domain, en ? (i.messageEn ?? i.message) : i.message, en ? (i.suggestionEn ?? i.suggestion ?? '-') : (i.suggestion ?? '-')]));
  }
  blank(); h(3, S.deploy.acceptanceTitle); blank();
  for (const it of S.deploy.acceptance) li(it);
  notes('deploy');

  // ───────── 11. Assumptions & sources ─────────
  blank(); h(2, S.chapters.sources, 'sources'); blank();
  const used = new Map<string, CatalogItem>();
  const addUsed = (id: string | undefined) => {
    const it = id ? findCatalogItem(id) : undefined;
    if (it) used.set(it.id, it);
  };
  project.equipment.forEach((e) => addUsed(e.catalogId));
  [project.power.upsCatalogId, project.power.generatorCatalogId, project.power.transformerCatalogId, project.power.rppCatalogId, project.cooling.cduCatalogId, project.cooling.crahCatalogId, project.cooling.chillerCatalogId].forEach(addUsed);
  net.fabrics.forEach((f) => addUsed(f.switchCatalogId));
  table([S.sources.equipment, S.sources.vendorModel, S.sources.dataSource, S.sources.notes], [...used.values()].map((it) => [it.name, `${it.vendor} ${it.model}`, src(it.source), it.notes ?? '-']));
  blank();
  table([S.sources.cable, S.sources.reach, S.sources.source], net.cablesByType.map((x) => {
    const t = cableTypes().find((ct) => ct.id === x.cableTypeId);
    return [t?.name ?? x.cableTypeId, `${t?.maxReachM ?? '-'} m`, t ? src(t.source) : '-'];
  }));
  blank(); h(3, S.sources.methodTitle); blank();
  for (const m of S.sources.methods) li(m.replace(/^- /, ''));
  blank(); p(S.sources.disclaimer);
  // stream E (P5, proposal §6.3): standards basis — profile, pinned documents, check summary, facility pre-check, notice
  B.push(...standardsBasisBlocks(project, a, locale));
  notes('sources');

  return { locale, title, blocks: B };
}

/** Markdown design document (internal format — tests, LLM grounding). The user-facing deliverable is HTML. */
export function generateDesignDocument(project: Project, analysis: ProjectAnalysis, opts: DesignDocOptions = {}): string {
  return renderBlocksMarkdown(buildDesignDocumentBlocks(project, analysis, opts).blocks);
}

// stream E (P5): standards labels, chips, BOM columns and the design-document "Standards basis" section
export * from './standardsLabels.ts';
export * from './standardsBasis.ts';
