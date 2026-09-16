// v2-2 project management (docs/research/project-management-v2-2.md): create from templates / a body, name + id rules,
// recoverable delete → trash → restore, lock-held 409, last-project 400, rename rule on the save path, no resurrection by
// autosave, shared secret on every write route. Temp data dirs only.
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECT_NAME_MAX, type Project } from '../../../packages/core/src/index.ts';
import { buildServer } from '../src/app.ts';

let app: FastifyInstance;
let dir: string;
const dataDir = () => join(dir, 'projects');
const trashDir = () => join(dir, 'trash');

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aidc-projmgmt-'));
  app = await buildServer({ dataDir: dataDir(), webDist: join(dir, 'no-dist'), logger: false, seed: false });
});

afterAll(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

const USER = { 'x-aidc-user': encodeURIComponent('Consultant Kim') };
const create = (payload: Record<string, unknown> | Project, headers: Record<string, string> = USER) => app.inject({ method: 'POST', url: '/api/projects', payload, headers });
const list = async () => (await app.inject({ method: 'GET', url: '/api/projects' })).json() as { id: string; name: string; versions: number; savedBy?: string; gpus: number; halls: number }[];
const trash = async () => (await app.inject({ method: 'GET', url: '/api/projects/trash' })).json() as { entry: string; id: string; name: string; deletedBy: string | null; versions: number; gpus: number }[];
const del = (id: string, headers: Record<string, string> = USER) => app.inject({ method: 'DELETE', url: `/api/projects/${id}`, headers });

describe('create', () => {
  it('reference template: slug id + suffix, fresh timestamps, no history until the first save; list carries versions / savedBy', async () => {
    const res = await create({ template: 'reference', pods: 1, name: '  Seoul  Campus — Phase 1 ' });
    expect(res.statusCode).toBe(201);
    const p = res.json() as Project;
    expect(p.name).toBe('Seoul Campus — Phase 1');
    expect(p.id).toMatch(/^seoul-campus-phase-1-[a-z0-9]{6}$/);
    expect(p.equipment.length).toBeGreaterThan(24);
    expect(existsSync(join(dataDir(), `${p.id}.json`))).toBe(true);
    expect((await list()).find((x) => x.id === p.id)).toMatchObject({ versions: 0, halls: 2 });
    const moved = structuredClone(p);
    moved.equipment[0].position.x += 1;
    expect((await app.inject({ method: 'PUT', url: `/api/projects/${p.id}`, payload: moved, headers: { ...USER, 'if-match': '*' } })).statusCode).toBe(200);
    expect((await list()).find((x) => x.id === p.id)).toMatchObject({ versions: 1, savedBy: 'Consultant Kim' });
  });

  it('empty template: one empty data hall with the reference hall defaults; default names are made unique', async () => {
    const a = (await create({ template: 'empty' })).json() as Project;
    const b = (await create({ template: 'empty' })).json() as Project;
    expect(a.halls).toHaveLength(1);
    expect(a.halls[0].name).toBe('Data Hall A');
    expect(a.halls[0].width).toBeGreaterThan(10);
    expect(a.equipment).toEqual([]);
    expect(a.schedule.waves).toEqual([]);
    expect(b.name).not.toBe(a.name);
    expect(b.name.toLowerCase()).toBe(`${a.name.toLowerCase()} (2)`);
    expect(a.id).not.toBe(b.id);
  });

  it('unknown template → 400; empty / too-long names → 400; case-insensitive duplicate → 409 with a suggestion', async () => {
    expect((await create({ template: 'pod' })).statusCode).toBe(400);
    expect((await create({ template: 'empty', name: '   ' })).json()).toMatchObject({ code: 'name-empty' });
    expect((await create({ template: 'empty', name: 'x'.repeat(PROJECT_NAME_MAX + 1) })).json()).toMatchObject({ code: 'name-too-long' });
    expect((await create({ template: 'empty', name: 'x'.repeat(PROJECT_NAME_MAX) })).statusCode).toBe(201);
    expect((await create({ template: 'empty', name: 'Unique Name' })).statusCode).toBe(201);
    const dup = await create({ template: 'empty', name: 'UNIQUE name ' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toMatchObject({ code: 'name-taken', suggestion: 'UNIQUE name (2)' });
  });

  it('a full Project body gets a NEW id, fresh createdAt, no versions / lock carried over; the source is untouched', async () => {
    const src = (await create({ template: 'reference', pods: 1, name: 'Copy Source' })).json() as Project;
    const lock = (await app.inject({ method: 'POST', url: `/api/projects/${src.id}/lock`, payload: { holder: 'Alice', clientId: 'client-alice-0001' } })).json() as { token: string };
    const edited = { ...structuredClone(src), name: 'Copy Target', client: 'New Client', createdAt: '2001-01-01T00:00:00.000Z' };
    const res = await create(edited);
    expect(res.statusCode).toBe(201);
    const copy = res.json() as Project;
    expect(copy.id).not.toBe(src.id);
    expect(copy.id).toMatch(/^copy-target-/);
    expect(copy.createdAt).not.toBe('2001-01-01T00:00:00.000Z');
    expect(copy.client).toBe('New Client');
    expect(copy.equipment.length).toBe(src.equipment.length);
    expect((await app.inject({ method: 'GET', url: `/api/projects/${copy.id}/versions` })).json()).toEqual([]);
    expect(((await app.inject({ method: 'GET', url: `/api/projects/${copy.id}/lock` })).json() as { lock: unknown }).lock).toBeNull();
    const again = (await app.inject({ method: 'GET', url: `/api/projects/${src.id}` })).json() as Project;
    expect(again.name).toBe('Copy Source');
    expect(again.client).toBe(src.client);
    // same name as an existing project → 409, nothing written
    const before = readdirSync(dataDir()).length;
    expect((await create({ ...structuredClone(src), name: 'copy source' })).statusCode).toBe(409);
    expect(readdirSync(dataDir()).length).toBe(before);
    await app.inject({ method: 'DELETE', url: `/api/projects/${src.id}/lock?token=${lock.token}` });
  });

  it('dryRun returns a template without storing it', async () => {
    const before = (await list()).length;
    const res = await create({ template: 'reference', pods: 1, dryRun: true });
    expect(res.statusCode).toBe(200);
    expect((await list()).length).toBe(before);
  });
});

describe('rename via the save path', () => {
  it('a changed name is validated (400 / 409); an unchanged duplicate legacy name still saves', async () => {
    const a = (await create({ template: 'reference', pods: 1, name: 'Rename A' })).json() as Project;
    const b = (await create({ template: 'reference', pods: 1, name: 'Rename B' })).json() as Project;
    const put = (p: Project) => app.inject({ method: 'PUT', url: `/api/projects/${p.id}`, headers: { 'if-match': '*' }, payload: p });
    expect((await put({ ...b, name: 'rename a' })).json()).toMatchObject({ code: 'name-taken' });
    expect((await put({ ...b, name: '' })).json()).toMatchObject({ code: 'name-empty' });
    const ok = await put({ ...b, name: '  Rename B2 ' });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as Project).name).toBe('Rename B2');
    expect((await put({ ...a, description: 'edited' })).statusCode).toBe(200);
  });
});

describe('recoverable delete → trash → restore', () => {
  it('moves <id>.json + <id>.versions into trash/<id>-<timestamp>/ with a manifest; list excludes it; restore brings it back', async () => {
    const p = (await create({ template: 'reference', pods: 1, name: 'Trash Me' })).json() as Project;
    const moved = structuredClone(p);
    moved.equipment[0].position.x += 1;
    expect((await app.inject({ method: 'PUT', url: `/api/projects/${p.id}`, payload: moved, headers: { ...USER, 'if-match': '*' } })).statusCode).toBe(200);
    const res = await del(p.id);
    expect(res.statusCode).toBe(200);
    const { trash: m } = res.json() as { trash: { entry: string; name: string; deletedBy: string; versions: number } };
    expect(m).toMatchObject({ name: 'Trash Me', deletedBy: 'Consultant Kim' });
    expect(m.versions).toBeGreaterThanOrEqual(1);
    expect(m.entry).toMatch(new RegExp(`^${p.id}-\\d{8}T\\d{9}Z$`));
    expect(existsSync(join(dataDir(), `${p.id}.json`))).toBe(false);
    expect(existsSync(join(dataDir(), `${p.id}.versions`))).toBe(false);
    for (const f of ['manifest.json', 'project.json', 'versions/index.json']) expect(existsSync(join(trashDir(), m.entry, f))).toBe(true);
    expect((await list()).some((x) => x.id === p.id)).toBe(false);
    expect((await trash()).find((x) => x.entry === m.entry)).toMatchObject({ id: p.id, name: 'Trash Me' });
    expect((await app.inject({ method: 'GET', url: `/api/projects/${p.id}` })).statusCode).toBe(404);
    expect((await del(p.id)).statusCode).toBe(404);

    // an autosave from a client that still has the deleted project open must not re-create it
    const stale = await app.inject({ method: 'PUT', url: `/api/projects/${p.id}`, payload: moved, headers: { 'if-match': `"${moved.updatedAt}"` } });
    expect(stale.statusCode).toBe(404);
    expect(stale.json()).toMatchObject({ code: 'deleted' });
    expect((await app.inject({ method: 'PUT', url: `/api/projects/${p.id}`, headers: { 'if-match': '*' }, payload: moved })).statusCode).toBe(404); // trashed id, no If-Match
    expect(existsSync(join(dataDir(), `${p.id}.json`))).toBe(false);

    const restored = await app.inject({ method: 'POST', url: `/api/projects/trash/${m.entry}/restore`, headers: USER });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({ originalId: p.id, renamedId: false, renamedName: false, project: { id: p.id, name: 'Trash Me' } });
    expect(existsSync(join(dataDir(), `${p.id}.json`))).toBe(true);
    expect(((await app.inject({ method: 'GET', url: `/api/projects/${p.id}/versions` })).json() as unknown[]).length).toBe(m.versions);
    expect(existsSync(join(trashDir(), m.entry))).toBe(false);
    expect((await trash()).some((x) => x.entry === m.entry)).toBe(false);
    expect((await app.inject({ method: 'POST', url: `/api/projects/trash/${m.entry}/restore` })).statusCode).toBe(404);
  });

  it('restore under a suffixed id and name when the original id and name are taken again (history re-keyed)', async () => {
    const p = (await create({ template: 'reference', pods: 1, name: 'Twice' })).json() as Project;
    const moved = structuredClone(p);
    moved.equipment[0].position.x += 1;
    await app.inject({ method: 'PUT', url: `/api/projects/${p.id}`, payload: moved, headers: { ...USER, 'if-match': '*' } });
    const m = ((await del(p.id)).json() as { trash: { entry: string } }).trash;
    // the id and the name are live again (a file written straight into the temp store)
    const clash = JSON.parse(await readFile(join(trashDir(), m.entry, 'project.json'), 'utf8')) as Project;
    await writeFile(join(dataDir(), `${p.id}.json`), JSON.stringify({ ...clash, name: 'TWICE' }), 'utf8');
    const res = await app.inject({ method: 'POST', url: `/api/projects/trash/${m.entry}/restore` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { project: Project; originalId: string; renamedId: boolean; renamedName: boolean };
    expect(body).toMatchObject({ originalId: p.id, renamedId: true, renamedName: true });
    expect(body.project.id).not.toBe(p.id);
    expect(body.project.id).toMatch(/restored-[a-z0-9]{6}$/);
    expect(body.project.name).toBe('Twice (restored)');
    expect(((await app.inject({ method: 'GET', url: `/api/projects/${p.id}` })).json() as Project).name).toBe('TWICE');
    const versions = (await app.inject({ method: 'GET', url: `/api/projects/${body.project.id}/versions` })).json() as { projectId: string }[];
    expect(versions.length).toBeGreaterThan(0);
    expect(versions.every((v) => v.projectId === body.project.id)).toBe(true);
  });

  it('deleting while another client holds the edit lock → 409; the holder (lock token) may delete', async () => {
    const p = (await create({ template: 'reference', pods: 1, name: 'Locked Delete' })).json() as Project;
    const alice = (await app.inject({ method: 'POST', url: `/api/projects/${p.id}/lock`, payload: { holder: 'Alice', clientId: 'client-alice-0002' } })).json() as { token: string };
    const res = await del(p.id);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'locked', lock: { holder: 'Alice' } });
    expect((await del(p.id, { 'x-aidc-lock': 'wrong' })).statusCode).toBe(409);
    expect(existsSync(join(dataDir(), `${p.id}.json`))).toBe(true);
    expect((await del(p.id, { 'x-aidc-lock': alice.token })).statusCode).toBe(200);
    expect(((await app.inject({ method: 'GET', url: `/api/projects/${p.id}/lock` })).json() as { lock: unknown }).lock).toBeNull();
  });
});

describe('last project + shared secret', () => {
  it('refuses deleting the last remaining project (400)', async () => {
    const d = await mkdtemp(join(tmpdir(), 'aidc-projmgmt-last-'));
    const s = await buildServer({ dataDir: join(d, 'projects'), webDist: join(d, 'no-dist'), logger: false, seed: false });
    try {
      const only = (await s.inject({ method: 'POST', url: '/api/projects', payload: { template: 'empty', name: 'Only' } })).json() as Project;
      const res = await s.inject({ method: 'DELETE', url: `/api/projects/${only.id}` });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'last-project' });
      expect(existsSync(join(d, 'projects', `${only.id}.json`))).toBe(true);
      const second = (await s.inject({ method: 'POST', url: '/api/projects', payload: { template: 'empty', name: 'Second' } })).json() as Project;
      expect((await s.inject({ method: 'DELETE', url: `/api/projects/${only.id}` })).statusCode).toBe(200);
      expect((await s.inject({ method: 'DELETE', url: `/api/projects/${second.id}` })).statusCode).toBe(400);
      expect(existsSync(join(d, 'trash'))).toBe(true);
    } finally {
      await s.close();
      await rm(d, { recursive: true, force: true });
    }
  });

  it('with AIDC_SHARED_SECRET every project-management route needs x-aidc-secret', async () => {
    const d = await mkdtemp(join(tmpdir(), 'aidc-projmgmt-secret-'));
    process.env.AIDC_SHARED_SECRET = 'lan-secret-pm';
    const s = await buildServer({ dataDir: join(d, 'projects'), webDist: join(d, 'no-dist'), logger: false, seed: false });
    delete process.env.AIDC_SHARED_SECRET;
    const H = { 'x-aidc-secret': 'lan-secret-pm' };
    try {
      expect((await s.inject({ method: 'POST', url: '/api/projects', payload: { template: 'empty', name: 'S1' } })).statusCode).toBe(401);
      const a = (await s.inject({ method: 'POST', url: '/api/projects', headers: H, payload: { template: 'empty', name: 'S1' } })).json() as Project;
      await s.inject({ method: 'POST', url: '/api/projects', headers: H, payload: { template: 'empty', name: 'S2' } });
      expect((await s.inject({ method: 'GET', url: '/api/projects/trash' })).statusCode).toBe(401);
      expect((await s.inject({ method: 'DELETE', url: `/api/projects/${a.id}` })).statusCode).toBe(401);
      expect((await s.inject({ method: 'DELETE', url: `/api/projects/${a.id}`, headers: { 'x-aidc-secret': 'wrong' } })).statusCode).toBe(401);
      const ok = await s.inject({ method: 'DELETE', url: `/api/projects/${a.id}`, headers: H });
      expect(ok.statusCode).toBe(200);
      const entry = (ok.json() as { trash: { entry: string } }).trash.entry;
      expect((await s.inject({ method: 'POST', url: `/api/projects/trash/${entry}/restore` })).statusCode).toBe(401);
      expect((await s.inject({ method: 'POST', url: `/api/projects/trash/${entry}/restore`, headers: H })).statusCode).toBe(200);
      expect(JSON.stringify((await s.inject({ method: 'GET', url: '/api/health' })).json())).not.toContain('lan-secret-pm');
    } finally {
      await s.close();
      await rm(d, { recursive: true, force: true });
    }
  });
});
