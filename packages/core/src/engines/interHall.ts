// Site-level trunk pathways and network-side sleeves (finish v2 2차, DECISIONS-v2-2 §D1 / D5).
//
//  - trunk sleeves: one per hall pair on the facing walls (layout/trunkSleeves.ts), at the level just below the hall's feeder approach
//    level (above the trays, the cable tubes and every unit top), with a site pathway between them that climbs over the electrical
//    rooms standing in the gap;
//  - partition sleeves: where stored trays and the drawn cable bundles cross a separate-room partition (built to the clear height).
import type { NetworkAnalysis, Project, ProjectAnalysis, Vec3, WallPenetration } from '../model/types.ts';
import { cableRunPaths, partitionWalls } from '../layout/geometry3d.ts';
import { trunkSleeveSpot } from '../layout/trunkSleeves.ts';
import { buildPowerPlane } from './powerPaths.ts';
import { feederApproachLevel, sleevesFromCrossings } from './powerGeometry.ts';

/** trunk bundles are drawn up to ±0.11 m around the sleeve centre (geometry3d cableRunPaths lateral jitter) */
const TRUNK_HALF_ALONG_M = 0.3;
const TRUNK_HALF_Z_M = 0.12;

export interface InterHallGeometry {
  penetrations: WallPenetration[];
  pathways: NonNullable<NetworkAnalysis['interHallPathways']>;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** Trunk sleeve elevation of a hall: 0.15 m below its feeder approach level. */
export function trunkSleeveZ(project: Project, analysis: ProjectAnalysis | undefined, hallId: string): number {
  const hall = project.halls.find((h) => h.id === hallId)!;
  const level = analysis?.power.paths?.length ? buildPowerPlane(project, analysis).feederLevels.find((l) => l.hallId === hallId) : undefined;
  return round3((level?.zApproach ?? feederApproachLevel(project, hall, hall.trayHeight)) - 0.15);
}

export function interHallGeometry(project: Project, analysis: ProjectAnalysis): InterHallGeometry {
  const hallOf = new Map(project.equipment.map((e) => [e.id, e.hallId]));
  const pairs = new Map<string, { a: string; b: string; runs: number; cables: number }>();
  for (const r of analysis.network.cableRuns) {
    if (r.tier !== 'inter-hall') continue;
    const ha = hallOf.get(r.fromId);
    const hb = hallOf.get(r.toId);
    if (!ha || !hb || ha === hb) continue;
    const [a, b] = ha < hb ? [ha, hb] : [hb, ha];
    const key = `${a}|${b}`;
    const p = pairs.get(key) ?? { a, b, runs: 0, cables: 0 };
    p.runs++;
    p.cables += r.count;
    pairs.set(key, p);
  }
  const penetrations: WallPenetration[] = [];
  const pathways: InterHallGeometry['pathways'] = [];
  for (const p of pairs.values()) {
    const sa = trunkSleeveSpot(project, p.a, p.b);
    const sb = trunkSleeveSpot(project, p.b, p.a);
    if (!sa || !sb) continue;
    const za = trunkSleeveZ(project, analysis, p.a);
    const zb = trunkSleeveZ(project, analysis, p.b);
    for (const [s, z] of [[sa, za], [sb, zb]] as const) {
      penetrations.push({ id: `pen-trunk-${s.hallId}-${s.peerHallId}`, hallId: s.hallId, wall: s.wall, along: [round3(s.along - TRUNK_HALF_ALONG_M), round3(s.along + TRUNK_HALF_ALONG_M)], z: [round3(z - TRUNK_HALF_Z_M), round3(z + TRUNK_HALF_Z_M)], kind: 'trunk-sleeve', targetId: s.peerHallId, runs: p.runs });
    }
    // site pathway (site coordinates): out of each sleeve, up over the electrical rooms in the gap, across, down into the peer sleeve
    const hallA = project.halls.find((h) => h.id === p.a)!;
    const hallB = project.halls.find((h) => h.id === p.b)!;
    const zSite = Math.max(za, zb, Math.min(hallA.clearHeight, 4) + 0.3, Math.min(hallB.clearHeight, 4) + 0.3);
    const out = (s: typeof sa, d: number) => ({ x: s.site.x + (s.wall === 'E' ? d : s.wall === 'W' ? -d : 0), y: s.site.y + (s.wall === 'N' ? d : s.wall === 'S' ? -d : 0) });
    const oa = out(sa, 0.2);
    const ob = out(sb, 0.2);
    const pts: Vec3[] = [{ ...sa.site, z: za }, { ...oa, z: za }, { ...oa, z: zSite }];
    if (sa.wall === 'E' || sa.wall === 'W') {
      const mx = (oa.x + ob.x) / 2;
      pts.push({ x: mx, y: oa.y, z: zSite }, { x: mx, y: ob.y, z: zSite });
    } else {
      const my = (oa.y + ob.y) / 2;
      pts.push({ x: oa.x, y: my, z: zSite }, { x: ob.x, y: my, z: zSite });
    }
    pts.push({ ...ob, z: zSite }, { ...ob, z: zb }, { ...sb.site, z: zb });
    const clean = pts.filter((q, i) => i === 0 || Math.hypot(q.x - pts[i - 1].x, q.y - pts[i - 1].y, q.z - pts[i - 1].z) > 1e-6).map((q) => ({ x: round3(q.x), y: round3(q.y), z: round3(q.z) }));
    const lengthM = clean.slice(1).reduce((s, q, i) => s + Math.abs(q.x - clean[i].x) + Math.abs(q.y - clean[i].y) + Math.abs(q.z - clean[i].z), 0);
    pathways.push({ id: `trunk-path-${p.a}-${p.b}`, hallIds: [p.a, p.b], points: clean, lengthM: round3(lengthM), runs: p.runs, cables: p.cables });
  }
  // partition sleeves for stored trays and drawn cable bundles; chimney sleeves where they cross the walls of a ducted hot aisle
  // above its doors (QA m1: the main tray of the shorter services rows joins rows on both sides of the services HAC)
  for (const hall of project.halls) {
    const eq = project.equipment.filter((e) => e.hallId === hall.id);
    const walls = partitionWalls(hall, project.reservations, eq);
    const chimneys = project.containments.filter((c) => c.hallId === hall.id && c.ductedToPlenum);
    if (!walls.length && !chimneys.length) continue;
    const trays = (project.trays ?? []).filter((t) => t.hallId === hall.id);
    // cables to row-less units (CRAH / CDU on the perimeter) leave the trays and may cross a partition or chimney wall on their own
    // line — only those few bundles are routed here (geometry3d cableRunPaths)
    const rowOf = new Map(eq.map((e) => [e.id, e.rowId]));
    const rowless = analysis.network.cableRuns.filter((r) => rowOf.has(r.fromId) && rowOf.has(r.toId) && (!rowOf.get(r.fromId) !== !rowOf.get(r.toId)));
    const loose = rowless.length ? cableRunPaths(hall, eq, rowless, project.trays, { allEquipment: project.equipment, containments: project.containments }).paths : [];
    const planes: { key: string; reservationId?: string; targetId: string; axis: 'x' | 'y'; c: number; spans: [number, number][]; z0: number; z1: number }[] = [
      ...walls.map((pw) => ({ key: `${pw.reservationId}-trays`, reservationId: pw.reservationId, targetId: 'trays', axis: pw.axis, c: (pw.c0 + pw.c1) / 2, spans: pw.spans, z0: 0, z1: pw.height })),
      ...chimneys.flatMap((ct) => {
        const axis: 'x' | 'y' = ct.rect.w >= ct.rect.d ? 'x' : 'y';
        const a0 = axis === 'x' ? ct.rect.x : ct.rect.y;
        const a1 = a0 + (axis === 'x' ? ct.rect.w : ct.rect.d);
        const p0 = axis === 'x' ? ct.rect.y : ct.rect.x;
        const p1 = p0 + (axis === 'x' ? ct.rect.d : ct.rect.w);
        const top = Math.max(ct.height + 0.3, hall.clearHeight);
        return [p0, p1].map((c, i) => ({ key: `chimney-${ct.id}-${i + 1}`, targetId: ct.id, axis, c, spans: [[a0, a1]] as [number, number][], z0: ct.height, z1: top }));
      }),
    ];
    for (const pl of planes) {
      const pts: { along: number; z: number }[] = [];
      const crossSeg = (s: Vec3, e: Vec3, halfAlong: number, zLo: number, zHi: number) => {
        const ps = pl.axis === 'x' ? s.y : s.x;
        const pe = pl.axis === 'x' ? e.y : e.x;
        if ((ps - pl.c) * (pe - pl.c) > 0 || Math.abs(pe - ps) < 1e-6) return;
        const t = (pl.c - ps) / (pe - ps);
        const along = pl.axis === 'x' ? s.x + (e.x - s.x) * t : s.y + (e.y - s.y) * t;
        if (!pl.spans.some(([a0, a1]) => along > a0 - 0.05 && along < a1 + 0.05)) return;
        const z = s.z + (e.z - s.z) * t;
        if (z + zHi < pl.z0 || z + zLo > pl.z1) return;
        // centre + both edges (≤ 0.5 m apart) so one crossing merges into one opening
        pts.push({ along: along - halfAlong, z: z + zLo }, { along, z }, { along: along + halfAlong, z: z + zHi });
      };
      // cable bundles cross these walls only along the trays (geometry3d cableRunPaths: ±0.11 m lateral jitter, radius ≤ 0.04 m, up to
      // 0.18 m above the tray deck), so the tray opening is sized for them — no cable paths are built during analysis
      for (const t of trays) for (let i = 0; i < t.points.length - 1; i++) crossSeg(t.points[i], t.points[i + 1], t.widthM / 2 + 0.16, -0.06, 0.24);
      for (const c of loose) for (let i = 0; i < c.points.length - 1; i++) crossSeg(c.points[i], c.points[i + 1], c.radius + 0.03, -c.radius - 0.03, c.radius + 0.03);
      sleevesFromCrossings(pts, 0.5, 0.05).forEach((s, i) => penetrations.push({ id: `pen-${pl.key}-${i + 1}`, hallId: hall.id, wall: 'partition', ...(pl.reservationId ? { reservationId: pl.reservationId } : {}), along: s.along, z: s.z, kind: 'partition-sleeve', targetId: pl.targetId, runs: s.runs, plane: round3(pl.c), planeAxis: pl.axis }));
    }
  }
  return { penetrations, pathways };
}
