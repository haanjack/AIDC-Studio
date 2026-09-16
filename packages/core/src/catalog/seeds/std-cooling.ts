import type { CatalogItem } from '../../model/types.ts';
import { block, D, E, GPM_TO_LPM, kwPerLpm, PSI_TO_KPA, round, std, U, V } from './std-helpers.ts';

/**
 * Liquid and air cooling building blocks (stream B / P2; OCP-DESIGN-PROPOSAL §3.2, P0 closure log).
 * Connector / manifold / CDU parameters with provenance; generic air handlers and UPS classes are NEW ids used by
 * new-project fallbacks (vendor ids keep their own values). Nothing here is tagged `meta.coolingTopology`, so the cooling
 * topology comparison of existing projects is unchanged.
 */

const psi = (x: number) => round(x * PSI_TO_KPA, 1);

// ───────────────────────────── quick connectors ─────────────────────────────

const UQD_SIZES = [
  { size: '02', cv: 0.25, gpm: 0.55, cvB: 0.25 },
  { size: '04', cv: 0.8, gpm: 1.7, cvB: 0.8 },
  { size: '06', cv: 1.6, gpm: 3.0, cvB: 1.55 },
  { size: '08', cv: 2.5, gpm: 4.7, cvB: 2.4 },
];

const uqd = (blind: boolean) =>
  UQD_SIZES.map(({ size, cv, gpm, cvB }) => {
    const lpm = round(gpm * GPM_TO_LPM, 1);
    const c = blind ? cvB : cv;
    const dpKPa = round((gpm / c) ** 2 * PSI_TO_KPA, 1);
    const sid = blind ? 'uqdb@1.0' : 'uqd@1.0';
    return block({
      id: `qd-${blind ? 'uqdb' : 'uqd'}${size}`, category: 'other', blockKind: 'quick-connector',
      model: `${blind ? 'Blind-mate universal' : 'Universal'} quick disconnect, size ${size}`,
      name: `${blind ? 'Blind-mate universal' : 'Universal'} quick disconnect, size ${size} (${lpm} L/min)`,
      description: `${blind ? 'Blind-mate' : 'Hand-mate'} liquid quick disconnect, size ${size}: 100 psi max operating, 300 psi burst, 17–65 °C, min Cv ${c}${blind ? ' at minimum engagement' : ''}, rated flow ≥${gpm} GPM (≈${lpm} L/min).`,
      liquidInterface: { connector: blind ? 'uqdb' : 'uqd', mawpKPa: psi(100), maxFluidC: 65, ratedLpmPerPort: lpm, hydrostaticKPa: psi(300) },
      cost: { capexUSD: 0, installHours: 0, leadTimeWeeks: 0 },
      standards: [std(sid, 'open-spec', 'liquid', 'verified')],
      paramSources: {
        'liquidInterface.mawpKPa': V(sid, undefined, '100 psi max operating'),
        'liquidInterface.hydrostaticKPa': V(sid, undefined, '300 psi burst'),
        'liquidInterface.maxFluidC': V(sid, undefined, '17–65 °C'),
        'liquidInterface.ratedLpmPerPort': D(sid, `rated ≥${gpm} GPM × 3.785`),
        'meta.minCv': V(sid),
        'meta.dpAtRatedKPa': D(sid, `ΔP per pair ≈ (Q/Cv)² = (${gpm}/${c})² psi`),
        'meta.kwPerPairAt10K': D(sid, 'Q × ρ × cp × 10 K, PG25'),
      },
      notes: `Connector descriptor (priced inside rack / node lines). ΔP per pair at rated flow ≈ ${dpKPa} kPa; ≈${round(lpm * kwPerLpm('pg25', 10), 1)} kW per pair at ΔT 10 K with PG25 (derived). 5000 mating cycles.`,
      meta: { minCv: c, dpAtRatedKPa: dpKPa, kwPerPairAt10K: round(lpm * kwPerLpm('pg25', 10), 2), cycles: 5000, minFluidC: 17 },
    });
  });

