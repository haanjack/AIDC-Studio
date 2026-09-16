import type { RackModel } from '../compose.ts';
import { NEUTRAL_REFERENCE_BASIS } from '../../standards/registry.ts';
import { D, E, std, U, V } from './std-helpers.ts';

/**
 * Rack enclosures as composer rack models (stream B / P2; proposal §3.1, P0 impacts box).
 *
 * One frame implementation for the 21-inch OU racks: footprint and ratings both come from the frame implementation named in
 * `NEUTRAL_REFERENCE_BASIS.frame` (600 × 1068 mm, 44 OU, 1400 kg payload, 80 kg per IT support shelf set). Legacy ids
 * (`rack-42u-600x1200`, `rack-48u-600x1200`, `rack-orv3-44ou`, `rack-orw-44ou`) resolve through `catalog/aliases.ts`.
 * EIA racks keep their earlier planning dimensions / masses / prices, so composed seed racks keep their totals.
 */

const F = NEUTRAL_REFERENCE_BASIS.frame;

const eiaNotes = (u: number, w: number) =>
  `Generic 19-inch cabinet, ${u}U, ${w * 1000} × 1200 mm. Unit pitch 44.45 mm (the EIA-310 value as cited in the rack base specification); footprint, height, empty mass and price are planning estimates.`;

const eiaSources = {
  'formFactor.unitPitchMm': V('orv3-base@1.1', '§6.1.2', 'EIA unit pitch as cited'),
  dims: E('cabinet footprint and height'),
  weightKg: E('empty cabinet'),
  'cost.capexUSD': E('price assumption'),
};

const orv3Frame = {
  rackUnits: F.heightUnits,
  dims: { w: F.widthMm / 1000, d: F.depthMm / 1000, h: 2.286 },
  clearance: { front: 1.2, rear: 0.9, sides: 0 },
  form: 'orv3-21' as const,
};

const orv3FrameSources = {
  'formFactor.unitPitchMm': V('orv3-base@1.1', '§6.1.2', '48 mm OU; 44.45 mm RU optional'),
  'rackPower.rangeV': V('orv3-base@1.1', '§12.1', '51 V option: 46–52 V (54 V option: 52–56 V)'),
  'rackPower.itConnectorA': V('orv3-base@1.1', undefined, 'IT busbar connector'),
  dims: V(F.standardId, '§6.1', '2286 × 600 × 1068 mm nominal'),
  'formFactor.heightUnits': V(F.standardId, '§6.1', '44 OU or 47 RU'),
  'formFactor.payloadKg': V(F.standardId, '§6.2', 'excludes the frame; IT shelves, doors and panels count'),
  'formFactor.crossBraceAboveKg': V(F.standardId, '§6.2', '1-OU cross brace, default OU23'),
  'formFactor.itShelfKgPerSet': V(F.standardId, '§12.8.4', 'dynamic, per IT support shelf set'),
  'meta.busbarDatumMm': V('orv3-base@1.1', undefined, 'figure-read'),
  weightKg: E('empty frame'),
  'cost.capexUSD': E('price assumption'),
};

const orv3FrameFormFactor = {
  unitPitchMm: 48 as const,
  heightUnits: F.heightUnits,
  usableUnits: F.heightUnits,
  supportsMixedPitch: true,
  implementation: F.standardId,
  payloadKg: F.payloadKg,
  payloadExcludesFrame: F.payloadExcludesFrame,
  crossBraceAboveKg: F.crossBraceAboveKg,
  itShelfKgPerSet: F.itShelfKgPerSet,
};

const orv3FrameMeta = {
  shelfInnerWidthMm: 539.4,
  latchWidthMm: 540.4,
  busbarDatumMm: 802.6,
  itStopDatumMm: 789.0,
  hacExtensionHeightMm: 2413,
  rampDeg: 10,
  alternativeImplementation: 'orv3-frame-google@0.2: 706 × 805 (or 1219) mm, 39.5 OU; its weights are rack totals and do not apply to populated liquid-cooled racks',
};

