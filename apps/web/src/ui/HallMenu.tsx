import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { create } from 'zustand';
import { hallRemovalSummary, makeHall } from '@aidc/core';
import { useApp } from '../store/appStore.ts';
import { useT } from '../i18n/index.ts';
import { Select } from './controls.tsx';
import { Icon } from './icons.tsx';
import { useReadOnly } from './Collab.tsx';

// Data hall lifecycle UI: topbar hall select + "New hall" + manage menu, the same menu on Site-panel hall rows, and the dialogs.

type HallDialog = { kind: 'add' } | { kind: 'rename'; hallId: string } | { kind: 'delete'; hallId: string };

export const useHallDialog = create<{ dialog: HallDialog | null; open: (d: HallDialog) => void; close: () => void }>((set) => ({
  dialog: null,
  open: (dialog) => set({ dialog }),
  close: () => set({ dialog: null }),
}));

/** "⋯" menu for one hall: rename · duplicate (empty / with layout) · delete. */
export function HallMenu({ hallId }: { hallId: string }) {
  const t = useT();
  const readOnly = useReadOnly();
  const halls = useApp((s) => s.project.halls);
  const duplicateHall = useApp((s) => s.duplicateHall);
  const notify = useApp((s) => s.notify);
  const openDialog = useHallDialog((s) => s.open);
  const [open, setOpen] = useState(false);
  // fixed position from the toggle's rect: the topbar and table cells clip overflow, so an absolutely positioned popover would be hidden
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onResize = () => setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); window.removeEventListener('resize', onResize); };
  }, [open]);
  const hall = halls.find((h) => h.id === hallId);
  if (!hall) return null;
  const run = (fn: () => void) => (e: ReactMouseEvent) => {
    e.stopPropagation();
    setOpen(false);
    fn();
  };
  const dup = (withLayout: boolean) => {
    const id = duplicateHall(hallId, withLayout);
    if (id) notify(t('halls.toast.duplicated', { name: useApp.getState().project.halls.find((h) => h.id === id)?.name ?? id }), 'ok');
  };
  return (
    <div className="hall-menu" ref={ref} data-hall-menu={hallId} onClick={(e) => e.stopPropagation()}>
      <button className="btn ghost sm" title={t('halls.manage')} aria-label={t('halls.manage')} aria-haspopup="menu" aria-expanded={open} data-ro-allow data-hall-menu-toggle onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        setPos({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) });
        setOpen(!open);
      }}>⋯</button>
      {open && (
        <div className="hall-menu-pop" role="menu" style={pos ? { position: 'fixed', top: pos.top, right: pos.right } : undefined}>
          <div className="hall-menu-head">{hall.name}</div>
          <button role="menuitem" data-hall-action="rename" disabled={readOnly} onClick={run(() => openDialog({ kind: 'rename', hallId }))}>{t('halls.menu.rename')}</button>
          <button role="menuitem" data-hall-action="duplicate-empty" disabled={readOnly} onClick={run(() => dup(false))}>{t('halls.menu.duplicateEmpty')}</button>
          <button role="menuitem" data-hall-action="duplicate-layout" disabled={readOnly} onClick={run(() => dup(true))}>{t('halls.menu.duplicateLayout')}</button>
          <hr />
          <button role="menuitem" className="danger" data-hall-action="delete" disabled={readOnly || halls.length <= 1} title={halls.length <= 1 ? t('halls.menu.lastHall') : undefined} onClick={run(() => openDialog({ kind: 'delete', hallId }))}>
            {t('halls.menu.delete')}
          </button>
        </div>
      )}
    </div>
  );
}

