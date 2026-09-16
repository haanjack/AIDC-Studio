// r4 stream D — grouped, virtualised sheet list (series → hall → DU; F · R pills; search with '/' focus; tree keyboard).
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import type { DrawingSheetMeta } from '@aidc/core';
import { useT } from '../../i18n/index.ts';
import { Icon } from '../../ui/icons.tsx';
import {
  ROW_H, SERIES_ORDER, buildTree, defaultOpen, duOf, faceOf, flattenTree, hallOf, paperBadge, pathTo, seriesOf,
  type ListRow, type SeriesId, type SheetFilters,
} from './model.ts';

export interface SheetListProps {
  /** every listed sheet (filter options) */
  all: readonly DrawingSheetMeta[];
  /** sheets after the filters, in list order */
  filtered: readonly DrawingSheetMeta[];
  filters: SheetFilters;
  onFilters(patch: Partial<SheetFilters>): void;
  selectedId: string | null;
  onSelect(id: string): void;
  /** node key → open (user toggles; missing = default) */
  expanded: Record<string, boolean>;
  onToggle(key: string, open: boolean): void;
  hallName(id: string): string;
  kindLabel(m: DrawingSheetMeta): string;
  searchRef?: RefObject<HTMLInputElement | null>;
  /** Escape in the search box or the tree with nothing to cancel */
  onEscape?(): void;
  /** focus the tree on mount (flyout) */
  autoFocus?: boolean;
}