export const QUICK_CONNECTOR_BLOCKS: CatalogItem[] = [
  ...uqd(false),
  ...uqd(true),
  block({
    id: 'qd-bmqc', category: 'other', blockKind: 'quick-connector', model: 'Rack blind-mate quick connector', name: 'Rack blind-mate quick connector (9 L/min, 50 psig)',
    description: 'Blind-mate quick connector for 21-inch OU rack manifolds: 50 psig (3.45 bar) max working, 9 L/min max flow, 60 °C max fluid; interoperability testing required.',
    liquidInterface: { connector: 'bmqc', mawpKPa: psi(50), maxFluidC: 60, ratedLpmPerPort: 9 },
    standards: [std('orv3-bmqc@1.0', 'open-spec', 'liquid', 'verified')],
    paramSources: {
      'liquidInterface.mawpKPa': V('orv3-bmqc@1.0', 'Table 9.8', '50 psig (3.45 bar)'),
      'liquidInterface.ratedLpmPerPort': V('orv3-bmqc@1.0', 'Table 9.8', 'maximum flow rate'),
      'liquidInterface.maxFluidC': V('orv3-bmqc@1.0', 'Table 9.8'),
      'meta.kwPerPairAt10K': D('orv3-bmqc@1.0', '9 L/min × 1.02 kg/L × 3.95 kJ/kg·K × 10 K ÷ 60 (PG25)'),
      'meta.kwPerPairWaterAt10K': D('orv3-bmqc@1.0', 'water ρ 0.997, cp 4.18'),
      'meta.kwPerPairAt1p5LpmPerKW': D('l-lcdu-wp@1.0', '9 L/min ÷ 1.5 L/min per kW'),
    },
    notes: 'Rev 1.0 is still the latest revision. One pair ≈6.0 kW at ΔT 10 K (PG25) / ≈6.3 kW (water); 6 kW at the 1.5 L/min-per-kW convention, so a ≈12 kW DLC node needs two pairs (derived).',
    meta: { kwPerPairAt10K: round(9 * kwPerLpm('pg25', 10), 2), kwPerPairWaterAt10K: round(9 * kwPerLpm('treated-water', 10), 2), kwPerPairAt1p5LpmPerKW: 6 },
  }),
  block({
    id: 'qd-lqc-v2', category: 'other', blockKind: 'quick-connector', model: 'Large quick connector, G1 1"', name: 'Large quick connector, G1 1" (100 L/min check value, 75 psig)',
    description: 'Hand-mate screw-coupling rack-to-TCS connector with G1 BSPP female ends: operating ≤75 psig at 60 °C, connect/disconnect ≤50 psig at 60 °C, hydrostatic 300 psig, −5…60 °C (PG25), spill <0.15 mL.',
    liquidInterface: { connector: 'lqc', mawpKPa: psi(75), connectMawpKPa: psi(50), hydrostaticKPa: psi(300), maxFluidC: 60, ratedLpmPerPort: 100 },
    standards: [std('lqc@2.0.0', 'open-spec', 'liquid', 'verified')],
    paramSources: {
      'liquidInterface.mawpKPa': V('lqc@2.0.0', '§7', 'maximum operating pressure 75 psig @ 60 °C'),
      'liquidInterface.connectMawpKPa': V('lqc@2.0.0', '§7', 'connect/disconnect 50 psig @ 60 °C'),
      'liquidInterface.hydrostaticKPa': V('lqc@2.0.0', '§7'),
      'liquidInterface.ratedLpmPerPort': V('lqc@2.0.0', '§7', 'max flow ">100 LPM", tested at 100 LPM: a floor used as the check value'),
      'liquidInterface.maxFluidC': V('lqc@2.0.0', '§7'),
      'meta.kwPerPairAt10K': D('lqc@2.0.0', '100 L/min, PG25, ΔT 10 K'),
      'meta.pqCurve': U('P-Q limit curve 20–100 L/min exists only as a figure'),
    },
    notes: 'Supersedes V1.0 (its "35 psi working / 175 psi max operating" values must not be used). ≈67 kW per pair at ΔT 10 K with PG25 (derived).',
    meta: { kwPerPairAt10K: round(100 * kwPerLpm('pg25', 10), 1), minFluidC: -5, spillMl: 0.15, ends: 'G1 BSPP female' },
  }),
  block({
    id: 'qd-pbmc-1', category: 'other', blockKind: 'quick-connector', model: 'Pivoting blind-mate coupling', name: 'Pivoting blind-mate coupling (36 L/min, 75 psig)',
    description: 'Pivoting blind-mate coupling: 75 psig (5.17 bar) max working, 36 L/min max flow, 60 °C max fluid, spill ≤0.12 cm³ at 75 psig, max mate distance 78.5 mm.',
    liquidInterface: { connector: 'pbmc', mawpKPa: psi(75), maxFluidC: 60, ratedLpmPerPort: 36 },
    standards: [std('pbmc@1.0', 'open-spec', 'liquid', 'verified', { note: 'fit with the 21-inch rack blind-mate manifold not established' })],
    paramSources: {
      'liquidInterface.mawpKPa': V('pbmc@1.0', 'Table 6.0'),
      'liquidInterface.ratedLpmPerPort': V('pbmc@1.0', 'Table 6.0'),
      'liquidInterface.maxFluidC': V('pbmc@1.0', 'Table 6.0'),
      'meta.kwPerPairAt10K': D('pbmc@1.0', '36 L/min, PG25, ΔT 10 K'),
      'meta.fitWithRackBlindMateManifold': U('fit not established; not auto-eligible for blind-mate manifold slots'),
    },
    notes: '≈24 kW per pair at ΔT 10 K with PG25 (derived). Not auto-eligible for the 21-inch rack blind-mate manifold until fit is verified.',
    meta: { kwPerPairAt10K: round(36 * kwPerLpm('pg25', 10), 1), spillCm3: 0.12, mateDistanceMm: 78.5, fitWithRackBlindMateManifold: 'unverified', autoEligibleForBlindMateManifold: false },
  }),
];

// ───────────────────────────── manifolds / headers ─────────────────────────────

