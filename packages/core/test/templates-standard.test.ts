import { describe, expect, it } from 'vitest';
import {
  catalogItems,
  createEmptyProject,
  DEFAULT_NEW_PROJECT_PRESET,
  DEFAULT_TEMPLATE_ID,
  draftSpecVisibility,
  duPitchM,
  findCatalogItem,
  findLayoutTemplate,
  findNodeSpec,
  LAYOUT_TEMPLATES,
  neutralRackClass,
  platformEligibility,
  platformRackClass,
  profileMaxRackKW,
  rackClassOf,
  registeredPlatformIds,
  sidecarPlan,
  slotCandidates,
  slotEligibility,
  standardTemplateOf,
  standardTemplatesFor,
  templateEligibilityProfile,
  templateIdForPreset,
  templatesByGroup,
  type CatalogItem,
} from '../src/index.ts';
import { termRe } from './guard-terms.ts';

/**
 * Standard-based templates (stream D / P4; OCP-DESIGN-PROPOSAL §4.1–4.3, §8.3; DECISIONS-v2-2 §I DO-1, DO-2, DO-4, DO-9, DO-10).
 * Eligibility is decided by declared standards only; vendor platforms plug into standard templates as instances.
 */

const STANDARD_IDS = ['std-orv3-hpr-liquid-du', 'std-orv3-hpr-rackscale-du', 'std-orw-liquid-sidecar-du', 'std-eia-air-du', 'std-eia-liquid-uqd-du'];
const rules = (e: { reasons: { rule: string }[] } | undefined) => (e?.reasons ?? []).map((r) => r.rule);
const get = (id: string) => findCatalogItem(id)!;

describe('standard templates: registry', () => {
  it('lists interface templates first, then vendor samples and custom; the default is the 21-inch OU liquid pod', () => {
    expect(LAYOUT_TEMPLATES.slice(0, STANDARD_IDS.length).map((t) => t.id)).toEqual(STANDARD_IDS);
    expect(DEFAULT_TEMPLATE_ID).toBe('std-orv3-hpr-liquid-du');
    expect(templatesByGroup('standard').map((t) => t.id)).toEqual(STANDARD_IDS);
    expect(templatesByGroup('vendor-sample').map((t) => t.id)).toEqual(['rack-scale-liquid-du', 'nvidia-facilities-su', 'rcu-row']);
    expect(templatesByGroup('custom').map((t) => t.id)).toEqual(['custom']);
  });

  it('standard pods use generic classes only (rack, CDU, switches, default platform) and carry a profile and an eligibility rule', () => {
    for (const id of STANDARD_IDS) {
      const t = findLayoutTemplate(id)!;
      expect(t.group, id).toBe('standard');
      expect(t.profile?.rackForm, id).toBeDefined();
      for (const cid of [t.pod.gpuRackCatalogId, t.pod.cduCatalogId, t.pod.scaleOutSwitchCatalogId]) expect(get(cid).vendor, `${id} → ${cid}`).toBe('Generic');
      const slot = t.computeSlots[0];
      expect(slot.accepts, id).toBeDefined();
      expect(get(slot.defaultPlatform!).vendor, id).toBe('Generic');
      // the default platform is eligible for its own slot
      expect(platformEligibility(id, 'primary', slot.defaultPlatform!)?.eligible, id).toBe(true);
    }
  });

  it('wording: template names, ids and descriptions carry no standards-body mark or blueprint term', () => {
    for (const t of LAYOUT_TEMPLATES) {
      expect(`${t.id} ${t.name} ${t.description} ${t.notes ?? ''}`, t.id).not.toMatch(termRe('\\bOCP\\b|Open Compute|<t>', 'i'));
    }
  });

  it('does not expose retired vendor-named SU presets; only a cited reference architecture carries an SU unit', () => {
    for (const id of ['nvidia-hgx-su', 'amd-su-tree', 'amd-su-rail', 'amd-helios-su', 'nvidia-su-row', 'rack-scale-zoned-du']) expect(findLayoutTemplate(id), id).toBeUndefined();
    const nvidia = findLayoutTemplate('nvidia-facilities-su')!;
    expect(nvidia.referenceUnit).toMatchObject({ computeRacksPerUnit: 16 });
    expect(nvidia.referenceUnit?.platformIds).toContain('nvidia-vr-nvl72');
    expect(nvidia.defaults.servicesZone).toBe('support-hac');
    for (const id of ['rack-scale-liquid-du', 'nvidia-facilities-su', 'rcu-row', 'custom']) expect(standardTemplateOf(id), id).toBeUndefined();
  });

  it('DU pitch follows rack depth and the facility aisle minimums (no fixed 24 ft pitch on standard pods)', () => {
    const hpr = findLayoutTemplate('std-orv3-hpr-liquid-du')!;
    expect(duPitchM(hpr.pod, get(hpr.pod.gpuRackCatalogId).dims.d)).toBeCloseTo(2 * 1.068 + 1.2 + 1.4, 6);
    const air = findLayoutTemplate('std-eia-air-du')!;
    expect(duPitchM(air.pod, get(air.pod.gpuRackCatalogId).dims.d)).toBeCloseTo(2 * 1.2 + 1.2 + 1.5, 6);
    expect(hpr.defaults.corridors).toMatchObject({ coldAisleM: 1.4, hotAisleM: 1.2 });
    const sample = findLayoutTemplate('rack-scale-liquid-du')!;
    expect(duPitchM(sample.pod, get(sample.pod.gpuRackCatalogId).dims.d)).toBeCloseTo(7.3152, 6);
  });

  it('DO-10: the liquid pod rack holds 5 eight-module DLC nodes with at least 2 blind-mate connector pairs per node', () => {
    const rack = get(findLayoutTemplate('std-orv3-hpr-liquid-du')!.pod.gpuRackCatalogId);
    expect(rack.compute?.nodesPerRack).toBe(5);
    expect(rack.compute?.gpus).toBe(40);
    const node = findNodeSpec(rack.meta!.node as string)!;
    expect(node.liquidInterface?.connector).toBe('bmqc');
    expect((node.liquidInterface?.ports ?? 0) / 2).toBeGreaterThanOrEqual(2);
    expect(rack.power!.nameplateKW).toBeLessThanOrEqual(82.5);
  });
});

