import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { existsSync, statSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import {
  analyzeProject,
  cableTypes,
  catalogItems,
  EXPORT_FORMATS,
  inferenceXApiUrl,
  inferenceXModelName,
  resolveCatalog,
  withCatalog,
  type CatalogLibrary,
  type ExportFormat,
  type Project,
  type ProjectAnalysis,
} from '../../../packages/core/src/index.ts';
import { buildExportZip } from './export-zip.ts';
import { CatalogStore, catalogLibraryErrors, projectCatalogImageErrors } from './catalogStore.ts';
import { DEFAULTS } from './paths.ts';
import { isProjectLike, isValidId, ProjectStore, summarize } from './storage.ts';
import { encodeThermalResult, runThermalJob, ThermalNotReadyError } from './thermal.ts';
// v2 2차 (T8): route modules — bodies live in their own files; app.ts only registers them
import { registerLlmRoutes } from './llm.ts';
import { registerVersionRoutes } from './versions.ts';
import { redactUrl, registerLockRoutes } from './locks.ts';
// v2-2 project management: list · create (templates / copy) · recoverable delete (trash) · restore · rename rule
import { registerProjectRoutes } from './projects.ts';

export interface ServerOptions {
  dataDir?: string;
  webDist?: string;
  publicAssets?: string;
  templatesRoot?: string;
  thermalModule?: string;
  logger?: boolean;
  /** seed the reference project when the store is empty */
  seed?: boolean;
  /** directory of the server-global catalog library (custom.json); default `<dataDir>/../catalog` (S3) */
  catalogDir?: string;
  /** deleted projects (recoverable); default `<dataDir>/../trash` */
  trashDir?: string;
}

const VERSION = '0.1.0';
const inferenceXCache = new Map<string, { expiresAt: number; rows: unknown[] }>();

/**
 * Server-global catalog library (stream S3 fills this from data/catalog/*.json via GET/PUT /api/catalog/custom).
 * Every request that resolves catalog ids runs inside `withCatalog(resolveCatalog(project, library), …)`.
 */
const library: CatalogLibrary = { items: [], cables: [] };
export function getCatalogLibrary(): CatalogLibrary {
  return library;
}
/** Run a synchronous function with the project's effective catalog (builtin ∪ library ∪ project extensions). */
function withProjectCatalog<T>(project: Project | null | undefined, fn: () => T): T {
  return withCatalog(resolveCatalog(project ?? undefined, library), fn);
}

export type AnalyzeOutcome = { ok: true; analysis: ProjectAnalysis } | { ok: false; status: number; message: string };

/** What v2 2차 route modules (llm.ts, versions.ts, locks.ts) get from buildServer. */
export interface RouteContext {
  /** project store directory (versions / locks live in sibling folders — r2-platform.md §4) */
  dataDir: string;
  /** recoverable deletes: <trashDir>/<id>-<timestamp>/ (projects.ts) */
  trashDir: string;
  /** persisted edit locks (locks.ts); default <dataDir>/.locks/locks.json */
  locksFile?: string;
  store: ProjectStore;
  /** server-global catalog library (mutated in place by PUT /api/catalog/custom) */
  library: CatalogLibrary;
  /** analyze under builtin ∪ library ∪ project catalog */
  analyze(project: Project): AnalyzeOutcome;
}

function tryAnalyze(project: Project): AnalyzeOutcome {
  try {
    // analyzeProject resolves project.catalogExtensions itself; the wrapper adds the server library
    return { ok: true, analysis: withProjectCatalog(project, () => analyzeProject(project)) };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, status: /not implemented/i.test(message) ? 501 : 500, message };
  }
}

function sendZip(reply: FastifyReply, zip: { buffer: Buffer; filename: string }) {
  return reply
    .header('content-type', 'application/zip')
    .header('content-disposition', `attachment; filename="${zip.filename}"`)
    .header('content-length', zip.buffer.length)
    .send(zip.buffer);
}

