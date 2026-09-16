import type { CatalogItem } from '../../model/types.ts';
import { NEUTRAL_REFERENCE_BASIS } from '../../standards/registry.ts';
import { block, D, E, std, U, V } from './std-helpers.ts';
import { RACK_MODEL_DATA } from './std-racks.ts';

/**
 * Rack enclosures and rack power building blocks (stream B / P2; OCP-DESIGN-PROPOSAL §3.1, P0 closure log).
 * Parameters only, each with provenance; ids and names carry no organisation mark (DO-5: neutral names, citation in tooltips).
 * DO-4: HPR v1 blocks are visible with a draft chip; the HPR V2 72 kW shelf and the ±400 VDC sidecar carry
 * `meta.behindDraftsToggle` and stay hidden unless the profile includes draft specs.
 */

/** Rack enclosures (non-floor blocks; composed racks inherit their form factor and standards). */
export const RACK_ENCLOSURE_BLOCKS: CatalogItem[] = RACK_MODEL_DATA.map((r) =>
  block({
    id: r.id, category: 'other', blockKind: 'rack-enclosure', vendor: r.vendor, model: r.model, name: r.name,
    description: r.notes ?? r.name, notes: r.notes ?? '', dims: { ...r.dims }, weightKg: r.weightKg, clearance: { ...r.clearance },
    rackUnits: r.rackUnits, cost: { ...r.cost }, source: r.source,
    ...(r.formFactor ? { formFactor: r.formFactor } : {}), ...(r.rackPower ? { rackPower: r.rackPower } : {}),
    standards: r.standards ?? [], paramSources: r.paramSources ?? {},
    meta: { rackForm: r.form, ...(r.meta ?? {}) },
  }),
);

const BBU = NEUTRAL_REFERENCE_BASIS.bbu;

