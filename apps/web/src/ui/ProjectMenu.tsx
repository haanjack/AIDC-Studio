// Project management UI (v2-2): top-bar project dropdown ('<New…>' · '[Delete]' · 'Recently deleted…' after a separator),
// the New project / Delete confirmation / Recently deleted / Save as new project dialogs, and the Site-panel project section.
// Store actions live in store/appStore.ts; pure helpers in app/projectMenu.ts; server routes in apps/server/src/projects.ts.
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { create } from 'zustand';
import { cleanProjectName, copyProjectName, DEFAULT_NEW_PROJECT_PRESET, PROJECT_NAME_MAX, STANDARDS_PRESET_IDS, STANDARDS_PRESETS, uniqueProjectName, type StandardsPresetId } from '@aidc/core';
import { useApp, type ProjectActionResult } from '../store/appStore.ts';
import { useI18n } from '../i18n/index.ts';
import { collabApi, useCollab, type StoredVersion } from '../app/collab.ts';
import type { ProjectListItem } from '../app/api.ts';
import { buildProjectOptions, deleteBlockReason, deleteConfirmMatches, projectMenuAction, projectNameError, type ProjectNameError } from '../app/projectMenu.ts';
import { Section, TextField } from './controls.tsx';
import { Icon } from './icons.tsx';
import { useReadOnly } from './Collab.tsx';

type ProjectDialog = { kind: 'new' } | { kind: 'delete' } | { kind: 'trash' } | { kind: 'saveAs' };

export const useProjectDialog = create<{ dialog: ProjectDialog | null; open: (d: ProjectDialog) => void; close: () => void }>((set) => ({
  dialog: null,
  open: (dialog) => set({ dialog }),
  close: () => set({ dialog: null }),
}));

/** project list refresh while the tab is visible (detects projects created / deleted by other clients) */
const PROJECT_POLL_MS = 30_000;

type T = ReturnType<typeof useI18n>['t'];

function nameErrorText(t: T, err: ProjectNameError): string {
  return err === 'taken' ? t('project.name.taken') : err === 'too-long' ? t('project.name.tooLong', { max: PROJECT_NAME_MAX }) : t('project.name.empty');
}

/** Focus trap for a modal: first focus inside, Tab / Shift+Tab cycle, Esc closes, focus returns to the opener. */
function useModal(ref: RefObject<HTMLElement | null>, onClose: () => void) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusables = () =>
      [...root.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((el) => !(el as HTMLButtonElement).disabled && el.getClientRects().length > 0);
    if (!root.contains(document.activeElement)) (root.querySelector<HTMLElement>('[data-autofocus]:not(:disabled)') ?? focusables()[0])?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const f = focusables();
      if (!f.length) return e.preventDefault();
      const first = f[0];
      const last = f[f.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !root.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !root.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      if (opener?.isConnected) opener.focus();
    };
  }, [ref]);
}

function useTooltip() {
  const { t, num, date } = useI18n();
  return (p: ProjectListItem) => {
    const when = p.savedAt ?? p.updatedAt;
    const params = { name: p.name, halls: t('project.unit.halls', { n: num(p.halls ?? 0) }), gpus: t('project.unit.gpus', { n: num(p.gpus ?? 0) }), when: when ? date(when) : '—', who: p.savedBy ?? '' };
    return t(p.savedBy ? 'project.tooltip' : 'project.tooltipNoAuthor', params);
  };
}

// ─────────── top bar ───────────