describe('slot eligibility by declared standards (§4.2, §8.3 matrix)', () => {
  it('a rack-scale NVLink-class instance is eligible for the rack-scale pod through its 21-inch-wide frame, not for the 19-inch air pod', () => {
    const e = platformEligibility('std-orv3-hpr-rackscale-du', 'primary', 'nvidia-gb300-nvl72');
    expect(e?.eligible).toBe(true);
    // undeclared liquid connector: a note, never a block
    expect(e?.notes.map((n) => n.rule)).toContain('connector');
    const air = platformEligibility('std-eia-air-du', 'primary', 'nvidia-gb300-nvl72');
    expect(air?.eligible).toBe(false);
    expect(rules(air)).toEqual(expect.arrayContaining(['rack-class', 'rack-form', 'rack-power', 'cooling']));
    for (const r of air!.reasons) {
      expect(r.en.length).toBeGreaterThan(10);
      expect(r.ko).toMatch(/[가-힣]/);
    }
  });

  it('8-module air node racks are eligible for the 19-inch air pod; the wide rack-scale system for the wide-rack pod only', () => {
    expect(platformEligibility('std-eia-air-du', 'primary', 'amd-mi300x-air-4x')?.eligible).toBe(true);
    expect(platformEligibility('std-eia-air-du', 'primary', 'ubb8-oam-air-eia48-4x')?.eligible).toBe(true);
    expect(platformEligibility('std-orw-liquid-sidecar-du', 'primary', 'amd-helios-mi455x')?.eligible).toBe(true);
    expect(rules(platformEligibility('std-orv3-hpr-liquid-du', 'primary', 'amd-helios-mi455x'))).toContain('rack-form');
    expect(rules(platformEligibility('std-orv3-hpr-rackscale-du', 'primary', 'amd-helios-mi455x'))).toContain('rack-form');
  });

  it('density: the profile limit of the high-power pod is 82.5 kW (3 × 27.5 kW at N+1, capped by the 93.5 kW three-set total)', () => {
    const hpr = findLayoutTemplate('std-orv3-hpr-liquid-du')!;
    expect(profileMaxRackKW(templateEligibilityProfile(hpr))).toBe(82.5);
    expect(profileMaxRackKW({ rackPower: 'dc-busbar-50v-hpr', shelfClass: 'hpr-33kw' }, 4)).toBe(93.5);
    const dense = platformEligibility('std-orv3-hpr-liquid-du', 'primary', 'rackscale-liquid-72');
    expect(rules(dense)).toEqual(['density']);
    expect(platformEligibility('std-orv3-hpr-liquid-du', 'primary', 'ubb8-oam-dlc-hpr-5x')?.eligible).toBe(true);
  });

  it('a pivoting blind-mate coupling is not auto-eligible for the 21-inch blind-mate manifold slot (fit not established)', () => {
    const hpr = findLayoutTemplate('std-orv3-hpr-liquid-du')!;
    const base = get('ubb8-oam-dlc-hpr-5x');
    const pbmc: CatalogItem = { ...base, id: 'probe-pbmc', liquidInterface: { ...base.liquidInterface!, connector: 'pbmc' } };
    const e = slotEligibility(hpr.computeSlots[0], pbmc, templateEligibilityProfile(hpr));
    expect(e.eligible).toBe(false);
    expect(rules(e)).toEqual(['connector']);
    // a UQD rack does not mate with the blind-mate manifold either, but fits the 19-inch UQD pod
    const uqd = get('ubb8-oam-dlc-uqd-eia48-5x');
    expect(rules(slotEligibility(hpr.computeSlots[0], uqd, templateEligibilityProfile(hpr)))).toEqual(expect.arrayContaining(['rack-form', 'connector']));
    expect(platformEligibility('std-eia-liquid-uqd-du', 'primary', uqd.id)?.eligible).toBe(true);
  });

  it('a 72 kW shelf for a power-rack busbar is not eligible on the high-power IT-rack busbar (and hidden behind the drafts toggle)', () => {
    const hpr = findLayoutTemplate('std-orv3-hpr-liquid-du')!;
    const shelf = get('pshelf-hpr-v2-72kw');
    const e = slotEligibility(hpr.computeSlots[0], shelf, templateEligibilityProfile(hpr));
    expect(rules(e)).toContain('shelf-generation');
    expect(e.hidden).toBe(true);
    // with a 72 kW shelf class declared by the profile the generation test passes (the shelf is still not a compute rack)
    const v2 = slotEligibility(hpr.computeSlots[0], shelf, { ...templateEligibilityProfile(hpr), shelfClass: 'hpr-v2-72kw', includeDraftSpecs: true });
    expect(rules(v2)).not.toContain('shelf-generation');
    expect(v2.hidden).toBe(false);
  });

  it('standard envelope notes never block: 8-module air racks above the module recommendation stay eligible with a note', () => {
    const e = platformEligibility('std-eia-air-du', 'primary', 'amd-mi300x-air-4x')!;
    expect(e.eligible).toBe(true);
    expect(e.notes.some((n) => n.rule === 'envelope')).toBe(true);
    const base = get('ubb8-oam-air-eia48-4x');
    const hot: CatalogItem = { ...base, id: 'probe-hot', accelModule: { standard: 'oam-2.0', tdpW: 1400, cooling: 'air' } };
    const h = slotEligibility(findLayoutTemplate('std-eia-air-du')!.computeSlots[0], hot, templateEligibilityProfile(findLayoutTemplate('std-eia-air-du')!));
    expect(h.eligible).toBe(true);
    expect(h.notes.filter((n) => n.rule === 'envelope').map((n) => n.en).join(' ')).toMatch(/1000 W/);
  });

  it('rack classes come from declared data; three NPU seeds differ from the legacy name rules on purpose', () => {
    const diffs: string[] = [];
    for (const it of catalogItems()) {
      if (it.category !== 'gpu-rack') continue;
      if (rackClassOf(it) !== neutralRackClass(platformRackClass(it))) diffs.push(`${it.id}:${rackClassOf(it)}`);
    }
    // 8 OAM modules per node → 8-module node class; wafer-scale and 2-module systems → appliance (the legacy rules said PCIe node)
    expect(diffs.sort()).toEqual(['cerebras-cs3-2x:accelerator-appliance', 'intel-gaudi3-air-4x:accel-node-8x', 'sambanova-sn40l-16:accelerator-appliance']);
  });

  it('candidates: registered + eligible first, then eligible, then ineligible with reasons; drafts-toggle items drop out', () => {
    const list = slotCandidates('std-eia-air-du', 'primary');
    const reg = new Set(registeredPlatformIds('std-eia-air-du', 'primary'));
    const firstIneligible = list.findIndex((c) => !c.eligible);
    expect(firstIneligible).toBeGreaterThan(0);
    expect(list.slice(firstIneligible).every((c) => !c.eligible && c.reasons.length > 0)).toBe(true);
    const firstUnregistered = list.findIndex((c) => !c.registered);
    expect(list.slice(0, firstUnregistered).every((c) => c.eligible && reg.has(c.catalogId))).toBe(true);
    expect(list.every((c) => !c.hidden)).toBe(true);
    // the default platform of the liquid pod is the only eligible generic rack there (the rack-scale archetype is too dense)
    expect(slotCandidates('std-orv3-hpr-liquid-du', 'primary').filter((c) => c.eligible).map((c) => c.catalogId)).toEqual(['ubb8-oam-dlc-hpr-5x']);
  });
});

