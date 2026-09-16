// Acceptance test kit (stream T7, DECISIONS-v2-2 §B/§C):
// 00-inventory · 10-links · 20-rdma · 30-collectives (η measurement kit) · 40-node · 50-storage · 60-thermal-power,
// a pytest skeleton writing results/<run>/results.json and a README.html with the acceptance thresholds and sources.
// Paths are relative to the kit root (export/files.ts places them under tests/).
import { buildCableSchedule } from '../../engines/links.ts';
import { buildIpPlan } from '../../engines/ipplan.ts';
import type { CableScheduleRow, GeneratedFile, IpPlan, Locale, Project, ProjectAnalysis } from '../../model/types.ts';
import { csvFile } from '../csv.ts';
import { escapeHtml, htmlPage, htmlTable } from '../html.ts';
import { buildTestKitModel, type TestKitModel } from './model.ts';
import { pythonFiles } from './python.ts';
import {
  COMMON_SH, FIO_JOB, countersSh, etaMpirunSh, etaSrunSh, inventorySh, linkFlapSh, lldpSh, ncclBuildSh, nodeDiagSh, perftestSh, redfishSh, runAllSh, storageSh,
} from './scripts.ts';
import { testKitStrings } from './strings.ts';

export { buildTestKitModel, type TestKitModel, type Threshold, type KitNode } from './model.ts';

export interface TestPlanOptions {
  locale?: Locale;
  cableSchedule?: CableScheduleRow[];
  ipPlan?: IpPlan;
  /** nodes per η run (default 16) */
  maxRunNodes?: number;
}

const hostfile = (title: string, hosts: string[]) => [`# ${title}`, ...hosts].join('\n') + '\n';

function expectedJson(m: TestKitModel): string {
  return JSON.stringify({
    schema: 'aidc-testkit-expected/1', project: m.projectName, vendor: m.vendor, tool: m.tool, gpuModel: m.gpuModel, gpusPerNode: m.gpusPerNode, nicGbps: m.nicGbps, nicsPerRank: 1,
    nics: m.nicNames, fabric: m.fabric, lbClass: m.lbClass, etaHost: m.etaHost, etaFabric: m.etaFabric, predicted: m.predicted,
    hostfiles: { singleLeaf: m.singleLeaf.length, crossSpine: m.crossSpine.length, crossSpineLeafGroups: m.crossSpineGroups, bisectionPairs: m.bisection.length },
    thresholds: m.thresholds, racks: m.racks, liquidSupplyMaxC: m.liquidSupplyMaxC, notes: m.notes,
  }, null, 2) + '\n';
}

