// P6 guard (OCP-DESIGN-PROPOSAL §8.3 "engine-fallback-guard.test.ts"): engines and layout code never fall back to a vendor catalog
// instance. Vendor ids may appear only in `layout/samples/` (vendor sample factory), `catalog/aliases.ts` (not scanned) and in the
// explicit data tables listed in ALLOW below, each with its reason. The allowlist is tight both ways: an id not listed fails, and a
// listed id that no longer appears in its file fails too, so the list shrinks when a table moves into item data.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LAYOUT_TEMPLATES, catalogItems } from '../src/index.ts';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const SCAN_DIRS = ['packages/core/src/engines', 'packages/core/src/layout'];
const SCAN_FILES = ['apps/web/src/app/derived.ts'];
const EXEMPT_PREFIXES = ['packages/core/src/layout/samples/'];

/** Neutral vendors: generic blocks and unbranded OEM planning archetypes (unless the id names a vendor platform). */
const VENDOR_PLATFORM_ID = /^(nvidia|amd|hgx|dgx|mgx|vertiv|drivenets|broadcom|arista|cisco|juniper|dell|hpe|supermicro|intel|groq|cerebras|sambanova|rebellions|furiosa|hyperaccel|tenstorrent|google|coolit|motivair|boyd)-/;
const isVendorItem = (i: { id: string; vendor?: string }) => !/^(Generic|OEM)$/.test(i.vendor ?? '') || VENDOR_PLATFORM_ID.test(i.id);

const ALLOW: Record<string, { ids: string[]; reason: string }> = {
  'packages/core/src/engines/maxq.ts': {
    ids: ['nvidia-vr-nvl72', 'nvidia-gb200-nvl72'],
    reason: 'published per-model MaxLPS provisioning values (vendor data table keyed by instance, C open item), not a fallback',
  },
  'packages/core/src/engines/network.ts': {
    ids: ['nvidia-q3400', 'nvidia-qm9700', 'nvidia-sn5600', 'nvidia-sn5400', 'drivenets-5300r', 'drivenets-2500s', 'drivenets-9300f', 'broadcom-th5-64x800'],
    reason: 'vendor fabric technologies (InfiniBand, Spectrum-X, DDC, ESE) map to their own vendor instance; generic Ethernet fabrics use generic classes (NW-04); DDC fallback specs used only when the catalog lacks the id',
  },
  'packages/core/src/engines/powerPaths.ts': {
    ids: ['nvidia-gb300-nvl72'],
    reason: 'published rack power-shelf arrangement of one vendor rack (data table; generic racks declare shelves through item data)',
  },
  'packages/core/src/layout/templates/index.ts': {
    ids: ['nvidia-gb300-nvl72', 'nvidia-vr-nvl72', 'amd-helios-mi455x'],
    reason: 'template registry data: vendor-shape templates register their platforms (DECISIONS-v2-2 §E2), listed side by side for every vendor so no one of them is routed differently; generic std-* templates are checked below',
  },
};

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) tsFiles(p, out);
    else if (/\.tsx?$/.test(n)) out.push(p);
  }
  return out;
}

describe('P6 engine fallback guard: no vendor catalog id literals in engines / layout', () => {
  const vendorIds = new Set(catalogItems().filter(isVendorItem).map((i) => i.id));
  const files = [...SCAN_DIRS.flatMap((d) => tsFiles(join(REPO, d))), ...SCAN_FILES.map((f) => join(REPO, f))]
    .map((abs) => relative(REPO, abs).split('\\').join('/'))
    .filter((rel) => !EXEMPT_PREFIXES.some((p) => rel.startsWith(p)));

  const found = new Map<string, Set<string>>();
  const hits: string[] = [];
  for (const rel of files) {
    const lines = readFileSync(join(REPO, rel), 'utf8').split('\n');
    lines.forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
      for (const m of line.matchAll(/(['"`])([a-z0-9][a-z0-9.+-]*)\1/g)) {
        if (!vendorIds.has(m[2])) continue;
        if (!found.has(rel)) found.set(rel, new Set());
        found.get(rel)!.add(m[2]);
        if (!ALLOW[rel]?.ids.includes(m[2])) hits.push(`${rel}:${i + 1}: ${m[2]}`);
      }
    });
  }

  it('the vendor id set is meaningful and the scan covers engines, layout and the web derived map', () => {
    expect(vendorIds.size).toBeGreaterThan(40);
    for (const id of ['nvidia-gb300-nvl72', 'vertiv-xdu2300', 'amd-helios-mi455x']) expect(vendorIds.has(id), id).toBe(true);
    for (const id of ['generic-roce-400', 'network-rack-48u', 'rack-orv3']) expect(vendorIds.has(id), id).toBe(false);
    expect(files).toContain('packages/core/src/layout/fit.ts');
    expect(files).toContain('packages/core/src/layout/coolingPlacement.ts');
    expect(files).toContain('apps/web/src/app/derived.ts');
  });

  it('no vendor id literal outside samples and the reasoned allowlist', () => {
    expect(hits).toEqual([]);
  });

  it('the allowlist has no stale entries', () => {
    const stale = Object.entries(ALLOW).flatMap(([rel, { ids, reason }]) => {
      expect(reason.length, rel).toBeGreaterThan(20);
      return ids.filter((id) => !found.get(rel)?.has(id)).map((id) => `${rel}: ${id}`);
    });
    expect(stale).toEqual([]);
  });

  it('generic standard templates (std-*) default to generic instances only', () => {
    const std = LAYOUT_TEMPLATES.filter((t) => t.id.startsWith('std-'));
    expect(std.length).toBeGreaterThanOrEqual(5);
    const bad: string[] = [];
    for (const t of std) {
      for (const [k, v] of Object.entries(t.pod ?? {})) if (typeof v === 'string' && vendorIds.has(v)) bad.push(`${t.id}.pod.${k}=${v}`);
      for (const k of ['networkRackCatalogId', 'storageRackCatalogId', 'cpuRackCatalogId', 'mgmtRackCatalogId'] as const) {
        const v = (t as unknown as Record<string, unknown>)[k];
        if (typeof v === 'string' && vendorIds.has(v)) bad.push(`${t.id}.${k}=${v}`);
      }
      for (const s of t.computeSlots ?? []) if (s.defaultPlatform && vendorIds.has(s.defaultPlatform)) bad.push(`${t.id}.${s.id}.defaultPlatform=${s.defaultPlatform}`);
    }
    expect(bad).toEqual([]);
  });
});
