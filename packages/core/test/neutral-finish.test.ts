// Neutralization finish round (2026-09-15): regressions found by the app / leak QA passes.
//  1. Legacy `rotation` key without `rotationDeg` is migrated on load (the viewer's frontVector() produced a NaN camera).
//  2. Shipped strings (core sources + i18n locales) do not cite private research notes (docs/research is not published).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeProject, createNvidiaReferenceProject, frontVector, legacyRotationDeg, normalizeLoadedProject, type EquipmentInstance, type Project } from '../src/index.ts';
import { termRe } from './guard-terms.ts';

const ROOT = join(__dirname, '..', '..', '..');

describe('legacy rotation migration', () => {
  it('snaps the legacy `rotation` key to a right angle and defaults to 0', () => {
    expect(legacyRotationDeg({ rotation: 0 })).toBe(0);
    expect(legacyRotationDeg({ rotation: 90 })).toBe(90);
    expect(legacyRotationDeg({ rotation: -90 })).toBe(270);
    expect(legacyRotationDeg({ rotation: 452 })).toBe(90);
    expect(legacyRotationDeg({})).toBe(0);
    expect(legacyRotationDeg({ rotation: 'x' })).toBe(0);
  });

  it('normalizeLoadedProject fills rotationDeg only where it is missing, keeps clean projects identical and totals unchanged', () => {
    const { project } = createNvidiaReferenceProject();
    expect(normalizeLoadedProject(project)).toBe(project);
    const legacy: Project = structuredClone(project);
    const [a, b] = legacy.equipment;
    const la = a as EquipmentInstance & { rotation?: number };
    delete (la as Partial<EquipmentInstance>).rotationDeg;
    la.rotation = 180;
    const lb = b as EquipmentInstance & { rotation?: number };
    delete (lb as Partial<EquipmentInstance>).rotationDeg;
    const n = normalizeLoadedProject(legacy);
    expect(n).not.toBe(legacy);
    expect(n.equipment[0].rotationDeg).toBe(180);
    expect(n.equipment[1].rotationDeg).toBe(0);
    expect(n.equipment.slice(2)).toEqual(legacy.equipment.slice(2));
    for (const e of n.equipment) {
      const f = frontVector(e.rotationDeg);
      expect(Number.isFinite(f.x) && Number.isFinite(f.y)).toBe(true);
    }
    // restoring the original angles gives the same analysis as the reference project
    n.equipment[0] = { ...n.equipment[0], rotationDeg: project.equipment[0].rotationDeg };
    n.equipment[1] = { ...n.equipment[1], rotationDeg: project.equipment[1].rotationDeg };
    const t0 = analyzeProject(project);
    const t1 = analyzeProject(n);
    expect(t1.summary).toEqual(t0.summary);
  });
});

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe('shipped strings do not cite private research notes', () => {
  const NOTE = /\b(r2-(layout|platform|ops|models|eta)|site-design|spine-placement|network-sim|r4-model-gap)\.md\b/;
  const files = [
    ...walk(join(ROOT, 'packages/core/src')),
    ...walk(join(ROOT, 'packages/thermal/src')),
    ...walk(join(ROOT, 'apps/server/src')),
    ...walk(join(ROOT, 'apps/web/src')),
  ];

  it('no non-comment line names a private note', () => {
    const hits: string[] = [];
    for (const f of files) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
        const code = line.replace(/\s\/\/\s.*$/, '');
        if (NOTE.test(code)) hits.push(`${relative(ROOT, f)}:${i + 1}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it('no i18n locale string names the retired blueprint', () => {
    const hits = files.filter((f) => f.includes('/i18n/locales/')).filter((f) => termRe('\\b<T>\\b').test(readFileSync(f, 'utf8')));
    expect(hits.map((f) => relative(ROOT, f))).toEqual([]);
  });
});
