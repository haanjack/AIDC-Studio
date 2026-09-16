/// <reference lib="webworker" />
// r4 stream C (spec §3.4 Renderer): builds the 2D view's draw lists off the main thread.
//   project (per generation) → buildHallPrims (pod detail, cached per hall) → projectPlan / projectSection / projectElevation →
//   annotate (project.locale, view units) → packDrawList → transfer. Plus wall-audit clearance findings (cached per generation),
//   section depth windows of the plan's cuts, and "export current view" SVG through drawListToSvg.
import {
  annotate, auditHallGeometry, buildHallPrims, bundleFeederItems, feederBundleLabel, feederBundleMid, type Annotation2D, type FeederBundle, type Locale, WALL_AUDIT_FAIL_CHECKS, drawListToSvg, elevationCut, frameS, frameU, packDrawList, packedTransferables, projectElevation, projectPlan, projectSection,
  sectionDepth, type DrawingCut, type DrawingViewport, type DrawList2D, type HallPrims, type Project, type ProjectAnalysis,
} from '@aidc/core';
import type { BuildRequest, ClearanceMark, DrawlistWorkerRequest, DrawlistWorkerResponse, PrimInfo, Scene2D } from './scene.ts';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const post = (m: DrawlistWorkerResponse, transfer: Transferable[] = []) => ctx.postMessage(m, transfer);

let gen = -1;
let project: Project | null = null;
let analysis: ProjectAnalysis | null = null;
const hpCache = new Map<string, HallPrims>();
const auditCache = new Map<string, ClearanceMark[]>();

function hallPrims(hallId: string): { hp: HallPrims; ms: number } {
  const k = `${gen}|${hallId}`;
  const hit = hpCache.get(k);
  if (hit) return { hp: hit, ms: 0 };
  const t = performance.now();
  const hp = buildHallPrims(project!, analysis, { hallId, detail: 'pod' });
  if (hpCache.size >= 3) hpCache.delete(hpCache.keys().next().value as string);
  hpCache.set(k, hp);
  return { hp, ms: performance.now() - t };
}

function auditMarks(hallId: string, hp: HallPrims): { marks: ClearanceMark[]; ms: number } {
  if (!analysis || !project) return { marks: [], ms: 0 };
  const k = `${gen}|${hallId}`;
  const hit = auditCache.get(k);
  if (hit) return { marks: hit, ms: 0 };
  const t = performance.now();
  let marks: ClearanceMark[] = [];
  try {
    const rep = auditHallGeometry(project, analysis, hallId, { prims: hp });
    // fail-class checks only (the D1 acceptance rule); report-only checks stay in the audit report
    const fail = new Set(WALL_AUDIT_FAIL_CHECKS);
    marks = rep.violations.filter((v) => fail.has(v.check)).slice(0, 400).map((v, i) => ({ id: `${v.check}:${v.id}:${i}`, check: v.check, x: v.at.x, y: v.at.y, z: v.at.z, ...(v.depthM !== undefined ? { depthM: v.depthM } : {}) }));
  } catch {
    marks = [];
  }
  auditCache.set(k, marks);
  return { marks, ms: performance.now() - t };
}

/** Wall-audit marks located in the view: plan as is; section / elevation within the cut depth (u, z); + the top-clearance datum. */
function locateClearance(req: BuildRequest, hp: HallPrims, list: DrawList2D, cut: DrawingCut | undefined, depthM: number | undefined, all: readonly ClearanceMark[]): ClearanceMark[] {
  let clearance: ClearanceMark[] = [];
  if (req.space === 'plan') clearance = [...all];
  else if (cut) {
    const depth = req.space === 'section' ? depthM ?? cut.depthM : cut.depthM;
    clearance = all.filter((m) => {
      const s = frameS(cut, m.x, m.y);
      return s >= -0.3 && s <= depth + 0.3;
    }).map((m) => ({ ...m, x: frameU(cut, m.x, m.y), y: m.z }));
  }
  if (req.space !== 'plan') {
    const top = hp.datums.find((d) => d.id === 'top-clearance');
    const ceil = hp.datums.find((d) => d.id === 'ceiling');
    if (top && ceil && top.z > ceil.z + 1e-6) clearance.push({ id: 'top-clearance', check: 'top-clearance', x: list.bounds.x + list.bounds.w - 0.5, y: ceil.z, z: ceil.z, depthM: top.z - ceil.z });
  }
  return clearance;
}