export const RACK_POWER_BLOCKS: CatalogItem[] = [
  block({
    id: 'pshelf-orv3-18kw', category: 'other', blockKind: 'power-shelf', model: '48 V power shelf, 6 × 3 kW', name: 'Rack power shelf, 48 V, 18 kW (15 kW at N+1)',
    description: '1-OU class DC power shelf for the 48 V rack busbar: six 3 kW PSUs, 18 kW nominal / 15 kW with one PSU redundant, 51 V PSU output.',
    dims: { w: 0.537, d: 0.79, h: 0.048 }, weightKg: 18, cost: { capexUSD: 6_000, installHours: 1, leadTimeWeeks: 10 },
    powerShelf: {
      heightOU: 1, slots: 6, psuKW: 3, redundancy: 'N+1', shelfKW: 18, ratedKWAtRedundancy: 15, outputV: [51, 47.5],
      outputConnector: { stillAirA: 360, airflowA: 500, airflowLFM: 300, ambientC: 45, spec: 'orv3-output-connector@2.0' },
      acInputs: { count: 1, V: 400, A: 32, plug: 'universal 7-pin inlet; whip IEC 60309 230/400 V 32 A or L22-20P 277/480 V 20 A' },
      busbarInterface: 'orv3-clip',
    },
    standards: [
      std('orv3-psu-48v@1.0', 'open-spec', 'power', 'verified'),
      std('orv3-bbu-shelf@1.1', 'open-spec', 'power', 'verified', { note: 'shelf rating basis (379.2 A, 15 kW discharge)' }),
      std('orv3-output-connector@2.0', 'open-spec', 'power', 'verified'),
      std('orv3-shelf-input-connector@1.0', 'open-spec', 'power', 'verified'),
      std('orv3-ac-whip@1.0', 'open-spec', 'power', 'verified'),
    ],
    paramSources: {
      'powerShelf.shelfKW': D('orv3-bbu-shelf@1.1', '379.2 A × 47.5 V ≈ 18 kW; "15 kW to 18 kW" in the revision history'),
      'powerShelf.ratedKWAtRedundancy': V('orv3-bbu-shelf@1.1', 'revision history'),
      'powerShelf.psuKW': V('orv3-psu-48v@1.0'),
      'powerShelf.outputV': U('51 V PSU set point (verified); 47.5 V full-load value taken from the BBU module output at 100 % load'),
      'powerShelf.outputConnector.stillAirA': V('orv3-output-connector@2.0', '§3'),
      'powerShelf.outputConnector.airflowA': V('orv3-output-connector@2.0', '§3', '500 A at 300 LFM, 45 °C'),
      'powerShelf.acInputs.A': V('orv3-shelf-input-connector@1.0', undefined, '32 A at 30 °C rise, 480 VAC pin-to-pin / 380 VDC'),
      'powerShelf.acInputs.plug': V('orv3-ac-whip@1.0'),
      'powerShelf.acInputs.count': U('input count not confirmed'),
      'powerShelf.heightOU': U('shelf specification page not reachable (HTTP 404)'),
      dims: E('shelf outline'), weightKg: E('shelf with PSUs'), 'cost.capexUSD': E('price assumption'),
    },
    notes: 'At 18 kW and 47.5 V the shelf draws ≈379 A, above the 360 A still-air connector rating; the 500 A rating needs ≥300 LFM airflow (derived). PSU peak efficiency >97.5 % (verified).',
    meta: { psuPeakEfficiency: 0.975, fullLoadCurrentA: 379.2 },
  }),
  block({
    id: 'pshelf-orv3-hpr-33kw', category: 'other', blockKind: 'power-shelf', model: 'High-power shelf, 6 × 5.5 kW', name: 'Rack power shelf, high power, 33 kW (27.5 kW at N+1)',
    description: '1 OU DC power shelf for the 50 V high-power rack busbar: six 5.5 kW PSUs, 33 kW at 6+0 / 27.5 kW at N+1, 700 A output clip, two AC inputs.',
    dims: { w: 0.537, d: 0.7887, h: 0.046 }, weightKg: 22, cost: { capexUSD: 9_000, installHours: 1, leadTimeWeeks: 12 },
    powerShelf: {
      heightOU: 1, slots: 6, psuKW: 5.5, redundancy: 'N+1', shelfKW: 33, ratedKWAtRedundancy: 27.5, outputV: [50, 49],
      outputConnector: { stillAirA: 700, spec: 'orv3-hpr-shelf-33kw@0.3' },
      acInputs: { count: 2, V: 400, A: 32, plug: 'IEC 60309 32 A or L22-30P 30 A (NEC)' },
      availableFaultKA: 25, parallelMax: 3, busbarInterface: 'hpr-v1-clip',
    },
    standards: [
      std('orv3-hpr-shelf-33kw@0.3', 'open-spec', 'power', 'verified', { note: 'draft document' }),
      std('hpr-psu-5.5kw@0.4', 'open-spec', 'power', 'verified', { note: 'draft document' }),
      std('hpr-ac-whip@0.1', 'open-spec', 'power', 'verified', { note: 'draft document' }),
    ],
    paramSources: {
      'powerShelf.ratedKWAtRedundancy': V('orv3-hpr-shelf-33kw@0.3', '§3'),
      'powerShelf.shelfKW': V('orv3-hpr-shelf-33kw@0.3', '§3', '6+0'),
      'powerShelf.outputV': V('hpr-psu-5.5kw@0.4', undefined, '50 V no-load / 49 V full-load'),
      'powerShelf.outputConnector.stillAirA': V('orv3-hpr-shelf-33kw@0.3'),
      'powerShelf.acInputs': V('hpr-ac-whip@0.1'),
      'powerShelf.availableFaultKA': V('orv3-hpr-shelf-33kw@0.3', '§4.1.1', 'available short-circuit current at the facility protection, not a shelf SCCR'),
      'powerShelf.parallelMax': V('orv3-hpr-shelf-33kw@0.3', 'revision history', 'three shelf sets in parallel: 93.5 kW total as stated'),
      dims: V('orv3-hpr-shelf-33kw@0.3', undefined, '537 × 46 × 788.7 mm'),
      weightKg: E('shelf with PSUs'), 'cost.capexUSD': E('price assumption'),
    },
    notes: 'Draft document (Rev 0.3 is still the latest revision). Three shelf sets in parallel give 93.5 kW total as stated — do not derive a per-set value. 33 kW / 49 V ≈ 673 A ≤ 700 A clip (derived). HPR v1 5.5 kW PSU ≈ 24.5 A at 230 V fits the 32 A whip (derived).',
    meta: { shelfSetsTotalKW: 93.5 },
  }),
  block({
    id: 'pshelf-hpr-v2-72kw', category: 'other', blockKind: 'power-shelf', behindDraftsToggle: true, model: 'High-power shelf V2, 6 × 12 kW', name: 'Rack power shelf V2, 72 kW (60 kW at N+1) — power-rack busbar only',
    description: '1 OU shelf of six 12 kW PSUs: 60 kW with N+1 (72 kW at 6+0, derived); bolted 2000 A output to the vertical busbar of a separate high-power power rack. Not a drop-in for the 700 A clip busbar of a high-power IT rack.',
    dims: { w: 0.537, d: 0.8675, h: 0.0462 }, weightKg: 30, cost: { capexUSD: 16_000, installHours: 2, leadTimeWeeks: 16 },
    powerShelf: {
      heightOU: 1, slots: 6, psuKW: 12, redundancy: 'N+1', shelfKW: 72, ratedKWAtRedundancy: 60, outputV: [50, 49],
      outputConnector: { stillAirA: 2000, airflowA: 2000, airflowLFM: 390, ambientC: 75, spec: 'hpr-2000a-output-connector@1.0.0' },
      acInputs: { count: 2, V: 277, A: 60, plug: 'NEC 60 A (48 A derated) or IEC 60 A; 5-pin 60 A input connector' },
      availableFaultKA: 40, parallelMax: 10, busbarInterface: 'hprv3-power-rack-bolted',
    },
    standards: [
      std('hpr-v2-shelf-72kw@1.0', 'open-spec', 'power', 'verified', { note: 'under review' }),
      std('hpr-v2-psu-12kw@1.0.0', 'open-spec', 'power', 'verified'),
      std('hpr-2000a-output-connector@1.0.0', 'open-spec', 'power', 'verified'),
      std('hpr-v2-pmm@1.0.0', 'open-spec', 'mgmt', 'verified'),
    ],
    paramSources: {
      'powerShelf.ratedKWAtRedundancy': V('hpr-v2-shelf-72kw@1.0', '§3.2'),
      'powerShelf.shelfKW': D('hpr-v2-shelf-72kw@1.0', 'document title and six 12 kW slots; not a stated output rating'),
      'powerShelf.psuKW': V('hpr-v2-psu-12kw@1.0.0', '§4.1', '12 kW at 218–305 VAC; 10 kW at 180–218 VAC'),
      'powerShelf.outputConnector': V('hpr-2000a-output-connector@1.0.0', '§3–4'),
      'powerShelf.acInputs': V('hpr-v2-shelf-72kw@1.0', '§4.1.1', 'one §3.2 heading says 63 A IEC (source inconsistency)'),
      'powerShelf.availableFaultKA': V('hpr-v2-shelf-72kw@1.0', '§4.1.1'),
      'powerShelf.parallelMax': V('hpr-v2-shelf-72kw@1.0', '§4.7', 'at least 10 shelves in parallel'),
      'meta.psuInputA': V('hpr-v2-psu-12kw@1.0.0', '§4.6'),
      dims: V('hpr-v2-shelf-72kw@1.0', undefined, '537 × 46.2 × 867.5 mm'),
      'meta.rackKW': U('190 kW rack figure is a roadmap value'),
      weightKg: E('shelf with PSUs'), 'cost.capexUSD': E('price assumption'),
    },
    notes: 'Shelf document under review (hidden unless draft specs are included). Requires the vertical busbar of a separate high-power power rack (rating not published). 72 kW / 49 V ≈ 1469 A and 60 kW ≈ 1224 A, both ≤ 2000 A (derived). A 230 V feed draws 55.7 A per PSU, above a 48 A NEC-derated circuit (derived). PSU hold-up 20 ms at 100 %; peak ≤140 % for 50 ms.',
    meta: { requiresBusbar: 'high-power power rack vertical busbar', psuInputA: { 230: 55.7, 277: 46.3 }, holdUpMs: 20, peak: [{ pct: 140, ms: 50 }, { pct: 160, ms: 0.4 }], rackKW: 190 },
  }),
  block({
    id: 'bbu-orv3-3kw', category: 'other', blockKind: 'bbu-shelf', model: 'BBU shelf, 6 × 3 kW modules', name: 'Battery backup shelf, 48 V (6 × 3 kW modules, 5+1)',
    description: '2 OU battery backup shelf: six 3 kW modules (5+1), 15 kW for more than 240 s at beginning of life; module end-of-life threshold defaults to 90 s of full-power backup.',
    dims: { w: 0.537, d: 0.7875, h: 0.0923 }, weightKg: 60, cost: { capexUSD: 12_000, installHours: 1, leadTimeWeeks: 12 },
    bbu: { moduleKW: 3, modules: 6, redundancy: '5+1', backupCurve: [{ kw: 15, seconds: 240 }], eolBackupS: BBU.eolBackupS, bolBackupS: BBU.bolBackupS, lifeYears: 8 },
    standards: [std(BBU.standardId, 'open-spec', 'power', 'verified'), std('orv3-bbu-shelf@1.1', 'open-spec', 'power', 'verified')],
    paramSources: {
      'bbu.eolBackupS': V(BBU.standardId, '§8.5', 'default end-of-life threshold (user-programmable); PW-06 check value'),
      'bbu.bolBackupS': V(BBU.standardId, undefined, '3 kW for ≥240 s at the PCM threshold; shown as information'),
      'bbu.backupCurve': V('orv3-bbu-shelf@1.1', undefined, '15 kW discharge time >240 s'),
      'bbu.lifeYears': V(BBU.standardId),
      'meta.shelfNominalKW': D('orv3-bbu-shelf@1.1', '379.2 A × 47.5 V'),
      'meta.shelfPeakKW': D('orv3-bbu-shelf@1.1', '568.8 A × 47.5 V'),
      dims: V('orv3-bbu-shelf@1.1', undefined, '537 × 92.3 × 787.5 mm'),
      weightKg: E('shelf with modules'), 'cost.capexUSD': E('price assumption'),
    },
    notes: 'Module: 47.5 V at 100 % / 48.0 V at 0 %, regulation 46.0–49.5 V, 78.1 × 87.6 × 678.5 mm, 8-year life. Shelf: 379.2 A continuous / 568.8 A peak (≈18 / 27 kW derived), 47.0–48.1 V, shelves run in parallel, not hot-removable. PW-06 uses the 90 s end-of-life value; 240 s is beginning-of-life information.',
    meta: { shelfNominalKW: 18, shelfPeakKW: 27, shelfContinuousA: 379.2, shelfPeakA: 568.8, moduleOutputV: { full: 47.5, none: 48.0 }, regulationV: [46.0, 49.5], hotRemovable: false },
  }),
  block({
    id: 'bbu-shelf-hpr-33kw', category: 'other', blockKind: 'bbu-shelf', model: 'High-power BBU shelf, 6 × 5.5 kW', name: 'Battery backup shelf, high power, 33 kW (5+1)',
    description: '2 OU battery backup shelf: six 5.5 kW modules (5+1); 20 kW ≥240 s / 27.5 kW ≥90 s at 5+0, 24 kW ≥240 s / 33 kW ≥90 s at 6+0.',
    dims: { w: 0.537, d: 0.7875, h: 0.0923 }, weightKg: 75, cost: { capexUSD: 18_000, installHours: 1, leadTimeWeeks: 14 },
    bbu: { moduleKW: 5.5, modules: 6, redundancy: '5+1', backupCurve: [{ kw: 20, seconds: 240 }, { kw: 27.5, seconds: 90 }], lifeYears: 6 },
    standards: [std('orv3-hpr-bbu-shelf-33kw@0.5', 'open-spec', 'power', 'verified', { note: 'draft document' })],
    paramSources: {
      'bbu.backupCurve': V('orv3-hpr-bbu-shelf-33kw@0.5', undefined, '5+0 curve'),
      'meta.backupCurve6plus0': V('orv3-hpr-bbu-shelf-33kw@0.5'),
      'meta.continuousA': V('orv3-hpr-bbu-shelf-33kw@0.5'),
      'bbu.lifeYears': V('orv3-hpr-bbu-shelf-33kw@0.5', undefined, '≥6 years'),
      dims: V('orv3-hpr-bbu-shelf-33kw@0.5', undefined, '537 × 92.3 × 787.5 mm'),
      weightKg: E('shelf with modules'), 'cost.capexUSD': E('price assumption'),
    },
    notes: 'Draft document. 674 A continuous / 1077 A peak.',
    meta: { backupCurve6plus0: [{ kw: 24, seconds: 240 }, { kw: 33, seconds: 90 }], continuousA: 674, peakA: 1077 },
  }),
  block({
    id: 'busbar-orv3', category: 'other', blockKind: 'busbar', model: '48 V rack busbar', name: 'Rack busbar, 48 V (zero-U)',
    description: '48 V + return busbar pair of the 21-inch OU rack. The base specification states no current rating (PW-04 reports "rating not specified").',
    rackPower: { interface: 'dc-busbar', nominalV: 51, rangeV: [46, 52], itConnectorA: 100, busbarCooling: 'air' },
    standards: [std('orv3-base@1.1', 'open-spec', 'rack', 'verified')],
    paramSources: { 'rackPower.busbarRatingA': V('orv3-base@1.1', '§6.3.1', 'not specified'), 'rackPower.rangeV': V('orv3-base@1.1', '§12.1') },
    notes: 'Descriptor only (attached to the rack; no floor footprint, no cost line).',
  }),
  block({
    id: 'busbar-hpr', category: 'other', blockKind: 'busbar', model: '50 V high-power rack busbar', name: 'Rack busbar, high power, 50 V (zero-U)',
    description: '50 V busbar of the high-power 21-inch OU rack (700 A shelf clip interface). No specification rating; an air-cooled roofline of ≈155 kW and a liquid-cooled ≈700 kW projection exist only on a roadmap deck.',
    rackPower: { interface: 'dc-busbar', nominalV: 50, rangeV: [46, 52], busbarRatingKW: 155, busbarCooling: 'air' },
    standards: [std('orv3-hpr-shelf-33kw@0.3', 'open-spec', 'power', 'verified', { note: 'draft document' })],
    paramSources: { 'rackPower.busbarRatingKW': U('roadmap deck (2025-05-07): air-cooled roofline ≈155 kW; liquid-cooled ≈700 kW projection'), 'rackPower.nominalV': V('orv3-hpr-shelf-33kw@0.3') },
    notes: 'Descriptor only. PW-04 on this value is a warning at most (roadmap).',
    meta: { liquidCooledProjectionKW: 700 },
  }),
  block({
    id: 'busbar-pm400', category: 'other', blockKind: 'busbar', behindDraftsToggle: true, model: '±400 VDC rack input', name: 'Rack busbar, ±400 VDC three-conductor (zero-U)',
    description: 'Three-conductor ±400 V / COM busbar fed from a disaggregated power rack; up to 1.1 MW average (pre-1.0 draft).',
    rackPower: { interface: 'hvdc-cable', nominalV: 400, rangeV: [400, 410], busbarRatingKW: 1100 },
    standards: [std('diablo400@0.7.0', 'open-spec', 'power', 'verified', { note: 'pre-1.0 draft' })],
    paramSources: { 'rackPower.busbarRatingKW': V('diablo400@0.7.0', undefined, 'up to 1.1 MW average'), 'rackPower.rangeV': V('diablo400@0.7.0', undefined, '410 V no-load / 400 V full-load') },
    notes: 'Descriptor only; hidden unless draft specs are included (DO-4). Checks built on it stay warnings (DO-9).',
  }),
  block({
    id: 'power-rack-pm400', category: 'rpp', behindDraftsToggle: true, model: '±400 VDC power rack', name: '±400 VDC disaggregated power rack (sidecar)',
    description: 'Power rack beside the IT racks: 480/415/400 V three-phase input (≤12 × 200 A cords), ±400 VDC output over 50 kW (63 A) or 100 kW (125 A) links, BBU 45–90 s at 100 % load, 15 OU AC/DC PDU space.',
    dims: { w: 0.6, d: 1.2, h: 2.329 }, weightKg: 2722, clearance: { front: 1.2, rear: 0.9, sides: 0 },
    capacity: { powerKW: 1100, outputVoltageV: 400, inputVoltageV: 480 },
    powerRack: { inputs: { count: 12, A: 200, V: [480, 415, 400] }, ratingKWByInputV: { 480: 1100, 415: 1100, 400: 718 }, linkKW: 100, linkA: 125, efficiency100: 0.97, bbuSeconds: [45, 90] },
    cost: { capexUSD: 380_000, installHours: 60, leadTimeWeeks: 30 },
    standards: [std('diablo400@0.7.0', 'open-spec', 'power', 'verified', { note: 'pre-1.0 draft; ratings unchanged from 0.5.2' })],
    paramSources: {
      'powerRack.ratingKWByInputV': V('diablo400@0.7.0', 'Table 5', 'minimum capability: 800 kW–1.1 MW @480 V; up to 1.1 MW @415 V; up to 718 kW @400 V'),
      'powerRack.inputs': V('diablo400@0.7.0', '§8.1.1'),
      'powerRack.linkKW': V('diablo400@0.7.0', 'App. C', '50 kW / 63 A or 100 kW / 125 A per link (non-normative appendix)'),
      'powerRack.efficiency100': V('diablo400@0.7.0', 'Table 9', '>97 % @480 V; >96.5 % @415/400 V'),
      'powerRack.bbuSeconds': V('diablo400@0.7.0', '§7.2.1.1'),
      dims: V('diablo400@0.7.0', undefined, '2329 mm high; 600 × 1200 mm variant (600 × 1219 and 711 × 1219.2 mm variants exist)'),
      weightKg: V('diablo400@0.7.0', undefined, 'target 6000 lb'),
      'capacity.powerKW': V('diablo400@0.7.0', 'Table 5', 'at 480 V'),
      'cost.capexUSD': E('price assumption'),
    },
    notes: 'Pre-1.0 draft (hidden unless draft specs are included; PW-08 warning-capped, DO-9). Load steps: 175 % <2 ms (one contributor) / 180 % <0.5 ms (another). PSU hold-up without storage up to 20 ms at 100 %. Ambient −5…35 °C; Redfish recommended. Price is an estimate.',
    meta: { ratingFloorKWAt480: 800, efficiency415or400: 0.965, pduSpaceOU: 15, ambientC: [-5, 35], holdUpMsNoStorage: 20, footprintVariantsMm: [[600, 1200], [600, 1219], [711, 1219.2]], linkClasses: [{ kw: 50, a: 63 }, { kw: 100, a: 125 }] },
  }),
  block({
    id: 'rmc-generic', category: 'other', blockKind: 'rack-manager', model: 'Rack manager / power monitoring', name: 'Rack manager and power monitoring (generic)',
    description: 'Rack manager controller with shelf power-management interfaces: Modbus RS-485 on RJ45 (shelf PMI), Modbus daisy chain with CAN addressing (high-power PMM), Redfish profiles for the rack manager, power shelves and rack PDUs.',
    mgmtProfiles: ['OCPRackManagerController.v1_1_0', 'OCPPowerShelf.v1_0_0', 'OCPRackPDU.v1_0_0'],
    standards: [
      std('orv3-pmi@1.0', 'open-spec', 'mgmt', 'verified'),
      std('hpr-pmm@0.5.0', 'open-spec', 'mgmt', 'verified', { note: 'draft document' }),
      std('hpr-v2-pmm@1.0.0', 'open-spec', 'mgmt', 'verified'),
      std('hwmgmt-profiles@2026-09-01', 'open-spec', 'mgmt', 'verified'),
    ],
    paramSources: { mgmtProfiles: V('hwmgmt-profiles@2026-09-01', undefined, 'profile names as published') },
    notes: 'Descriptor only. One monitoring module per PSU / BBU shelf on the V2 platform; PSU and BBU shelves can share one chain.',
  }),
];

