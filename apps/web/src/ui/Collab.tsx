// Collaboration UI (stream T8): topbar lock badge · versions button · copy-link, the versions drawer (list, compare,
// restore) and the display-name prompt. Logic lives in app/collab.ts.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { KPI_HIGHER_IS_BETTER, VERSION_KPIS, type Project } from '@aidc/core';
import { useApp } from '../store/appStore.ts';
import { useI18n } from '../i18n/index.ts';
import { AUTOSAVE_COALESCE_MIN, collabApi, deepLinkUrl, startCollab, useCollab, type DiffResponse, type StoredVersion } from '../app/collab.ts';
import { recordRev, session } from '../app/session.ts';
import { Icon } from './icons.tsx';

// ─────────── read-only mode (polish v2 2차): page-panel edit controls disabled while another holder has the lock ───────────

/** true while the server is online and someone else holds the current project's edit lock */
export function useReadOnly(): boolean {
  const serverOnline = useApp((s) => s.serverOnline);
  const other = useCollab((s) => !!s.lock && !s.mine);
  return serverOnline && other;
}

/** controls that stay usable in read-only mode: explicit opt-outs, tab strips, search boxes, disclosure summaries */
export const READ_ONLY_ALLOW = '[data-ro-allow], [role="tab"], input[type="search"]';
const RO_CONTROLS = 'button, input, select, textarea';

/** React's current `disabled` prop of a host element (so leaving read-only restores what the component asked for) */
function reactDisabled(el: Element): boolean {
  const key = Object.keys(el).find((k) => k.startsWith('__reactProps$'));
  return key ? !!(el as unknown as Record<string, { disabled?: boolean } | undefined>)[key]?.disabled : false;
}

/**
 * Wraps the page-panel content in a <fieldset>. A native `disabled` fieldset cannot exempt downloads or view toggles, so read-only mode
 * disables every form control inside except `READ_ONLY_ALLOW` matches, marks them `data-ro-off`, and keeps new or re-rendered controls
 * disabled with a MutationObserver until the lock is free again. The store's `beforeEdit` guard stays as the second line of defence.
 */
export function ReadOnlyFieldset({ readOnly, children }: { readOnly: boolean; children: ReactNode }) {
  const ref = useRef<HTMLFieldSetElement>(null);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const restore = () => {
      for (const el of root.querySelectorAll<HTMLButtonElement>('[data-ro-off]')) {
        el.removeAttribute('data-ro-off');
        el.disabled = reactDisabled(el);
      }
    };
    if (!readOnly) {
      restore();
      return;
    }
    const apply = () => {
      for (const el of root.querySelectorAll<HTMLButtonElement>(RO_CONTROLS)) {
        if (el.closest(READ_ONLY_ALLOW)) continue;
        if (!el.disabled) {
          el.disabled = true;
          el.setAttribute('data-ro-off', '');
        }
      }
    };
    apply();
    const mo = new MutationObserver(apply);
    mo.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled'] });
    return () => {
      mo.disconnect();
      restore();
    };
  }, [readOnly]);
  return (
    // backlog T3 (9): no aria-disabled on the fieldset — it told assistive technology that every control inside is disabled, although
    // READ_ONLY_ALLOW controls (tabs, search, filters, CSV / downloads) still work. Edit controls carry the native `disabled` state instead.
    <fieldset ref={ref} className="ro-scope" data-readonly={readOnly ? '' : undefined}>
      {children}
    </fieldset>
  );
}

/** Banner above the page content in read-only mode (who holds the lock + force release). */
export function ReadOnlyBanner() {
  const { t } = useI18n();
  const readOnly = useReadOnly();
  const lock = useCollab((s) => s.lock);
  if (!readOnly || !lock) return null;
  const forceRelease = async () => {
    if (!window.confirm(t('shell.collab.forceConfirm', { name: lock.holder }))) return;
    if (await useCollab.getState().acquire(true)) useApp.getState().notify(t('shell.collab.forced'), 'ok');
  };
  return (
    <div className="ro-banner" role="status" data-readonly-banner>
      <span className="dot" />
      <span className="grow">{t('shell.collab.readOnlyBanner', { name: lock.holder })}</span>
      <button className="btn sm" onClick={() => void forceRelease()} data-ro-allow>{t('shell.collab.forceRelease')}</button>
    </div>
  );
}

