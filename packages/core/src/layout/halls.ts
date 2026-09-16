// Data-hall lifecycle helpers (v2 2차 follow-up "halls"): add / rename / duplicate / remove a hall and keep every project-level
// reference to it consistent (equipment, containments, trays, busways, reservations, services zones, clusters, schedule waves).
// Pure: every function returns a new Project and never mutates its input.
import type { Hall, Id, Project } from '../model/types.ts';

/** gap between halls placed side by side (m). backlog T1a (qa-autosize v2 2차 §3.3): was 12 m, sized for one 4.5–7.4 m room per facing wall;
 *  a hall whose row-end walls carry the cooling puts rooms A and B side by side on a wall parallel to the rows, each on half the wall and
 *  about twice as deep → 2 × (2 × 4.5 m) + 2 × 0.4 m room gap + 1.2 m access ≈ 20 m. Deeper sized rooms are cleared by autoSizeHall's shift
 *  of the hall it sizes and by the 'shift-hall' remedy. */
export const HALL_GAP_M = 20;

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Prefix + next free letter, e.g. "Data Hall C" when "Data Hall A" and "Data Hall B" exist. */
export function nextHallName(project: Project): string {
  // "Data Hall B (Phase 2)" uses letter B too: an optional parenthetical / dash suffix after the letter is ignored
  const re = /^(.*?\s|)([A-Z])(?:\s*[(\-–—].*)?$/;
  const parsed = project.halls.map((h) => re.exec(h.name.trim())).filter((m): m is RegExpExecArray => !!m);
  const prefix = parsed[0]?.[1] || 'Data Hall ';
  const used = new Set(project.halls.map((h) => h.name.trim()));
  const usedLetters = new Set(parsed.filter((m) => m[1] === prefix).map((m) => m[2]));
  for (const l of LETTERS) if (!usedLetters.has(l) && !used.has(`${prefix}${l}`)) return `${prefix}${l}`;
  let n = LETTERS.length + 1;
  while (used.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

function uniqueId(base: string, taken: Set<string>): string {
  let id = base;
  let i = 2;
  while (taken.has(id)) id = `${base}-${i++}`;
  taken.add(id);
  return id;
}

/** Id derived from the hall name's last token ("Data Hall C" → "hall-c"), unique within the project. */
export function nextHallId(project: Project, name: string): string {
  const token = name.trim().split(/\s+/).pop()?.toLowerCase().replace(/[^a-z0-9]+/g, '') || 'x';
  return uniqueId(`hall-${token}`, new Set(project.halls.map((h) => h.id)));
}

/** Origin just east of every existing hall (never overlaps), aligned with the right-most hall. */
export function nextHallOrigin(project: Project): { x: number; y: number } {
  if (!project.halls.length) return { x: 0, y: 0 };
  const right = project.halls.reduce((a, h) => (h.origin.x + h.width > a.origin.x + a.width ? h : a));
  return { x: right.origin.x + right.width + HALL_GAP_M, y: right.origin.y };
}

export interface NewHallOptions {
  name?: string;
  width?: number;
  depth?: number;
}

/** An empty hall shaped like the first hall (size, heights, tile size, budgets, layout policy) — no keep-outs, no equipment. */
export function makeHall(project: Project, opts: NewHallOptions = {}): Hall {
  const tpl = project.halls[0];
  const name = opts.name?.trim() || nextHallName(project);
  const base: Hall = tpl
    ? structuredClone(tpl)
    : {
        id: '', name, origin: { x: 0, y: 0 }, width: 60, depth: 30, clearHeight: 4.5, raisedFloorHeight: 0, ceilingPlenumHeight: 1.2, floorLoadingKgPerM2: 1500,
        tileSize: 0.6, itPowerBudgetKW: 10000, liquidCoolingBudgetKW: 8000, airCoolingBudgetKW: 2000, keepouts: [], trayHeight: 3,
      };
  const hall: Hall = { ...base, id: nextHallId(project, name), name, origin: nextHallOrigin(project), keepouts: [] };
  delete hall.outline;
  if (opts.width && opts.width > 0) hall.width = opts.width;
  if (opts.depth && opts.depth > 0) hall.depth = opts.depth;
  return hall;
}

export function addHall(project: Project, opts: NewHallOptions = {}): { project: Project; hallId: Id } {
  const hall = makeHall(project, opts);
  return { project: { ...project, halls: [...project.halls, hall] }, hallId: hall.id };
}

export function renameHall(project: Project, hallId: Id, name: string): Project {
  const n = name.trim();
  if (!n || !project.halls.some((h) => h.id === hallId)) return project;
  return { ...project, halls: project.halls.map((h) => (h.id === hallId ? { ...h, name: n } : h)) };
}

/**
 * Copy a hall beside the others. `withLayout` also copies its equipment, containments, trays, busways, reservations and services zone
 * (new ids; pods and rows get the new hall id as suffix and join the same schedule waves as their source pods).
 */
export function duplicateHall(project: Project, hallId: Id, opts: { withLayout?: boolean; name?: string } = {}): { project: Project; hallId: Id } {
  const src = project.halls.find((h) => h.id === hallId);
  if (!src) return { project, hallId };
  const name = opts.name?.trim() || nextHallName(project);
  const id = nextHallId(project, name);
  const hall: Hall = { ...structuredClone(src), id, name, origin: nextHallOrigin(project) };
  const out: Project = { ...project, halls: [...project.halls, hall] };
  if (!opts.withLayout) {
    hall.keepouts = structuredClone(src.keepouts);
    return { project: out, hallId: id };
  }
  const takenEq = new Set(project.equipment.map((e) => e.id));
  const eqMap = new Map<Id, Id>();
  const podMap = new Map<Id, Id>();
  const rowMap = new Map<Id, Id>();
  const suffix = (m: Map<Id, Id>, v: Id | undefined) => {
    if (!v) return v;
    if (!m.has(v)) m.set(v, `${v}-${id}`);
    return m.get(v);
  };
  const srcEq = project.equipment.filter((e) => e.hallId === hallId);
  const newEq = srcEq.map((e) => {
    const nid = uniqueId(`${e.id}-${id}`, takenEq);
    eqMap.set(e.id, nid);
    const c = structuredClone(e);
    c.id = nid;
    c.hallId = id;
    if (c.podId) c.podId = suffix(podMap, c.podId);
    if (c.rowId) c.rowId = suffix(rowMap, c.rowId);
    return c;
  });
  out.equipment = [...project.equipment, ...newEq];
  const takenC = new Set(project.containments.map((c) => c.id));
  out.containments = [
    ...project.containments,
    ...project.containments.filter((c) => c.hallId === hallId).map((c) => ({ ...structuredClone(c), id: uniqueId(`${c.id}-${id}`, takenC), hallId: id, ...(c.podId ? { podId: suffix(podMap, c.podId) } : {}) })),
  ];
  if (project.trays) {
    const taken = new Set(project.trays.map((t) => t.id));
    out.trays = [...project.trays, ...project.trays.filter((t) => t.hallId === hallId).map((t) => ({ ...structuredClone(t), id: uniqueId(`${t.id}-${id}`, taken), hallId: id }))];
  }
  if (project.busways) {
    const taken = new Set(project.busways.map((b) => b.id));
    out.busways = [
      ...project.busways,
      ...project.busways.filter((b) => b.hallId === hallId).map((b) => ({
        ...structuredClone(b), id: uniqueId(`${b.id}-${id}`, taken), hallId: id,
        tapoffs: b.tapoffs.filter((t) => eqMap.has(t.equipmentId)).map((t) => ({ ...t, equipmentId: eqMap.get(t.equipmentId)! })),
      })),
    ];
  }
  if (project.reservations) {
    const taken = new Set(project.reservations.map((r) => r.id));
    out.reservations = [
      ...project.reservations,
      ...project.reservations.filter((r) => r.hallId === hallId).map((r) => ({ ...structuredClone(r), id: uniqueId(`${r.id}-${id}`, taken), hallId: id, ...(r.rowId ? { rowId: suffix(rowMap, r.rowId) } : {}) })),
    ];
  }
  if (project.servicesZones) out.servicesZones = [...project.servicesZones, ...project.servicesZones.filter((z) => z.hallId === hallId).map((z) => ({ ...structuredClone(z), hallId: id }))];
  if (podMap.size) {
    out.schedule = {
      ...project.schedule,
      waves: project.schedule.waves.map((w) => {
        const extra = w.podIds.filter((p) => podMap.has(p)).map((p) => podMap.get(p)!);
        return extra.length ? { ...w, podIds: [...w.podIds, ...extra] } : w;
      }),
    };
  }
  return { project: out, hallId: id };
}

export interface HallRemovalSummary {
  hallId: Id;
  hallName: string;
  equipment: number;
  containments: number;
  trays: number;
  busways: number;
  reservations: number;
  servicesZones: number;
  /** clusters that list the hall (they lose it; a cluster left with no hall is removed) */
  clusters: number;
  clustersRemoved: number;
  /** pods of this hall removed from schedule waves */
  wavePods: number;
  /** waves that only contained this hall's pods (removed) */
  wavesRemoved: number;
  /** saved thermal snapshots (`project.thermalSnapshots`) of this hall */
  thermalSnapshots: number;
  /** false when this is the last hall */
  allowed: boolean;
}

function podsOnlyIn(project: Project, hallId: Id): Set<Id> {
  const inHall = new Set<Id>();
  const elsewhere = new Set<Id>();
  for (const e of project.equipment) if (e.podId) (e.hallId === hallId ? inHall : elsewhere).add(e.podId);
  return new Set([...inHall].filter((p) => !elsewhere.has(p)));
}

/** What `removeHall` would delete (for the confirmation dialog). */
export function hallRemovalSummary(project: Project, hallId: Id): HallRemovalSummary {
  const n = <T extends { hallId: Id }>(xs: T[] | undefined) => (xs ?? []).filter((x) => x.hallId === hallId).length;
  const pods = podsOnlyIn(project, hallId);
  const clusters = (project.clusters ?? []).filter((c) => c.hallIds.includes(hallId));
  return {
    hallId,
    hallName: project.halls.find((h) => h.id === hallId)?.name ?? hallId,
    equipment: n(project.equipment),
    containments: n(project.containments),
    trays: n(project.trays),
    busways: n(project.busways),
    reservations: n(project.reservations),
    servicesZones: n(project.servicesZones),
    clusters: clusters.length,
    clustersRemoved: clusters.filter((c) => c.hallIds.every((h) => h === hallId)).length,
    wavePods: project.schedule.waves.reduce((a, w) => a + w.podIds.filter((p) => pods.has(p)).length, 0),
    wavesRemoved: project.schedule.waves.filter((w) => w.podIds.length > 0 && w.podIds.every((p) => pods.has(p))).length,
    thermalSnapshots: n(project.thermalSnapshots),
    allowed: project.halls.length > 1 && project.halls.some((h) => h.id === hallId),
  };
}

/** Remove a hall and everything that references it. Throws when it is the last hall. */
export function removeHall(project: Project, hallId: Id): Project {
  if (!project.halls.some((h) => h.id === hallId)) return project;
  if (project.halls.length <= 1) throw new Error('cannot remove the last hall');
  const keep = <T extends { hallId: Id }>(xs: T[]) => xs.filter((x) => x.hallId !== hallId);
  const pods = podsOnlyIn(project, hallId);
  const removedWaves = new Set(project.schedule.waves.filter((w) => w.podIds.length > 0 && w.podIds.every((p) => pods.has(p))).map((w) => w.id));
  const out: Project = {
    ...project,
    halls: project.halls.filter((h) => h.id !== hallId),
    equipment: keep(project.equipment).map((e) => (e.waveId && removedWaves.has(e.waveId) ? { ...e, waveId: undefined } : e)),
    containments: keep(project.containments),
    schedule: {
      ...project.schedule,
      waves: project.schedule.waves.filter((w) => !removedWaves.has(w.id)).map((w) => (w.podIds.some((p) => pods.has(p)) ? { ...w, podIds: w.podIds.filter((p) => !pods.has(p)) } : w)),
    },
  };
  if (project.trays) out.trays = keep(project.trays);
  if (project.busways) out.busways = keep(project.busways);
  if (project.reservations) out.reservations = keep(project.reservations).map((r) => (r.waveId && removedWaves.has(r.waveId) ? { ...r, waveId: undefined } : r));
  if (project.servicesZones) out.servicesZones = keep(project.servicesZones);
  if (project.thermalSnapshots) out.thermalSnapshots = keep(project.thermalSnapshots);
  if (project.clusters) {
    out.clusters = project.clusters
      .map((c) => {
        if (!c.hallIds.includes(hallId) && c.interHallCore?.zoneHallId !== hallId) return c;
        const next = { ...c, hallIds: c.hallIds.filter((h) => h !== hallId) };
        if (next.interHallCore?.zoneHallId === hallId) next.interHallCore = { ...next.interHallCore, zoneHallId: undefined };
        return next;
      })
      .filter((c) => c.hallIds.length > 0);
  }
  return out;
}

/**
 * Load-time normalisation (finish v2 2차): derived overhead records whose hall no longer exists (trays, busways, reservations, services
 * zones) are dropped — e.g. a retired reference POD file carried 43 trays / busways of the reference project's 'hall-a'.
 * Returns the input object when nothing changes. Equipment and containments are never touched.
 */
/** `rotationDeg` for an item that lacks a finite one: the legacy `rotation` key (degrees) snapped to 0/90/180/270, else 0. */
export function legacyRotationDeg(e: { rotation?: unknown }): 0 | 90 | 180 | 270 {
  const r = Number(e.rotation);
  if (!Number.isFinite(r)) return 0;
  return ((((Math.round(r / 90) * 90) % 360) + 360) % 360) as 0 | 90 | 180 | 270;
}

export function normalizeLoadedProject(project: Project): Project {
  const halls = new Set(project.halls.map((h) => h.id));
  const orphan = (xs?: readonly { hallId: Id }[]) => (xs ?? []).some((x) => !halls.has(x.hallId));
  // Legacy key `rotation` (older hand-made / QA files) without `rotationDeg`: the viewer's frontVector() would get undefined
  // and put the camera at NaN (finish QA). Migrate to the nearest right angle; items with a finite rotationDeg are untouched.
  const badRot = (project.equipment ?? []).some((e) => !Number.isFinite(e.rotationDeg));
  if (!badRot && !orphan(project.trays) && !orphan(project.busways) && !orphan(project.reservations) && !orphan(project.servicesZones)) return project;
  const out: Project = { ...project };
  if (badRot) out.equipment = project.equipment.map((e) => (Number.isFinite(e.rotationDeg) ? e : { ...e, rotationDeg: legacyRotationDeg(e as { rotation?: unknown }) }));
  if (project.trays) out.trays = project.trays.filter((x) => halls.has(x.hallId));
  if (project.busways) out.busways = project.busways.filter((x) => halls.has(x.hallId));
  if (project.reservations) out.reservations = project.reservations.filter((x) => halls.has(x.hallId));
  if (project.servicesZones) out.servicesZones = project.servicesZones.filter((x) => halls.has(x.hallId));
  return out;
}
