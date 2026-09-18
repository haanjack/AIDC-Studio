import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Issue, Severity, SpecSource } from '@aidc/core';
import { Icon } from './icons.tsx';
import { useIssueText, useT } from '../i18n/index.ts';
import { isCoolingPlacementIssue, openCoolingPlacement } from '../app/coolingNav.ts';

export function Section({ title, actions, children }: { title: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="section">
      <div className="section-title">
        <span>{title}</span>
        <span className="line" />
        {actions}
      </div>
      {children}
    </div>
  );
}

/** `hint`: a string becomes the tooltip (title); any other node is rendered as a visible hint line under the control. */
export function Field({ label, children, hint }: { label: ReactNode; children: ReactNode; hint?: ReactNode }) {
  const tip = typeof hint === 'string' ? hint : undefined;
  return (
    <div className="field" title={tip}>
      <label>{label}</label>
      <div>{children}</div>
      {hint !== undefined && tip === undefined && hint !== null && <div className="hint" style={{ marginTop: 3 }}>{hint}</div>}
    </div>
  );
}

/** Commits on blur / Enter so typing doesn't flood undo history and re-analysis. */
export function NumberField({
  label, value, onChange, step = 1, min, max, unit, digits, hint, disabled,
}: {
  label: ReactNode; value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number; unit?: string; digits?: number; hint?: ReactNode; disabled?: boolean;
}) {
  const shown = digits != null ? Number(value.toFixed(digits)) : value;
  const [text, setText] = useState(String(shown));
  useEffect(() => setText(String(shown)), [shown]);
  const commit = () => {
    let v = Number(text);
    if (!Number.isFinite(v)) return setText(String(shown));
    if (min != null) v = Math.max(min, v);
    if (max != null) v = Math.min(max, v);
    if (v !== value) onChange(v);
    else setText(String(shown));
  };
  return (
    <Field label={label} hint={hint}>
      <div className="with-unit">
        <input
          type="number" value={text} step={step} min={min} max={max} disabled={disabled}
          onChange={(e) => setText(e.target.value)} onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        />
        {unit && <span className="unit">{unit}</span>}
      </div>
    </Field>
  );
}

export function TextField({ label, value, onChange, hint, type = 'text' }: { label: ReactNode; value: string; onChange: (v: string) => void; hint?: ReactNode; type?: 'text' | 'date' }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <Field label={label} hint={hint}>
      <input
        type={type} value={text} onChange={(e) => { setText(e.target.value); if (type === 'date') onChange(e.target.value); }}
        onBlur={() => text !== value && onChange(text)} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      />
    </Field>
  );
}

export interface Option<T extends string | number> { value: T; label: string }

export function SelectField<T extends string | number>({ label, value, options, onChange, hint }: { label: ReactNode; value: T; options: Option<T>[]; onChange: (v: T) => void; hint?: ReactNode }) {
  return (
    <Field label={label} hint={hint}>
      <Select value={value} options={options} onChange={onChange} />
    </Field>
  );
}

export function Select<T extends string | number>({ value, options, onChange }: { value: T; options: Option<T>[]; onChange: (v: T) => void }) {
  return (
    <select
      value={String(value)}
      onChange={(e) => {
        const o = options.find((x) => String(x.value) === e.target.value);
        if (o) onChange(o.value);
      }}
    >
      {options.map((o) => (
        <option key={String(o.value)} value={String(o.value)}>{o.label}</option>
      ))}
    </select>
  );
}

