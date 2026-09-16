// r4 drawings test helpers (stream B0; not a test file). Shared by drawings-sheets-r4 and drawings-golden; B1 / B2 may import them.
import { createHash } from 'node:crypto';
import { analyzeProject, createNvidiaReferenceProject, emptyDrawList, generateHallLayout, primAabb, resolveLayoutTemplate, roundUpToGrid, type DrawingCut, type DrawItem2D, type DrawList2D, type HallPrims, type Project, type ProjectAnalysis } from '../src/index.ts';
import { MARGIN, TITLE_BAND_H, TITLE_COL_W } from '../src/drawings/sheet.ts';
import { MIN_TEXT_MM, textWidth } from '../src/drawings/svg.ts';
import { R4_FX_HALL, r4FixtureHallPrims } from './fixtures/r4-prims.ts';
import { createRefPodFixture } from './fixtures/ref-pod.ts';

// ── fixture draw lists (stand-ins while A0's projections land; B0 tests and goldens only) ──

/** Minimal plan projection of the fixture prims: AABB rects, cut at 1.2 m. */
export function fixturePlanList(hp: HallPrims = r4FixtureHallPrims()): DrawList2D {
  const list = emptyDrawList('plan', hp.hallId, { x: 0, y: 0, w: R4_FX_HALL.width, d: R4_FX_HALL.depth });
  for (const p of hp.prims) {
    if (p.emitter === 'ceiling') continue;
    const bb = primAabb(p);
    const role: DrawItem2D['role'] = bb.min.z <= 1.2 && bb.max.z >= 1.2 ? 'cut' : bb.max.z < 1.2 ? 'below' : 'overhead';
    list.items.push({ kind: 'rect', pts: [bb.min.x, bb.min.y, bb.max.x - bb.min.x, bb.max.y - bb.min.y], role, layer: p.layer, lodMin: 1, style: (p.meta?.category as string) ?? p.system ?? p.emitter, primId: p.id, ...(p.refId ? { refId: p.refId } : {}) });
  }
  return list;
}

/** Minimal section projection: plane ⟂ y at `at` (look +1), u = x, depth 1.2 m. */
export function fixtureSectionList(at = 4.0, hp: HallPrims = r4FixtureHallPrims()): DrawList2D {
  const cut: DrawingCut = { id: 'A', label: 'A–A', hallId: hp.hallId, axis: 'y', at, look: 1, depthM: 1.2 };
  const list = emptyDrawList('section', hp.hallId, { x: -0.3, y: -0.3, w: R4_FX_HALL.width + 0.6, d: 5.3 }, { cut });
  for (const p of hp.prims) {
    const bb = primAabb(p);
    const isCut = bb.min.y <= at && bb.max.y >= at;
    const beyond = !isCut && bb.min.y > at && bb.min.y <= at + 1.2;
    if (!isCut && !beyond) continue;
    list.items.push({ kind: 'rect', pts: [bb.min.x, bb.min.z, bb.max.x - bb.min.x, bb.max.z - bb.min.z], role: isCut ? 'cut' : 'beyond', layer: p.layer, lodMin: 1, style: (p.meta?.category as string) ?? p.system ?? p.emitter, primId: p.id, depth: isCut ? 0 : bb.min.y - at });
  }
  return list;
}

/** Reference project whose only hall is the fixture hall (annotate reads hall extents / locale from the project). */
export function fixtureProject(): Project {
  const p = fix(createNvidiaReferenceProject().project);
  p.halls = [structuredClone(R4_FX_HALL)];
  p.equipment = [];
  return p;
}

const fix = (p: Project): Project => {
  p.updatedAt = '2026-09-14T00:00:00.000Z';
  p.createdAt = '2026-09-01T00:00:00.000Z';
  return p;
};

export function refProject(): Project {
  return fix(createNvidiaReferenceProject().project);
}

/** Synthetic single-POD fixture (fixtures/ref-pod.ts; authored from AIDC Studio parameters, always present). */
export function podProject(): Project | null {
  return fix(createRefPodFixture());
}

/** RCU template hall (layout-templates.test.ts recipe): one pod, enclosures of 4 in meta.rcu. */
export function rcuProject(): Project {
  const t = resolveLayoutTemplate('rcu-row')!;
  const p: Project = structuredClone(createNvidiaReferenceProject({ pods: 1 }).project);
  const hall = p.halls[0];
  hall.itPowerBudgetKW = 1e9;
  hall.liquidCoolingBudgetKW = 1e9;
  hall.airCoolingBudgetKW = 1e9;
  p.site.utility.forEach((u) => (u.capacityMVA = 1e6));
  const opts = { hall, pods: 1, template: t.pod, services: { spineRacks: 'auto' as const, storageRacks: 2, cpuRacks: 1, mgmtRacks: 1 }, crahCatalogId: 'vertiv-cw375', crahs: 'auto' as const, crahRedundancy: 'N+1' as const, marginM: 1, podsPerWave: 2, spinePlacement: 'central-end' as const, templateId: t.id };
  const probe = generateHallLayout(opts);
  hall.width = roundUpToGrid(probe.requiredWidth, 0.6);
  hall.depth = roundUpToGrid(probe.requiredDepth, 0.6);
  hall.keepouts = [];
  const layout = generateHallLayout(opts);
  p.equipment = layout.equipment;
  p.containments = layout.containments;
  p.trays = undefined;
  p.busways = undefined;
  p.network.scaleOut.switchCatalogId = t.pod.scaleOutSwitchCatalogId;
  p.cooling.cduCatalogId = t.pod.cduCatalogId;
  return fix(p);
}

