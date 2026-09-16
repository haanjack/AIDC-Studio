// rack-elevations.html · rack-contents.csv · rack-summary.csv (area D2, DECISIONS-v2-2 §D, r3-rack-diagrams.md §4.6).
// Printable single-file HTML (A3 landscape print CSS, inline SVG, no external assets): cover + scope summary, one chapter
// per DU / services / network-core / unassigned group with the FRONT and REAR row figures, a row table and rack contents
// tables grouped by identical configuration. Above 16 DUs the HTML splits into rack-elevations/<DU>.html + an index.
import { announcedSpec } from '../catalog/checks.ts';
import { findCatalogItem as findItemT4 } from '../catalog/catalog.ts';
import type { CableScheduleRow, Locale, Project, ProjectAnalysis, ThermalSnapshot } from '../model/types.ts';
import { drawRowBand, groupTitle, layoutRow, rackElevationStrings, STATUS_COLOR, type RackFace } from '../drawings/rackElevations.ts';
import { FONT } from '../drawings/svg.ts';
import { csvFile } from './csv.ts';
import { escapeHtml, htmlId, htmlPage, htmlTable, type HtmlTocEntry } from './html.ts';
import { buildRackContents, rackRowGroups, type RackContents, type RackRowGroup, type RackStatus } from './rackElevationsData.ts';

export interface RackElevationDocOptions {
  locale?: Locale;
  thermal?: ThermalSnapshot[] | null;
  cableSchedule?: CableScheduleRow[];
  generatedAt?: string;
  /** DU count above which the HTML is split per DU (D-10 default 16) */
  splitAboveDu?: number;
}

const T = {
  en: {
    doc: 'Rack elevations', disclaimer: 'All values are design values from the project model or simulated values (CFD-lite). Nothing in this document is measured; there is no DCIM or BMC data in AIDC Studio.',
    scope: 'Scope', group: 'Group', rows: 'Rows', racks: 'Racks', gpus: 'GPUs', kwD: 'Design kW', kwP: 'Peak kW', uPct: 'U used %', weightT: 'Weight t', waves: 'Waves', statusCounts: 'Status G / A / R / –',
    front: 'Front', rear: 'Rear', rowTable: 'Racks in this row', contents: 'Rack contents (grouped by identical configuration)', configRacks: 'Racks with this configuration',
    u: 'U', slot: 'Slot', device: 'Device', category: 'Category', kwDesign: 'kW design', kwPeak: 'kW peak', weight: 'Weight kg', ports: 'Ports used / total', cables: 'Cables', source: 'Source', announced: 'Announced',
    tag: 'Tag', position: 'Pos.', model: 'Rack model', used: 'U used / free', cap: 'Capacity kW', circuits: 'A / B circuits', weightRating: 'Weight / rating kg', wave: 'Wave', inlet: 'Inlet B / M / T °C (sim)', status: 'Status',
    thermalNone: 'Inlet temperatures: no CFD-lite simulation saved for this hall — run CFD-lite in the Cooling panel to include simulated inlet values.',
    thermalStale: 'Inlet temperatures: the saved CFD-lite snapshot ({at}) is stale — the layout changed since the run.', thermalSim: 'Inlet temperatures: CFD-lite snapshot {at} (simulated).',
    index: 'Index', chapters: 'Chapters', appendix: 'Appendix — CSV columns', generated: 'Generated {at}',
    csvNote: 'rack-contents.csv: one row per slot (devices, blanking panels, reserved positions), 0U items and one residual row per rack (slot weights + residual = rack weight). rack-summary.csv: one row per rack (same racks as rack-plan.csv).',
  },
  ko: {
    doc: '랙 입면도', disclaimer: '모든 값은 프로젝트 모델의 설계값 또는 CFD-lite 시뮬레이션값입니다. 이 문서에 실측값은 없으며 AIDC Studio에는 DCIM/BMC 데이터가 없습니다.',
    scope: '범위', group: '그룹', rows: '열', racks: '랙', gpus: 'GPU', kwD: '설계 kW', kwP: '피크 kW', uPct: 'U 사용률 %', weightT: '중량 t', waves: '웨이브', statusCounts: '상태 녹 / 황 / 적 / –',
    front: '전면', rear: '후면', rowTable: '이 열의 랙', contents: '랙 구성(동일 구성끼리 묶음)', configRacks: '이 구성을 쓰는 랙',
    u: 'U', slot: '슬롯', device: '장비', category: '유형', kwDesign: '설계 kW', kwPeak: '피크 kW', weight: '중량 kg', ports: '포트 사용 / 전체', cables: '케이블', source: '출처', announced: '발표됨',
    tag: '태그', position: '위치', model: '랙 모델', used: 'U 사용 / 여유', cap: '용량 kW', circuits: 'A / B 회로', weightRating: '중량 / 정격 kg', wave: '웨이브', inlet: '흡기 하 / 중 / 상 °C (시뮬)', status: '상태',
    thermalNone: '흡기 온도: 이 홀에 저장된 CFD-lite 시뮬레이션이 없습니다 — 냉각 패널에서 CFD-lite를 실행하면 시뮬레이션 흡기값이 포함됩니다.',
    thermalStale: '흡기 온도: 저장된 CFD-lite 스냅숏({at})이 오래되었습니다 — 실행 이후 배치가 바뀌었습니다.', thermalSim: '흡기 온도: CFD-lite 스냅숏 {at} (시뮬레이션).',
    index: '색인', chapters: '장', appendix: '부록 — CSV 열', generated: '생성 {at}',
    csvNote: 'rack-contents.csv: 슬롯마다 한 행(장비·블랭크 패널·예약 자리) + 0U 항목 + 랙마다 잔차 행 1개(슬롯 중량 + 잔차 = 랙 중량). rack-summary.csv: 랙마다 한 행(rack-plan.csv와 같은 랙).',
  },
};
const fmt = (s: string, v: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k: string) => v[k] ?? '');
const f1 = (v: number) => (Math.round(v * 10) / 10).toFixed(1);

