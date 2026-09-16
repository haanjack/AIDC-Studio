// Stream E (P5): pure helpers of the standards UI (profile selector, catalog standards filters, template picker filter, checks
// grouping, one-time catalog data notice). No React; unit-tested from apps/server/test/standards-ui-web.test.ts.
import {
  CHECK_FAMILY_ORDER, LAYOUT_TEMPLATES, STANDARDS_PRESET_IDS, catalogDataChangesFor, draftSpecVisibility, rackFormFromMeta, standardTemplateOf, standardsPreset,
  type CatalogDataChange, type CatalogItem, type HallStandardsOverride, type Issue, type LayoutTemplate, type Project, type Severity, type StandardsCheckDetail,
  type StandardsPresetId, type StandardsProfile,
} from '@aidc/core';

// ───────────────────────────── profile fields ─────────────────────────────

export const PROFILE_FIELD_OPTIONS = {
  rackForm: ['orv3-hpr', 'orv3', 'orw', 'eia-310-19', 'orv3-mgx', 'mixed'],
  rackPower: ['dc-busbar-50v-hpr', 'dc-busbar-48-54v', 'hvdc-pm400-sidecar', 'ac-pdu', 'vendor-busbar'],
  shelfClass: ['none', 'hpr-33kw', 'orv3-18kw', 'hpr-v2-72kw'],
  bbu: ['in-rack', 'none'],
  connector: ['bmqc', 'uqd', 'uqdb', 'pbmc', 'lqc', 'vendor', 'none'],
  rackManifold: ['orv3-blindmate', 'eia-vertical', 'vendor', 'none'],
  cduClass: ['row-l2l', 'facility-2mw', 'in-rack-rpu', 'none'],
  cduRatingBasis: ['none', 'l-lcdu-wp-r1', 'loop-reqs-4k', 'vendor'],
  fluid: ['pg25', 'treated-water', 'dielectric-1p'],
  fwsClass: ['none', 'W17', 'W27', 'W32', 'W40', 'W45', 'W+'],
  air: ['crah-perimeter', 'fan-wall', 'door-hx', 'in-row', 'none'],
  facilityPrecheck: ['facility-v2hs@1.15', 'facility-v1@1.5', 'off'],
} as const;

export type ProfileField = keyof typeof PROFILE_FIELD_OPTIONS;
export const PROFILE_FIELDS = Object.keys(PROFILE_FIELD_OPTIONS) as ProfileField[];
/** Fields a hall may override in the Layout panel. */
export const HALL_OVERRIDE_FIELDS: ProfileField[] = ['rackForm', 'rackPower', 'shelfClass', 'connector', 'cduClass', 'air', 'facilityPrecheck'];

const LIQUID_FIELDS: ReadonlySet<ProfileField> = new Set(['connector', 'rackManifold', 'cduClass', 'cduRatingBasis', 'fluid', 'fwsClass']);
/** Optional fields whose `none` / `off` value means "not set" (the key is removed). */
const UNSET_VALUE: Partial<Record<ProfileField, string>> = { shelfClass: 'none', cduRatingBasis: 'none', fwsClass: 'none' };
/** Options behind the drafts toggle (DO-4): the 72 kW shelf generation and the ±400 VDC sidecar plane. */
const DRAFT_OPTIONS: ReadonlySet<string> = new Set(['shelfClass:hpr-v2-72kw', 'rackPower:hvdc-pm400-sidecar']);

/** Option values of a field; draft options are dropped unless drafts are included or the value is the current one. */
export function fieldOptions(field: ProfileField, current: string | undefined, includeDrafts: boolean): { value: string; draft: boolean }[] {
  return PROFILE_FIELD_OPTIONS[field]
    .map((value) => ({ value: value as string, draft: DRAFT_OPTIONS.has(`${field}:${value}`) }))
    .filter((o) => !o.draft || includeDrafts || o.value === current);
}

export function profileFieldValue(p: StandardsProfile, field: ProfileField): string {
  if (LIQUID_FIELDS.has(field)) return ((p.liquid as unknown as Record<string, string | undefined>)[field] ?? UNSET_VALUE[field] ?? 'none');
  if (field === 'shelfClass') return p.shelfClass ?? 'none';
  if (field === 'bbu') return p.bbu ?? 'none';
  if (field === 'facilityPrecheck') return p.facilityPrecheck ?? 'off';
  return (p as unknown as Record<string, string>)[field];
}

const PRESET_COMPARE = (p: StandardsProfile) => JSON.stringify([
  p.rackForm, p.rackPower, p.shelfClass ?? null, p.bbu ?? null, p.liquid.connector, p.liquid.rackManifold, p.liquid.cduClass, p.liquid.cduRatingBasis ?? null,
  p.liquid.fluid, p.liquid.fwsClass ?? null, p.air, p.facilityPrecheck ?? null,
]);

