// r4 stream C (spec §3.3): keyboard scopes. Scope comes from the closest `[data-keyscope]` ancestor of the event target
// ('drawings' | 'view2d' | 'view3d'); an inner handler that consumes a key calls preventDefault (and stopPropagation). Pure:
// works on anything with `closest` / `tagName` / `isContentEditable`, so node tests can pass plain objects.

export type KeyScope = 'drawings' | 'view2d' | 'view3d' | string;

interface ElLike {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (sel: string) => ElLike | null;
  getAttribute?: (name: string) => string | null;
}

interface KeyEventLike {
  code?: string;
  defaultPrevented?: boolean;
  target?: unknown;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

export function isTypingTarget(t: unknown): boolean {
  const el = t as ElLike | null;
  const tag = el?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable === true;
}

/** The innermost key scope containing the target, or null. */
export function keyScopeOf(t: unknown): KeyScope | null {
  const el = t as ElLike | null;
  if (!el || typeof el.closest !== 'function') return null;
  const s = el.closest('[data-keyscope]');
  return s?.getAttribute?.('data-keyscope') ?? null;
}

/**
 * CameraRig fly-key guard: fly keys are ignored when another handler consumed the key, when typing, or when the target sits inside
 * a key scope other than the 3D pane (2D pane, Drawings list / preview, splitter …).
 */
export function flyKeyAllowed(e: KeyEventLike): boolean {
  if (e.defaultPrevented) return false;
  if (isTypingTarget(e.target)) return false;
  const scope = keyScopeOf(e.target);
  return scope === null || scope === 'view3d';
}

export type ViewportKeyAction = { kind: 'mode'; mode: '3d' | 'plan' | 'section' | 'elevation' } | { kind: 'split' };

const MODE_KEYS: Record<string, ViewportKeyAction> = {
  Digit1: { kind: 'mode', mode: '3d' },
  Digit2: { kind: 'mode', mode: 'plan' },
  Digit3: { kind: 'mode', mode: 'section' },
  Digit4: { kind: 'mode', mode: 'elevation' },
  Digit5: { kind: 'split' },
};

/** Viewport-scope mode keys (Digit1–5): only inside a viewport pane, never with modifiers, typing or an already consumed key. */
export function viewportKeyAction(e: KeyEventLike): ViewportKeyAction | null {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return null;
  const scope = keyScopeOf(e.target);
  if (scope !== 'view2d' && scope !== 'view3d') return null;
  return (e.code && MODE_KEYS[e.code]) || null;
}

/**
 * Digit1–5 for a *hovered* viewport while focus sits outside every key scope (body, a panel button): spec §3.3 "focused or hovered
 * pane". Never when typing, inside a key scope (Drawings binds Digit0/1/9; the panes handle their own), a dialog / menu / tree, or with
 * a modifier (Shift+Slash is the shortcut sheet).
 */
export function hoverViewportKeyAction(e: KeyEventLike & { shiftKey?: boolean }): ViewportKeyAction | null {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || isTypingTarget(e.target)) return null;
  if (keyScopeOf(e.target) !== null) return null;
  const el = e.target as ElLike | null;
  if (el?.closest?.('[role="dialog"], [role="menu"], [role="tree"], [role="listbox"]')) return null;
  return (e.code && MODE_KEYS[e.code]) || null;
}

/** 2D pane keys (spec §3.3). `measuring` enables Backspace; everything else is never bound (W A S D Q E, arrows, R, Delete …). */
export type Pane2DKey =
  | 'tool-select' | 'tool-pan' | 'tool-measure' | 'tool-cut' | 'flip' | 'nudge-' | 'nudge+' | 'nudge-fine-' | 'nudge-fine+' | 'prev' | 'next'
  | 'layers' | 'annotations' | 'snap' | 'fit-hall' | 'zoom-in' | 'zoom-out' | 'fit-selection' | 'escape' | 'measure-undo' | 'measure-end';

export function pane2DKey(e: KeyEventLike, measuring: boolean): Pane2DKey | null {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || isTypingTarget(e.target)) return null;
  if (keyScopeOf(e.target) !== 'view2d') return null;
  const alt = !!e.altKey;
  switch (e.code) {
    case 'Comma':
      return alt ? 'nudge-fine-' : 'nudge-';
    case 'Period':
      return alt ? 'nudge-fine+' : 'nudge+';
    case 'Backspace':
      return measuring && !alt ? 'measure-undo' : null;
    case 'Enter':
    case 'NumpadEnter':
      return measuring && !alt ? 'measure-end' : null;
  }
  if (alt) return null;
  switch (e.code) {
    case 'KeyV': return 'tool-select';
    case 'KeyH': return 'tool-pan';
    case 'KeyM': return 'tool-measure';
    case 'KeyC': return 'tool-cut';
    case 'KeyX': return 'flip';
    case 'BracketLeft': return 'prev';
    case 'BracketRight': return 'next';
    case 'KeyL': return 'layers';
    case 'KeyT': return 'annotations';
    case 'KeyG': return 'snap';
    case 'Digit0': case 'Numpad0': return 'fit-hall';
    case 'Equal': case 'NumpadAdd': return 'zoom-in';
    case 'Minus': case 'NumpadSubtract': return 'zoom-out';
    case 'KeyF': return 'fit-selection';
    case 'Escape': return 'escape';
    default: return null;
  }
}
