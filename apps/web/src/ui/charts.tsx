import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { DataTable } from './controls.tsx';
import { useT } from '../i18n/index.ts';

/**
 * Chart kit following the dataviz method: thin marks (≤24px bars, 4px rounded data-end,
 * square at baseline), 2px lines, 2px surface gaps, hairline recessive grid, legend for ≥2 series,
 * hover tooltips with value-first rows, and a table-view twin for every chart.
 */

export const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)', 'var(--series-6)', 'var(--series-7)', 'var(--series-8)'];

export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(600);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((entries) => setW(Math.max(120, Math.floor(entries[0].contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0];
  if (max === min) max = min + 1;
  const span = max - min;
  const step0 = span / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(step0));
  const norm = step0 / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const start = Math.floor(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + step * 0.5; v += step) ticks.push(Math.round(v / step) * step);
  return ticks;
}

interface TooltipState { x: number; y: number; title: string; rows: { color: string; name: string; value: string }[] }

function Tooltip({ t, width }: { t: TooltipState | null; width: number }) {
  if (!t) return null;
  const left = t.x > width - 190 ? t.x - 180 : t.x + 14;
  return (
    <div className="chart-tooltip" style={{ left, top: Math.max(0, t.y - 10) }}>
      <div className="t-title">{t.title}</div>
      {t.rows.map((r, i) => (
        <div className="t-row" key={i}>
          <span className="t-key" style={{ background: r.color }} />
          <span className="t-val">{r.value}</span>
          <span className="t-name">{r.name}</span>
        </div>
      ))}
    </div>
  );
}

function ChartFrame({ title, legend, children, table, actions }: { title?: ReactNode; legend?: ReactNode; children: ReactNode; table: ReactNode; actions?: ReactNode }) {
  const [showTable, setShowTable] = useState(false);
  const t = useT();
  return (
    <div className="chart">
      <div className="row">
        {title && <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>{title}</h3>}
        <span className="grow" />
        {actions}
        <button className="btn ghost sm" onClick={() => setShowTable((v) => !v)} aria-pressed={showTable}>{showTable ? t('ui.chart.showChart') : t('ui.chart.showTable')}</button>
      </div>
      {legend}
      {showTable ? table : children}
    </div>
  );
}

export interface SeriesDef { key: string; name: string; color?: string }

function Legend({ series, kind }: { series: SeriesDef[]; kind: 'rect' | 'line' }) {
  if (series.length < 2) return null;
  return (
    <div className="legend">
      {series.map((s, i) => (
        <span className="item" key={s.key}>
          <span className={kind === 'rect' ? 'sw' : 'ln'} style={{ background: s.color ?? SERIES[i % SERIES.length] }} />
          {s.name}
        </span>
      ))}
    </div>
  );
}

/** Rounded data-end rect path, square at the baseline (horizontal bars grow to the right). */
function hbarPath(x: number, y: number, w: number, h: number, roundEnd: boolean) {
  const r = roundEnd ? Math.min(4, w / 2, h / 2) : 0;
  if (w <= 0) return '';
  return `M${x},${y}H${x + w - r}${r ? `Q${x + w},${y} ${x + w},${y + r}` : ''}V${y + h - r}${r ? `Q${x + w},${y + h} ${x + w - r},${y + h}` : ''}H${x}Z`;
}

export interface BarDatum { label: string; values: Record<string, number>; id?: string }

/** Horizontal bar chart — single series or stacked (part-to-whole). */
export function BarChart({
  title, data, series, format = (v) => v.toLocaleString(), rowHeight = 30, labelWidth = 150, onBarClick, maxValue, actions,
}: {
  title?: ReactNode; data: BarDatum[]; series: SeriesDef[]; format?: (v: number) => string; rowHeight?: number; labelWidth?: number;
  onBarClick?: (d: BarDatum) => void; maxValue?: number; actions?: ReactNode;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<TooltipState | null>(null);
  const tr = useT();
  const valueBand = 76;
  const plotW = Math.max(40, width - labelWidth - valueBand);
  const totals = data.map((d) => series.reduce((s, k) => s + Math.max(0, d.values[k.key] ?? 0), 0));
  const max = maxValue ?? Math.max(1e-9, ...totals);
  const ticks = niceTicks(0, max, 4).filter((t) => t <= max * 1.001);
  const barH = Math.min(18, rowHeight - 10);
  const axisH = 18;
  const height = data.length * rowHeight + axisH;
  const colorOf = (i: number) => series[i].color ?? SERIES[i % SERIES.length];

  const table = (
    <DataTable
      columns={[
        { key: 'label', header: tr('ui.chart.col.item'), render: (d: BarDatum) => d.label },
        ...series.map((s) => ({ key: s.key, header: s.name, num: true, render: (d: BarDatum) => format(d.values[s.key] ?? 0) })),
        ...(series.length > 1 ? [{ key: '_t', header: tr('ui.chart.col.total'), num: true, render: (d: BarDatum) => format(series.reduce((a, s) => a + (d.values[s.key] ?? 0), 0)) }] : []),
      ]}
      rows={data}
      rowKey={(d) => d.id ?? d.label}
      maxHeight={320}
    />
  );

  return (
    <ChartFrame title={title} legend={<Legend series={series} kind="rect" />} table={table} actions={actions}>
      <div ref={ref} style={{ position: 'relative' }} onMouseLeave={() => setTip(null)}>
        <svg width={width} height={height} role="img">
          {ticks.map((t) => {
            const x = labelWidth + (t / max) * plotW;
            return (
              <g key={t}>
                <line className="gridline" x1={x} x2={x} y1={0} y2={data.length * rowHeight} />
                <text className="tick" x={x} y={height - 4} textAnchor="middle">{format(t)}</text>
              </g>
            );
          })}
          <line className="baseline" x1={labelWidth} x2={labelWidth} y1={0} y2={data.length * rowHeight} />
          {data.map((d, di) => {
            const y = di * rowHeight + (rowHeight - barH) / 2;
            let x = labelWidth;
            const segs = series.map((s, si) => ({ s, si, v: Math.max(0, d.values[s.key] ?? 0) })).filter((g) => g.v > 0);
            return (
              <g key={d.id ?? d.label} style={{ cursor: onBarClick ? 'pointer' : undefined }} onClick={() => onBarClick?.(d)}>
                <text className="label" x={labelWidth - 8} y={di * rowHeight + rowHeight / 2 + 4} textAnchor="end">
                  {d.label.length > 24 ? `${d.label.slice(0, 23)}…` : d.label}
                </text>
                {segs.map((g, gi) => {
                  const w = (g.v / max) * plotW;
                  const last = gi === segs.length - 1;
                  const drawW = Math.max(0, last ? w : w - 2); // 2px surface gap between stacked segments
                  const p = hbarPath(x, y, drawW, barH, last);
                  const x0 = x;
                  x += w;
                  return (
                    <path
                      key={g.s.key} d={p} style={{ fill: colorOf(g.si) }}
                      onMouseMove={(e) => {
                        const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                        setTip({
                          x: e.clientX - rect.left, y: e.clientY - rect.top, title: d.label,
                          rows: segs.map((q) => ({ color: colorOf(q.si), name: q.s.name, value: format(q.v) })),
                        });
                      }}
                      data-x0={x0}
                    />
                  );
                })}
                {/* transparent hit row larger than the mark */}
                <rect x={labelWidth} y={di * rowHeight} width={plotW} height={rowHeight} fill="transparent"
                  onMouseMove={(e) => {
                    const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                    setTip({ x: e.clientX - rect.left, y: e.clientY - rect.top, title: d.label, rows: segs.map((q) => ({ color: colorOf(q.si), name: q.s.name, value: format(q.v) })) });
                  }}
                />
                <text className="value-label" x={x + 6} y={di * rowHeight + rowHeight / 2 + 4}>{format(totals[di])}</text>
              </g>
            );
          })}
        </svg>
        <Tooltip t={tip} width={width} />
      </div>
    </ChartFrame>
  );
}

export interface LinePoint { x: number; y: number }
export interface LineSeries extends SeriesDef { points: LinePoint[] }

/** Multi-series line chart with crosshair snapping to the nearest X; optional area wash for a single series. */
export function LineChart({
  title, series, height = 200, xFormat = (v) => String(v), yFormat = (v) => v.toLocaleString(), yMin, yMax, area, refLines, actions, step,
}: {
  title?: ReactNode; series: LineSeries[]; height?: number; xFormat?: (v: number) => string; yFormat?: (v: number) => string;
  yMin?: number; yMax?: number; area?: boolean; refLines?: { y: number; label: string }[]; actions?: ReactNode; step?: boolean;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hoverX, setHoverX] = useState<number | null>(null);
  const pad = { l: 52, r: series.length <= 4 && series.length > 1 ? 70 : 14, t: 10, b: 22 };
  const plotW = Math.max(40, width - pad.l - pad.r);
  const plotH = height - pad.t - pad.b;
  const all = series.flatMap((s) => s.points);
  const xs = all.map((p) => p.x);
  const ys = all.map((p) => p.y);
  const xMin = xs.length ? Math.min(...xs) : 0;
  const xMax = xs.length ? Math.max(...xs) : 1;
  const yLo = yMin ?? Math.min(0, ...ys, ...(refLines?.map((r) => r.y) ?? []));
  const yHiRaw = yMax ?? Math.max(...ys, ...(refLines?.map((r) => r.y) ?? []), yLo + 1e-9);
  const yTicks = niceTicks(yLo, yHiRaw, 4);
  const yHi = Math.max(yHiRaw, yTicks[yTicks.length - 1]);
  const sx = (x: number) => pad.l + ((x - xMin) / Math.max(1e-9, xMax - xMin)) * plotW;
  const sy = (y: number) => pad.t + plotH - ((y - yLo) / Math.max(1e-9, yHi - yLo)) * plotH;
  const xTicks = niceTicks(xMin, xMax, Math.max(2, Math.floor(plotW / 90))).filter((t) => t >= xMin && t <= xMax);
  const colorOf = (i: number) => series[i].color ?? SERIES[i % SERIES.length];

  const paths = useMemo(
    () =>
      series.map((s) => {
        if (!s.points.length) return { line: '', area: '' };
        let d = '';
        s.points.forEach((p, i) => {
          if (i === 0) d += `M${sx(p.x)},${sy(p.y)}`;
          else if (step) d += `H${sx(p.x)}V${sy(p.y)}`;
          else d += `L${sx(p.x)},${sy(p.y)}`;
        });
        const a = `${d}L${sx(s.points[s.points.length - 1].x)},${sy(yLo)}L${sx(s.points[0].x)},${sy(yLo)}Z`;
        return { line: d, area: a };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [series, width, height, yLo, yHi, step],
  );

  const nearest = (s: LineSeries, x: number) => {
    let best: LinePoint | undefined;
    let bd = Infinity;
    for (const p of s.points) {
      const d = Math.abs(p.x - x);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  };
  const snapX = hoverX == null || !series[0]?.points.length ? null : nearest(series[0], hoverX)?.x ?? null;

  const table = (
    <DataTable
      columns={[
        { key: 'x', header: 'X', render: (r: { x: number }) => xFormat(r.x) },
        ...series.map((s) => ({ key: s.key, header: s.name, num: true, render: (r: { x: number; [k: string]: number }) => (r[s.key] != null ? yFormat(r[s.key]) : '–') })),
      ]}
      rows={(series[0]?.points ?? []).filter((_, i, arr) => arr.length <= 200 || i % Math.ceil(arr.length / 200) === 0).map((p) => {
        const row: { x: number; [k: string]: number } = { x: p.x };
        series.forEach((s) => { const q = nearest(s, p.x); if (q) row[s.key] = q.y; });
        return row;
      })}
      rowKey={(r) => String(r.x)}
      maxHeight={260}
    />
  );

  // direct end labels for 2..4 series when they don't collide
  const ends = series.map((s, i) => ({ i, p: s.points[s.points.length - 1] })).filter((e) => e.p);
  const endYs = ends.map((e) => sy(e.p.y)).sort((a, b) => a - b);
  const collide = endYs.some((y, i) => i > 0 && y - endYs[i - 1] < 13);

  return (
    <ChartFrame title={title} legend={<Legend series={series} kind="line" />} table={table} actions={actions}>
      <div ref={ref} style={{ position: 'relative' }}>
        <svg
          width={width} height={height}
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const px = e.clientX - rect.left;
            if (px < pad.l || px > pad.l + plotW) return setHoverX(null);
            setHoverX(xMin + ((px - pad.l) / plotW) * (xMax - xMin));
          }}
          onMouseLeave={() => setHoverX(null)}
        >
          {yTicks.map((t) => (
            <g key={t}>
              <line className="gridline" x1={pad.l} x2={pad.l + plotW} y1={sy(t)} y2={sy(t)} />
              <text className="tick" x={pad.l - 6} y={sy(t) + 4} textAnchor="end">{yFormat(t)}</text>
            </g>
          ))}
          {xTicks.map((t) => (
            <text key={t} className="tick" x={sx(t)} y={height - 5} textAnchor="middle">{xFormat(t)}</text>
          ))}
          <line className="baseline" x1={pad.l} x2={pad.l + plotW} y1={sy(yLo)} y2={sy(yLo)} />
          {refLines?.map((r) => (
            <g key={r.label}>
              <line x1={pad.l} x2={pad.l + plotW} y1={sy(r.y)} y2={sy(r.y)} style={{ stroke: 'var(--text-muted)', strokeWidth: 1 }} />
              <rect x={pad.l + 4} y={sy(r.y) - 15} width={r.label.length * 6.4 + 8} height={13} rx={3} style={{ fill: 'var(--surface-1)', opacity: 0.85 }} />
              <text className="tick" x={pad.l + 8} y={sy(r.y) - 5}>{r.label}</text>
            </g>
          ))}
          {series.map((s, i) => (
            <g key={s.key}>
              {area && series.length === 1 && <path d={paths[i].area} style={{ fill: colorOf(i), opacity: 0.1 }} />}
              <path d={paths[i].line} fill="none" style={{ stroke: colorOf(i), strokeWidth: 2, strokeLinejoin: 'round', strokeLinecap: 'round' }} />
            </g>
          ))}
          {series.length > 1 && series.length <= 4 && !collide &&
            ends.map((e) => (
              <text key={e.i} className="label" x={sx(e.p.x) + 6} y={sy(e.p.y) + 4}>{series[e.i].name.length > 10 ? `${series[e.i].name.slice(0, 9)}…` : series[e.i].name}</text>
            ))}
          {snapX != null && (
            <g>
              <line x1={sx(snapX)} x2={sx(snapX)} y1={pad.t} y2={pad.t + plotH} style={{ stroke: 'var(--axis)', strokeWidth: 1 }} />
              {series.map((s, i) => {
                const p = nearest(s, snapX);
                return p ? <circle key={s.key} cx={sx(p.x)} cy={sy(p.y)} r={4} style={{ fill: colorOf(i), stroke: 'var(--surface-1)', strokeWidth: 2 }} /> : null;
              })}
            </g>
          )}
        </svg>
        {snapX != null && (
          <Tooltip
            width={width}
            t={{
              x: sx(snapX), y: pad.t + 10, title: xFormat(snapX),
              rows: series.map((s, i) => ({ color: colorOf(i), name: s.name, value: (() => { const p = nearest(s, snapX); return p ? yFormat(p.y) : '–'; })() })),
            }}
          />
        )}
      </div>
    </ChartFrame>
  );
}
