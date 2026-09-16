// r4 stream D — 56 px number rail (640–959 px panel, or a collapsed list in two columns); ☰ opens the full list as a flyout.
import { useEffect, useRef, type ReactNode } from 'react';
import type { DrawingSheetMeta } from '@aidc/core';
import { useT } from '../../i18n/index.ts';
import { seriesOf } from './model.ts';

/** compact rail label: '2-DU01-A-F' → 'DU01A·F', '301-H1-T02' → '301·T02', '101' → '101' */
export function railLabel(number: string): string {
  const p = number.split('-');
  if (p[0] === '2' && p.length >= 3) {
    const face = /^[FR]$/.test(p[p.length - 1]) ? p.pop() : undefined;
    const rest = p.slice(1).filter((x) => !/^H\d+$/.test(x));
    return `${rest.join('').slice(0, 6)}${face ? `·${face}` : ''}`;
  }
  if (p.length === 1) return p[0].slice(0, 7);
  return `${p[0]}·${p[p.length - 1]}`.slice(0, 8);
}

export interface SheetRailProps {
  filtered: readonly DrawingSheetMeta[];
  selectedId: string | null;
  onSelect(id: string): void;
  flyoutOpen: boolean;
  onFlyout(open: boolean): void;
  /** the SheetList rendered inside the flyout */
  flyout: ReactNode;
  /** two-col with a collapsed list: button to expand the list again */
  onExpandList?(): void;
}

export function SheetRail({ filtered, selectedId, onSelect, flyoutOpen, onFlyout, flyout, onExpandList }: SheetRailProps) {
  const t = useT();
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = strip.current?.querySelector<HTMLElement>('[data-sel]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);
  let prevSeries = '';
  return (
    <div className="dwg-rail" data-flyout={flyoutOpen ? '' : undefined}>
      <button className={`btn ghost sm dwg-rail-menu${flyoutOpen ? ' active' : ''}`} title={t('drawings.rail.open')} aria-label={t('drawings.rail.open')} aria-expanded={flyoutOpen} onClick={() => onFlyout(!flyoutOpen)}>☰</button>
      {onExpandList && <button className="btn ghost sm dwg-rail-menu" title={t('drawings.list.expand')} aria-label={t('drawings.list.expand')} onClick={onExpandList}>⇥</button>}
      <div ref={strip} className="dwg-rail-strip">
        {filtered.map((m) => {
          const s = seriesOf(m);
          const mark = s !== prevSeries;
          prevSeries = s;
          const sel = m.id === selectedId;
          return (
            <button key={m.id} className={`dwg-rail-item${sel ? ' sel' : ''}${mark ? ' mark' : ''}`} data-sel={sel ? '' : undefined} title={`${m.number} · ${m.title}`} onClick={() => onSelect(m.id)}>
              {railLabel(m.number)}
            </button>
          );
        })}
      </div>
      {flyoutOpen && (
        <>
          <div className="dwg-flyout-scrim" onClick={() => onFlyout(false)} />
          <div className="dwg-flyout" role="dialog" aria-label={t('drawings.list.aria')}>{flyout}</div>
        </>
      )}
    </div>
  );
}