export const MANIFOLD_BLOCKS: CatalogItem[] = [
  block({
    id: 'manifold-rack-eia', category: 'other', blockKind: 'rack-manifold', model: 'Vertical rack manifold, 19-inch', name: 'Vertical rack manifold, 19-inch (44.45 mm port pitch)',
    description: 'Vertical supply/return rack manifold for 19-inch racks: 44.45 mm port pitch, hand-mate or blind-mate UQD ports, burst ≥3 × MAWP, velocity <1.5 m/s, 17–65 °C, SS304/316 or copper.',
    liquidInterface: { connector: 'uqd', portPitch: 'U', mawpKPa: psi(100), maxFluidC: 65, maxVelocityMs: 1.5 },
    cost: { capexUSD: 2_500, installHours: 3, leadTimeWeeks: 8 },
    standards: [std('rack-manifold-wp@2023', 'open-spec', 'liquid', 'verified', { note: 'white paper (non-normative)' }), std('uqd@1.0', 'open-spec', 'liquid', 'verified')],
    paramSources: {
      'liquidInterface.maxVelocityMs': V('rack-manifold-wp@2023'),
      'liquidInterface.maxFluidC': V('rack-manifold-wp@2023', undefined, '17–65 °C'),
      'liquidInterface.mawpKPa': E('connector-limited (UQD 100 psi); the white paper sets burst ≥3 × MAWP rather than a MAWP'),
      'cost.capexUSD': E('price assumption'),
    },
    notes: 'The white paper recommends a deep (~1200 mm) rack for manifold space. Price is an estimate.',
    meta: { burstFactor: 3, minFluidC: 17, materials: 'SS304/316 or copper' },
  }),
  block({
    id: 'manifold-rack-orv3-bm', category: 'other', blockKind: 'rack-manifold', model: 'Blind-mate rack manifold, 21-inch', name: 'Blind-mate rack manifold, 21-inch OU (48 mm port pitch)',
    description: 'Blind-mate rack manifold for 21-inch OU racks: 48 mm port pitch, blind-mate quick connector ports, 50 psig, 60 °C, branch flow spread ≤5 % (recommended), branch ΔP ≈1–2 psi, 1-inch large quick connector inlet top or bottom; supply right / return left seen from the rear.',
    liquidInterface: { connector: 'bmqc', portPitch: 'OU', mawpKPa: psi(50), maxFluidC: 60, maxFlowSpreadPct: 5 },
    cost: { capexUSD: 4_000, installHours: 3, leadTimeWeeks: 10 },
    standards: [std('orv3-bm-manifold@1.0', 'open-spec', 'liquid', 'verified', { note: 'revision table says initial draft; acceptance not confirmed' }), std('orv3-bmqc@1.0', 'open-spec', 'liquid', 'verified')],
    paramSources: {
      'liquidInterface.mawpKPa': V('orv3-bm-manifold@1.0'),
      'liquidInterface.maxFluidC': V('orv3-bm-manifold@1.0'),
      'liquidInterface.maxFlowSpreadPct': V('orv3-bm-manifold@1.0', undefined, 'recommended'),
      'meta.branchDpPsi': V('orv3-bm-manifold@1.0'),
      'cost.capexUSD': E('price assumption'),
    },
    notes: 'A CDU with ≥40 psi in-row head plus static fill can exceed the 50 psig limit at the manifold (CL-05 warning expected without pressure reduction). Price is an estimate.',
    meta: { branchDpPsi: [1, 2], inlet: '1-inch large quick connector, top or bottom', crossBraceDefaultOU: 23 },
  }),
  block({
    id: 'manifold-wall-dn100', category: 'other', blockKind: 'row-header', model: 'Row / wall liquid header, ≥ 4-inch', name: 'Row / wall liquid header (≥ 4-inch, 130 psi)',
    description: 'Facility-side row or wall header: ≥4-inch inner diameter, ~3 m segments to ≥30 m runs, 15–55 °C, 130 psi, supply–return ΔP 80–90 psi, drip tray and leak detection.',
    liquidInterface: { connector: 'vendor', branchDN: 100, mawpKPa: psi(130), maxFluidC: 55 },
    cost: { capexUSD: 1_800, installHours: 6, leadTimeWeeks: 12 },
    standards: [std('deschutes@0.80.0', 'open-spec', 'liquid', 'verified', { note: 'facility specification draft; acceptance unverified' })],
    paramSources: {
      'liquidInterface.mawpKPa': V('deschutes@0.80.0', '§23.2'),
      'liquidInterface.maxFluidC': V('deschutes@0.80.0', '§23.2', '15–55 °C'),
      'liquidInterface.branchDN': V('deschutes@0.80.0', '§23.2', '≥4-inch ID'),
      'meta.supplyReturnDpPsi': V('deschutes@0.80.0', '§23.2'),
      'cost.capexUSD': E('price per metre assumption'),
    },
    notes: 'Price is per metre (estimate). Paired with 50 psig rack parts it needs row pressure reduction (CL-05).',
    meta: { costBasis: 'per metre', segmentM: 3, minRunM: 30, supplyReturnDpPsi: [80, 90], minFluidC: 15, dripTray: true, leakDetection: true },
  }),
];

