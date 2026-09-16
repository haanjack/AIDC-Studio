// r4 drawing units (spec S6, T7). Owner: stream B0 (hand-off B → C: fmtLength). Metric default: metres, two decimals, no suffix;
// levels '+2.73'. Imperial: ft-in to the nearest ½" at 1:50 and larger (and when no scale is given), 1" on smaller scales (plans).
// An absent Project.drawingUnits means metric, so every pre-r4 output stays byte-identical.
import type { DrawingUnits, Locale, Project } from '../model/types.ts';

const IN_PER_M = 1 / 0.0254;

/** The units a project's sheets and 2D readouts use (default metric). */
export function drawingUnitsOf(project: Pick<Project, 'drawingUnits'>): DrawingUnits {
  return project.drawingUnits === 'imperial' ? 'imperial' : 'metric';
}

/** Imperial rounding step: ½" at 1:50 and larger (or no scale), 1" on smaller scales. */
export function imperialStepIn(scaleDen?: number): 0.5 | 1 {
  return scaleDen !== undefined && scaleDen > 50 ? 1 : 0.5;
}

/** "8'-11 1/2\"" style ft-in string; `stepIn` = 0.5 or 1 */
export function feetInches(m: number, stepIn: 0.5 | 1 = 0.5): string {
  const total = Math.round((Math.abs(m) * IN_PER_M) / stepIn) * stepIn;
  const sign = m < 0 && total > 0 ? '-' : '';
  let ft = Math.floor(total / 12 + 1e-9);
  let inch = total - ft * 12;
  if (inch >= 12 - 1e-9) {
    ft += 1;
    inch -= 12;
  }
  const whole = Math.floor(inch + 1e-9);
  const half = inch - whole >= 0.5 - 1e-9;
  return `${sign}${ft}'-${whole}${half ? ' 1/2' : ''}"`;
}

/** Length for dimension texts. `scaleDen` = scale denominator (50 for 1:50). */
export function fmtLength(m: number, units: DrawingUnits = 'metric', scaleDen?: number): string {
  if (!Number.isFinite(m)) return '—';
  if (units === 'imperial') return feetInches(m, imperialStepIn(scaleDen));
  const r = Math.round(m * 100) / 100;
  return (Object.is(r, -0) ? 0 : r).toFixed(2);
}

/** Level datum text: '+2.73' / '±0.00' (metric) or "+8'-11 1/2\"" / "±0'-0\"" (imperial, ½" step). */
export function fmtLevel(z: number, units: DrawingUnits = 'metric'): string {
  if (!Number.isFinite(z)) return '—';
  if (units === 'imperial') {
    const halfInches = Math.round(Math.abs(z) * IN_PER_M * 2);
    if (halfInches === 0) return `±0'-0"`;
    return `${z > 0 ? '+' : '-'}${feetInches(Math.abs(z), 0.5)}`;
  }
  const r = Math.round(z * 100) / 100;
  return r === 0 ? '±0.00' : `${r > 0 ? '+' : ''}${r.toFixed(2)}`;
}

/** Short unit label for sheet notes and the 2D readout toggle. */
export function unitsLabel(units: DrawingUnits, locale: Locale = 'en'): string {
  if (units === 'imperial') return locale === 'ko' ? 'ft-in' : 'ft-in';
  return 'm';
}

/** General note on units (sheet 001 and sheet notes). */
export function unitsNote(units: DrawingUnits, locale: Locale = 'en'): string {
  if (units === 'imperial') {
    return locale === 'ko'
      ? '치수 단위 ft-in: 1:50 이상 축척은 1/2", 평면도는 1" 단위로 반올림. 레벨은 FFL ±0\'-0" 기준.'
      : 'Dimensions in feet-inches, rounded to 1/2" at 1:50 and larger and to 1" on plans. Levels relative to FFL ±0\'-0".';
  }
  return locale === 'ko' ? '치수 단위 m (소수 둘째 자리). 레벨은 마감 바닥면(FFL) ±0.00 기준.' : 'Dimensions in metres (two decimals). Levels relative to finished floor level (FFL) ±0.00.';
}
