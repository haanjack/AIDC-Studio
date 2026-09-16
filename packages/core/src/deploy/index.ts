import { buildCableSchedule } from '../engines/links.ts';
import { buildIpPlan } from '../engines/ipplan.ts';
import type { CableScheduleRow, IpPlan, Locale, Project, ProjectAnalysis, ThermalSnapshot } from '../model/types.ts';
import { buildWaveBom, waveBomCsv } from './bom.ts';
import { cableScheduleCsv, cableScheduleHtml, topologyDot } from './cables.ts';
import { asCsvFile } from './csv.ts';
import { planDevices } from './devices.ts';
import { escapeHtml, htmlPage, htmlTable } from './html.ts';
import { IP_PLAN_SECTIONS, ipPlanCsv, ipPlanHtml, ipPlanSectionCsv } from './ipmap.ts';
import { switchInventoryCsv } from './inventory.ts';
import { netStrings } from './netStrings.ts';
import { buildRackPlan, rackPlanCsv } from './rackplan.ts';
import { rackPlanHtml, waveBomHtml } from './sheets.ts';
import { rackElevationDeployFiles } from './rackElevations.ts';

/**
 * Deployment bundle (stream S4 → T7, DECISIONS-v2 #11, DECISIONS-v2-2 F5: HTML + CSV, no Markdown).
 *
 * `buildDeployBundle(project, analysis, { locale })` returns the files that `export/files.ts` ('deploy' format) zips:
 *   bom-by-wave.csv/.html · rack-plan.csv/.html · cable-schedule.csv/.html + topology.dot · ip-plan.csv/.html +
 *   ip-plan/<section>.csv · switch-inventory.csv · README.html.
 * Cable schedule and IP plan rows come from T2 (`buildCableSchedule`, `buildIpPlan`) unless injected through the
 * options (tests / previews). NOS configs and the test kit are added by export/files.ts (nos/<target>/, tests/).
 */
export interface DeployFile {
  /** relative path inside the bundle, e.g. 'bom-by-wave.csv', 'rack-plan.html' */
  path: string;
  content: string | Uint8Array;
  kind: 'bom' | 'rack-plan' | 'network-map' | 'ip-plan' | 'cable-schedule' | 'topology' | 'tests' | 'other';
}

export interface DeployOptions {
  locale?: Locale;
  /** restrict the BOM to these waves (rack plan always lists every rack) */
  waveIds?: string[];
  /** injected cable schedule (default: T2 buildCableSchedule) */
  cableSchedule?: CableScheduleRow[];
  /** injected IP plan (default: T2 buildIpPlan) */
  ipPlan?: IpPlan;
  /** D2: CFD-lite snapshots for rack-elevations.html / rack-summary.csv (default project.thermalSnapshots) */
  thermal?: ThermalSnapshot[] | null;
}

export { buildWaveBom, waveBomCsv, waveBomMarkdown, lengthBin, LENGTH_BINS, COMMON_WAVE, waveOf, reconcileBom } from './bom.ts';
export type { WaveBom, WaveBomLine, BomGroup, BomReconciliation, BomReconRow, BomReconScope } from './bom.ts';
export { buildRackPlan, rackPlanCsv, rackPlanMarkdown, umapFor } from './rackplan.ts';
export type { RackPlan, RackPlanRow, RackUMap, RackUMapEntry } from './rackplan.ts';
export { deployStrings } from './strings.ts';
// D2: per-DU rack elevations (contents resolver data, HTML, CSV)
export { buildRackContents, rackContents, rackRowGroups, inletStatus, zoneOfPod, worstStatus, SENSOR_HEIGHTS, INLET_RECOMMENDED_C, SPACE_THRESHOLDS, WEIGHT_THRESHOLDS } from './rackElevationsData.ts';
export type { RackContents, RackContentsOptions, RackRowGroup, RackSensor, RackStatus, RackUnitRow, RackZeroU, RackZone } from './rackElevationsData.ts';
export { rackElevationsHtmlFiles, rackContentsCsv, rackSummaryCsv, rackElevationDeployFiles, rackRowFigureSvg, RACK_CONTENTS_COLUMNS, RACK_SUMMARY_COLUMNS, type RackElevationDocOptions } from './rackElevations.ts';
export type { DeployStrings } from './strings.ts';
export { waveBomHtml, rackPlanHtml } from './sheets.ts';
export { CABLE_SCHEDULE_COLUMNS, REACH_LIMIT, cableScheduleCsv, cableScheduleHtml, cableScheduleRecords, topologyDot, type CableScheduleRecord } from './cables.ts';
export { IP_PLAN_COLUMNS, IP_PLAN_COMBINED_COLUMNS, IP_PLAN_SECTIONS, ipPlanCsv, ipPlanHtml, ipPlanRows, ipPlanSectionCsv, type IpPlanSection } from './ipmap.ts';
export { SWITCH_INVENTORY_COLUMNS, buildSwitchInventoryCsv, switchInventoryCsv } from './inventory.ts';
export { planDevices, roleFromAsn, roleFromId, hostnameOf, splitEndpoint, type DeviceRole, type PlanDevice } from './devices.ts';
export { netStrings, type NetStrings } from './netStrings.ts';

