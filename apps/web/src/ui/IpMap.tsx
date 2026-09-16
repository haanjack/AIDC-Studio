import { useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { findInIpMap, ipMapPath, rangeLabel, type IpMap, type IpMapMatch, type IpMapNode } from '@aidc/core';
import { useT } from '../i18n/index.ts';

// Nested block map of the IP plan (Network › IP map). Cells: squarified treemap of the focused node's children with one nested level;
// area ∝ log₂(addresses) so a /24 stays visible next to a /10 — the bar above shows the true address positions. Colour: one hue, by utilisation.

const MAX_CELLS = 96;
const MAX_NESTED = 64;
const STEP_OPACITY = [0.08, 0.22, 0.38, 0.58, 0.85];
const STEP_LABELS = ['0', '< 1 %', '1–10 %', '10–50 %', '≥ 50 %'];

const stepOf = (n: IpMapNode) => (n.used === 0 ? 0 : n.utilisation < 0.01 ? 1 : n.utilisation < 0.1 ? 2 : n.utilisation < 0.5 ? 3 : 4);
export const pctText = (u: number) => (u === 0 ? '0 %' : u < 0.001 ? '< 0.1 %' : `${(u * 100).toFixed(u < 0.1 ? 1 : 0)} %`);
const rangeOf = (n: IpMapNode) => n.cidr ?? rangeLabel(n.start, n.size);

interface Box { x: number; y: number; w: number; h: number }

/** Squarified treemap (Bruls et al.), order preserved. */
export function squarify(values: number[], x: number, y: number, w: number, h: number): Box[] {
  const out: Box[] = new Array(values.length);
  const total = values.reduce((a, b) => a + b, 0);
  if (!values.length || total <= 0 || w <= 0 || h <= 0) return values.map(() => ({ x, y, w: 0, h: 0 }));
  let rest = values.map((v, i) => ({ i, a: (v / total) * w * h }));
  let rx = x, ry = y, rw = w, rh = h;
  const worst = (row: { a: number }[], s: number) => {
    const sum = row.reduce((a, r) => a + r.a, 0);
    const max = Math.max(...row.map((r) => r.a));
    const min = Math.min(...row.map((r) => r.a));
    return Math.max((s * s * max) / (sum * sum), (sum * sum) / (s * s * min));
  };
  while (rest.length) {
    const short = Math.min(rw, rh);
    let row = [rest[0]];
    let best = worst(row, short);
    for (let k = 1; k < rest.length; k++) {
      const cand = [...row, rest[k]];
      const wv = worst(cand, short);
      if (wv > best) break;
      row = cand;
      best = wv;
    }
    const area = row.reduce((a, r) => a + r.a, 0);
    if (rw >= rh) {
      const cw = area / rh;
      let cy = ry;
      for (const r of row) { const hh = r.a / cw; out[r.i] = { x: rx, y: cy, w: cw, h: hh }; cy += hh; }
      rx += cw;
      rw -= cw;
    } else {
      const ch = area / rw;
      let cx = rx;
      for (const r of row) { const ww = r.a / ch; out[r.i] = { x: cx, y: ry, w: ww, h: ch }; cx += ww; }
      ry += ch;
      rh -= ch;
    }
    rest = rest.slice(row.length);
  }
  return out;
}

const weight = (n: IpMapNode) => Math.log2(Math.max(1, n.size)) + 2;

export function IpMapView({ map }: { map: IpMap }) {
  const t = useT();
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(560);
  const [focusId, setFocusId] = useState(map.root.id);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<IpMapMatch[]>([]);
  const [hover, setHover] = useState<{ node: IpMapNode; x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(280, Math.floor(el.clientWidth)));
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);

  const focusPath = useMemo(() => { const p = ipMapPath(map.root, focusId); return p.length ? p : [map.root]; }, [map, focusId]);
  const focus = focusPath[focusPath.length - 1];
  const selectedPath = useMemo(() => (selectedId ? ipMapPath(map.root, selectedId) : []), [map, selectedId]);
  const hit = useMemo(() => new Set(selectedPath.map((n) => n.id)), [selectedPath]);
  const selected = selectedPath[selectedPath.length - 1];
  const activeMatch = matches.find((m) => m.path[m.path.length - 1].id === selectedId);

  const jump = (m: IpMapMatch) => {
    const leaf = m.path[m.path.length - 1];
    setSelectedId(leaf.id);
    setFocusId((leaf.children.length ? leaf : m.path[m.path.length - 2] ?? map.root).id);
  };
  const onQuery = (v: string) => {
    setQuery(v);
    const found = v.trim() ? findInIpMap(map, v, 12) : [];
    setMatches(found);
    if (found[0]) jump(found[0]);
    else if (!v.trim()) setSelectedId(null);
  };

  const H = Math.round(Math.min(560, Math.max(320, width * 0.66)));
  // at most MAX_CELLS cells: when the selected / searched node lies beyond them, shift the window (address order kept) so its cell is drawn
  const hitIdx = focus.children.length > MAX_CELLS ? focus.children.findIndex((c) => hit.has(c.id)) : -1;
  const offset = hitIdx >= MAX_CELLS ? Math.min(hitIdx - Math.floor(MAX_CELLS / 2), focus.children.length - MAX_CELLS) : 0;
  const cells = focus.children.slice(offset, offset + MAX_CELLS);
  const boxes = squarify(cells.map(weight), 0, 0, width, H);
  const tip = (e: ReactMouseEvent, node: IpMapNode) => {
    e.stopPropagation();
    const r = boxRef.current?.getBoundingClientRect();
    if (!r) return;
    const x = e.clientX - r.left + 14;
    setHover({ node, x: x > width - 300 ? Math.max(0, x - 320) : x, y: e.clientY - r.top + 14 });
  };
  const open = (n: IpMapNode, parent: IpMapNode) => {
    if (n.children.length) setFocusId(n.id);
    else {
      setFocusId(parent.id);
      setSelectedId(n.id);
    }
  };
  const detail = selected ?? focus;

  return (
    <div className="ipmap" data-ipmap>
      <p className="hint" style={{ marginTop: 0 }}>{t('ipmap.hint')}</p>
      <div className="row wrap" style={{ gap: 8, alignItems: 'flex-end' }}>
        <div className="field" style={{ minWidth: 260, flex: '1 1 260px' }}>
          <label htmlFor="ipmap-search">{t('ipmap.search')}</label>
          <input id="ipmap-search" type="search" value={query} onChange={(e) => onQuery(e.target.value)} placeholder={t('ipmap.searchPlaceholder')} data-ipmap-search />
        </div>
      </div>
      {query.trim() && (
        <div className="ipmap-matches">
          {matches.length ? matches.slice(0, 8).map((m) => {
            const leaf = m.path[m.path.length - 1];
            return (
              <button key={leaf.id} type="button" className={`btn sm ${leaf.id === selectedId ? 'active' : ''}`} data-ro-allow onClick={() => jump(m)}>
                {rangeOf(leaf)}{m.member ? ` · ${m.member}` : ` · ${leaf.label}`}
              </button>
            );
          }) : <span className="hint">{t('ipmap.noMatch')}</span>}
        </div>
      )}

      <nav className="ipmap-crumbs" aria-label="IP map path">
        {focusPath.map((n, i) => (
          <span key={n.id} style={{ display: 'inline-flex', alignItems: 'center' }}>
            {i > 0 && <span aria-hidden>›</span>}
            <button type="button" data-ro-allow disabled={n.id === focus.id} onClick={() => setFocusId(n.id)}>{n.label}{n.cidr ? ` ${n.cidr}` : ''}</button>
          </span>
        ))}
      </nav>

      <div ref={boxRef} style={{ position: 'relative' }} onMouseLeave={() => setHover(null)}>
        {/* true address positions inside the focused node */}
        <div className="caption" style={{ margin: '0 0 2px' }}>{t('ipmap.bar', { cidr: rangeOf(focus) })}</div>
        <svg className="ipmap-bar" width={width} height={22} role="img" aria-label={t('ipmap.bar', { cidr: rangeOf(focus) })}>
          <rect x={0} y={2} width={width} height={18} rx={3} fill="var(--surface-1)" stroke="var(--border)" />
          {focus.children.map((c) => {
            const x = ((c.start - focus.start) / focus.size) * width;
            const w = Math.max(2, (c.size / focus.size) * width);
            return <rect key={c.id} className={`seg-fill ${hit.has(c.id) ? 'hit' : ''}`} x={x} y={3} width={w} height={16} style={{ fillOpacity: STEP_OPACITY[Math.max(1, stepOf(c))] }} onMouseMove={(e) => tip(e, c)} onClick={() => open(c, focus)} />;
          })}
        </svg>

        <svg width={width} height={H} role="img" aria-label={`${t('ipmap.title')} — ${focus.label}`} style={{ marginTop: 6 }}>
          {!cells.length && (
            <g className="ipmap-cell hit">
              <svg x={0} y={0} width={width} height={H}>
                <rect className="box" x={1} y={1} width={width - 2} height={H - 2} rx={4} style={{ fillOpacity: STEP_OPACITY[stepOf(focus)] }} />
                <text x={12} y={24} className="ipmap-label">{focus.label}</text>
                <text x={12} y={42} className="ipmap-sub">{rangeOf(focus)} · {pctText(focus.utilisation)}</text>
                {focus.kind === 'block' && <text x={12} y={60} className="ipmap-sub">{t('ipmap.unallocated')}</text>}
              </svg>
            </g>
          )}
          {cells.map((c, i) => {
            const b = boxes[i];
            const nested = c.children.length > 0 && b.w > 150 && b.h > 96;
            const inner = nested ? c.children.slice(0, MAX_NESTED) : [];
            const ib = nested ? squarify(inner.map(weight), 6, 40, b.w - 12, b.h - 46) : [];
            return (
              <g key={c.id} className={`ipmap-cell ${hit.has(c.id) ? 'hit' : ''}`} data-ipmap-node={c.id} onClick={() => open(c, focus)} onMouseMove={(e) => tip(e, c)}>
                <svg x={b.x} y={b.y} width={b.w} height={b.h}>
                  <rect className={nested ? 'frame' : 'box'} x={1} y={1} width={Math.max(0, b.w - 2)} height={Math.max(0, b.h - 2)} rx={4} style={nested ? undefined : { fillOpacity: STEP_OPACITY[stepOf(c)] }} />
                  {b.w > 54 && b.h > 22 && <text x={7} y={16} className="ipmap-label">{c.label}</text>}
                  {b.w > 80 && b.h > 36 && <text x={7} y={30} className="ipmap-sub">{rangeOf(c)} · {pctText(c.utilisation)}</text>}
                  {inner.map((g, k) => {
                    const r = ib[k];
                    if (!r || r.w < 3 || r.h < 3) return null;
                    return (
                      <g key={g.id} className={`ipmap-cell ${hit.has(g.id) ? 'hit' : ''}`} data-ipmap-node={g.id} onClick={(e) => { e.stopPropagation(); open(g, c); }} onMouseMove={(e) => tip(e, g)}>
                        <svg x={r.x} y={r.y} width={r.w} height={r.h}>
                          <rect className="box" x={0.5} y={0.5} width={Math.max(0, r.w - 1)} height={Math.max(0, r.h - 1)} rx={2} style={{ fillOpacity: STEP_OPACITY[stepOf(g)] }} />
                          {r.w > 64 && r.h > 18 && <text x={5} y={13} className="ipmap-sub" style={{ fill: 'var(--text-primary)' }}>{g.label}</text>}
                          {r.w > 90 && r.h > 32 && <text x={5} y={26} className="ipmap-sub">{rangeOf(g)}</text>}
                        </svg>
                      </g>
                    );
                  })}
                  {nested && c.children.length > MAX_NESTED && <text x={b.w - 8} y={16} textAnchor="end" className="ipmap-sub">{t('ipmap.more', { n: c.children.length - MAX_NESTED })}</text>}
                </svg>
              </g>
            );
          })}
        </svg>
        {focus.children.length > MAX_CELLS && (
          <div className="caption" data-ipmap-window={offset}>
            {offset > 0 ? t('ipmap.window', { from: offset + 1, to: offset + cells.length, n: focus.children.length }) : t('ipmap.more', { n: focus.children.length - MAX_CELLS })}
          </div>
        )}

        {hover && (
          <div className="ipmap-tip" style={{ left: hover.x, top: hover.y }}>
            <div className="secondary">{t(`ipmap.kind.${hover.node.kind}`)}</div>
            <div><strong>{hover.node.label}</strong></div>
            <div className="mono">{rangeOf(hover.node)}</div>
            <div>{t('ipmap.used', { used: hover.node.used.toLocaleString(), size: hover.node.size.toLocaleString() })} · {pctText(hover.node.utilisation)}</div>
            {hover.node.purpose && <div className="hint" style={{ margin: 0 }}>{hover.node.purpose}</div>}
            {hover.node.children.length > 0 && <div className="hint" style={{ margin: 0 }}>{t('ipmap.children', { n: hover.node.children.length })}</div>}
          </div>
        )}
      </div>

      <div className="ipmap-legend">
        <span>{t('ipmap.legend')}</span>
        {STEP_LABELS.map((l, i) => <span key={l}><i style={{ opacity: STEP_OPACITY[i] }} />{l}</span>)}
        <span className="grow" />
        <span>{t('ipmap.legendArea')}</span>
      </div>
      {map.outside.length > 0 && <p className="hint">{t('ipmap.outside', { n: map.outside.length })}</p>}

      <div className="card" style={{ marginTop: 6 }} data-ipmap-detail>
        <div className="row wrap" style={{ gap: 8 }}>
          <span className="badge">{t(`ipmap.kind.${detail.kind}`)}</span>
          <strong>{detail.label}</strong>
          <span className="mono secondary">{rangeOf(detail)}</span>
          <span className="grow" />
          <span className="secondary">{t('ipmap.used', { used: detail.used.toLocaleString(), size: detail.size.toLocaleString() })} · {pctText(detail.utilisation)}</span>
        </div>
        {detail.purpose && <div className="hint">{detail.purpose}</div>}
        {detail.members && detail.members.length > 0 && (
          <div className="hint" style={{ wordBreak: 'break-all' }}>
            {t('ipmap.members')}: {activeMatch?.member && <mark>{activeMatch.member}</mark>}{activeMatch?.member ? ' · ' : ''}
            {detail.members.filter((m) => m !== activeMatch?.member).slice(0, 18).join(' · ')}{detail.members.length > 18 ? ' …' : ''}
          </div>
        )}
      </div>

      <details style={{ marginTop: 6 }}>
        <summary className="secondary" style={{ cursor: 'pointer', fontSize: 12.5 }}>{t('ipmap.table', { n: focus.children.length })}</summary>
        <div style={{ overflowX: 'auto' }}>
          <table className="diff-table">
            <thead><tr><th>{t('ipmap.col.name')}</th><th>{t('ipmap.col.range')}</th><th>{t('ipmap.col.used')}</th><th>{t('ipmap.col.size')}</th><th>{t('ipmap.col.util')}</th></tr></thead>
            <tbody>
              {focus.children.map((c) => (
                <tr key={c.id}><td>{c.label}</td><td className="mono">{rangeOf(c)}</td><td>{c.used.toLocaleString()}</td><td>{c.size.toLocaleString()}</td><td>{pctText(c.utilisation)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
