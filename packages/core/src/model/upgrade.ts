import {
  canonicalConnector,
  canonicalFacilityPrecheck,
  canonicalSeedNote,
  canonicalSpecSource,
  canonicalStandardLevel,
  neutralRackClass,
  rackFormFromMeta,
} from '../catalog/aliases.ts';
import { findCatalogItem } from '../catalog/catalog.ts';
import { resolveCatalog, withCatalog } from '../catalog/registry.ts';
import { platformRackClass } from '../layout/templates/index.ts';
import { STANDARDS_PRESETS } from '../standards/registry.ts';
import type { AirSideKey, CduClassKey, HallStandardsOverride, LiquidProfile, RackFormKey, RackPowerKey, StandardFamily, StandardsProfile } from '../standards/types.ts';
import type { CatalogItem, Hall, Project } from './types.ts';

/**
 * Stored-project upgrade (stream A / P1; OCP-DESIGN-PROPOSAL §2.5).
 *
 * `upgradeProject(p)` is pure and idempotent. It runs at every load (server storage + version snapshots, web store) and:
 *  1. rewrites legacy spec-source tags of project catalog / cable extensions;
 *  2. canonicalises enum keys inside an existing standards profile (connector, facility pre-check, item standard levels);
 *  3. adds `standards` = `inferProfile(p)` with `inferred: true` when the project has none (checks stay advisory);
 *  4. replaces the unedited seed note of the retired blueprint generator with today's neutral seed note (`canonicalSeedNote`).
 * It never changes placed equipment, catalog ids, geometry or any number the engines read, so analysis totals are identical.
 * Returns the input object itself when nothing changes.
 */
export function upgradeProject(p: Project): Project {
  let out = p;
  const patch = (fields: Partial<Project>) => {
    out = out === p ? { ...p, ...fields } : { ...out, ...fields };
  };

  // 1. catalog / cable extensions: legacy source tags and standard levels
  if (p.catalogExtensions?.some(itemNeedsUpgrade)) patch({ catalogExtensions: p.catalogExtensions.map((it) => (itemNeedsUpgrade(it) ? upgradeCatalogItem(it) : it)) });
  if (p.cableExtensions?.some((c) => canonicalSpecSource(c.source) !== c.source && canonicalSpecSource(c.source))) {
    patch({ cableExtensions: p.cableExtensions.map((c) => ({ ...c, source: canonicalSpecSource(c.source) ?? c.source })) });
  }

  // 2–3. standards profile
  if (!out.standards) patch({ standards: inferProfile(out) });
  else {
    const s = canonicalProfile(out.standards);
    if (s !== out.standards) patch({ standards: s });
  }
  if (out.halls?.some((h) => h.standards && canonicalOverride(h.standards) !== h.standards)) {
    patch({ halls: out.halls.map((h) => (h.standards ? withHallStandards(h, canonicalOverride(h.standards)) : h)) });
  }

  // 4. the unedited seed note of the retired blueprint generator → today's neutral seed note (display text only)
  if (p.notes?.some((n) => canonicalSeedNote(n) !== n)) patch({ notes: p.notes.map((n) => canonicalSeedNote(n)) });
  return out;
}

function withHallStandards(h: Hall, s: HallStandardsOverride): Hall {
  return s === h.standards ? h : { ...h, standards: s };
}

function itemNeedsUpgrade(it: CatalogItem): boolean {
  if (canonicalSpecSource(it.source) && canonicalSpecSource(it.source) !== it.source) return true;
  if (it.rackStaticLoadSource && canonicalSpecSource(it.rackStaticLoadSource) !== it.rackStaticLoadSource && canonicalSpecSource(it.rackStaticLoadSource)) return true;
  return !!it.standards?.some((s) => canonicalStandardLevel(s.level) !== s.level);
}

function upgradeCatalogItem(it: CatalogItem): CatalogItem {
  const next: CatalogItem = { ...it, source: canonicalSpecSource(it.source) ?? it.source };
  if (it.rackStaticLoadSource) next.rackStaticLoadSource = canonicalSpecSource(it.rackStaticLoadSource) ?? it.rackStaticLoadSource;
  if (it.standards) next.standards = it.standards.map((s) => (canonicalStandardLevel(s.level) !== s.level ? { ...s, level: canonicalStandardLevel(s.level) as typeof s.level } : s));
  return next;
}

