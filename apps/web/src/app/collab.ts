// Client side of minimal collaboration (stream T8, DECISIONS-v2 #12, DECISIONS-v2-2 §C, r2-platform.md §4):
// advisory edit lock (acquire on first edit, heartbeat 40 s, poll 15 s, release on pagehide), read-only mode while
// someone else holds the lock, save conflicts (412 / 423 → conflict-copy version + reload head), version API,
// assistant API, deep links (#/p/<id>/<page>?hall=… and ?project=&page=&hall=).
import { create } from 'zustand';
import type { Project, ProjectLock, ProjectVersion, VersionDiff } from '@aidc/core';
import { storeHooks, useApp, type PageId } from '../store/appStore.ts';
import { t } from '../i18n/index.ts';
import { api } from './api.ts';
import { commonHeaders, recordRev, session, setDisplayName as persistDisplayName, setLockToken } from './session.ts';

/** Heartbeat interval while holding the lock (DECISIONS-v2-2 §C: 40 s). */
export const LOCK_HEARTBEAT_MS = 40_000;
/** Poll interval for the lock state while not holding it (r2-platform.md §4.4: 15 s, estimate). */
export const LOCK_POLL_MS = 15_000;
/** Autosave coalescing window shown in the versions drawer (server: AUTOSAVE_COALESCE_MS). */
export const AUTOSAVE_COALESCE_MIN = 10;

export const PAGE_IDS: PageId[] = ['overview', 'workload', 'architecture', 'site', 'layout', 'power', 'network', 'cooling', 'cost', 'schedule', 'drawings', 'docs', 'catalog'];
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

// ─────────── HTTP helpers (status-aware, never throw on 4xx) ───────────

export interface HttpResult<T> {
  status: number;
  body: T;
}