/** The last build whose audit was not cached (only the newest request matters; older ones are superseded). */
let pendingAudit: { req: BuildRequest; hp: HallPrims; list: DrawList2D; cut?: DrawingCut; depthM?: number; gen: number } | null = null;
let auditTimer: ReturnType<typeof setTimeout> | null = null;

/** Run the pending wall audit after the scene was posted (a macrotask later, so the main thread paints first). */
function runAuditAfterPaint() {
  if (!pendingAudit) return;
  if (auditTimer) clearTimeout(auditTimer);
  auditTimer = setTimeout(() => {
    auditTimer = null;
    const job = pendingAudit;
    pendingAudit = null;
    if (!job || job.gen !== gen || !project) return;
    const { marks, ms } = auditMarks(job.req.hallId, job.hp);
    if (job.gen !== gen) return;
    post({ type: 'clearance', gen, key: job.req.key, clearance: locateClearance(job.req, job.hp, job.list, job.cut, job.depthM, marks), auditMs: ms });
  }, 0);
}

function listFor(req: BuildRequest, hp: HallPrims): { list: DrawList2D; depthM?: number; cut?: DrawingCut; bundles?: FeederBundle[] } {
  if (req.space === 'plan') {
    // backlog T2 #5: parallel feeders draw as one centre line + circuit count at hall / pod LOD, individually at detail LOD
    const b = bundleFeederItems(projectPlan(hp));
    return { list: b.list, bundles: b.bundles };
  }
  if (req.space === 'section') {
    const cut = req.cut;
    if (!cut) return { list: projectPlan(hp, { layers: [] }) };
    const preset = req.depth ?? 'next-row';
    const depthM = sectionDepth(hp, cut, preset);
    return { list: projectSection(hp, cut, { depth: preset }), depthM, cut };
  }
  if (!req.elevation) return { list: projectPlan(hp, { layers: [] }) };
  const list = projectElevation(hp, req.elevation);
  return { list, cut: elevationCut(hp, req.elevation) ?? undefined };
}

/** Circuit-count labels of the feeder bundles (plan, LOD 1–2 tags on the feeders layer). */
function bundleLabels(bundles: readonly FeederBundle[] | undefined, locale: Locale): Annotation2D[] {
  return (bundles ?? []).map((b) => ({ kind: 'tag' as const, pts: feederBundleMid(b), text: feederBundleLabel(locale, b.count), priority: 9, layer: 'feeders' as const, lodMin: 1 as const, size: 1.8, rot: b.axis === 'v' ? -90 : 0, refId: b.id }));
}

