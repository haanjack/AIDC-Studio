// Power one-line diagram as inline SVG (replaces the mermaid `flowchart TB` in the HTML document).
// Layered layout: rank = longest path from the utility sources; parentless feeders (generators, batteries) are
// pulled down to sit one rank above their first child; ranks wider than `maxPerRank` fold identical (kind, path)
// nodes into one "× n" box. Deterministic for identical input.
import type { Locale, OneLineNode, PowerAnalysis } from '../../model/types.ts';
import { BAND, INK, INK2, SERIES, box, legendItem, polyline, svgRoot, text, wrap } from './common.ts';

const PATH_COLOR: Record<string, string> = { A: SERIES[1], B: SERIES[0], C: SERIES[6] };
const NEUTRAL = INK2;

const KIND_LABEL: Record<Locale, Record<OneLineNode['kind'], string>> = {
  en: { utility: 'utility', transformer: 'transformer', generator: 'generator', switchgear: 'switchgear', ups: 'UPS', battery: 'battery', pdu: 'PDU', rpp: 'RPP', busway: 'busway', load: 'load', mech: 'mechanical' },
  ko: { utility: '수전', transformer: '변압기', generator: '발전기', switchgear: '배전반', ups: 'UPS', battery: '배터리', pdu: 'PDU', rpp: 'RPP', busway: '버스웨이', load: '부하', mech: '기계 부하' },
};

export interface OneLineSvgOptions {
  locale?: Locale;
  title?: string;
  /** widest rank before identical nodes fold into one box (default 10) */
  maxPerRank?: number;
  /** r4 (611 per hall): keep only the loads of these racks / busways and every node upstream of them (default: the whole site) */
  filter?: OneLineFilter;
}

/** r4 hall filter: loads whose refs meet `equipmentIds`, busway / RPP nodes whose refs meet `buswayIds`, and all their ancestors. */
export interface OneLineFilter {
  equipmentIds?: ReadonlySet<string>;
  buswayIds?: ReadonlySet<string>;
}

/**
 * Site one-line filtered to one hall (r4 sheet 611): the load nodes serving the hall's racks (refs ∩ equipmentIds), the busway / RPP
 * nodes carrying the hall's busways (refs ∩ buswayIds; nodes without refs stay when they feed a kept load), and every ancestor of
 * those, with the edges between kept nodes. Mechanical loads and other halls' loads drop out. Deterministic; input order kept.
 */
export function filterOneLine(oneLine: PowerAnalysis['oneLine'], f: OneLineFilter): PowerAnalysis['oneLine'] {
  const meets = (refs: string[] | undefined, set: ReadonlySet<string> | undefined) => !!refs && !!set && refs.some((r) => set.has(r));
  const seeds = new Set<string>();
  for (const n of oneLine.nodes) {
    if (n.kind === 'load' && meets(n.refs, f.equipmentIds)) seeds.add(n.id);
    if ((n.kind === 'busway' || n.kind === 'rpp') && meets(n.refs, f.buswayIds)) seeds.add(n.id);
  }
  const parents = new Map<string, string[]>();
  for (const e of oneLine.edges) parents.set(e.to, [...(parents.get(e.to) ?? []), e.from]);
  const keep = new Set<string>();
  const stack = [...seeds];
  while (stack.length) {
    const id = stack.pop()!;
    if (keep.has(id)) continue;
    keep.add(id);
    for (const p of parents.get(id) ?? []) if (!keep.has(p)) stack.push(p);
  }
  return { nodes: oneLine.nodes.filter((n) => keep.has(n.id)), edges: oneLine.edges.filter((e) => keep.has(e.from) && keep.has(e.to)) };
}

interface LNode { id: string; node: OneLineNode; members: string[] }