/** A project whose only hall is empty (no equipment). */
export function emptyHallProject(): Project {
  const p = refProject();
  p.halls = [p.halls[p.halls.length - 1]];
  p.equipment = [];
  p.containments = [];
  p.trays = [];
  p.busways = [];
  return p;
}

export function analysisOf(p: Project): ProjectAnalysis {
  return analyzeProject(p);
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
/** Digest of the model input (analysis.generatedAt removed) — goldens skip byte / structure compares when another workflow changed it. */
export const inputDigest = (p: Project, a: ProjectAnalysis | null) => sha(`${JSON.stringify(p)}\n${JSON.stringify(a, (k, v) => (k === 'generatedAt' ? undefined : v))}`);

/** Tag-balance checker (node: no DOMParser). */
export function checkBalanced(svg: string): { ok: boolean; error?: string } {
  const stack: string[] = [];
  const re = /<(\/?)([A-Za-z][\w:-]*)([^<>]*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg))) {
    const [, close, name, , self] = m;
    if (close) {
      const top = stack.pop();
      if (top !== name) return { ok: false, error: `expected </${top}> got </${name}> at ${m.index}` };
    } else if (!self) stack.push(name);
  }
  return stack.length ? { ok: false, error: `unclosed ${stack.join(',')}` } : { ok: true };
}

export function rootPaper(svg: string): { w: number; h: number } | null {
  const m = /^<svg [^>]*width="([\d.]+)mm" height="([\d.]+)mm"/.exec(svg);
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
}

/**
 * T5 sheet checks: balanced XML, no NaN / Infinity / undefined, every font-size ≥ MIN_TEXT_MM, and every element inside a
 * `<g data-layer>` group lies in the content area (inside the frame, left of the title-block column; 0.5 mm tolerance).
 */
export function sheetProblems(svg: string, paper: { w: number; h: number }): string[] {
  const out: string[] = [];
  const b = checkBalanced(svg);
  if (!b.ok) out.push(`unbalanced: ${b.error}`);
  for (const w of ['NaN', 'Infinity', 'undefined']) if (svg.includes(w)) out.push(`contains ${w}`);
  for (const m of svg.matchAll(/font-size="([\d.]+)"/g)) if (Number(m[1]) < MIN_TEXT_MM - 1e-9) out.push(`font-size ${m[1]} < ${MIN_TEXT_MM}`);
  const x0 = MARGIN - 0.5;
  const x1 = paper.w - MARGIN - TITLE_COL_W + 0.5;
  const y0 = MARGIN + TITLE_BAND_H - 0.5;
  const y1 = paper.h - MARGIN + 0.5;
  const re = /<(\/?)([A-Za-z][\w:-]*)([^<>]*?)(\/?)>([^<]*)/g;
  const stack: boolean[] = [];
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(svg)) && out.length < 20) {
    const [, close, name, attrs, self, after] = m;
    if (name === 'g') {
      if (close) stack.pop();
      else if (!self) stack.push(/data-layer=/.test(attrs) || (stack.length > 0 && stack[stack.length - 1]));
      continue;
    }
    if (close || !stack.length || !stack[stack.length - 1] || name === 'pattern' || name === 'clipPath') continue;
    const num = (k: string) => {
      const r = new RegExp(`\\s${k}="(-?[\\d.]+)"`).exec(attrs);
      return r ? Number(r[1]) : undefined;
    };
    const pts: [number, number][] = [];
    for (const [kx, ky] of [['x', 'y'], ['x1', 'y1'], ['x2', 'y2'], ['cx', 'cy']] as const) {
      const vx = num(kx);
      const vy = num(ky);
      if (vx !== undefined && vy !== undefined) pts.push([vx, vy]);
    }
    const w = num('width');
    const h = num('height');
    if (name === 'rect' && pts[0] && w !== undefined && h !== undefined) pts.push([pts[0][0] + w, pts[0][1] + h]);
    const pa = /\spoints="([^"]+)"/.exec(attrs);
    if (pa) for (const pr of pa[1].trim().split(/\s+/)) {
      const [px, py] = pr.split(',').map(Number);
      pts.push([px, py]);
    }
    if (name === 'text' && pts[0] && after && !/rotate\(/.test(attrs)) {
      const size = num('font-size') ?? 2.5;
      const tw = textWidth(after, size);
      const anchor = /text-anchor="(\w+)"/.exec(attrs)?.[1] ?? 'start';
      const lx = anchor === 'middle' ? pts[0][0] - tw / 2 : anchor === 'end' ? pts[0][0] - tw : pts[0][0];
      pts.push([lx, pts[0][1]], [lx + tw, pts[0][1]]);
    }
    for (const [px, py] of pts) {
      if (px < x0 || px > x1 || py < y0 || py > y1) {
        out.push(`<${name}> at ${px.toFixed(1)},${py.toFixed(1)} outside content (${x0}–${x1} × ${y0}–${y1}) ${after ? `"${after.slice(0, 30)}"` : ''}`);
        break;
      }
    }
    n++;
  }
  return out;
}
