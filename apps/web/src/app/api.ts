import type { CableType, CatalogItem, CatalogLibrary, Project, ProjectAnalysis } from '@aidc/core';
import { commonHeaders, recordRev, saveHeaders, session, setSharedSecret } from './session.ts';

export interface ProjectListItem {
  id: string;
  name: string;
  updatedAt: string;
  gpus?: number;
  // v2-2 project management (GET /api/projects): summary + history of each project
  halls?: number;
  racks?: number;
  versions?: number;
  savedBy?: string;
  savedAt?: string;
}

/** v2-2: a recoverable delete (GET /api/projects/trash) */
export interface TrashEntry {
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

export type ExportFormat = 'usd' | 'godot' | 'unreal' | 'json' | 'docs' | 'drawings' | 'deploy' | 'all';

async function request<T>(path: string, init: RequestInit = {}, timeoutMs = 15000, retried = false): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const sentSecret = session.secret;
    const res = await fetch(path, {
      ...init,
      signal: ctrl.signal,
      // T8: shared secret + display name on every call (session.ts)
      headers: { ...commonHeaders(), ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
    });
    // v2-2 QA: parallel start-up requests all get 401 — once one of them has obtained the secret, the others retry without asking again
    if (res.status === 401 && !retried && session.secret && session.secret !== sentSecret) {
      clearTimeout(timer);
      return request<T>(path, init, timeoutMs, true);
    }
    // T8: AIDC_SHARED_SECRET — ask once, then retry
    if (res.status === 401 && !retried && session.requestSecret) {
      const secret = session.requestSecret();
      if (secret) {
        setSharedSecret(secret);
        clearTimeout(timer);
        return request<T>(path, init, timeoutMs, true);
      }
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = undefined;
      }
      // v2-2: status + parsed body ride along (project management reads `code` / `suggestion` / `lock`)
      throw Object.assign(new Error(`${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 200)}` : ''}`), { status: res.status, body });
    }
    const ct = res.headers.get('content-type') ?? '';
    return (ct.includes('application/json') ? await res.json() : await res.blob()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  async health(): Promise<boolean> {
    try {
      await request('/api/health', {}, 2500);
      return true;
    } catch {
      return false;
    }
  },
  /** v2-2: server capabilities (GET /api/health `features`; 'project-trash' = recoverable deletes + name rules) */
  async features(): Promise<string[]> {
    try {
      const h = await request<{ features?: unknown }>('/api/health', {}, 2500);
      return Array.isArray(h.features) ? h.features.filter((f): f is string => typeof f === 'string') : [];
    } catch {
      return [];
    }
  },
  listProjects: () => request<ProjectListItem[]>('/api/projects'),
  // T8: remember the server revision of every project read/written (If-Match on the next save); saves carry the lock token
  getProject: (id: string) => request<Project>(`/api/projects/${encodeURIComponent(id)}`).then((p) => (recordRev(p), p)),
  createProject: (body: { template: 'reference' | 'empty' | 'nvidia-reference'; preset?: string; pods?: number; name?: string; dryRun?: boolean } | Project) =>
    request<Project>('/api/projects', { method: 'POST', body: JSON.stringify(body) }).then((p) => (recordRev(p), p)),
  saveProject: (p: Project) =>
    request<Project>(`/api/projects/${encodeURIComponent(p.id)}`, { method: 'PUT', body: JSON.stringify(p), headers: saveHeaders(p.id) }).then((saved) => (recordRev(saved), saved)),
  // v2-2: recoverable delete (moves to the server trash); the lock token goes along when this tab holds the edit lock
  deleteProject: (id: string) =>
    request<unknown>(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE', headers: session.lockTokens[id] ? { 'x-aidc-lock': session.lockTokens[id] } : {} }),
  listTrash: () => request<TrashEntry[]>('/api/projects/trash'),
  // backlog T3 (8): permanent removal — every entry, or entries deleted more than `olderThanDays` days ago (the UI confirms first)
  purgeTrash: (olderThanDays?: number) =>
    request<{ removed: number; entries: string[] }>(`/api/projects/trash${olderThanDays !== undefined ? `?olderThanDays=${encodeURIComponent(String(olderThanDays))}` : ''}`, { method: 'DELETE' }, 30000),
  restoreTrash: (entry: string) =>
    request<{ project: Project; originalId: string; renamedId: boolean; renamedName: boolean }>(`/api/projects/trash/${encodeURIComponent(entry)}/restore`, { method: 'POST' }, 30000)
      .then((r) => (recordRev(r.project), r)),
  // S3: catalog (builtin ∪ library merged) and the server-global library (data/catalog/custom.json)
  getCatalog: () => request<{ items: CatalogItem[]; cables: CableType[] }>('/api/catalog'),
  getCatalogLibrary: () => request<CatalogLibrary & { file?: string }>('/api/catalog/custom', {}, 8000),
  // polish v2 2차: the current project and its lock token go along — the server refuses (423) while another holder has that project's lock
  putCatalogLibrary: async (lib: CatalogLibrary, projectId?: string) => {
    const put = (token: string | undefined) =>
      request<CatalogLibrary & { file?: string }>('/api/catalog/custom', {
        method: 'PUT',
        body: JSON.stringify(lib),
        headers: projectId ? { 'x-aidc-project': projectId, ...(token ? { 'x-aidc-lock': token } : {}) } : {},
      });
    const sent = projectId ? session.lockTokens[projectId] : undefined;
    try {
      return await put(sent);
    } catch (e) {
      // QA backlog (catalog lens): this tab's first edit acquires the project lock asynchronously, so "Register → Server library" could
      // leave before the token arrived and be refused (423) by its own lock. Wait briefly for this tab's token and retry once; a lock
      // held by another client still fails (the server checks the token).
      if ((e as { status?: number }).status !== 423 || !projectId) throw e;
      for (let i = 0; i < 15 && session.lockTokens[projectId] === sent; i++) await new Promise((r) => setTimeout(r, 100));
      const token = session.lockTokens[projectId];
      if (!token || token === sent) throw e;
      return put(token);
    }
  },
  exportBundle: (format: ExportFormat, project: Project, analysis: ProjectAnalysis | null) =>
    request<Blob>(`/api/export/${format}`, { method: 'POST', body: JSON.stringify({ project, analysis }) }, 120000),
};

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function downloadText(text: string, filename: string, type = 'text/plain') {
  downloadBlob(new Blob([text], { type }), filename);
}
