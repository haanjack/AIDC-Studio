import type { CableType } from '../../model/types.ts';

/**
 * Cable / optic seeds extending CABLE_TYPES (800G OSFP class; public transceiver MSA reaches).
 * Existing ids (dac-800, aec-800, mmf-800-sr8, smf-800-dr8 …) keep working; these add the missing media classes:
 * ACC (3–5 m linear active copper), 800G AOC, DR8 "-NS" 100 m variant, FR8 2 km, LPO and 1.6T XDR copper.
 *
 * The cabling engine still reads cableUSD / cableUSDPerM / transceiverUSD / transceiverW; the v2 fields
 * (medium, wattsPerEnd, priceFixedUSD, pricePerMUSD) mirror them. Prices are 2nd-source list prices → 'estimate'.
 */
const C = (o: Omit<CableType, 'wattsPerEnd' | 'priceFixedUSD' | 'pricePerMUSD'> & Partial<Pick<CableType, 'wattsPerEnd' | 'priceFixedUSD' | 'pricePerMUSD'>>): CableType => ({
  wattsPerEnd: o.transceiverW,
  priceFixedUSD: o.cableUSD,
  pricePerMUSD: o.cableUSDPerM,
  ...o,
});

export const CABLE_SEEDS: CableType[] = [
  C({ id: 'acc-800', kind: 'acc', medium: 'copper', name: '800G linear active copper (ACC/LACC) 3–5 m', gbps: 800, minReachM: 2.5, maxReachM: 5, cableUSD: 420, cableUSDPerM: 60, transceiverUSD: 0, transceiverW: 1.5, latencyNsPerM: 4.4, source: 'estimate' }),
  C({ id: 'aoc-800', kind: 'aoc', medium: 'aoc', name: '800G active optical cable (OM4) ≤ 50 m', gbps: 800, minReachM: 3, maxReachM: 50, cableUSD: 2_400, cableUSDPerM: 18, transceiverUSD: 0, transceiverW: 7, latencyNsPerM: 4.9, source: 'estimate' }),
  C({ id: 'smf-800-dr8-ns', kind: 'smf', medium: 'smf', name: '800G DR8-NS (100 m SMF, node-to-switch) + MPO-16', gbps: 800, minReachM: 1, maxReachM: 100, cableUSD: 90, cableUSDPerM: 2.0, transceiverUSD: 1_100, transceiverW: 15, latencyNsPerM: 4.9, source: 'estimate' }),
  C({ id: 'smf-800-fr8', kind: 'smf', medium: 'smf', name: '800G FR8 / 2×FR4 (2 km SMF duplex)', gbps: 800, minReachM: 2, maxReachM: 2000, cableUSD: 60, cableUSDPerM: 1.2, transceiverUSD: 2_100, transceiverW: 17, latencyNsPerM: 4.9, source: 'estimate' }),
  C({ id: 'lpo-800-sr8', kind: 'mmf', medium: 'mmf', name: '800G LPO (linear pluggable optics, SR-class, OM4 ≤ 50 m)', gbps: 800, minReachM: 1, maxReachM: 50, cableUSD: 120, cableUSDPerM: 4.5, transceiverUSD: 950, transceiverW: 9, latencyNsPerM: 4.9, source: 'estimate' }),
  C({ id: 'dac-1600', kind: 'dac', medium: 'copper', name: '1.6T passive DAC (XDR twin-port OSFP) ≤ 1.5 m', gbps: 1600, minReachM: 0.5, maxReachM: 1.5, cableUSD: 420, cableUSDPerM: 150, transceiverUSD: 0, transceiverW: 0.2, latencyNsPerM: 4.3, source: 'estimate' }),
  C({ id: 'acc-1600', kind: 'acc', medium: 'copper', name: '1.6T XDR active copper (ACC) 1.1–3 m', gbps: 1600, minReachM: 1.1, maxReachM: 3, cableUSD: 900, cableUSDPerM: 120, transceiverUSD: 0, transceiverW: 2.5, latencyNsPerM: 4.4, source: 'estimate' }),
  C({ id: 'mmf-1600-sr8', kind: 'mmf', medium: 'mmf', name: '1.6T SR8 (200G/lane) + OM4 MPO-16 ≤ 50 m', gbps: 1600, minReachM: 1, maxReachM: 50, cableUSD: 140, cableUSDPerM: 4.5, transceiverUSD: 2_400, transceiverW: 25, latencyNsPerM: 4.9, source: 'estimate' }),
];

/** Per-media reference table (spine-placement.md §3) kept for the catalog panel / docs. */
export const CABLE_MEDIA_NOTES: { kind: CableType['kind']; reach: string; wattsPerEnd: string; price: string }[] = [
  { kind: 'dac', reach: '800G ≤ 2 m (NVIDIA MCP4Y10; ~2.5 m third-party)', wattsPerEnd: '≈ 0–0.2 W', price: '2 m ≈ US$165–299' },
  { kind: 'acc', reach: '3–5 m (MCA4J80); 1.6T XDR 1.1–3 m', wattsPerEnd: '1.5 W max per end', price: 'n/a (NVIDIA part)' },
  { kind: 'aec', reach: '5–7 m typical (9–10 m demonstrated)', wattsPerEnd: '≈ 3–10 W', price: '5 m ≈ US$650–1,055' },
  { kind: 'aoc', reach: '30 m OM3 / 50 m OM4 (vendors claim 60–100 m)', wattsPerEnd: '< 7 W (< 14 W per cable)', price: '3 m ≈ US$3,040–3,899' },
  { kind: 'mmf', reach: 'SR8 50 m (SuperPOD: 50 m max, 30 m optimum); LPO same class', wattsPerEnd: '14–17 W (SR8); LPO ≈ 9 W', price: 'US$599–1,249 per SR8 module' },
  { kind: 'smf', reach: 'DR8 500 m (DR8-NS ≈ 100 m); FR8 2 km', wattsPerEnd: '14–18 W', price: 'DR8 US$899–1,949; FR8 US$1,869–2,399' },
];
