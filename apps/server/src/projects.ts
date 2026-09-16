// Project management routes (v2-2 project management, docs/research/project-management-v2-2.md):
// list · create (templates / copy) · recoverable delete (trash) · restore · rename rules on the save path.
//
// Routes:
//   GET    /api/projects                         → ProjectListEntry[] (newest first; trash excluded)
//   POST   /api/projects                         { template?: 'reference'|'empty', name?, pods?, gpuRackCatalogId?, dryRun? } | Project
//                                                → 201 Project | 200 Project (dryRun: not stored) | 400 {code} | 409 {code:'name-taken', suggestion}
//   DELETE /api/projects/:id                     (x-aidc-lock when this client holds the lock) → 200 { trash: TrashManifest }
//                                                | 404 | 409 {code:'locked', lock} | 400 {code:'last-project'}
//   GET    /api/projects/trash                   → TrashManifest[] (newest first)
//   DELETE /api/projects/trash[?olderThanDays=N]  → 200 { removed, entries } — permanent: all entries, or those deleted more than N days ago
//                                                (backlog T3 (8); the client confirms first) | 400 {code:'invalid-days'}
//   POST   /api/projects/trash/:entry/restore    → 200 { project, originalId, renamedId, renamedName } | 404
//   PUT    /api/projects/:id (hook)              name changed → 400 {code:'name-empty'|'name-too-long'} | 409 {code:'name-taken'};
//                                                missing project + If-Match (or a trashed id) → 404 {code:'deleted'} (no resurrection by autosave)
//
// Trash layout: <trashDir>/<id>-<yyyymmddThhmmssmmmZ>/{manifest.json, project.json, versions/} — trashDir defaults to
// <dataDir>/../trash (a sibling of the project store, so ProjectStore.list never sees it). Entries are kept until restored or purged;
// optional retention AIDC_TRASH_RETENTION_DAYS=N purges entries older than N days when the trash is listed and at start-up.
// Every route sits behind the shared-secret hook of locks.ts (AIDC_SHARED_SECRET).
import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  cleanProjectName, createEmptyProject, createReferenceProject, createVendorSampleProject, isStandardsPresetId, PROJECT_NAME_MAX, PROJECT_TEMPLATE_IDS, PROJECT_TEMPLATE_NAMES, projectIdFor, projectNameError,
  resolveCatalog, uniqueProjectName, withCatalog, type Project, type ProjectNameError, type ProjectTemplateId,
} from '../../../packages/core/src/index.ts';
import type { RouteContext } from './app.ts';
import { projectCatalogImageErrors } from './catalogStore.ts';
import { headerString, lockManagerFor, userFromHeader } from './locks.ts';
import { isProjectLike, isValidId, summarize, type ProjectSummary } from './storage.ts';
import { acquireMutex, listVersions } from './versions.ts';

export interface ProjectListEntry extends ProjectSummary {
  createdAt?: string;
  /** saved versions kept for the project */
  versions: number;
  /** newest version's author / time (who last saved it) */
  savedBy?: string;
  savedAt?: string;
}

export interface TrashManifest {
  entry: string;
  id: string;
  name: string;
  deletedAt: string;
  deletedBy: string | null;
  updatedAt: string;
  halls: number;
  racks: number;
  gpus: number;
  versions: number;
  savedBy?: string;
}

const NAMES_MUTEX = 'projects:names';
const RELEASE_NAMES = Symbol('aidc.projectNamesMutex');
type Tagged = FastifyRequest & { [RELEASE_NAMES]?: () => void };

function nameErrorReply(err: ProjectNameError, name: string, taken: string[]) {
  if (err === 'taken') return { status: 409, body: { code: 'name-taken', error: `a project named "${cleanProjectName(name)}" already exists`, suggestion: uniqueProjectName(name, taken) } };
  if (err === 'too-long') return { status: 400, body: { code: 'name-too-long', error: `project name longer than ${PROJECT_NAME_MAX} characters`, max: PROJECT_NAME_MAX } };
  return { status: 400, body: { code: 'name-empty', error: 'project name is required' } };
}

/** rename, falling back to copy + remove across file systems */
async function move(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    await cp(from, to, { recursive: true, errorOnExist: true, force: false });
    await rm(from, { recursive: true, force: true });
  }
}

const stamp = (d: Date) => d.toISOString().replace(/[-:.]/g, '');