export function CollabTopbar() {
  const { t, date } = useI18n();
  const serverOnline = useApp((s) => s.serverOnline);
  const lock = useCollab((s) => s.lock);
  const mine = useCollab((s) => s.mine);
  const displayName = useCollab((s) => s.displayName);
  const versionsOpen = useCollab((s) => s.versionsOpen);

  useEffect(() => startCollab(), []);

  const copyLink = async () => {
    const s = useApp.getState();
    const url = deepLinkUrl(s.project.id, s.page, s.hallId);
    try {
      await navigator.clipboard.writeText(url);
      s.notify(t('shell.collab.linkCopied', { url }), 'ok');
    } catch {
      s.notify(t('shell.collab.linkCopyFailed', { url }), 'info');
    }
  };

  const forceRelease = async () => {
    if (!lock || !window.confirm(t('shell.collab.forceConfirm', { name: lock.holder }))) return;
    if (await useCollab.getState().acquire(true)) useApp.getState().notify(t('shell.collab.forced'), 'ok');
  };

  return (
    <>
      {serverOnline && (lock && !mine ? (
        <span className="row" style={{ gap: 4 }} data-lock-badge="other">
          <span className="pill lock-badge other" title={t('shell.collab.lockOtherTitle', { name: lock.holder, since: date(lock.acquiredAt) })}>
            <span className="dot" />{t('shell.collab.lockOther', { name: lock.holder })}
          </span>
          <button className="btn sm" onClick={() => void forceRelease()} data-force-release>{t('shell.collab.forceRelease')}</button>
        </span>
      ) : mine && lock ? (
        <button className="pill lock-badge mine" data-lock-badge="mine" title={t('shell.collab.lockMineTitle')} onClick={() => { if (window.confirm(t('shell.collab.releaseConfirm'))) void useCollab.getState().release().then(() => useApp.getState().notify(t('shell.collab.released'), 'ok')); }}>
          <span className="dot" />{t('shell.collab.lockMine', { name: lock.holder })}
        </button>
      ) : (
        <button className="pill lock-badge" data-lock-badge="free" title={t('shell.collab.lockFreeTitle')} onClick={() => useCollab.getState().setNamePromptOpen(true)}>
          <span className="dot" />{displayName ?? t('shell.collab.guest')} · {t('shell.collab.lockFree')}
        </button>
      ))}
      {serverOnline && (
        <button className={`btn ghost sm ${versionsOpen ? 'active' : ''}`} title={t('shell.collab.versionsTitle')} onClick={() => useCollab.getState().setVersionsOpen(!versionsOpen)} data-versions-button>
          <Icon name="layers" size={14} />{t('shell.collab.versions')}
        </button>
      )}
      <button className="btn ghost sm" title={t('shell.collab.copyLinkTitle')} onClick={() => void copyLink()} data-copy-link>
        <Icon name="copy" size={14} />
      </button>
    </>
  );
}

export function CollabOverlays() {
  return (
    <>
      <NamePrompt />
      <VersionsDrawer />
    </>
  );
}

function NamePrompt() {
  const { t } = useI18n();
  const open = useCollab((s) => s.namePromptOpen);
  const [name, setName] = useState(session.displayName ?? '');
  useEffect(() => {
    if (open) setName(session.displayName ?? '');
  }, [open]);
  if (!open) return null;
  const submit = () => useCollab.getState().setDisplayName(name.trim() || null);
  return (
    <div className="modal-backdrop" data-name-prompt onMouseDown={(e) => { if (e.target === e.currentTarget) useCollab.getState().setNamePromptOpen(false); }}>
      <div className="modal" role="dialog" aria-label={t('shell.collab.namePromptTitle')}>
        <h2>{t('shell.collab.namePromptTitle')}</h2>
        <div className="hint">{t('shell.collab.namePromptBody')}</div>
        <input type="text" autoFocus value={name} maxLength={60} placeholder={t('shell.collab.namePlaceholder')} aria-label={t('shell.collab.displayName')}
          onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
        <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
          <button className="btn sm ghost" onClick={() => useCollab.getState().setNamePromptOpen(false)}>{t('shell.collab.nameSkip')}</button>
          <button className="btn sm primary" onClick={submit} data-name-save>{t('shell.collab.nameSave')}</button>
        </div>
      </div>
    </div>
  );
}

