// v2-2 project management — pure helpers of the web project menu (apps/web/src/app/projectMenu.ts) and the shared name rules
// (packages/core/src/collab/projects.ts). Lives here because the root vitest config collects apps/server/test (not apps/web).
import { describe, expect, it } from 'vitest';
import { copyProjectName, PROJECT_NAME_MAX, projectIdFor, projectNameError, projectSlug, uniqueProjectName } from '../../../packages/core/src/index.ts';
import {
  apiErrorInfo, buildProjectOptions, deleteBlockReason, deleteConfirmMatches, PROJECT_ACTION, pickFallbackProject, projectMenuAction,
} from '../../web/src/app/projectMenu.ts';

const labels = { new: '<New…>', delete: '[Delete]', trash: (n: number) => `Recently deleted… (${n})`, tooltip: (p: { name: string }) => `tip:${p.name}` };
const P = (id: string, name: string, updatedAt = '2026-09-01T00:00:00.000Z', extra: Record<string, unknown> = {}) => ({ id, name, updatedAt, ...extra });

describe('name rules (core)', () => {
  it('trimmed, non-empty, ≤ 120 chars, unique case-insensitively (self excluded)', () => {
    const others = [P('a', 'Reference AI Factory — GB300 NVL72'), P('b', 'Seoul Campus')];
    expect(projectNameError('  ', others)).toBe('empty');
    expect(projectNameError('x'.repeat(PROJECT_NAME_MAX + 1), others)).toBe('too-long');
    expect(projectNameError('x'.repeat(PROJECT_NAME_MAX), others)).toBeNull();
    expect(projectNameError(' seoul  CAMPUS ', others)).toBe('taken');
    expect(projectNameError('Seoul Campus', others, 'b')).toBeNull();
    expect(projectNameError('서울 캠퍼스', [P('k', '서울 캠퍼스')])).toBe('taken');
  });

  it('slug + random suffix ids; non-ASCII names fall back to "project"', () => {
    expect(projectSlug('Reference AI Factory — GB300 NVL72 (HAC-style)')).toBe('reference-ai-factory-gb300-nvl72-hac-sty');
    expect(projectIdFor('Café Hall #2', () => 'abc123')).toBe('cafe-hall-2-abc123');
    expect(projectIdFor('서울 캠퍼스', () => 'zz0000')).toBe('project-zz0000');
    expect(projectIdFor('x')).toMatch(/^x-[a-z0-9]{6}$/);
  });

  it('unique / copy names keep the suffix within the length limit', () => {
    expect(uniqueProjectName('Hall', ['hall', 'HALL (2)'])).toBe('Hall (3)');
    expect(copyProjectName('Hall', ['Hall (copy)'])).toBe('Hall (copy) (2)');
    expect(copyProjectName('홀', [], '사본')).toBe('홀 (사본)');
    const long = uniqueProjectName('y'.repeat(200), ['y'.repeat(PROJECT_NAME_MAX)]);
    expect([...long].length).toBe(PROJECT_NAME_MAX);
    expect(long.endsWith(' (2)')).toBe(true);
  });
});

describe('project dropdown options', () => {
  it('projects by full name (alphabetical), then separator · <New…> · [Delete] · Recently deleted… at the bottom', () => {
    const opts = buildProjectOptions({
      projects: [P('p2', 'Zeta Hall 10'), P('p1', 'alpha'), P('p3', 'Zeta Hall 9')],
      current: { id: 'p1', name: 'Alpha (renamed)' },
      trashCount: 2,
      canManage: true,
      labels,
    });
    expect(opts.map((o) => o.label)).toEqual(['Alpha (renamed)', 'Zeta Hall 9', 'Zeta Hall 10', '──────────', '<New…>', '[Delete]', 'Recently deleted… (2)']);
    expect(opts[0]).toMatchObject({ value: 'p1', kind: 'project', title: 'tip:Alpha (renamed)' });
    expect(opts[3]).toMatchObject({ kind: 'separator', disabled: true });
    expect(opts.slice(4).map((o) => projectMenuAction(o.value))).toEqual(['new', 'delete', 'trash']);
    expect(projectMenuAction('p1')).toBeNull();
    expect(projectMenuAction(PROJECT_ACTION.separator)).toBeNull();
  });

  it('the open project is listed even before the list has it; no trash entry when empty; no actions without a managing server', () => {
    const base = { projects: [P('p1', 'One')], current: { id: 'new-1', name: 'Brand New' }, labels };
    expect(buildProjectOptions({ ...base, trashCount: 0, canManage: true }).map((o) => o.kind)).toEqual(['project', 'project', 'separator', 'new', 'delete']);
    expect(buildProjectOptions({ ...base, trashCount: 3, canManage: false }).map((o) => o.value)).toEqual(['new-1', 'p1']);
  });
});

describe('delete helpers', () => {
  it('fallback = most recently saved remaining project', () => {
    const list = [P('a', 'A', '2026-09-01T00:00:00.000Z'), P('b', 'B', '2026-09-03T00:00:00.000Z'), P('c', 'C', '2026-09-02T00:00:00.000Z', { savedAt: '2026-09-04T00:00:00.000Z' })];
    expect(pickFallbackProject(list, 'x')).toBe('c');
    expect(pickFallbackProject(list, 'c')).toBe('b');
    expect(pickFallbackProject([P('a', 'A')], 'a')).toBeUndefined();
  });

  it('confirmation: the full name, ignoring letter case and extra spaces', () => {
    expect(deleteConfirmMatches('reference ai factory — gb300 nvl72', 'Reference AI Factory — GB300 NVL72')).toBe(true);
    expect(deleteConfirmMatches('  Seoul   Campus ', 'Seoul Campus')).toBe(true);
    expect(deleteConfirmMatches('Seoul', 'Seoul Campus')).toBe(false);
    expect(deleteConfirmMatches('', '')).toBe(false);
  });

  it('disabled reasons in priority order', () => {
    expect(deleteBlockReason({ online: false, admin: false, readOnly: true, projectCount: 1 })).toBe('offline');
    expect(deleteBlockReason({ online: true, admin: false, readOnly: true, projectCount: 1 })).toBe('unsupported');
    expect(deleteBlockReason({ online: true, admin: true, readOnly: true, projectCount: 1 })).toBe('locked');
    expect(deleteBlockReason({ online: true, admin: true, readOnly: false, projectCount: 1 })).toBe('last');
    expect(deleteBlockReason({ online: true, admin: true, readOnly: false, projectCount: 2 })).toBeNull();
  });

  it('apiErrorInfo reads status, code, suggestion and lock holder from api.ts errors', () => {
    const e = Object.assign(new Error('409 Conflict — {"code":"name-taken","error":"exists","suggestion":"A (2)"}'), { status: 409 });
    expect(apiErrorInfo(e)).toMatchObject({ status: 409, code: 'name-taken', suggestion: 'A (2)', message: 'exists' });
    const locked = Object.assign(new Error('409 Conflict — …'), { body: { code: 'locked', error: 'busy', lock: { holder: 'Alice' } } });
    expect(apiErrorInfo(locked)).toMatchObject({ status: 409, code: 'locked', holder: 'Alice' });
    expect(apiErrorInfo(new Error('Failed to fetch'))).toMatchObject({ status: undefined, message: 'Failed to fetch' });
  });
});
