import { useState } from 'react';
import { isDraftStatus, standardCitation, standardsCheckReport, type Project, type StandardsCheckDetail, type StandardsCheckReport } from '@aidc/core';
import { useApp } from '../store/appStore.ts';
import { useIssueText, useT } from '../i18n/index.ts';
import { groupStandardsIssues, severityCounts } from '../app/standardsUi.ts';
import { DataTable, Seg, StatusIcon } from './controls.tsx';

const num = (v: number | undefined, locale: string) => (v === undefined ? '—' : v.toLocaleString(locale === 'ko' ? 'ko-KR' : 'en-US', { maximumFractionDigits: 2 }));

/**
 * Standards parameter checks view (stream E / P5, proposal §6.1 "Checks view"): findings grouped by family with design value,
 * limit, cited document + version and a draft chip; the advisory / design-gate toggle (DO-3); on request the full report with
 * passed and not-modelled rows and the facility pre-check tables. Findings come from the live analysis; the full report runs
 * the checks once more on click (it re-evaluates the pipeline, so it is not on the render path).
 */
export function StandardsChecksView({ families, hallId }: { families?: StandardsCheckDetail['family'][]; hallId?: string }) {
  const t = useT();
  const { msg } = useIssueText();
  const project = useApp((s) => s.project);
  const analysis = useApp((s) => s.analysis);
  const update = useApp((s) => s.update);
  const setPage = useApp((s) => s.setPage);
  const locale = useApp((s) => s.uiLocale);
  const [full, setFull] = useState<{ project: Project; report: StandardsCheckReport } | null>(null);
  const [busy, setBusy] = useState(false);
  const p = project.standards;

  if (!p) {
    return (
      <div className="row wrap" style={{ gap: 8, alignItems: 'center' }} data-standards-checks="no-profile">
        <span className="hint grow">{t('standards.ui.checks.noProfile')}</span>
        <button className="btn ghost sm" onClick={() => setPage('site')}>{t('standards.ui.checks.goSite')}</button>
      </div>
    );
  }
  const groups = analysis ? groupStandardsIssues(analysis.issues, { families, hallId }) : [];
  const all = groups.flatMap((g) => g.issues);
  const c = severityCounts(all);
  const report = full && full.project === project ? full.report : null;
  const runFull = () => {
    setBusy(true);
    setTimeout(() => {
      try { setFull({ project, report: standardsCheckReport(project) }); } finally { setBusy(false); }
    }, 20);
  };
  const rows = report ? report.results.filter((r) => (!families || families.includes(r.family as StandardsCheckDetail['family'])) && (!hallId || !r.hallId || r.hallId === hallId)) : [];
  const facility = report && (!families || families.includes('facility')) ? report.facility.filter((f) => !hallId || f.hallId === hallId) : [];

  return (
    <div data-standards-checks={p.inferred ? 'inferred' : p.strictness}>
      <p className="hint" style={{ marginTop: 0 }}>{t('standards.ui.checks.hint')}</p>
      <div className="row wrap" style={{ gap: 8, alignItems: 'center', marginBottom: 6 }}>
        <Seg value={p.strictness} options={[{ value: 'advisory' as const, label: t('standards.strictness.advisory') }, { value: 'gate' as const, label: t('standards.strictness.gate') }]}
          onChange={(v) => update((d) => { if (d.standards) { d.standards.strictness = v; delete d.standards.inferred; } })} />
        <span className="hint grow" data-standards-counts>{t('standards.ui.checks.count', c)}</span>
        <button className="btn ghost sm" onClick={() => setPage('site')}>{t('standards.ui.checks.goSite')}</button>
      </div>
      {p.inferred && <p className="hint" style={{ margin: '0 0 6px', borderLeft: '3px solid var(--warning)', paddingLeft: 8 }}>{t('standards.ui.checks.inferred')}</p>}
      {!groups.length && <p className="hint">{t('standards.ui.checks.none')}</p>}
      {groups.map((g) => (
        <div key={g.family} style={{ marginBottom: 8 }} data-check-family={g.family}>
          <div className="secondary" style={{ fontSize: 12, margin: '6px 0 2px' }}>{t(`standards.family.${g.family}`)}</div>
          {g.issues.map((i) => {
            const ck = i.check!;
            return (
              <div key={i.id} className={`issue ${i.severity}`} data-check-rule={ck.ruleId}>
                <StatusIcon severity={i.severity} />
                <div style={{ minWidth: 0 }}>
                  <div className="row wrap" style={{ gap: 6, alignItems: 'baseline' }}>
                    <strong className="mono" style={{ fontSize: 12 }}>{ck.ruleId}</strong>
                    {ck.specStatus && isDraftStatus(ck.specStatus) && <span className="badge warn" title={t('standards.chip.draftTip')}>{t('standards.chip.draft')}</span>}
                    {(ck.verification === 'estimate' || ck.verification === 'unverified') && <span className="badge">{t(`standards.chip.${ck.verification}`)}</span>}
                  </div>
                  <div className="msg">{msg(i)}</div>
                  <div className="hint" style={{ marginTop: 2 }}>
                    {ck.designValue !== undefined && <>{t('standards.ui.checks.col.design')} {num(ck.designValue, locale)}{ck.unit ? ` ${ck.unit}` : ''} · </>}
                    {ck.limit !== undefined && <>{t('standards.ui.checks.col.limit')} {num(ck.limit, locale)}{ck.unit ? ` ${ck.unit}` : ''} · </>}
                    {t('standards.ui.checks.col.basis')}: {ck.standardId ? standardCitation(ck.standardId) : t(`standards.basis.${ck.basis}`)}
                    {ck.naturalSeverity !== i.severity && <> · {t('standards.ui.checks.capped', { severity: t(`ui.severity.${ck.naturalSeverity}`) })}</>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ))}
      {!report && (
        <button className="btn sm" disabled={busy} onClick={runFull} data-standards-full>{busy ? t('standards.ui.checks.running') : t('standards.ui.checks.runFull')}</button>
      )}
      {report && (
        <div data-standards-full-report>
          <div className="hint" style={{ margin: '6px 0' }}>{t('standards.ui.checks.full', { pass: rows.filter((r) => r.status === 'pass').length, nm: rows.filter((r) => r.status === 'not-modelled').length, f: rows.filter((r) => r.status === 'finding').length })}</div>
          <DataTable
            columns={[
              { key: 'r', header: t('standards.ui.checks.col.rule'), render: (r: (typeof rows)[number]) => <span className="mono">{r.ruleId}</span>, sortValue: (r) => r.ruleId },
              { key: 's', header: t('standards.ui.col.status'), render: (r) => <span className={`badge ${r.status === 'finding' ? 'warn' : ''}`}>{t(`standards.checkStatus.${r.status}`)}</span>, sortValue: (r) => r.status },
              { key: 'm', header: t('standards.ui.checks.col.finding'), render: (r) => <span style={{ whiteSpace: 'normal' }}>{locale === 'ko' ? r.message : r.messageEn}</span> },
              { key: 'b', header: t('standards.ui.checks.col.basis'), render: (r) => <span style={{ whiteSpace: 'normal' }}>{r.standardId ? standardCitation(r.standardId) : t(`standards.basis.${r.basis}`)}</span> },
            ]}
            rows={rows}
            rowKey={(r) => r.id}
            maxHeight={320}
          />
          {facility.map((f) => (
            <div key={f.hallId} style={{ marginTop: 10 }} data-facility-precheck={f.hallId}>
              <div className="secondary" style={{ fontSize: 12, marginBottom: 4 }}>{t('standards.ui.checks.facility', { hall: project.halls.find((h) => h.id === f.hallId)?.name ?? f.hallId })} · {f.citation}</div>
              <DataTable
                columns={[
                  { key: 'ref', header: t('standards.ui.checks.col.ref'), render: (r: (typeof f.rows)[number]) => r.ref },
                  { key: 'a', header: t('standards.ui.checks.col.attribute'), render: (r) => <span style={{ whiteSpace: 'normal' }}>{locale === 'ko' ? r.attributeKo : r.attributeEn}</span> },
                  { key: 'd', header: t('standards.ui.checks.col.design'), render: (r) => (r.designValue !== undefined ? `${typeof r.designValue === 'number' ? num(r.designValue, locale) : r.designValue}${r.unit ? ` ${r.unit}` : ''}` : '—') },
                  { key: 'l', header: t('standards.ui.checks.col.result'), render: (r) => <span className={`badge ${r.level === 'exception' ? 'warn' : ''}`}>{t(`standards.facilityLevel.${r.level}`)}</span> },
                  { key: 't', header: t('standards.ui.checks.col.threshold'), render: (r) => <span style={{ whiteSpace: 'normal' }}>{r.thresholdEn ?? '—'}</span> },
                ]}
                rows={f.rows}
                rowKey={(r) => `${r.ruleId}-${r.key}`}
                maxHeight={320}
              />
              <p className="hint" style={{ margin: '4px 0 0' }}>{locale === 'ko' ? f.summaryKo : f.summaryEn}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
