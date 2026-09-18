import { describe, expect, it } from 'vitest';
import { comparePlatformsForDisplay, platformSummary } from '../src/layout/templates/eligibility.ts';
import { findCatalogItem } from '../src/catalog/catalog.ts';

const get = (id: string) => {
  const it = findCatalogItem(id);
  expect(it, id).toBeDefined();
  return it!;
};

describe('platform display order is vendor-neutral', () => {
  it('puts generic classes first and orders vendor instances alphabetically, with no vendor ranking', () => {
    const ids = ['nvidia-gb300-nvl72', 'amd-helios-mi455x', 'rackscale-liquid-72', 'ubb8-oam-dlc-hpr-5x', 'hgx-b200-air-4x', 'amd-mi355x-dlc-4x'];
    const sorted = ids.map(get).sort(comparePlatformsForDisplay);
    const firstVendor = sorted.findIndex((x) => x.vendor !== 'Generic');
    expect(firstVendor, 'at least one generic class leads the list').toBeGreaterThan(0);
    // every generic class precedes every vendor instance
    expect(sorted.slice(0, firstVendor).every((x) => x.vendor === 'Generic')).toBe(true);
    expect(sorted.slice(firstVendor).every((x) => x.vendor !== 'Generic')).toBe(true);
    // inside each group the order is by name only — not a vendor table
    const names = sorted.slice(firstVendor).map((x) => x.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it('is symmetric and never prefers one vendor over another', () => {
    const nv = get('nvidia-gb300-nvl72');
    const amd = get('amd-helios-mi455x');
    expect(Math.sign(comparePlatformsForDisplay(nv, amd))).toBe(-Math.sign(comparePlatformsForDisplay(amd, nv)));
    // both are vendor instances, so neither is promoted by group
    expect(comparePlatformsForDisplay(nv, amd)).toBe(nv.name.localeCompare(amd.name));
  });
});

describe('platform summary states the class in planner units', () => {
  it('describes a node-class rack by accelerators per node, nodes, cooling, rack form and kW', () => {
    const s = platformSummary(get('ubb8-oam-dlc-hpr-5x'));
    expect(s.plain).toMatch(/8 accelerators\/node/);
    expect(s.plain).toMatch(/5 nodes/);
    expect(s.plain).toMatch(/kW\/rack/);
    expect(s.className).toBe('8-module accelerator node rack');
    expect(s.specs.length, 'declared specification designations are exposed as annotation').toBeGreaterThan(0);
  });

  it('describes a rack-scale domain by its accelerator count', () => {
    expect(platformSummary(get('nvidia-gb300-nvl72')).plain).toMatch(/72 accelerators in one rack/);
  });

  it('localises to Korean without vendor names in the class wording', () => {
    const s = platformSummary(get('ubb8-oam-dlc-hpr-5x'), 'ko');
    expect(s.plain).toMatch(/노드당 가속기 8개/);
    expect(s.plain).not.toMatch(/NVIDIA|AMD/i);
  });
});

describe('vendor balance rests on declared data, not on curation', () => {
  it('the leading NVIDIA and AMD rack-scale systems implement the same generic class', () => {
    const nv = platformSummary(get('nvidia-gb300-nvl72'));
    const amd = platformSummary(get('amd-helios-mi455x'));
    expect(nv.classId).toBe('rackscale-liquid-72');
    expect(amd.classId).toBe(nv.classId);
    expect(nv.className).toBe(amd.className);
  });

  it('records why the two cannot share one template: they declare different rack forms', () => {
    expect(get('nvidia-gb300-nvl72').formFactor?.rack).toBe('orv3-mgx');
    expect(get('amd-helios-mi455x').formFactor?.rack).toBe('orw');
  });
});