function readmeHtml(project: Project, m: TestKitModel, locale: Locale): string {
  const S = testKitStrings(locale);
  const tag = locale === 'ko' ? 'ko-KR' : 'en-US';
  const nf = (v: number, d = 2) => v.toLocaleString(tag, { maximumFractionDigits: d });
  const parts: string[] = [];
  parts.push(`<p>${escapeHtml(S.intro)}</p>`);
  parts.push(htmlTable([S.item, S.value], [
    [S.vendor, `${m.vendor.toUpperCase()} · ${m.gpuModel}`], [S.tool, m.tool], [S.gpusPerNode, m.gpusPerNode], [S.nic, `${m.nicGbps} Gb/s × ${m.nicNames.length} (${m.nicNames.join(', ')})`],
    [S.fabric, `${m.fabric} · ${m.lbClass}`], [S.nodes, m.nodes.length],
  ], { numericCols: [] }));
  if (m.notes.length) for (const n of m.notes) parts.push(`<p class="note">${escapeHtml(n)}</p>`);

  parts.push(`<section class="chapter" id="stages"><h2>${escapeHtml(S.stagesTitle)}</h2><p>${escapeHtml(S.runOrder)}</p>`);
  parts.push(htmlTable([S.stage, S.proves, S.scripts, S.outputs], S.stages.map((s) => [s.id, s.proves, s.scripts, s.outputs]), { monoCols: [0, 2, 3] }));
  parts.push('</section>');

  parts.push(`<section class="chapter" id="eta"><h2>${escapeHtml(S.etaTitle)}</h2>`);
  parts.push(`<p>${escapeHtml(S.etaIntro(m.gpusPerNode))}</p>`);
  parts.push(`<ul>${[
    S.etaScopeSingle(m.singleLeaf.length),
    S.etaScopeCross(m.crossSpine.length, m.crossSpineGroups),
    S.etaFormula(nf(m.nicGbps / 8)),
    S.etaPaste,
    S.etaPlanes,
  ].map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>`);
  parts.push(htmlTable([S.item, S.value, S.sourceType, S.source], [
    [S.predIdeal, `${nf(m.predicted.idealGBps)} GB/s`, 'derived', `NIC ${m.nicGbps} Gb/s ÷ 8`],
    ['η_host', nf(m.etaHost.value), m.etaHost.sourceType, m.etaHost.source],
    ['η_fabric', nf(m.etaFabric.value), m.etaFabric.sourceType, m.etaFabric.source],
    [S.predSingle, `${nf(m.predicted.singleLeafGBps)} GB/s`, 'derived', 'ideal × η_host'],
    [S.predCross, `${nf(m.predicted.crossSpineGBps)} GB/s`, 'derived', 'ideal × η_host × η_fabric'],
  ], { monoCols: [] }));
  parts.push('</section>');

  parts.push(`<section class="chapter" id="acceptance"><h2>${escapeHtml(S.acceptanceTitle)}</h2><p>${escapeHtml(S.acceptanceIntro)}</p>`);
  const bar = (t: TestKitModel['thresholds'][number]) => {
    if (t.op === 'record') return S.recordOnly;
    if (t.value === null) return S.noValue;
    if (t.op === 'range') return `${nf(t.value)} – ${nf(t.max ?? t.value)} ${t.unit}`;
    return `${t.op} ${nf(t.value)} ${t.unit}`;
  };
  parts.push(htmlTable([S.stage, S.check, S.bar, S.sourceType, S.source], m.thresholds.map((t) => [t.stage, t.check, bar(t), t.sourceType, t.note ? `${t.source} — ${t.note}` : t.source])));
  parts.push('</section>');

  parts.push(`<section class="chapter" id="sources"><h2>${escapeHtml(S.sourcesTitle)}</h2><ul>${S.sources.map(([label, url]) => `<li>${escapeHtml(label)} — <code>${escapeHtml(url)}</code></li>`).join('')}</ul></section>`);
  return htmlPage(S.title(project.name), parts.join('\n'), locale, {
    toc: [{ id: 'stages', label: S.stagesTitle, level: 1 }, { id: 'eta', label: S.etaTitle, level: 1 }, { id: 'acceptance', label: S.acceptanceTitle, level: 1 }, { id: 'sources', label: S.sourcesTitle, level: 1 }],
  });
}

