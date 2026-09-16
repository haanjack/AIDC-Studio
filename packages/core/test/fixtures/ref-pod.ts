// Synthetic single-POD fixture (neutralization stream N2a, 2026-09-15).
//
// Replaces the retired reference-CFD POD that was rebuilt from a third-party CFD dataset. Every number below is an
// AIDC Studio test parameter chosen for coverage, NOT taken from any vendor layout: one 24 × 12 m hall, 24 rack-scale
// GPU racks in two facing rows of 12 around a ducted hot-aisle containment, two wall-mounted cooling units on the west
// wall, no CDUs, two columns and one partition wall. It keeps the geometry features the drawing / scene / wall-audit
// tests exercised (geometry-only `purpose: 'reference-cfd'` project, windowed rows in a wide hall, columns, partition,
// no CDU) without any vendor data.
import { createNvidiaReferenceProject, type Containment, type EquipmentInstance, type Hall, type Keepout, type Project } from '../../src/index.ts';

export const REF_POD_HALL_ID = 'pod';
export const REF_POD_ID = 'pod-ref';
export const REF_POD_RACKS_PER_ROW = 12;

const WAVE_ID = 'wave-01';
const STAMP = '2026-09-15T00:00:00.000Z';

/** Plan parameters of the synthetic POD (metres). */
export const REF_POD_PARAMS = {
  width: 24,
  depth: 12,
  clearHeight: 5.4,
  plenum: 1.8,
  rackPitch: 0.6,
  rackDepth: 1.2,
  rowStartX: 7.2,
  hotAisle: { y0: 4.8, y1: 6.6 },
  containmentHeight: 2.3,
  coolerX: 0.6,
  coolerY: [3.0, 9.0],
} as const;

export function createRefPodFixture(): Project {
  // the reference hall's trays / busways / reservations / services zones / clusters belong to 'hall-a' → not inherited
  const { trays: _t, busways: _b, reservations: _r, servicesZones: _z, clusters: _c, ...base } = createNvidiaReferenceProject().project;
  const P = REF_POD_PARAMS;
  const rowLen = REF_POD_RACKS_PER_ROW * P.rackPitch;

  const keepouts: Keepout[] = [
    { id: 'col-1', kind: 'column', rect: { x: 18.0, y: 1.8, w: 0.6, d: 0.6 }, label: 'Column' },
    { id: 'col-2', kind: 'column', rect: { x: 18.0, y: 9.6, w: 0.6, d: 0.6 }, label: 'Column' },
    { id: 'wall-1', kind: 'other', rect: { x: 21.6, y: 0, w: 0.2, d: 3.0 }, label: 'Partition wall' },
  ];
  const hall: Hall = {
    ...base.halls[0],
    id: REF_POD_HALL_ID,
    name: 'Synthetic reference POD',
    origin: { x: 0, y: 0 },
    width: P.width,
    depth: P.depth,
    clearHeight: P.clearHeight,
    ceilingPlenumHeight: P.plenum,
    keepouts,
  };

  const equipment: EquipmentInstance[] = [];
  for (const [row, front] of [['a', -1], ['b', 1]] as const) {
    for (let i = 0; i < REF_POD_RACKS_PER_ROW; i++) {
      const n = String(i + 1).padStart(2, '0');
      equipment.push({
        id: `pod-rack-${row}${n}`,
        catalogId: 'nvidia-gb300-nvl72',
        hallId: hall.id,
        tag: `POD-${row.toUpperCase()}${n}`,
        // rear faces on the containment planes: row A fronts face -y, row B fronts face +y
        position: { x: P.rowStartX + P.rackPitch / 2 + i * P.rackPitch, y: front < 0 ? P.hotAisle.y0 - P.rackDepth / 2 : P.hotAisle.y1 + P.rackDepth / 2 },
        rotationDeg: front < 0 ? 180 : 0,
        podId: REF_POD_ID,
        rowId: `${REF_POD_ID}-${row}`,
        waveId: WAVE_ID,
        blanking: true,
      });
    }
  }
  P.coolerY.forEach((y, i) =>
    equipment.push({ id: `pod-cooler-${i + 1}`, catalogId: 'vertiv-cw375', hallId: hall.id, tag: `COOLER-${i + 1}`, position: { x: P.coolerX, y }, rotationDeg: 270, waveId: WAVE_ID }),
  );

  const containments: Containment[] = [
    {
      id: 'pod-hac',
      hallId: hall.id,
      kind: 'hot-aisle',
      rect: { x: P.rowStartX - 0.3, y: P.hotAisle.y0, w: rowLen + 0.6, d: P.hotAisle.y1 - P.hotAisle.y0 },
      height: P.containmentHeight,
      roof: true,
      endDoors: true,
      ductedToPlenum: true,
      podId: REF_POD_ID,
    },
  ];

  return {
    ...base,
    id: 'ref-pod-fixture',
    name: 'Synthetic reference POD (test fixture)',
    description: 'Geometry-only test fixture authored from AIDC Studio parameters (24 rack-scale racks, ducted hot-aisle containment, wall cooling units).',
    purpose: 'reference-cfd',
    createdAt: STAMP,
    updatedAt: STAMP,
    halls: [hall],
    equipment,
    containments,
    workloads: [],
    schedule: { ...base.schedule, waves: [{ id: WAVE_ID, name: 'Reference POD', podIds: [REF_POD_ID] }] },
    notes: [],
  };
}
