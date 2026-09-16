// Stream A (P1) compatibility suite — OCP-DESIGN-PROPOSAL §8.3 "Migration / compatibility tests".
// Stored projects (read-only copies of data/projects/*.json and their version snapshots) load through upgradeProject with
// identical analysis results; legacy ids and enum keys resolve; inferred profiles follow the §2.5 table.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  analyzeProject,
  canonicalConnector,
  canonicalFacilityPrecheck,
  canonicalNicFormFactor,
  canonicalScaleUp,
  canonicalSeedNote,
  canonicalSpecSource,
  canonicalStandardLevel,
  canonicalTemplateGroup,
  CATALOG_ID_ALIASES,
  createNvidiaReferenceProject,
  effectiveStandardsProfile,
  findCatalogItem,
  findLayoutTemplate,
  getCatalogItem,
  inferHallOverrides,
  inferProfile,
  LAYOUT_TEMPLATES,
  LEGACY_KEYS,
  neutralRackClass,
  rackFormFromMeta,
  upgradeProject,
  type Project,
  type ProjectAnalysis,
} from '../src/index.ts';
import { termRe } from './guard-terms.ts';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const PROJECTS = join(REPO, 'data/projects');

/** Read-only copies: parsed from disk, never written back. */
function storedProjects(): { name: string; project: Project }[] {
  if (!existsSync(PROJECTS)) return [];
  const out: { name: string; project: Project }[] = [];
  for (const f of readdirSync(PROJECTS)) {
    const full = join(PROJECTS, f);
    if (f.endsWith('.json')) out.push({ name: f, project: JSON.parse(readFileSync(full, 'utf8')) });
    else if (f.endsWith('.versions')) {
      for (const v of readdirSync(full)) if (v.endsWith('.json') && v !== 'index.json') out.push({ name: `${f}/${v}`, project: JSON.parse(readFileSync(join(full, v), 'utf8')) });
    }
  }
  return out;
}

const stored = storedProjects();

/** Analysis without the timestamp; issues compared at severity ≥ warning by id + severity + subject. */
function fingerprint(a: ProjectAnalysis) {
  const { generatedAt: _g, issues, ...rest } = a;
  void _g;
  return {
    rest: JSON.stringify(rest),
    issues: issues
      .filter((i) => i.severity !== 'info')
      .map((i) => `${i.severity}|${i.id}|${(i as { equipmentIds?: string[] }).equipmentIds?.join(',') ?? ''}`)
      .sort(),
  };
}

describe('compat: stored projects (read-only copies of data/projects)', () => {
  it.skipIf(stored.length === 0)('found the stored project and its version snapshots', () => {
    expect(stored.length).toBeGreaterThan(1);
  });

  it.each(stored.map((s) => [s.name, s.project] as const))('%s: upgrade is pure, idempotent and analysis-neutral', (_name, raw) => {
    const before = JSON.stringify(raw);
    const up = upgradeProject(raw);
    expect(JSON.stringify(raw)).toBe(before); // input untouched
    expect(upgradeProject(up)).toBe(up); // idempotent (no change → same object)
    // round trip: save → load → save is byte-stable after the one-time standards block
    const again = upgradeProject(JSON.parse(JSON.stringify(up)) as Project);
    expect(JSON.stringify(again)).toBe(JSON.stringify(up));
    // Legacy files get an inferred advisory block; projects that already made an explicit standards choice keep it verbatim.
    if (raw.standards) expect(up.standards).toEqual(raw.standards);
    else {
      expect(up.standards?.inferred).toBe(true);
      expect(up.standards?.strictness).toBe('advisory');
      expect(up.standards?.facilityPrecheck).toBe('off');
    }
    const { standards: _s, halls: upHalls, notes: upNotes, ...upRest } = up;
    const { standards: _rawStandards, halls: rawHalls, notes: rawNotes, ...rawRest } = raw;
    void _s;
    void _rawStandards;
    expect(JSON.stringify(upRest)).toBe(JSON.stringify(rawRest));
    // listed change (QA ui-wording): the unedited retired seed note becomes the neutral seed note; every other note is untouched
    expect(upNotes).toEqual(rawNotes.map((n) => canonicalSeedNote(n)));
    expect(JSON.stringify(upNotes)).not.toMatch(termRe('<T>|<t>|<Tt>'));
    expect(upHalls.map((h) => ({ ...h, layoutPolicy: h.layoutPolicy && { ...h.layoutPolicy, templateId: 'x' } }))).toEqual(rawHalls.map((h) => ({ ...h, layoutPolicy: h.layoutPolicy && { ...h.layoutPolicy, templateId: 'x' } })));
    // identical analysis
    const a0 = fingerprint(analyzeProject(structuredClone(raw)));
    const a1 = fingerprint(analyzeProject(structuredClone(up)));
    expect(a1.rest).toBe(a0.rest);
    expect(a1.issues).toEqual(a0.issues);
  }, 300_000);

});

