import { useEffect, useState } from 'react';
import { CATALOG_DATA_CHANGES } from '@aidc/core';
import { useApp } from '../store/appStore.ts';
import { useT } from '../i18n/index.ts';
import { DATA_CHANGE_SEEN_KEY, dataChangeParams, dataChangeSeenKey, pendingDataChanges } from '../app/standardsUi.ts';

function readSeen(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(DATA_CHANGE_SEEN_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function writeSeen(keys: string[]): void {
  try {
    localStorage.setItem(DATA_CHANGE_SEEN_KEY, JSON.stringify([...new Set(keys)].slice(-200)));
  } catch {
    // storage unavailable (private window): the notice then shows again next time, which is harmless
  }
}

/**
 * One-time notice for intentional catalog value changes that alter a stored project's results (stream B data, stream E UI;
 * DECISIONS-v2-2 §I: XDU2300 datasheet values). Shown once per viewer and project: the first render records it as seen in
 * browser storage, and it stays on screen for this session until dismissed. Nothing is written to the project.
 */
export function DataChangeNotice() {
  const t = useT();
  const project = useApp((s) => s.project);
  const [shown, setShown] = useState<string[]>([]);
  useEffect(() => {
    const seen = readSeen();
    const pending = pendingDataChanges(project, seen);
    if (!pending.length) return;
    const keys = pending.map((c) => dataChangeSeenKey(project.id, c.id));
    setShown((s) => [...new Set([...s, ...keys])]);
    writeSeen([...seen, ...keys]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, project.equipment.length, project.cooling.cduCatalogId]);

  const changes = CATALOG_DATA_CHANGES.filter((c) => shown.includes(dataChangeSeenKey(project.id, c.id)));
  if (!changes.length) return null;
  return (
    <>
      {changes.map((c) => (
        <div key={c.id} className="card" style={{ marginBottom: 10, borderLeft: '3px solid var(--warning)' }} data-data-change-notice={c.id} role="status">
          <div className="row" style={{ gap: 8, alignItems: 'baseline' }}>
            <strong className="grow">{t('standards.ui.notice.title')}</strong>
            <span className="hint">{c.date}</span>
            <button className="btn ghost sm" data-data-change-dismiss onClick={() => setShown((s) => s.filter((k) => k !== dataChangeSeenKey(project.id, c.id)))}>{t('standards.ui.notice.dismiss')}</button>
          </div>
          <div style={{ marginTop: 4 }}>{t(c.messageKey, dataChangeParams(c))}</div>
          <a className="hint" href={c.sourceUrl} target="_blank" rel="noreferrer">{t('standards.ui.notice.source')}</a>
        </div>
      ))}
    </>
  );
}
