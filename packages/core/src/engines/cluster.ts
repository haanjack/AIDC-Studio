// Cluster scope (stream T2, DECISIONS-v2-2 F2).
//
// Default: every hall that holds equipment is its own cluster — an independent scale-out / front-end / storage / OOB fabric with its
// own leaves, spines and cores, and no cable leaves the hall. Joining several halls into one cluster is explicit
// (`project.clusters`): only then does network.ts add an inter-hall super-spine tier, hosted in the cluster's zone hall
// (racks with networkRole 'inter-hall-core'), and single-mode trunks between the halls (common reference-design "CIN spine" pattern).
import type { ClusterDef, Project } from '../model/types.ts';

const defaultCluster = (h: { id: string; name: string }): ClusterDef => ({ id: `cluster-${h.id}`, name: h.name, hallIds: [h.id] });

/**
 * Clusters of the project: `project.clusters` when set (returned as-is when they cover every populated hall), plus one default
 * cluster for each populated hall that no explicit cluster lists; else one cluster per hall that has equipment (hall order).
 */
export function resolveClusters(project: Project): ClusterDef[] {
  const populated = new Set(project.equipment.map((e) => e.hallId));
  if (project.clusters?.length) {
    const covered = new Set(project.clusters.flatMap((c) => c.hallIds));
    const extra = project.halls.filter((h) => populated.has(h.id) && !covered.has(h.id)).map(defaultCluster);
    return extra.length ? [...project.clusters, ...extra] : project.clusters;
  }
  return project.halls.filter((h) => populated.has(h.id)).map(defaultCluster);
}

/** The cluster that contains a hall (default cluster when none lists it). */
export function clusterOfHall(project: Project, hallId: string): ClusterDef {
  const c = resolveClusters(project).find((x) => x.hallIds.includes(hallId));
  const hall = project.halls.find((h) => h.id === hallId);
  return c ?? defaultCluster({ id: hallId, name: hall?.name ?? hallId });
}

/** Hall hosting the inter-hall core of a joined cluster: `interHallCore.zoneHallId`, else the first listed hall. */
export function zoneHallOf(cluster: ClusterDef): string | undefined {
  return cluster.interHallCore?.zoneHallId && cluster.hallIds.includes(cluster.interHallCore.zoneHallId) ? cluster.interHallCore.zoneHallId : cluster.hallIds[0];
}

/** Manhattan distance between two hall origins (site coordinates, m) — the inter-hall part of a trunk length. */
export function interHallDistanceM(project: Project, hallA: string, hallB: string): number {
  const a = project.halls.find((h) => h.id === hallA)?.origin ?? { x: 0, y: 0 };
  const b = project.halls.find((h) => h.id === hallB)?.origin ?? { x: 0, y: 0 };
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/**
 * New `project.clusters` with `hallIds` joined into one cluster (the halls are removed from the clusters that held them; clusters left
 * empty are dropped). Every hall of the project ends up in exactly one cluster.
 */
export function joinHalls(project: Project, hallIds: string[], name?: string): ClusterDef[] {
  const join = project.halls.map((h) => h.id).filter((id) => hallIds.includes(id));
  const base = explicitAll(project).map((c) => ({ ...c, hallIds: c.hallIds.filter((id) => !join.includes(id)) })).filter((c) => c.hallIds.length > 0);
  if (!join.length) return base;
  const names = join.map((id) => project.halls.find((h) => h.id === id)?.name ?? id);
  const joined: ClusterDef = { id: `cluster-${join.join('+')}`, name: name ?? names.join(' + '), hallIds: join, interHallCore: { zoneHallId: join[0] } };
  return [...base, joined];
}

/** New `project.clusters` with one cluster split back into one default cluster per hall. */
export function splitCluster(project: Project, clusterId: string): ClusterDef[] {
  const all = explicitAll(project);
  const target = all.find((c) => c.id === clusterId);
  if (!target) return all;
  const halls = target.hallIds.map((id) => project.halls.find((h) => h.id === id) ?? { id, name: id });
  return [...all.filter((c) => c.id !== clusterId), ...halls.map(defaultCluster)];
}

/** Every hall (populated or not) in exactly one cluster: explicit clusters first, then one default cluster per remaining hall. */
function explicitAll(project: Project): ClusterDef[] {
  const explicit = project.clusters ?? [];
  const covered = new Set(explicit.flatMap((c) => c.hallIds));
  return [...explicit, ...project.halls.filter((h) => !covered.has(h.id)).map(defaultCluster)];
}

/** true when the project uses only the default per-hall clusters (no joined halls). */
export function allClustersSingleHall(project: Project): boolean {
  return resolveClusters(project).every((c) => c.hallIds.length <= 1);
}
