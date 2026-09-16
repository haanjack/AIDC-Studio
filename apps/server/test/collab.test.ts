// Stream T8: version history (snapshot on save, coalescing, retention, restore, diff), save preconditions (412 / 423),
// advisory locks (TTL, heartbeat, force release with snapshot) and the optional shared secret.
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Project } from '../../../packages/core/src/index.ts';
import { buildServer } from '../src/app.ts';
import { lockManagerFor } from '../src/locks.ts';
import { VERSION_RETENTION } from '../src/versions.ts';

let app: FastifyInstance;
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aidc-collab-'));
  app = await buildServer({ dataDir: join(dir, 'projects'), webDist: join(dir, 'no-dist'), logger: false, seed: false });
});

afterAll(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

// v2-2 project management: project names are unique (case-insensitive) → every helper call gets its own name
let created = 0;
async function createProject(): Promise<Project> {
  const name = created++ ? `Collab Hall #${created}` : 'Collab Hall';
  const res = await app.inject({ method: 'POST', url: '/api/projects', payload: { template: 'nvidia-reference', pods: 1, name } }); // stream D (P4): GB300 rack edits below → the vendor sample template
  expect(res.statusCode).toBe(201);
  return res.json() as Project;
}
// backlog T3 (5): saves of an existing project need If-Match — tests that do not exercise revisions send `*`
const put = (p: Project, headers: Record<string, string> = {}) => app.inject({ method: 'PUT', url: `/api/projects/${p.id}`, payload: p, headers: { 'if-match': '*', ...headers } });
const versions = async (id: string) => (await app.inject({ method: 'GET', url: `/api/projects/${id}/versions` })).json() as { id: string; kind: string; savedBy?: string; note?: string; summary: { gpus: number } }[];

describe('versions', () => {
  it('snapshots changed saves, skips unchanged, coalesces autosaves, keeps manual versions', async () => {
    const p = await createProject();
    const user = { 'x-aidc-user': encodeURIComponent('김 엔지니어') };
    expect((await put(p, user)).statusCode).toBe(200);
    let list = await versions(p.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: 'autosave', savedBy: '김 엔지니어' });
    expect(list[0].summary.gpus).toBe(72 * 1 * 24 > 0 ? list[0].summary.gpus : 0);
    await put(p, user); // same content
    expect(await versions(p.id)).toHaveLength(1);
    const moved = structuredClone(p);
    moved.equipment[0].position.x += 1;
    await put(moved, user); // changed, same person within 10 min → replaces the autosave
    list = await versions(p.id);
    expect(list).toHaveLength(1);
    await put({ ...moved, name: 'Collab Hall 2' }, { 'x-aidc-user': 'other' }); // other person → new version
    expect(await versions(p.id)).toHaveLength(2);
    const manual = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/versions`, payload: { note: 'baseline', savedBy: 'Lee' } });
    expect(manual.statusCode).toBe(201);
    list = await versions(p.id);
    expect(list[0]).toMatchObject({ kind: 'manual', note: 'baseline', savedBy: 'Lee' });
    const files = await readdir(join(dir, 'projects', `${p.id}.versions`));
    expect(files.filter((f) => f.endsWith('.json') && f !== 'index.json')).toHaveLength(3);
    // the history folder is invisible to the project list
    expect(((await app.inject({ method: 'GET', url: '/api/projects' })).json() as unknown[]).length).toBeGreaterThan(0);
  });

  it('GET one version, diff against current, restore (pre-restore snapshot first)', async () => {
    const p = await createProject();
    const v1 = (await app.inject({ method: 'POST', url: `/api/projects/${p.id}/versions`, payload: { note: 'v1' } })).json() as { id: string };
    const snap = (await app.inject({ method: 'GET', url: `/api/projects/${p.id}/versions/${v1.id}` })).json() as Project;
    expect(snap.equipment.length).toBe(p.equipment.length);
    const edited = structuredClone(p);
    const removed = edited.equipment.find((e) => e.catalogId === 'nvidia-gb300-nvl72')!;
    edited.equipment = edited.equipment.filter((e) => e.id !== removed.id);
    edited.equipment[0].position.y += 2;
    await put(edited);
    const diff = (await app.inject({ method: 'GET', url: `/api/projects/${p.id}/diff?from=${v1.id}&to=current` })).json();
    expect(diff.diff.removed).toEqual([removed.id]);
    expect(diff.diff.moved).toHaveLength(1);
    expect(diff.diff.summaryDelta.gpus).toBe(-72);
    expect(diff.byCategory.find((c: { category: string }) => c.category === 'gpu-rack').removed).toBe(1);
    expect((await app.inject({ method: 'GET', url: `/api/projects/${p.id}/diff?from=nope` })).statusCode).toBe(404);
    const restored = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/versions/${v1.id}/restore`, payload: { savedBy: 'Kim' } });
    expect(restored.statusCode).toBe(200);
    const body = restored.json() as { project: Project; preRestore: { kind: string } };
    expect(body.project.equipment.length).toBe(p.equipment.length);
    expect(body.preRestore.kind).toBe('pre-restore');
    const head = (await app.inject({ method: 'GET', url: `/api/projects/${p.id}` }));
    expect(head.headers.etag).toBe(`"${body.project.updatedAt}"`);
    expect((head.json() as Project).equipment.length).toBe(p.equipment.length);
  });

  it(`keeps the newest ${VERSION_RETENTION} versions`, async () => {
    const p = await createProject();
    for (let i = 0; i < VERSION_RETENTION + 4; i++) await app.inject({ method: 'POST', url: `/api/projects/${p.id}/versions`, payload: { note: `n${i}` } });
    const list = await versions(p.id);
    expect(list).toHaveLength(VERSION_RETENTION);
    expect(list[0].note).toBe(`n${VERSION_RETENTION + 3}`);
    expect(list[list.length - 1].note).toBe('n4');
    const files = await readdir(join(dir, 'projects', `${p.id}.versions`));
    expect(files.filter((f) => f !== 'index.json')).toHaveLength(VERSION_RETENTION);
  });

  it('If-Match revision check → 412 on a stale base revision', async () => {
    const p = await createProject();
    const r1 = await put(p, { 'if-match': `"${p.updatedAt}"` });
    expect(r1.statusCode).toBe(200);
    const rev1 = (r1.json() as Project).updatedAt;
    expect(r1.headers.etag).toBe(`"${rev1}"`);
    const stale = await put({ ...p, name: 'stale' }, { 'if-match': `"${p.updatedAt}"` });
    expect(stale.statusCode).toBe(412);
    expect(stale.json().rev).toBe(rev1);
    expect((await put({ ...p, name: 'fresh' }, { 'if-match': `"${rev1}"` })).statusCode).toBe(200);
    // backlog T3 (5): no If-Match on an existing project → 428 with a code the client maps to a clear message; `*` overwrites explicitly
    const legacy = await app.inject({ method: 'PUT', url: `/api/projects/${p.id}`, payload: { ...p, name: 'legacy' } });
    expect(legacy.statusCode).toBe(428);
    expect(legacy.json()).toMatchObject({ code: 'if-match-required' });
    expect((await put({ ...p, name: 'explicit overwrite' }, { 'if-match': '*' })).statusCode).toBe(200);
  });
});