describe('compat: legacy ids', () => {
  it('has only current template ids when there are no projects to migrate', () => {
    const ids = LAYOUT_TEMPLATES.map((t) => t.id);
    expect(ids.join(' ')).not.toMatch(termRe('<t>', 'i'));
  });

  it('every current template id resolves unchanged', () => {
    for (const id of ['std-orv3-hpr-liquid-du', 'std-orv3-hpr-rackscale-du', 'std-orw-liquid-sidecar-du', 'std-eia-air-du', 'std-eia-liquid-uqd-du', 'rack-scale-liquid-du', 'nvidia-facilities-su', 'rcu-row', 'custom']) expect(findLayoutTemplate(id)?.id, id).toBe(id);
  });

  it('catalog aliases redirect only when the exact id is gone; vendor ids stay vendor instances', () => {
    for (const [legacy, target] of Object.entries(CATALOG_ID_ALIASES)) {
      const hit = findCatalogItem(legacy);
      if (hit) expect([legacy, target]).toContain(hit.id);
    }
    for (const id of ['network-rack-48u', 'vertiv-xdu2300', 'vertiv-cw375', 'nvidia-gb300-nvl72']) if (findCatalogItem(id)) expect(findCatalogItem(id)!.id).toBe(id);
    // stream B seeded the targets and removed the old estimate racks: the legacy ids now redirect
    for (const [legacy, target] of [['rack-orv3-44ou', 'rack-orv3'], ['rack-orw-44ou', 'rack-orw']]) expect(findCatalogItem(legacy)?.id).toBe(target);
  });

});

describe('compat: legacy enums', () => {
  it('map to the neutral keys', () => {
    expect(canonicalSpecSource(LEGACY_KEYS.specSources[0])).toBe('vendor-datasheet');
    expect(canonicalSpecSource('estimate')).toBe('estimate');
    expect(canonicalSpecSource('nonsense')).toBeUndefined();
    expect(canonicalNicFormFactor('ocp3')).toBe('nic3-sff');
    expect(canonicalNicFormFactor('pcie-hhhl')).toBe('pcie-hhhl');
    expect(canonicalScaleUp({ kind: 'xgmi', domainSize: 8, gbpsPerGpu: 896 })).toEqual({ kind: 'vendor-proprietary', family: 'Infinity Fabric', domainSize: 8, gbpsPerGpu: 896 });
    expect(neutralRackClass('nvidia-rack-scale')).toBe('rack-scale-liquid');
    expect(neutralRackClass('amd-rack-scale')).toBe('rack-scale-liquid');
    expect(neutralRackClass('hgx-ubb8')).toBe('accel-node-8x');
    expect(neutralRackClass('lpu-accelerator')).toBe('accelerator-appliance');
    expect(neutralRackClass('npu')).toBe('accel-node-pcie');
    expect(canonicalTemplateGroup('nvidia')).toBe('vendor-sample');
    expect(canonicalTemplateGroup('amd')).toBe('vendor-sample');
    expect(canonicalTemplateGroup('custom')).toBe('custom');
    expect(rackFormFromMeta('orv3-21')).toBe('orv3');
    expect(rackFormFromMeta('orw-double-wide')).toBe('orw');
    expect(rackFormFromMeta('eia-19')).toBe('eia-310-19');
    expect(canonicalConnector('lqc-dn25')).toBe('lqc');
    for (const legacy of LEGACY_KEYS.standardLevels) expect(canonicalStandardLevel(legacy)).not.toMatch(/ocp/i);
    for (const legacy of LEGACY_KEYS.facilityPrechecks) expect(canonicalFacilityPrecheck(legacy)).toMatch(/^facility-/);
  });

  it('an existing profile with legacy keys is canonicalised once', () => {
    const { project } = createNvidiaReferenceProject({ pods: 1 });
    const inferred = inferProfile(project);
    const legacy: Project = { ...project, standards: { ...inferred, liquid: { ...inferred.liquid, connector: 'lqc-dn25' as never }, facilityPrecheck: LEGACY_KEYS.facilityPrechecks[1] as never } };
    const up = upgradeProject(legacy);
    expect(up.standards?.liquid.connector).toBe('lqc');
    expect(up.standards?.facilityPrecheck).toBe('facility-v2hs@1.15');
    expect(upgradeProject(up)).toBe(up);
  });
});