/** TCS pipe capacity bands at ΔT 10 K, PG25, ≈2.3 m/s (Modular TCS white paper); scale linearly with ΔT (CL-08). */
export const TCS_PIPE_BANDS = {
  standardId: 'modular-tcs-wp@dlm1',
  verification: 'verified' as const,
  deltaTK: 10,
  velocityMs: 2.3,
  designTempC: [20, 70] as [number, number],
  filtrationUm: 25,
  bands: [
    { dn: 25, scope: 'rack branch', kw: [55, 60] as [number, number] },
    { dn: 50, scope: 'rack branch', kw: [215, 220] as [number, number] },
    { dn: 100, scope: 'loop', kw: [840, 840] as [number, number] },
    { dn: 150, scope: 'loop', kw: [1872, 1872] as [number, number] },
  ],
  /** capacity (kW, lower bound) of a DN at design ΔT */
  capacityKW(dn: number, deltaTK: number): number | undefined {
    const b = this.bands.find((x) => x.dn === dn);
    return b ? (b.kw[0] * deltaTK) / this.deltaTK : undefined;
  },
};

// ───────────────────────────── CDUs, pump units, door HX ─────────────────────────────

const rowCdu = (kw: number, dims: { w: number; d: number; h: number }, weightKg: number, capexUSD: number) =>
  block({
    id: `cdu-row-l2l-${kw}`, category: 'cdu', model: `Row liquid-to-liquid CDU class, ${kw} kW`, name: `Row CDU class, liquid-to-liquid (${kw} kW at 5 K approach)`,
    description: `Generic row liquid-to-liquid CDU class rated ${kw} kW at an approach of 5 °C (TCS supply − FWS supply) with TCS and FWS flow at 1.5 L/min per kW (${round(kw * 1.5, 0)} L/min), TCS head ≥40 psi (in-row), FWS pressure drop ≤75 psi; water on the FWS, PG on the TCS; N+1 pumps.`,
    dims, weightKg, clearance: { front: 1.0, rear: 0.9, sides: 0 },
    power: { nameplateKW: round(kw * 0.012, 1), typicalKW: round(kw * 0.008, 1), idleKW: round(kw * 0.003, 1), peakKW: round(kw * 0.012, 1), feeds: 2, voltageV: 415 },
    capacity: { coolingKW: kw, liquidFlowLpm: round(kw * 1.5, 0) },
    cost: { capexUSD, installHours: 40 + kw / 20, leadTimeWeeks: 20 },
    source: 'estimate',
    cdu: {
      class: 'row-l2l', ratedKW: kw, ratedApproachK: 5, tcsLpmPerKW: 1.5, availableDpKPa: psi(40), parasiticKW: round(kw * 0.012, 1), pumpRedundancy: 'N+1', filtrationUm: 50, dualFeed: true,
      mgmtProfile: 'OCPCoolantDistributionUnit.v1_0_0',
      ratingBasis: { convention: 'l-lcdu-wp-r1', approachK: 5, lpmPerKW: 1.5, tcsHeadPsi: 40, fwsDpPsi: 75 },
    },
    liquidInterface: { connector: 'vendor', mawpKPa: psi(100), maxFluidC: 65 },
    mgmtProfiles: ['OCPCoolantDistributionUnit.v1_0_0'],
    standards: [std('l-lcdu-wp@1.0', 'open-spec', 'liquid', 'verified', { note: 'rating convention (white paper, non-normative)' }), std('cold-plate-loop-reqs@2', 'open-spec', 'liquid', 'verified')],
    paramSources: {
      'cdu.ratingBasis': V('l-lcdu-wp@1.0', '§3.3.2.4', 'ATD 5 °C at 1.5 L/min per kW; head ≥40 psi in-row / ≥25 psi in-rack; FWS ≤75 psi'),
      'cdu.filtrationUm': V('l-lcdu-wp@1.0', undefined, '≤200 µm primary / ≤50 µm secondary'),
      'cdu.pumpRedundancy': V('l-lcdu-wp@1.0', undefined, 'N+1 or more'),
      'liquidInterface.mawpKPa': V('l-lcdu-wp@1.0', undefined, 'TCS design pressure up to 100 psi'),
      'liquidInterface.maxFluidC': V('l-lcdu-wp@1.0', undefined, 'operating 17–65 °C'),
      'meta.tcsPressureKPa': V('cold-plate-loop-reqs@2', 'Tables 9, 12', 'typical'),
      'capacity.coolingKW': E('class size'),
      dims: E('class footprint'), weightKg: E('wet mass'), power: E('parasitic ≈1.2 % of rating'), 'cost.capexUSD': E('price assumption'), 'cdu.dualFeed': E('assumed'),
    },
    notes: 'Class size, footprint, mass, parasitic power (≈1.2 %) and price are estimates. Sized only against units on the same rating basis (vendor 4 K ratings are labelled separately).',
    meta: { ratings: [{ coolingKW: kw, atdC: 5, flowLpm: round(kw * 1.5, 0), headPsi: 40, note: 'row CDU rating convention (5 K, 1.5 L/min per kW)' }], tcsPressureKPa: [140, 450], operatingC: [17, 65], primaryFilterUm: 200, inRackHeadPsi: 25 },
  });

