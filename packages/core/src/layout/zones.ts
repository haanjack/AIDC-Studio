// Services zones (stream T1, DECISIONS-v2-2 F3b, r2-layout.md §T1–T3).
//
// Hall-shared services (storage, CPU, mgmt, network core) are a ZONE, never an island:
//   'end-band'      band of rows spanning the full pod-grid width at the phase-1 end (default for phased growth)
//   'center-band'   band between pod rows floor(R/2) and floor(R/2)+1 (default for single-build)
//   'support-hac'   one support HAC per user-defined deployment unit
//   'separate-room' dedicated room outside the white space
// Unused positions inside a band are reserve / expansion positions.
//
// Implemented by T1 (v2 2차). Band geometry lives in layout/generate.ts (build → layBand / placeSupport).
import type { GrowthPattern, Project, Rect, ServicesZoneMode } from '../model/types.ts';

export const SERVICES_ZONE_MODES: ServicesZoneMode[] = ['end-band', 'center-band', 'support-hac', 'separate-room'];

/** Default services zone for a growth pattern (phased → end band, single-build → centre band). */
export function defaultServicesZone(growth: GrowthPattern | undefined): ServicesZoneMode {
  return growth === 'single-build' ? 'center-band' : 'end-band';
}

/** Effective services-zone mode of a hall (policy value, else the growth default). */
export function servicesZoneMode(project: Project, hallId: string): ServicesZoneMode {
  const hall = project.halls.find((h) => h.id === hallId);
  return hall?.layoutPolicy?.servicesZone ?? defaultServicesZone(project.growth);
}

/**
 * Plan rectangle (hall-local) of the hall's services zone, including reserve positions.
 * Written by applyHallLayout from the generator (layout.zone): the band for end / centre bands, the room strip for
 * 'separate-room', the envelope of the support HACs for 'support-hac'. undefined = no generated services zone.
 */
export function servicesZoneRect(project: Project, hallId: string): Rect | undefined {
  return project.servicesZones?.find((z) => z.hallId === hallId)?.rect;
}
