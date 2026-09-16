// Integration v2 2차 (#10): project catalogExtensions[].image follow the server-library image rule on the project save path
// (PNG / JPEG / WebP base64 data URL ≤ 1 MB, `src` only under /assets/).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CATALOG_IMAGE_MAX_BYTES, getCatalogItem, type Project } from '../../../packages/core/src/index.ts';
import { buildServer } from '../src/app.ts';

let app: FastifyInstance;
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aidc-images-'));
  app = await buildServer({ dataDir: join(dir, 'projects'), webDist: join(dir, 'no-dist'), logger: false, seed: false });
});

afterAll(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

// 1 × 1 transparent PNG
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

// v2-2 project management: project names are unique (case-insensitive) → every helper call gets its own name
let created = 0;
async function createProject(): Promise<Project> {
  const name = created++ ? `Image Hall #${created}` : 'Image Hall';
  const res = await app.inject({ method: 'POST', url: '/api/projects', payload: { template: 'reference', pods: 1, name } });
  expect(res.statusCode).toBe(201);
  return res.json() as Project;
}
const withImage = (p: Project, image: Record<string, unknown>): Project => ({
  ...p,
  catalogExtensions: [{ ...getCatalogItem('nvidia-gb300-nvl72'), id: 'nvidia-gb300-nvl72-copy', name: 'GB300 copy', image } as unknown as NonNullable<Project['catalogExtensions']>[number]],
});

describe('project save path validates catalog extension images', () => {
  it('PUT rejects GIF data URLs, oversize images and remote src; accepts a PNG data URL', async () => {
    const p = await createProject();
    const gif = await app.inject({ method: 'PUT', url: `/api/projects/${p.id}`, headers: { 'if-match': '*' }, payload: withImage(p, { kind: 'user', dataUrl: GIF }) });
    expect(gif.statusCode).toBe(400);
    expect(JSON.stringify(gif.json())).toMatch(/catalogExtensions\[0\]\.image\.dataUrl/);

    const big = `data:image/png;base64,${'A'.repeat(Math.ceil(((CATALOG_IMAGE_MAX_BYTES + 1024) * 4) / 3))}`;
    const over = await app.inject({ method: 'PUT', url: `/api/projects/${p.id}`, headers: { 'if-match': '*' }, payload: withImage(p, { kind: 'user', dataUrl: big }) });
    expect(over.statusCode).toBe(400);
    expect(JSON.stringify(over.json())).toMatch(/exceeds/);

    const remote = await app.inject({ method: 'PUT', url: `/api/projects/${p.id}`, headers: { 'if-match': '*' }, payload: withImage(p, { kind: 'user', src: 'https://example.com/x.png' }) });
    expect(remote.statusCode).toBe(400);

    const ok = await app.inject({ method: 'PUT', url: `/api/projects/${p.id}`, headers: { 'if-match': '*' }, payload: withImage(p, { kind: 'user', dataUrl: PNG, credit: 'QA' }) });
    expect(ok.statusCode).toBe(200);
    const back = (await app.inject({ method: 'GET', url: `/api/projects/${p.id}` })).json() as Project;
    expect(back.catalogExtensions?.[0]?.image).toMatchObject({ kind: 'user', dataUrl: PNG });

    const asset = await app.inject({ method: 'PUT', url: `/api/projects/${p.id}`, headers: { 'if-match': '*' }, payload: withImage(p, { kind: 'thumbnail', src: '/assets/thumbs/gb300.png' }) });
    expect(asset.statusCode).toBe(200);
  });

  it('POST (import) applies the same rule', async () => {
    const p = await createProject();
    const res = await app.inject({ method: 'POST', url: '/api/projects', payload: withImage({ ...p, id: 'img-import' }, { kind: 'user', dataUrl: GIF }) });
    expect(res.statusCode).toBe(400);
  });
});