export function Toggle({ label, checked, onChange }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export function Seg<T extends string | number>({ value, options, onChange, wrap }: { value: T; options: Option<T>[]; onChange: (v: T) => void; /** tab strips: buttons wrap onto more lines instead of clipping */ wrap?: boolean }) {
  return (
    <div className={wrap ? 'seg seg-wrap' : 'seg'} role="radiogroup">
      {options.map((o) => (
        <button key={String(o.value)} role="radio" aria-checked={o.value === value} className={o.value === value ? 'on' : ''} data-ro-allow={wrap ? '' : undefined} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Stat({ label, value, delta, title }: { label: ReactNode; value: ReactNode; delta?: ReactNode; title?: string }) {
  return (
    <div className="stat" title={title}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {delta != null && <div className="delta">{delta}</div>}
    </div>
  );
}

/** Ratio meter: severity from utilization (≤85% accent, ≤100% warning, >100% critical). */
export function Meter({ ratio, label }: { ratio: number; label?: string }) {
  const r = Number.isFinite(ratio) ? ratio : 0;
  const cls = r > 1 ? 'bad' : r > 0.85 ? 'warn' : '';
  return (
    <div title={label}>
      <div className={`meter ${cls}`}>
        <div style={{ width: `${Math.min(100, Math.max(0, r * 100))}%` }} />
      </div>
    </div>
  );
}

export function StatusIcon({ severity }: { severity: Severity | 'good' }) {
  const name = severity === 'error' ? 'error' : severity === 'warning' ? 'warning' : severity === 'good' ? 'check' : 'info';
  return <Icon name={name} />;
}

export function StatusLabel({ severity, children }: { severity: Severity | 'good'; children: ReactNode }) {
  return (
    <span className={`status ${severity}`}>
      <StatusIcon severity={severity} />
      {children}
    </span>
  );
}

const DOMAIN_KEY: Record<Issue['domain'], string> = {
  space: 'ui.domain.space', power: 'ui.domain.power', cooling: 'ui.domain.cooling', network: 'ui.domain.network', thermal: 'ui.domain.thermal',
  schedule: 'ui.domain.schedule', cost: 'ui.domain.cost', workload: 'ui.domain.workload', layout: 'ui.domain.layout',
};

export function IssueList({ issues, onRefs, limit }: { issues: Issue[]; onRefs?: (ids: string[]) => void; limit?: number }) {
  const tr = useT();
  const order: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  const { msg, sug } = useIssueText();
  const sorted = useMemo(() => [...issues].sort((a, b) => order[a.severity] - order[b.severity]), [issues]);
  const shown = limit ? sorted.slice(0, limit) : sorted;
  if (!issues.length)
    return (
      <div className="row" style={{ padding: '6px 0' }}>
        <StatusLabel severity="good">{tr('ui.issue.none')}</StatusLabel>
      </div>
    );
  return (
    <div>
      {shown.map((i) => (
        <div key={i.id} className={`issue ${i.severity}`}>
          <StatusIcon severity={i.severity} />
          <div>
            <div className="dom">{DOMAIN_KEY[i.domain] ? tr(DOMAIN_KEY[i.domain]) : i.domain} · {tr(i.severity === 'error' ? 'ui.severity.error' : i.severity === 'warning' ? 'ui.severity.warning' : 'ui.severity.info')}</div>
            <div className="msg">{msg(i)}</div>
            {sug(i) && <div className="sug">→ {sug(i)}</div>}
            {((onRefs && i.refs && i.refs.length > 0) || isCoolingPlacementIssue(i)) && (
              <div className="row wrap" style={{ gap: 10, marginTop: 4 }}>
                {onRefs && i.refs && i.refs.length > 0 && (
                  <button className="btn ghost sm" style={{ paddingLeft: 0 }} onClick={() => onRefs(i.refs!)}>
                    {tr('ui.issue.selectRefs', { n: i.refs.length })}
                  </button>
                )}
                {/* T4 (F8): "install more CDUs / CRAHs" warnings link to the cooling-equipment placement controls */}
                {isCoolingPlacementIssue(i) && (
                  <button className="btn ghost sm" style={{ paddingLeft: 0 }} onClick={openCoolingPlacement} data-cooling-goto>
                    {tr('cooling.place.goto')}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      ))}
      {limit && sorted.length > limit && <div className="hint">{tr('ui.issue.more', { n: sorted.length - limit })}</div>}
    </div>
  );
}

export function SourceBadge({ source }: { source: SpecSource }) {
  const tr = useT();
  return <span className={`badge src-${source}`}>{tr(`ui.source.${source}`)}</span>;
}

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  sortValue?: (row: T) => number | string;
  num?: boolean;
  width?: number | string;
}

export function DataTable<T>({
  columns, rows, rowKey, onRowClick, selectedKeys, footer, maxHeight, initialSort,
}: {
  columns: Column<T>[]; rows: T[]; rowKey: (r: T) => string; onRowClick?: (r: T, e: React.MouseEvent) => void; selectedKeys?: string[];
  footer?: ReactNode; maxHeight?: number | string; initialSort?: { key: string; dir: 1 | -1 };
}) {
  const [sort, setSort] = useState(initialSort ?? null);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return rows;
    const sv = col.sortValue;
    return [...rows].sort((a, b) => {
      const va = sv(a);
      const vb = sv(b);
      return (va < vb ? -1 : va > vb ? 1 : 0) * sort.dir;
    });
  }, [rows, sort, columns]);
  const selected = new Set(selectedKeys ?? []);
  return (
    <div className="table-wrap" style={{ maxHeight }}>
      <table className="data">
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key} className={c.num ? 'num' : ''} style={{ width: c.width, cursor: c.sortValue ? 'pointer' : undefined }}
                onClick={() => c.sortValue && setSort((s) => (s?.key === c.key ? { key: c.key, dir: (s.dir * -1) as 1 | -1 } : { key: c.key, dir: -1 }))}
              >
                {c.header}
                {sort?.key === c.key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const k = rowKey(r);
            return (
              <tr key={k} className={`${onRowClick ? 'clickable' : ''} ${selected.has(k) ? 'selected' : ''}`} onClick={(e) => onRowClick?.(r, e)}>
                {columns.map((c) => (
                  <td key={c.key} className={c.num ? 'num' : ''}>{c.render(r)}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
        {footer && <tfoot>{footer}</tfoot>}
      </table>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
