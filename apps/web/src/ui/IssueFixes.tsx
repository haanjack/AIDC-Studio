import { useMemo, useState } from 'react';
import { applyRemedy, fixAllRemedies, findCatalogItem, issueHallId, issueRemedies, issueRemedy, noRemedyReason, SIZING_ISSUE_RE, type AutoSizeReport, type Issue, type IssueRemedy, type Project, type ProjectAnalysis } from '@aidc/core';
import { useApp } from '../store/appStore.ts';
import { useIssueText, useT } from '../i18n/index.ts';
import { fmt1, fmtInt } from '../app/format.ts';
import { StatusIcon, StatusLabel } from './controls.tsx';

/** Layout panel card after "Generate": what the engine-verified generation placed / raised, then this hall's live issues with fixes. */
export function GenerationReportCard({ report, hallId }: { report: AutoSizeReport; hallId: string }) {
  const t = useT();
  const project = useApp((s) => s.project);
  const analysis = useApp((s) => s.analysis);
  const setSelection = useApp((s) => s.setSelection);
  const hall = project.halls.find((h) => h.id === hallId);
  const issues = useMemo(
    () => (analysis ? analysis.issues.filter((i) => i.severity !== 'info' && (issueHallId(project, i) === hallId || (!issueHallId(project, i) && SIZING_ISSUE_RE.test(i.id)))) : []),
    [analysis, project, hallId],
  );
  const b = report.budgets;
  const raised = b.it.after !== b.it.before || b.liquid.after !== b.liquid.before || b.air.after !== b.air.before;
  const hallNames = (ids: string[]) => ids.map((id) => project.halls.find((h) => h.id === id)?.name ?? id).join(', ');
  return (
    <div className="card" style={{ marginTop: 8, wordBreak: 'keep-all', overflowWrap: 'anywhere' }} data-generation-report>
      <strong>{t('autosize.report.title', { hall: hall?.name ?? hallId })}</strong>
      <div className="hint" style={{ marginTop: 4 }}>
        {t('autosize.report.counts', { pods: report.pods, cduPlaced: report.cdus.placed, cduRequired: report.cdus.required, crahPlaced: report.crahs.placed, crahRequired: report.crahs.required, net: report.networkRacks, w: fmt1(report.hall.width), d: fmt1(report.hall.depth) })}
      </div>
      {(report.hall.beforeWidth !== report.hall.width || report.hall.beforeDepth !== report.hall.depth) && (
        <div className="hint" data-hall-envelope-change>{t('autosize.report.envelope', { mode: t(`autosize.report.envelope.${report.hall.mode}`), w0: fmt1(report.hall.beforeWidth), d0: fmt1(report.hall.beforeDepth), w1: fmt1(report.hall.width), d1: fmt1(report.hall.depth) })}</div>
      )}
      {report.corrections.length > 0 && <div className="hint">{t('autosize.report.corrected', { what: [...new Set(report.corrections)].map((c) => t(`autosize.report.correction.${c}`)).join(', ') })}</div>}
      {b.mode === 'fit' && raised && (
        <div className="hint" data-budgets-raised>{t('autosize.report.budgetsRaised', { it0: fmtInt(b.it.before), it1: fmtInt(b.it.after), l0: fmtInt(b.liquid.before), l1: fmtInt(b.liquid.after), a0: fmtInt(b.air.before), a1: fmtInt(b.air.after) })}</div>
      )}
      {b.mode === 'hold' && <div className="hint">{t('autosize.report.budgetsHeld', { it: fmtInt(b.it.after), l: fmtInt(b.liquid.after), a: fmtInt(b.air.after) })}</div>}
      {b.utility && <div className="hint">{t('autosize.report.utilityRaised', { from: fmt1(b.utility.beforeMVA), to: fmt1(b.utility.afterMVA), req: fmt1(b.utility.requiredMVA) })}</div>}
      {report.switchKept && <div className="hint" data-switch-kept>{t('autosize.report.switchKept', { kept: findCatalogItem(report.switchKept.kept)?.name ?? report.switchKept.kept, halls: hallNames(report.switchKept.halls) })}</div>}
      <div style={{ marginTop: 6 }}>
        {!analysis || issues.length === 0 ? (
          <StatusLabel severity="good">{t('autosize.report.clean')}</StatusLabel>
        ) : (
          <>
            <div className="hint">{t('autosize.report.remaining', { n: issues.length })}</div>
            <IssueFixes issues={issues} project={project} analysis={analysis} hallId={hallId} onRefs={(ids) => setSelection(ids)} />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Issue list with one-click fixes (autosize v2 2차, DECISIONS-v2-2 §F): issues that have a deterministic engine remedy
 * (layout/remedies.ts) are listed first with "Auto-fix"; "Fix all" applies the safe ones in one undoable step. Issues without a
 * remedy say why. Used at the top of the Overview issues and in the Layout panel after generation.
 */

/** Replace a store draft's content with another project (top-level keys the new project lacks are removed). */
export function replaceProject(draft: Project, next: Project): void {
  const d = draft as unknown as Record<string, unknown>;
  for (const k of Object.keys(d)) if (!(k in next)) delete d[k];
  Object.assign(draft, structuredClone(next));
}

const SEV: Record<Issue['severity'], number> = { error: 0, warning: 1, info: 2 };
const fmtParam = (v: string | number) => (typeof v === 'number' ? v.toLocaleString('en-US') : v);

export function IssueFixes({ issues, project, analysis, limit, onRefs, hallId, showOther = true }: {
  issues: Issue[];
  project: Project;
  analysis: ProjectAnalysis;
  limit?: number;
  onRefs?: (ids: string[]) => void;
  /** restrict "Fix all" to remedies of this hall */
  hallId?: string;
  /** list the issues without a remedy below (with the reason) */
  showOther?: boolean;
}) {
  const t = useT();
  const { msg, sug } = useIssueText();
  const update = useApp((s) => s.update);
  const notify = useApp((s) => s.notify);
  const [busy, setBusy] = useState<string | null>(null);
  // backlog T1a: per-issue alternatives (hall shift / reshape / fan wall) are computed on request — the reshape probe generates layouts
  // integrator: the cache belongs to the project it was computed for, so an edit / undo never offers a stale shift or reshape
  const [altCache, setAltCache] = useState<{ project: Project; byIssue: Record<string, IssueRemedy[]> }>({ project, byIssue: {} });
  const alts = altCache.project === project ? altCache.byIssue : {};
  const setAlts = (f: (m: Record<string, IssueRemedy[]>) => Record<string, IssueRemedy[]>) => setAltCache((c) => ({ project, byIssue: f(c.project === project ? c.byIssue : {}) }));
  const ALT_RE = /^(power-elec-room-wall-|site-hall-overlap-)/;
  const ALT_KINDS: IssueRemedy['kind'][] = ['shift-hall', 'reshape-hall', 'fan-wall'];
  const rows = useMemo(() => {
    const sorted = [...issues].sort((a, b) => SEV[a.severity] - SEV[b.severity]);
    return sorted.map((i) => ({ issue: i, remedy: issueRemedy(project, analysis, i) }));
  }, [issues, project, analysis]);
  const fixable = rows.filter((r) => r.remedy);
  const other = rows.filter((r) => !r.remedy);
  const safeKeys = new Set(fixable.filter((r) => r.remedy!.safe).map((r) => r.remedy!.key));
  const label = (r: IssueRemedy) => t(`autosize.remedy.${r.kind}`, Object.fromEntries(Object.entries(r.params).map(([k, v]) => [k, fmtParam(v)])));

  const run = (key: string, fn: () => Project | null, n = 1) => {
    setBusy(key);
    // let the busy state paint before the synchronous engine work
    setTimeout(() => {
      try {
        const next = fn();
        if (!next || next === project) notify(t(next === null ? 'autosize.nothing' : 'autosize.unchanged'), 'info');
        else if (update((d) => replaceProject(d, next))) notify(t('autosize.applied', { n }), 'ok');
      } finally {
        setBusy(null);
      }
    }, 20);
  };
  const fixOne = (r: IssueRemedy) => run(r.issueId, () => applyRemedy(project, r));
  const fixAll = () => {
    let applied = 0;
    run('all', () => {
      const res = fixAllRemedies(project, { analysis, filter: (r) => r.safe && (!hallId || r.hallId === hallId) });
      applied = res.applied.length;
      return res.applied.length ? res.project : null;
    }, Math.max(1, safeKeys.size));
    void applied;
  };

  const row = (i: Issue, r: IssueRemedy | undefined) => (
    <div key={i.id} className={`issue ${i.severity}`} data-issue-id={i.id} data-remedy={r?.kind ?? ''}>
      <StatusIcon severity={i.severity} />
      <div style={{ minWidth: 0 }}>
        <div className="msg">{msg(i)}</div>
        {r ? (
          <div className="row wrap" style={{ gap: 8, marginTop: 4, alignItems: 'center' }}>
            <button className="btn sm primary" disabled={busy !== null} onClick={() => fixOne(r)} data-fix-issue={i.id}>
              {busy === i.id ? t('autosize.fixing') : t('autosize.fix')}
            </button>
            <span className="sug" style={{ margin: 0 }}>{label(r)}</span>
            {!r.safe && <span className="badge" title={t(`autosize.why.${r.kind}`)}>{t('autosize.reviewBadge')}</span>}
          </div>
        ) : (
          <>
            {sug(i) && <div className="sug">→ {sug(i)}</div>}
            <div className="hint" style={{ marginTop: 2 }}>{t(`autosize.noFix.${noRemedyReason(project, i)}`)}</div>
          </>
        )}
        {r && !r.safe && <div className="hint" style={{ marginTop: 2 }}>{t(`autosize.why.${r.kind}`)}</div>}
        {ALT_RE.test(i.id) && !alts[i.id] && (
          <button className="btn ghost sm" style={{ paddingLeft: 0 }} disabled={busy !== null} data-alt-open={i.id}
            onClick={() => { setBusy(`alt|${i.id}`); setTimeout(() => { try { setAlts((m) => ({ ...m, [i.id]: issueRemedies(project, analysis, i).filter((x) => ALT_KINDS.includes(x.kind)) })); } finally { setBusy(null); } }, 20); }}>
            {busy === `alt|${i.id}` ? t('autosize.fixing') : t('autosize.moreFixes')}
          </button>
        )}
        {alts[i.id]?.length === 0 && <div className="hint" style={{ marginTop: 2 }}>{t('autosize.noMoreFixes')}</div>}
        {(alts[i.id] ?? []).map((x) => (
          <div key={x.key} className="row wrap" style={{ gap: 8, marginTop: 4, alignItems: 'center' }} data-alt-remedy={x.kind}>
            <button className="btn sm" disabled={busy !== null} onClick={() => fixOne(x)} data-fix-alt={x.kind}>{busy === x.issueId ? t('autosize.fixing') : t('autosize.fix')}</button>
            <span className="sug" style={{ margin: 0 }}>{label(x)}</span>
            <span className="badge" title={t(`autosize.why.${x.kind}`)}>{t('autosize.reviewBadge')}</span>
          </div>
        ))}
        {onRefs && i.refs && i.refs.length > 0 && (
          <button className="btn ghost sm" style={{ paddingLeft: 0 }} onClick={() => onRefs(i.refs!)}>{t('ui.issue.selectRefs', { n: i.refs.length })}</button>
        )}
      </div>
    </div>
  );

  if (!issues.length) return <div className="hint" data-issue-fixes>{t('autosize.none')}</div>;
  const shownOther = limit ? other.slice(0, Math.max(0, limit - Math.min(limit, fixable.length))) : other;
  return (
    <div data-issue-fixes style={{ wordBreak: 'keep-all', overflowWrap: 'anywhere' }}>
      {fixable.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <div className="row" style={{ alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <strong className="grow">{t('autosize.fixable.title', { n: fixable.length })}</strong>
            {safeKeys.size > 0 && (
              <button className="btn sm primary" disabled={busy !== null} onClick={fixAll} title={t('autosize.fixAllHint')} data-fix-all>
                {busy === 'all' ? t('autosize.fixing') : t('autosize.fixAll', { n: fixable.filter((r) => r.remedy!.safe).length })}
              </button>
            )}
          </div>
          {fixable.map((r) => row(r.issue, r.remedy))}
        </div>
      )}
      {showOther && other.length > 0 && (
        <div>
          {fixable.length > 0 && <strong style={{ display: 'block', margin: '8px 0 4px' }}>{t('autosize.other.title', { n: other.length })}</strong>}
          {shownOther.map((r) => row(r.issue, undefined))}
          {shownOther.length < other.length && <div className="hint">{t('autosize.more', { n: other.length - shownOther.length })}</div>}
        </div>
      )}
    </div>
  );
}