export function oneLineSvg(oneLine: PowerAnalysis['oneLine'], opts: OneLineSvgOptions = {}): string {
  const L: Locale = opts.locale ?? 'en';
  const title = opts.title ?? (L === 'ko' ? '단선도' : 'One-line diagram');
  const maxPerRank = opts.maxPerRank ?? 10;
  const src = opts.filter ? filterOneLine(oneLine, opts.filter) : oneLine;
  const nodes = [...src.nodes];
  if (!nodes.length) return svgRoot(480, 60, title, [text(16, 34, L === 'ko' ? '단선도 데이터 없음' : 'No one-line data', { fill: INK2 })]);
  const ids = new Set(nodes.map((n) => n.id));
  const edges = src.edges.filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to);
  const parents = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  for (const e of edges) {
    parents.set(e.to, [...(parents.get(e.to) ?? []), e.from]);
    children.set(e.from, [...(children.get(e.from) ?? []), e.to]);
  }
  // longest-path ranks (bounded relaxation → safe on accidental cycles)
  const rank = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  for (let it = 0; it < nodes.length; it++) {
    let changed = false;
    for (const e of edges) {
      const r = (rank.get(e.from) ?? 0) + 1;
      if (r > (rank.get(e.to) ?? 0) && r <= nodes.length) {
        rank.set(e.to, r);
        changed = true;
      }
    }
    if (!changed) break;
  }
  for (const n of nodes) {
    if (n.kind === 'utility' || parents.has(n.id)) continue;
    const kids = children.get(n.id) ?? [];
    if (kids.length) rank.set(n.id, Math.max(0, Math.min(...kids.map((k) => rank.get(k) ?? 0)) - 1));
  }
  const byRank = new Map<number, OneLineNode[]>();
  for (const n of nodes) byRank.set(rank.get(n.id)!, [...(byRank.get(rank.get(n.id)!) ?? []), n]);
  const ranks = [...byRank.keys()].sort((a, b) => a - b);

  // fold wide ranks
  const alias = new Map<string, string>();
  const layers: LNode[][] = [];
  const pathKey = (n: OneLineNode) => ({ A: 0, B: 1, C: 2 } as Record<string, number>)[n.path ?? ''] ?? 3;
  const pos = new Map<string, number>();
  for (const r of ranks) {
    let list = byRank.get(r)!;
    let layer: LNode[];
    if (list.length > maxPerRank) {
      const groups = new Map<string, OneLineNode[]>();
      for (const n of list) groups.set(`${n.kind}|${n.path ?? ''}`, [...(groups.get(`${n.kind}|${n.path ?? ''}`) ?? []), n]);
      layer = [...groups.entries()].map(([k, g]) => {
        const first = g[0];
        const id = g.length === 1 ? first.id : `group:${k}`;
        for (const m of g) alias.set(m.id, id);
        const label = g.length === 1 ? first.label : `${KIND_LABEL[L][first.kind]} × ${g.length}${first.path ? ` (${first.path})` : ''}`;
        const loadKW = g.reduce((s, m) => s + (m.loadKW ?? 0), 0);
        const ratingKVA = g.reduce((s, m) => s + (m.ratingKVA ?? 0), 0);
        return { id, node: { ...first, id, label, loadKW: loadKW || undefined, ratingKVA: ratingKVA || undefined }, members: g.map((m) => m.id) };
      });
    } else {
      layer = list.map((n) => {
        alias.set(n.id, n.id);
        return { id: n.id, node: n, members: [n.id] };
      });
    }
    // order: barycentre of already-placed parents, then A/B/C, then id
    const bary = (ln: LNode) => {
      const ps = ln.members.flatMap((m) => parents.get(m) ?? []).map((p) => pos.get(alias.get(p) ?? p)).filter((v): v is number => v !== undefined);
      return ps.length ? ps.reduce((s, v) => s + v, 0) / ps.length : Number.POSITIVE_INFINITY;
    };
    layer.sort((a, b) => {
      const ba = bary(a), bb = bary(b);
      if (ba !== bb) return (Number.isFinite(ba) ? ba : 1e9) - (Number.isFinite(bb) ? bb : 1e9);
      return pathKey(a.node) - pathKey(b.node) || a.id.localeCompare(b.id);
    });
    layer.forEach((ln, i) => pos.set(ln.id, i / Math.max(1, layer.length - 1)));
    list = [];
    layers.push(layer);
  }

  const W = 150, H = 50, GX = 20, GY = 44, M = 20, TOP = 46;
  const widest = Math.max(...layers.map((l) => l.length));
  const width = Math.max(560, M * 2 + widest * W + (widest - 1) * GX);
  const height = TOP + layers.length * H + (layers.length - 1) * GY + M;
  const xy = new Map<string, { x: number; y: number; color: string }>();
  layers.forEach((layer, ri) => {
    const rowW = layer.length * W + (layer.length - 1) * GX;
    const x0 = (width - rowW) / 2;
    layer.forEach((ln, i) => xy.set(ln.id, { x: x0 + i * (W + GX), y: TOP + ri * (H + GY), color: PATH_COLOR[ln.node.path ?? ''] ?? NEUTRAL }));
  });

  const body: string[] = [];
  // legend
  let lx = M;
  for (const [label, color] of [[L === 'ko' ? '경로 A' : 'Path A', PATH_COLOR.A], [L === 'ko' ? '경로 B' : 'Path B', PATH_COLOR.B], [L === 'ko' ? '예비 (C)' : 'Reserve (C)', PATH_COLOR.C], [L === 'ko' ? '공용' : 'Shared', NEUTRAL]] as const) {
    const [m, w] = legendItem(lx, 22, color, label);
    body.push(m);
    lx += w;
  }
  // edges (under the boxes), de-duplicated after folding
  const seen = new Set<string>();
  const sortedEdges = [...edges].sort((a, b) => (a.from + a.to).localeCompare(b.from + b.to));
  for (const e of sortedEdges) {
    const f = alias.get(e.from) ?? e.from, t = alias.get(e.to) ?? e.to;
    const k = `${f}>${t}`;
    if (f === t || seen.has(k)) continue;
    seen.add(k);
    const a = xy.get(f), b = xy.get(t);
    if (!a || !b) continue;
    const x1 = a.x + W / 2, y1 = a.y + H, x2 = b.x + W / 2, y2 = b.y;
    const color = b.color !== NEUTRAL ? b.color : a.color;
    if (y2 > y1) {
      const my = y1 + (y2 - y1) / 2;
      body.push(polyline([[x1, y1], [x1, my], [x2, my], [x2, y2]], color, 1.4));
    } else {
      // same-rank or upward link (rare): side connector
      body.push(polyline([[a.x + W, a.y + H / 2], [b.x, b.y + H / 2]], color, 1.2));
    }
  }
  // boxes
  for (const layer of layers) {
    for (const ln of layer) {
      const p = xy.get(ln.id)!;
      const n = ln.node;
      const rating = n.ratingKVA ? `${Math.round(n.ratingKVA).toLocaleString('en-US')} kVA` : n.loadKW ? `${Math.round(n.loadKW).toLocaleString('en-US')} kW` : '';
      const tip = [n.label, KIND_LABEL[L][n.kind], rating, n.path ? `path ${n.path}` : ''].filter(Boolean).join(' · ');
      body.push(`<g>${box(p.x, p.y, W, H, { fill: '#fff', stroke: p.color, sw: 1.4, rx: 3, title: tip })}${box(p.x, p.y, 5, H, { fill: p.color })}`);
      body.push(text(p.x + W - 6, p.y + 11, KIND_LABEL[L][n.kind].toUpperCase(), { size: 8, anchor: 'end', fill: INK2 }));
      const lines = wrap(n.label, 10.5, W - 16, rating ? 2 : 3);
      lines.forEach((l, i) => body.push(text(p.x + 11, p.y + 22 + i * 12.5, l, { size: 10.5, fill: INK, weight: i === 0 ? 600 : undefined })));
      if (rating) body.push(text(p.x + 11, p.y + H - 6, rating, { size: 9, fill: INK2 }));
      body.push('</g>');
    }
  }
  body.unshift(box(0, 0, width, 32, { fill: BAND }));
  return svgRoot(width, height, title, body);
}
