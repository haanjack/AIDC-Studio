// r4 stream D — stacked-mode picker (panel < 640 px): search · series / hall / DU / face filters, then ◀ sheet select ▶.
import { useMemo } from 'react';
import type { DrawingSheetMeta } from '@aidc/core';
import { useT } from '../../i18n/index.ts';
import { SERIES_ORDER, duOf, faceOf, hallOf, seriesOf, type SheetFilters } from './model.ts';

export interface SheetPickerProps {
  all: readonly DrawingSheetMeta[];
  filtered: readonly DrawingSheetMeta[];
  filters: SheetFilters;
  onFilters(patch: Partial<SheetFilters>): void;
  selectedId: string | null;
  onSelect(id: string): void;
  onStep(delta: number): void;
  hallName(id: string): string;
  searchRef?: React.RefObject<HTMLInputElement | null>;
}

export function SheetPicker({ all, filtered, filters, onFilters, selectedId, onSelect, onStep, hallName, searchRef }: SheetPickerProps) {
  const t = useT();
  const seriesOpts = useMemo(() => SERIES_ORDER.filter((s) => all.some((m) => seriesOf(m) === s)), [all]);
  const hallOpts = useMemo(() => [...new Set(all.map(hallOf).filter((h): h is string => !!h))], [all]);
  const duOpts = useMemo(() => [...new Set(all.filter((m) => filters.hall === 'all' || hallOf(m) === filters.hall).map(duOf).filter((d): d is string => !!d))], [all, filters.hall]);
  const hasFaces = useMemo(() => all.some((m) => faceOf(m)), [all]);
  const idx = filtered.findIndex((m) => m.id === selectedId);
  return (
    <div className="dwg-picker">
      <div className="dwg-filter-row">
        <input ref={searchRef} type="text" className="dwg-search" data-drawings-search placeholder={t('drawings.search.placeholder')} aria-label={t('drawings.search.aria')} value={filters.q} onChange={(e) => onFilters({ q: e.target.value })}
          onKeyDown={(e) => { if (e.code === 'Escape') { e.preventDefault(); e.stopPropagation(); if (filters.q) onFilters({ q: '' }); else (e.target as HTMLInputElement).blur(); } }} />
        <select className="input sm" aria-label={t('drawings.filter.series')} value={filters.series} onChange={(e) => onFilters({ series: e.target.value as SheetFilters['series'] })}>
          <option value="all">{t('drawings.filter.series')}: {t('drawings.filter.all')}</option>
          {seriesOpts.map((s) => <option key={s} value={s}>{t(`drawings.series.${s}`)}</option>)}
        </select>
        {hallOpts.length > 1 && (
          <select className="input sm" aria-label={t('drawings.filter.hall')} value={filters.hall} onChange={(e) => onFilters({ hall: e.target.value, du: 'all' })}>
            <option value="all">{t('drawings.filter.hall')}: {t('drawings.filter.all')}</option>
            {hallOpts.map((h) => <option key={h} value={h}>{hallName(h)}</option>)}
          </select>
        )}
        {duOpts.length > 0 && (
          <select className="input sm" data-du-filter aria-label={t('drawings.filter.du')} value={filters.du} onChange={(e) => onFilters({ du: e.target.value })}>
            <option value="all">{t('drawings.filter.du')}: {t('drawings.filter.all')}</option>
            {duOpts.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        )}
        {hasFaces && (
          <div className="seg dwg-face" role="radiogroup" aria-label={t('drawings.filter.face')}>
            {(['F', 'R', 'both'] as const).map((f) => (
              <button key={f} role="radio" aria-checked={filters.face === f} className={filters.face === f ? 'on' : ''} onClick={() => onFilters({ face: f })}>{f === 'both' ? t('drawings.filter.faceBoth') : f}</button>
            ))}
          </div>
        )}
      </div>
      <div className="dwg-filter-row dwg-picker-nav">
        <button className="btn sm" onClick={() => onStep(-1)} disabled={!filtered.length} title={t('drawings.nav.prev')} aria-label={t('drawings.nav.prev')}>◀</button>
        <select className="input sm dwg-picker-select" aria-label={t('drawings.list.aria')} value={selectedId ?? ''} onChange={(e) => onSelect(e.target.value)}>
          {idx < 0 && <option value="">—</option>}
          {filtered.map((m) => <option key={m.id} value={m.id}>{m.number} · {m.title}</option>)}
        </select>
        <button className="btn sm" onClick={() => onStep(1)} disabled={!filtered.length} title={t('drawings.nav.next')} aria-label={t('drawings.nav.next')}>▶</button>
        <span className="mono secondary dwg-pos">{idx >= 0 ? idx + 1 : '—'} / {filtered.length}</span>
      </div>
    </div>
  );
}