function canonicalLiquid<T extends Partial<LiquidProfile>>(l: T | undefined): T | undefined {
  if (!l?.connector || canonicalConnector(l.connector) === l.connector) return l;
  return { ...l, connector: canonicalConnector(l.connector) as LiquidProfile['connector'] };
}

function canonicalProfile(s: StandardsProfile): StandardsProfile {
  let out = s;
  const liquid = canonicalLiquid(s.liquid);
  if (liquid !== s.liquid) out = { ...out, liquid: liquid! };
  if (s.facilityPrecheck && canonicalFacilityPrecheck(s.facilityPrecheck) !== s.facilityPrecheck) out = { ...out, facilityPrecheck: canonicalFacilityPrecheck(s.facilityPrecheck) as StandardsProfile['facilityPrecheck'] };
  return out;
}

function canonicalOverride(s: HallStandardsOverride): HallStandardsOverride {
  let out = s;
  const liquid = canonicalLiquid(s.liquid);
  if (liquid !== s.liquid) out = { ...out, liquid };
  if (s.facilityPrecheck && canonicalFacilityPrecheck(s.facilityPrecheck) !== s.facilityPrecheck) out = { ...out, facilityPrecheck: canonicalFacilityPrecheck(s.facilityPrecheck) as StandardsProfile['facilityPrecheck'] };
  return out;
}

// ───────────────────────────── inference ─────────────────────────────

export interface InferredRack {
  rackForm: RackFormKey;
  rackPower: RackPowerKey;
  liquid: boolean;
}

/**
 * Standards keys implied by one placed compute rack (proposal §2.5 inference table):
 *  - rack-scale NVLink-class systems → vendor-contributed ORv3-width frame + vendor busbar (never the HPR busbar interface:
 *    that would make shelf checks flag every such hall);
 *  - ORW-class rack-scale systems (UALink scale-up / ORW meta form) → ORW + 50 V HPR busbar;
 *  - 8-GPU node, PCIe / NPU and appliance racks → EIA-310 19-inch + AC PDU (DLC nodes keep a vendor liquid interface).
 * An explicit `formFactor.rack` or legacy `meta.rackForm` wins for the frame.
 */
export function inferRackStandards(item: CatalogItem): InferredRack | undefined {
  if (item.category !== 'gpu-rack') return undefined;
  const declared = item.formFactor?.rack ?? rackFormFromMeta(item.meta?.rackForm);
  const cls = neutralRackClass(platformRackClass(item));
  const liquid = (item.cooling?.liquidFraction ?? 0) >= 0.5;
  if (cls === 'rack-scale-liquid') {
    const orw = declared === 'orw' || item.compute?.scaleUp?.kind === 'ualink' || /helios/i.test(item.id);
    if (orw) return { rackForm: 'orw', rackPower: 'dc-busbar-50v-hpr', liquid: true };
    return { rackForm: declared && declared !== 'orv3' && declared !== 'orv3-hpr' ? declared : 'orv3-mgx', rackPower: 'vendor-busbar', liquid: true };
  }
  const form = declared ?? 'eia-310-19';
  return { rackForm: form, rackPower: form === 'eia-310-19' ? 'ac-pdu' : 'vendor-busbar', liquid };
}

const unique = <T>(xs: T[]): T[] => [...new Set(xs)];

function airSide(h: Hall | undefined): AirSideKey {
  const s = h?.coolingPlacement?.crahStrategy ?? h?.layoutPolicy?.crahStrategy;
  if (s === 'gallery-fan-wall') return 'fan-wall';
  if (s === 'in-row') return 'in-row';
  return 'crah-perimeter';
}

function pinnedFor(rackForm: RackFormKey, rackPower: RackPowerKey): Partial<Record<StandardFamily, string[]>> {
  switch (rackForm) {
    case 'orv3-mgx':
      return { rack: ['orv3-base@1.1', 'vendor-rackscale-orv3-width@2024-10-15'] };
    case 'orw':
      return { rack: ['orw-base@1.0.0', 'orw-meta-design@1.0.0'], ...(rackPower === 'dc-busbar-50v-hpr' ? { 'rack-power': ['orv3-hpr-shelf-33kw@0.3'] } : {}) };
    case 'eia-310-19':
      return { rack: ['eia-310@e'] };
    case 'orv3':
    case 'orv3-hpr':
      return { rack: ['orv3-base@1.1', 'orv3-frame-meta@1.3'] };
    default:
      return {};
  }
}

