import { describe, expect, it } from 'vitest';
import { composeRack, findNodeSpec, getCatalogItem, moveRackComponent, placeRackComponents, rackComponentsFor, type RackComponent } from '../src/index.ts';

const node = findNodeSpec('hgx-b300-node')!; // 10 U
const sw = getCatalogItem('nvidia-sn5600');

describe('rack component placement (T5, F7)', () => {
  const comps = (): RackComponent[] => rackComponentsFor({ node, nodesPerRack: 3, switches: [{ item: sw, count: 2 }], powerShelves: { count: 4, ratingKW: 33 } });

  it('auto-places deterministically: shelves bottom/top, switches centred, nodes fill', () => {
    const a = placeRackComponents(comps(), 48);
    const b = placeRackComponents(comps(), 48);
    expect(a).toEqual(b);
    expect(a.issues).toEqual([]);
    const u = Object.fromEntries(a.placed.map((p) => [p.id, p.u]));
    expect([u['ps-1'], u['ps-2']]).toEqual([1, 2]);
    expect([u['ps-3'], u['ps-4']]).toEqual([48, 47]);
    const swU = sw.switch!.rackUnits;
    const ideal = Math.floor((48 - 2 * swU) / 2) + 1;
    expect(u[`sw-${sw.id}-1`]).toBe(ideal);
    expect(u[`sw-${sw.id}-2`]).toBe(ideal + swU);
    expect(u['node-1']).toBe(3);
    // no two blocks share a unit; free ranges + used = capacity
    const taken = new Set<number>();
    for (const p of a.placed) for (let k = p.u!; k < p.u! + p.units; k++) { expect(taken.has(k)).toBe(false); taken.add(k); }
    expect(a.usedU + a.free.reduce((s, f) => s + f.units, 0)).toBe(48);
  });

  it('flags overflow and overlap', () => {
    const many = rackComponentsFor({ node, nodesPerRack: 5, switches: [{ item: sw, count: 1 }] });
    const over = placeRackComponents(many, 42);
    expect(over.issues.some((i) => i.kind === 'overflow')).toBe(true);
    expect(over.placed.filter((p) => p.conflict === 'overflow').every((p) => p.u == null)).toBe(true);
    const clash = placeRackComponents(comps(), 48, { 'node-1': 10, 'node-2': 15 });
    expect(clash.issues.find((i) => i.kind === 'overlap')?.ids.sort()).toEqual(['node-1', 'node-2']);
    const out = placeRackComponents(comps(), 48, { 'node-1': 45 });
    expect(out.placed.find((p) => p.id === 'node-1')!.conflict).toBe('overflow');
  });

  it('moves a component into free space or swaps with its neighbour', () => {
    const c = comps();
    const base = Object.fromEntries(placeRackComponents(c, 48).placed.map((p) => [p.id, p.u!]));
    // node-1 (U3) directly under node-2 (U13): swap
    const swapped = moveRackComponent(c, 48, {}, 'node-1', 1);
    expect(swapped['node-2']).toBe(base['node-1']);
    expect(swapped['node-1']).toBe(base['node-1'] + node.rackUnits);
    expect(placeRackComponents(c, 48, swapped).issues).toEqual([]);
    // a shelf at U1 cannot go below 1
    expect(moveRackComponent(c, 48, {}, 'ps-1', -1)['ps-1']).toBe(1);
  });

  it('composeRack stores explicit positions and rejects invalid layouts', () => {
    const r = composeRack({ node, nodesPerRack: 3, switches: [{ item: sw, count: 2 }], powerShelves: { count: 4, ratingKW: 33, weightKg: 12 } });
    const pos = r.meta!.positions as Record<string, number>;
    expect(pos['ps-1']).toBe(1);
    expect(r.meta!.ruUsed).toBe(3 * 10 + 2 * sw.switch!.rackUnits + 4);
    expect(r.weightKg).toBeCloseTo(170 + 3 * node.weightKg + 2 * sw.weightKg + 4 * 12, 6);
    const again = composeRack({ node, nodesPerRack: 3, switches: [{ item: sw, count: 2 }], powerShelves: { count: 4, ratingKW: 33, weightKg: 12 }, positions: pos });
    expect(again.meta!.umap).toEqual(r.meta!.umap);
    expect(() => composeRack({ node, nodesPerRack: 3, positions: { 'node-1': 5, 'node-2': 6 } })).toThrow(/overlaps/);
  });
});
