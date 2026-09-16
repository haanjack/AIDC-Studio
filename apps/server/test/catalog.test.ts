import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CatalogItem, Project } from '../../../packages/core/src/index.ts';
import { buildServer } from '../src/app.ts';
import { catalogLibraryErrors } from '../src/catalogStore.ts';

let app: FastifyInstance;
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aidc-catalog-'));
  app = await buildServer({ dataDir: join(dir, 'projects'), catalogDir: join(dir, 'catalog'), webDist: join(dir, 'no-dist'), logger: false, seed: false });
});

afterAll(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

describe('S3 catalog library (GET/PUT /api/catalog/custom)', () => {
  it('starts empty, persists a PUT to custom.json and merges into GET /api/catalog', async () => {
    const empty = (await app.inject({ method: 'GET', url: '/api/catalog/custom' })).json() as { items: unknown[]; cables: unknown[] };
    expect(empty.items).toEqual([]);
    const all = (await app.inject({ method: 'GET', url: '/api/catalog' })).json() as { items: CatalogItem[] };
    const base = all.items.find((i) => i.id === 'amd-mi355x-dlc-4x')!;
    expect(base).toBeDefined();
    const lib = { ...base, id: 'lib-mi355x', name: 'Library MI355X', source: 'user' as const, origin: undefined };
    const put = await app.inject({ method: 'PUT', url: '/api/catalog/custom', payload: { items: [lib], cables: [] } });
    expect(put.statusCode).toBe(200);
    expect((put.json() as { items: CatalogItem[] }).items[0].origin).toBe('library');
    const file = JSON.parse(await readFile(join(dir, 'catalog', 'custom.json'), 'utf8')) as { items: CatalogItem[] };
    expect(file.items[0].id).toBe('lib-mi355x');
    const merged = (await app.inject({ method: 'GET', url: '/api/catalog' })).json() as { items: CatalogItem[] };
    expect(merged.items.find((i) => i.id === 'lib-mi355x')?.origin).toBe('library');
    expect(merged.items.find((i) => i.id === 'amd-mi355x-dlc-4x')?.origin).toBe('builtin');
  });

  it('a project referencing a library item analyses on the server', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/projects', payload: { template: 'reference', pods: 1, gpuRackCatalogId: 'lib-mi355x', name: 'lib test' } });
    expect(created.statusCode).toBe(201);
    const p = created.json() as Project;
    const res = await app.inject({ method: 'POST', url: '/api/analyze', payload: p });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { summary: { gpus: number } }).summary.gpus).toBe(24 * 32);
    const sum = (await app.inject({ method: 'GET', url: `/api/projects/${p.id}/summary` })).json() as { gpus: number };
    expect(sum.gpus).toBe(24 * 32);
  });

  it('rejects invalid libraries with field-level errors', async () => {
    const bad = await app.inject({ method: 'PUT', url: '/api/catalog/custom', payload: { items: [{ id: 'x', name: 'no dims' }] } });
    expect(bad.statusCode).toBe(400);
    const body = bad.json() as { errors: string[] };
    expect(body.errors.some((e) => /dims/.test(e))).toBe(true);
    expect(catalogLibraryErrors({ items: [{ id: 'a' }, { id: 'a' }] }).some((e) => /duplicate/.test(e))).toBe(true);
    expect(catalogLibraryErrors({ items: 'nope' })).toContain('items must be an array');
    // the previous library is untouched
    const still = (await app.inject({ method: 'GET', url: '/api/catalog/custom' })).json() as { items: CatalogItem[] };
    expect(still.items.map((i) => i.id)).toEqual(['lib-mi355x']);
  });

  it('PUT with empty arrays clears the library', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/catalog/custom', payload: { items: [], cables: [] } });
    expect(res.statusCode).toBe(200);
    const merged = (await app.inject({ method: 'GET', url: '/api/catalog' })).json() as { items: CatalogItem[] };
    expect(merged.items.find((i) => i.id === 'lib-mi355x')).toBeUndefined();
  });
});