/** Preset whose technical fields equal the profile's (strictness, drafts and pinned documents are not compared). */
export function matchingPresetId(p: StandardsProfile): StandardsPresetId | undefined {
  const key = PRESET_COMPARE(p);
  return STANDARDS_PRESET_IDS.find((id) => PRESET_COMPARE(standardsPreset(id)) === key);
}

/** A preset as a confirmed profile, keeping the user's strictness and drafts toggles. */
export function profileFromPreset(id: StandardsPresetId, prev?: StandardsProfile): StandardsProfile {
  const p = standardsPreset(id);
  return { ...p, strictness: prev?.strictness ?? p.strictness, includeDraftSpecs: prev?.includeDraftSpecs ?? p.includeDraftSpecs };
}

/** The same profile, confirmed (standards findings leave the info-only cap). */
export function confirmProfile(p: StandardsProfile): StandardsProfile {
  const { inferred: _inferred, ...rest } = p;
  void _inferred;
  return rest;
}

/** Set one field (any edit confirms the profile); the preset id follows the new values. */
export function setProfileField(p: StandardsProfile, field: ProfileField, value: string): StandardsProfile {
  const next = confirmProfile(structuredClone(p));
  const unset = UNSET_VALUE[field] === value;
  if (LIQUID_FIELDS.has(field)) {
    const liquid = next.liquid as unknown as Record<string, string>;
    if (unset) delete liquid[field];
    else liquid[field] = value;
  } else if (unset) delete (next as unknown as Record<string, unknown>)[field];
  else (next as unknown as Record<string, string>)[field] = value;
  const id = matchingPresetId(next);
  if (id) next.id = id;
  else delete next.id;
  return next;
}

export function hallOverrideField(o: HallStandardsOverride | undefined, field: ProfileField): string | undefined {
  if (!o) return undefined;
  if (LIQUID_FIELDS.has(field)) return (o.liquid as Record<string, string | undefined> | undefined)?.[field];
  return (o as unknown as Record<string, string | undefined>)[field];
}

/** Set or clear (`undefined`) one hall override field; returns undefined when nothing is overridden any more. */
export function setHallOverrideField(o: HallStandardsOverride | undefined, field: ProfileField, value: string | undefined): HallStandardsOverride | undefined {
  const next: HallStandardsOverride = structuredClone(o ?? {});
  if (LIQUID_FIELDS.has(field)) {
    const liquid = { ...(next.liquid ?? {}) } as Record<string, string>;
    if (value === undefined) delete liquid[field];
    else liquid[field] = value;
    if (Object.keys(liquid).length) next.liquid = liquid as HallStandardsOverride['liquid'];
    else delete next.liquid;
  } else if (value === undefined) delete (next as Record<string, unknown>)[field];
  else (next as Record<string, unknown>)[field] = value;
  return Object.keys(next).length ? next : undefined;
}

// ───────────────────────────── catalog standards filters ─────────────────────────────

export type StandardsFacet = 'rackForm' | 'rackPower' | 'connector' | 'cduClass' | 'level' | 'specStatus' | 'verification';
export const STANDARDS_FACETS: StandardsFacet[] = ['rackForm', 'rackPower', 'connector', 'cduClass', 'level', 'specStatus', 'verification'];
/** Label kind (`standards.<kind>.<value>`) of each facet's values. */
export const FACET_LABEL_KIND: Record<StandardsFacet, string> = {
  rackForm: 'rackForm', rackPower: 'rackPowerInterface', connector: 'connector', cduClass: 'cduClass', level: 'level', specStatus: 'status', verification: 'verification',
};
export type StandardsFilter = Partial<Record<StandardsFacet, string>>;

/** Declared values of an item for a facet (never inferred from names or vendor ids). */
export function itemFacetValues(item: CatalogItem, facet: StandardsFacet): string[] {
  switch (facet) {
    case 'rackForm': {
      const f = item.formFactor?.rack ?? rackFormFromMeta(item.meta?.rackForm as string | undefined);
      return f ? [f] : [];
    }
    case 'rackPower': return item.rackPower?.interface ? [item.rackPower.interface] : [];
    case 'connector': return item.liquidInterface?.connector ? [item.liquidInterface.connector] : [];
    case 'cduClass': return item.cdu?.class ? [item.cdu.class] : [];
    case 'level': return [...new Set((item.standards ?? []).map((s) => s.level))];
    case 'specStatus': return item.specStatus ? [item.specStatus] : [];
    case 'verification': return [...new Set([...(item.standards ?? []).map((s) => s.verification), ...Object.values(item.paramSources ?? {}).map((p) => p.verification)])];
  }
}

/** Values present in a list of items for a facet (stable order of first appearance within the label table order). */
export function facetValues(items: readonly CatalogItem[], facet: StandardsFacet): string[] {
  const seen = new Set<string>();
  for (const it of items) for (const v of itemFacetValues(it, facet)) seen.add(v);
  return [...seen].sort();
}

export function matchesStandardsFilter(item: CatalogItem, filter: StandardsFilter): boolean {
  for (const facet of STANDARDS_FACETS) {
    const want = filter[facet];
    if (!want || want === 'all') continue;
    if (!itemFacetValues(item, facet).includes(want)) return false;
  }
  return true;
}

