// Advisory project locks by display name (stream T8, DECISIONS-v2 #12, DECISIONS-v2-2 §C, r2-platform.md §4.4).
//
// TTL 120 s, heartbeat every 40 s (ttl/3); expired locks are dropped. No accounts: identity = display name + a random
// per-browser clientId; the token returned on acquisition must accompany heartbeats, releases and project saves
// (header `x-aidc-lock`). Force release snapshots the current head as a 'pre-force-release' version first.
// Locks live in memory (single server process) and, backlog T3 (5), are written to a small JSON file (default
// <dataDir>/.locks/locks.json, mode 0600) on every grant / heartbeat / release; a restart reloads the unexpired ones, so the TTL still applies
// and a restart no longer silently frees a project someone is editing.
//
// Optional LAN shared secret: when AIDC_SHARED_SECRET is set, every /api/* request except GET /api/health must carry
// header `x-aidc-secret: <secret>` — 401 otherwise. The pagehide beacon (navigator.sendBeacon cannot set headers) sends the secret
// in its text/plain JSON body instead of the URL, so the secret never reaches request logs (polish v2 2차).
//
// Routes:
//   GET    /api/projects/:id/lock            → { lock: ProjectLock | null, ttlSec, heartbeatSec, serverTime }
//   POST   /api/projects/:id/lock            { holder, clientId, token?, force? } → 200 { lock, token, forced?, previousHolder? } | 423 { lock }
//   DELETE /api/projects/:id/lock?token=…    → 204 | 409 { lock }
//   POST   /api/projects/:id/lock/release    { token } (sendBeacon on pagehide) → 204 | 409
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ProjectLock } from '../../../packages/core/src/index.ts';
import type { RouteContext } from './app.ts';
import { isValidId } from './storage.ts';
import { recordVersion } from './versions.ts';

/** Lock time-to-live after the last heartbeat (s) — DECISIONS-v2-2 §C. */
export const LOCK_TTL_S = 120;
/** Client heartbeat interval (s) = TTL / 3 — DECISIONS-v2-2 §C. */
export const LOCK_HEARTBEAT_S = 40;

export interface LockRecord extends ProjectLock {
  clientId: string;
  token: string;
  heartbeatAt: string;
}

export class LockManager {
  private readonly locks = new Map<string, LockRecord>();
  ttlMs = LOCK_TTL_S * 1000;
  now: () => number = () => Date.now();
  private file?: string;

  /** Persist locks to `file` and load its unexpired records (a missing or unreadable file = no locks). */
  attachFile(file: string): void {
    this.file = file;
    try {
      const rows = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      for (const l of Array.isArray(rows) ? (rows as LockRecord[]) : []) {
        if (!l || typeof l.projectId !== 'string' || !isValidId(l.projectId) || typeof l.token !== 'string' || typeof l.clientId !== 'string') continue;
        if (typeof l.expiresAt !== 'string' || !(Date.parse(l.expiresAt) > this.now())) continue;
        this.locks.set(l.projectId, { projectId: l.projectId, holder: cleanDisplayName(l.holder), clientId: l.clientId, token: l.token, acquiredAt: String(l.acquiredAt), heartbeatAt: String(l.heartbeatAt), expiresAt: l.expiresAt });
      }
    } catch {
      /* no file yet */
    }
  }

  private persist(): void {
    if (!this.file) return;
    try {
      const live = [...this.locks.values()].filter((l) => Date.parse(l.expiresAt) > this.now());
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(live), { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, this.file);
    } catch {
      /* best effort: the in-memory locks stay authoritative */
    }
  }

  active(projectId: string): LockRecord | null {
    const l = this.locks.get(projectId);
    if (!l) return null;
    if (Date.parse(l.expiresAt) <= this.now()) {
      this.locks.delete(projectId);
      this.persist();
      return null;
    }
    return l;
  }

