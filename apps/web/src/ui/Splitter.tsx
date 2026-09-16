// r4 contract (C7): a small accessible pane splitter (Drawings list | preview, 3D | 2D split). Owner after the contract: stream D.
// Controlled: the parent owns the size (px) and persists it. Pointer drag with capture, keyboard on the focused handle
// (arrows ± step, Home / End = min / max; handled keys call preventDefault + stopPropagation so fly keys never see them),
// double-click resets to `defaultValue`. Styling hook: `.splitter` with `data-orientation` and `data-dragging`.
import { useCallback, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';

export interface SplitterProps {
  /** 'vertical' = a vertical bar resizing left / right panes (default); 'horizontal' = a horizontal bar resizing top / bottom */
  orientation?: 'vertical' | 'horizontal';
  /** current size (px) of the pane the splitter controls */
  value: number;
  min: number;
  max: number;
  /** live updates while dragging / on each key */
  onChange: (value: number) => void;
  /** final value (pointer up, key press, double-click reset) — persist here */
  onCommit?: (value: number) => void;
  /** double-click resets to this value */
  defaultValue?: number;
  /** keyboard step (px), default 16 */
  step?: number;
  /** the controlled pane is after the splitter (right / bottom): dragging towards it shrinks it */
  invert?: boolean;
  /** hit-area thickness (px), default 6 */
  thickness?: number;
  ariaLabel?: string;
  className?: string;
  style?: CSSProperties;
  disabled?: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

export function Splitter({ orientation = 'vertical', value, min, max, onChange, onCommit, defaultValue, step = 16, invert = false, thickness = 6, ariaLabel, className, style, disabled }: SplitterProps) {
  const drag = useRef<{ start: number; value: number; last: number; pointerId: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const vertical = orientation === 'vertical';
  const sign = invert ? -1 : 1;

  const onPointerDown = useCallback((e: PointerEvent<HTMLDivElement>) => {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { start: vertical ? e.clientX : e.clientY, value, last: value, pointerId: e.pointerId };
    setDragging(true);
  }, [disabled, vertical, value]);

  const onPointerMove = useCallback((e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const next = clamp(d.value + sign * ((vertical ? e.clientX : e.clientY) - d.start), min, max);
    if (next !== d.last) {
      d.last = next;
      onChange(next);
    }
  }, [sign, vertical, min, max, onChange]);

  const end = useCallback((e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    drag.current = null;
    setDragging(false);
    onCommit?.(d.last);
  }, [onCommit]);

  const set = useCallback((v: number) => {
    const next = clamp(v, min, max);
    onChange(next);
    onCommit?.(next);
  }, [min, max, onChange, onCommit]);

  const onKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const dec = vertical ? 'ArrowLeft' : 'ArrowUp';
    const inc = vertical ? 'ArrowRight' : 'ArrowDown';
    let next: number | null = null;
    if (e.key === dec) next = value - sign * step;
    else if (e.key === inc) next = value + sign * step;
    else if (e.key === 'Home') next = min;
    else if (e.key === 'End') next = max;
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    set(next);
  }, [disabled, vertical, value, sign, step, min, max, set]);

  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-valuenow={Math.round(value)}
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(max)}
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      className={`splitter${className ? ` ${className}` : ''}`}
      data-orientation={orientation}
      data-dragging={dragging ? '' : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={onKeyDown}
      onDoubleClick={defaultValue !== undefined && !disabled ? () => set(defaultValue) : undefined}
      style={{
        flex: `0 0 ${thickness}px`,
        [vertical ? 'width' : 'height']: thickness,
        [vertical ? 'alignSelf' : 'justifySelf']: 'stretch',
        cursor: disabled ? 'default' : vertical ? 'col-resize' : 'row-resize',
        touchAction: 'none',
        userSelect: 'none',
        position: 'relative',
        zIndex: 2,
        ...style,
      }}
    />
  );
}