const CURRENT = 'current';

function fmtKpi(k: string, v: number, num: (v: number, d?: number) => string): string {
  if (!Number.isFinite(v)) return '—';
  switch (k) {
    case 'rfsDays': return new Date(v * 86_400_000).toISOString().slice(0, 10);
    case 'capexUSD': return `$${num(v / 1e6, 1)} M`;
    case 'itMW':
    case 'facilityMW': return num(v, 2);
    case 'pue': return num(v, 3);
    case 'cableKm': return num(v, 1);
    default: return num(v, 0);
  }
}

function fmtDelta(k: string, d: number, num: (v: number, d?: number) => string): string {
  if (!d) return '0';
  const sign = d > 0 ? '+' : '−';
  const a = Math.abs(d);
  switch (k) {
    case 'capexUSD': return `${sign}$${num(a / 1e6, 2)} M`;
    case 'itMW':
    case 'facilityMW': return `${sign}${num(a, 2)}`;
    case 'pue': return `${sign}${num(a, 3)}`;
    case 'cableKm': return `${sign}${num(a, 1)}`;
    default: return `${sign}${num(a, 0)}`;
  }
}

function VersionsDrawer() {
  const { t, num, date, rel } = useI18n();
  const open = useCollab((s) => s.versionsOpen);
  const projectId = useApp((s) => s.project.id);
  const serverOnline = useApp((s) => s.serverOnline);
  const [list, setList] = useState<StoredVersion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [diff, setDiff] = useState<DiffResponse | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    if (!serverOnline) return;
    const r = await collabApi.listVersions(projectId).catch((e: Error) => ({ status: 0, body: e.message as unknown as StoredVersion[] }));
    if (r.status === 200) {
      setList(r.body);
      setError(null);
    } else setError(t('shell.collab.loadFailed', { message: String(r.body ?? r.status) }));
  };

  useEffect(() => {
    if (!open) return;
    setDiff(null);
    setSelected([]);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectId, serverOnline]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') useCollab.getState().setVersionsOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const order = useMemo(() => new Map([[CURRENT, Number.MAX_SAFE_INTEGER], ...list.map((v) => [v.id, Date.parse(v.savedAt)] as [string, number])]), [list]);

  if (!open) return null;

  const toggle = (id: string) => setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id].slice(-2)));

  const saveVersion = async () => {
    setBusy(true);
    const app = useApp.getState();
    if (app.dirty) await app.save();
    const r = await collabApi.saveVersion(projectId, { note: note.trim() || undefined, savedBy: session.displayName ?? undefined });
    setBusy(false);
    if (r.status === 201) {
      setNote('');
      app.notify(t('shell.collab.versionSaved'), 'ok');
      void load();
    } else app.notify(t('shell.collab.loadFailed', { message: String((r.body as unknown as { error?: string })?.error ?? r.status) }), 'error');
  };

  const compare = async () => {
    if (selected.length !== 2) return;
    const [from, to] = [...selected].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    setBusy(true);
    const app = useApp.getState();
    if (app.dirty && (from === CURRENT || to === CURRENT)) await app.save();
    const r = await collabApi.diff(projectId, from, to).catch((e: Error) => ({ status: 0, body: { error: e.message } as DiffResponse & { error?: string } }));
    setBusy(false);
    if (r.status === 200) setDiff(r.body);
    else app.notify(t('shell.collab.loadFailed', { message: String(r.body?.error ?? r.status) }), 'error');
  };

  const restore = async (v: StoredVersion) => {
    const app = useApp.getState();
    if (!window.confirm(t('shell.collab.restoreConfirm', { date: date(v.savedAt) }))) return;
    const c = useCollab.getState();
    if (c.lock && !c.mine) {
      app.notify(t('shell.collab.readOnlyBlocked', { name: c.lock.holder }), 'error');
      return;
    }
    if (!(await c.acquire())) return;
    if (app.dirty) await app.save();
    setBusy(true);
    const r = await collabApi.restoreVersion(projectId, v.id);
    setBusy(false);
    if (r.status !== 200) {
      app.notify(t('shell.collab.loadFailed', { message: String(r.body?.error ?? r.status) }), 'error');
      return;
    }
    const restored: Project = r.body.project;
    recordRev(restored);
    // apply through update() so Ctrl+Z undoes the restore (history keeps the previous state)
    app.update((d) => {
      const draft = d as unknown as Record<string, unknown>;
      for (const k of Object.keys(draft)) delete draft[k];
      Object.assign(draft, structuredClone(restored));
    });
    app.notify(t('shell.collab.restored'), 'ok');
    void load();
  };

  const selectIn3d = () => {
    if (!diff) return;
    const ids = new Set(useApp.getState().project.equipment.map((e) => e.id));
    const pick = [...diff.diff.added, ...diff.diff.moved, ...diff.diff.changed].filter((id) => ids.has(id));
    useApp.getState().setSelection(pick);
  };

  const label = (id: string) => (id === CURRENT ? t('shell.collab.current') : (() => { const v = list.find((x) => x.id === id); return v ? date(v.savedAt) : id; })());

  return (
    <aside className="help-drawer versions-drawer" role="dialog" aria-label={t('shell.collab.versionsTitle')} data-versions-drawer>
      <div className="help-head">
        <strong>{t('shell.collab.versionsTitle')}</strong>
        <span className="grow" />
        <button className="btn ghost sm" onClick={() => useCollab.getState().setVersionsOpen(false)} aria-label={t('shell.collab.close')}>✕</button>
      </div>
      <div className="help-body">
        {!serverOnline ? <div className="empty">{t('shell.collab.versionsOffline')}</div> : (
          <>
            <div className="row" style={{ gap: 6, marginBottom: 10 }}>
              <input type="text" value={note} placeholder={t('shell.collab.notePlaceholder')} onChange={(e) => setNote(e.target.value)} style={{ flex: 1 }} maxLength={500} />
              <button className="btn sm primary" disabled={busy} onClick={() => void saveVersion()} data-save-version><Icon name="save" size={13} />{t('shell.collab.saveVersion')}</button>
            </div>
            {error && <div className="hint" style={{ color: 'var(--critical)' }}>{error}</div>}
            <div className="row" style={{ gap: 6, marginBottom: 6 }}>
              <span className="hint" style={{ flex: 1 }}>{t('shell.collab.compareHint')}</span>
              <button className="btn sm" disabled={selected.length !== 2 || busy} onClick={() => void compare()} data-compare>{t('shell.collab.compare')}</button>
            </div>
            <div className="version-list">
              <label className={`version-row ${selected.includes(CURRENT) ? 'sel' : ''}`}>
                <input type="checkbox" checked={selected.includes(CURRENT)} onChange={() => toggle(CURRENT)} />
                <div><strong>{t('shell.collab.current')}</strong></div>
                <span />
              </label>
              {list.map((v) => (
                <label key={v.id} className={`version-row ${selected.includes(v.id) ? 'sel' : ''}`} data-version-row={v.id}>
                  <input type="checkbox" checked={selected.includes(v.id)} onChange={() => toggle(v.id)} />
                  <div style={{ minWidth: 0 }}>
                    <div title={date(v.savedAt)}>
                      <strong>{rel(v.savedAt)}</strong> <span className="badge">{t(`shell.collab.kind.${v.kind}`)}</span>{v.savedBy ? <span className="v-sub"> · {t('shell.collab.by', { name: v.savedBy })}</span> : null}
                    </div>
                    {v.note && <div className="v-sub" style={{ color: 'var(--text-secondary)' }}>{v.note}</div>}
                    <div className="v-sub">{num(v.summary.gpus)} GPU · {num(v.summary.racks)} {t('shell.collab.metric.racks')} · {num(v.summary.itMW, 2)} MW IT · ${num(v.summary.capexUSD / 1e6, 1)} M{v.summary.rfs ? ` · RFS ${v.summary.rfs}` : ''}</div>
                  </div>
                  <button className="btn sm ghost" disabled={busy} onClick={(e) => { e.preventDefault(); void restore(v); }} data-restore={v.id}>{t('shell.collab.restore')}</button>
                </label>
              ))}
              {!list.length && <div className="empty">{t('shell.collab.versionsEmpty', { minutes: AUTOSAVE_COALESCE_MIN })}</div>}
            </div>
            {diff && (
              <div className="help-section" data-diff>
                <div className="section-title"><span>{t('shell.collab.diffTitle')} — {label(diff.from)} → {label(diff.to)}</span><span className="line" /></div>
                <div className="row wrap" style={{ gap: 6, margin: '6px 0' }}>
                  <span className="pill"><span className="dot" style={{ background: 'var(--good)' }} />{t('shell.collab.added')} {diff.diff.added.length}</span>
                  <span className="pill"><span className="dot" style={{ background: 'var(--critical)' }} />{t('shell.collab.removed')} {diff.diff.removed.length}</span>
                  <span className="pill"><span className="dot" style={{ background: 'var(--warning)' }} />{t('shell.collab.moved')} {diff.diff.moved.length}</span>
                  <span className="pill"><span className="dot" style={{ background: 'var(--accent)' }} />{t('shell.collab.changed')} {diff.diff.changed.length}</span>
                  <span className="grow" />
                  <button className="btn sm" onClick={selectIn3d} disabled={!diff.diff.added.length && !diff.diff.moved.length && !diff.diff.changed.length}>{t('shell.collab.selectIn3d')}</button>
                </div>
                <table className="diff-table">
                  <thead><tr><th>{t('shell.collab.metric')}</th><th>{t('shell.collab.from')}</th><th>{t('shell.collab.to')}</th><th>{t('shell.collab.delta')}</th></tr></thead>
                  <tbody>
                    {VERSION_KPIS.map((k) => {
                      const raw = diff.diff.summaryDelta[k] ?? 0;
                      // a delta that rounds to zero at display precision is shown as a neutral 0
                      const d = Math.abs(raw) < ({ pue: 5e-4, itMW: 5e-3, facilityMW: 5e-3, cableKm: 0.05, capexUSD: 5e3 } as Record<string, number>)[k] ? 0 : raw;
                      const better = KPI_HIGHER_IS_BETTER[k];
                      const cls = !d || better === undefined ? '' : (d > 0) === better ? 'up' : 'down';
                      return (
                        <tr key={k}>
                          <td>{t(`shell.collab.metric.${k}`)}</td>
                          <td>{fmtKpi(k, diff.kpisFrom[k], num)}</td>
                          <td>{fmtKpi(k, diff.kpisTo[k], num)}</td>
                          <td className={cls}>{fmtDelta(k, d, num)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <div className="section-title" style={{ marginTop: 12 }}><span>{t('shell.collab.byCategory')}</span><span className="line" /></div>
                {diff.byCategory.length ? (
                  <table className="diff-table">
                    <thead><tr><th /><th>{t('shell.collab.added')}</th><th>{t('shell.collab.removed')}</th><th>{t('shell.collab.moved')}</th><th>{t('shell.collab.changed')}</th></tr></thead>
                    <tbody>{diff.byCategory.map((c) => <tr key={c.category}><td className="mono">{c.category}</td><td>{c.added}</td><td>{c.removed}</td><td>{c.moved}</td><td>{c.changed}</td></tr>)}</tbody>
                  </table>
                ) : <div className="hint">{t('shell.collab.noEquipmentChange')}</div>}
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