describe('DO-4 draft visibility and DO-9 sidecar data', () => {
  it('high-power rack blocks show a draft chip; wide racks are released (no chip); the 72 kW shelf and the sidecar are behind the toggle', () => {
    expect(draftSpecVisibility(get('rack-orv3-hpr'))).toEqual({ hidden: false, draftChip: true });
    expect(draftSpecVisibility(get('pshelf-orv3-hpr-33kw'))).toEqual({ hidden: false, draftChip: true });
    expect(draftSpecVisibility(get('rack-orw'))).toEqual({ hidden: false, draftChip: false });
    for (const id of ['pshelf-hpr-v2-72kw', 'power-rack-pm400', 'busbar-pm400']) {
      expect(draftSpecVisibility(get(id)).hidden, id).toBe(true);
      expect(draftSpecVisibility(get(id), { includeDraftSpecs: true }).hidden, id).toBe(false);
    }
  });

  it('the wide-rack pod declares the sidecar option off by default, behind the drafts toggle; power racks are sized by input voltage', () => {
    const t = findLayoutTemplate('std-orw-liquid-sidecar-du')!;
    expect(t.sidecar).toMatchObject({ powerRackCatalogId: 'power-rack-pm400', behindDraftsToggle: true, defaultOn: false, standardId: 'diablo400@0.7.0' });
    expect(t.profile?.rackPower).toBe('dc-busbar-50v-hpr');
    const racks = Array.from({ length: 16 }, () => get('rackscale-liquid-72-wide').power!.nameplateKW);
    const at415 = sidecarPlan(racks, 415);
    expect(at415.ratingKW).toBe(1100);
    expect(at415.powerRacks).toBe(Math.ceil((16 * racks[0]) / 1100));
    expect(at415.linksPerRack.every((n) => n === 1)).toBe(true);
    expect(at415.maxAcCords).toBe(at415.powerRacks * 12);
    const at400 = sidecarPlan(racks, 400);
    expect(at400.ratingKW).toBe(718);
    expect(at400.powerRacks).toBe(Math.ceil((16 * racks[0]) / 718));
    // 3 × 245 kW at 400 V: 735 kW > 718 kW → two power racks (the PW-08 hand case of stream C)
    expect(sidecarPlan([245, 245, 245], 400).powerRacks).toBe(2);
    expect(sidecarPlan([245, 245, 245], 400, { linkKW: 50 }).totalLinks).toBe(15);
  });
});