/** DO-4: hidden behind the drafts toggle. */
export const draftHidden = (item: CatalogItem, includeDrafts: boolean): boolean => draftSpecVisibility(item, { includeDraftSpecs: includeDrafts }).hidden;

// ───────────────────────────── template picker ─────────────────────────────

/** Rack forms whose standard templates fit a profile rack form (21-inch high-power and plain OU pods share the frame; a vendor rack-scale frame fits the rack-scale pod). */
const FORM_COMPAT: Record<string, string[]> = {
  orv3: ['orv3', 'orv3-hpr'],
  'orv3-hpr': ['orv3-hpr', 'orv3'],
  'orv3-mgx': ['orv3-mgx', 'orv3-hpr'],
  orw: ['orw'],
  'eia-310-19': ['eia-310-19'],
};

/** The rack form a template assumes (its standard base's profile), if any. */
export const templateRackForm = (t: LayoutTemplate): string | undefined => (standardTemplateOf(t)?.profile ?? t.profile)?.rackForm;

/** Standard templates are filtered by the profile rack form; vendor samples and custom always match. */
export function templateMatchesProfile(t: LayoutTemplate, rackForm: string | undefined): boolean {
  if (t.group !== 'standard') return true;
  const form = templateRackForm(t);
  if (!rackForm || rackForm === 'mixed' || !form) return true;
  return (FORM_COMPAT[rackForm] ?? [rackForm]).includes(form);
}

const GROUP_RANK = (t: LayoutTemplate) => (t.group === 'standard' ? 0 : t.group === 'custom' ? 2 : 1);

/**
 * Picker entries: matching standard templates first, then explicitly labelled vendor samples and custom.
 */
export function templatePickerEntries(rackForm: string | undefined, currentId: string, showAll: boolean, templates: readonly LayoutTemplate[] = LAYOUT_TEMPLATES): { entries: { template: LayoutTemplate; matches: boolean }[]; hidden: number } {
  const all = templates.map((template, i) => ({ template, matches: templateMatchesProfile(template, rackForm), i }));
  const shown = all.filter((e) => e.matches || showAll || e.template.id === currentId);
  shown.sort((a, b) => Number(b.matches) - Number(a.matches) || GROUP_RANK(a.template) - GROUP_RANK(b.template) || a.i - b.i);
  return { entries: shown.map(({ template, matches }) => ({ template, matches })), hidden: all.length - shown.length };
}

// ───────────────────────────── checks ─────────────────────────────

const SEV_RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/** Standards findings (issues carrying `check`), optionally restricted to families / a hall, grouped in family order. */
export function groupStandardsIssues(issues: readonly Issue[], opts: { families?: readonly StandardsCheckDetail['family'][]; hallId?: string } = {}): { family: StandardsCheckDetail['family']; issues: Issue[] }[] {
  const list = issues.filter((i) => i.check && (!opts.families || opts.families.includes(i.check.family)) && (!opts.hallId || !i.refs?.length || i.refs.includes(opts.hallId) || i.id.endsWith(opts.hallId)));
  return CHECK_FAMILY_ORDER.map((family) => ({
    family,
    issues: list.filter((i) => i.check!.family === family).sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || a.check!.ruleId.localeCompare(b.check!.ruleId)),
  })).filter((g) => g.issues.length);
}

export function severityCounts(issues: readonly Issue[]): { e: number; w: number; i: number } {
  return { e: issues.filter((x) => x.severity === 'error').length, w: issues.filter((x) => x.severity === 'warning').length, i: issues.filter((x) => x.severity === 'info').length };
}

// ───────────────────────────── one-time catalog data notice ─────────────────────────────

/** Browser storage key (per viewer): list of `<projectId>|<changeId>` already shown. */
export const DATA_CHANGE_SEEN_KEY = 'aidc:catalogDataChangesSeen';
export const dataChangeSeenKey = (projectId: string, changeId: string) => `${projectId}|${changeId}`;

/** Intentional catalog value changes that affect the project and were not shown to this viewer yet. */
export function pendingDataChanges(project: Pick<Project, 'id' | 'equipment' | 'cooling'>, seen: Iterable<string>): CatalogDataChange[] {
  const s = new Set(seen);
  return catalogDataChangesFor(project).filter((c) => !s.has(dataChangeSeenKey(project.id, c.id)));
}

/** Message parameters `{beforeKW} {afterKW} {beforeKg} {afterKg}` from the change's fields. */
export function dataChangeParams(c: CatalogDataChange): Record<string, string> {
  const kw = c.fields.find((f) => f.unit === 'kW');
  const kg = c.fields.find((f) => f.unit === 'kg');
  const fmt = (v: number | undefined) => (v === undefined ? '—' : v.toLocaleString('en-US', { maximumFractionDigits: 1 }));
  return { beforeKW: fmt(kw?.before), afterKW: fmt(kw?.after), beforeKg: fmt(kg?.before), afterKg: fmt(kg?.after) };
}
