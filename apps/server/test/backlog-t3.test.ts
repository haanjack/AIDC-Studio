// Backlog T3 (5), (7), (8): If-Match required for overwriting saves (428), edit locks persisted across a server restart (TTL kept),
// permanent trash purge (all / older than N days), and the hall-removal thermal undo stash of the web store.
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNvidiaReferenceProject, type Project } from '../../../packages/core/src/index.ts';
import { buildServer } from '../src/app.ts';
import { hallThermalDrop, hallThermalRestore, withHallThermal } from '../../web/src/store/hallThermalUndo.ts';

let dir: string;
const dataDir = () => join(dir, 'projects');
const boot = () => buildServer({ dataDir: dataDir(), webDist: join(dir, 'no-dist'), logger: false, seed: false });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aidc-t3-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const make = (name: string): Project => ({ ...createNvidiaReferenceProject({ pods: 1 }).project, id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name });

describe('If-Match required (backlog T3 (5))', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await boot();
  });
  afterAll(async () => {
    await app.close();
  });

  it('a first save of a new id needs no If-Match; overwriting it without one → 428, with the ETag → 200, stale → 412', async () => {
    const p = make('T3 If Match');
    const first = await app.inject({ method: 'PUT', url: `/api/projects/${p.id}`, payload: p });
    expect([200, 201]).toContain(first.statusCode);
    const rev = (first.json() as Project).updatedAt;
    const again = await app.inject({ method: 'PUT', url: `/api/projects/${p.id}`, payload: { ...p, name: 'T3 If Match 2' } });
    expect(again.statusCode).toBe(428);
    expect(again.json()).toMatchObject({ code: 'if-match-required' });
    const ok = await app.inject({ method: 'PUT', url: `/api/projects/${p.id}`, payload: { ...p, name: 'T3 If Match 2' }, headers: { 'if-match': `"${rev}"` } });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers.etag).toBe(`"${(ok.json() as Project).updatedAt}"`);
    const stale = await app.inject({ method: 'PUT', url: `/api/projects/${p.id}`, payload: { ...p, name: 'T3 stale' }, headers: { 'if-match': `"${rev}"` } });
    expect(stale.statusCode).toBe(412);
  });

  it('health advertises the rule so clients can tell', async () => {
    const h = (await app.inject({ method: 'GET', url: '/api/health' })).json() as { features: string[] };
    expect(h.features).toEqual(expect.arrayContaining(['project-trash', 'trash-purge', 'if-match-required']));
  });
});

describe('edit locks survive a server restart (backlog T3 (5))', () => {
  it('an active lock is reloaded after a restart; expired records are dropped', async () => {
    const p = make('T3 Lock Persist');
    let app = await boot();
    expect([200, 201]).toContain((await app.inject({ method: 'PUT', url: `/api/projects/${p.id}`, payload: p })).statusCode);
    const got = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/lock`, payload: { holder: 'Kim', clientId: 'client-aaaa-1111' } });
    expect(got.statusCode).toBe(200);
    const { token } = got.json() as { token: string };
    await app.close();
    expect(existsSync(join(dataDir(), '.locks', 'locks.json'))).toBe(true);

    app = await boot();
    const lock = (await app.inject({ method: 'GET', url: `/api/projects/${p.id}/lock` })).json() as { lock: { holder: string } | null };
    expect(lock.lock?.holder).toBe('Kim');
    const other = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/lock`, payload: { holder: 'Lee', clientId: 'client-bbbb-2222' } });
    expect(other.statusCode).toBe(423);
    const head = (await app.inject({ method: 'GET', url: `/api/projects/${p.id}` })).json() as Project;
    const blocked = await app.inject({ method: 'PUT', url: `/api/projects/${p.id}`, payload: head, headers: { 'if-match': `"${head.updatedAt}"` } });
    expect(blocked.statusCode).toBe(423);
    const mine = await app.inject({ method: 'PUT', url: `/api/projects/${p.id}`, payload: head, headers: { 'if-match': `"${head.updatedAt}"`, 'x-aidc-lock': token } });
    expect(mine.statusCode).toBe(200);
    // the token still releases the reloaded lock
    expect((await app.inject({ method: 'DELETE', url: `/api/projects/${p.id}/lock?token=${encodeURIComponent(token)}` })).statusCode).toBe(204);
    await app.close();

    // an expired record in the file is ignored on start
    await mkdir(join(dataDir(), '.locks'), { recursive: true });
    await writeFile(join(dataDir(), '.locks', 'locks.json'), JSON.stringify([{ projectId: p.id, holder: 'Old', clientId: 'client-cccc-3333', token: 'x'.repeat(24), acquiredAt: '2020-01-01T00:00:00Z', heartbeatAt: '2020-01-01T00:00:00Z', expiresAt: '2020-01-01T00:02:00Z' }]));
    app = await boot();
    expect(((await app.inject({ method: 'GET', url: `/api/projects/${p.id}/lock` })).json() as { lock: unknown }).lock).toBeNull();
    await app.close();
  });
});