export const CDU_BLOCKS: CatalogItem[] = [
  rowCdu(350, { w: 0.6, d: 1.2, h: 2.0 }, 700, 90_000),
  rowCdu(700, { w: 0.8, d: 1.2, h: 2.2 }, 1_100, 160_000),
  rowCdu(1400, { w: 1.2, d: 1.2, h: 2.3 }, 1_900, 260_000),
  block({
    id: 'cdu-facility-2mw', category: 'cdu', model: 'Facility CDU envelope, 2 MW', name: 'Facility CDU class (2,000 kW at 3 K approach)',
    description: 'Facility-scale CDU envelope: 2000 kW, 500 GPM (≈1893 L/min), approach 3 °C, IT-side available ΔP 80–90 psi, 18–55 °C, 0–130 psig, N+1 pumps, 0.2 µm side-stream filtration, 74 kW parasitic, 380–416 VAC dual feed, Modbus/TCP. No part numbers or brands.',
    dims: { w: 1.651, d: 1.199, h: 2.365 }, weightKg: 3134, clearance: { front: 1.2, rear: 0.9, sides: 0 },
    power: { nameplateKW: 74, typicalKW: 55, idleKW: 15, peakKW: 74, feeds: 2, voltageV: 400 },
    capacity: { coolingKW: 2000, liquidFlowLpm: 1893 },
    cost: { capexUSD: 260_000, installHours: 100, leadTimeWeeks: 26 },
    cdu: {
      class: 'facility', ratedKW: 2000, ratedApproachK: 3, tcsLpmPerKW: 0.95, availableDpKPa: psi(80), parasiticKW: 74, pumpRedundancy: 'N+1', filtrationUm: 0.2, dualFeed: true, mgmtProfile: 'Modbus/TCP',
      ratingBasis: { convention: 'vendor', approachK: 3, lpmPerKW: 0.95 },
    },
    liquidInterface: { connector: 'vendor', mawpKPa: psi(130), maxFluidC: 55 },
    standards: [std('deschutes@0.80.0', 'open-spec', 'liquid', 'verified', { note: 'facility specification draft; acceptance unverified' })],
    paramSources: {
      'capacity.coolingKW': V('deschutes@0.80.0', '§3'),
      'capacity.liquidFlowLpm': D('deschutes@0.80.0', '500 GPM × 3.785'),
      'cdu.ratedApproachK': V('deschutes@0.80.0', '§3', 'vendor-style 3 K basis (not the 5 K row convention)'),
      'cdu.availableDpKPa': V('deschutes@0.80.0', '§3', '80–90 psi IT side; lower bound used'),
      'cdu.tcsLpmPerKW': D('deschutes@0.80.0', '1893 L/min ÷ 2000 kW'),
      'liquidInterface.mawpKPa': V('deschutes@0.80.0', '§3', '0–130 psig'),
      'liquidInterface.maxFluidC': V('deschutes@0.80.0', '§3', '18–55 °C'),
      'power.nameplateKW': V('deschutes@0.80.0', '§3', 'parasitic ≈3.7 % (derived)'),
      dims: V('deschutes@0.80.0', '§3', '65 × 93.1 × 47.2 in; orientation W × H × D assumed'),
      weightKg: V('deschutes@0.80.0', '§3', 'wet'),
      'power.typicalKW': E('typical / idle draw'), 'cost.capexUSD': E('price assumption'),
    },
    notes: 'Incompatible as-is with 50 psig blind-mate rack manifolds and connectors (80–90 psi IT-side ΔP): needs row pressure reduction or a different rack interface (CL-05). Typical/idle power and price are estimates; dimension orientation assumed.',
    meta: { ratings: [{ coolingKW: 2000, atdC: 3, flowLpm: 1893, headPsi: 80, note: 'facility CDU envelope; IT-side available ΔP 80–90 psi' }], supplyC: [18, 55], maxPressurePsig: 130, sideStreamFiltrationUm: 0.2 },
  }),
  block({
    id: 'cdu-inrack-rpu', category: 'other', blockKind: 'rack-pump-unit', model: 'In-rack reservoir and pumping unit', name: 'In-rack reservoir and pumping unit (4 RU, 20–50 L/min)',
    description: 'In-rack pump / reservoir hub for air-assisted liquid cooling: 4 RU 19-inch (≤175.3 mm high, ≤820 mm long), 20–50 L/min PG25, N+1 hot-swap pumps, ≤2 % of rack power at 50 L/min, 48 V (46–52 V) or 230 VAC input, Redfish. No heat exchanger — pairs with a door heat exchanger or sidecar.',
    dims: { w: 0.483, d: 0.82, h: 0.1753 }, weightKg: 45, cost: { capexUSD: 9_000, installHours: 4, leadTimeWeeks: 12 },
    standards: [std('rpu@1.0', 'open-spec', 'liquid', 'verified')],
    paramSources: {
      dims: V('rpu@1.0', undefined, '≤175.3 mm high, ≤820 mm long'),
      'meta.flowLpm': V('rpu@1.0'),
      'meta.maxParasiticPctOfRack': V('rpu@1.0', undefined, 'at 50 L/min; total air-assisted parasitic ≤5 %'),
      'meta.heatTransportKWAt10K': D('rpu@1.0', '50 L/min × PG25 × 10 K'),
      weightKg: E('wet'), 'cost.capexUSD': E('price assumption'),
    },
    notes: 'No heat exchanger: heat leaves through a door HX or sidecar. ≈33 kW of heat transport at 50 L/min and ΔT 10 K with PG25 (derived). Mass and price are estimates.',
    meta: { flowLpm: [20, 50], maxParasiticPctOfRack: 2, maxAalcParasiticPct: 5, heatTransportKWAt10K: round(50 * kwPerLpm('pg25', 10), 1), pumpRedundancy: 'N+1', inputV: '48 V (46–52 V) or 230 VAC' },
  }),
  block({
    id: 'rdhx-door-orv3', category: 'other', blockKind: 'door-hx', model: 'Rack door heat exchanger, 21-inch', name: 'Rack door heat exchanger, 21-inch OU rack (active)',
    description: 'Rack-mounted door heat exchanger: depth ≤305 mm, ≤150 kg wet, ≥1200 mm aisle to open, supply ≥16 °C, rated at 16 °C water with 45 → 30 °C air, coolant ΔP ≤100 kPa, passive air ΔP ≤15 Pa, active fan power ≤2 % with N+1 fans, nominal ≤600 kPa.',
    dims: { w: 0.6, d: 0.305, h: 2.286 }, weightKg: 150, cost: { capexUSD: 14_000, installHours: 6, leadTimeWeeks: 12 },
    doorHx: { ratedKW: 30, ratingPoint: { waterC: 16, airInC: 45, airOutC: 30 }, depthMm: 305, massKg: 150, coolantDpKPa: 100, minSupplyC: 16, active: true, fanRedundancy: 'N+1', aisleOpenMm: 1200 },
    standards: [std('door-hx-reqs@1.0', 'open-spec', 'air', 'verified', { note: 'facts and numbers only' }), std('door-hx-wp@2023', 'open-spec', 'air', 'estimate', { note: 'example rack load' })],
    paramSources: {
      'doorHx.ratingPoint': V('door-hx-reqs@1.0'),
      'doorHx.depthMm': V('door-hx-reqs@1.0'),
      'doorHx.massKg': V('door-hx-reqs@1.0', undefined, 'wet'),
      'doorHx.coolantDpKPa': V('door-hx-reqs@1.0'),
      'doorHx.minSupplyC': V('door-hx-reqs@1.0'),
      'doorHx.aisleOpenMm': V('door-hx-reqs@1.0'),
      'doorHx.fanRedundancy': V('door-hx-reqs@1.0'),
      'doorHx.ratedKW': E('rated kW per unit; the white paper uses a 30 kW rack as an example'),
      'cost.capexUSD': E('price assumption'),
    },
    notes: 'Rated kW per unit and price are estimates. CL-11: FWS / secondary supply ≥16 °C, aisle ≥1200 mm, coolant ΔP ≤100 kPa, depth added to the row pitch.',
    meta: { passiveAirDpPa: 15, activePowerPctMax: 2, nominalPressureKPa: 600 },
  }),
  block({
    id: 'rdhx-floor-anchored', category: 'other', blockKind: 'door-hx', model: 'Floor-anchored rear-door heat exchanger', name: 'Floor-anchored rear-door heat exchanger (716 mm wide)',
    description: 'Floor-anchored rear-door heat exchanger: 716 W × 2398 H × 332 D mm, ≥94.8 mm gap to the rack.',
    dims: { w: 0.716, d: 0.332, h: 2.398 }, weightKg: 180, cost: { capexUSD: 15_000, installHours: 8, leadTimeWeeks: 14 },
    standards: [std('deschutes@0.80.0', 'open-spec', 'air', 'verified', { note: 'facility specification draft' })],
    paramSources: { dims: V('deschutes@0.80.0', '§18'), 'meta.gapToRackMm': V('deschutes@0.80.0', '§18'), weightKg: E('wet'), 'cost.capexUSD': E('price assumption') },
    notes: 'Rated kW is not stated (instance value). Mass and price are estimates.',
    meta: { gapToRackMm: 94.8 },
  }),
];

