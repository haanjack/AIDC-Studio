// Max-Q stranded-power model (stream T3, DECISIONS-v2-2 §B/§C — AIDC Studio worked example; concept per the public MaxLPS documentation and blog).
//
// Called by analyzeProject after the analysis object is built; attached to `analysis.power.maxq` when defined.
//
// Model (AIDC Studio derivation, `derived`):
//   static   : every rack is allocated A_i (Max-P). stranded = Σ (A_i − D_i)  (power allocated but unused)
//   dynamic  : admit racks on *draw* instead of allocation: extra = floor((B − Σ D − m·B) / D_new)
//   headroom : B − m·B − Σ D − extra·D_new
//   cap depth: 1 − B / (n_dynamic · Ā)  — the throttle DPS must apply if every rack peaks at its allocation together
// Allocation basis (DECISIONS-v2-2 §C): catalog Max-P (the catalog nameplate; no separate Max-P field exists), with
//   Vera Rubin NVL72 selectable between 227 kW MaxP (vendor MaxLPS documentation) and 136 kW provisioned / 101 kW MaxQ (MaxLPS blog).
// Draw basis: workload power profile (analysis.workloads peak or avg ÷ allocation, GPU-weighted), else catalog typical / nameplate.
//   polish v2 2차 (QA m3): the workload profile includes its network share (engines/workload.ts netShare = network kW × job GPUs ÷
//   project GPUs); that share is removed before the per-GPU ratio because switches and optics are not on the GPU racks' allocation.
//   The ratio is not clamped at 1.0: a draw above the allocation is reported (utilization > 1) instead of being hidden.
// Budget basis (polish v2 2차, `power.maxq.budgetBasis`, default 'allocation'):
//   allocation  : B = Σ rack allocation — default; the worked example uses 5 × 130 kW = 650 kW;
//   hall-budget : B = Σ over halls with GPU racks (hall IT power budget − non-GPU IT design load in that hall) — the envelope the
//                 hall was provisioned for, so headroom already stranded at the hall level counts too;
//   custom      : B = power.maxq.budgetKW (e.g. a busway / UPS envelope the user derived).
//
// Worked example (AIDC Studio, `derived`): 5 racks × 130 kW budget = 650 kW; draws 105/95/109/87/79 = 475 kW → 175 kW stranded;
//   dynamic Max-Q admits one more 110 kW rack (585 ≤ 650 kW).
import { findCatalogItem } from '../catalog/catalog.ts';
import type { EvidenceSourceType, MaxQReport, Project, ProjectAnalysis } from '../model/types.ts';

export interface MaxQSource { label: string; url?: string; sourceType: EvidenceSourceType }

export const MAXQ_SOURCES = {
  workedExample: { label: 'AIDC Studio worked example of static vs dynamic Max-Q provisioning (5 × 130 kW budget, draws 475 kW → 175 kW stranded, +1 × 110 kW rack); the concept follows the NVIDIA Technical Blog post on MaxLPS performance per watt (2026-08-24)', sourceType: 'derived' },
  // P6 term sweep: both public pages have the blueprint abbreviation in their URL path, so they are cited by publisher, page title
  // and date (docs.nvidia.com / developer.nvidia.com, accessed 2026-09-15) without the URL.
  maxlpsDocs: { label: 'NVIDIA MaxLPS documentation, overview page (docs.nvidia.com, accessed 2026-09-15): Vera Rubin 227 kW MaxP TDP as the fixed per-rack allocation basis', sourceType: 'vendor-claim' },
  maxlpsBlog: { label: 'NVIDIA Technical Blog post on MaxLPS performance per watt (developer.nvidia.com, S. McKenney and H. Petty, 2026-08-24): VR NVL72 136 → 101 kW, GB200 NVL72 125 → 90 kW', sourceType: 'vendor-claim' },
  model: { label: 'AIDC Studio closed-form stranded-power model', sourceType: 'derived' },
} satisfies Record<string, MaxQSource>;

/** Vera Rubin NVL72 allocation options (DECISIONS-v2-2 §C). */
export const VR_MAXQ_OPTIONS: { id: 'maxlps-docs' | 'maxlps-blog'; maxpKW: number; maxqKW?: number; source: MaxQSource }[] = [
  { id: 'maxlps-docs', maxpKW: 227, source: MAXQ_SOURCES.maxlpsDocs },
  { id: 'maxlps-blog', maxpKW: 136, maxqKW: 101, source: MAXQ_SOURCES.maxlpsBlog },
];

/** Static Max-P → Max-Q provisioning published in the MaxLPS blog (per rack model id). */
export const BLOG_PROVISIONING: Record<string, { maxpKW: number; maxqKW: number }> = {
  'nvidia-vr-nvl72': { maxpKW: 136, maxqKW: 101 },
  'nvidia-gb200-nvl72': { maxpKW: 125, maxqKW: 90 },
};

const VR_ID = 'nvidia-vr-nvl72';