/** Topbar: hall select · "+ New hall" · manage menu of the selected hall. */
export function HallTopbarControls() {
  const t = useT();
  const readOnly = useReadOnly();
  const halls = useApp((s) => s.project.halls);
  const hallId = useApp((s) => s.hallId);
  const setHall = useApp((s) => s.setHall);
  const openDialog = useHallDialog((s) => s.open);
  return (
    <>
      <div className="topbar-hall">
        <Select value={hallId} options={halls.map((h) => ({ value: h.id, label: h.name }))} onChange={(v) => setHall(v)} />
      </div>
      <button className="btn ghost sm topbar-hall-add" data-hall-add title={t('halls.newTitle')} disabled={readOnly} onClick={() => openDialog({ kind: 'add' })}>
        <Icon name="plus" size={13} /><span className="lbl">{t('halls.new')}</span>
      </button>
      <HallMenu hallId={hallId} />
    </>
  );
}

export function HallDialogs() {
  const dialog = useHallDialog((s) => s.dialog);
  const close = useHallDialog((s) => s.close);
  useEffect(() => {
    if (!dialog) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog, close]);
  if (!dialog) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      {dialog.kind === 'add' && <AddHallDialog onClose={close} />}
      {dialog.kind === 'rename' && <RenameHallDialog hallId={dialog.hallId} onClose={close} />}
      {dialog.kind === 'delete' && <DeleteHallDialog hallId={dialog.hallId} onClose={close} />}
    </div>
  );
}

function DialogButtons({ onClose, label, disabled, danger }: { onClose: () => void; label: string; disabled?: boolean; danger?: boolean }) {
  const t = useT();
  return (
    <div className="row" style={{ gap: 6 }}>
      <span className="grow" />
      <button type="button" className="btn sm" onClick={onClose}>{t('halls.cancel')}</button>
      <button type="submit" className={`btn sm ${danger ? 'danger' : 'primary'}`} data-hall-confirm disabled={disabled}>{label}</button>
    </div>
  );
}

/** another hall already uses this name (trimmed, case-insensitive) — two identical entries in the hall select / IP map are ambiguous */
function nameTaken(halls: { id: string; name: string }[], name: string, selfId?: string): boolean {
  const n = name.trim().toLowerCase();
  return !!n && halls.some((h) => h.id !== selfId && h.name.trim().toLowerCase() === n);
}

function NameTakenHint({ show }: { show: boolean }) {
  const t = useT();
  return show ? <span className="hint" role="alert" data-hall-name-taken style={{ margin: 0, color: 'var(--danger, #d64545)' }}>{t('halls.field.nameTaken')}</span> : null;
}

function AddHallDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const readOnly = useReadOnly();
  const project = useApp((s) => s.project);
  const addHall = useApp((s) => s.addHall);
  const notify = useApp((s) => s.notify);
  const preview = useMemo(() => makeHall(project), [project]);
  const [name, setName] = useState(preview.name);
  const [w, setW] = useState(preview.width);
  const [d, setD] = useState(preview.depth);
  const taken = nameTaken(project.halls, name);
  const submit = () => {
    if (taken) return;
    const id = addHall({ name, width: w, depth: d });
    if (!id) return;
    notify(t('halls.toast.added', { name: name.trim() }), 'ok');
    onClose();
  };
  return (
    <form className="modal" role="dialog" aria-label={t('halls.add.title')} data-hall-dialog="add" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <h2>{t('halls.add.title')}</h2>
      <div className="field"><label htmlFor="hall-add-name">{t('halls.field.name')}</label><input id="hall-add-name" type="text" autoFocus value={name} aria-invalid={taken || undefined} onChange={(e) => setName(e.target.value)} /><NameTakenHint show={taken} /></div>
      <div className="field"><label htmlFor="hall-add-w">{t('halls.field.width')}</label><input id="hall-add-w" type="number" min={1} step="any" value={w} onChange={(e) => setW(Number(e.target.value))} /></div>
      <div className="field"><label htmlFor="hall-add-d">{t('halls.field.depth')}</label><input id="hall-add-d" type="number" min={1} step="any" value={d} onChange={(e) => setD(Number(e.target.value))} /></div>
      <p className="hint" style={{ margin: 0 }}>{t('halls.add.hint', { h: preview.clearHeight, tile: preview.tileSize, x: preview.origin.x.toFixed(1), y: preview.origin.y.toFixed(1) })}</p>
      <DialogButtons onClose={onClose} label={t('halls.add.confirm')} disabled={readOnly || !name.trim() || taken || !(w > 0) || !(d > 0)} />
    </form>
  );
}

