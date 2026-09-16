// Saved-version history + two-version comparison (stream T8, DECISIONS-v2 #12, DECISIONS-v2-2 §C, r2-platform.md §4).
//
// Storage: history folders beside the project files — <dataDir>/<projectId>.versions/{index.json, <versionId>.json}
// (ProjectStore.list() only reads *.json files, so the folders are invisible to it). Retention: the newest 50 versions.
//
// A snapshot is stored on every successful project save (PUT /api/projects/:id) whose content changed. Consecutive
// autosaves by the same person within 10 min replace the previous autosave snapshot (autosave fires 1.5 s after each
// edit; without coalescing 50 versions would cover a few minutes of work). Manual versions, pre-restore,
// pre-force-release and conflict copies are always kept.
//
// Save preconditions (Fastify hooks on PUT /api/projects/:id, no change to app.ts):
//   If-Match: "<updatedAt>" of the client's base revision → 412 { error, rev } when the head moved (RFC 9110 §13.1.1);
//   backlog T3 (5): a PUT without If-Match on an existing project → 428 { code: 'if-match-required' } (RFC 6585 §3); a first save of a
//   new id needs none; `If-Match: *` is an explicit "overwrite whatever is there". An active lock held by another client → 423 { lock } unless
//   the request carries the lock token in `x-aidc-lock`. `x-aidc-user` (URI-encoded display name) = savedBy.
//   GET/PUT responses carry `ETag: "<updatedAt>"`.
//
// Routes:
//   GET  /api/projects/:id/versions                 → StoredVersion[] (newest first)
//   POST /api/projects/:id/versions                 { note?, savedBy?, kind?: 'manual'|'conflict-copy', project? } → 201 StoredVersion
//   GET  /api/projects/:id/versions/:vid            → Project snapshot
//   POST /api/projects/:id/versions/:vid/restore    { savedBy? } → { project, preRestore }
//   GET  /api/projects/:id/diff?from=<vid|current>&to=<vid|current> → { from, to, diff, kpisFrom, kpisTo, byCategory, changedFields }
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  diffProjectsDetailed, projectContentKey, resolveCatalog, withCatalog, type Project, type ProjectVersion,
  upgradeProject,
} from '../../../packages/core/src/index.ts';
import type { RouteContext } from './app.ts';
import { cleanDisplayName, headerString, lockManagerFor, userFromHeader } from './locks.ts';
import { isProjectLike, isValidId } from './storage.ts';

/** Versions kept per project — DECISIONS-v2-2 §C. */
export const VERSION_RETENTION = 50;
/** Autosaves by the same person within this window replace the previous autosave snapshot — estimate. */
export const AUTOSAVE_COALESCE_MS = 10 * 60_000;

export type VersionKind = 'autosave' | 'manual' | 'pre-restore' | 'pre-force-release' | 'conflict-copy';

export interface StoredVersion extends ProjectVersion {
  kind: VersionKind;
  sha256: string;
  bytes: number;
}

// ─────────── per-key async mutex (single process) ───────────
const chains = new Map<string, Promise<void>>();
export async function acquireMutex(key: string): Promise<() => void> {
  const prev = chains.get(key) ?? Promise.resolve();
  let unlock!: () => void;
  const mine = new Promise<void>((r) => (unlock = r));
  const tail = prev.then(() => mine);
  chains.set(key, tail);
  await prev;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    unlock();
    if (chains.get(key) === tail) chains.delete(key);
  };
}

const versionsDir = (ctx: RouteContext, projectId: string) => join(ctx.dataDir, `${projectId}.versions`);

