// Page-panel collapse (stream T5, DECISIONS-v2-2 F4): button in the panel head + Ctrl+Shift+L (macOS ⌘⇧L),
// state in useApp().panelCollapsed (persisted in localStorage). The nav rail stays visible; when collapsed the
// viewport takes the full width (App.tsx `.main.collapsed`) and a slim handle on the left edge re-opens the panel.
import { useEffect } from 'react';
import { useApp } from '../store/appStore.ts';
import { useT } from '../i18n/index.ts';
import { Icon } from './icons.tsx';

const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);
export const panelCollapseShortcut = () => (isMac() ? '⌘⇧L' : 'Ctrl+Shift+L');

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

/** Collapse button in the page-panel head. */
export function PanelCollapseButton() {
  const t = useT();
  const toggle = useApp((s) => s.togglePanelCollapsed);
  return (
    <button className="btn ghost sm" data-panel-collapse onClick={toggle} title={t('catalog.shell.collapseTooltip', { shortcut: panelCollapseShortcut() })} aria-label={t('catalog.shell.collapse')}>
      <svg viewBox="0 0 16 16" width={15} height={15} fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden>
        <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
        <line x1="6" y1="2.5" x2="6" y2="13.5" />
        <polyline points="4.2,6.5 2.8,8 4.2,9.5" />
      </svg>
    </button>
  );
}

/**
 * Always mounted inside `.main`: owns the global shortcut (so it keeps working while the panel head is hidden) and
 * renders the re-open handle when collapsed.
 */
export function PanelCollapseHandle() {
  const t = useT();
  const collapsed = useApp((s) => s.panelCollapsed);
  const setCollapsed = useApp((s) => s.setPanelCollapsed);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey || e.key.toLowerCase() !== 'l') return;
      if (isTyping(e.target)) return;
      e.preventDefault();
      useApp.getState().togglePanelCollapsed();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  if (!collapsed) return null;
  return (
    <button className="panel-handle" data-panel-expand onClick={() => setCollapsed(false)} title={t('catalog.shell.expandTooltip', { shortcut: panelCollapseShortcut() })} aria-label={t('catalog.shell.expand')}>
      <Icon name="chevron" size={12} />
    </button>
  );
}
