// CFD-lite → project snapshot extraction (area D2, DECISIONS-v2-2 §D "랙 입면도" D-9 / D-10).
// Samples each rack's inlet face at 0.5 / 1.2 / 1.9 m above the floor (the 3D viewer's rackInletTemp heights), 0.1 m in
// front of the face, and stores them with the hall layout hash so rack elevation documents can mark a snapshot stale.
import { findCatalogItem, hallLayoutHash, type Project, type ThermalSnapshot } from '@aidc/core';
import type { ThermalResult } from './types.ts';
import { sampleTemperature } from './zones.ts';

export const SNAPSHOT_HEIGHTS_M: [number, number, number] = [0.5, 1.2, 1.9];

/** Build a per-hall snapshot from a finished CFD-lite result. `at` is the run completion time (ISO). */
export function thermalSnapshotFromResult(project: Project, hallId: string, result: ThermalResult, at: string): ThermalSnapshot {
  const eq = new Map(project.equipment.filter((e) => e.hallId === hallId).map((e) => [e.id, e]));
  const round = (v: number) => Math.round(v * 100) / 100;
  const racks: ThermalSnapshot['racks'] = [];
  for (const r of result.metrics.racks) {
    const e = eq.get(r.id);
    const item = e ? findCatalogItem(e.catalogId) : undefined;
    let bands: [number, number, number] | undefined;
    if (e && item && r.airflowM3s > 0) {
      // front (inlet) direction: 0° → +Y, 90° → +X, 180° → −Y, 270° → −X
      const th = (e.rotationDeg * Math.PI) / 180;
      const off = item.dims.d / 2 + 0.1;
      const x = e.position.x + Math.sin(th) * off;
      const y = e.position.y + Math.cos(th) * off;
      const vals = SNAPSHOT_HEIGHTS_M.map((z) => sampleTemperature(result, x, y, z));
      if (vals.every((v) => Number.isFinite(v))) bands = vals.map(round) as [number, number, number];
    }
    racks.push({ id: r.id, tag: r.tag, ...(bands ? { inletBandsC: bands } : {}), inletAvgC: round(r.inletAvgC), inletMaxC: round(r.inletMaxC), exhaustC: round(r.exhaustC), airflowM3s: round(r.airflowM3s) });
  }
  return { id: `cfd-${hallId}-${at.replace(/[^0-9]/g, '').slice(0, 14)}`, hallId, at, layoutHash: hallLayoutHash(project, hallId), cellM: result.grid.cellSize, maxInletC: round(result.metrics.maxInletC), racks };
}

/** Append a snapshot, keeping the newest `keepPerHall` per hall. */
export function appendThermalSnapshot(list: ThermalSnapshot[] | undefined, snap: ThermalSnapshot, keepPerHall = 4): ThermalSnapshot[] {
  const others = (list ?? []).filter((s) => s.hallId !== snap.hallId);
  const same = (list ?? []).filter((s) => s.hallId === snap.hallId).concat(snap).sort((a, b) => a.at.localeCompare(b.at)).slice(-keepPerHall);
  return [...others, ...same];
}