export function generateTestPlan(project: Project, analysis: ProjectAnalysis, opts: TestPlanOptions = {}): GeneratedFile[] {
  const locale: Locale = opts.locale ?? project.locale ?? 'en';
  let rows = opts.cableSchedule;
  let plan = opts.ipPlan;
  if (!rows) { try { rows = buildCableSchedule(project, analysis); } catch { rows = []; } }
  if (!plan) { try { plan = buildIpPlan(project, analysis); } catch { plan = { blocks: [], loopbacks: [], asns: [], p2p: [], hosts: [], oob: [] }; } }
  const m = buildTestKitModel(project, analysis, plan, rows, opts.maxRunNodes ?? 16);
  const sh = (path: string, content: string): GeneratedFile => ({ path, content, mime: 'text/x-shellscript' });
  const bmcs = plan.oob.filter((o) => /:BMC$/i.test(o.deviceId)).map((o) => o.ip.replace(/\/\d+$/, ''));
  const files: GeneratedFile[] = [
    { path: 'README.html', content: readmeHtml(project, m, locale), mime: 'text/html' },
    sh('common.sh', COMMON_SH),
    sh('run_all.sh', runAllSh()),
    { path: 'inventory/expected.json', content: expectedJson(m), mime: 'application/json' },
    { path: 'inventory/hostfiles/all.txt', content: hostfile(`all compute nodes (${m.nodes.length})`, m.nodes.map((n) => n.hostname)), mime: 'text/plain' },
    { path: 'inventory/hostfiles/single-leaf.txt', content: hostfile('η baseline: nodes on one leaf of the first rail (rings stay inside the leaf)', m.singleLeaf), mime: 'text/plain' },
    { path: 'inventory/hostfiles/cross-spine.txt', content: hostfile('η cross-spine: one node per leaf / pod, interleaved (every ring edge crosses the spine)', m.crossSpine), mime: 'text/plain' },
    { path: 'inventory/hostfiles/bisection-pairs.txt', content: ['# server client (node i of one half of the leaves ↔ node i of the other half)', ...m.bisection.map((p) => `${p.server} ${p.client}`)].join('\n') + '\n', mime: 'text/plain' },
    { path: 'inventory/bmcs.txt', content: ['# BMC addresses from ip-plan/oob.csv', ...bmcs].join('\n') + '\n', mime: 'text/plain' },
    { path: 'inventory/nodes.csv', content: csvFile(m.nodes.map((n) => ({ hostname: n.hostname, node_id: n.id, rack_tag: n.rackTag, pod: n.podId, leaves: Object.entries(n.leafByNic).map(([k, v]) => `${k}=${v}`).join(' '), addresses: Object.entries(n.ipByNic).map(([k, v]) => `${k}=${v}`).join(' ') })), ['hostname', 'node_id', 'rack_tag', 'pod', 'leaves', 'addresses']), mime: 'text/csv' },
    { path: 'inventory/switches.csv', content: csvFile(m.switches.map((d) => ({ hostname: d.hostname, role: d.role, fabric: d.fabric, rack_tag: d.rackTag, u: d.u, mgmt_ip: d.mgmtIp })), ['hostname', 'role', 'fabric', 'rack_tag', 'u', 'mgmt_ip']), mime: 'text/csv' },
    { path: 'inventory/expected-links.csv', content: csvFile(m.expectedLinks.map((l) => ({ cable_id: l.cableId, a_device: l.aDevice, a_port: l.aPort, b_device: l.bDevice, b_port: l.bPort })), ['cable_id', 'a_device', 'a_port', 'b_device', 'b_port']), mime: 'text/csv' },
    sh('00-inventory/collect_inventory.sh', inventorySh(m)),
    sh('10-links/lldp_collect.sh', lldpSh()),
    sh('10-links/link_counters.sh', countersSh(m)),
    sh('10-links/_link_flap.sh', linkFlapSh()),
    sh('20-rdma/perftest_pairs.sh', perftestSh(m)),
    sh('30-collectives/_build.sh', ncclBuildSh(m)),
    sh('30-collectives/eta_mpirun.sh', etaMpirunSh(m)),
    sh('30-collectives/_eta_srun.sh', etaSrunSh(m)),
    sh('40-node/node_diag.sh', nodeDiagSh(m)),
    sh('50-storage/storage.sh', storageSh()),
    { path: '50-storage/fio-seq.fio', content: FIO_JOB, mime: 'text/plain' },
    sh('60-thermal-power/redfish_poll.sh', redfishSh()),
    { path: 'logs/.keep', content: '', mime: 'text/plain' },
    ...pythonFiles(m).map((f) => ({ ...f, mime: f.path.endsWith('.py') ? 'text/x-python' : 'text/plain' })),
  ];
  return files;
}
