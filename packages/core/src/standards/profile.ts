import type { Hall, Project } from '../model/types.ts';
import type { HallStandardsOverride, StandardsProfile } from './types.ts';

/**
 * Effective standards profile of a hall: the project profile with the hall override applied field by field
 * (`liquid` and `pinned` merge per key). Returns undefined when neither carries a profile (callers treat that as
 * "no standards checks"). Pure; never mutates its inputs.
 */
export function mergeStandardsProfile(base: StandardsProfile, override: HallStandardsOverride | undefined): StandardsProfile {
  if (!override) return base;
  const { liquid, pinned, ...rest } = override;
  const out: StandardsProfile = { ...base };
  for (const [k, v] of Object.entries(rest)) if (v !== undefined) (out as unknown as Record<string, unknown>)[k] = v;
  out.liquid = { ...base.liquid, ...stripUndefined(liquid ?? {}) };
  out.pinned = { ...base.pinned, ...stripUndefined(pinned ?? {}) };
  return out;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function effectiveStandardsProfile(project: Pick<Project, 'standards' | 'halls'>, hallOrId?: Hall | string): StandardsProfile | undefined {
  const hall = typeof hallOrId === 'string' ? project.halls.find((h) => h.id === hallOrId) : hallOrId;
  const base = project.standards;
  if (!base) return undefined;
  return mergeStandardsProfile(base, hall?.standards);
}

/** New standards checks are advisory (`info`) while the profile is inferred and not yet confirmed (proposal §2.5). */
export function standardsChecksAdvisoryOnly(profile: StandardsProfile | undefined): boolean {
  return !profile || profile.inferred === true || profile.strictness === 'advisory';
}