describe('trash purge (backlog T3 (8))', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await boot();
  });
  afterAll(async () => {
    await app.close();
  });
  const trash = async () => (await app.inject({ method: 'GET', url: '/api/projects/trash' })).json() as { entry: string; deletedAt: string }[];

  it('olderThanDays keeps recent entries, no parameter empties the trash, invalid days → 400', async () => {
    for (const n of ['T3 Keep', 'T3 Drop A', 'T3 Drop B']) expect([200, 201]).toContain((await app.inject({ method: 'PUT', url: `/api/projects/${make(n).id}`, payload: make(n) })).statusCode);
    for (const n of ['T3 Drop A', 'T3 Drop B']) expect((await app.inject({ method: 'DELETE', url: `/api/projects/${make(n).id}` })).statusCode).toBe(200);
    const before = await trash();
    expect(before.length).toBeGreaterThanOrEqual(2);
    expect((await app.inject({ method: 'DELETE', url: '/api/projects/trash?olderThanDays=abc' })).statusCode).toBe(400);
    const recent = await app.inject({ method: 'DELETE', url: '/api/projects/trash?olderThanDays=1' });
    expect(recent.json()).toMatchObject({ removed: 0 });
    expect((await trash()).length).toBe(before.length);
    const all = await app.inject({ method: 'DELETE', url: '/api/projects/trash' });
    expect(all.statusCode).toBe(200);
    expect(all.json()).toMatchObject({ removed: before.length });
    expect(await trash()).toEqual([]);
    for (const m of before) expect(existsSync(join(dir, 'trash', m.entry))).toBe(false);
    // the kept project is untouched
    expect((await app.inject({ method: 'GET', url: `/api/projects/${make('T3 Keep').id}` })).statusCode).toBe(200);
  });
});

describe('hall removal thermal undo stash (backlog T3 (7))', () => {
  it('undo to the snapshot before the removal restores result and scenarios; redo drops them again', () => {
    const before = { id: 'p' } as unknown as Project;
    const after = { id: 'p' } as unknown as Project;
    const result = { options: { hallId: 'h2' } };
    const sc = [{ id: 's1', options: { hallId: 'h2' } }, { id: 's2', options: { hallId: 'h1' } }];
    const full = { scenarios: sc, result, metrics: { maxInletC: 30 }, history: [1], status: 'done' };
    // what removeHall leaves behind
    const removed = { scenarios: [sc[1]], result: null, metrics: null, history: [], status: 'idle' };
    hallThermalRestore.set(before, { hallId: 'h2', scenarios: [sc[0]], result, metrics: full.metrics, history: full.history, status: 'done' });
    hallThermalDrop.set(after, 'h2');
    const undone = withHallThermal(removed, before);
    expect(undone.scenarios.map((s) => s.id).sort()).toEqual(['s1', 's2']);
    expect(undone.result).toBe(result);
    expect(undone.status).toBe('done');
    const redone = withHallThermal(undone, after);
    expect(redone.scenarios.map((s) => s.id)).toEqual(['s2']);
    expect(redone.result).toBeNull();
    // unrelated snapshots leave the state alone
    expect(withHallThermal(full, { id: 'x' } as unknown as Project)).toBe(full);
  });
});