// ───────────────────────────── air handlers and UPS (generic classes, NEW ids) ─────────────────────────────

const airflowFor = (kw: number) => round(kw / (1.2 * 1.005 * 12), 2);
const facilityNote = 'no open air-handler specification exists; the class is sized against the facility assessment air-side attributes (IT ΔT ≥12 K optimum, ASHRAE inlet classes)';

const crah = (kw: number, dims: { w: number; d: number; h: number }, weightKg: number, capexUSD: number) =>
  block({
    id: `crah-generic-${kw}`, category: 'crah', model: `Chilled-water air handler class, ${kw} kW`, name: `Chilled-water air handler class (${kw} kW)`,
    description: `Generic chilled-water computer-room air handler class, ${kw} kW sensible at 12 K air ΔT (≈${airflowFor(kw)} m³/s), EC fans.`,
    dims, weightKg, clearance: { front: 1.0, rear: 0.2, sides: 0 },
    power: { nameplateKW: round(kw * 0.035, 1), typicalKW: round(kw * 0.024, 1), idleKW: round(kw * 0.008, 1), peakKW: round(kw * 0.035, 1), feeds: 1, voltageV: 480 },
    capacity: { coolingKW: kw, airflowM3s: airflowFor(kw) },
    cost: { capexUSD, installHours: 40 + kw / 10, leadTimeWeeks: 14 },
    source: 'estimate',
    standards: [std('facility-v1@1.5', 'open-spec', 'facility', 'estimate', { note: facilityNote })],
    paramSources: {
      'capacity.airflowM3s': D('facility-v1@1.5', 'kW ÷ (1.2 kg/m³ × 1.005 kJ/kg·K × 12 K); 12 K = IT temperature rise optimum (2.2-I)'),
      'capacity.coolingKW': E('class size'), dims: E('class footprint'), weightKg: E('operating mass'), power: E('fan power ≈3.5 % of cooling'), 'cost.capexUSD': E('price assumption'),
    },
    notes: `Generic class for new-project fallbacks (vendor air handlers keep their own ids and values). Capacity, footprint, mass, fan power and price are estimates; ${facilityNote}.`,
  });

