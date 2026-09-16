// Stream E (P5): pure helpers of the web standards UI (apps/web/src/app/standardsUi.ts) and the `standards` locale namespace.
// Lives here because the root vitest config collects apps/server/test (not apps/web).
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TEMPLATE_ID, LAYOUT_TEMPLATES, STANDARDS_PRESET_IDS, createNvidiaReferenceProject, findCatalogItem, standardsPreset, type Issue,
} from '../../../packages/core/src/index.ts';
import {
  FACET_LABEL_KIND, PROFILE_FIELDS, PROFILE_FIELD_OPTIONS, STANDARDS_FACETS, confirmProfile, dataChangeParams, dataChangeSeenKey, draftHidden, facetValues,
  fieldOptions, groupStandardsIssues, hallOverrideField, matchesStandardsFilter, matchingPresetId, pendingDataChanges, profileFieldValue, profileFromPreset,
  setHallOverrideField, setProfileField, templatePickerEntries,
} from '../../web/src/app/standardsUi.ts';
import en from '../../web/src/i18n/locales/en/standards.ts';
import ko from '../../web/src/i18n/locales/ko/standards.ts';
import { catalogItems } from '../../../packages/core/src/index.ts';

const FORBIDDEN = /OCP Inspired|OCP (Accepted|Ready)(®|™)? (compliant|certified|approved)|OCP[- ]certified|OCP compliant|OCP mode|OCP Studio/i;

describe('profile selector helpers', () => {
  it('every preset matches itself; editing a field makes it custom, restoring it matches again; edits confirm the profile', () => {
    for (const id of STANDARDS_PRESET_IDS) expect(matchingPresetId(standardsPreset(id))).toBe(id);
    const inferred = { ...standardsPreset('orv3-hpr-liquid'), inferred: true };
    const custom = setProfileField(inferred, 'connector', 'lqc');
    expect(custom.inferred).toBeUndefined();
    expect(custom.id).toBeUndefined();
    expect(profileFieldValue(custom, 'connector')).toBe('lqc');
    const back = setProfileField(custom, 'connector', 'bmqc');
    expect(back.id).toBe('orv3-hpr-liquid');
    expect(confirmProfile(inferred).inferred).toBeUndefined();
    expect(inferred.inferred).toBe(true); // pure
  });

  it('presets keep the strictness and drafts toggles; optional fields unset with none', () => {
    const prev = { ...standardsPreset('eia-air'), strictness: 'gate' as const, includeDraftSpecs: true };
    const p = profileFromPreset('orv3-hpr-liquid', prev);
    expect(p).toMatchObject({ rackForm: 'orv3-hpr', strictness: 'gate', includeDraftSpecs: true });
    const noShelf = setProfileField(p, 'shelfClass', 'none');
    expect('shelfClass' in noShelf).toBe(false);
    expect(profileFieldValue(noShelf, 'shelfClass')).toBe('none');
  });

  it('draft options (72 kW shelf, ±400 VDC sidecar) stay behind the drafts toggle unless selected', () => {
    expect(fieldOptions('shelfClass', 'hpr-33kw', false).map((o) => o.value)).not.toContain('hpr-v2-72kw');
    expect(fieldOptions('shelfClass', 'hpr-33kw', true).find((o) => o.value === 'hpr-v2-72kw')?.draft).toBe(true);
    expect(fieldOptions('shelfClass', 'hpr-v2-72kw', false).map((o) => o.value)).toContain('hpr-v2-72kw');
    expect(fieldOptions('rackPower', 'ac-pdu', false).map((o) => o.value)).not.toContain('hvdc-pm400-sidecar');
  });

  it('hall overrides set and clear per field (liquid fields nest)', () => {
    let o = setHallOverrideField(undefined, 'rackForm', 'eia-310-19');
    o = setHallOverrideField(o, 'connector', 'uqd');
    expect(o).toEqual({ rackForm: 'eia-310-19', liquid: { connector: 'uqd' } });
    expect(hallOverrideField(o, 'connector')).toBe('uqd');
    o = setHallOverrideField(o, 'connector', undefined);
    expect(o).toEqual({ rackForm: 'eia-310-19' });
    expect(setHallOverrideField(o, 'rackForm', undefined)).toBeUndefined();
  });
});

describe('template picker filtered by the profile', () => {
  it('21-inch high-power profile: matching standard templates first, other rack forms hidden, current template kept', () => {
    const { entries, hidden } = templatePickerEntries('orv3-hpr', DEFAULT_TEMPLATE_ID, false);
    const ids = entries.map((e) => e.template.id);
    expect(ids[0]).toBe('std-orv3-hpr-liquid-du');
    expect(ids).toContain('std-orv3-hpr-rackscale-du');
    expect(ids).not.toContain('std-eia-air-du');
    expect(ids).not.toContain('amd-helios-su'); // variant of the wide-rack pod
    expect(templatePickerEntries('eia-310-19', 'std-eia-air-du', false).entries.map((e) => e.template.id)).not.toContain('amd-su-rail');
    expect(hidden).toBeGreaterThan(0);
    expect(entries.filter((e) => e.template.group === 'vendor-sample').length).toBe(LAYOUT_TEMPLATES.filter((t) => t.group === 'vendor-sample').length);
    const keep = templatePickerEntries('orv3-hpr', 'std-eia-air-du', false);
    expect(keep.entries.find((e) => e.template.id === 'std-eia-air-du')?.matches).toBe(false);
    expect(templatePickerEntries('orv3-hpr', DEFAULT_TEMPLATE_ID, true).hidden).toBe(0);
    expect(templatePickerEntries(undefined, DEFAULT_TEMPLATE_ID, false).hidden).toBe(0);
    expect(templatePickerEntries('orw', 'std-orw-liquid-sidecar-du', false).entries.find((e) => e.template.id === 'std-orw-liquid-sidecar-du')?.matches).toBe(true);
  });
});

