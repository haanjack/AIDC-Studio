// Project menu helpers (v2-2 project management): top-bar dropdown options, fallback project after a delete, delete
// confirmation rule, disabled reasons. Pure — tested from apps/server/test/projects-management-web.test.ts.
import { cleanProjectName, projectNameError, projectNameKey, type ProjectNameError } from '@aidc/core';
import type { ProjectListItem } from './api.ts';

export { projectNameError, type ProjectNameError };

/** option values of the non-project entries (never valid project ids: ids start with a letter or digit) */
export const PROJECT_ACTION = { new: '__aidc:new', delete: '__aidc:delete', trash: '__aidc:trash', separator: '__aidc:sep' } as const;
export type ProjectMenuAction = 'new' | 'delete' | 'trash';

export interface ProjectOption {
  value: string;
  label: string;
  title?: string;
  disabled?: boolean;
  kind: 'project' | 'separator' | ProjectMenuAction;
}

export interface ProjectMenuLabels {
  new: string;
  delete: string;
  /** "Recently deleted… (n)" */
  trash: (n: number) => string;
  /** tooltip of one project entry */
  tooltip: (p: ProjectListItem) => string;
  deleteTitle?: string;
  newTitle?: string;
}

/**
 * Dropdown options: every project by full name (alphabetical, numeric-aware — the list does not jump around on autosave),
 * the open project even when the list does not have it yet, then — only when the server manages projects — a separator,
 * '<New…>', '[Delete]' and 'Recently deleted…' (when the trash is not empty).
 */
export function buildProjectOptions(args: {
  projects: readonly ProjectListItem[];
  current: { id: string; name: string };
  trashCount: number;
  canManage: boolean;
  labels: ProjectMenuLabels;
}): ProjectOption[] {
  const { projects, current, trashCount, canManage, labels } = args;
  const items = projects.some((p) => p.id === current.id) ? [...projects] : [...projects, { id: current.id, name: current.name, updatedAt: '' }];
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  // the open project shows its in-memory name (a rename is visible before the list refreshes)
  const named = items.map((p) => (p.id === current.id ? { ...p, name: current.name } : p));
  named.sort((a, b) => collator.compare(a.name, b.name) || a.id.localeCompare(b.id));
  const out: ProjectOption[] = named.map((p) => ({ value: p.id, label: p.name, title: labels.tooltip(p), kind: 'project' }));
  if (!canManage) return out;
  out.push({ value: PROJECT_ACTION.separator, label: '──────────', disabled: true, kind: 'separator' });
  out.push({ value: PROJECT_ACTION.new, label: labels.new, title: labels.newTitle, kind: 'new' });
  out.push({ value: PROJECT_ACTION.delete, label: labels.delete, title: labels.deleteTitle, kind: 'delete' });
  if (trashCount > 0) out.push({ value: PROJECT_ACTION.trash, label: labels.trash(trashCount), kind: 'trash' });
  return out;
}

/** 'new' | 'delete' | 'trash' for an action option value, null for a project id (or the separator) */
export function projectMenuAction(value: string): ProjectMenuAction | null {
  if (value === PROJECT_ACTION.new) return 'new';
  if (value === PROJECT_ACTION.delete) return 'delete';
  if (value === PROJECT_ACTION.trash) return 'trash';
  return null;
}

/** The project to open after `excludeId` is gone: the most recently saved remaining one. */
export function pickFallbackProject(projects: readonly ProjectListItem[], excludeId: string): string | undefined {
  const when = (p: ProjectListItem) => p.savedAt ?? p.updatedAt ?? '';
  return [...projects].filter((p) => p.id !== excludeId).sort((a, b) => when(b).localeCompare(when(a)))[0]?.id;
}

/**
 * Delete confirmation rule (one rule for every name length): the typed text must equal the project name, ignoring
 * surrounding / repeated spaces and letter case. Pasting the name works for very long names.
 */
export function deleteConfirmMatches(typed: string, projectName: string): boolean {
  const t = cleanProjectName(typed);
  return !!t && projectNameKey(t) === projectNameKey(projectName);
}

export type DeleteBlockReason = 'offline' | 'unsupported' | 'locked' | 'last';

/** Why [Delete] is disabled for the open project (null = allowed). */
export function deleteBlockReason(s: { online: boolean; admin: boolean; readOnly: boolean; projectCount: number }): DeleteBlockReason | null {
  if (!s.online) return 'offline';
  if (!s.admin) return 'unsupported';
  if (s.readOnly) return 'locked';
  if (s.projectCount <= 1) return 'last';
  return null;
}

/** Parse `{ code, suggestion, lock }` out of an api.ts error ("409 Conflict — {json}"). */
export function apiErrorInfo(e: unknown): { status?: number; code?: string; suggestion?: string; holder?: string; message: string } {
  const message = e instanceof Error ? e.message : String(e);
  const status = Number(/^(\d{3})\b/.exec(message)?.[1]) || undefined;
  const body = (e as { body?: unknown })?.body;
  let json: Record<string, unknown> | null = body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  if (!json) {
    const i = message.indexOf('{');
    if (i >= 0) {
      try {
        json = JSON.parse(message.slice(i)) as Record<string, unknown>;
      } catch {
        json = null;
      }
    }
  }
  const lock = json?.lock as { holder?: string } | undefined;
  return {
    status,
    code: typeof json?.code === 'string' ? json.code : undefined,
    suggestion: typeof json?.suggestion === 'string' ? json.suggestion : undefined,
    holder: typeof lock?.holder === 'string' ? lock.holder : undefined,
    message: typeof json?.error === 'string' ? json.error : message,
  };
}