/** Per-shelf AC feed classes (data for PW-07; proposal §3.1 `feed-*`). */
export const SHELF_FEED_CLASSES = [
  { id: 'feed-32a-400v-iec', A: 32, V: 400, plug: 'IEC 60309', shelves: ['pshelf-orv3-18kw', 'pshelf-orv3-hpr-33kw'], standardId: 'hpr-ac-whip@0.1', verification: 'verified' },
  { id: 'feed-20a-480v-nec', A: 20, V: 480, plug: 'L22-20P', shelves: ['pshelf-orv3-18kw'], standardId: 'orv3-ac-whip@1.0', verification: 'verified' },
  { id: 'feed-30a-480v-nec', A: 30, V: 480, plug: 'L22-30P', shelves: ['pshelf-orv3-hpr-33kw'], standardId: 'hpr-ac-whip@0.1', verification: 'verified' },
  { id: 'feed-60a-v2-nec', A: 60, continuousA: 48, V: 480, plug: '5-pin 60 A inlet', shelves: ['pshelf-hpr-v2-72kw'], faultKA: 40, standardId: 'hpr-v2-shelf-72kw@1.0', verification: 'verified' },
  { id: 'feed-60a-v2-iec', A: 60, V: 400, plug: '5-pin 60 A inlet', shelves: ['pshelf-hpr-v2-72kw'], faultKA: 40, standardId: 'hpr-v2-shelf-72kw@1.0', verification: 'verified' },
  { id: 'feed-100a-power-rack-pdu', A: 100, V: 480, plug: 'lug', shelves: ['power-rack-pm400'], standardId: 'diablo400@0.7.0', verification: 'verified' },
  { id: 'feed-200a-power-rack-input', A: 200, V: 480, plug: 'lug (1/0 AWG conductors or 3/0 AWG whips, non-normative)', shelves: ['power-rack-pm400'], standardId: 'diablo400@0.7.0', verification: 'verified' },
] as const;

export const STD_RACK_POWER_CATALOG: CatalogItem[] = [...RACK_ENCLOSURE_BLOCKS, ...RACK_POWER_BLOCKS];