interface HallInference {
  rackForm: RackFormKey;
  rackPower: RackPowerKey;
  liquid: LiquidProfile;
  air: AirSideKey;
}

function inferGroup(racks: InferredRack[], cduKW: number[], hall: Hall | undefined): HallInference {
  const forms = unique(racks.map((r) => r.rackForm));
  const powers = unique(racks.map((r) => r.rackPower));
  const rackForm: RackFormKey = forms.length === 1 ? forms[0] : 'mixed';
  const rackPower: RackPowerKey = powers.length === 1 ? powers[0] : 'vendor-busbar';
  const anyLiquid = racks.some((r) => r.liquid);
  const cduClass: CduClassKey = cduKW.length === 0 ? 'none' : Math.max(...cduKW) >= 1000 ? 'facility-2mw' : 'row-l2l';
  const liquid: LiquidProfile = anyLiquid || cduClass !== 'none'
    ? { connector: 'vendor', rackManifold: 'vendor', cduClass, cduRatingBasis: 'vendor', fluid: 'pg25' }
    : { connector: 'none', rackManifold: 'none', cduClass: 'none', fluid: 'treated-water' };
  return { rackForm, rackPower, liquid, air: airSide(hall) };
}

/**
 * Inferred profile of a legacy project (never a preset the user did not pick): strictness advisory, drafts hidden,
 * facility pre-check off (DO-6 for existing projects), `inferred: true`. Resolves catalog ids against builtin ∪ active
 * library ∪ project extensions. Halls whose own inference differs from the project value get a hall override on
 * `hall.standards` only through `inferHallOverrides` (not applied automatically).
 */
export function inferProfile(p: Project): StandardsProfile {
  return withCatalog(resolveCatalog(p), () => {
    const { racks, cduKW } = collect(p, undefined);
    const g = inferGroup(racks, cduKW, p.halls?.[0]);
    const preset = Object.values(STANDARDS_PRESETS).find((s) => s.rackForm === g.rackForm && s.rackPower === g.rackPower && s.liquid.connector === g.liquid.connector);
    const profile: StandardsProfile = {
      rackForm: g.rackForm,
      rackPower: g.rackPower,
      liquid: g.liquid,
      air: g.air,
      facilityPrecheck: 'off',
      strictness: 'advisory',
      includeDraftSpecs: false,
      pinned: pinnedFor(g.rackForm, g.rackPower),
      inferred: true,
    };
    if (preset?.id) profile.id = preset.id;
    return profile;
  });
}

/** Per-hall overrides for halls whose racks imply a different frame / power interface than the project profile. */
export function inferHallOverrides(p: Project, profile: StandardsProfile = p.standards ?? inferProfile(p)): Record<string, HallStandardsOverride> {
  return withCatalog(resolveCatalog(p), () => {
    const out: Record<string, HallStandardsOverride> = {};
    for (const h of p.halls ?? []) {
      const { racks, cduKW } = collect(p, h.id);
      if (!racks.length) continue;
      const g = inferGroup(racks, cduKW, h);
      if (g.rackForm !== profile.rackForm || g.rackPower !== profile.rackPower) out[h.id] = { rackForm: g.rackForm, rackPower: g.rackPower, liquid: g.liquid, pinned: pinnedFor(g.rackForm, g.rackPower), inferred: true };
    }
    return out;
  });
}

function collect(p: Project, hallId: string | undefined): { racks: InferredRack[]; cduKW: number[] } {
  const racks: InferredRack[] = [];
  const cduKW: number[] = [];
  const seen = new Map<string, CatalogItem | undefined>();
  for (const e of p.equipment ?? []) {
    if (hallId && e.hallId !== hallId) continue;
    if (!seen.has(e.catalogId)) seen.set(e.catalogId, findCatalogItem(e.catalogId));
    const item = seen.get(e.catalogId);
    if (!item) continue;
    if (item.category === 'gpu-rack') {
      const r = inferRackStandards(item);
      if (r) racks.push(r);
    } else if (item.category === 'cdu') cduKW.push(item.cdu?.ratedKW ?? item.capacity?.coolingKW ?? 0);
  }
  return { racks, cduKW };
}