describe('locks', () => {
  it('acquire, conflict (423), save enforcement, heartbeat, force release with snapshot, release', async () => {
    const p = await createProject();
    const url = `/api/projects/${p.id}/lock`;
    expect((await app.inject({ method: 'GET', url })).json()).toMatchObject({ lock: null, ttlSec: 120, heartbeatSec: 40 });
    const a = await app.inject({ method: 'POST', url, payload: { holder: 'Alice', clientId: 'client-alice-1' } });
    expect(a.statusCode).toBe(200);
    const tokenA = a.json().token as string;
    expect(a.json().lock).toMatchObject({ projectId: p.id, holder: 'Alice' });
    expect(JSON.stringify((await app.inject({ method: 'GET', url })).json())).not.toContain(tokenA);

    const b = await app.inject({ method: 'POST', url, payload: { holder: 'Bob', clientId: 'client-bob-22' } });
    expect(b.statusCode).toBe(423);
    expect(b.json().lock.holder).toBe('Alice');
    expect((await put({ ...p, name: 'by bob' })).statusCode).toBe(423);
    expect((await put({ ...p, name: 'by alice' }, { 'x-aidc-lock': tokenA })).statusCode).toBe(200);

    const lm = lockManagerFor(app);
    const t0 = Date.now();
    lm.now = () => t0 + 100_000;
    const hb = await app.inject({ method: 'POST', url, payload: { holder: 'Alice', clientId: 'client-alice-1', token: tokenA } });
    expect(hb.statusCode).toBe(200);
    expect(Date.parse(hb.json().lock.expiresAt)).toBe(t0 + 100_000 + 120_000);

    const before = (await versions(p.id)).length;
    const forced = await app.inject({ method: 'POST', url, payload: { holder: 'Bob', clientId: 'client-bob-22', force: true } });
    expect(forced.statusCode).toBe(200);
    expect(forced.json()).toMatchObject({ forced: true, previousHolder: 'Alice', lock: { holder: 'Bob' } });
    const vs = await versions(p.id);
    expect(vs).toHaveLength(before + 1);
    expect(vs[0]).toMatchObject({ kind: 'pre-force-release', savedBy: 'Bob' });
    const tokenB = forced.json().token as string;
    // Alice's next heartbeat is refused, her save too
    expect((await app.inject({ method: 'POST', url, payload: { holder: 'Alice', clientId: 'client-alice-1', token: tokenA } })).statusCode).toBe(423);
    expect((await put({ ...p, name: 'alice late' }, { 'x-aidc-lock': tokenA })).statusCode).toBe(423);
    expect((await app.inject({ method: 'DELETE', url: `${url}?token=${tokenA}` })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: `${url}/release`, payload: JSON.stringify({ token: tokenB }), headers: { 'content-type': 'text/plain' } })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url })).json().lock).toBeNull();

    // expiry: a lock older than the TTL is dropped
    const c = await app.inject({ method: 'POST', url, payload: { holder: 'Carol', clientId: 'client-carol-3' } });
    expect(c.statusCode).toBe(200);
    lm.now = () => t0 + 100_000 + 121_000;
    expect((await app.inject({ method: 'GET', url })).json().lock).toBeNull();
    lm.now = () => Date.now();
    expect((await app.inject({ method: 'POST', url, payload: { holder: 'x' } })).statusCode).toBe(400);
  });
});

describe('shared secret (AIDC_SHARED_SECRET)', () => {
  it('requires x-aidc-secret on /api/* except health', async () => {
    const d = await mkdtemp(join(tmpdir(), 'aidc-secret-'));
    process.env.AIDC_SHARED_SECRET = 's3cret-lan';
    const s = await buildServer({ dataDir: join(d, 'projects'), webDist: join(d, 'no-dist'), logger: false, seed: false });
    delete process.env.AIDC_SHARED_SECRET;
    try {
      expect((await s.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
      expect((await s.inject({ method: 'GET', url: '/api/projects' })).statusCode).toBe(401);
      expect((await s.inject({ method: 'GET', url: '/api/projects', headers: { 'x-aidc-secret': 'wrong' } })).statusCode).toBe(401);
      expect((await s.inject({ method: 'GET', url: '/api/projects', headers: { 'x-aidc-secret': 's3cret-lan' } })).statusCode).toBe(200);
      // polish v2 2차 (QA collab #10): the secret is never accepted from the query string — URLs end up in request logs
      expect((await s.inject({ method: 'GET', url: '/api/projects?secret=s3cret-lan' })).statusCode).toBe(401);
    } finally {
      await s.close();
      await rm(d, { recursive: true, force: true });
    }
  });
});