function build(req: BuildRequest): Scene2D {
  const t0 = performance.now();
  const { hp, ms: primsMs } = hallPrims(req.hallId);
  const t1 = performance.now();
  const { list, depthM, cut, bundles } = listFor(req, hp);
  const projMs = performance.now() - t1;
  const t2 = performance.now();
  const ann = list.items.length ? [...annotate(project!, hp, list, { locale: req.locale, units: req.units, scaleDen: req.space === 'plan' ? 100 : 50, cuts: [] }), ...bundleLabels(bundles, req.locale)] : [];
  const annMs = performance.now() - t2;
  const hall = project!.halls.find((h) => h.id === req.hallId);
  // clearance findings located in this view. backlog T2 #6: the wall audit (≈ 0.5 s on a 162 MW hall) no longer blocks the first paint —
  // a cached result is used at once, otherwise the scene goes out without it and a 'clearance' message follows (runAuditAfterPaint)
  const auditKey = `${gen}|${req.hallId}`;
  const cachedMarks = analysis && project ? auditCache.get(auditKey) : [];
  const clearance = locateClearance(req, hp, list, cut, depthM, cachedMarks ?? []);
  const auditMs = 0;
  if (!cachedMarks) pendingAudit = { req, hp, list, cut, depthM, gen };
  const t3 = performance.now();
  const packed = packDrawList(list);
  const packMs = performance.now() - t3;
  const prims: Record<string, PrimInfo> = {};
  const byId = new Map(hp.prims.map((p) => [p.id, p]));
  for (const it of list.items) {
    if (!it.primId || prims[it.primId]) continue;
    const p = byId.get(it.primId);
    if (!p) continue;
    const info: PrimInfo = { emitter: p.emitter, layer: p.layer, z0: Math.min(p.a.z, p.b.z) - (p.shape === 'bar' || p.shape === 'tube' ? p.halfH : 0), z1: Math.max(p.a.z, p.b.z) + (p.shape === 'bar' || p.shape === 'tube' ? p.halfH : 0) };
    if (typeof p.meta?.category === 'string') info.category = p.meta.category;
    if (p.system) info.system = p.system;
    if (p.tag) info.tag = p.tag;
    if (p.refId) info.refId = p.refId;
    if (p.rowId) info.rowId = p.rowId;
    if (p.podId) info.podId = p.podId;
    if (p.tier) info.tier = p.tier;
    if (p.meta) info.meta = p.meta;
    prims[it.primId] = info;
  }
  const cutDepths: Record<string, number> = {};
  if (req.space === 'plan') for (const c of req.cuts ?? []) cutDepths[c.id] = sectionDepth(hp, c, req.depth ?? 'next-row');
  return {
    key: req.key,
    space: req.space,
    hallId: req.hallId,
    packed,
    ann,
    prims,
    datums: hp.datums,
    rows: hp.rows,
    hallRect: { x: 0, y: 0, w: hall?.width ?? 0, d: hall?.depth ?? 0 },
    ...(cut ? { cut } : {}),
    ...(req.elevation && req.space === 'elevation' ? { elevation: req.elevation } : {}),
    ...(depthM !== undefined ? { depthM } : {}),
    ...(req.space === 'plan' ? { cutDepths } : {}),
    clearance,
    ...(cachedMarks ? {} : { auditPending: true }),
    ms: { prims: primsMs, project: projMs, annotate: annMs, audit: auditMs, pack: packMs, total: performance.now() - t0 },
    counts: { prims: hp.prims.length, items: list.items.length, ann: ann.length },
  };
}

ctx.onmessage = (ev: MessageEvent<DrawlistWorkerRequest>) => {
  const m = ev.data;
  if (m.type === 'project') {
    gen = m.gen;
    project = m.project;
    analysis = m.analysis;
    hpCache.clear();
    auditCache.clear();
    return;
  }
  if (!project) return;
  if (m.type === 'build') {
    try {
      pendingAudit = null;
      const scene = build(m);
      post({ type: 'scene', gen, scene }, packedTransferables(scene.packed));
      runAuditAfterPaint();
    } catch (e) {
      post({ type: 'error', gen, key: m.key, message: (e as Error).message });
    }
    return;
  }
  if (m.type === 'export-svg') {
    try {
      const { hp } = hallPrims(m.build.hallId);
      const { list, bundles } = listFor(m.build, hp);
      const ann = list.items.length ? [...annotate(project, hp, list, { locale: m.build.locale, units: m.build.units, scaleDen: m.build.space === 'plan' ? 100 : 50, cuts: [] }), ...bundleLabels(bundles, m.build.locale)] : [];
      const mm = 25.4 / 96;
      const W = m.widthPx * mm;
      const H = m.heightPx * mm;
      const vp: DrawingViewport = { paperRect: { x: 0, y: 0, w: W, h: H }, hallId: m.build.hallId, space: m.build.space, worldRect: m.world, mmPerM: W / m.world.w, ...(m.build.cut ? { cut: m.build.cut } : {}), ...(m.build.elevation ? { elevation: m.build.elevation } : {}) };
      const r = drawListToSvg(list, ann, vp, { hp, layers: (m.layers ?? undefined) as never, lod: m.lod, idPrefix: 'v2d-' });
      const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W.toFixed(2)}mm" height="${H.toFixed(2)}mm" viewBox="0 0 ${W.toFixed(3)} ${H.toFixed(3)}" font-family="Inter, 'Noto Sans KR', sans-serif">\n<title>${esc(m.title)}</title>\n<defs>${r.defs.join('')}</defs>\n<rect x="0" y="0" width="${W.toFixed(3)}" height="${H.toFixed(3)}" fill="#ffffff"/>\n${r.svg}\n</svg>\n`;
      post({ type: 'svg', gen, key: m.key, svg });
    } catch (e) {
      post({ type: 'error', gen, key: m.key, message: (e as Error).message });
    }
  }
};
