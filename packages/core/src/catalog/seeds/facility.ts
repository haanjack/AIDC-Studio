import type { CatalogItem } from '../../model/types.ts';

/**
 * Facility seeds: a fan-wall unit (Liebert CWA class, estimate), CDUs with (kW, ATD, flow, head) rating tuples in
 * `meta.ratings` (vendor datasheet ratings), plus one busway tap-off and one LV switchgear line-up so every
 * EquipmentCategory has at least one item. The Vertiv CoolChip CDU 1350 / CDU 2300 planning items stay in catalog.ts.
 */

export interface CduRating {
  coolingKW: number;
  /** approach temperature difference (°C) at which the rating applies */
  atdC: number;
  flowLpm?: number;
  headPsi?: number;
  note?: string;
}

const cdu = (o: Partial<CatalogItem> & Pick<CatalogItem, 'id' | 'vendor' | 'model' | 'name' | 'description' | 'dims' | 'weightKg' | 'power' | 'capacity' | 'cost' | 'source'> & { ratings: CduRating[] }): CatalogItem => {
  const { ratings, ...rest } = o;
  return {
    category: 'cdu',
    clearance: { front: 1.0, rear: 0.9, sides: 0 },
    asset: { color: '#d9dadb' },
    ...rest,
    meta: { ratings, ...(rest.meta ?? {}) },
  };
};