/** Inline SVG figure of one row face. */
export function rackRowFigureSvg(racks: RackContents[], face: RackFace, locale: Locale, idPrefix: string, mmPerM: number, pitch: number): string {
  const band = drawRowBand(racks, 2, 2, { idPrefix, locale, face, mmPerM, pitch });
  // size: the root carries the font family once (every <text> repeats it on the A1 sheets)
  band.svg = band.svg.replace(/ font-family="[^"]*"/g, '');
  const w = band.w + 4;
  const h = band.h + 4;
  // finish v2 2차 (QA rack-elevations M1): physical size in mm (1 viewBox unit = 1 mm) so a figure prints at its stated scale and the 1.8 mm
  // sheet text stays 1.8 mm; screens scale it down with max-width
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w.toFixed(1)} ${h.toFixed(1)}" width="${w.toFixed(1)}mm" height="${h.toFixed(1)}mm" role="img" aria-label="${escapeHtml(`${face} elevation`)}" font-family="${FONT.replace(/"/g, '&quot;')}"><defs>${band.defs.join('')}</defs><rect x="0" y="0" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="#ffffff"/>${band.svg}</svg>`;
}

interface Chapter { id: string; label: string; groups: RackRowGroup[] }

function chaptersOf(groups: RackRowGroup[], L: Locale, multiHall: boolean): Chapter[] {
  const S = rackElevationStrings(L);
  const map = new Map<string, Chapter>();
  for (const g of groups) {
    const key = `${g.hallId}|${g.zone}|${g.du}`;
    let c = map.get(key);
    if (!c) {
      const name = g.zone === 'du' ? g.du : g.zone === 'services' ? `${S.services}${g.du !== 'SV' ? ` ${g.du}` : ''}` : g.zone === 'network-core' ? `${S['network-core']}${g.du !== 'NC' ? ` ${g.du}` : ''}` : S.unassigned;
      c = { id: htmlId(`${multiHall ? g.hallCode : ''}-${g.du}`), label: `${multiHall ? `${g.hallName} · ` : ''}${name}`, groups: [] };
      map.set(key, c);
    }
    c.groups.push(g);
  }
  return [...map.values()];
}

const statusDot = (s: RackStatus) => `<span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${STATUS_COLOR[s]};vertical-align:middle"></span> ${s}`;

function chapterHtml(ch: Chapter, L: Locale): string {
  const X = T[L === 'ko' ? 'ko' : 'en'];
  const out: string[] = [`<section class="chapter" id="${ch.id}"><h2>${escapeHtml(ch.label)}</h2>`];
  const all = ch.groups.flatMap((g) => g.racks);
  const th = all[0]?.thermal;
  out.push(`<p class="note">${escapeHtml(!th || th.state === 'none' ? X.thermalNone : th.state === 'stale' ? fmt(X.thermalStale, { at: th.at ?? '' }) : fmt(X.thermalSim, { at: th.at ?? '' }))}</p>`);
  ch.groups.forEach((g, gi) => {
    out.push(`<h3 id="${ch.id}-${htmlId(g.row)}">${escapeHtml(groupTitle(g, L))}</h3>`);
    // A3 landscape content width 400 mm → at most 7 racks per figure at a fixed 1:20 (every figure in the document at the same scale)
    const lay = layoutRow(g, HTML_FIGURE_WIDTH_MM, [HTML_FIGURE_SCALE]);
    lay.segments.forEach((seg, si) => {
      for (const face of ['front', 'rear'] as RackFace[]) {
        out.push(`<figure>${rackRowFigureSvg(seg, face, L, `${ch.id}-${gi}-${si}-${face[0]}`, lay.mmPerM, lay.pitch)}<figcaption>${escapeHtml(`${face === 'front' ? X.front : X.rear} · ${groupTitle(g, L)}${lay.segments.length > 1 ? ` · ${si + 1}/${lay.segments.length}` : ''} · 1:${lay.den} (A3)`)}</figcaption></figure>`);
      }
    });
    out.push(htmlTable([X.tag, X.position, X.model, X.used, X.kwD + ' / ' + X.kwP, X.cap, X.circuits, X.weightRating, X.wave, X.inlet, X.status], g.racks.map((r) => [
      r.rack.tag, r.rack.position, `${r.rack.model}${announcedSpec(findItemT4(r.rack.catalogId)).announced ? ` [${X.announced}]` : ''} · ${r.totalU}${r.unit}`, `${r.usedU} / ${r.freeU}`, `${f1(r.kwDesign)} / ${f1(r.kwPeak)}`, r.circuitBudgetKw !== undefined ? f1(r.circuitBudgetKw) : '—',
      `${r.circuits.A?.label ?? '—'} / ${r.circuits.B?.label ?? '—'}`, `${r.weightKg} / ${r.ratedLoadKg ?? '—'}`, r.wave.name, r.sensors.map((s) => (s.valueC !== undefined ? f1(s.valueC) : '—')).join(' / '), statusDot(r.status.overall),
    ]), { caption: X.rowTable, monoCols: [0], numericCols: [1, 4, 5], rawCols: [10] }));
  });
  // grouped rack contents
  const configs = new Map<string, RackContents[]>();
  for (const r of all) {
    const sig = `${r.rack.catalogId}#${r.units.map((u) => `${u.uStart}-${u.uEnd}:${u.category}:${u.model}:${u.portsUsed ?? ''}`).join('|')}`;
    const arr = configs.get(sig) ?? [];
    arr.push(r);
    configs.set(sig, arr);
  }
  out.push(`<h3>${escapeHtml(X.contents)}</h3>`);
  for (const racks of configs.values()) {
    const r = racks[0];
    out.push(`<h4>${escapeHtml(`${r.rack.model}${announcedSpec(findItemT4(r.rack.catalogId)).announced ? ` [${X.announced}]` : ''} · ${r.totalU}${r.unit} · ${racks.length} × `)}</h4><p class="muted mono">${escapeHtml(`${X.configRacks}: ${racks.map((x) => x.rack.tag).join(', ')}`)}</p>`);
    out.push(htmlTable([X.u, X.slot, X.device, X.category, X.kwDesign, X.kwPeak, X.weight, X.ports, X.cables, X.source], r.units.map((u) => [
      u.uStart === u.uEnd ? `${r.unit}${u.uStart}` : `${r.unit}${u.uStart}–${u.uEnd}`, u.label, u.model, u.category, u.kwDesign ? f1(u.kwDesign) : '', u.kwPeak ? f1(u.kwPeak) : '', u.weightKg ?? '', u.ports ? `${u.portsUsed ?? 0} / ${u.ports}` : '', u.cableCount ?? '', u.source,
    ]), { monoCols: [0, 1], numericCols: [4, 5, 6, 8] }));
  }
  out.push('</section>');
  return out.join('\n');
}

const HTML_FIGURE_WIDTH_MM = 396;
const HTML_FIGURE_SCALE = 20;
const PRINT_EXTRA = '<style>@page{size:A3 landscape;margin:10mm 10mm 12mm;}main{max-width:1500px;}figure{break-inside:avoid;page-break-inside:avoid;margin:0 0 4mm;}figure svg{max-width:100%;height:auto;}</style>';

function scopeTable(chapters: Chapter[], L: Locale): string {
  const X = T[L === 'ko' ? 'ko' : 'en'];
  return htmlTable([X.group, X.rows, X.racks, X.gpus, X.kwD, X.kwP, X.uPct, X.weightT, X.waves, X.statusCounts], chapters.map((c) => {
    const rs = c.groups.flatMap((g) => g.racks);
    const tu = rs.reduce((s, r) => s + r.totalU, 0);
    const cnt = (s: RackStatus) => rs.filter((r) => r.status.overall === s).length;
    return [c.label, c.groups.length, rs.length, rs.reduce((s, r) => s + r.rack.gpus, 0), f1(rs.reduce((s, r) => s + r.kwDesign, 0)), f1(rs.reduce((s, r) => s + r.kwPeak, 0)), tu ? f1((100 * rs.reduce((s, r) => s + r.usedU, 0)) / tu) : '—', f1(rs.reduce((s, r) => s + r.weightKg, 0) / 1000), [...new Set(rs.map((r) => r.wave.name))].join(', '), `${cnt('green')} / ${cnt('amber')} / ${cnt('red')} / ${cnt('grey')}`];
  }), { caption: X.scope, numericCols: [1, 2, 3, 4, 5, 6, 7] });
}

/** rack-elevations.html (or index + per-DU files above `splitAboveDu` DUs). Paths relative to the deploy bundle. */
export function rackElevationsHtmlFiles(project: Project, analysis: ProjectAnalysis | null, opts: RackElevationDocOptions = {}): { path: string; content: string }[] {
  const L: Locale = opts.locale ?? project.locale ?? 'en';
  const X = T[L === 'ko' ? 'ko' : 'en'];
  const contents = buildRackContents(project, analysis, { thermal: opts.thermal, cableSchedule: opts.cableSchedule });
  const groups = rackRowGroups(contents, project);
  const chapters = chaptersOf(groups, L, new Set(project.equipment.map((e) => e.hallId)).size > 1);
  const subtitle = `${project.name} · ${fmt(X.generated, { at: opts.generatedAt ?? (project.updatedAt ?? '').slice(0, 10) })}`;
  const cover = `${PRINT_EXTRA}<p class="note">${escapeHtml(X.disclaimer)}</p>${scopeTable(chapters, L)}`;
  const appendix = `<section class="chapter"><h2>${escapeHtml(X.appendix)}</h2><p>${escapeHtml(X.csvNote)}</p><p class="mono">${escapeHtml(RACK_CONTENTS_COLUMNS.join(', '))}</p><p class="mono">${escapeHtml(RACK_SUMMARY_COLUMNS.join(', '))}</p></section>`;
  const duCount = chapters.filter((c) => c.groups[0]?.zone === 'du').length;
  const title = `${X.doc} — ${project.name}`;
  if (duCount <= (opts.splitAboveDu ?? 16)) {
    const toc: HtmlTocEntry[] = chapters.flatMap((c) => [{ id: c.id, label: c.label, level: 1 as const }, ...c.groups.map((g) => ({ id: `${c.id}-${htmlId(g.row)}`, label: groupTitle(g, L), level: 2 as const }))]);
    return [{ path: 'rack-elevations.html', content: htmlPage(title, [cover, ...chapters.map((c) => chapterHtml(c, L)), appendix].join('\n'), L, { subtitle, toc, landscape: true, footer: subtitle }) }];
  }
  const files = chapters.map((c) => ({ path: `rack-elevations/${c.id}.html`, content: htmlPage(`${X.doc} — ${c.label}`, `${PRINT_EXTRA}<p class="note">${escapeHtml(X.disclaimer)}</p>${chapterHtml(c, L)}`, L, { subtitle, landscape: true, footer: subtitle }) }));
  const index = `${cover}<h2>${escapeHtml(X.chapters)}</h2><ul>${chapters.map((c) => `<li><a href="rack-elevations/${c.id}.html">${escapeHtml(c.label)}</a></li>`).join('')}</ul>${appendix}`;
  return [{ path: 'rack-elevations.html', content: htmlPage(`${title} — ${X.index}`, index, L, { subtitle, landscape: true, footer: subtitle }) }, ...files];
}

export const RACK_CONTENTS_COLUMNS = ['hall', 'du', 'zone', 'row', 'position', 'rack_tag', 'rack_id', 'face', 'mount', 'u_start', 'u_end', 'units', 'unit_system', 'slot_label', 'device', 'catalog_id', 'category', 'role', 'fabric', 'kw_design', 'kw_peak', 'weight_kg', 'ports_total', 'ports_used', 'cable_count', 'wave', 'source', 'note'];

export const RACK_SUMMARY_COLUMNS = ['hall', 'du', 'zone', 'row', 'position', 'rack_tag', 'rack_id', 'catalog_id', 'rack_model', 'category', 'x', 'y', 'rotation_deg', 'u_total', 'unit_system', 'u_used', 'u_free', 'u_blank', 'u_reserved', 'gpus', 'kw_design', 'kw_typical', 'kw_peak', 'kw_capacity', 'kw_capacity_source', 'cord_sides', 'circuit_a', 'circuit_b', 'circuit_a_limit_kw', 'circuit_b_limit_kw', 'weight_kg', 'floor_load_kg_m2', 'floor_rating_kg_m2', 'rack_static_rating_kg', 'rack_static_rating_source', 'cables', 'ports_used', 'ports_total', 'wave', 'inlet_bottom_c', 'inlet_middle_c', 'inlet_top_c', 'exhaust_c', 'inlet_limit_c', 'thermal_state', 'thermal_run_at', 'status_space', 'status_power', 'status_weight', 'status_thermal', 'status_overall', 'status_note', 'values'];

/** One row per slot (devices, blanking panels, reserved positions) plus one per 0U item. */
export function rackContentsCsv(contents: RackContents[]): string {
  const rows: Record<string, unknown>[] = [];
  for (const r of contents) {
    const base = { hall: r.rack.hallName, du: r.rack.du, zone: r.rack.zone, row: r.rack.row, position: r.rack.position, rack_tag: r.rack.tag, rack_id: r.rack.id, unit_system: r.unit, wave: r.wave.id };
    for (const u of r.units) {
      rows.push({ ...base, face: 'both', mount: 'rail', u_start: u.uStart, u_end: u.uEnd, units: u.units, slot_label: u.label, device: u.model, catalog_id: u.catalogId ?? '', category: u.category, role: u.role ?? '', fabric: u.fabric ?? '', kw_design: u.kwDesign, kw_peak: u.kwPeak, weight_kg: u.weightKg ?? '', ports_total: u.ports ?? '', ports_used: u.ports ? u.portsUsed ?? 0 : '', cable_count: u.cableCount ?? '', source: u.source, note: u.auto ? 'auto blanking panel (BOM)' : u.category === 'switch' || u.category === 'blank' || u.category === 'reserved' ? '' : 'kW apportioned from the rack power spec (estimate)' });
    }
    for (const z of r.zeroU) rows.push({ ...base, face: 'rear', mount: z.side === 'center' ? '0U-center' : z.side === 'A' ? '0U-left' : '0U-right', u_start: '', u_end: '', units: 0, slot_label: z.label, device: z.label, catalog_id: '', category: z.kind, source: z.source, note: '' });
    // finish v2 2차 (QA rack-elevations m6): residual row — slot weights and kW plus this row add up to the rack totals (spec §4.6)
    const slotKg = r.units.reduce((s, u) => s + (u.weightKg ?? 0), 0);
    const slotKw = r.units.reduce((s, u) => s + u.kwDesign, 0);
    rows.push({ ...base, face: 'both', mount: 'frame', u_start: '', u_end: '', units: 0, slot_label: 'Residual', device: 'Frame, manifold, busbar and load not apportioned to slots', catalog_id: r.rack.catalogId, category: 'residual', kw_design: Math.round((r.kwDesign - slotKw) * 10) / 10, weight_kg: Math.round(r.weightKg - slotKg), source: 'estimate', note: 'rack total minus the slots of this rack (estimate)' });
  }
  return csvFile(rows, RACK_CONTENTS_COLUMNS);
}

/** One row per rack. */
export function rackSummaryCsv(contents: RackContents[]): string {
  return csvFile(contents.map((r) => ({
    hall: r.rack.hallName, du: r.rack.du, zone: r.rack.zone, row: r.rack.row, position: r.rack.position, rack_tag: r.rack.tag, rack_id: r.rack.id, catalog_id: r.rack.catalogId, rack_model: r.rack.model, category: r.rack.category,
    x: r.rack.x, y: r.rack.y, rotation_deg: r.rack.rotationDeg, u_total: r.totalU, unit_system: r.unit, u_used: r.usedU, u_free: r.freeU, u_blank: r.blankU, u_reserved: r.reservedU, gpus: r.rack.gpus,
    kw_design: r.kwDesign, kw_typical: r.kwTypical, kw_peak: r.kwPeak, kw_capacity: r.circuitBudgetKw ?? '', kw_capacity_source: r.circuitBudgetSource, cord_sides: r.cordSides,
    circuit_a: r.circuits.A?.label ?? '', circuit_b: r.circuits.B?.label ?? '', circuit_a_limit_kw: r.circuits.A?.limitKw ?? '', circuit_b_limit_kw: r.circuits.B?.limitKw ?? '',
    weight_kg: r.weightKg, floor_load_kg_m2: r.floorLoadKgM2, floor_rating_kg_m2: r.floorRatingKgM2, rack_static_rating_kg: r.ratedLoadKg ?? '', rack_static_rating_source: r.ratedLoadSource ?? '',
    cables: Object.entries(r.cables).map(([k, v]) => `${k}:${v}`).join('; '), ports_used: r.portsUsed, ports_total: r.portsTotal, wave: r.wave.id,
    inlet_bottom_c: r.sensors[0]?.valueC ?? '', inlet_middle_c: r.sensors[1]?.valueC ?? '', inlet_top_c: r.sensors[2]?.valueC ?? '', exhaust_c: r.exhaustC ?? '', inlet_limit_c: r.sensors[0]?.limitC ?? '',
    thermal_state: r.thermal.state, thermal_run_at: r.thermal.at ?? '', status_space: r.status.space, status_power: r.status.power, status_weight: r.status.weight, status_thermal: r.status.thermal, status_overall: r.status.overall, status_note: r.statusNotes.join('; '),
    values: r.thermal.state === 'simulated' ? 'design + simulated (CFD-lite)' : 'design',
  })), RACK_SUMMARY_COLUMNS);
}

/** Deploy-bundle files: rack-elevations.html (+ per-DU split) · rack-contents.csv · rack-summary.csv. */
export function rackElevationDeployFiles(project: Project, analysis: ProjectAnalysis | null, opts: RackElevationDocOptions = {}): { path: string; content: string; rows?: number }[] {
  const contents = buildRackContents(project, analysis, { thermal: opts.thermal, cableSchedule: opts.cableSchedule });
  return [
    ...rackElevationsHtmlFiles(project, analysis, opts),
    { path: 'rack-contents.csv', content: rackContentsCsv(contents), rows: contents.reduce((s, r) => s + r.units.length + r.zeroU.length + 1, 0) },
    { path: 'rack-summary.csv', content: rackSummaryCsv(contents), rows: contents.length },
  ];
}