  grant(projectId: string, holder: string, clientId: string): LockRecord {
    const now = this.now();
    const rec: LockRecord = {
      projectId,
      holder,
      clientId,
      token: randomBytes(18).toString('base64url'),
      acquiredAt: new Date(now).toISOString(),
      heartbeatAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlMs).toISOString(),
    };
    this.locks.set(projectId, rec);
    this.persist();
    return rec;
  }

  refresh(rec: LockRecord, holder?: string): LockRecord {
    const now = this.now();
    rec.heartbeatAt = new Date(now).toISOString();
    rec.expiresAt = new Date(now + this.ttlMs).toISOString();
    if (holder) rec.holder = holder;
    this.persist();
    return rec;
  }

  release(projectId: string): void {
    this.locks.delete(projectId);
    this.persist();
  }

  /** Can a write carrying `token` modify the project? (no active lock, or the token matches) */
  allowsWrite(projectId: string, token: string | undefined): { ok: true } | { ok: false; lock: ProjectLock } {
    const l = this.active(projectId);
    if (!l || (token && token === l.token)) return { ok: true };
    return { ok: false, lock: publicLock(l) };
  }
}

export function publicLock(l: LockRecord): ProjectLock {
  return { projectId: l.projectId, holder: l.holder, acquiredAt: l.acquiredAt, expiresAt: l.expiresAt };
}

const managers = new WeakMap<FastifyInstance, LockManager>();
/** The lock manager of a server instance (created on first use; shared by versions.ts save hooks). */
export function lockManagerFor(app: FastifyInstance): LockManager {
  let m = managers.get(app);
  if (!m) managers.set(app, (m = new LockManager()));
  return m;
}

/** Display names: trimmed, control characters removed, ≤ 60 chars; empty → 'Guest'. */
export function cleanDisplayName(v: unknown): string {
  const s = typeof v === 'string' ? v : '';
  let out = '';
  for (const ch of s) if (ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127) out += ch;
  out = out.trim().slice(0, 60);
  return out || 'Guest';
}

export function headerString(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' && s.length ? s : undefined;
}

/** Decode the URI-encoded `x-aidc-user` header. */
export function userFromHeader(v: string | string[] | undefined): string | undefined {
  const s = headerString(v);
  if (!s) return undefined;
  try {
    return cleanDisplayName(decodeURIComponent(s));
  } catch {
    return cleanDisplayName(s);
  }
}

/** true when no shared secret is configured or `given` matches it (constant time); `secret` is read once per server at registration */
export function sharedSecretOk(given: string | undefined, secret: string | undefined): boolean {
  if (!secret) return true;
  const expected = Buffer.from(secret);
  const buf = Buffer.from(given ?? '');
  return buf.length === expected.length && timingSafeEqual(buf, expected);
}

const RELEASE_PATH = /^\/api\/projects\/[^/]+\/lock\/release$/;

function installSharedSecret(app: FastifyInstance, secret: string | undefined): void {
  if (!secret) return;
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (!path.startsWith('/api/') || path === '/api/health') return;
    // the beacon release carries the secret in its body (checked by the route after parsing); a header works there too
    if (req.method === 'POST' && RELEASE_PATH.test(path)) return;
    if (!sharedSecretOk(headerString(req.headers['x-aidc-secret']), secret)) {
      return reply.code(401).send({ error: 'shared secret required (x-aidc-secret header)', sharedSecret: true });
    }
  });
}