async function readIndex(ctx: RouteContext, projectId: string): Promise<StoredVersion[]> {
  try {
    const list = JSON.parse(await readFile(join(versionsDir(ctx, projectId), 'index.json'), 'utf8')) as StoredVersion[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function atomicWrite(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, file);
}

function versionId(now: Date, existing: StoredVersion[]): string {
  const base = `v${now.toISOString().replace(/[-:.]/g, '')}`;
  let id = base;
  for (let i = 2; existing.some((v) => v.id === id); i++) id = `${base}-${i}`;
  return id;
}

function summaryOf(ctx: RouteContext, project: Project): ProjectVersion['summary'] {
  const out = ctx.analyze(project);
  if (!out.ok) return { gpus: 0, racks: 0, itMW: 0, capexUSD: 0 };
  const s = out.analysis.summary;
  return { gpus: s.gpus, racks: s.racks, itMW: Math.round(s.itMW * 1000) / 1000, capexUSD: Math.round(s.capexUSD), rfs: s.readyForService };
}

/**
 * Store a snapshot of `project`. Returns null for an autosave whose content equals the newest version.
 * Serialised per project; prunes to VERSION_RETENTION.
 */
export async function recordVersion(ctx: RouteContext, project: Project, opts: { kind: VersionKind; savedBy?: string; note?: string }): Promise<StoredVersion | null> {
  if (!isValidId(project.id)) return null;
  const release = await acquireMutex(`versions:${project.id}`);
  try {
    const dir = versionsDir(ctx, project.id);
    await mkdir(dir, { recursive: true });
    const index = await readIndex(ctx, project.id);
    const content = projectContentKey(project);
    const sha256 = createHash('sha256').update(content).digest('hex');
    const last = index[index.length - 1];
    if (opts.kind === 'autosave' && last?.sha256 === sha256) return null;
    const now = new Date();
    const savedBy = opts.savedBy ? cleanDisplayName(opts.savedBy) : undefined;
    let replaced: StoredVersion | undefined;
    if (opts.kind === 'autosave' && last?.kind === 'autosave' && last.savedBy === savedBy && now.getTime() - Date.parse(last.savedAt) < AUTOSAVE_COALESCE_MS) {
      replaced = index.pop();
    }
    const json = JSON.stringify(project);
    const version: StoredVersion = {
      id: versionId(now, index),
      projectId: project.id,
      savedAt: now.toISOString(),
      ...(savedBy ? { savedBy } : {}),
      ...(opts.note ? { note: String(opts.note).slice(0, 500) } : {}),
      summary: summaryOf(ctx, project),
      kind: opts.kind,
      sha256,
      bytes: Buffer.byteLength(json),
    };
    await atomicWrite(join(dir, `${version.id}.json`), json);
    index.push(version);
    const pruned = index.length > VERSION_RETENTION ? index.splice(0, index.length - VERSION_RETENTION) : [];
    await atomicWrite(join(dir, 'index.json'), JSON.stringify(index, null, 1));
    for (const old of [...pruned, ...(replaced ? [replaced] : [])]) await rm(join(dir, `${old.id}.json`), { force: true });
    return version;
  } finally {
    release();
  }
}

export async function listVersions(ctx: RouteContext, projectId: string): Promise<StoredVersion[]> {
  return (await readIndex(ctx, projectId)).slice().reverse();
}

export async function readVersion(ctx: RouteContext, projectId: string, vid: string): Promise<Project | null> {
  if (!isValidId(vid) || vid === 'index') return null;
  try {
    return upgradeProject(JSON.parse(await readFile(join(versionsDir(ctx, projectId), `${vid}.json`), 'utf8')) as Project);
  } catch {
    return null;
  }
}

const RELEASE = Symbol('aidc.projectMutex');
const SAVED = Symbol('aidc.savedProject');
type Tagged = FastifyRequest & { [RELEASE]?: () => void; [SAVED]?: Project };

function parseIfMatch(v: string | undefined): string[] | null {
  if (!v) return null;
  return v.split(',').map((s) => s.trim().replace(/^W\//, '').replace(/^"|"$/g, '')).filter(Boolean);
}

export async function registerVersionRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const locks = lockManagerFor(app);
  const PROJECT_ROUTE = '/api/projects/:id';

  // ─────────── save preconditions + snapshot on save (hooks on the existing PUT route) ───────────
  app.addHook('preHandler', async (req, reply) => {
    if (req.method !== 'PUT' || req.routeOptions.url !== PROJECT_ROUTE) return;
    const id = (req.params as { id?: string }).id ?? '';
    if (!isValidId(id)) return;
    const release = await acquireMutex(`project:${id}`);
    (req as Tagged)[RELEASE] = release;
    reply.raw.once('close', release);
    const allowed = locks.allowsWrite(id, headerString(req.headers['x-aidc-lock']));
    if (!allowed.ok) return reply.code(423).send({ error: `project is being edited by ${allowed.lock.holder}`, lock: allowed.lock });
    const tags = parseIfMatch(headerString(req.headers['if-match']));
    if (!tags) {
      if (await ctx.store.exists(id)) {
        return reply.code(428).send({ code: 'if-match-required', error: 'If-Match with the base revision (ETag) is required to overwrite an existing project — reload it and save again' });
      }
    } else if (!tags.includes('*')) {
      const head = await ctx.store.get(id);
      if (head && !tags.includes(head.updatedAt)) {
        return reply.code(412).send({ error: 'the project was changed since your base revision', rev: head.updatedAt });
      }
    }
  });

  app.addHook('onSend', async (req, reply, payload) => {
    if (req.routeOptions.url !== PROJECT_ROUTE || (req.method !== 'PUT' && req.method !== 'GET') || reply.statusCode >= 300 || typeof payload !== 'string') return payload;
    try {
      const p = JSON.parse(payload) as Project;
      if (typeof p?.updatedAt === 'string') reply.header('etag', `"${p.updatedAt}"`);
      if (req.method === 'PUT' && isProjectLike(p)) {
        (req as Tagged)[SAVED] = p;
        await recordVersion(ctx, p, { kind: 'autosave', savedBy: userFromHeader(req.headers['x-aidc-user']) });
      }
    } catch (e) {
      app.log.warn({ err: e }, 'version snapshot failed');
    }
    return payload;
  });

  app.addHook('onResponse', async (req) => {
    (req as Tagged)[RELEASE]?.();
  });

  // ─────────── routes ───────────
  app.get<{ Params: { id: string } }>('/api/projects/:id/versions', async (req, reply) => {
    if (!isValidId(req.params.id)) return reply.code(400).send({ error: 'invalid project id' });
    return listVersions(ctx, req.params.id);
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/versions', async (req, reply) => {
    const id = req.params.id;
    if (!isValidId(id)) return reply.code(400).send({ error: 'invalid project id' });
    const body = (req.body ?? {}) as { note?: unknown; savedBy?: unknown; kind?: unknown; project?: unknown };
    const kind: VersionKind = body.kind === 'conflict-copy' ? 'conflict-copy' : 'manual';
    let project: Project | null;
    if (body.project !== undefined) {
      if (!isProjectLike(body.project)) return reply.code(400).send({ error: 'project is not an AIDC project (schemaVersion 1)' });
      project = { ...body.project, id };
    } else {
      project = await ctx.store.get(id);
      if (!project) return reply.code(404).send({ error: 'project not found' });
    }
    const savedBy = typeof body.savedBy === 'string' ? body.savedBy : userFromHeader(req.headers['x-aidc-user']);
    const v = await recordVersion(ctx, project, { kind, savedBy, note: typeof body.note === 'string' ? body.note : undefined });
    return reply.code(201).send(v);
  });

  app.get<{ Params: { id: string; vid: string } }>('/api/projects/:id/versions/:vid', async (req, reply) => {
    if (!isValidId(req.params.id)) return reply.code(400).send({ error: 'invalid project id' });
    const p = await readVersion(ctx, req.params.id, req.params.vid);
    return p ?? reply.code(404).send({ error: 'version not found' });
  });

  app.post<{ Params: { id: string; vid: string } }>('/api/projects/:id/versions/:vid/restore', async (req, reply) => {
    const { id, vid } = req.params;
    if (!isValidId(id)) return reply.code(400).send({ error: 'invalid project id' });
    const release = await acquireMutex(`project:${id}`);
    try {
      const allowed = locks.allowsWrite(id, headerString(req.headers['x-aidc-lock']));
      if (!allowed.ok) return reply.code(423).send({ error: `project is being edited by ${allowed.lock.holder}`, lock: allowed.lock });
      const snap = await readVersion(ctx, id, vid);
      if (!snap) return reply.code(404).send({ error: 'version not found' });
      const body = (req.body ?? {}) as { savedBy?: unknown };
      const savedBy = typeof body.savedBy === 'string' ? body.savedBy : userFromHeader(req.headers['x-aidc-user']);
      const head = await ctx.store.get(id);
      const preRestore = head ? await recordVersion(ctx, head, { kind: 'pre-restore', savedBy, note: `before restoring ${vid}` }) : null;
      const project: Project = { ...snap, id, createdAt: head?.createdAt ?? snap.createdAt, updatedAt: new Date().toISOString() };
      await ctx.store.put(project);
      reply.header('etag', `"${project.updatedAt}"`);
      return { project, preRestore };
    } finally {
      release();
    }
  });

  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>('/api/projects/:id/diff', async (req, reply) => {
    const id = req.params.id;
    if (!isValidId(id)) return reply.code(400).send({ error: 'invalid project id' });
    const load = async (ref: string | undefined): Promise<Project | null> => (!ref || ref === 'current' ? ctx.store.get(id) : readVersion(ctx, id, ref));
    const [a, b] = await Promise.all([load(req.query.from), load(req.query.to ?? 'current')]);
    if (!a || !b) return reply.code(404).send({ error: 'version not found' });
    const outA = ctx.analyze(a);
    const outB = ctx.analyze(b);
    if (!outA.ok || !outB.ok) return reply.code(500).send({ error: `analysis failed: ${!outA.ok ? outA.message : !outB.ok ? outB.message : ''}` });
    const details = withCatalog(resolveCatalog(b, ctx.library), () => diffProjectsDetailed(a, b, { analysisA: outA.analysis, analysisB: outB.analysis }));
    return { from: req.query.from ?? 'current', to: req.query.to ?? 'current', ...details };
  });
}