describe('compat: inferred profiles (proposal §2.5)', () => {
  const withRacks = (swap: (catalogId: string, i: number) => string): Project => {
    const { project } = createNvidiaReferenceProject({ pods: 1 });
    let i = 0;
    return { ...project, standards: undefined, equipment: project.equipment.map((e) => (findCatalogItem(e.catalogId)?.category === 'gpu-rack' ? { ...e, catalogId: swap(e.catalogId, i++) } : e)) };
  };
  const helios = 'amd-helios-mi455x';

  it('rack-scale NVLink-class hall → contributed ORv3-width frame + vendor busbar, advisory, facility pre-check off', () => {
    const p = withRacks((id) => id);
    const s = inferProfile(p);
    expect(s).toMatchObject({ rackForm: 'orv3-mgx', rackPower: 'vendor-busbar', inferred: true, strictness: 'advisory', includeDraftSpecs: false, facilityPrecheck: 'off' });
    expect(s.shelfClass).toBeUndefined(); // no HPR shelf inference → no shelf findings on GB300 halls
    expect(upgradeProject(p).standards).toEqual(s);
  });

  it('8-GPU air node hall → EIA-310 + AC PDU', () => {
    const s = inferProfile(withRacks(() => 'hgx-b200-air-4x'));
    expect(s).toMatchObject({ rackForm: 'eia-310-19', rackPower: 'ac-pdu' });
  });

  it('ORW-class rack-scale hall → ORW', () => {
    expect(inferProfile(withRacks(() => helios)).rackForm).toBe('orw');
  });

  it('mixed hall → mixed', () => {
    const s = inferProfile(withRacks((id, i) => (i % 2 ? 'hgx-b200-air-4x' : id)));
    expect(s.rackForm).toBe('mixed');
    expect(s.rackPower).toBe('vendor-busbar');
  });

  it('hall overrides (field by field) and per-hall inference', () => {
    const p = upgradeProject(withRacks((id) => id));
    const hallId = p.halls[0].id;
    const withOverride: Project = { ...p, halls: p.halls.map((h, i) => (i === 0 ? { ...h, standards: { rackForm: 'orw', liquid: { cduClass: 'facility-2mw' } } } : h)) };
    const eff = effectiveStandardsProfile(withOverride, hallId)!;
    expect(eff.rackForm).toBe('orw');
    expect(eff.liquid.cduClass).toBe('facility-2mw');
    expect(eff.liquid.connector).toBe(p.standards!.liquid.connector);
    expect(eff.rackPower).toBe(p.standards!.rackPower);
    expect(inferHallOverrides(p)).toEqual({});
  });

  it('the reference project writes neutral template ids only', () => {
    const { project } = createNvidiaReferenceProject({ pods: 1 });
    for (const h of project.halls) if (h.layoutPolicy) expect(findLayoutTemplate(h.layoutPolicy.templateId)).toBeDefined();
  });
});

// QA ui-wording (2026-09-15): the stored live project and its snapshots still carried the retired generator's design-basis note, whose
// id and body name the retired blueprint. Only the byte-identical seed note is replaced; the stored copies supply it (no test re-spells it).
describe('compat: retired seed note', () => {
  const legacy = stored.flatMap((s) => s.project.notes ?? []).find((n) => canonicalSeedNote(n) !== n);

  it.skipIf(!legacy)('the unedited seed note becomes the sample seed note, once', () => {
    const n = legacy!;
    const up = canonicalSeedNote(n);
    expect(up).not.toBe(n);
    expect(JSON.stringify(up)).not.toMatch(termRe('<T>|<t>|<Tt>'));
    expect(canonicalSeedNote(up)).toBe(up);
    const sampleNote = createNvidiaReferenceProject().project.notes.find((x) => x.id === up.id);
    expect(sampleNote).toEqual(up);
  }, 300_000);

  it.skipIf(!legacy)('an edited copy of the seed note is left alone', () => {
    const n = legacy!;
    for (const edited of [{ ...n, body: `${n.body}\n- 추가 메모` }, { ...n, title: '설계 기준 (수정)' }, { ...n, id: 'note-user' }]) expect(canonicalSeedNote(edited)).toBe(edited);
    const p = { ...stored[0].project, notes: [{ ...n, body: `${n.body} ` }] } as Project;
    expect(upgradeProject(p).notes).toBe(p.notes);
  });
});