export async function registerProjectRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const locks = lockManagerFor(app);
  const trashDir = ctx.trashDir;
  const versionsDir = (id: string) => join(ctx.dataDir, `${id}.versions`);
  const withLib = <T>(p: Project | undefined, fn: () => T): T => withCatalog(resolveCatalog(p, ctx.library), fn);

  async function readTrash(): Promise<TrashManifest[]> {
    let names: string[];
    try {
      names = await readdir(trashDir);
    } catch {
      return [];
    }
    const out: TrashManifest[] = [];
    for (const n of names) {
      if (!isValidId(n)) continue;
      try {
        const m = JSON.parse(await readFile(join(trashDir, n, 'manifest.json'), 'utf8')) as TrashManifest;
        if (m && typeof m.id === 'string' && existsSync(join(trashDir, n, 'project.json'))) out.push({ ...m, entry: n });
      } catch {
        // incomplete / foreign folder — not listed
      }
    }
    return out.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  }

  const idTaken = async (id: string) => (await ctx.store.exists(id)) || existsSync(versionsDir(id));

  // ─────────── list ───────────
  app.get('/api/projects', async (): Promise<ProjectListEntry[]> => {
    const list = await ctx.store.list();
    return Promise.all(
      list.map(async (s) => {
        const v = await listVersions(ctx, s.id).catch(() => []);
        const newest = v[0];
        return { ...s, versions: v.length, ...(newest?.savedBy ? { savedBy: newest.savedBy } : {}), ...(newest ? { savedAt: newest.savedAt } : {}) };
      }),
    );
  });

  // ─────────── create ───────────
  app.post('/api/projects', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const savedBy = userFromHeader(req.headers['x-aidc-user']);
    let project: Project;
    let requestedName: string | undefined;
    let defaultName = PROJECT_TEMPLATE_NAMES.reference;
    let source: string;
    if (isProjectLike(body)) {
      const imageErrs = projectCatalogImageErrors(body);
      if (imageErrs.length) return reply.code(400).send({ code: 'invalid-image', error: 'invalid catalog extension image', details: imageErrs });
      project = { ...body };
      requestedName = body.name;
      source = 'copy';
    } else {
      const template = (body.template ?? 'reference') as ProjectTemplateId;
      if (!PROJECT_TEMPLATE_IDS.includes(template)) return reply.code(400).send({ code: 'unknown-template', error: `unknown template: ${String(body.template)}` });
      // stream D (P4): standards profile preset of an empty site (DO-1 default orv3-hpr-liquid); unknown presets are refused
      if (body.preset !== undefined && !isStandardsPresetId(body.preset)) return reply.code(400).send({ code: 'unknown-preset', error: `unknown standards preset: ${String(body.preset)}` });
      const preset = isStandardsPresetId(body.preset) ? body.preset : undefined;
      const pods = typeof body.pods === 'number' ? Math.max(1, Math.min(64, Math.floor(body.pods))) : undefined;
      const gpuRackCatalogId = typeof body.gpuRackCatalogId === 'string' ? body.gpuRackCatalogId : undefined;
      // S3: the template may reference a server-library rack id → resolve builtin ∪ library while generating
      project = withLib(undefined, () =>
        template === 'empty' ? createEmptyProject({ gpuRackCatalogId, preset })
        : template === 'nvidia-reference' ? createVendorSampleProject('nvidia-reference', { pods, gpuRackCatalogId }).project
        : createReferenceProject({ pods, gpuRackCatalogId }).project);
      requestedName = typeof body.name === 'string' ? body.name : undefined;
      defaultName = PROJECT_TEMPLATE_NAMES[template];
      source = `template ${template}`;
      if (body.dryRun === true) {
        // template preview (the in-place "reset to template" of the web app): nothing is stored, no name rule
        return reply.code(200).send({ ...project, name: cleanProjectName(requestedName) || defaultName });
      }
    }
    const release = await acquireMutex(NAMES_MUTEX);
    try {
      const existing = await ctx.store.list();
      const taken = existing.map((p) => p.name);
      let name: string;
      if (requestedName !== undefined) {
        const err = projectNameError(requestedName, existing);
        if (err) {
          const r = nameErrorReply(err, requestedName, taken);
          return reply.code(r.status).send(r.body);
        }
        name = cleanProjectName(requestedName);
      } else {
        name = uniqueProjectName(defaultName, taken);
      }
      let id = projectIdFor(name);
      while (await idTaken(id)) id = projectIdFor(name);
      const now = new Date().toISOString();
      // a new id: the source project's versions (<old>.versions/) and lock stay with the source; history starts with the first save
      project = { ...project, id, name, createdAt: now, updatedAt: now };
      await ctx.store.put(project);
      app.log.info({ projectId: id, source, by: savedBy }, 'project created');
      reply.header('etag', `"${project.updatedAt}"`);
      return reply.code(201).send(project);
    } finally {
      release();
    }
  });

  // ─────────── recoverable delete ───────────
  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    const id = req.params.id;
    if (!isValidId(id)) return reply.code(400).send({ code: 'invalid-id', error: 'invalid project id' });
    const releaseProject = await acquireMutex(`project:${id}`);
    try {
      const head = await ctx.store.get(id);
      if (!head) return reply.code(404).send({ code: 'not-found', error: 'project not found' });
      const allowed = locks.allowsWrite(id, headerString(req.headers['x-aidc-lock']));
      if (!allowed.ok) return reply.code(409).send({ code: 'locked', error: `project is being edited by ${allowed.lock.holder}`, lock: allowed.lock });
      const others = (await ctx.store.list()).filter((p) => p.id !== id);
      if (!others.length) return reply.code(400).send({ code: 'last-project', error: 'the last remaining project cannot be deleted' });

      const releaseVersions = await acquireMutex(`versions:${id}`);
      try {
        const deleted = new Date();
        let entry = `${id}-${stamp(deleted)}`;
        for (let i = 2; existsSync(join(trashDir, entry)); i++) entry = `${id}-${stamp(deleted)}-${i}`;
        const dir = join(trashDir, entry);
        await mkdir(dir, { recursive: true });
        const versions = await listVersions(ctx, id).catch(() => []);
        const sum = withLib(head, () => summarize(head));
        const manifest: TrashManifest = {
          entry, id, name: head.name, deletedAt: deleted.toISOString(), deletedBy: userFromHeader(req.headers['x-aidc-user']) ?? null,
          updatedAt: head.updatedAt, halls: sum.halls, racks: sum.racks, gpus: sum.gpus, versions: versions.length,
          ...(versions[0]?.savedBy ? { savedBy: versions[0].savedBy } : {}),
        };
        await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
        // project file first: from here on the project is out of the list; the history follows it
        await move(join(ctx.dataDir, `${id}.json`), join(dir, 'project.json'));
        if (existsSync(versionsDir(id))) await move(versionsDir(id), join(dir, 'versions'));
        locks.release(id);
        app.log.info({ projectId: id, entry }, 'project moved to trash');
        return reply.code(200).send({ trash: manifest });
      } finally {
        releaseVersions();
      }
    } finally {
      releaseProject();
    }
  });

  // ─────────── trash ───────────
  const retentionDays = Number(process.env.AIDC_TRASH_RETENTION_DAYS ?? '');
  /** permanently remove trash entries (all, or deleted more than `olderThanDays` days ago); returns the removed entry names */
  async function purgeTrash(olderThanDays?: number): Promise<string[]> {
    const cutoff = olderThanDays === undefined ? Infinity : Date.now() - olderThanDays * 86_400_000;
    const removed: string[] = [];
    for (const m of await readTrash()) {
      if (olderThanDays !== undefined && !(Date.parse(m.deletedAt) < cutoff)) continue;
      await rm(join(trashDir, m.entry), { recursive: true, force: true });
      removed.push(m.entry);
    }
    return removed;
  }
  const applyRetention = async () => {
    if (!(retentionDays > 0)) return;
    const removed = await purgeTrash(retentionDays).catch(() => []);
    if (removed.length) app.log.info({ removed: removed.length, retentionDays }, 'trash retention purge');
  };
  await applyRetention();

  app.get('/api/projects/trash', async () => {
    await applyRetention();
    return readTrash();
  });

  app.delete<{ Querystring: { olderThanDays?: string } }>('/api/projects/trash', async (req, reply) => {
    const raw = req.query.olderThanDays;
    let days: number | undefined;
    if (raw !== undefined && raw !== '') {
      days = Number(raw);
      if (!Number.isFinite(days) || days < 0 || days > 3650) return reply.code(400).send({ code: 'invalid-days', error: 'olderThanDays must be a number of days between 0 and 3650' });
    }
    const release = await acquireMutex(NAMES_MUTEX);
    try {
      const entries = await purgeTrash(days);
      app.log.info({ removed: entries.length, olderThanDays: days ?? null }, 'trash purged');
      return { removed: entries.length, entries };
    } finally {
      release();
    }
  });

  app.post<{ Params: { entry: string } }>('/api/projects/trash/:entry/restore', async (req, reply) => {
    const entry = req.params.entry;
    if (!isValidId(entry)) return reply.code(400).send({ code: 'invalid-entry', error: 'invalid trash entry' });
    const dir = join(trashDir, entry);
    const release = await acquireMutex(NAMES_MUTEX);
    try {
      let manifest: TrashManifest;
      let project: Project;
      try {
        manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as TrashManifest;
        project = JSON.parse(await readFile(join(dir, 'project.json'), 'utf8')) as Project;
      } catch {
        return reply.code(404).send({ code: 'not-found', error: 'trash entry not found' });
      }
      if (!isProjectLike(project)) return reply.code(422).send({ code: 'invalid-project', error: 'the trashed file is not an AIDC project' });
      const originalId = isValidId(manifest.id) ? manifest.id : isValidId(project.id) ? project.id : projectIdFor(project.name);
      let id = originalId;
      const renamedId = await idTaken(id);
      if (renamedId) {
        id = projectIdFor(`${originalId.slice(0, 60)} restored`);
        while (await idTaken(id)) id = projectIdFor(`${originalId.slice(0, 60)} restored`);
      }
      const existing = await ctx.store.list();
      const renamedName = projectNameError(project.name, existing) !== null;
      const name = renamedName ? uniqueProjectName(`${cleanProjectName(project.name) || 'Project'} (restored)`, existing.map((p) => p.name)) : cleanProjectName(project.name);
      const restored: Project = { ...project, id, name, updatedAt: new Date().toISOString() };
      const trashedVersions = join(dir, 'versions');
      if (existsSync(trashedVersions)) {
        await move(trashedVersions, versionsDir(id));
        if (id !== project.id) {
          const indexFile = join(versionsDir(id), 'index.json');
          try {
            const index = JSON.parse(await readFile(indexFile, 'utf8')) as { projectId?: string }[];
            await writeFile(indexFile, JSON.stringify(index.map((v) => ({ ...v, projectId: id })), null, 1), 'utf8');
          } catch {
            /* no index — nothing to re-key */
          }
        }
      }
      await ctx.store.put(restored);
      await rm(dir, { recursive: true, force: true });
      app.log.info({ projectId: id, entry }, 'project restored from trash');
      reply.header('etag', `"${restored.updatedAt}"`);
      return { project: restored, originalId, renamedId, renamedName };
    } finally {
      release();
    }
  });

  // ─────────── rename rule + no resurrection on the save path (runs after versions.ts' lock / If-Match hook) ───────────
  app.addHook('preHandler', async (req, reply) => {
    if (req.method !== 'PUT' || req.routeOptions.url !== '/api/projects/:id' || reply.sent) return;
    const id = (req.params as { id?: string }).id ?? '';
    if (!isValidId(id) || !isProjectLike(req.body)) return; // the route answers 400
    const body = req.body as Project;
    const head = await ctx.store.get(id);
    if (!head) {
      // an autosave of a project another client deleted carries If-Match (its base revision) → do not re-create it
      const inTrash = (await readTrash()).some((m) => m.id === id);
      if (headerString(req.headers['if-match']) || inTrash) {
        return reply.code(404).send({ code: 'deleted', error: 'project not found — it was deleted (restore it from Recently deleted)' });
      }
    }
    if (head && body.name === head.name) return;
    const release = await acquireMutex(NAMES_MUTEX);
    (req as Tagged)[RELEASE_NAMES] = release;
    reply.raw.once('close', release);
    const existing = await ctx.store.list();
    const err = projectNameError(body.name, existing, id);
    if (err) {
      const r = nameErrorReply(err, body.name, existing.filter((p) => p.id !== id).map((p) => p.name));
      return reply.code(r.status).send(r.body);
    }
    body.name = cleanProjectName(body.name);
  });

  app.addHook('onResponse', async (req) => {
    (req as Tagged)[RELEASE_NAMES]?.();
  });
}

