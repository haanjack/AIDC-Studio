// Neutralization stream N2a (2026-09-15): the product has no code path that only serves the retired reference content pack, no dependency on a third-party asset
// pack, and stored ids keep working. See docs/research/neutral-N2a.md.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as core from '../src/index.ts';
import { analyzeProject, buildExportFiles, createNvidiaReferenceProject, exportUsda, findLayoutTemplate, LAYOUT_TEMPLATES, PROJECT_TEMPLATE_NAMES, resolveLayoutTemplate, type Project } from '../src/index.ts';
import { createRefPodFixture } from './fixtures/ref-pod.ts';
import { termRe, TERM_LOWER } from './guard-terms.ts';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const VENDOR_TEXT = termRe('\\b<T>\\b|<T> Blueprint|SimReady|\\baif:');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '__golden__' || name === '__screenshots__') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|js|json)$/.test(name)) out.push(p);
  }
  return out;
}

describe('N2a: no dependency on the reference content pack', () => {
  it('no source file under core / thermal / server / web references the reference content pack, its CFD outputs or the retired loader', () => {
    const roots = ['packages/core/src', 'packages/thermal/src', 'packages/thermal/scripts', 'apps/server/src', 'apps/web/src'].map((r) => join(REPO, r));
    const pattern = termRe('assets\\/<T>_BP|<T>_ASSET_ROOT|<t>Assets|<t>_gb300|<t>ReferencePod|create<Tt>ReferencePodProject|loadReferenceCfd|\\/assets\\/cfd\\b');
    const hits = roots.flatMap((r) => walk(r)).filter((f) => pattern.test(readFileSync(f, 'utf8')));
    expect(hits.map((f) => f.slice(REPO.length))).toEqual([]);
  });

  it('core exports no symbol named after the retired blueprint', () => {
    expect(Object.keys(core).filter((k) => termRe('<t>', 'i').test(k))).toEqual([]);
  });

  it('USD export payloads only AIDC-generated assets and uses the aidc: namespace only', () => {
    const { project } = createNvidiaReferenceProject({ pods: 1 });
    const usda = exportUsda(project);
    expect(usda).toContain('aidc:catalogId');
    expect(usda).not.toMatch(termRe('Library\\/Assets|Data_Center\\/|<T>|aif:|aidc:assetRoot'));
    for (const m of usda.matchAll(/prepend payload = @([^@]+)@/g)) expect(m[1]).toMatch(/\/usd\//);
    const files = buildExportFiles(project, null, 'usd');
    expect(String(files['README.md'])).not.toMatch(termRe('<T>|SimReady|Omniverse'));
  });
});

describe('N2a: neutral labels, stored ids unchanged', () => {
  it('reference project name / description / notes carry no blueprint branding; the template name matches', () => {
    const { project } = createNvidiaReferenceProject();
    // stream D (P4): the GB300 hall is the vendor sample "NVIDIA reference"; the default reference is vendor-neutral
    expect(project.name).toBe('NVIDIA reference');
    expect(PROJECT_TEMPLATE_NAMES['nvidia-reference']).toBe(project.name);
    expect(PROJECT_TEMPLATE_NAMES.reference).not.toMatch(termRe('nvidia|gb300|<t>', 'i'));
    expect(`${project.description}\n${project.notes.map((n) => `${n.id} ${n.title} ${n.body}`).join('\n')}`).not.toMatch(VENDOR_TEXT);
    // stream A (P1): the reference writes the neutral template id; legacy ids resolve through catalog/aliases.ts
    expect(project.halls[0].layoutPolicy?.templateId).toBe('rack-scale-liquid-du');
  });

  it("physical DU template ids resolve with neutral labels and non-vendor sources", () => {
    for (const id of ['rack-scale-liquid-du', 'rcu-row']) {
      const t = findLayoutTemplate(id)!;
      expect(t, id).toBeTruthy();
      expect(resolveLayoutTemplate(id)?.id).toBe(id);
      expect(`${t.name} ${t.description} ${t.notes ?? ''}`, id).not.toMatch(VENDOR_TEXT);
    }
    for (const t of LAYOUT_TEMPLATES) expect(['public-spec', 'estimate', 'user'], t.id).toContain(t.source);
  });

  it("a stored geometry-only project (purpose 'reference-cfd', legacy template policy) still analyses", () => {
    const p: Project = createRefPodFixture();
    const a = analyzeProject(p);
    expect(a.summary.gpus).toBe(24 * 72);
    expect(a.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(a.issues.some((i) => i.id === 'reference-cfd-scope')).toBe(true);
  });
});