export function SheetList({ all, filtered, filters, onFilters, selectedId, onSelect, expanded, onToggle, hallName, kindLabel, searchRef, onEscape, autoFocus }: SheetListProps) {
  const t = useT();
  const { nodes } = useMemo(() => buildTree(filtered, filters.face), [filtered, filters.face]);
  const selectedPath = useMemo(() => (selectedId ? new Set(pathTo(nodes, selectedId)) : new Set<string>()), [nodes, selectedId]);
  const searching = filters.q.trim().length > 0;
  const rows = useMemo(
    () => flattenTree(nodes, (key, level, count) => (searching ? true : expanded[key] ?? (selectedPath.has(key) || defaultOpen(level, count)))),
    [nodes, expanded, selectedPath, searching],
  );

  // filter options from the whole list
  const seriesOpts = useMemo(() => SERIES_ORDER.filter((s) => all.some((m) => seriesOf(m) === s)), [all]);
  const hallOpts = useMemo(() => [...new Set(all.map(hallOf).filter((h): h is string => !!h))], [all]);
  const duOpts = useMemo(() => [...new Set(all.filter((m) => filters.hall === 'all' || hallOf(m) === filters.hall).map(duOf).filter((d): d is string => !!d))], [all, filters.hall]);
  const hasFaces = useMemo(() => all.some((m) => faceOf(m)), [all]);

  // virtual window
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(400);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    setViewH(el.clientHeight);
    return () => ro.disconnect();
  }, []);
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - 6);
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewH) / ROW_H) + 6);

  // keyboard focus row (tree)
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const focusIndex = Math.max(0, rows.findIndex((r) => r.key === focusKey));
  const selectedRowIndex = rows.findIndex((r) => r.type === 'sheet' && selectedId !== null && r.ids.includes(selectedId));
  const scrollToIndex = (i: number) => {
    const el = scroller.current;
    if (!el || i < 0) return;
    const top = i * ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
  };
  // keep the selected sheet in view when it changes from outside ([ / ] keys, rail, picker)
  useEffect(() => {
    if (selectedRowIndex >= 0) scrollToIndex(selectedRowIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, rows.length]);
  const tree = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (autoFocus) tree.current?.focus();
  }, [autoFocus]);

  const onTreeKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const cur = rows[focusKey ? focusIndex : Math.max(0, selectedRowIndex)];
    let next: number | null = null;
    const i = cur ? rows.indexOf(cur) : 0;
    switch (e.code) {
      case 'ArrowDown': next = Math.min(rows.length - 1, i + 1); break;
      case 'ArrowUp': next = Math.max(0, i - 1); break;
      case 'Home': next = 0; break;
      case 'End': next = rows.length - 1; break;
      case 'ArrowRight':
        if (cur?.type === 'group') {
          if (!cur.expanded) onToggle(cur.key, true);
          else next = Math.min(rows.length - 1, i + 1);
        }
        break;
      case 'ArrowLeft':
        if (cur?.type === 'group' && cur.expanded) onToggle(cur.key, false);
        else if (cur) {
          for (let j = i - 1; j >= 0; j--) if (rows[j].type === 'group' && rows[j].depth < cur.depth) { next = j; break; }
        }
        break;
      case 'Enter':
      case 'Space':
        if (cur?.type === 'group') onToggle(cur.key, !cur.expanded);
        else if (cur) onSelect(cur.primary.id);
        break;
      case 'Escape':
        onEscape?.();
        break;
      default:
        return;
    }
    // handled: never reaches the fly-mode camera or the drawings / global handlers
    e.preventDefault();
    e.stopPropagation();
    if (next !== null && rows[next]) {
      setFocusKey(rows[next].key);
      scrollToIndex(next);
    }
  };

  const groupLabel = (r: Extract<ListRow, { type: 'group' }>) =>
    r.level === 'series' ? t(`drawings.series.${r.value as SeriesId}`) : r.level === 'hall' ? hallName(r.value) : r.value;
  const activeRow = rows[focusKey ? focusIndex : Math.max(0, selectedRowIndex)];

  return (
    <div className="dwg-list-inner">
      <div className="dwg-filters">
        <input
          ref={searchRef}
          type="text"
          className="dwg-search"
          data-drawings-search
          placeholder={t('drawings.search.placeholder')}
          aria-label={t('drawings.search.aria')}
          value={filters.q}
          onChange={(e) => onFilters({ q: e.target.value })}
          onKeyDown={(e) => {
            if (e.code === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              if (filters.q) onFilters({ q: '' });
              else {
                (e.target as HTMLInputElement).blur();
                onEscape?.();
              }
            } else if (e.code === 'ArrowDown' || e.code === 'Enter') {
              e.preventDefault();
              tree.current?.focus();
              if (e.code === 'Enter' && filtered[0]) onSelect(filtered[0].id);
            }
          }}
        />
        <div className="dwg-filter-row">
          <select className="input sm" aria-label={t('drawings.filter.series')} title={t('drawings.filter.series')} value={filters.series} onChange={(e) => onFilters({ series: e.target.value as SheetFilters['series'] })}>
            <option value="all">{t('drawings.filter.series')}: {t('drawings.filter.all')}</option>
            {seriesOpts.map((s) => <option key={s} value={s}>{t(`drawings.series.${s}`)}</option>)}
          </select>
          {hallOpts.length > 1 && (
            <select className="input sm" aria-label={t('drawings.filter.hall')} title={t('drawings.filter.hall')} value={filters.hall} onChange={(e) => onFilters({ hall: e.target.value, du: 'all' })}>
              <option value="all">{t('drawings.filter.hall')}: {t('drawings.filter.all')}</option>
              {hallOpts.map((h) => <option key={h} value={h}>{hallName(h)}</option>)}
            </select>
          )}
          {duOpts.length > 0 && (
            <select className="input sm" data-du-filter aria-label={t('drawings.filter.du')} title={t('drawings.filter.du')} value={filters.du} onChange={(e) => onFilters({ du: e.target.value })}>
              <option value="all">{t('drawings.filter.du')}: {t('drawings.filter.all')}</option>
              {duOpts.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          )}
          {hasFaces && (
            <div className="seg dwg-face" role="radiogroup" aria-label={t('drawings.filter.face')} title={t('drawings.filter.faceTitle')}>
              {(['F', 'R', 'both'] as const).map((f) => (
                <button key={f} role="radio" aria-checked={filters.face === f} className={filters.face === f ? 'on' : ''} onClick={() => onFilters({ face: f })}>
                  {f === 'both' ? t('drawings.filter.faceBoth') : f}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="dwg-count hint">{t('drawings.list.count', { n: filtered.length, total: all.length })}</div>
      </div>
      <div
        ref={(el) => {
          scroller.current = el;
          tree.current = el;
        }}
        className="dwg-tree"
        role="tree"
        tabIndex={0}
        aria-label={t('drawings.list.aria')}
        aria-activedescendant={activeRow ? `dwg-row-${cssId(activeRow.key)}` : undefined}
        onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
        onKeyDown={onTreeKey}
      >
        {!rows.length && <div className="dwg-empty-row hint">{t('drawings.list.noMatch')}</div>}
        <div style={{ height: rows.length * ROW_H, position: 'relative' }}>
          {rows.slice(first, last).map((r, k) => {
            const i = first + k;
            const focused = activeRow?.key === r.key && focusKey !== null;
            const style = { top: i * ROW_H, height: ROW_H, paddingLeft: 6 + r.depth * 14 };
            if (r.type === 'group') {
              return (
                <div
                  key={r.key}
                  id={`dwg-row-${cssId(r.key)}`}
                  role="treeitem"
                  aria-expanded={r.expanded}
                  aria-level={r.depth + 1}
                  className={`dwg-row group lvl-${r.level}${focused ? ' focus' : ''}`}
                  style={style}
                  onClick={() => {
                    setFocusKey(r.key);
                    onToggle(r.key, !r.expanded);
                  }}
                >
                  <Icon name="chevron" size={12} className="dwg-caret" data-open={r.expanded ? '' : undefined} />
                  <span className="lbl">{groupLabel(r)}</span>
                  <span className="cnt">({r.count})</span>
                </div>
              );
            }
            const m = r.primary;
            const selected = selectedId !== null && r.ids.includes(selectedId);
            return (
              <div
                key={r.key}
                id={`dwg-row-${cssId(r.key)}`}
                role="treeitem"
                aria-selected={selected}
                aria-level={r.depth + 1}
                data-sheet-id={m.id}
                className={`dwg-row sheet${selected ? ' sel' : ''}${focused ? ' focus' : ''}`}
                style={style}
                title={`${m.number} · ${m.title}\n${kindLabel(m)} · ${m.scale} · ${paperBadge(m.paper)}`}
                onClick={() => {
                  setFocusKey(r.key);
                  onSelect(selected ? selectedId! : m.id);
                }}
              >
                <span className="num mono">{r.faces ? m.number.replace(/-[FR]$/, '') : m.number}</span>
                <span className="ttl">{m.title}</span>
                {r.faces && (
                  <span className="faces">
                    {(['F', 'R'] as const).map((f) => {
                      const fm = r.faces![f];
                      if (!fm) return null;
                      return (
                        <button
                          key={f}
                          className={`face-pill${selectedId === fm.id ? ' on' : ''}`}
                          title={t(f === 'F' ? 'drawings.face.front' : 'drawings.face.rear')}
                          onClick={(e) => {
                            e.stopPropagation();
                            setFocusKey(r.key);
                            onSelect(fm.id);
                          }}
                        >
                          {f}
                        </button>
                      );
                    })}
                  </span>
                )}
                <span className="scl mono">{m.scale}</span>
                <span className="paper">{paperBadge(m.paper)}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const cssId = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_');
