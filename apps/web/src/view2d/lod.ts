// r4 stream C (spec §3.2 LOD): level-of-detail bands of the plan with ±15 % hysteresis (pure).
//   0 Campus < 1.5 ppm · 1 Hall 1.5–12 · 2 Pod 12–40 · 3 Detail ≥ 40
// A band is left only when ppm moves 15 % past the threshold, so labels do not flicker when a zoom settles on a boundary.
export type LodBand = 0 | 1 | 2 | 3;

export const LOD_THRESHOLDS: readonly [number, number, number] = [1.5, 12, 40];
export const LOD_HYSTERESIS = 0.15;
/** below this ppm, racks draw as merged row bars (band 1, spec §3.2) */
export const ROW_BAR_PPM = 6;
/** sections / elevations below this ppm merge racks into row blocks */
export const SECTION_BLOCK_PPM = 8;
/** minimum label height on screen (px) */
export const MIN_LABEL_PX = 7;

/** Band without hysteresis. */
export function lodBandOf(ppm: number): LodBand {
  const [a, b, c] = LOD_THRESHOLDS;
  return ppm < a ? 0 : ppm < b ? 1 : ppm < c ? 2 : 3;
}

/**
 * Band with hysteresis: stays in `prev` while ppm lies inside prev's range widened by ±15 % at each threshold; otherwise the
 * plain band. Jumps across several bands resolve in one call.
 */
export function lodBand(ppm: number, prev: LodBand | null | undefined): LodBand {
  const plain = lodBandOf(ppm);
  if (prev === null || prev === undefined || plain === prev) return plain;
  const t = LOD_THRESHOLDS;
  const lo = prev === 0 ? -Infinity : t[prev - 1] * (1 - LOD_HYSTERESIS);
  const hi = prev === 3 ? Infinity : t[prev] * (1 + LOD_HYSTERESIS);
  return ppm >= lo && ppm < hi ? prev : plain;
}
