// Stream A (P1): standards registry, presets and P0 reference basis (OCP-DESIGN-PROPOSAL §2.1–2.2, §8.3, P0 impacts box).
import { describe, expect, it } from 'vitest';
import {
  findStandard,
  isDraftStatus,
  LEGACY_KEYS,
  mergeStandardsProfile,
  NEUTRAL_REFERENCE_BASIS,
  standardCitation,
  standardsChecksAdvisoryOnly,
  standardsPreset,
  STANDARDS_PRESET_IDS,
  STANDARDS_PRESETS,
  STANDARDS_REGISTRY,
  weakestStatus,
} from '../src/index.ts';

describe('standards registry', () => {
  it('ids are unique, pinned as key@version, and every entry carries title / version / url / licence / status / doc type', () => {
    const ids = STANDARDS_REGISTRY.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of STANDARDS_REGISTRY) {
      expect(s.id, s.id).toMatch(/^[a-z0-9][a-z0-9.-]*@[A-Za-z0-9.-]+$/);
      expect(s.title.length, s.id).toBeGreaterThan(3);
      expect(s.version.length, s.id).toBeGreaterThan(0);
      expect(s.url, s.id).toMatch(/^https:\/\//);
      expect(s.date, s.id).toMatch(/^$|^\d{4}(-\d{2}(-\d{2})?)?$/);
      expect(s.licence && s.status && s.docType, s.id).toBeTruthy();
      if (s.supersedes) expect(findStandard(s.supersedes), s.id).toBeTruthy();
    }
  });

  it('holds facts, not document text: notes stay short; no private paths or spec files are referenced', () => {
    for (const s of STANDARDS_REGISTRY) {
      expect((s.notes ?? '').length, s.id).toBeLessThanOrEqual(200);
      expect(JSON.stringify(s), s.id).not.toMatch(/docs\/research|docs\/legal|aidc-private|file:\/\//);
    }
  });

  it('ids and profile keys carry no organisation mark (internal keys; labels come from strings)', () => {
    for (const s of STANDARDS_REGISTRY) expect(s.id).not.toMatch(/ocp/i);
    expect(JSON.stringify(STANDARDS_PRESETS)).not.toMatch(/ocp/i);
    expect(JSON.stringify(NEUTRAL_REFERENCE_BASIS)).not.toMatch(/ocp/i);
    // legacy keys exist only as alias inputs
    expect(LEGACY_KEYS.standardLevels.every((k) => /^ocp-/.test(k))).toBe(true);
  });

  it('P0 statuses: ORW released, HPR v1 shelf draft, HPR V2 72 kW shelf under review and behind the drafts toggle, Diablo 0.7.0 pre-1.0 draft', () => {
    expect(findStandard('orw-base@1.0.0')?.status).toBe('accepted');
    expect(findStandard('orw-meta-design@1.0.0')?.status).toBe('accepted');
    expect(findStandard('orv3-hpr-shelf-33kw@0.3')?.status).toBe('draft');
    expect(findStandard('hpr-v2-shelf-72kw@1.0')?.status).toBe('review');
    expect(NEUTRAL_REFERENCE_BASIS.behindDraftsToggle).toContain('hpr-v2-shelf-72kw@1.0');
    expect(findStandard('diablo400@0.7.0')).toMatchObject({ status: 'draft', supersedes: 'diablo400@0.5.2' });
    expect(isDraftStatus('review')).toBe(true);
    expect(isDraftStatus('accepted')).toBe(false);
    expect(weakestStatus(['orv3-base@1.1', 'orv3-hpr-shelf-33kw@0.3'])).toBe('draft');
    expect(weakestStatus(['orv3-base@1.1'])).toBe('accepted');
    expect(weakestStatus([])).toBeUndefined();
    expect(standardCitation('orv3-base@1.1')).toBe('Open Rack V3 Base Specification Rev 1.1');
  });

  it('P0 reference basis: one frame (Meta ORv3 1.3), OAM 1000 W cap, 9 OU HPR zone, BBU end-of-life 90 s', () => {
    const b = NEUTRAL_REFERENCE_BASIS;
    expect(b.frame).toMatchObject({ standardId: 'orv3-frame-meta@1.3', widthMm: 600, depthMm: 1068, heightUnits: 44, payloadKg: 1400, itShelfKgPerSet: 80 });
    expect(findStandard(b.frame.standardId)).toBeTruthy();
    expect(b.dlcNode).toMatchObject({ moduleCapW: 1000, maxHeightUnits: 6, modules: 8 });
    expect(b.hprPowerZoneUnits).toBe(9);
    expect(b.bbu).toMatchObject({ eolBackupS: 90, bolBackupS: 240 });
    expect(b.adoptedRules).toEqual(['RK-03', 'CL-15', 'CL-16', 'PW-06']);
  });
});

describe('standards presets', () => {
  it('every pinned id exists; presets are advisory with drafts hidden', () => {
    expect(STANDARDS_PRESET_IDS).toEqual(['orv3-hpr-liquid', 'orw-liquid-sidecar', 'orv3-air-dhx', 'eia-air', 'eia-liquid-uqd']);
    for (const id of STANDARDS_PRESET_IDS) {
      const p = STANDARDS_PRESETS[id];
      expect(p.id).toBe(id);
      expect(p.strictness).toBe('advisory');
      expect(p.includeDraftSpecs).toBe(false);
      for (const ids of Object.values(p.pinned)) for (const sid of ids ?? []) expect(findStandard(sid), `${id} → ${sid}`).toBeTruthy();
    }
    expect(STANDARDS_PRESETS['orv3-hpr-liquid'].pinned.rack).toContain('orv3-frame-meta@1.3');
    expect(STANDARDS_PRESETS['orv3-hpr-liquid'].facilityPrecheck).toBe('facility-v2hs@1.15'); // DO-6
  });

  it('standardsPreset returns an independent copy; hall overrides merge field by field', () => {
    const a = standardsPreset('orv3-hpr-liquid');
    a.liquid.connector = 'uqd';
    expect(STANDARDS_PRESETS['orv3-hpr-liquid'].liquid.connector).toBe('bmqc');
    const merged = mergeStandardsProfile(standardsPreset('orv3-hpr-liquid'), { rackPower: 'hvdc-pm400-sidecar', liquid: { cduClass: 'facility-2mw' }, pinned: { 'rack-power': ['diablo400@0.7.0'] } });
    expect(merged.rackPower).toBe('hvdc-pm400-sidecar');
    expect(merged.liquid).toMatchObject({ connector: 'bmqc', cduClass: 'facility-2mw' });
    expect(merged.pinned.rack).toContain('orv3-base@1.1');
    expect(merged.pinned['rack-power']).toEqual(['diablo400@0.7.0']);
    expect(standardsChecksAdvisoryOnly(undefined)).toBe(true);
    expect(standardsChecksAdvisoryOnly({ ...merged, strictness: 'gate' })).toBe(false);
    expect(standardsChecksAdvisoryOnly({ ...merged, strictness: 'gate', inferred: true })).toBe(true);
  });
});