export const FACILITY_CATALOG: CatalogItem[] = [
  {
    id: 'liebert-cwa-fanwall-600', category: 'fan-wall', vendor: 'Vertiv', model: 'Liebert CWA class (600 kW)', name: 'Fan-wall unit, chilled-water (600 kW class)',
    description: 'Thermal-wall / fan-wall chilled-water air handler mounted in the wall between the hall and the mechanical gallery (Liebert CWA class): EC fan array, ~42 m³/s at 12 K ΔT, slab-floor halls, serviced from the gallery.',
    dims: { w: 3.6, d: 1.5, h: 3.0 }, weightKg: 2600, clearance: { front: 1.5, rear: 1.0, sides: 0.1 },
    power: { nameplateKW: 24, typicalKW: 14, idleKW: 3, peakKW: 24, feeds: 1, voltageV: 480 },
    capacity: { coolingKW: 600, airflowM3s: 41.5 },
    cost: { capexUSD: 165_000, installHours: 96, leadTimeWeeks: 20 },
    asset: { glb: 'generic_fanwall_3600x3000.glb', usd: 'usd/Generic/generic_fanwall_3600x3000.usd', color: '#cfd2d4' }, source: 'estimate',
    links: [{ label: 'Vertiv Liebert CWA', url: 'https://www.vertiv.com/en-us/products-catalog/thermal-management/room-cooling/liebert-cwa-thermal-wall/' }],
    notes: 'Class estimate: airflow = 600 kW / (1.2 kg/m³ × 1.005 kJ/kg·K × 12 K) ≈ 41.5 m³/s; fan power ≈ 4 % of cooling. Hall-level N+1 (units = ceil(air kW / 600) + 1) (AIDC Studio class rule); the exact CWA model table was not re-checked.',
  },
  cdu({
    id: 'vertiv-coolchip-cdu-2300', vendor: 'Vertiv', model: 'CoolChip CDU 2300', name: 'Vertiv CoolChip CDU 2300 (2,300 kW @ 4 °C ATD)',
    description: 'Perimeter / gallery liquid-to-liquid CDU, 2,300 kW at 4 °C approach, 6-inch flanges, redundant pumps / sensors / component-and-unit failover ("large scale, multi-pod, campus"). Datasheet values (the catalog.ts item vertiv-xdu2300 carries the same datasheet power and mass since 2026-09-15).',
    dims: { w: 2.4, d: 1.2, h: 1.2 }, weightKg: 1793,
    power: { nameplateKW: 47.8, typicalKW: 30, idleKW: 8, peakKW: 47.8, feeds: 2, voltageV: 480 },
    capacity: { coolingKW: 2300, liquidFlowLpm: 3300 },
    cost: { capexUSD: 295_000, installHours: 110, leadTimeWeeks: 26 }, source: 'vendor-datasheet',
    links: [{ label: 'CoolChip CDU 2300 data sheet (PDF)', url: 'https://www.vertiv.com/493b1e/globalassets/shared/vertiv-coolchip-cdu-2300kw-data-sheet-sl-80005.pdf' }, { label: 'Vertiv CoolChip CDU', url: 'https://www.vertiv.com/en-us/products-catalog/thermal-management/high-density-solutions/vertiv-coolchip-cdu/' }],
    notes: 'Datasheet: 2,300 kW @ 4 °C ATD, 2400 × 1200 × 1200 mm, 1,793 kg wet, 47.8 kW (≈ 2.1 % parasitic). Secondary flow 3,300 LPM (≈ 1.4 LPM/kW) and typical/idle power are estimates. Dims mapped w=2.4 (frontage), d=1.2, h=1.2 as printed — verify orientation against the drawing.',
    ratings: [{ coolingKW: 2300, atdC: 4, flowLpm: 3300, note: '6-inch flanges; redundant pumps' }],
  }),
  cdu({
    id: 'coolit-chx2000', vendor: 'CoolIT', model: 'CHx2000', name: 'CoolIT CHx2000 (2,000 kW @ 5 °C ATD)',
    description: 'Row-based liquid-to-liquid CDU, 2,000 kW at 5 °C ATD, 2,125 LPM at 35 psi, 12 × GB300 NVL72 racks per CDU (1.2 LPM/kW), 750 × 1200 mm footprint.',
    dims: { w: 0.75, d: 1.2, h: 2.0 }, weightKg: 900,
    power: { nameplateKW: 12.24, typicalKW: 9, idleKW: 3, peakKW: 12.24, feeds: 2, voltageV: 480 },
    capacity: { coolingKW: 2000, liquidFlowLpm: 2125 },
    cost: { capexUSD: 240_000, installHours: 90, leadTimeWeeks: 22 }, source: 'vendor-datasheet',
    links: [{ label: 'CoolIT CHx2000', url: 'https://www.coolitsystems.com/cdu-product/chx2000/' }],
    notes: 'Vendor page: 2,000 kW @ 5 °C ATD, 2,125 LPM @ 35 psi, 12.24 kW, 750 × 1200 mm. Height, weight, typical/idle power and price are estimates.',
    ratings: [{ coolingKW: 2000, atdC: 5, flowLpm: 2125, headPsi: 35, note: '12 × GB300 NVL72 per CDU' }],
  }),
  cdu({
    id: 'motivair-mcdu-70', vendor: 'Motivair (Schneider)', model: 'MCDU-70', name: 'Motivair MCDU-70 (2.5 MW)',
    description: 'Floor-mount liquid-to-liquid CDU, 2.5 MW (at 105.8 °F primary / 113 °F secondary, 25 % PG), 1,025 / 991 GPM primary / secondary, 38 psi head, 6-inch connections, 2 pumps, A/B feeds.',
    dims: { w: 2.29, d: 1.22, h: 1.6 }, weightKg: 2200,
    power: { nameplateKW: 40, typicalKW: 26, idleKW: 8, peakKW: 40, feeds: 2, voltageV: 480 },
    capacity: { coolingKW: 2500, liquidFlowLpm: 3751 },
    cost: { capexUSD: 310_000, installHours: 110, leadTimeWeeks: 26 }, source: 'vendor-datasheet',
    links: [{ label: 'Motivair CDU brochure (PDF)', url: 'https://www.motivaircorp.com/uploads/files/brochures/CDU%202026%20Motivair%20by%20SE.pdf' }],
    notes: 'Brochure: 2.5 MW, 90.0 × 48.13 × 63.0 in (2.29 × 1.22 × 1.60 m), 1,025 / 991 GPM (3,880 / 3,751 LPM), 38 psi, 6-inch. ATD at the rated point ≈ 4 K (113 − 105.8 °F) — derived. Weight, power and price are estimates ("industry target of 1.5 LPM per kW").',
    ratings: [{ coolingKW: 2500, atdC: 4, flowLpm: 3751, headPsi: 38, note: '105.8 °F primary / 113 °F secondary, 25 % PG' }],
  }),
  cdu({
    id: 'boyd-rol4000', vendor: 'Boyd', model: 'ROL4000-48U65', name: 'Boyd ROL4000 (2 MW @ 3 °C ATD)',
    description: 'In-row liquid-to-liquid CDU, 2 MW at 3 °C approach, up to 80 psi, seal-less N+1 pumps, redundant power feeds, 0.2 µm side-stream filtration; 48U rack form factor.',
    dims: { w: 0.65, d: 1.2, h: 2.3 }, weightKg: 1000,
    power: { nameplateKW: 30, typicalKW: 20, idleKW: 6, peakKW: 30, feeds: 2, voltageV: 480 },
    capacity: { coolingKW: 2000, liquidFlowLpm: 2600 },
    cost: { capexUSD: 250_000, installHours: 90, leadTimeWeeks: 22 }, source: 'vendor-datasheet',
    links: [{ label: 'Boyd ROL4000 (news)', url: 'https://www.boydcorp.com/about-boyd/resources/news-and-events/boyd-2mw-cdu-for-liquid-cooled-ai-data-centers-rol4000.html' }, { label: 'Boyd CDU brochure (PDF)', url: 'https://info.boydcorp.com/hubfs/Thermal/Liquid-Cooling/Boyd-Coolant-Distribution-Units.pdf' }],
    notes: 'Vendor: "2 MW of cooling at a 3 °C approach", up to 80 psi, N+1 seal-less pumps, ROL2300 = 2.3 MW. 48U / 650 mm width from the model code; depth, weight, flow (1.3 LPM/kW), power and price are estimates.',
    ratings: [{ coolingKW: 2000, atdC: 3, flowLpm: 2600, headPsi: 80, note: 'up to 80 psi; N+1 pumps' }],
  }),
  {
    id: 'busway-tapoff-250a', category: 'busway-tapoff', vendor: 'Generic', model: 'Tap-off 250 A', name: 'Overhead busway tap-off (250 A, 415 V, 3P+N+PE)',
    description: 'Plug-in tap-off box for an overhead busway run, 250 A @ 415 V (≈ 180 kVA), breaker + metering, feeds one rack-pair A or B PDU whip.',
    dims: { w: 0.35, d: 0.25, h: 0.45 }, weightKg: 18, clearance: { front: 0, rear: 0, sides: 0 },
    capacity: { powerKVA: 180, currentA: 250, outputVoltageV: 415 },
    cost: { capexUSD: 3_200, installHours: 2, leadTimeWeeks: 10 },
    asset: { color: '#5a6b7a' }, source: 'estimate',
    notes: 'Estimate. One tap-off per feed (A/B) per rack for 130–227 kW racks (2 × 250 A × 415 V × √3 × 0.8 ≈ 287 kW).',
  },
  {
    id: 'switchgear-lv-4000a', category: 'switchgear', vendor: 'Generic', model: 'LV switchgear 4,000 A', name: 'LV main switchgear line-up (4,000 A, 415 V)',
    description: 'Low-voltage main switchboard per transformer: 4,000 A main ACB, feeder ACBs to UPS / mechanical / busways, metering, 65 kA.',
    dims: { w: 6.0, d: 1.2, h: 2.3 }, weightKg: 4500, clearance: { front: 1.5, rear: 1.0, sides: 0.5 },
    capacity: { powerKVA: 2875, currentA: 4000, inputVoltageV: 415, outputVoltageV: 415 },
    cost: { capexUSD: 260_000, installHours: 160, leadTimeWeeks: 30 },
    asset: { color: '#7d8791' }, source: 'estimate',
    notes: 'Estimate; matches the synthetic "LV switchgear per transformer" cost line in engines/cost.ts (260 k USD).',
  },
];