function RenameHallDialog({ hallId, onClose }: { hallId: string; onClose: () => void }) {
  const t = useT();
  const readOnly = useReadOnly();
  const halls = useApp((s) => s.project.halls);
  const hall = halls.find((h) => h.id === hallId);
  const renameHall = useApp((s) => s.renameHall);
  const notify = useApp((s) => s.notify);
  const [name, setName] = useState(hall?.name ?? '');
  if (!hall) return null;
  const taken = nameTaken(halls, name, hallId);
  return (
    <form className="modal" role="dialog" aria-label={t('halls.rename.title')} data-hall-dialog="rename" onSubmit={(e) => {
      e.preventDefault();
      if (taken) return;
      if (renameHall(hallId, name)) notify(t('halls.toast.renamed', { name: name.trim() }), 'ok');
      onClose();
    }}>
      <h2>{t('halls.rename.title')}</h2>
      <div className="field"><label htmlFor="hall-rename">{t('halls.field.name')}</label><input id="hall-rename" type="text" autoFocus value={name} aria-invalid={taken || undefined} onChange={(e) => setName(e.target.value)} onFocus={(e) => e.target.select()} /><NameTakenHint show={taken} /></div>
      <DialogButtons onClose={onClose} label={t('halls.rename.confirm')} disabled={readOnly || !name.trim() || taken} />
    </form>
  );
}

function DeleteHallDialog({ hallId, onClose }: { hallId: string; onClose: () => void }) {
  const t = useT();
  const readOnly = useReadOnly();
  const project = useApp((s) => s.project);
  const thermal = useApp((s) => s.thermal);
  const removeHall = useApp((s) => s.removeHall);
  const notify = useApp((s) => s.notify);
  const sum = useMemo(() => hallRemovalSummary(project, hallId), [project, hallId]);
  const thermalN = thermal.scenarios.filter((sc) => sc.options.hallId === hallId).length + (thermal.result?.options.hallId === hallId ? 1 : 0);
  const rows: [string, number, Record<string, number>?][] = [
    ['equipment', sum.equipment], ['containments', sum.containments], ['trays', sum.trays], ['busways', sum.busways], ['reservations', sum.reservations],
    ['servicesZones', sum.servicesZones], ['clusters', sum.clusters, { m: sum.clustersRemoved }], ['wavePods', sum.wavePods, { m: sum.wavesRemoved }], ['thermal', thermalN + sum.thermalSnapshots],
  ];
  return (
    <form className="modal" role="alertdialog" aria-label={t('halls.delete.title', { name: sum.hallName })} data-hall-dialog="delete" style={{ width: 440 }} onSubmit={(e) => {
      e.preventDefault();
      const name = sum.hallName;
      if (removeHall(hallId)) {
        notify(t('halls.toast.removed', { name }), 'ok');
        onClose();
      }
    }}>
      <h2>{t('halls.delete.title', { name: sum.hallName })}</h2>
      <div className="secondary" style={{ fontSize: 12.5 }}>{t('halls.delete.intro')}</div>
      <ul className="hall-remove-list">
        {rows.map(([k, n, extra]) => <li key={k} className={n ? '' : 'zero'}>{t(`halls.delete.${k}`, { n, ...(extra ?? {}) })}</li>)}
      </ul>
      {!sum.allowed && <p className="hint" style={{ margin: 0 }}>{t('halls.menu.lastHall')}</p>}
      <p className="hint" style={{ margin: 0 }}>{t('halls.delete.undo')}</p>
      <DialogButtons onClose={onClose} label={t('halls.delete.confirm')} disabled={readOnly || !sum.allowed} danger />
    </form>
  );
}
