import { useApp } from '../store/appStore.ts';
import { fmt2, fmtDate, fmtDuration, fmtInt, fmtMoney, fmtPower, fmtPct } from '../app/format.ts';
import { itemOf } from '../app/derived.ts';
import { Meter, Section, Stat, StatusLabel } from '../ui/controls.tsx';
import { IssueFixes } from '../ui/IssueFixes.tsx';
import { Term } from '../ui/Term.tsx';
import { hasKey, useT } from '../i18n/index.ts';
import { openIpMap } from '../app/networkNav.ts';
// stream E (P5): one-time catalog data notice and standards parameter checks view
import { DataChangeNotice } from '../ui/DataChangeNotice.tsx';
import { StandardsChecksView } from '../ui/StandardsChecks.tsx';

export function OverviewPanel() {
  const project = useApp((s) => s.project);
  const analysis = useApp((s) => s.analysis);
  const analysisError = useApp((s) => s.analysisError);
  const setSelection = useApp((s) => s.setSelection);
  const setPage = useApp((s) => s.setPage);
  const t = useT();
  const uiLocale = useApp((s) => s.uiLocale);

  const counts = new Map<string, number>();
  project.equipment.forEach((e) => {
    const c = itemOf(e.catalogId)?.category ?? 'other';
    counts.set(c, (counts.get(c) ?? 0) + 1);
  });

  if (!analysis)
    return (
      <div>
        <p className="hint">{analysisError ? t('overview.engineError', { error: analysisError }) : t('overview.analyzing')}</p>
        <Section title={t('overview.composition')}>
          {[...counts].map(([k, v]) => (
            <div key={k} className="row"><span className="grow secondary">{hasKey(`layout.cat.${k}`) ? t(`layout.cat.${k}`) : k}</span><span>{v}</span></div>
          ))}
        </Section>
      </div>
    );

  const s = analysis.summary;
  const p = analysis.power;
  const train = analysis.workloads.find((w) => w.timeToTrainDays != null);
  const infer = analysis.workloads.find((w) => w.gpusRequired != null);
  const utilRatio = p.utilityAvailableMVA > 0 ? p.utilityRequiredMVA / p.utilityAvailableMVA : 0;

  return (
    <div>
      <DataChangeNotice />
      <div className="card" style={{ marginTop: 4 }}>
        <div className="secondary" style={{ fontSize: 12 }}>{t('overview.hero.totalGpus')}</div>
        <div className="hero">{fmtInt(s.gpus)}</div>
        <div className="muted" style={{ marginTop: 4 }}>
          {t('overview.hero.line', { gpuRacks: t('overview.hero.gpuRacks', { n: fmtInt(s.gpuRacks) }), racks: t('overview.hero.racks', { n: fmtInt(s.racks) }), halls: t('overview.hero.halls', { n: s.halls }), location: project.site.location })}
          {(s.acceleratorChips ?? 0) > 0 && t('overview.hero.accelerators', { n: fmtInt(s.acceleratorChips ?? 0) })}
        </div>
      </div>

      <div className="grid-3" style={{ marginTop: 10 }}>
        <Stat label={t('overview.stat.itLoad')} value={`${fmt2(s.itMW)} MW`} delta={t('overview.stat.facility', { v: fmt2(s.facilityMW) })} />
        <Stat label={<><Term id="pue">PUE</Term> {t('overview.stat.design')}</>} value={fmt2(s.pue)} delta={t('overview.stat.coolingPpue', { v: fmt2(analysis.cooling.partialPue) })} />
        <Stat label={<Term id="capex-opex">CAPEX</Term>} value={fmtMoney(s.capexUSD, project.pricing)} delta={t('overview.stat.perGpu', { v: fmtMoney(analysis.cost.usdPerGpu, project.pricing) })} />
        <Stat label={<Term id="rfs">{t('overview.stat.rfs')}</Term>} value={fmtDate(s.readyForService)} delta={t('overview.stat.start', { date: fmtDate(project.schedule.projectStart) })} />
        <Stat label={<Term id="capex-opex">{t('overview.stat.tco5y')}</Term>} value={fmtMoney(analysis.cost.tcoUSD5y, project.pricing)} delta={t('overview.stat.energy', { v: fmtInt(analysis.cost.energyMWhPerYear) })} />
        <Stat
          label={t('overview.stat.validation')}
          value={<span style={{ fontSize: 15 }}><StatusLabel severity={s.errors ? 'error' : s.warnings ? 'warning' : 'good'}>{s.errors ? t('overview.stat.errors', { n: s.errors }) : s.warnings ? t('overview.stat.warnings', { n: s.warnings }) : t('overview.stat.pass')}</StatusLabel></span>}
          delta={t('overview.stat.errWarn', { e: s.errors, w: s.warnings })}
        />
      </div>

      <Section title={t('ipmap.links.title')}>
        <div className="row wrap" style={{ gap: 8 }}>
          <button className="btn sm primary" data-ro-allow data-open-ipmap onClick={openIpMap}>{t('ipmap.links.open')}</button>
          <span className="hint">{t('ipmap.links.hint')}</span>
        </div>
      </Section>

      <Section title={<><Term id="n-1-feed">{t('overview.headroom.utility')}</Term> · <Term id="white-space">{t('overview.headroom.whiteSpace')}</Term> {t('overview.headroom.suffix')}</>}>
        <div className="card">
          <div className="row"><span className="grow"><Term id="n-1-feed">{t('overview.headroom.utilityCapacity')}</Term> {t('overview.headroom.reqAvail')}</span><span className="secondary nowrap">{fmt2(p.utilityRequiredMVA)} / {fmt2(p.utilityAvailableMVA)} MVA · {fmtPct(utilRatio)}</span></div>
          <Meter ratio={utilRatio} />
          {p.perHall.map((h) => {
            const hall = project.halls.find((x) => x.id === h.hallId);
            const sp = analysis.space.find((x) => x.hallId === h.hallId);
            return (
              <div key={h.hallId} style={{ marginTop: 10 }}>
                <div className="row">
                  <span className="grow">{hall?.name ?? h.hallId}</span>
                  <span className="secondary nowrap">{fmtPower(h.itKW)} / {fmtPower(h.budgetKW)} · {fmtPct(h.utilization)}</span>
                </div>
                <Meter ratio={h.utilization} />
                {sp && <div className="hint">{t('overview.headroom.hallSpace', { area: fmtInt(sp.areaM2), util: fmtPct(sp.whiteSpaceUtilization), density: fmt2(sp.itDensityKWPerM2), racks: sp.rackCount })}</div>}
              </div>
            );
          })}
        </div>
      </Section>

      <Section title={t('overview.issues.title')} actions={<button className="btn ghost sm" onClick={() => setPage('layout')}>{t('overview.issues.goLayout')}</button>}>
        <div className="card">
          {/* autosize v2 2차: issues with a one-click remedy first ("Fix all" for the safe ones), then the rest with the reason there is none */}
          <IssueFixes issues={analysis.issues} project={project} analysis={analysis} limit={8} onRefs={(ids) => setSelection(ids)} />
        </div>
      </Section>

      <Section title={t('standards.ui.checks.title')}>
        <div className="card"><StandardsChecksView /></div>
      </Section>

      <Section title={t('overview.workloads.title')}>
        <div className="grid-2">
          {train && (
            <Stat label={t('overview.workloads.training', { name: project.workloads.find((w) => w.id === train.workloadId)?.name ?? '' })} value={fmtDuration(train.timeToTrainDays, uiLocale)}
              delta={<>{fmtInt(train.tokensPerSec)} tok/s · <Term id="mfu">MFU</Term> {fmtPct(train.mfu)} · <Term id="goodput">goodput</Term> {fmtPct(train.goodput)}</>} />
          )}
          {infer && (
            <Stat label={t('overview.workloads.inference', { name: project.workloads.find((w) => w.id === infer.workloadId)?.name ?? '' })} value={t('overview.workloads.gpusRequired', { n: fmtInt(infer.gpusRequired) })}
              delta={<><Term id="ttft">TTFT</Term> {fmtInt(infer.ttftMs)} ms · <Term id="tpot">TPOT</Term> {fmtInt(infer.tpotMs)} ms</>} />
          )}
        </div>
      </Section>

      <Section title={t('overview.config.title')}>
        <div className="card">
          {[...counts].sort((a, b) => b[1] - a[1]).map(([k, v]) => (
            <div key={k} className="row" style={{ padding: '2px 0' }}>
              <span className="grow secondary">{hasKey(`layout.cat.${k}`) ? t(`layout.cat.${k}`) : k}</span>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>{v}</span>
            </div>
          ))}
          <div className="caption">{t('overview.config.caption', { switches: fmtInt(analysis.network.fabrics[0]?.totalSwitches), cables: fmtInt(analysis.network.cablesByType.reduce((a, c) => a + c.count, 0)), cdus: analysis.cooling.cdus.units, crahs: analysis.cooling.crahs.units })}</div>
        </div>
      </Section>
    </div>
  );
}