/** Redact secrets and lock tokens from a logged URL (Fastify request serializer, apps/server/src/app.ts). */
export function redactUrl(url: string): string {
  return url.replace(/([?&](?:secret|token|apiKey|api_key|key)=)[^&#]*/gi, '$1[redacted]');
}

export async function registerLockRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const secret = process.env.AIDC_SHARED_SECRET || undefined;
  installSharedSecret(app, secret);
  const locks = lockManagerFor(app);
  locks.attachFile(ctx.locksFile ?? join(ctx.dataDir, '.locks', 'locks.json'));

  // polish v2 2차 (QA collab #7): the catalog library is server-global, but a client editing inside a project sends that project's id
  // (`x-aidc-project`) with its lock token (`x-aidc-lock`). While another holder has that project's lock the write is refused (423),
  // so a read-only viewer cannot change catalog data the holder's project resolves. Requests without the project header (scripts,
  // the catalog import tool) are not project-scoped and stay allowed — the library has no lock of its own.
  app.addHook('preHandler', async (req, reply) => {
    if (req.method !== 'PUT' || req.url.split('?')[0] !== '/api/catalog/custom') return;
    const projectId = headerString(req.headers['x-aidc-project']);
    if (!projectId || !isValidId(projectId)) return;
    const cur = locks.active(projectId);
    if (!cur || headerString(req.headers['x-aidc-lock']) === cur.token) return;
    return reply.code(423).send({ error: 'project is locked by another editor — catalog library changes are refused', lock: publicLock(cur) });
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/lock', async (req, reply) => {
    if (!isValidId(req.params.id)) return reply.code(400).send({ error: 'invalid project id' });
    const l = locks.active(req.params.id);
    return { lock: l ? publicLock(l) : null, ttlSec: locks.ttlMs / 1000, heartbeatSec: LOCK_HEARTBEAT_S, serverTime: new Date(locks.now()).toISOString() };
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/lock', { bodyLimit: 8 * 1024 }, async (req, reply) => {
    const id = req.params.id;
    if (!isValidId(id)) return reply.code(400).send({ error: 'invalid project id' });
    const body = (req.body ?? {}) as { holder?: unknown; clientId?: unknown; token?: unknown; force?: unknown };
    const holder = cleanDisplayName(body.holder);
    const clientId = typeof body.clientId === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(body.clientId) ? body.clientId : null;
    if (!clientId) return reply.code(400).send({ error: 'clientId (8–80 url-safe chars) is required' });
    const token = typeof body.token === 'string' ? body.token : undefined;
    const cur = locks.active(id);
    if (!cur) {
      const rec = locks.grant(id, holder, clientId);
      return { lock: publicLock(rec), token: rec.token };
    }
    if ((token && token === cur.token) || cur.clientId === clientId) {
      const rec = locks.refresh(cur, holder);
      return { lock: publicLock(rec), token: rec.token };
    }
    if (body.force === true) {
      const head = await ctx.store.get(id);
      if (head) await recordVersion(ctx, head, { kind: 'pre-force-release', savedBy: holder, note: `before force release by ${holder} (lock held by ${cur.holder})` });
      const previousHolder = cur.holder;
      const rec = locks.grant(id, holder, clientId);
      app.log.info({ projectId: id, previousHolder, holder }, 'project lock force-released');
      return { lock: publicLock(rec), token: rec.token, forced: true, previousHolder };
    }
    return reply.code(423).send({ error: `project is being edited by ${cur.holder}`, lock: publicLock(cur) });
  });

  const release = (id: string, token: string | undefined) => {
    const cur = locks.active(id);
    if (!cur) return { status: 204 as const };
    if (token && token === cur.token) {
      locks.release(id);
      return { status: 204 as const };
    }
    return { status: 409 as const, lock: publicLock(cur) };
  };

  app.delete<{ Params: { id: string }; Querystring: { token?: string } }>('/api/projects/:id/lock', async (req, reply) => {
    if (!isValidId(req.params.id)) return reply.code(400).send({ error: 'invalid project id' });
    const token = req.query.token ?? headerString(req.headers['x-aidc-lock']) ?? ((req.body as { token?: string } | undefined)?.token);
    const r = release(req.params.id, token);
    return r.status === 204 ? reply.code(204).send() : reply.code(409).send({ error: 'lock is held by someone else', lock: r.lock });
  });

  app.post<{ Params: { id: string }; Querystring: { token?: string } }>('/api/projects/:id/lock/release', { bodyLimit: 4 * 1024 }, async (req, reply) => {
    let body = req.body as { token?: string; secret?: string } | string | undefined;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body) as { token?: string; secret?: string };
      } catch {
        body = undefined;
      }
    }
    const obj = typeof body === 'object' && body ? body : undefined;
    if (!sharedSecretOk(headerString(req.headers['x-aidc-secret']) ?? (typeof obj?.secret === 'string' ? obj.secret : undefined), secret)) {
      return reply.code(401).send({ error: 'shared secret required (x-aidc-secret header or beacon body)', sharedSecret: true });
    }
    if (!isValidId(req.params.id)) return reply.code(400).send({ error: 'invalid project id' });
    const token = req.query.token ?? obj?.token;
    const r = release(req.params.id, token);
    return r.status === 204 ? reply.code(204).send() : reply.code(409).send({ error: 'lock is held by someone else', lock: r.lock });
  });
}