describe('DO-1 new-project wizard: presets', () => {
  it('an empty site starts from the high-power liquid preset by default, with its standard template and aisle minimums', () => {
    expect(DEFAULT_NEW_PROJECT_PRESET).toBe('orv3-hpr-liquid');
    const p = createEmptyProject();
    expect(p.standards?.id).toBe('orv3-hpr-liquid');
    expect(p.standards?.inferred).toBeUndefined();
    expect(p.halls[0].layoutPolicy?.templateId).toBe('std-orv3-hpr-liquid-du');
    expect(p.halls[0].layoutPolicy?.corridors).toMatchObject({ coldAisleM: 1.4, hotAisleM: 1.2 });
    const air = createEmptyProject({ preset: 'eia-air' });
    expect(air.standards?.rackForm).toBe('eia-310-19');
    expect(air.halls[0].layoutPolicy?.templateId).toBe('std-eia-air-du');
    expect(air.halls[0].layoutPolicy?.corridors).toMatchObject({ coldAisleM: 1.5, hotAisleM: 1.2 });
    expect(air.equipment).toEqual([]);
  });

  it('every preset maps to a standard template', () => {
    expect(templateIdForPreset('orw-liquid-sidecar')).toBe('std-orw-liquid-sidecar-du');
    expect(templateIdForPreset('eia-liquid-uqd')).toBe('std-eia-liquid-uqd-du');
    expect(templateIdForPreset('orv3-air-dhx')).toBe(DEFAULT_TEMPLATE_ID);
    expect(standardTemplatesFor('eia-310-19').map((t) => t.id)).toEqual(['std-eia-air-du', 'std-eia-liquid-uqd-du']);
  });
});