export interface MaxQRackInput { allocationKW: number; drawKW: number; gpus?: number }

export interface MaxQModelResult {
  budgetKW: number;
  allocatedKW: number;
  drawKW: number;
  strandedKW: number;
  staticRacks: number;
  extraRacks: number;
  dynamicRacks: number;
  dynamicDrawKW: number;
  headroomKW: number;
  reserveKW: number;
  newRackDrawKW: number;
  capDepth: number;
  gpusStatic: number;
  gpusDynamic: number;
  gpusPerMWStatic: number;
  gpusPerMWDynamic: number;
}

/** Pure closed-form model over explicit racks (reproduces the worked example exactly). */
export function maxqModel(racks: readonly MaxQRackInput[], opts: { budgetKW?: number; newRackDrawKW?: number; reserveFraction?: number; gpusPerRack?: number } = {}): MaxQModelResult {
  const allocatedKW = racks.reduce((s, r) => s + r.allocationKW, 0);
  // polish v2 2차: draws are not clamped at the allocation (a draw above it makes stranded power negative, which the report flags)
  const drawKW = racks.reduce((s, r) => s + r.drawKW, 0);
  const budgetKW = opts.budgetKW ?? allocatedKW;
  const m = Math.max(0, opts.reserveFraction ?? 0);
  const reserveKW = m * budgetKW;
  const newRackDrawKW = opts.newRackDrawKW ?? racks.reduce((mx, r) => Math.max(mx, r.drawKW), 0);
  const strandedKW = allocatedKW - drawKW;
  const extraRacks = newRackDrawKW > 0 ? Math.max(0, Math.floor((budgetKW - reserveKW - drawKW) / newRackDrawKW + 1e-9)) : 0;
  const dynamicDrawKW = drawKW + extraRacks * newRackDrawKW;
  const n = racks.length;
  const meanAlloc = n ? allocatedKW / n : 0;
  const dynamicRacks = n + extraRacks;
  const capDepth = dynamicRacks > 0 && meanAlloc > 0 ? Math.max(0, 1 - budgetKW / (dynamicRacks * meanAlloc)) : 0;
  const gpusStatic = racks.reduce((s, r) => s + (r.gpus ?? 0), 0);
  const gpusPerRack = opts.gpusPerRack ?? (n ? gpusStatic / n : 0);
  const gpusDynamic = gpusStatic + extraRacks * gpusPerRack;
  const mw = budgetKW / 1000;
  return {
    budgetKW, allocatedKW, drawKW, strandedKW, staticRacks: n, extraRacks, dynamicRacks, dynamicDrawKW,
    headroomKW: budgetKW - reserveKW - dynamicDrawKW, reserveKW, newRackDrawKW, capDepth,
    gpusStatic, gpusDynamic, gpusPerMWStatic: mw > 0 ? gpusStatic / mw : 0, gpusPerMWDynamic: mw > 0 ? gpusDynamic / mw : 0,
  };
}