const fanWall = (kw: number, w: number, weightKg: number, capexUSD: number) =>
  block({
    id: `fanwall-generic-${kw}`, category: 'fan-wall', model: `Fan-wall air handler class, ${kw} kW`, name: `Fan-wall air handler class, chilled water (${kw} kW)`,
    description: `Generic fan-wall chilled-water air handler class in the wall between the hall and a mechanical gallery: ${kw} kW at 12 K air ΔT (≈${airflowFor(kw)} m³/s), EC fan array, serviced from the gallery.`,
    dims: { w, d: 1.5, h: 3.0 }, weightKg, clearance: { front: 1.5, rear: 1.0, sides: 0.1 },
    power: { nameplateKW: round(kw * 0.04, 1), typicalKW: round(kw * 0.023, 1), idleKW: round(kw * 0.005, 1), peakKW: round(kw * 0.04, 1), feeds: 1, voltageV: 480 },
    capacity: { coolingKW: kw, airflowM3s: airflowFor(kw) },
    cost: { capexUSD, installHours: 48 + kw / 12, leadTimeWeeks: 20 },
    source: 'estimate',
    standards: [std('facility-v1@1.5', 'open-spec', 'facility', 'estimate', { note: facilityNote })],
    paramSources: {
      'capacity.airflowM3s': D('facility-v1@1.5', 'kW ÷ (1.2 × 1.005 × 12 K)'),
      'capacity.coolingKW': E('class size'), dims: E('class footprint'), weightKg: E('operating mass'), power: E('fan power ≈4 % of cooling'), 'cost.capexUSD': E('price assumption'),
    },
    notes: `Generic class for new-project fallbacks (the vendor fan wall keeps its id and values). Capacity, footprint, mass, fan power and price are estimates; ${facilityNote}.`,
  });

const inRow = (kw: number, w: number, weightKg: number, capexUSD: number) =>
  block({
    id: `crah-inrow-generic-${kw}`, category: 'crah', model: `In-row air unit class, ${kw} kW`, name: `In-row chilled-water air unit class (${kw} kW, ${w * 1000} mm wide)`,
    description: `Generic in-row chilled-water cooler class that fits a rack position: ${w * 1000} × 1200 × 2000 mm, ${kw} kW at 12 K air ΔT (≈${airflowFor(kw)} m³/s). Lower than the overhead services, unlike a room air handler.`,
    dims: { w, d: 1.2, h: 2.0 }, weightKg, clearance: { front: 1.2, rear: 0.9, sides: 0 },
    power: { nameplateKW: round(kw * 0.05, 2), typicalKW: round(kw * 0.03, 2), idleKW: round(kw * 0.01, 2), peakKW: round(kw * 0.05, 2), feeds: 2, voltageV: 415 },
    capacity: { coolingKW: kw, airflowM3s: airflowFor(kw) },
    cost: { capexUSD, installHours: 16, leadTimeWeeks: 12 },
    source: 'estimate',
    standards: [std('facility-v1@1.5', 'open-spec', 'facility', 'estimate', { note: facilityNote })],
    paramSources: {
      'capacity.airflowM3s': D('facility-v1@1.5', 'kW ÷ (1.2 × 1.005 × 12 K)'),
      'capacity.coolingKW': E('class size'), dims: E('rack-position footprint, 2.0 m high'), weightKg: E('operating mass'), power: E('fan power ≈5 % of cooling'), 'cost.capexUSD': E('price assumption'),
    },
    notes: `Generic in-row class (backlog: row placement used a 3.4 m room air handler). Not tagged for the cooling topology comparison, so existing comparison rows do not change; row placement selects it by id. Capacity, footprint, mass, fan power and price are estimates; ${facilityNote}.`,
    meta: { placement: 'in-row' },
  });