export async function buildServer(opts: ServerOptions = {}): Promise<FastifyInstance> {
  const cfg = {
    dataDir: opts.dataDir ?? DEFAULTS.dataDir,
    webDist: opts.webDist ?? DEFAULTS.webDist,
    publicAssets: opts.publicAssets ?? DEFAULTS.publicAssets,
    templatesRoot: opts.templatesRoot ?? DEFAULTS.templatesRoot,
    thermalModule: opts.thermalModule ?? DEFAULTS.thermalModule,
  };
  // polish v2 2차: request logs never carry secrets / lock tokens from query strings
  const logger = opts.logger ? { serializers: { req: (r: { method: string; url: string; hostname?: string; ip?: string }) => ({ method: r.method, url: redactUrl(r.url), hostname: r.hostname, remoteAddress: r.ip }) } } : false;
  const app = Fastify({ logger, bodyLimit: 256 * 1024 * 1024 });
  await app.register(cors, { origin: true, exposedHeaders: ['content-disposition'] });

  const store = new ProjectStore(cfg.dataDir);
  await store.init();
  if (opts.seed) await store.seedIfEmpty();

  // S3: server-global catalog library (data/catalog/custom.json) → the module-level `library` (mutated in place)
  const catalogStore = new CatalogStore(opts.catalogDir ?? resolve(cfg.dataDir, '..', 'catalog'));
  await catalogStore.init();
  {
    const loaded = await catalogStore.load();
    library.items = loaded.library.items;
    library.cables = loaded.library.cables;
    if (loaded.errors.length) app.log.warn({ errors: loaded.errors }, 'catalog library ignored (invalid custom.json)');
  }

  const zipCfg = { templatesRoot: cfg.templatesRoot, modelsDir: join(cfg.publicAssets, 'models') };

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) app.log.error(err);
    void reply.code(status).send({ error: err.message });
  });

  // ─────────── meta ───────────
  app.get('/api/health', async () => ({
    ok: true,
    name: 'aidc-studio',
    version: VERSION,
    time: new Date().toISOString(),
    dataDir: cfg.dataDir,
    webBuilt: existsSync(join(cfg.webDist, 'index.html')),
    // clients enable New / Delete / Recently deleted only against a server with recoverable deletes
    features: ['project-trash', 'trash-purge', 'if-match-required'],
  }));

  // builtin ∪ server library (project extensions travel with the project itself)
  app.get('/api/catalog', async () => withCatalog(resolveCatalog(undefined, library), () => ({ items: catalogItems(), cables: cableTypes() })));

  // Public, read-only benchmark bridge. The upstream API has no browser CORS contract, so the local server performs the
  // fixed-origin request; clients still rank rows against topology, precision, ISL/OSL and SLO locally.
  app.get<{ Querystring: { presetId?: string; sequence?: string } }>('/api/inferencex/benchmarks', async (req, reply) => {
    const publicModel = inferenceXModelName(req.query.presetId);
    if (!publicModel) return reply.code(400).send({ error: 'no exact InferenceX model mapping for this preset' });
    const sequence = req.query.sequence === 'agentic-traces' ? 'agentic-traces' as const : undefined;
    if (req.query.sequence && !sequence) return reply.code(400).send({ error: 'unsupported InferenceX sequence' });
    const cacheKey = `${publicModel}:${sequence ?? 'default'}`;
    const cached = inferenceXCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return { model: publicModel, rows: cached.rows, cached: true };
    let upstream: Response;
    try {
      upstream = await fetch(inferenceXApiUrl(publicModel, sequence), { headers: { accept: 'application/json', 'user-agent': 'AIDC-Studio/0.1' }, signal: AbortSignal.timeout(15000) });
    } catch (error) {
      return reply.code(502).send({ error: `InferenceX API unavailable: ${error instanceof Error ? error.message : String(error)}` });
    }
    if (!upstream.ok) return reply.code(502).send({ error: `InferenceX API returned ${upstream.status}` });
    const body = await upstream.json() as unknown;
    if (!Array.isArray(body)) return reply.code(502).send({ error: 'InferenceX API returned an unexpected response shape' });
    const rows = body.slice(0, 5000);
    inferenceXCache.set(cacheKey, { expiresAt: Date.now() + 15 * 60_000, rows });
    return { model: publicModel, rows, cached: false };
  });

  // ─────────── S3: server-global catalog library (data/catalog/custom.json) ───────────
  app.get('/api/catalog/custom', async () => ({ items: library.items ?? [], cables: library.cables ?? [], file: catalogStore.file }));

  app.put('/api/catalog/custom', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const errors = catalogLibraryErrors(body);
    if (errors.length) return reply.code(400).send({ error: 'invalid catalog library', errors: errors.slice(0, 50) });
    const saved = await catalogStore.save({ items: body.items as CatalogLibrary['items'], cables: body.cables as CatalogLibrary['cables'] });
    library.items = saved.items;
    library.cables = saved.cables;
    return { items: saved.items, cables: saved.cables, file: catalogStore.file };
  });

  // ─────────── projects ───────────
  // GET /api/projects · POST /api/projects · DELETE /api/projects/:id · trash routes → projects.ts (registered below)

  app.get<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    if (!isValidId(req.params.id)) return reply.code(400).send({ error: 'invalid project id' });
    const p = await store.get(req.params.id);
    return p ?? reply.code(404).send({ error: 'project not found' });
  });

  app.put<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    if (!isValidId(req.params.id)) return reply.code(400).send({ error: 'invalid project id' });
    if (!isProjectLike(req.body)) return reply.code(400).send({ error: 'body is not an AIDC project (schemaVersion 1)' });
    // T5 (F6) image rule also on the project save path: catalogExtensions[].image (PNG / JPEG / WebP data URL ≤ 1 MB, /assets/ src)
    const imageErrs = projectCatalogImageErrors(req.body);
    if (imageErrs.length) return reply.code(400).send({ error: 'invalid catalog extension image', details: imageErrs });
    const prev = await store.get(req.params.id);
    const project: Project = { ...req.body, id: req.params.id, createdAt: prev?.createdAt ?? req.body.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString() };
    await store.put(project);
    return reply.code(prev ? 200 : 201).send(project);
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/summary', async (req, reply) => {
    if (!isValidId(req.params.id)) return reply.code(400).send({ error: 'invalid project id' });
    const p = await store.get(req.params.id);
    return p ? withProjectCatalog(p, () => summarize(p)) : reply.code(404).send({ error: 'project not found' });
  });

  // ─────────── analysis ───────────
  app.post('/api/analyze', async (req, reply) => {
    const body = req.body as Record<string, unknown> | undefined;
    const project = isProjectLike(body) ? body : isProjectLike(body?.project) ? (body!.project as Project) : null;
    if (!project) return reply.code(400).send({ error: 'body must be a Project or { project }' });
    const out = tryAnalyze(project);
    return out.ok ? out.analysis : reply.code(out.status).send({ error: out.message });
  });

  // ─────────── export ───────────
  const exportHandler = async (project: Project, analysisIn: ProjectAnalysis | null | undefined, format: string, reply: FastifyReply) => {
    if (!EXPORT_FORMATS.includes(format as ExportFormat)) return reply.code(400).send({ error: `unknown format '${format}' (expected ${EXPORT_FORMATS.join(', ')})` });
    let analysis = analysisIn ?? null;
    if (!analysis) {
      const out = tryAnalyze(project);
      if (out.ok) analysis = out.analysis;
    }
    // buildExportZip is async (zip packaging); it runs the synchronous catalog-dependent generation under this index
    const zip = await buildExportZip(project, analysis, format as ExportFormat, { ...zipCfg, catalog: resolveCatalog(project, library) });
    return sendZip(reply, zip);
  };

  app.post<{ Params: { format: string } }>('/api/export/:format', async (req, reply) => {
    const body = req.body as Record<string, unknown> | undefined;
    const project = isProjectLike(body?.project) ? (body!.project as Project) : isProjectLike(body) ? body : null;
    if (!project) return reply.code(400).send({ error: 'body must be { project, analysis? } or a Project' });
    return exportHandler(project, (body?.analysis as ProjectAnalysis | undefined) ?? null, req.params.format, reply);
  });

  app.get<{ Params: { id: string; format: string } }>('/api/projects/:id/export/:format', async (req, reply) => {
    if (!isValidId(req.params.id)) return reply.code(400).send({ error: 'invalid project id' });
    const p = await store.get(req.params.id);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    return exportHandler(p, null, req.params.format, reply);
  });

  // ─────────── thermal ───────────
  app.post('/api/thermal', async (req, reply) => {
    const body = (req.body ?? {}) as { project?: unknown; options?: Record<string, unknown>; timeoutMs?: number };
    if (!isProjectLike(body.project)) return reply.code(400).send({ error: 'body must be { project, options }' });
    const options = { hallId: body.project.halls[0]?.id, ...(body.options ?? {}) };
    try {
      // the worker thread activates resolveCatalog(project, library) itself (thermal-worker.ts)
      const result = await runThermalJob(body.project, options, body.timeoutMs ?? 10 * 60_000, cfg.thermalModule, library);
      return encodeThermalResult(result);
    } catch (e) {
      if (e instanceof ThermalNotReadyError) return reply.code(501).send({ error: e.message });
      throw e;
    }
  });

  // ─────────── v2 2차 (T8): LLM Q&A · version history · project locks ───────────
  const routeCtx: RouteContext = { dataDir: cfg.dataDir, trashDir: opts.trashDir ?? resolve(cfg.dataDir, '..', 'trash'), store, library, analyze: tryAnalyze };
  await registerLlmRoutes(app, routeCtx);
  await registerVersionRoutes(app, routeCtx);
  await registerLockRoutes(app, routeCtx);
  // after versions.ts: its lock / If-Match preHandler on PUT /api/projects/:id runs before the rename rule
  await registerProjectRoutes(app, routeCtx);

  // ─────────── static web app + assets ───────────
  const hasDist = existsSync(join(cfg.webDist, 'index.html'));
  const hasAssets = existsSync(cfg.publicAssets);
  if (hasDist) {
    await app.register(fastifyStatic, { root: cfg.webDist, prefix: '/' });
  } else if (hasAssets) {
    await app.register(fastifyStatic, { root: cfg.publicAssets, prefix: '/assets/' });
    app.get('/', async (_req, reply) =>
      reply.type('text/html').send('<h1>AIDC Studio API</h1><p>Web app not built. Run <code>npm run build</code> or use the Vite dev server (<code>npm run dev</code>).</p>'),
    );
  }

  app.setNotFoundHandler(async (req, reply) => {
    const path = decodeURIComponent(req.url.split('?')[0]);
    if (path.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
    if (hasDist && hasAssets && path.startsWith('/assets/')) {
      const rel = normalize(path.slice('/assets/'.length));
      const abs = join(cfg.publicAssets, rel);
      if (!rel.startsWith('..') && existsSync(abs) && statSync(abs).isFile()) return reply.sendFile(rel, cfg.publicAssets);
    }
    if (hasDist && req.method === 'GET' && !/\.[a-z0-9]+$/i.test(path)) return reply.sendFile('index.html', cfg.webDist);
    return reply.code(404).send({ error: 'not found' });
  });

  return app;
}