describe('catalog standards filters', () => {
  it('declared facets only; the drafts toggle hides the 72 kW shelf and sidecar blocks', () => {
    const items = catalogItems();
    expect(facetValues(items, 'rackForm')).toEqual(expect.arrayContaining(['orv3', 'orw', 'eia-310-19']));
    const orw = findCatalogItem('rack-orw')!;
    expect(matchesStandardsFilter(orw, { rackForm: 'orw', specStatus: 'accepted' })).toBe(true);
    expect(matchesStandardsFilter(orw, { rackForm: 'eia-310-19' })).toBe(false);
    expect(items.filter((i) => matchesStandardsFilter(i, { level: 'open-spec' })).length).toBeGreaterThan(10);
    expect(draftHidden(findCatalogItem('pshelf-hpr-v2-72kw')!, false)).toBe(true);
    expect(draftHidden(findCatalogItem('pshelf-hpr-v2-72kw')!, true)).toBe(false);
    expect(draftHidden(findCatalogItem('pshelf-orv3-hpr-33kw')!, false)).toBe(false);
  });
});

describe('checks grouping and the one-time data notice', () => {
  it('groups standards findings by family (errors first), ignoring issues without a check', () => {
    const mk = (id: string, family: 'liquid' | 'rack', severity: Issue['severity'], ruleId: string): Issue => ({ id, severity, domain: 'cooling', message: id, check: { ruleId, family, basis: 'standard', verification: 'verified', naturalSeverity: severity } });
    const groups = groupStandardsIssues([mk('a', 'liquid', 'info', 'CL-08'), mk('b', 'rack', 'warning', 'RK-03'), mk('c', 'liquid', 'warning', 'CL-09'), { id: 'x', severity: 'error', domain: 'space', message: 'x' }]);
    expect(groups.map((g) => g.family)).toEqual(['rack', 'liquid']);
    expect(groups[1].issues.map((i) => i.id)).toEqual(['c', 'a']);
    expect(groupStandardsIssues([mk('a', 'liquid', 'info', 'CL-08')], { families: ['rack'] })).toEqual([]);
  });

  it('XDU2300 datasheet change: pending once per project, parameters from the change data', () => {
    const p = createNvidiaReferenceProject().project;
    const withXdu = { ...p, equipment: [...p.equipment, { ...p.equipment[0], id: 'probe-xdu', catalogId: 'vertiv-xdu2300' }] };
    const pending = pendingDataChanges(withXdu, []);
    expect(pending.map((c) => c.id)).toEqual(['xdu2300-datasheet-2026-09-15']);
    expect(pendingDataChanges(withXdu, [dataChangeSeenKey(withXdu.id, pending[0].id)])).toEqual([]);
    expect(dataChangeParams(pending[0])).toEqual({ beforeKW: '32', afterKW: '47.8', beforeKg: '1,569', afterKg: '1,793' });
  });
});

describe('standards locale namespace', () => {
  it('every field option and facet value has an EN and KO label', () => {
    for (const f of PROFILE_FIELDS) {
      expect(en[`standards.ui.field.${f}`], f).toBeTruthy();
      for (const v of PROFILE_FIELD_OPTIONS[f]) {
        expect(en[`standards.${f}.${v}`], `${f}.${v}`).toBeTruthy();
        expect(ko[`standards.${f}.${v}`], `${f}.${v}`).toBeTruthy();
      }
    }
    const items = catalogItems();
    for (const facet of STANDARDS_FACETS) for (const v of facetValues(items, facet)) expect(en[`standards.${FACET_LABEL_KIND[facet]}.${v}`], `${facet}.${v}`).toBeTruthy();
  });

  it('no mark in chips or labels, no forbidden wording, no raw level keys (the notice text is the only mark-bearing string)', () => {
    for (const dict of [en, ko]) {
      for (const [k, v] of Object.entries(dict)) {
        if (k === 'standards.ui.about.notice') continue;
        expect(v, k).not.toMatch(/\bOCP\b|Open Compute/);
        expect(v, k).not.toMatch(FORBIDDEN);
        expect(v, k).not.toMatch(/\bocp-(based|contributed-design|inspired-host)\b/);
      }
    }
    expect(en['standards.ui.about.notice']).toContain('not affiliated with, endorsed by or certified by');
  });
});