const ups = (kw: number, dims: { w: number; d: number; h: number }, weightKg: number, capexUSD: number) =>
  block({
    id: `ups-generic-${kw}`, category: 'ups', model: `Double-conversion UPS class, ${kw} kW`, name: `Double-conversion UPS class (${kw} kVA / ${kw} kW)`,
    description: `Generic transformer-free double-conversion UPS line-up class, ${kw} kVA at unity power factor, ≈97 % efficiency, Li-ion battery cabinets separate.`,
    dims, weightKg, clearance: { front: 1.2, rear: 0.1, sides: 0 },
    capacity: { powerKVA: kw, powerKW: kw, inputVoltageV: 480, outputVoltageV: 480 },
    cost: { capexUSD, installHours: 40 + kw / 15, leadTimeWeeks: 24 },
    source: 'estimate',
    standards: [std('facility-v1@1.5', 'open-spec', 'facility', 'estimate', { note: 'upstream UPS feed attribute (2.1-G); no open UPS specification' })],
    paramSources: { 'capacity.powerKVA': E('class size'), dims: E('line-up footprint'), weightKg: E('without batteries'), 'meta.efficiencyPct': E('double-conversion class'), 'cost.capexUSD': E('price assumption') },
    notes: 'Generic class for new-project fallbacks (vendor UPS items keep their ids and values). All values are estimates.',
    meta: { efficiencyPct: 97 },
  });

export const AIR_UPS_BLOCKS: CatalogItem[] = [
  crah(100, { w: 2.5, d: 0.9, h: 1.9 }, 750, 42_000),
  crah(250, { w: 3.1, d: 1.1, h: 2.4 }, 1_250, 88_000),
  crah(400, { w: 3.1, d: 1.2, h: 2.4 }, 1_700, 128_000),
  fanWall(300, 2.0, 1_400, 88_000),
  fanWall(600, 3.6, 2_600, 165_000),
  inRow(30, 0.3, 160, 14_000),
  inRow(60, 0.6, 280, 22_000),
  ups(500, { w: 1.6, d: 0.9, h: 1.95 }, 1_500, 190_000),
  ups(1200, { w: 3.2, d: 1.0, h: 1.95 }, 3_200, 420_000),
];

// ───────────────────────────── coolant descriptors and class tables (data) ─────────────────────────────

export const COOLANT_DESCRIPTORS = [
  {
    id: 'fluid-pg25', fluid: 'pg25' as const, rho: 1.02, cp: 3.95,
    limits: [
      { key: 'glycol-vol-pct', range: [24.5, 29.5], standardId: 'pg25-guideline@2022', verification: 'verified' },
      { key: 'glycol-vol-pct', range: [24.5, 27.5], standardId: 'pg25-base@1.0.0', verification: 'verified', note: 'headline value; full pass pending' },
      { key: 'ph', range: [8.0, 10.5], standardId: 'pg25-guideline@2022', verification: 'verified' },
      { key: 'typical-max-c', value: 49, standardId: 'pg25-guideline@2022', verification: 'verified' },
      { key: 'max-c', value: 66, standardId: 'pg25-guideline@2022', verification: 'verified' },
      { key: 'side-stream-filtration-um', value: 5, note: 'on 10 % of flow', standardId: 'pg25-guideline@2022', verification: 'verified' },
      { key: 'product-final-filtration-um', value: 50, standardId: 'pg25-base@1.0.0', verification: 'verified' },
    ],
    note: 'ρ and cp are planning values (derived); PG25 needs ≈3–5 % more flow than water for the same heat (derived).',
  },
  {
    id: 'fluid-treated-water', fluid: 'treated-water' as const, rho: 0.997, cp: 4.18,
    limits: [
      { key: 'conductivity-us-cm-max', value: 1500, standardId: 'water-coolant-guideline@2022', verification: 'verified' },
      { key: 'conductivity-us-cm-max', value: 2000, standardId: 'water-coolant-base@1.3', verification: 'verified', note: 'headline value; full pass pending' },
      { key: 'ph', range: [8.0, 10.5], standardId: 'water-coolant-base@1.3', verification: 'verified' },
      { key: 'turbidity-ntu-max', value: 5, standardId: 'water-coolant-base@1.3', verification: 'verified' },
    ],
    note: 'Record which document each limit comes from; the guideline and the base specification differ.',
  },
] as const;

/** ITE cooling class → liquid fraction (derived from 65–75 / 75–85 / ~100 %; Cold Plate Loop Requirements Rev 2 §3). */
export const ITE_COOLING_CLASS_LIQUID_FRACTION = { standardId: 'cold-plate-loop-reqs@2', verification: 'derived' as const, classes: { 'hybrid-basic': 0.7, 'hybrid-intermediate': 0.8, 'full-liquid': 0.97 } };

/** Facility water supply classes (ASHRAE TC9.9, as cited in cooling guidance): nominal max supply °C; W+ = above 45 °C. */
export const FWS_CLASS_SUPPLY_C = { standardId: 'ashrae-tc99-liquid@cited', verification: 'verified' as const, classes: { W17: 17, W27: 27, W32: 32, W40: 40, W45: 45, 'W+': 45 } };

export const STD_COOLING_CATALOG: CatalogItem[] = [...QUICK_CONNECTOR_BLOCKS, ...MANIFOLD_BLOCKS, ...CDU_BLOCKS, ...AIR_UPS_BLOCKS];
