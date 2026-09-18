import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { termRe } from '../../../packages/core/test/guard-terms.ts';
import type { Project } from '../../../packages/core/src/index.ts';
import { buildServer } from '../src/app.ts';

let app: FastifyInstance;
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aidc-server-'));
  app = await buildServer({ dataDir: join(dir, 'projects'), webDist: join(dir, 'no-dist'), logger: false, seed: false });
});

afterAll(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

// v2-2 project management: project names are unique (case-insensitive) → every helper call gets its own name
let created = 0;
async function createProject(pods = 1): Promise<Project> {
  const name = created++ ? `Test Hall #${created}` : 'Test Hall';
  const res = await app.inject({ method: 'POST', url: '/api/projects', payload: { template: 'nvidia-reference', pods, name } }); // stream D (P4): GB300 counts below → the vendor sample template
  expect(res.statusCode).toBe(201);
  return res.json() as Project;
}

describe('meta', () => {
  it('health', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, name: 'aidc-studio' });
  });

  it('catalog', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/catalog' });
    const body = res.json() as { items: { id: string }[]; cables: unknown[] };
    expect(body.items.some((i) => i.id === 'nvidia-gb300-nvl72')).toBe(true);
    expect(body.cables.length).toBeGreaterThan(0);
  });

  it('rejects an InferenceX query without an exact preset mapping before contacting upstream', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/inferencex/benchmarks?presetId=kimi-k2' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: expect.stringContaining('exact InferenceX model mapping') });
  });
});

describe('projects CRUD', () => {
  it('create → list → get → update → delete', async () => {
    const p = await createProject(1);
    expect(p.name).toBe('Test Hall');
    expect(p.equipment.length).toBeGreaterThan(24);

    const list = (await app.inject({ method: 'GET', url: '/api/projects' })).json() as { id: string; gpus: number }[];
    const entry = list.find((x) => x.id === p.id);
    expect(entry?.gpus).toBe(24 * 72);

    const got = await app.inject({ method: 'GET', url: `/api/projects/${p.id}` });
    expect(got.statusCode).toBe(200);
    expect((got.json() as Project).equipment.length).toBe(p.equipment.length);

    const put = await app.inject({ method: 'PUT', url: `/api/projects/${p.id}`, headers: { 'if-match': '*' }, payload: { ...p, name: 'Renamed' } });
    expect(put.statusCode).toBe(200);
    expect(((await app.inject({ method: 'GET', url: `/api/projects/${p.id}` })).json() as Project).name).toBe('Renamed');

    // v2-2: DELETE is a recoverable move to the trash (200 + manifest) and never removes the last project
    await createProject(1);
    expect((await app.inject({ method: 'DELETE', url: `/api/projects/${p.id}` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/projects/${p.id}` })).statusCode).toBe(404);
  });

  it('rejects invalid ids and bodies', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/projects/..%2Fsecret' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/projects/abc', payload: { hello: 1 } })).statusCode).toBe(400);
  });
});

describe('analysis', () => {
  it('analyze returns an analysis or 501 while engines are pending', async () => {
    const p = await createProject(1);
    const res = await app.inject({ method: 'POST', url: '/api/analyze', payload: p });
    expect([200, 501]).toContain(res.statusCode);
    if (res.statusCode === 200) expect((res.json() as { summary: { gpus: number } }).summary.gpus).toBe(24 * 72);
  });

  it('analyze, summary and export resolve project-scoped catalog extensions (v2 registry)', async () => {
    const p = await createProject(1);
    const gb300 = (await app.inject({ method: 'GET', url: '/api/catalog' })).json().items.find((i: { id: string }) => i.id === 'nvidia-gb300-nvl72');
    const clone = { ...gb300, id: 'srv-gb300-clone', name: 'GB300 clone (project)', source: 'user' };
    const ext: Project = { ...p, catalogExtensions: [clone], equipment: p.equipment.map((e) => (e.catalogId === 'nvidia-gb300-nvl72' ? { ...e, catalogId: 'srv-gb300-clone' } : e)) };
    const res = await app.inject({ method: 'POST', url: '/api/analyze', payload: ext });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { summary: { gpus: number } }).summary.gpus).toBe(24 * 72);
    await app.inject({ method: 'PUT', url: `/api/projects/${p.id}`, headers: { 'if-match': '*' }, payload: ext });
    const sum = (await app.inject({ method: 'GET', url: `/api/projects/${p.id}/summary` })).json() as { gpus: number };
    expect(sum.gpus).toBe(24 * 72);
    const zip = await JSZip.loadAsync((await app.inject({ method: 'POST', url: '/api/export/json', payload: { project: ext } })).rawPayload);
    const layout = JSON.parse(await zip.file('aidc-json/layout.json')!.async('string'));
    expect(layout.catalog['srv-gb300-clone']).toBeDefined();
    // without the extension the same equipment is unknown to the catalog
    const bare = (await app.inject({ method: 'POST', url: '/api/analyze', payload: { ...ext, catalogExtensions: undefined } })).json() as { summary: { gpus: number } };
    expect(bare.summary.gpus).toBe(0);
  });
});

describe('exports', () => {
  async function exportZip(format: string, project: Project) {
    const res = await app.inject({ method: 'POST', url: `/api/export/${format}`, payload: { project } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/zip');
    expect(String(res.headers['content-disposition'])).toContain('.zip');
    return JSZip.loadAsync(res.rawPayload);
  }

  it('json bundle', async () => {
    const p = await createProject(1);
    const zip = await exportZip('json', p);
    const layout = JSON.parse(await zip.file('aidc-json/layout.json')!.async('string'));
    expect(layout.schema).toBe('aidc.layout/1');
    expect(layout.equipment.length).toBe(p.equipment.length);
    expect(zip.file('aidc-json/project.json')).not.toBeNull();
  });

  it('usd bundle is self-contained (aidc: attributes, no third-party asset library paths)', async () => {
    const p = await createProject(1);
    const zip = await exportZip('usd', p);
    const usda = await zip.file('aidc-usd/stage.usda')!.async('string');
    expect(usda.startsWith('#usda 1.0')).toBe(true);
    expect(usda).toContain('upAxis = "Z"');
    expect(usda).not.toMatch(termRe('<T>|Library\\/Assets|aif:|SimReady'));
    expect(usda).not.toContain('aidc:assetRoot');
    expect(usda.match(/def Cube "Box"/g)?.length).toBeGreaterThan(0);
    expect(usda.match(/aidc:tag = /g)?.length).toBe(p.equipment.length);
    expect(zip.file('aidc-usd/README.md')).not.toBeNull();
  });

  it('godot bundle contains project template + scene', async () => {
    const p = await createProject(1);
    const zip = await exportZip('godot', p);
    for (const f of ['project.godot', 'main.tscn', 'scripts/aidc_loader.gd', 'layout.json', 'scene.tscn']) expect(zip.file(`aidc-godot/${f}`), f).not.toBeNull();
    expect(await zip.file('aidc-godot/scene.tscn')!.async('string')).toMatch(/^\[gd_scene/);
  });

  it('unreal bundle contains import script', async () => {
    const p = await createProject(1);
    const zip = await exportZip('unreal', p);
    expect(zip.file('aidc-unreal/aidc_import.py')).not.toBeNull();
    expect(zip.file('aidc-unreal/layout.json')).not.toBeNull();
  });

  it('rejects unknown formats', async () => {
    const p = await createProject(1);
    const res = await app.inject({ method: 'POST', url: '/api/export/fbx', payload: { project: p } });
    expect(res.statusCode).toBe(400);
  });
});