/** Cable schedule + IP plan for a project: injected values win, else T2's generators (empty on failure / no analysis). */
export function networkDeliverableData(project: Project, analysis: ProjectAnalysis | null, opts: Pick<DeployOptions, 'cableSchedule' | 'ipPlan' | 'locale'> = {}): { cableSchedule: CableScheduleRow[]; ipPlan: IpPlan } {
  const empty: IpPlan = { blocks: [], loopbacks: [], asns: [], p2p: [], hosts: [], oob: [] };
  let cableSchedule = opts.cableSchedule;
  let ipPlan = opts.ipPlan;
  if (!cableSchedule) {
    try { cableSchedule = analysis ? buildCableSchedule(project, analysis) : []; } catch { cableSchedule = []; }
  }
  if (!ipPlan) {
    try { ipPlan = analysis ? buildIpPlan(project, analysis, { locale: opts.locale ?? project.locale }) : empty; } catch { ipPlan = empty; }
  }
  return { cableSchedule: cableSchedule ?? [], ipPlan: ipPlan ?? empty };
}

export function buildDeployBundle(project: Project, analysis: ProjectAnalysis | null, opts: DeployOptions = {}): DeployFile[] {
  const locale: Locale = opts.locale ?? project.locale ?? 'en';
  const N = netStrings(locale);
  const generatedAt = (analysis?.generatedAt ?? project.updatedAt ?? project.createdAt ?? '').slice(0, 19).replace('T', ' ');
  let bom = buildWaveBom(project, analysis, locale);
  if (opts.waveIds?.length) bom = { ...bom, lines: bom.lines.filter((l) => opts.waveIds!.includes(l.waveId)) };
  const plan = buildRackPlan(project, analysis, locale);
  const { cableSchedule, ipPlan } = networkDeliverableData(project, analysis, opts);
  const devices = planDevices(project, analysis, ipPlan);
  const rackElev = rackElevationDeployFiles(project, analysis, { locale, thermal: opts.thermal, cableSchedule, generatedAt });

  const files: DeployFile[] = [
    { path: 'bom-by-wave.csv', content: asCsvFile(waveBomCsv(bom)), kind: 'bom' },
    { path: 'bom-by-wave.html', content: waveBomHtml(project, bom, locale, generatedAt, analysis), kind: 'bom' },
    { path: 'rack-plan.csv', content: asCsvFile(rackPlanCsv(plan)), kind: 'rack-plan' },
    { path: 'rack-plan.html', content: rackPlanHtml(project, plan, locale, generatedAt), kind: 'rack-plan' },
    ...rackElev.map((f) => ({ path: f.path, content: f.content, kind: 'rack-plan' as const })),
    { path: 'cable-schedule.csv', content: cableScheduleCsv(cableSchedule), kind: 'cable-schedule' },
    { path: 'cable-schedule.html', content: cableScheduleHtml(project, cableSchedule, locale, generatedAt), kind: 'cable-schedule' },
    { path: 'topology.dot', content: topologyDot(cableSchedule, devices), kind: 'topology' },
    { path: 'ip-plan.csv', content: ipPlanCsv(ipPlan, devices), kind: 'ip-plan' },
    { path: 'ip-plan.html', content: ipPlanHtml(project, ipPlan, locale, generatedAt, devices), kind: 'ip-plan' },
    ...IP_PLAN_SECTIONS.map((s) => ({ path: `ip-plan/${s}.csv`, content: ipPlanSectionCsv(ipPlan, s, devices), kind: 'ip-plan' as const })),
    { path: 'switch-inventory.csv', content: switchInventoryCsv(devices), kind: 'network-map' },
  ];

  const F = N.files;
  const describe: Record<string, [string, number | undefined]> = {
    'bom-by-wave.csv': [F.bomCsv, bom.lines.length], 'bom-by-wave.html': [F.bomHtml, undefined],
    'rack-plan.csv': [F.rackCsv, plan.rows.length], 'rack-plan.html': [F.rackHtml, undefined],
    'cable-schedule.csv': [F.cableCsv, cableSchedule.length], 'cable-schedule.html': [F.cableHtml, undefined], 'topology.dot': [F.dot, cableSchedule.length],
    'ip-plan.csv': [F.ipCsv, IP_PLAN_SECTIONS.reduce((n, s) => n + (ipPlan[s] as unknown[]).length, 0) + (ipPlan.ipv6Blocks?.length ?? 0)], 'ip-plan.html': [F.ipHtml, undefined],
    'switch-inventory.csv': [F.inventory, devices.length],
    ...Object.fromEntries(rackElev.map((f) => [f.path, [locale === 'ko' ? (f.path.endsWith('.html') ? '랙 입면도 (DU별 전면·후면, 인쇄용)' : f.path === 'rack-contents.csv' ? '랙 구성 — 슬롯마다 한 행' : '랙 요약 — 랙마다 한 행') : f.path.endsWith('.html') ? 'Rack elevations (front / rear per DU row, printable)' : f.path === 'rack-contents.csv' ? 'Rack contents — one row per slot' : 'Rack summary — one row per rack', f.rows] as [string, number | undefined]])),
  };
  const rows = files.map((f) => {
    const [desc, count] = describe[f.path] ?? [F.ipSectionCsv, undefined];
    return [f.path, desc, count ?? '-'];
  });
  rows.push(['nos/<target>/', F.nos, '-'], ['tests/', F.tests, '-']);
  const body = [
    `<p>${escapeHtml(N.bundleIntro)}</p>`,
    htmlTable([N.file, N.contents, N.rows], rows, { monoCols: [0], numericCols: [2] }),
    ...(cableSchedule.length ? [] : [`<p class="note">${escapeHtml(N.notAvailable('cable-schedule.csv'))}</p>`]),
    ...(ipPlan.loopbacks.length || ipPlan.hosts.length ? [] : [`<p class="note">${escapeHtml(N.notAvailable('ip-plan.csv'))}</p>`]),
    ...bom.notes.map((x) => `<p class="note">${escapeHtml(x)}</p>`),
  ].join('\n');
  files.push({ path: 'README.html', content: htmlPage(N.bundleTitle(project.name), body, locale, { subtitle: N.generated(generatedAt) }), kind: 'other' });
  return files;
}