export const RACK_MODEL_DATA: RackModel[] = [
  {
    id: 'rack-eia310-42u', vendor: 'Generic', model: '42U 600×1200', name: '19-inch rack, 42U (600 × 1200 mm)',
    dims: { w: 0.6, d: 1.2, h: 2.0 }, weightKg: 140, rackUnits: 42, clearance: { front: 1.2, rear: 0.9, sides: 0 }, form: 'eia-19',
    cost: { capexUSD: 3_500, installHours: 6, leadTimeWeeks: 6 }, source: 'estimate', notes: eiaNotes(42, 0.6),
    formFactor: { rack: 'eia-310-19', unitPitchMm: 44.45, heightUnits: 42, usableUnits: 42 },
    rackPower: { interface: 'ac-pdu', nominalV: 415, rangeV: [380, 440] },
    standards: [std('eia-310@e', 'eia', 'rack', 'estimate', { note: 'paid standard, not read; only the unit pitch is used' })],
    paramSources: { ...eiaSources, rackPower: E('AC rack PDU class; voltage from the site power profile') },
  },
  {
    id: 'rack-eia310-48u', vendor: 'Generic', model: '48U 600×1200', name: '19-inch rack, 48U (600 × 1200 mm)',
    dims: { w: 0.6, d: 1.2, h: 2.3 }, weightKg: 170, rackUnits: 48, clearance: { front: 1.2, rear: 0.9, sides: 0 }, form: 'eia-19',
    cost: { capexUSD: 4_500, installHours: 6, leadTimeWeeks: 6 }, source: 'estimate', notes: eiaNotes(48, 0.6),
    formFactor: { rack: 'eia-310-19', unitPitchMm: 44.45, heightUnits: 48, usableUnits: 48 },
    rackPower: { interface: 'ac-pdu', nominalV: 415, rangeV: [380, 440] },
    standards: [std('eia-310@e', 'eia', 'rack', 'estimate', { note: 'paid standard, not read; only the unit pitch is used' })],
    paramSources: { ...eiaSources, rackPower: E('AC rack PDU class; voltage from the site power profile') },
  },
  {
    id: 'rack-48u-800x1200', vendor: 'Generic', model: '48U 800×1200', name: '19-inch rack, 48U, wide (800 × 1200 mm) — cable-dense',
    dims: { w: 0.8, d: 1.2, h: 2.3 }, weightKg: 200, rackUnits: 48, clearance: { front: 1.2, rear: 0.9, sides: 0 }, form: 'eia-19',
    cost: { capexUSD: 5_500, installHours: 6, leadTimeWeeks: 6 }, source: 'estimate', notes: eiaNotes(48, 0.8),
    formFactor: { rack: 'eia-310-19', unitPitchMm: 44.45, heightUnits: 48, usableUnits: 48 },
    rackPower: { interface: 'ac-pdu', nominalV: 415, rangeV: [380, 440] },
    standards: [std('eia-310@e', 'eia', 'rack', 'estimate', { note: 'paid standard, not read; only the unit pitch is used' })],
    paramSources: { ...eiaSources, rackPower: E('AC rack PDU class; voltage from the site power profile') },
  },
  {
    id: 'rack-orv3', vendor: 'Generic', model: '21-inch OU rack, 44 OU', name: '21-inch OU rack (44 OU, 48 V busbar)',
    ...orv3Frame, weightKg: 220, cost: { capexUSD: 12_000, installHours: 10, leadTimeWeeks: 10 }, source: 'open-standard',
    notes: 'Frame interface per the rack base specification (48 mm OU pitch, 46–52 V IT input window, 100 A IT busbar connector; the base specification fixes no payload). Footprint and ratings from the frame implementation: 600 × 1068 × 2286 mm, 44 OU / 47 RU, payload 1400 kg excluding the frame, cross brace above 800 kg, 80 kg per IT support shelf set. Empty-frame mass and price are estimates.',
    formFactor: { rack: 'orv3', ...orv3FrameFormFactor },
    rackPower: { interface: 'dc-busbar', nominalV: 51, rangeV: [46, 52], itConnectorA: 100 },
    standards: [std('orv3-base@1.1', 'open-spec', 'rack', 'verified'), std(F.standardId, 'open-spec', 'rack', 'verified', { note: 'frame implementation whose ratings apply' })],
    paramSources: orv3FrameSources,
    meta: { ...orv3FrameMeta },
  },
  {
    id: 'rack-orv3-hpr', vendor: 'Generic', model: '21-inch OU rack, high power, 44 OU', name: '21-inch OU rack, high power (44 OU, 50 V busbar)',
    ...orv3Frame, weightKg: 230, cost: { capexUSD: 14_000, installHours: 12, leadTimeWeeks: 12 }, source: 'open-standard',
    notes: 'Same frame interface and ratings as rack-orv3. High-power zone: three PSU + BBU shelf sets in parallel, 93.5 kW total as stated in the draft shelf document (not 3 × 33 kW), 27.5 kW per shelf at N+1, so ≤ 82.5 kW at N+1 with three shelves; power zone 3 × 1 OU PSU + 3 × 2 OU BBU = 9 OU. Draft basis: checks built on it stay warnings. Air-cooled busbar roofline ≈155 kW is a roadmap figure (unverified). Empty-frame mass and price are estimates.',
    formFactor: { rack: 'orv3-hpr', ...orv3FrameFormFactor },
    rackPower: { interface: 'dc-busbar', nominalV: 50, rangeV: [46, 52], itConnectorA: 100, busbarCooling: 'air' },
    standards: [
      std('orv3-base@1.1', 'open-spec', 'rack', 'verified'),
      std(F.standardId, 'open-spec', 'rack', 'verified', { note: 'frame implementation whose ratings apply' }),
      std('orv3-hpr-shelf-33kw@0.3', 'open-spec', 'power', 'verified', { note: 'draft document' }),
      std('orv3-hpr-bbu-shelf-33kw@0.5', 'open-spec', 'power', 'verified', { note: 'draft document' }),
    ],
    paramSources: {
      ...orv3FrameSources,
      'rackPower.nominalV': V('orv3-hpr-shelf-33kw@0.3', undefined, 'shelf output 50 V no-load / 49 V full-load'),
      'meta.powerZoneUnits': D('orv3-hpr-shelf-33kw@0.3', '3 × 1 OU PSU shelves + 3 × 2 OU BBU shelves (BBU shelf Rev 0.5)'),
      'meta.shelfSetsTotalKW': V('orv3-hpr-shelf-33kw@0.3', 'revision history', 'stated total for three shelf sets; breakdown not stated'),
      'meta.shelfKWAtNplus1': V('orv3-hpr-shelf-33kw@0.3', '§3'),
      'meta.maxRackKWAtNplus1': D('orv3-hpr-shelf-33kw@0.3', 'min(3 × 27.5 kW, 93.5 kW)'),
      'meta.airBusbarRooflineKW': U('roadmap deck (2025-05-07), not a specification'),
      weightKg: E('empty frame with busbar'),
    },
    meta: { ...orv3FrameMeta, powerZoneUnits: NEUTRAL_REFERENCE_BASIS.hprPowerZoneUnits, shelfSets: 3, shelfSetsTotalKW: 93.5, shelfKWAtNplus1: 27.5, maxRackKWAtNplus1: 82.5, airBusbarRooflineKW: 155 },
  },
  {
    id: 'rack-orw', vendor: 'Generic', model: 'Wide OU rack, 44 OU', name: 'Wide OU rack (44 OU, 1200 × 1219 mm)',
    dims: { w: 1.2, d: 1.219, h: 2.39 }, weightKg: 400, rackUnits: 44, clearance: { front: 1.2, rear: 0.9, sides: 0 }, form: 'orw-double-wide',
    cost: { capexUSD: 25_000, installHours: 16, leadTimeWeeks: 12 }, source: 'open-standard',
    notes: 'Released wide-rack base and design specifications V1.0.0: 2390 × 1200 × 1219 mm nominal, 44 OU / 47 RU, 48 V busbar datum 802.59 mm, IT input 51 V (46–52 V), payload 4700 kg minimum with allowable support bracing (excluding the frame; the unbraced rating was not evaluated), 125 kg per IT support shelf set, no casters (forklift / pallet / AGV base, M18 bolt-down), HAC seal plane 1068 mm from the front face or flush with the rear face. No busbar rating is stated. Empty-frame mass and price are estimates.',
    formFactor: { rack: 'orw', unitPitchMm: 48, heightUnits: 44, usableUnits: 44, supportsMixedPitch: true, implementation: 'orw-meta-design@1.0.0', payloadKg: 4700, payloadExcludesFrame: true, itShelfKgPerSet: 125 },
    rackPower: { interface: 'dc-busbar', nominalV: 51, rangeV: [46, 52] },
    standards: [std('orw-base@1.0.0', 'open-spec', 'rack', 'verified'), std('orw-meta-design@1.0.0', 'open-spec', 'rack', 'verified', { note: 'design specification whose ratings apply' })],
    paramSources: {
      dims: V('orw-meta-design@1.0.0', '§4.2', '2390 × 1200 × 1219 mm nominal'),
      'formFactor.heightUnits': V('orw-meta-design@1.0.0', '§4.4', '44 OU or 47 RU'),
      'formFactor.unitPitchMm': V('orw-base@1.0.0'),
      'formFactor.payloadKg': V('orw-meta-design@1.0.0', '§4.3', 'minimum with allowable support bracing; excludes the frame'),
      'formFactor.itShelfKgPerSet': V('orw-meta-design@1.0.0', undefined, 'dynamic; 78 kg static end load'),
      'rackPower.rangeV': V('orw-base@1.0.0', '§4.9'),
      'meta.busbarDatumMm': V('orw-base@1.0.0', undefined, 'drawing value'),
      'meta.hacSealPlaneMm': V('orw-meta-design@1.0.0', '§4.5.13'),
      'meta.busbarRating': V('orw-base@1.0.0', '§4.10', 'not stated; liquid-cooled busbar specification in progress'),
      weightKg: E('empty frame'),
      'cost.capexUSD': E('price assumption'),
    },
    meta: { busbarDatumMm: 802.59, innerVerticalsMm: 1094.44, casters: false, base: 'forklift / pallet / AGV base, M18 bolt-down', payloadRequiresBracing: true, hacSealPlaneMm: 1068, itShelfStaticEndLoadKg: 78, busbarRating: 'not stated' },
  },
];
