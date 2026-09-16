import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { findTerm } from '@aidc/core';
import { openHelpTerm } from './HelpDrawer.tsx';
import { useI18n } from '../i18n/index.ts';

/**
 * Glossary term with an accessible popover (S4, PROPOSAL-v2 §3.8; UI language by T8).
 *
 *   <Term id="oversubscription">{t('network.fabric.oversubscription')}</Term>
 *
 * Hover, keyboard focus or touch opens a small popover with the one-liner in the UI language (uiLocale) and the term in
 * the other language; "More" opens the help drawer at the term. Unknown ids render the children unchanged.
 */
export function Term({ id, children, className }: { id: string; children?: ReactNode; className?: string }) {
  const term = findTerm(id);
  const { locale } = useI18n();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const popId = useId();

  const show = () => {
    clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const hide = (delay = 120) => {
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), delay);
  };
  useEffect(() => () => clearTimeout(closeTimer.current), []);

  if (!term) return <span className={className} data-term-missing={id}>{children ?? id}</span>;
  const label = children ?? term.term[locale];
  return (
    <>
      <span
        ref={anchor}
        className={`term ${className ?? ''}`}
        tabIndex={0}
        role="button"
        aria-describedby={open ? popId : undefined}
        aria-expanded={open}
        data-term={id}
        onMouseEnter={show}
        onMouseLeave={() => hide()}
        onFocus={show}
        onBlur={() => hide()}
        onPointerDown={(e) => {
          if (e.pointerType === 'touch') {
            e.preventDefault();
            if (open) setOpen(false);
            else show();
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openHelpTerm(id);
          }
        }}
      >
        {label}
      </span>
      {open && anchor.current && (
        <TermPopover id={popId} termId={id} anchor={anchor.current} onEnter={show} onLeave={() => hide()} onMore={() => { setOpen(false); openHelpTerm(id); }} />
      )}
    </>
  );
}

function TermPopover({ id, termId, anchor, onEnter, onLeave, onMore }: { id: string; termId: string; anchor: HTMLElement; onEnter: () => void; onLeave: () => void; onMore: () => void }) {
  const term = findTerm(termId)!;
  const { t, locale } = useI18n();
  const other = locale === 'ko' ? 'en' : 'ko';
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; below: boolean }>({ left: 0, top: 0, below: true });

  useLayoutEffect(() => {
    const place = () => {
      const a = anchor.getBoundingClientRect();
      const el = ref.current;
      const w = el?.offsetWidth ?? 300;
      const h = el?.offsetHeight ?? 120;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let left = a.left;
      if (left + w + 8 > vw) left = Math.max(8, vw - w - 8);
      let top = a.bottom + 6;
      let below = true;
      if (top + h + 8 > vh && a.top - h - 6 > 8) {
        top = a.top - h - 6;
        below = false;
      }
      top = Math.max(8, Math.min(top, vh - h - 8));
      setPos({ left, top, below });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchor]);

  return createPortal(
    <div
      ref={ref}
      id={id}
      role="tooltip"
      className={`term-pop ${pos.below ? 'below' : 'above'}`}
      style={{ left: pos.left, top: pos.top }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <div className="term-pop-head">
        <span className="term-pop-ko">{term.term[locale]}</span>
        <span className="term-pop-en">{term.term[other]}</span>
      </div>
      <div className="term-pop-body">{term.short[locale]}</div>
      <div className="term-pop-foot">
        {term.domain && <span className="badge">{t(`shell.domain.${term.domain}`)}</span>}
        <span className="grow" />
        <button type="button" className="btn ghost sm" onMouseDown={(e) => e.preventDefault()} onClick={onMore}>{t('shell.help.more')}</button>
      </div>
    </div>,
    document.body,
  );
}

