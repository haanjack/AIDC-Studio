// backlog T2 #5: feeder bundles on plans. Parallel circuit feeders of one route (end-aisle feeder tray → room sleeve) are drawn 0.05 m
// wide a few centimetres apart; at hall / pod scale they merged into a heavy overlapping hatch in the 2D plan (Power preset) and on
// sheet 111. A bundle is a set of feeder plan rects of one orientation whose centre lines chain at ≤ FEEDER_BUNDLE_LANE_M pitch and
// whose extents overlap (0.5 m tolerance). It is drawn as one centre line with a circuit-count label; the individual feeders
// move to the detail LOD band (3).
import type { Locale } from '../../model/types.ts';
import { drawListHash, type DrawItem2D, type DrawList2D } from '../drawList.ts';

/**
 * lateral chaining pitch (m): a feeder whose centre line is within this distance of the bundle's outermost member joins it, so a continuous
 * band of parallel feeders (≈ 0.1 m pitch on a feeder tray) is one bundle however wide it is; a route further away starts a new one
 */
export const FEEDER_BUNDLE_LANE_M = 0.35;
/** gap along the run that still joins two segments (m) */
export const FEEDER_BUNDLE_GAP_M = 0.5;

export interface FeederBundle {
  id: string;
  /** 'h' = along x, 'v' = along y (plan) */
  axis: 'h' | 'v';
  a0: number;
  a1: number;
  /** centre line (mean of the member centre lines) */
  c: number;
  /** lateral extent of the members (m) */
  c0: number;
  c1: number;
  /** distinct feeder paths (= circuits) */
  count: number;
  /** indices of the member items in the input list */
  itemIdx: number[];
}

/** Group the feeder plan rects of a draw list into bundles (pure, deterministic). */
export function feederBundles(items: readonly DrawItem2D[]): FeederBundle[] {
  interface Seg { i: number; axis: 'h' | 'v'; a0: number; a1: number; c: number; ref: string }
  const segs: Seg[] = [];
  items.forEach((it, i) => {
    if (it.layer !== 'feeders' || it.kind !== 'rect') return;
    const [x, y, w, d] = it.pts;
    const h = Math.abs(w) >= Math.abs(d);
    segs.push({ i, axis: h ? 'h' : 'v', a0: h ? Math.min(x, x + w) : Math.min(y, y + d), a1: h ? Math.max(x, x + w) : Math.max(y, y + d), c: h ? y + d / 2 : x + w / 2, ref: it.refId ?? it.primId ?? `#${i}` });
  });
  segs.sort((p, q) => (p.axis === q.axis ? 0 : p.axis === 'h' ? -1 : 1) || p.c - q.c || p.a0 - q.a0 || p.i - q.i);
  interface Acc { axis: 'h' | 'v'; a0: number; a1: number; c0: number; c1: number; cSum: number; n: number; refs: Set<string>; idx: number[] }
  const done: Acc[] = [];
  let active: Acc[] = [];
  let axis: 'h' | 'v' | null = null;
  for (const s of segs) {
    if (s.axis !== axis) {
      done.push(...active);
      active = [];
      axis = s.axis;
    }
    // bundles whose lane lies behind this centre line can never take a later segment (sorted by c)
    const still: Acc[] = [];
    for (const b of active) (s.c - b.c1 > FEEDER_BUNDLE_LANE_M ? done : still).push(b);
    active = still;
    const b = active.find((q) => s.c - q.c1 <= FEEDER_BUNDLE_LANE_M && s.a0 <= q.a1 + FEEDER_BUNDLE_GAP_M && q.a0 <= s.a1 + FEEDER_BUNDLE_GAP_M);
    if (b) {
      b.a0 = Math.min(b.a0, s.a0);
      b.a1 = Math.max(b.a1, s.a1);
      b.c1 = Math.max(b.c1, s.c);
      b.cSum += s.c;
      b.n++;
      b.refs.add(s.ref);
      b.idx.push(s.i);
    } else active.push({ axis: s.axis, a0: s.a0, a1: s.a1, c0: s.c, c1: s.c, cSum: s.c, n: 1, refs: new Set([s.ref]), idx: [s.i] });
  }
  done.push(...active);
  const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
  return done
    .map((b) => ({ axis: b.axis, a0: r6(b.a0), a1: r6(b.a1), c: r6(b.cSum / b.n), c0: r6(b.c0), c1: r6(b.c1), count: b.refs.size, itemIdx: b.idx.sort((p, q) => p - q) }))
    .sort((p, q) => (p.axis === q.axis ? 0 : p.axis === 'h' ? -1 : 1) || p.c - q.c || p.a0 - q.a0)
    .map((b, k) => ({ id: `feeder-bundle-${b.axis}${k + 1}`, ...b }));
}

/** Label of a bundle: its circuit count. */
export function feederBundleLabel(locale: Locale, count: number): string {
  return locale === 'ko' ? `회로 ${count}개` : `${count} circuits`;
}

/** Plan point at the middle of a bundle's centre line. */
export function feederBundleMid(b: FeederBundle): [number, number] {
  const m = (b.a0 + b.a1) / 2;
  return b.axis === 'h' ? [m, b.c] : [b.c, m];
}

/**
 * A copy of a plan draw list where every bundle of ≥ `minCount` circuits gets one centre-line polyline (LOD 1, layer 'feeders',
 * style 'feeder') and its member rects move to the detail band (lodMin 3). Item order of the input is kept; centre lines are appended.
 */
export function bundleFeederItems(list: DrawList2D, opts: { minCount?: number } = {}): { list: DrawList2D; bundles: FeederBundle[] } {
  const minCount = opts.minCount ?? 2;
  const bundles = feederBundles(list.items).filter((b) => b.count >= minCount);
  if (!bundles.length) return { list, bundles };
  const items = list.items.slice();
  for (const b of bundles) {
    for (const i of b.itemIdx) if (items[i].lodMin < 3) items[i] = { ...items[i], lodMin: 3 };
    const first = list.items[b.itemIdx[0]];
    items.push({
      kind: 'polyline',
      pts: b.axis === 'h' ? [b.a0, b.c, b.a1, b.c] : [b.c, b.a0, b.c, b.a1],
      role: first.role,
      layer: 'feeders',
      lodMin: 1,
      style: 'feeder',
      refId: b.id,
    });
  }
  const out = { ...list, items };
  return { list: { ...out, hash: drawListHash(out) }, bundles };
}