export function analyzeMaxQ(project: Project, analysis: ProjectAnalysis): MaxQReport | undefined {
  const opts = project.power.maxq ?? {};
  const vrBasis = opts.vrBasis ?? 'maxlps-docs';
  const drawPref = opts.drawBasis ?? 'peak';
  const racks: { id: string; allocationKW: number; typicalKW: number; gpus: number }[] = [];
  const models = new Map<string, number>();
  for (const e of project.equipment) {
    const item = findCatalogItem(e.catalogId);
    if (!item || item.category !== 'gpu-rack' || !item.power) continue;
    const allocationKW = item.id === VR_ID && vrBasis === 'maxlps-blog' ? BLOG_PROVISIONING[VR_ID].maxpKW : item.power.nameplateKW;
    if (!(allocationKW > 0)) continue;
    racks.push({ id: e.id, allocationKW, typicalKW: item.power.typicalKW || item.power.nameplateKW, gpus: item.compute?.gpus ?? 0 });
    models.set(item.id, (models.get(item.id) ?? 0) + 1);
  }
  if (!racks.length) return undefined;

  const allocTotal = racks.reduce((s, r) => s + r.allocationKW, 0);
  const gpuTotal = racks.reduce((s, r) => s + r.gpus, 0);
  const kwPerGpu = gpuTotal > 0 ? allocTotal / gpuTotal : 0;
  // utilisation of the allocation from the workload power profile (GPU-weighted), network share removed, not clamped
  const projectGpus = Math.max(1, analysis.summary?.gpus ?? gpuTotal);
  const networkKW = analysis.power.networkKW ?? 0;
  let wsum = 0;
  let usum = 0;
  for (const w of analysis.workloads) {
    const p = drawPref === 'avg' ? w.avgPowerKW : w.peakPowerKW;
    if (!(w.gpus > 0) || !(p > 0) || !(kwPerGpu > 0)) continue;
    const share = (networkKW * w.gpus) / projectGpus;
    usum += (Math.max(0, p - share) / (w.gpus * kwPerGpu)) * w.gpus;
    wsum += w.gpus;
  }
  const drawBasis: MaxQReport['drawBasis'] = wsum > 0 ? drawPref : 'catalog-typical';
  const utilization = wsum > 0 ? usum / wsum : undefined;

  const budgetBasis = opts.budgetBasis ?? 'allocation';
  let budgetKW: number | undefined;
  if (budgetBasis === 'hall-budget') {
    const div = project.power.diversityFactor;
    const gpuByHall = new Map<string, number>();
    for (const r of racks) {
      const e = project.equipment.find((x) => x.id === r.id);
      if (e) gpuByHall.set(e.hallId, (gpuByHall.get(e.hallId) ?? 0) + (findCatalogItem(e.catalogId)?.power?.nameplateKW ?? 0) * div);
    }
    budgetKW = 0;
    for (const h of analysis.power.perHall) {
      if (!gpuByHall.has(h.hallId)) continue;
      const nonGpuKW = Math.max(0, h.itKW - (gpuByHall.get(h.hallId) ?? 0));
      budgetKW += Math.max(0, h.budgetKW - nonGpuKW);
    }
  } else if (budgetBasis === 'custom' && (opts.budgetKW ?? 0) > 0) budgetKW = opts.budgetKW;
  const model = maxqModel(
    racks.map((r) => ({ allocationKW: r.allocationKW, drawKW: utilization !== undefined ? utilization * r.allocationKW : Math.min(r.typicalKW, r.allocationKW), gpus: r.gpus })),
    { reserveFraction: opts.reserveFraction ?? 0, ...(budgetKW !== undefined ? { budgetKW } : {}) },
  );

  const dominant = [...models].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
  const hasVr = models.has(VR_ID);
  const sources: MaxQSource[] = [MAXQ_SOURCES.workedExample, MAXQ_SOURCES.model];
  if (hasVr) sources.push(vrBasis === 'maxlps-blog' ? MAXQ_SOURCES.maxlpsBlog : MAXQ_SOURCES.maxlpsDocs);
  const blog = BLOG_PROVISIONING[dominant];
  let staticMaxQ: MaxQReport['staticMaxQ'];
  if (blog && models.size === 1) {
    // fix v2 2차 (QA): the blog's Max-Q setting is relative to ITS Max-P (VR 101 of 136 kW). On another allocation basis (227 kW docs)
    // the setting is scaled by the same ratio, maxqKW × A ÷ maxpKW, and marked derived — so the static rack gain equals gainPct.
    const A = allocTotal / racks.length;
    const onBlogBasis = Math.abs(A - blog.maxpKW) < 1e-6;
    const settingKW = onBlogBasis ? blog.maxqKW : (blog.maxqKW * A) / blog.maxpKW;
    staticMaxQ = {
      settingKW,
      maxpKW: onBlogBasis ? blog.maxpKW : A,
      racks: Math.floor(model.budgetKW / settingKW + 1e-9),
      gainPct: (blog.maxpKW / blog.maxqKW - 1) * 100,
      source: onBlogBasis ? MAXQ_SOURCES.maxlpsBlog.label : `${MAXQ_SOURCES.maxlpsBlog.label} — setting scaled to the ${Math.round(A)} kW allocation (${blog.maxqKW} × ${Math.round(A)} ÷ ${blog.maxpKW}, derived)`,
      ...(onBlogBasis ? {} : { derived: true }),
    };
    if (!sources.includes(MAXQ_SOURCES.maxlpsBlog)) sources.push(MAXQ_SOURCES.maxlpsBlog);
  }
  const allocationBasis = hasVr
    ? vrBasis === 'maxlps-blog' ? 'Vera Rubin 136 kW provisioned (MaxLPS blog), other racks catalog nameplate' : 'Vera Rubin 227 kW MaxP (MaxLPS docs = catalog nameplate), other racks catalog nameplate'
    : 'catalog Max-P = nameplate (no separate Max-P field in the catalog)';

  return {
    budgetKW: model.budgetKW,
    drawKW: model.drawKW,
    strandedKW: model.strandedKW,
    extraRacks: model.extraRacks,
    gpusPerMWStatic: model.gpusPerMWStatic,
    gpusPerMWDynamic: model.gpusPerMWDynamic,
    source: sources.map((s) => `${s.label} (${s.sourceType})`).join('; '),
    racks: racks.length,
    gpus: gpuTotal,
    allocationKWPerRack: allocTotal / racks.length,
    drawKWPerRack: model.drawKW / racks.length,
    newRackDrawKW: model.newRackDrawKW,
    headroomKW: model.headroomKW,
    capDepth: model.capDepth,
    reserveKW: model.reserveKW,
    allocationBasis,
    drawBasis,
    staticMaxQ,
    sources,
    budgetBasis: budgetKW === undefined ? 'allocation' : budgetBasis,
    allocatedKW: model.allocatedKW,
    ...(utilization !== undefined ? { utilization, networkShareKW: (networkKW * wsum) / projectGpus } : {}),
  };
}