async function http<T>(path: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<HttpResult<T>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(path, {
      ...init,
      signal: init.signal ?? ctrl.signal,
      headers: { ...commonHeaders(), ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    return { status: res.status, body: body as T };
  } finally {
    clearTimeout(timer);
  }
}

const enc = encodeURIComponent;

export interface StoredVersion extends ProjectVersion {
  kind: 'autosave' | 'manual' | 'pre-restore' | 'pre-force-release' | 'conflict-copy';
  sha256: string;
  bytes: number;
}

export interface DiffResponse {
  from: string;
  to: string;
  diff: VersionDiff;
  kpisFrom: Record<string, number>;
  kpisTo: Record<string, number>;
  byCategory: { category: string; added: number; removed: number; moved: number; changed: number }[];
  changedFields: Record<string, string[]>;
}

export interface LlmStatus {
  configured: boolean;
  available: boolean;
  baseUrl: string | null;
  host: string;
  locality: 'loopback' | 'lan' | 'remote' | 'invalid';
  model: string | null;
  models: { id: string; maxModelLen?: number }[];
  maxModelLen: number | null;
  hasApiKey: boolean;
  source: { baseUrl: string; model: string; apiKey: string };
  error?: string;
}

export interface LlmSettingsView {
  baseUrl: string | null;
  model: string | null;
  hasApiKey: boolean;
  source: { baseUrl: string; model: string; apiKey: string };
  locality: LlmStatus['locality'];
}

export const collabApi = {
  getLock: (id: string) => http<{ lock: ProjectLock | null; ttlSec: number; heartbeatSec: number }>(`/api/projects/${enc(id)}/lock`, {}, 5000),
  acquireLock: (id: string, body: { holder: string; clientId: string; token?: string; force?: boolean }) =>
    http<{ lock: ProjectLock; token?: string; forced?: boolean; previousHolder?: string; error?: string }>(`/api/projects/${enc(id)}/lock`, { method: 'POST', body: JSON.stringify(body) }, 8000),
  releaseLock: (id: string, token: string) => http<unknown>(`/api/projects/${enc(id)}/lock?token=${enc(token)}`, { method: 'DELETE' }, 5000),
  listVersions: (id: string) => http<StoredVersion[]>(`/api/projects/${enc(id)}/versions`),
  saveVersion: (id: string, body: { note?: string; savedBy?: string; kind?: 'manual' | 'conflict-copy'; project?: Project }) =>
    http<StoredVersion>(`/api/projects/${enc(id)}/versions`, { method: 'POST', body: JSON.stringify(body) }, 30_000),
  getVersion: (id: string, vid: string) => http<Project>(`/api/projects/${enc(id)}/versions/${enc(vid)}`),
  restoreVersion: (id: string, vid: string) =>
    http<{ project: Project; preRestore: StoredVersion | null; error?: string; lock?: ProjectLock }>(`/api/projects/${enc(id)}/versions/${enc(vid)}/restore`, {
      method: 'POST',
      body: JSON.stringify({ savedBy: session.displayName ?? undefined }),
      headers: session.lockTokens[id] ? { 'x-aidc-lock': session.lockTokens[id] } : {},
    }, 30_000),
  diff: (id: string, from: string, to: string) => http<DiffResponse & { error?: string }>(`/api/projects/${enc(id)}/diff?from=${enc(from)}&to=${enc(to)}`, {}, 60_000),
  llmStatus: () => http<LlmStatus>('/api/llm/status', {}, 6000),
  llmSettings: () => http<LlmSettingsView>('/api/llm/settings', {}, 5000),
  saveLlmSettings: (patch: { baseUrl?: string | null; model?: string | null; apiKey?: string | null }) =>
    http<LlmSettingsView & { error?: string }>('/api/llm/settings', { method: 'PUT', body: JSON.stringify(patch) }, 5000),
};

// ─────────── lock + session store ───────────

interface CollabState {
  displayName: string | null;
  namePromptOpen: boolean;
  lock: ProjectLock | null;
  /** this browser holds `lock` */
  mine: boolean;
  versionsOpen: boolean;
  setDisplayName(name: string | null): void;
  setNamePromptOpen(v: boolean): void;
  setVersionsOpen(v: boolean): void;
  refreshLock(): Promise<void>;
  acquire(force?: boolean): Promise<boolean>;
  release(): Promise<void>;
}

let acquiring: Promise<boolean> | null = null;

function publish(lock: ProjectLock | null, mine: boolean) {
  useCollab.setState({ lock, mine });
  useApp.getState().setProjectLock(lock);
}

export const useCollab = create<CollabState>((set, get) => ({
  displayName: session.displayName,
  namePromptOpen: false,
  lock: null,
  mine: false,
  versionsOpen: false,
  setDisplayName(name) {
    persistDisplayName(name);
    set({ displayName: session.displayName, namePromptOpen: false });
    if (get().mine) void get().acquire();
  },
  setNamePromptOpen(v) {
    set({ namePromptOpen: v });
  },
  setVersionsOpen(v) {
    set({ versionsOpen: v });
  },
  async refreshLock() {
    const app = useApp.getState();
    if (!app.serverOnline) return publish(null, false);
    const id = app.project.id;
    try {
      const r = await collabApi.getLock(id);
      if (useApp.getState().project.id !== id || r.status !== 200) return;
      const lock = r.body.lock;
      const mine = !!lock && get().mine && !!session.lockTokens[id];
      if (!lock && session.lockTokens[id]) setLockToken(id, null);
      publish(lock, mine);
    } catch {
      /* keep the previous state */
    }
  },
  async acquire(force = false) {
    if (acquiring && !force) return acquiring;
    const app = useApp.getState();
    if (!app.serverOnline) return true;
    const id = app.project.id;
    acquiring = (async () => {
      try {
        const r = await collabApi.acquireLock(id, { holder: session.displayName ?? t('shell.collab.guest'), clientId: session.clientId, token: session.lockTokens[id], force });
        if (useApp.getState().project.id !== id) return false;
        if (r.status === 200 && r.body.token) {
          setLockToken(id, r.body.token);
          publish(r.body.lock, true);
          return true;
        }
        if (r.status === 423) {
          const wasMine = get().mine;
          setLockToken(id, null);
          publish(r.body.lock, false);
          if (wasMine) await onLockLost(r.body.lock);
          return false;
        }
        return false;
      } catch {
        return false;
      } finally {
        acquiring = null;
      }
    })();
    return acquiring;
  },
  async release() {
    const app = useApp.getState();
    const id = app.project.id;
    const token = session.lockTokens[id];
    if (!token) return;
    if (app.dirty) await app.save();
    await collabApi.releaseLock(id, token).catch(() => undefined);
    setLockToken(id, null);
    publish(null, false);
  },
}));

async function saveConflictCopy(p: Project): Promise<boolean> {
  const r = await collabApi.saveVersion(p.id, { kind: 'conflict-copy', project: p, savedBy: session.displayName ?? undefined }).catch((e: Error) => ({ status: 0, body: { error: e.message } as unknown as StoredVersion }));
  if (r.status !== 201) {
    useApp.getState().notify(t('shell.collab.conflictFailed', { message: String((r.body as unknown as { error?: string })?.error ?? r.status) }), 'error');
    return false;
  }
  return true;
}

async function reloadHead(id: string) {
  try {
    const head = await api.getProject(id);
    if (useApp.getState().project.id === id) useApp.getState().replaceProject(head);
  } catch {
    /* stay on the local copy */
  }
}

async function onLockLost(lock: ProjectLock | null) {
  const app = useApp.getState();
  if (app.dirty) await saveConflictCopy(app.project);
  await reloadHead(app.project.id);
  useApp.getState().notify(t('shell.collab.lockLost', { name: lock?.holder ?? '?' }), 'error');
}

let conflictBusy = false;
async function handleSaveConflict(status: '412' | '423', p: Project) {
  if (conflictBusy) return;
  conflictBusy = true;
  try {
    const copied = await saveConflictCopy(p);
    await reloadHead(p.id);
    if (status === '423') {
      setLockToken(p.id, null);
      await useCollab.getState().refreshLock();
      useApp.getState().notify(t('shell.collab.lockLost', { name: useCollab.getState().lock?.holder ?? '?' }), 'error');
    } else if (copied) {
      useApp.getState().notify(t('shell.collab.conflict'), 'error');
    }
    void useCollab.getState().refreshLock();
  } finally {
    conflictBusy = false;
  }
}

// ─────────── deep links ───────────

export interface DeepLink {
  projectId?: string;
  page?: PageId;
  hall?: string;
}

export function parseDeepLink(loc: { hash: string; search: string } = window.location): DeepLink {
  const out: DeepLink = {};
  const m = /^#\/p\/([^/?#]+)(?:\/([a-z]+))?(?:\?(.*))?$/.exec(loc.hash);
  const q = new URLSearchParams(m ? m[3] ?? '' : '');
  const qs = new URLSearchParams(loc.search);
  const id = m ? decodeURIComponent(m[1]) : qs.get('project') ?? undefined;
  const page = (m ? m[2] : undefined) ?? qs.get('page') ?? undefined;
  const hall = q.get('hall') ?? qs.get('hall') ?? undefined;
  if (id && ID_RE.test(id) && !id.includes('..')) out.projectId = id;
  if (page && PAGE_IDS.includes(page as PageId)) out.page = page as PageId;
  if (hall && ID_RE.test(hall)) out.hall = hall;
  return out;
}

/** Shareable hash-route link (works with the Fastify SPA fallback and a static build). */
export function deepLinkUrl(projectId: string, page: PageId, hallId?: string): string {
  const base = `${window.location.origin}${window.location.pathname}`;
  return `${base}#/p/${enc(projectId)}/${page}${hallId ? `?hall=${enc(hallId)}` : ''}`;
}

const initialLink: DeepLink = typeof window !== 'undefined' ? parseDeepLink() : {};
// the store's init() opens aidc:lastProjectId when the server has it — point it at the linked project before init runs
if (initialLink.projectId) {
  try {
    localStorage.setItem('aidc:lastProjectId', initialLink.projectId);
  } catch {
    /* storage blocked */
  }
}

function applyDeepLinkAfterInit() {
  if (!initialLink.projectId && !initialLink.page) return;
  const started = Date.now();
  let opened = false;
  const tick = () => {
    const s = useApp.getState();
    const want = initialLink.projectId;
    if (want && s.project.id !== want && s.serverOnline && !opened && s.projects.some((p) => p.id === want)) {
      opened = true;
      void s.openProject(want);
    }
    if (!want || s.project.id === want) {
      if (initialLink.page && s.page !== initialLink.page) s.setPage(initialLink.page);
      if (initialLink.hall && s.project.halls.some((h) => h.id === initialLink.hall)) s.setHall(initialLink.hall);
      return;
    }
    if (Date.now() - started < 10_000) setTimeout(tick, 250);
    else if (initialLink.page) s.setPage(initialLink.page);
  };
  setTimeout(tick, 300);
}

// ─────────── lifecycle ───────────

let started = false;
/** Wire store hooks, timers and listeners once (called from the topbar component). */
export function startCollab(): void {
  if (started) return;
  started = true;

  session.requestSecret = () => window.prompt(t('shell.collab.secretPrompt'))?.trim() || null;

  storeHooks.beforeEdit = () => {
    const app = useApp.getState();
    if (!app.serverOnline) return true;
    const c = useCollab.getState();
    if (c.lock && !c.mine) {
      app.notify(t('shell.collab.readOnlyBlocked', { name: c.lock.holder }), 'error');
      return false;
    }
    if (!c.mine) void c.acquire();
    return true;
  };

  storeHooks.onSaveError = (e, p) => {
    // backlog T3 (5): the server refuses to overwrite an existing project without the base revision (If-Match) — say so, stay online
    if (/^428\b/.test(e.message)) {
      useApp.getState().notify(t('project.toast.revisionRequired', { name: p.name }), 'error');
      return true;
    }
    const m = /^(412|423)\b/.exec(e.message);
    if (!m) return false;
    void handleSaveConflict(m[1] as '412' | '423', p);
    return true;
  };

  let lastProject = useApp.getState().project.id;
  let lastOnline = useApp.getState().serverOnline;
  useApp.subscribe((s) => {
    if (s.project.id !== lastProject) {
      const prev = lastProject;
      lastProject = s.project.id;
      recordRev(s.project);
      const token = session.lockTokens[prev];
      if (token && s.serverOnline) void collabApi.releaseLock(prev, token).catch(() => undefined);
      setLockToken(prev, null);
      publish(null, false);
      void useCollab.getState().refreshLock();
    }
    if (s.serverOnline !== lastOnline) {
      lastOnline = s.serverOnline;
      if (s.serverOnline) {
        void useCollab.getState().refreshLock();
        if (!session.displayName) useCollab.getState().setNamePromptOpen(true);
      } else publish(null, false);
    }
  });

  setInterval(() => {
    const c = useCollab.getState();
    if (useApp.getState().serverOnline && !c.mine && document.visibilityState !== 'hidden') void c.refreshLock();
  }, LOCK_POLL_MS);
  setInterval(() => {
    const c = useCollab.getState();
    if (c.mine && useApp.getState().serverOnline) void c.acquire();
  }, LOCK_HEARTBEAT_MS);

  window.addEventListener('pagehide', () => {
    const s = useApp.getState();
    const token = session.lockTokens[s.project.id];
    if (!token || !s.serverOnline) return;
    // polish v2 2차 (QA collab #10): token and shared secret travel in the text/plain JSON body, never in the URL (server logs record URLs)
    const url = `/api/projects/${enc(s.project.id)}/lock/release`;
    navigator.sendBeacon?.(url, new Blob([JSON.stringify({ token, ...(session.secret ? { secret: session.secret } : {}) })], { type: 'text/plain' }));
    setLockToken(s.project.id, null);
  });

  if (useApp.getState().serverOnline) {
    void useCollab.getState().refreshLock();
    if (!session.displayName) useCollab.getState().setNamePromptOpen(true);
  }
  applyDeepLinkAfterInit();
}