/** Top-bar project dropdown: every project by full name, then '<New…>', '[Delete]' and 'Recently deleted…'. */
export function ProjectTopbar() {
  const { t } = useI18n();
  const serverOnline = useApp((s) => s.serverOnline);
  const projects = useApp((s) => s.projects);
  const projectAdmin = useApp((s) => s.projectAdmin);
  const trashCount = useApp((s) => s.trash.length);
  const projectId = useApp((s) => s.project.id);
  const projectName = useApp((s) => s.project.name);
  const openDialog = useProjectDialog((s) => s.open);
  const tooltip = useTooltip();

  useEffect(() => {
    if (!serverOnline) return;
    const h = setInterval(() => {
      if (document.visibilityState !== 'hidden') void useApp.getState().refreshProjects();
    }, PROJECT_POLL_MS);
    return () => clearInterval(h);
  }, [serverOnline]);

  if (!serverOnline) {
    return <span className="project-name" data-project-offline title={`${projectName}\n${t('project.offlineTitle')}`}>{projectName}</span>;
  }
  const options = buildProjectOptions({
    projects,
    current: { id: projectId, name: projectName },
    trashCount,
    canManage: projectAdmin,
    labels: {
      new: t('project.option.new'),
      newTitle: t('project.option.newTitle'),
      delete: t('project.option.delete'),
      deleteTitle: t('project.option.deleteTitle'),
      trash: (n) => t('project.option.trash', { n }),
      tooltip,
    },
  });
  const current = projects.find((p) => p.id === projectId) ?? { id: projectId, name: projectName, updatedAt: '' };
  const title = projectAdmin ? tooltip({ ...current, name: projectName }) : `${tooltip({ ...current, name: projectName })}\n${t('project.unsupportedTitle')}`;
  return (
    <div className="topbar-project" title={title} data-project-select>
      <select
        aria-label={t('project.select.label')}
        value={projectId}
        onChange={(e) => {
          const v = e.target.value;
          // actions never change the selected project: put the select back before React re-renders
          e.currentTarget.value = projectId;
          const action = projectMenuAction(v);
          if (action) {
            if (action === 'trash') void useApp.getState().refreshTrash();
            openDialog({ kind: action });
            return;
          }
          if (v !== projectId && !v.startsWith('__aidc:')) void useApp.getState().openProject(v);
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled} title={o.title} data-project-option={o.kind}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

// ─────────── dialogs ───────────

export function ProjectDialogs() {
  const dialog = useProjectDialog((s) => s.dialog);
  const close = useProjectDialog((s) => s.close);
  if (!dialog) return null;
  return (
    <div className="modal-backdrop" data-project-backdrop onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      {dialog.kind === 'new' && <NewProjectDialog onClose={close} />}
      {dialog.kind === 'delete' && <DeleteProjectDialog onClose={close} />}
      {dialog.kind === 'trash' && <TrashDialog onClose={close} />}
      {dialog.kind === 'saveAs' && <SaveAsNewDialog onClose={close} />}
    </div>
  );
}

function Buttons({ onClose, label, disabled, danger, busy }: { onClose: () => void; label: string; disabled?: boolean; danger?: boolean; busy?: boolean }) {
  const { t } = useI18n();
  return (
    <div className="row" style={{ gap: 6 }}>
      <span className="grow" />
      <button type="button" className="btn sm" onClick={onClose} data-project-cancel>{t('project.cancel')}</button>
      <button type="submit" className={`btn sm ${danger ? 'danger' : 'primary'}`} disabled={disabled || busy} data-project-confirm>{busy ? t('project.busy') : label}</button>
    </div>
  );
}

function NameInput({ id, value, onChange, error, showEmpty, suggestion, onSuggestion }: {
  id: string; value: string; onChange: (v: string) => void; error: ProjectNameError | null; showEmpty: boolean; suggestion?: string; onSuggestion?: (v: string) => void;
}) {
  const { t } = useI18n();
  const shown = error && (error !== 'empty' || showEmpty) ? error : null;
  return (
    <div className="field">
      <label htmlFor={id}>{t('project.field.name')}</label>
      <input id={id} type="text" value={value} autoFocus data-autofocus data-project-name aria-invalid={shown ? true : undefined} aria-describedby={shown ? `${id}-err` : undefined}
        onChange={(e) => onChange(e.target.value)} onFocus={(e) => e.target.select()} />
      {shown && (
        <span id={`${id}-err`} className="hint project-name-error" role="alert" data-project-name-error={shown}>
          {nameErrorText(t, shown)}
          {shown === 'taken' && suggestion && onSuggestion && (
            <button type="button" className="btn ghost sm" onClick={() => onSuggestion(suggestion)}>{t('project.name.useSuggestion', { name: suggestion })}</button>
          )}
        </span>
      )}
    </div>
  );
}

function ServerError({ result }: { result: Extract<ProjectActionResult, { ok: false }> | null }) {
  const { t } = useI18n();
  if (!result || result.code?.startsWith('name-')) return null;
  return <p className="hint project-name-error" role="alert" style={{ margin: 0 }}>{t('project.toast.failed', { msg: result.message })}</p>;
}

type StartingPoint = 'reference' | 'empty' | 'nvidia-reference' | 'copy';

function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const ref = useRef<HTMLFormElement>(null);
  useModal(ref, onClose);
  const projects = useApp((s) => s.projects);
  const current = useApp((s) => s.project);
  const newProject = useApp((s) => s.newProject);
  const others = useMemo(() => (projects.some((p) => p.id === current.id) ? projects : [...projects, { id: current.id, name: current.name, updatedAt: '' }]), [projects, current.id, current.name]);
  const taken = useMemo(() => others.map((p) => p.name), [others]);
  const defaultFor = (s: StartingPoint) =>
    s === 'copy' ? copyProjectName(current.name, taken, t('project.saveAs.copyWord')) : uniqueProjectName(t(s === 'empty' ? 'project.new.defaultEmpty' : s === 'nvidia-reference' ? 'project.new.defaultNvidiaReference' : 'project.new.defaultReference'), taken);
  const [start, setStart] = useState<StartingPoint>('reference');
  // stream D (P4, DO-1): an empty site starts from a standards profile preset, the high-power 21-inch OU liquid preset preselected
  const [preset, setPreset] = useState<StandardsPresetId>(DEFAULT_NEW_PROJECT_PRESET);
  const [name, setName] = useState(() => defaultFor('reference'));
  const [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<Extract<ProjectActionResult, { ok: false }> | null>(null);
  const localErr = projectNameError(name, others);
  const err: ProjectNameError | null = localErr ?? (failed?.code === 'name-taken' ? 'taken' : null);
  const pick = (s: StartingPoint) => {
    setStart(s);
    if (!edited) setName(defaultFor(s));
  };
  const submit = async () => {
    if (err || busy) return;
    setBusy(true);
    setFailed(null);
    const r = await newProject({ name, template: start, ...(start === 'empty' ? { preset } : {}) });
    setBusy(false);
    if (r.ok) onClose();
    else setFailed(r);
  };
  const starts: { id: StartingPoint; label: string; hint: string }[] = [
    { id: 'reference', label: t('project.new.tplReference'), hint: t('project.new.tplReferenceHint') },
    { id: 'empty', label: t('project.new.tplEmpty'), hint: t('project.new.tplEmptyHint') },
    { id: 'nvidia-reference', label: t('project.new.tplNvidiaReference'), hint: t('project.new.tplNvidiaReferenceHint') },
    { id: 'copy', label: t('project.new.tplCopy'), hint: t('project.new.tplCopyHint', { name: current.name }) },
  ];
  return (
    <form ref={ref} className="modal project-modal" role="dialog" aria-modal="true" aria-labelledby="project-new-title" data-project-dialog="new" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <h2 id="project-new-title">{t('project.new.title')}</h2>
      <NameInput id="project-new-name" value={name} onChange={(v) => { setName(v); setEdited(true); setFailed(null); }} error={err} showEmpty={edited}
        suggestion={failed?.suggestion ?? uniqueProjectName(name, taken)} onSuggestion={(v) => { setName(v); setEdited(true); setFailed(null); }} />
      <fieldset className="project-start" data-project-start>
        <legend>{t('project.new.start')}</legend>
        {starts.map((s) => (
          <label key={s.id} data-start={s.id}>
            <input type="radio" name="project-start" value={s.id} checked={start === s.id} onChange={() => pick(s.id)} />
            <span>{s.label}</span>
            <span className="hint">{s.hint}</span>
          </label>
        ))}
      </fieldset>
      {start === 'empty' && (
        <label className="field" data-project-preset>
          <span>{t('project.new.preset')}</span>
          <select value={preset} onChange={(e) => setPreset(e.target.value as StandardsPresetId)}>
            {STANDARDS_PRESET_IDS.map((id) => <option key={id} value={id}>{t(`project.new.preset.${id}`)}</option>)}
          </select>
          <span className="hint">{t('project.new.presetHint')}</span>
        </label>
      )}
      {start === 'empty' && <PresetSummary preset={preset} />}
      <p className="hint" style={{ margin: 0 }}>{t('project.new.note')}</p>
      <ServerError result={failed} />
      <Buttons onClose={onClose} label={t('project.new.confirm')} disabled={!!err} busy={busy} />
    </form>
  );
}

/** stream E (P5, DO-1): what the chosen standards profile preset sets, in plain labels (no internal keys). */
function PresetSummary({ preset }: { preset: StandardsPresetId }) {
  const { t } = useI18n();
  const p = STANDARDS_PRESETS[preset];
  const rows: [string, string][] = [
    [t('standards.ui.field.rackForm'), t(`standards.rackForm.${p.rackForm}`)],
    [t('standards.ui.field.rackPower'), t(`standards.rackPower.${p.rackPower}`)],
    [t('standards.ui.field.connector'), t(`standards.connector.${p.liquid.connector}`)],
    [t('standards.ui.field.cduClass'), t(`standards.cduClass.${p.liquid.cduClass}`)],
    [t('standards.ui.field.air'), t(`standards.air.${p.air}`)],
    [t('standards.ui.field.facilityPrecheck'), t(`standards.facilityPrecheck.${p.facilityPrecheck ?? 'off'}`)],
  ];
  return (
    <div className="hint" data-project-preset-summary={preset} style={{ margin: '-2px 0 4px' }}>
      <div>{t('standards.ui.wizard.summary')}:</div>
      <ul style={{ margin: '2px 0', paddingLeft: 18 }}>{rows.map(([k, v]) => <li key={k}>{k}: {v}</li>)}</ul>
      <div>{t('standards.ui.wizard.defaults')}</div>
    </div>
  );
}

function DeleteProjectDialog({ onClose }: { onClose: () => void }) {
  const { t, num, date } = useI18n();
  const ref = useRef<HTMLFormElement>(null);
  useModal(ref, onClose);
  const project = useApp((s) => s.project);
  const analysis = useApp((s) => s.analysis);
  const projects = useApp((s) => s.projects);
  const online = useApp((s) => s.serverOnline);
  const admin = useApp((s) => s.projectAdmin);
  const deleteProject = useApp((s) => s.deleteProject);
  const readOnly = useReadOnly();
  const lock = useCollab((s) => s.lock);
  const [versions, setVersions] = useState<StoredVersion[] | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setVersions(null);
    if (!online) {
      setVersions([]);
      return;
    }
    collabApi
      .listVersions(project.id)
      .then((r) => alive && setVersions(r.status === 200 && Array.isArray(r.body) ? r.body : []))
      .catch(() => alive && setVersions([]));
    return () => {
      alive = false;
    };
  }, [project.id, online]);

  const item = projects.find((p) => p.id === project.id);
  const count = new Set([...projects.map((p) => p.id), project.id]).size;
  const reason = deleteBlockReason({ online, admin, readOnly, projectCount: count });
  const newest = versions?.[0];
  const when = newest?.savedAt ?? item?.savedAt ?? item?.updatedAt ?? project.updatedAt;
  const who = newest?.savedBy ?? item?.savedBy;
  const matches = deleteConfirmMatches(typed, project.name);
  const reasonText = reason === 'locked' ? t('project.delete.reason.locked', { name: lock?.holder ?? '?' }) : reason ? t(`project.delete.reason.${reason}`) : null;

  const submit = async () => {
    if (reason || !matches || busy) return;
    setBusy(true);
    setError(null);
    const r = await deleteProject(project.id);
    setBusy(false);
    if (r.ok) return onClose();
    setError(r.code === 'locked' ? t('project.delete.reason.locked', { name: r.holder ?? '?' }) : r.code === 'last-project' ? t('project.delete.reason.last') : t('project.toast.failed', { msg: r.message }));
  };

  return (
    <form ref={ref} className="modal project-modal" role="alertdialog" aria-modal="true" aria-labelledby="project-delete-title" aria-describedby="project-delete-recover" data-project-dialog="delete"
      onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <h2 id="project-delete-title">{t('project.delete.title')}</h2>
      <div className="secondary" style={{ fontSize: 12.5 }}>{t('project.delete.intro')}</div>
      <div className="project-delete-name" data-project-delete-name>{project.name}</div>
      <ul className="hall-remove-list" data-project-delete-stats>
        <li>{t('project.delete.halls', { n: num(project.halls.length) })}</li>
        <li>{t('project.delete.racks', { n: num(analysis?.summary.racks ?? item?.racks ?? 0) })}</li>
        <li>{t('project.delete.gpus', { n: num(analysis?.summary.gpus ?? item?.gpus ?? 0) })}</li>
        <li>{versions ? t('project.delete.versions', { n: num(versions.length) }) : t('project.delete.versionsLoading')}</li>
        <li>{who ? t('project.delete.lastSaved', { when: date(when), who }) : t('project.delete.lastSavedNoAuthor', { when: date(when) })}</li>
      </ul>
      <p id="project-delete-recover" className="hint" style={{ margin: 0 }}>{t('project.delete.recover')}</p>
      {reasonText && <p className="hint project-name-error" role="alert" data-project-delete-reason={reason} style={{ margin: 0 }}>{reasonText}</p>}
      <div className="field">
        <label htmlFor="project-delete-typed">{t('project.delete.typeLabel')}</label>
        <input id="project-delete-typed" type="text" value={typed} autoComplete="off" spellCheck={false} disabled={!!reason} data-autofocus data-project-delete-typed
          placeholder={project.name} aria-describedby="project-delete-rule" onChange={(e) => setTyped(e.target.value)} />
        <span id="project-delete-rule" className="hint">{t('project.delete.typeRule')}</span>
      </div>
      {error && <p className="hint project-name-error" role="alert" style={{ margin: 0 }}>{error}</p>}
      <Buttons onClose={onClose} label={t('project.delete.confirm')} disabled={!!reason || !matches} busy={busy} danger />
    </form>
  );
}

function TrashDialog({ onClose }: { onClose: () => void }) {
  const { t, num, date } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  useModal(ref, onClose);
  const trash = useApp((s) => s.trash);
  const restoreProject = useApp((s) => s.restoreProject);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // backlog T3 (8): permanent removal — "Empty trash" or "older than N days", each behind an explicit confirmation step
  const purgeTrash = useApp((s) => s.purgeTrash);
  const [days, setDays] = useState(30);
  const [confirm, setConfirm] = useState<{ kind: 'all' } | { kind: 'older'; days: number; n: number } | null>(null);
  const olderCount = (d: number) => trash.filter((m) => Date.parse(m.deletedAt) < Date.now() - d * 86_400_000).length;
  const purge = async () => {
    if (!confirm) return;
    setBusy('purge');
    setError(null);
    const r = await purgeTrash(confirm.kind === 'all' ? undefined : confirm.days);
    setBusy(null);
    setConfirm(null);
    if (r.ok) useApp.getState().notify(t('project.trash.purged', { n: num(r.removed) }), 'ok');
    else setError(t('project.toast.failed', { msg: r.message }));
  };
  useEffect(() => {
    void useApp.getState().refreshTrash();
  }, []);
  const restore = async (entry: string) => {
    setBusy(entry);
    setError(null);
    const r = await restoreProject(entry);
    setBusy(null);
    if (r.ok) onClose();
    else setError(t('project.toast.failed', { msg: r.message }));
  };
  return (
    <div ref={ref} className="modal project-modal" role="dialog" aria-modal="true" aria-labelledby="project-trash-title" data-project-dialog="trash">
      <h2 id="project-trash-title">{t('project.trash.title')}</h2>
      <p className="hint" style={{ margin: 0 }}>{t('project.trash.intro')}</p>
      {trash.length === 0 ? (
        <p className="secondary" style={{ margin: 0 }}>{t('project.trash.empty')}</p>
      ) : (
        <ul className="project-trash-list">
          {trash.map((m) => (
            <li key={m.entry} data-trash-entry={m.entry}>
              <div>
                <div className="project-trash-name" title={m.name}>{m.name}</div>
                <div className="hint">{t('project.trash.stats', { halls: t('project.unit.halls', { n: num(m.halls) }), gpus: t('project.unit.gpus', { n: num(m.gpus) }), versions: t('project.unit.versions', { n: num(m.versions) }) })}</div>
                <div className="hint">{m.deletedBy ? t('project.trash.deleted', { when: date(m.deletedAt), who: m.deletedBy }) : t('project.trash.deletedNoAuthor', { when: date(m.deletedAt) })}</div>
              </div>
              <button type="button" className="btn sm" disabled={!!busy} data-trash-restore onClick={() => void restore(m.entry)}>
                <Icon name="undo" size={13} />{busy === m.entry ? t('project.busy') : t('project.trash.restore')}
              </button>
            </li>
          ))}
        </ul>
      )}
      {trash.length > 0 && !confirm && (
        <div className="row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'flex-end' }} data-trash-purge>
          <button type="button" className="btn danger sm" disabled={!!busy} data-trash-empty onClick={() => setConfirm({ kind: 'all' })}>{t('project.trash.emptyAll')}</button>
          <span className="grow" />
          <label className="field" style={{ margin: 0 }}>
            <span>{t('project.trash.olderLabel')}</span>
            <input type="number" min={0} max={3650} step={1} value={days} data-trash-days style={{ width: 90 }} onChange={(e) => setDays(Math.max(0, Math.min(3650, Math.floor(Number(e.target.value) || 0))))} />
          </label>
          <button type="button" className="btn sm" disabled={!!busy} data-trash-older onClick={() => {
            const n = olderCount(days);
            if (n === 0) setError(t('project.trash.purgeNone', { days: t('project.unit.days', { n: num(days) }) }));
            else { setError(null); setConfirm({ kind: 'older', days, n }); }
          }}>{t('project.trash.purgeOlder')}</button>
        </div>
      )}
      {confirm && (
        <div className="callout warn" role="alertdialog" aria-labelledby="project-trash-confirm" data-trash-confirm={confirm.kind}>
          <p id="project-trash-confirm" style={{ margin: 0 }}>
            {confirm.kind === 'all' ? t('project.trash.emptyConfirm', { n: num(trash.length) }) : t('project.trash.purgeConfirm', { n: num(confirm.n), days: t('project.unit.days', { n: num(confirm.days) }) })}
          </p>
          <div className="row" style={{ marginTop: 8 }}>
            <span className="grow" />
            <button type="button" className="btn sm" disabled={busy === 'purge'} onClick={() => setConfirm(null)} data-trash-confirm-cancel>{t('project.trash.cancel')}</button>
            <button type="button" className="btn danger sm" disabled={busy === 'purge'} onClick={() => void purge()} data-trash-confirm-ok>{busy === 'purge' ? t('project.busy') : t('project.trash.confirmDelete')}</button>
          </div>
        </div>
      )}
      {error && <p className="hint project-name-error" role="alert" style={{ margin: 0 }}>{error}</p>}
      <div className="row"><span className="grow" /><button type="button" className="btn sm" onClick={onClose} data-project-cancel>{t('project.close')}</button></div>
    </div>
  );
}

function SaveAsNewDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const ref = useRef<HTMLFormElement>(null);
  useModal(ref, onClose);
  const project = useApp((s) => s.project);
  const projects = useApp((s) => s.projects);
  const saveAsNewProject = useApp((s) => s.saveAsNewProject);
  const others = useMemo(() => (projects.some((p) => p.id === project.id) ? projects : [...projects, { id: project.id, name: project.name, updatedAt: '' }]), [projects, project.id, project.name]);
  const taken = useMemo(() => others.map((p) => p.name), [others]);
  const [name, setName] = useState(() => copyProjectName(project.name, taken, t('project.saveAs.copyWord')));
  const [client, setClient] = useState(project.client ?? '');
  const [description, setDescription] = useState(project.description ?? '');
  const [siteName, setSiteName] = useState(project.site.name);
  const [siteLocation, setSiteLocation] = useState(project.site.location);
  const [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<Extract<ProjectActionResult, { ok: false }> | null>(null);
  const err: ProjectNameError | null = projectNameError(name, others) ?? (failed?.code === 'name-taken' ? 'taken' : null);
  const submit = async () => {
    if (err || busy) return;
    setBusy(true);
    setFailed(null);
    const r = await saveAsNewProject({ name, client, description, siteName, siteLocation });
    setBusy(false);
    if (r.ok) onClose();
    else setFailed(r);
  };
  const field = (id: string, label: string, value: string, set: (v: string) => void): ReactNode => (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="text" value={value} onChange={(e) => set(e.target.value)} data-save-as-field={id} />
    </div>
  );
  return (
    <form ref={ref} className="modal project-modal" role="dialog" aria-modal="true" aria-labelledby="project-saveas-title" data-project-dialog="saveAs" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <h2 id="project-saveas-title">{t('project.saveAs.title')}</h2>
      <p className="hint" style={{ margin: 0 }}>{t('project.saveAs.help', { name: project.name })}</p>
      <NameInput id="project-saveas-name" value={name} onChange={(v) => { setName(v); setEdited(true); setFailed(null); }} error={err} showEmpty={edited}
        suggestion={failed?.suggestion ?? uniqueProjectName(name, taken)} onSuggestion={(v) => { setName(v); setFailed(null); }} />
      {field('project-saveas-client', t('project.field.client'), client, setClient)}
      {field('project-saveas-site', t('project.field.siteName'), siteName, setSiteName)}
      {field('project-saveas-location', t('project.field.location'), siteLocation, setSiteLocation)}
      {field('project-saveas-description', t('project.field.description'), description, setDescription)}
      <ServerError result={failed} />
      <Buttons onClose={onClose} label={t('project.saveAs.confirm')} disabled={!!err} busy={busy} />
    </form>
  );
}

// ─────────── Site panel: project identity ───────────

/** Project name (rename, autosaved, unique) · client · description · 'Save as new project…'. */
export function ProjectIdentitySection() {
  const { t } = useI18n();
  const project = useApp((s) => s.project);
  const projects = useApp((s) => s.projects);
  const online = useApp((s) => s.serverOnline);
  const admin = useApp((s) => s.projectAdmin);
  const update = useApp((s) => s.update);
  const openDialog = useProjectDialog((s) => s.open);
  const [name, setName] = useState(project.name);
  useEffect(() => setName(project.name), [project.name, project.id]);
  const err = projectNameError(name, online ? projects : [], project.id);
  const commit = () => {
    if (err) return;
    const clean = cleanProjectName(name);
    if (clean !== project.name) update((d) => { d.name = clean; });
    setName(clean);
  };
  const canCopy = online && admin;
  return (
    <Section
      title={t('project.section.title')}
      actions={
        <button className="btn sm" data-ro-allow data-save-as-new disabled={!canCopy} title={canCopy ? t('project.section.saveAsHint') : t('project.section.offlineHint')} onClick={() => openDialog({ kind: 'saveAs' })}>
          <Icon name="copy" size={13} />{t('project.section.saveAs')}
        </button>
      }
    >
      <div className="project-identity">
        <div className="field wide">
          <label htmlFor="site-project-name">{t('project.field.name')}</label>
            <input id="site-project-name" type="text" value={name} data-project-rename aria-invalid={err ? true : undefined} aria-describedby="site-project-name-hint"
              onChange={(e) => setName(e.target.value)} onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                if (e.key === 'Escape') setName(project.name);
              }} />
            {err ? (
              <span id="site-project-name-hint" className="hint project-name-error" role="alert" data-project-name-error={err}>{nameErrorText(t, err)}</span>
            ) : (
              <span id="site-project-name-hint" className="hint">{t('project.section.nameHint')}</span>
            )}
        </div>
        <div className="fields-2">
          <div>
            <TextField label={t('project.field.client')} value={project.client ?? ''} onChange={(v) => update((d) => { d.client = v; })} />
          </div>
          <div>
            <TextField label={t('project.field.description')} value={project.description ?? ''} onChange={(v) => update((d) => { d.description = v; })} />
          </div>
        </div>
      </div>
      <p className="hint" style={{ marginTop: 0 }}>{canCopy ? t('project.section.saveAsHint') : t('project.section.offlineHint')}</p>
    </Section>
  );
}
