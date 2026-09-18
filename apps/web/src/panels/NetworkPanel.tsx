import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import {
  AGGREGATE_TRAFFIC_ID, ETA_DEFAULT, LB_LABEL, OVERLAP_FRAMEWORKS, buildCableSchedule, buildIpReview, buildSwitchUnits, cableTypes, calibrateEta, compareFabrics, etaFor, findCatalogItem,
  joinHalls, mediumOf, nominalBusbwGBps, nominalInputsFor, normalizeLeafPlacement, normalizeSpinePlacement, parseCollectiveLog, projectEtaSensitivity, resolveClusters, splitCluster, summarizeCableSchedule,
  type AuxNetwork, type CableScheduleRow, type CatalogItem, type ClusterDef, type ClusterNetworkSummary, type EtaCalibration, type FabricAnalysis, type FabricTech, type LoadBalancing,
  filterIpReview, groupIpPlanByLocation, groupIpPlanByRail, groupIpPlanBySubnet, ipReviewCsv, ipReviewGroupEntries, prefixOf, rangeLabel,
  type IpPlan, type IpReviewDeviceType, type IpReviewEntry, type IpReviewFilter, type IpReviewGroup, type IpReviewNet,
  type NetworkDesign, type OverlapFramework, type PlacementCandidate, type ScaleOutNetwork, type SpinePlacement, type TrafficReport,
} from '@aidc/core';
import { projectGrowth, useApp } from '../store/appStore.ts';
import { AUX_FABRICS, FABRIC_SWITCH, SCALE_OUT_FABRICS, switchOptionsFor } from '../app/derived.ts';
import { fmt1, fmt2, fmtDuration, fmtInt, fmtMoney, fmtPct, fmtPower } from '../app/format.ts';
import { useT } from '../i18n/index.ts';
import { BarChart, LineChart } from '../ui/charts.tsx';
import { DataTable, Empty, Meter, NumberField, Section, Seg, SelectField, Stat, StatusLabel, Toggle } from '../ui/controls.tsx';
import { FabricTopology, TrafficBottleneckMap } from '../ui/diagrams.tsx';
import { Term } from '../ui/Term.tsx';
import { IpMapView } from '../ui/IpMap.tsx';
import { useNetworkNav, type NetworkTabId } from '../app/networkNav.ts';
import { downloadText } from '../app/api.ts';

type Tab = NetworkTabId;
type TrainingGroup = 'tp' | 'cp' | 'pp' | 'dp' | 'ep';
type Group = TrainingGroup | 'pd';
const LB_CLASSES: LoadBalancing[] = ['ecmp', 'qp-scaling', 'te', 'adaptive', 'ddc'];
const PLACEMENTS: SpinePlacement[] = ['central-end', 'central-center', 'distributed', 'separate-room'];
const TRAINING_GROUPS: TrainingGroup[] = ['tp', 'cp', 'pp', 'dp', 'ep'];
const INFERENCE_GROUPS: Group[] = ['tp', 'cp', 'pp', 'ep', 'pd'];
const ALL_TRAFFIC_GROUPS: Group[] = ['tp', 'cp', 'pp', 'dp', 'ep', 'pd'];
const TRAFFIC_TRACE_RATE_KEY = { 'scale-up': 'scaleUpGBps', leaf: 'leafGBps', spine: 'spineGBps', core: 'coreGBps' } as const;
const ROW_LIMIT = 200;
const META_BLOG = 'https://engineering.fb.com/2024/03/12/data-center-engineering/building-metas-genai-infrastructure/';

/** Badge colour per evidence class (theme.css src-* palette). */
const BADGE_CLASS: Record<string, string> = {
  'measured-paper': 'src-public-spec',
  'vendor-claim': 'src-vendor-datasheet',
  'acceptance-threshold': 'src-public-spec',
  standard: 'src-public-spec',
  'official-config': 'src-public-spec',
  derived: 'src-announced',
  estimate: 'src-estimate',
  nominal: 'src-estimate',
  'user-measured': 'src-user',
  user: 'src-user',
};

function EvidenceBadge({ type, title }: { type?: string; title?: string }) {
  const t = useT();
  if (!type) return null;
  return <span className={`badge ${BADGE_CLASS[type] ?? ''}`} title={title}>{t(`network.src.${type}`)}</span>;
}

const monoArea: React.CSSProperties = { width: '100%', minHeight: 110, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11, background: 'var(--surface-1)', color: 'inherit', border: '1px solid var(--surface-3)', borderRadius: 4, padding: 6, boxSizing: 'border-box' };
const codeBlock: React.CSSProperties = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11, background: 'var(--surface-1)', border: '1px solid var(--surface-3)', borderRadius: 4, padding: 8, overflowX: 'auto', whiteSpace: 'pre' };

const today = () => new Date().toISOString().slice(0, 10);
const gib = (b: number) => (b >= 2 ** 30 ? `${+(b / 2 ** 30).toFixed(2)} GiB` : `${+(b / 2 ** 20).toFixed(0)} MiB`);

export function NetworkPanel() {
  const t = useT();
  const project = useApp((s) => s.project);
  const analysis = useApp((s) => s.analysis);
  const update = useApp((s) => s.update);
  const overlays = useApp((s) => s.overlays);
  const setOverlays = useApp((s) => s.setOverlays);
  const net = project.network;
  const so = net.scaleOut;
  // tab lives in app/networkNav.ts so the Overview shortcut can open Network › IP map
  const tab = useNetworkNav((s) => s.tab);
  const setTab = useNetworkNav((s) => s.setTab);
  const [compareSet, setCompareSet] = useState<FabricTech[]>(['ib-xdr-800', 'ib-ndr-400', 'spectrumx-800', 'roce-generic-400']);
  const [fill, setFill] = useState<0.5 | 0.4>(0.5);

  const setSO = (patch: Partial<ScaleOutNetwork>) => update((d) => { Object.assign(d.network.scaleOut, patch); });
  const setAux = (k: 'frontend' | 'storage' | 'oob', patch: Partial<AuxNetwork>) => update((d) => { Object.assign(d.network[k], patch); });
  const setCab = (patch: Partial<NetworkDesign['cabling']>) => update((d) => { Object.assign(d.network.cabling, patch); });

  const TABS: { value: Tab; label: string }[] = [
    { value: 'fabric', label: t('network.tab.fabric') },
    { value: 'clusters', label: t('network.tab.clusters') },
    { value: 'placement', label: t('network.tab.placement') },
    { value: 'traffic', label: t('network.tab.traffic') },
    { value: 'schedule', label: t('network.tab.schedule') },
    { value: 'ip', label: t('network.tab.ip') },
  ];
  const lbOptions = LB_CLASSES.map((v) => ({ value: v, label: `${LB_LABEL[v]} (η ${ETA_DEFAULT[v].nominalValue ?? ETA_DEFAULT[v].value}${ETA_DEFAULT[v].nominalValue ? ` · ${t('network.src.nominal')}` : ''})` }));

  const na = analysis?.network;
  const traffic = na?.traffic;
  const tierLabel = (tier: TrafficReport['perTier'][number]['tier']) => tier === 'scale-up' && traffic?.physical?.scaleUpName
    ? t('network.tier.scale-upNamed', { name: traffic.physical.scaleUpName })
    : t(`network.tier.${tier}`);
  const trafficWorkload = traffic ? project.workloads.find((w) => w.id === traffic.workloadId) : undefined;
  const trafficScenarios = project.workloads.filter((w) => w.training || w.inference);
  const selectedTrafficIsAggregate = net.trafficWorkloadId === AGGREGATE_TRAFFIC_ID
    || (!net.trafficWorkloadId && trafficScenarios.length > 1);
  const selectedTrafficWorkload = selectedTrafficIsAggregate ? undefined : trafficScenarios.find((w) => w.id === net.trafficWorkloadId)
    ?? trafficWorkload
    ?? trafficScenarios.find((w) => w.training)
    ?? trafficScenarios[0];
  const selectedTrafficIsInference = !selectedTrafficIsAggregate && !!selectedTrafficWorkload?.inference;
  const trafficGroups = traffic?.mode === 'aggregate' ? ALL_TRAFFIC_GROUPS : traffic?.mode === 'inference' ? INFERENCE_GROUPS : TRAINING_GROUPS;
  const trafficRateMode = traffic?.mode === 'inference' || traffic?.mode === 'aggregate';
  const trafficDisplayName = traffic?.mode === 'aggregate'
    ? t('network.traffic.scenarioAggregate')
    : trafficWorkload?.name ?? traffic?.workloadId ?? t('network.traffic.pathUnknownWorkload');
  const trafficBottleneck = traffic?.perTier.reduce((worst, tier) => !worst || tier.utilization > worst.utilization ? tier : worst, undefined as TrafficReport['perTier'][number] | undefined);
  const placement = na?.placement;
  const growth = projectGrowth(project);
  const spineNow = normalizeSpinePlacement(so.spinePlacement);
  const eta = etaFor(so);
  const comparison = useMemo(() => {
    if (tab !== 'fabric') return [];
    try {
      return compareFabrics(project, compareSet);
    } catch {
      return [];
    }
  }, [project, compareSet, tab]);

  const cableRows = (na?.cablesByType ?? []).map((c) => {
    const ct = cableTypes().find((x) => x.id === c.cableTypeId);
    const price = project.pricing.cableOverrides[c.cableTypeId];
    const cost = ct ? c.count * (price ?? ct.cableUSD) + c.totalLengthM * ct.cableUSDPerM + c.transceivers * ct.transceiverUSD : 0;
    return { ...c, name: ct?.name ?? c.cableTypeId, cost };
  });

  // comparator rows at the selected tray fill (trayPeakMm2 = cable area ÷ fill, so re-scaling is exact)
  const candidates: PlacementCandidate[] = useMemo(() => {
    if (!placement) return [];
    const base = placement.fillRatio ?? 0.5;
    const order = new Map(PLACEMENTS.map((p, i) => [p, i]));
    return [...placement.candidates].sort((a, b) => (order.get(a.spinePlacement) ?? 9) - (order.get(b.spinePlacement) ?? 9)).map((c) => ({ ...c, trayPeakMm2: (c.trayPeakMm2 * base) / fill }));
  }, [placement, fill]);
  const growthNote = growth === 'phased' ? t('network.fabric.growthPhased') : t('network.fabric.growthSingle');

  return (
    <div>
      <style>{NET_PANEL_CSS}</style>
      <div className="row wrap" style={{ marginBottom: 10, gap: 8 }}>
        <div style={{ flex: '1 1 100%', minWidth: 0 }} data-network-tabs><Seg wrap value={tab} options={TABS} onChange={setTab} /></div>
        <span className="grow" />
        {traffic && <span className="pill"><span className="dot" />{t('network.pill.commEff', { v: fmtPct(traffic.commEfficiencyEffective) })}</span>}
        {placement?.recommended && <span className={`pill ${placement.recommended === spineNow ? 'good' : 'warn'}`}><span className="dot" />{t('network.pill.recommendedSpine', { v: t(`network.spinePlacement.${placement.recommended}`) })}</span>}
      </div>

      {tab === 'fabric' && (
        <>
          <Section title={t('network.fabric.scaleOut')}>
            <div className="fields-2">
              <div>
                <SelectField label={t('network.fabric.fabric')} value={so.fabric} options={SCALE_OUT_FABRICS.map((f) => ({ value: f, label: t(`network.fabricName.${f}`) }))} onChange={(v) => setSO({ fabric: v, switchCatalogId: FABRIC_SWITCH[v], loadBalancing: undefined })} />
                <SelectField label={t('network.fabric.switch')} value={so.switchCatalogId} options={switchOptionsFor(so.fabric)} onChange={(v) => setSO({ switchCatalogId: v })} />
                <SelectField label={<Term id="rail-optimized">{t('network.fabric.topology')}</Term>} value={so.topology} options={[{ value: 'rail-optimized', label: 'Rail-optimized' }, { value: 'fat-tree', label: 'Fat-tree' }, { value: 'leaf-spine', label: 'Leaf-spine' }]} onChange={(v) => setSO({ topology: v })} />
                <SelectField label={<Term id="ecmp">{t('network.fabric.lb')}</Term>} value={eta.class} options={lbOptions} onChange={(v) => setSO({ loadBalancing: v })} hint={t('network.fabric.lbHint')} />
              </div>
              <div>
                <SelectField label={<Term id="tiers">{t('network.fabric.tiers')}</Term>} value={String(so.tiers)} options={[{ value: 'auto', label: t('network.common.auto') }, { value: '2', label: '2-tier' }, { value: '3', label: '3-tier' }]} onChange={(v) => setSO({ tiers: v === 'auto' ? 'auto' : (Number(v) as 2 | 3) })} />
                <NumberField label={<Term id="oversubscription">{t('network.fabric.oversub')}</Term>} unit=": 1" step={0.5} min={1} value={so.oversubscription} onChange={(v) => setSO({ oversubscription: v })} hint={traffic ? t('network.fabric.oversubHint', { n: traffic.minOversubscription }) : undefined} />
                <SelectField label={t('network.fabric.leafPlacement')} value={normalizeLeafPlacement(so.leafPlacement)} options={[{ value: 'end-of-row', label: 'End-of-row' }, { value: 'mid-row', label: 'Mid-row' }, { value: 'tor', label: t('network.fabric.leafTor') }]} onChange={(v) => setSO({ leafPlacement: v })} />
                <SelectField label={<Term id="spine-placement">{t('network.fabric.spinePlacement')}</Term>} value={spineNow} options={PLACEMENTS.map((p) => ({ value: p, label: t(`network.spinePlacement.${p}`) }))} onChange={(v) => setSO({ spinePlacement: v, separateRoom: v === 'separate-room' })} hint={growthNote} />
              </div>
            </div>
            <p className="hint" style={{ marginTop: 4 }}>{t('network.fabric.growthHint', { note: growthNote })}</p>
            <p className="caption" style={{ margin: '3px 0 0' }}>{t(so.fabric.startsWith('ib-') ? 'network.fabric.switchCompatibilityIb' : 'network.fabric.switchCompatibilityEthernet')}</p>
          </Section>

          <Section title={t('network.aux.title')}>
            {(['frontend', 'storage', 'oob'] as const).map((k) => (
              <div key={k} className="row" style={{ padding: '3px 0' }}>
                <div style={{ width: 110 }}><Toggle label={t(`network.aux.${k}`)} checked={net[k].enabled} onChange={(v) => setAux(k, { enabled: v })} /></div>
                <div className="grow"><SelectField label="" value={net[k].fabric} options={AUX_FABRICS.map((f) => ({ value: f, label: t(`network.fabricName.${f}`) }))} onChange={(v) => setAux(k, { fabric: v, switchCatalogId: FABRIC_SWITCH[v] })} /></div>
                <div style={{ width: 90 }} className="field"><label><Term id="oversubscription">{t('network.aux.oversubShort')}</Term></label><input type="number" min={1} step={0.5} defaultValue={net[k].oversubscription} title={t('network.fabric.oversub')} onBlur={(e) => setAux(k, { oversubscription: Number(e.target.value) })} /></div>
              </div>
            ))}
          </Section>

          <Section title={t('network.cabling.title')}>
            <div className="fields-2">
              <div>
                <NumberField label={t('network.cabling.maxCopper')} unit="m" step={0.5} value={net.cabling.maxCopperM} onChange={(v) => setCab({ maxCopperM: v })} />
                <NumberField label={t('network.cabling.routeFactor')} step={0.05} value={net.cabling.routeFactor} onChange={(v) => setCab({ routeFactor: v })} hint={t('network.cabling.routeFactorHint')} />
              </div>
              <div>
                <NumberField label={t('network.cabling.slack')} unit="m" step={0.5} value={net.cabling.slackPerEndM} onChange={(v) => setCab({ slackPerEndM: v })} />
                <div className="row wrap" style={{ gap: 12, paddingTop: 6 }}>
                  <Toggle label={t('network.cabling.allowActive')} checked={net.cabling.allowActiveCopper} onChange={(v) => setCab({ allowActiveCopper: v })} />
                  <Toggle label={t('network.cabling.preferSmf')} checked={net.cabling.preferSingleMode} onChange={(v) => setCab({ preferSingleMode: v })} />
                </div>
              </div>
            </div>
            <div className="row" style={{ marginTop: 6 }}>
              <Toggle label={t('network.cabling.showOverlay')} checked={overlays.cables} onChange={(v) => setOverlays({ cables: v })} />
              <span className="hint">{project.trays?.length ? t('network.cabling.lengthTrays', { n: project.trays.length }) : t('network.cabling.lengthManhattan')}</span>
            </div>
          </Section>

          {!na ? (
            <Empty>{t('network.common.noAnalysis')}</Empty>
          ) : (
            <>
              <Section title={t('network.analysis.title')}>
                <div className="grid-3">
                  <Stat label={t('network.analysis.capex')} value={fmtMoney(na.costUSD, project.pricing)} delta={t('network.analysis.xcvr', { p: fmtPower(na.transceiverKW) })} />
                  <Stat label={t('network.analysis.commEff')} value={fmtPct(traffic?.commEfficiencyEffective ?? na.commEfficiency)} delta={traffic ? t('network.analysis.commEffWorkload', { eta: eta.value, scalar: fmtPct(na.commEfficiency) }) : t('network.analysis.commEffBaseline')} />
                  <Stat label={t('network.analysis.cables')} value={fmtInt(na.cablesByType.reduce((a, c) => a + c.count, 0))} delta={`${fmtInt(na.cablesByType.reduce((a, c) => a + c.totalLengthM, 0) / 1000)} km`} />
                </div>
                <div style={{ marginTop: 10 }}>
                  <DataTable
                    columns={[
                      { key: 'n', header: t('network.col.fabric'), render: (f: FabricAnalysis) => <span>{f.name}{f.extrapolated && <span className="badge src-estimate" title={t('network.badge.extrapolatedTitle')}> {t('network.badge.extrapolated')}</span>}{f.feasible === false && <StatusLabel severity="error">{t('network.badge.infeasible')}</StatusLabel>}</span> },
                      { key: 'e', header: t('network.col.endpoints'), num: true, render: (f) => fmtInt(f.endpoints) },
                      { key: 't', header: t('network.col.tiers'), render: (f) => f.tiers.map((x) => `${x.name} ${x.switches}`).join(' / ') },
                      { key: 's', header: t('network.col.switches'), num: true, render: (f) => fmtInt(f.totalSwitches) },
                      { key: 'b', header: t('network.col.bisection'), num: true, render: (f) => `${fmt1(f.bisectionGbps / 1000)} Tbps` },
                      { key: 'h', header: t('network.col.hops'), num: true, render: (f) => f.maxHops },
                      { key: 'p', header: t('network.col.power'), num: true, render: (f) => fmtPower(f.powerKW) },
                      { key: 'r', header: t('network.col.racks'), num: true, render: (f) => f.racksNeeded },
                    ]}
                    rows={na.fabrics}
                    rowKey={(f) => f.name}
                  />
                </div>
                {na.fabrics[0] && (
                  <div className="card" style={{ marginTop: 10 }}>
                    <h3>{t('network.analysis.topology', { name: na.fabrics[0].name })}</h3>
                    <FabricTopology fabric={na.fabrics[0]} />
                  </div>
                )}
              </Section>

              <Section title={t('network.bom.title')}>
                <DataTable
                  columns={[
                    { key: 'n', header: t('network.col.type'), render: (c: (typeof cableRows)[number]) => c.name },
                    { key: 'c', header: t('network.col.qty'), num: true, render: (c) => fmtInt(c.count), sortValue: (c) => c.count },
                    { key: 'l', header: t('network.col.totalLength'), num: true, render: (c) => `${fmtInt(c.totalLengthM)} m`, sortValue: (c) => c.totalLengthM },
                    { key: 'avg', header: t('network.col.avg'), num: true, render: (c) => `${fmt1(c.totalLengthM / Math.max(1, c.count))} m` },
                    { key: 't', header: t('network.col.xcvr'), num: true, render: (c) => fmtInt(c.transceivers) },
                    { key: '$', header: t('network.col.cost'), num: true, render: (c) => fmtMoney(c.cost, project.pricing), sortValue: (c) => c.cost },
                  ]}
                  rows={cableRows}
                  rowKey={(c) => c.cableTypeId}
                  initialSort={{ key: 'c', dir: -1 }}
                />
              </Section>
            </>
          )}

          <Section title={t('network.compare.title')}>
            <div className="row wrap" style={{ gap: 12, marginBottom: 8 }}>
              {SCALE_OUT_FABRICS.map((f) => (
                <Toggle key={f} label={t(`network.fabricName.${f}`)} checked={compareSet.includes(f)} onChange={(v) => setCompareSet((s) => (v ? [...s, f] : s.filter((x) => x !== f)))} />
              ))}
            </div>
            {comparison.length === 0 ? (
              <Empty>{t('network.compare.empty')}</Empty>
            ) : (
              <>
                <DataTable
                  columns={[
                    { key: 'f', header: t('network.col.fabric'), render: (r: (typeof comparison)[number]) => <span>{r.label}{r.extrapolated && <span className="badge src-estimate" title={t('network.badge.extrapolatedCompareTitle')}> {t('network.badge.extrapolated')}</span>}{r.feasible === false && <StatusLabel severity="error">{t('network.badge.ddcCap')}</StatusLabel>}</span> },
                    { key: 's', header: t('network.col.switches'), num: true, render: (r) => fmtInt(r.switches) },
                    { key: 'x', header: t('network.col.xcvr'), num: true, render: (r) => fmtInt(r.transceivers) },
                    { key: 'c', header: t('network.col.capex'), num: true, render: (r) => fmtMoney(r.networkCapexUSD, project.pricing), sortValue: (r) => r.networkCapexUSD },
                    { key: 'p', header: t('network.col.power'), num: true, render: (r) => fmtPower(r.networkPowerKW) },
                    { key: 'e', header: t('network.col.effBoth'), num: true, render: (r) => `${fmtPct(r.commEfficiencyEffective ?? r.commEfficiency)} / ${fmtPct(r.commEfficiency)}`, sortValue: (r) => r.commEfficiencyEffective ?? r.commEfficiency },
                    {
                      key: 'eta',
                      header: t('network.col.etaSource'),
                      render: (r) => {
                        const cur = r.fabric === so.fabric;
                        const e = etaFor(cur ? so : { fabric: r.fabric });
                        return <span title={`${e.citation}${e.conditions ? ` — ${e.conditions}` : ''}`}>η {e.nominalValue !== undefined ? `${e.nominalValue} → ${+e.value.toFixed(3)}` : +e.value.toFixed(3)} <EvidenceBadge type={e.sourceType} /></span>;
                      },
                      sortValue: (r) => etaFor(r.fabric === so.fabric ? so : { fabric: r.fabric }).value,
                    },
                    { key: 't', header: t('network.col.trainDays'), num: true, render: (r) => <span>{fmtDuration(r.timeToTrainDays, useApp.getState().uiLocale)}{(r.extrapolated || r.feasible === false) && <span className="badge src-estimate" title={t('network.badge.estimateTitle')}> {t('network.badge.estimate')}</span>}</span>, sortValue: (r) => (r.feasible === false ? Number.POSITIVE_INFINITY : (r.timeToTrainDays ?? Number.POSITIVE_INFINITY)) },
                    { key: 'a', header: '', render: (r) => (r.fabric === so.fabric ? <span className="badge">{t('network.common.current')}</span> : <button className="btn sm" onClick={() => setSO({ fabric: r.fabric, switchCatalogId: FABRIC_SWITCH[r.fabric], loadBalancing: undefined })}>{t('network.common.apply')}</button>) },
                  ]}
                  rows={comparison}
                  rowKey={(r) => r.fabric}
                />
                <div className="card" style={{ marginTop: 10 }}>
                  <BarChart title={t('network.compare.capexChart')} data={comparison.map((r) => ({ label: r.label, id: r.fabric, values: { v: r.networkCapexUSD } }))} series={[{ key: 'v', name: 'CAPEX' }]} format={(v) => fmtMoney(v, project.pricing)} labelWidth={170} />
                </div>
                <div className="card">
                  <BarChart title={t('network.compare.daysChart')} data={comparison.filter((r) => r.timeToTrainDays != null).map((r) => ({ label: r.label, id: r.fabric, values: { v: r.timeToTrainDays ?? 0 } }))} series={[{ key: 'v', name: t('network.common.days') }]} format={(v) => fmt2(v)} labelWidth={170} />
                  <p className="caption">{t('network.compare.caption')}</p>
                </div>
              </>
            )}
          </Section>
        </>
      )}

      {tab === 'clusters' && <ClustersTab />}

      {tab === 'placement' && (
        <Section title={t('network.placement.title')} actions={<Seg value={fill} options={[{ value: 0.5, label: t('network.placement.fill50') }, { value: 0.4, label: t('network.placement.fill40') }]} onChange={setFill} />}>
          <p className="hint" style={{ marginBottom: 8 }}>{t('network.placement.hint', { note: growthNote })}</p>
          {!placement || candidates.length === 0 ? (
            <Empty>{t('network.placement.empty')}</Empty>
          ) : (
            <>
              <DataTable
                columns={[
                  { key: 'p', header: t('network.col.position'), render: (c: PlacementCandidate) => <span>{t(`network.spinePlacement.${c.spinePlacement}`)} {c.spinePlacement === placement.chosen && <span className="badge">{t('network.common.current')}</span>} {c.spinePlacement === placement.recommended && <span className="badge src-vendor-datasheet">{t('network.common.recommended')}</span>}</span> },
                  { key: 'b', header: t('network.col.basis'), render: (c) => <span className="badge">{c.basis === 'relayout' ? t('network.placement.basis.relayout') : c.basis === 'current' ? t('network.placement.basis.current') : t('network.placement.basis.approx')}</span> },
                  { key: 'm', header: t('network.col.meanLink'), num: true, render: (c) => `${fmt1(c.meanLinkM)} m`, sortValue: (c) => c.meanLinkM },
                  { key: 'x', header: t('network.col.maxLink'), num: true, render: (c) => <span>{fmt1(c.maxLinkM)} m {c.overLimitLinks > 0 ? <StatusLabel severity="error">{t('network.placement.overLimit', { n: fmtInt(c.overLimitLinks) })}</StatusLabel> : <StatusLabel severity="good">{t('network.placement.reachOk')}</StatusLabel>}</span>, sortValue: (c) => c.maxLinkM },
                  { key: 'f', header: t('network.col.fiber'), num: true, render: (c) => `${fmt1(c.fiberKm)} km`, sortValue: (c) => c.fiberKm },
                  { key: 't', header: t('network.col.trayPeak', { pct: Math.round(fill * 100) }), num: true, render: (c) => `${fmtInt(c.trayPeakMm2)} mm²`, sortValue: (c) => c.trayPeakMm2 },
                  { key: 'o', header: t('network.col.optics'), num: true, render: (c) => `${fmtInt(c.transceivers)} · ${fmtPower(c.transceiverKW ?? 0)}` },
                  { key: 'l', header: t('network.col.lost'), num: true, render: (c) => fmtInt(c.lostPositions) },
                  { key: '$', header: t('network.col.interconnect'), num: true, render: (c) => fmtMoney(c.interconnectUSD, project.pricing), sortValue: (c) => c.interconnectUSD },
                  { key: 'a', header: '', render: (c) => (c.spinePlacement === placement.chosen ? null : <button className="btn sm" onClick={() => setSO({ spinePlacement: c.spinePlacement, separateRoom: c.spinePlacement === 'separate-room' })}>{t('network.common.apply')}</button>) },
                ]}
                rows={candidates}
                rowKey={(c) => c.spinePlacement}
              />
              <div className="grid-2" style={{ marginTop: 10 }}>
                <div className="card">
                  <BarChart title={t('network.placement.chartLength')} data={candidates.map((c) => ({ label: t(`network.spinePlacement.${c.spinePlacement}`), id: c.spinePlacement, values: { mean: c.meanLinkM, max: c.maxLinkM } }))} series={[{ key: 'mean', name: t('network.common.mean') }, { key: 'max', name: t('network.common.max') }]} format={(v) => `${fmt1(v)} m`} labelWidth={130} />
                </div>
                <div className="card">
                  <BarChart title={t('network.placement.chartCost')} data={candidates.map((c) => ({ label: t(`network.spinePlacement.${c.spinePlacement}`), id: c.spinePlacement, values: { v: c.interconnectUSD } }))} series={[{ key: 'v', name: 'USD' }]} format={(v) => fmtMoney(v, project.pricing)} labelWidth={130} />
                </div>
                <div className="card">
                  <BarChart title={t('network.placement.chartFiber')} data={candidates.map((c) => ({ label: t(`network.spinePlacement.${c.spinePlacement}`), id: c.spinePlacement, values: { v: c.fiberKm } }))} series={[{ key: 'v', name: 'km' }]} format={(v) => fmt1(v)} labelWidth={130} />
                </div>
                <div className="card">
                  <BarChart title={t('network.placement.chartTray', { pct: Math.round(fill * 100) })} data={candidates.map((c) => ({ label: t(`network.spinePlacement.${c.spinePlacement}`), id: c.spinePlacement, values: { v: c.trayPeakMm2 } }))} series={[{ key: 'v', name: 'mm²' }]} format={(v) => fmtInt(v)} labelWidth={130} />
                </div>
              </div>
              <ul className="hint" style={{ marginTop: 10 }}>
                {placement.notes?.map((n, i) => <li key={i}>{n}</li>)}
                {candidates.flatMap((c) => (c.notes ?? []).map((n, i) => <li key={`${c.spinePlacement}-${i}`}>{t(`network.spinePlacement.${c.spinePlacement}`)}: {n}</li>))}
              </ul>
            </>
          )}
        </Section>
      )}

      {tab === 'traffic' && (
        <>
          <Section title={t('network.traffic.scenarioTitle')}>
            {trafficScenarios.length ? (
              <SelectField
                label={t('network.traffic.scenario')}
                value={selectedTrafficIsAggregate ? AGGREGATE_TRAFFIC_ID : selectedTrafficWorkload?.id ?? ''}
                options={[
                  { value: AGGREGATE_TRAFFIC_ID, label: t('network.traffic.scenarioAggregate') },
                  ...trafficScenarios.map((w) => ({ value: w.id, label: `${w.name} · ${w.inference ? t('network.traffic.scenarioInference') : t('network.traffic.scenarioTraining')}` })),
                ]}
                onChange={(v) => update((d) => { d.network.trafficWorkloadId = v; })}
                hint={t('network.traffic.scenarioHint')}
              />
            ) : <Empty>{t('network.traffic.noScenario')}</Empty>}
          </Section>
          <EtaSection lbOptions={lbOptions} />
          <MeasurementMethod />
          <CalibrationBox />
          {!selectedTrafficIsAggregate && !selectedTrafficIsInference && <SensitivitySection />}
          {!selectedTrafficIsAggregate && !selectedTrafficIsInference && <OverlapSection />}

          {!traffic ? (
            <Empty>{t('network.traffic.empty')}</Empty>
          ) : (
            <>
              <Section title={t('network.traffic.pathTitle')}>
                <div className="card">
                  <TrafficBottleneckMap traffic={traffic} workloadName={trafficDisplayName} />
                  {traffic.physical && (
                    <>
                      <p className="hint" style={{ margin: '4px 0 0' }}>{t('network.traffic.physicalEnvelope', {
                        platform: traffic.physical.platformName ?? traffic.physical.acceleratorName ?? '—',
                        fabric: traffic.physical.scaleUpName,
                        domain: fmtInt(traffic.physical.scaleUpDomain),
                        effective: fmt1(traffic.physical.scaleUpEffectiveGBpsPerGpu),
                        raw: fmt1(traffic.physical.scaleUpRawBidirectionalGBpsPerGpu),
                        busbw: fmtPct(traffic.physical.scaleUpBusbwFactor),
                        scaleOut: traffic.physical.scaleOutFabric ? t(`network.fabricName.${traffic.physical.scaleOutFabric}`) : t('network.traffic.pathScaleOutUnknown'),
                      })}</p>
                      <p className="hint" style={{ margin: '3px 0 0' }}>{t('network.traffic.scaleOutPortAccounting', {
                        nicPorts: fmtInt(traffic.physical.scaleOutNicPortsPerGpu),
                        nicPort: fmtInt(traffic.physical.scaleOutNicPortGbps),
                        nicRaw: fmt1(traffic.physical.scaleOutRawGBpsPerGpu),
                        effective: fmt1(traffic.physical.scaleOutEffectiveGBpsPerGpu),
                        switch: traffic.physical.scaleOutSwitchName ?? t('network.fabric.switch'),
                        switchPort: fmtInt(traffic.physical.scaleOutSwitchPortGbps),
                        switchRaw: fmt1(traffic.physical.scaleOutSwitchRawGBps),
                        portUse: fmt2(traffic.physical.scaleOutSwitchPortsPerGpu),
                      })}</p>
                      {traffic.physical.scaleOutNicPortGbps < traffic.physical.scaleOutSwitchPortGbps && (
                        <p className="caption" style={{ margin: '2px 0 0' }}>{t('network.traffic.scaleOutMixedSpeedWarning', {
                          nicPort: fmtInt(traffic.physical.scaleOutNicPortGbps),
                          switchPort: fmtInt(traffic.physical.scaleOutSwitchPortGbps),
                        })}</p>
                      )}
                      <p className="caption" style={{ margin: '2px 0 0' }}>{t('network.traffic.physicalEnvelopeHint')}</p>
                    </>
                  )}
                  <p className="caption">{t(traffic.mode === 'aggregate' ? 'network.traffic.pathBasisAggregate' : traffic.mode === 'inference' ? 'network.traffic.pathBasisInference' : 'network.traffic.pathBasis')}</p>
                </div>
              </Section>

              <Section title={t(traffic.mode === 'aggregate' ? 'network.traffic.titleAggregate' : traffic.mode === 'inference' ? 'network.traffic.titleInference' : 'network.traffic.title')}>
                {traffic.mode === 'aggregate' ? (
                  <div className="grid-4">
                    <Stat label={t('network.traffic.aggregateWorkloads')} value={fmtInt(traffic.quality?.workloadCount ?? traffic.workloadIds?.length ?? 0)} delta={t('network.traffic.aggregateConcurrent')} />
                    <Stat label={t('network.traffic.aggregateAllocation')} value={`${fmtInt(traffic.allocatedGpus ?? 0)} GPU`} delta={t('network.traffic.aggregateAllocationDelta')} />
                    <Stat label={t('network.traffic.inferenceBottleneck')} value={trafficBottleneck ? `${fmtPct(trafficBottleneck.utilization, 1)}` : '–'} delta={trafficBottleneck ? tierLabel(trafficBottleneck.tier) : undefined} />
                    <Stat label={t('network.traffic.qualityTitle')} value={t(`network.traffic.quality.${traffic.quality?.level ?? 'estimate'}`)} delta={t('network.traffic.qualityCoverage', { n: traffic.quality?.calibratedWorkloads ?? 0, total: traffic.quality?.workloadCount ?? 0 })} />
                  </div>
                ) : traffic.mode === 'inference' ? (
                  <div className="grid-4">
                    <Stat label={t('network.traffic.inferenceDemand')} value={`${fmtInt(traffic.inference?.requestsPerSec ?? 0)} req/s`} delta={traffic.inference?.disaggregated ? t('network.inf.modePd') : t('network.inf.modeAggregated')} />
                    <Stat label={t('network.traffic.inferenceTokens')} value={`${fmtInt((traffic.inference?.prefillTokensPerSec ?? 0) + (traffic.inference?.decodeTokensPerSec ?? 0))} tok/s`} delta={t('network.traffic.inferenceTokensDelta', { prefill: fmtInt(traffic.inference?.prefillTokensPerSec ?? 0), decode: fmtInt(traffic.inference?.decodeTokensPerSec ?? 0) })} />
                    <Stat label={t('network.traffic.inferenceAllocation')} value={`${fmtInt(traffic.inference?.allocatedGpus ?? 0)} GPU`} delta={t('network.traffic.inferenceReplicas', { n: traffic.inference?.replicas ?? 0 })} />
                    <Stat label={t('network.traffic.inferenceBottleneck')} value={trafficBottleneck ? `${fmtPct(trafficBottleneck.utilization, 1)}` : '–'} delta={trafficBottleneck ? tierLabel(trafficBottleneck.tier) : undefined} />
                  </div>
                ) : (
                  <div className="grid-4">
                    <Stat label={t('network.traffic.step')} value={`${fmt2(traffic.stepTimeS)} s`} delta={t('network.traffic.stepDelta', { comp: fmt2(traffic.computeTimeS), exposed: (traffic.exposedCommS ?? 0).toFixed(3) })} />
                    <Stat label={t('network.traffic.effEff')} value={fmtPct(traffic.commEfficiencyEffective)} delta={t('network.traffic.effDelta', { eta: eta.value, mfu: fmtPct(traffic.mfuEffective) })} />
                    <Stat label={<Term id="oversubscription">{t('network.traffic.maxOversub')}</Term>} value={`${traffic.minOversubscription}:1`} delta={`${t('network.traffic.oversubDelta', { n: so.oversubscription })} · ${so.oversubscription <= traffic.minOversubscription ? t('network.traffic.oversubOk') : t('network.traffic.oversubShort')}`} />
                    <Stat label={t('network.traffic.l2l3')} value={traffic.l2l3.recommendation.toUpperCase()} delta={traffic.groupTier ? `DP → ${traffic.groupTier.dp}` : undefined} />
                  </div>
                )}
                <div className="grid-2" style={{ marginTop: 10 }}>
                  <div className="card">
                    <BarChart
                      title={t(traffic.mode === 'aggregate' ? 'network.traffic.bytesChartAggregate' : traffic.mode === 'inference' ? 'network.traffic.bytesChartInference' : 'network.traffic.bytesChart')}
                      data={trafficGroups.map((g) => ({ label: t(`network.traffic.group.${g}`), id: g, values: { v: traffic.bytesPerStepByGroup[g] ?? 0 } }))}
                      series={[{ key: 'v', name: trafficRateMode ? 'GB/s' : 'GB' }]} format={(v) => `${fmt1(v)} ${trafficRateMode ? 'GB/s' : 'GB'}`} labelWidth={170}
                    />
                    {traffic.groupTier && <p className="caption">{trafficRateMode ? t('network.traffic.placementCaptionInference', { ...traffic.groupTier, pd: traffic.groupTier.pd ?? '-' }) : t('network.traffic.placementCaption', traffic.groupTier)}</p>}
                  </div>
                  <div className="card">
                    <h3>{t(traffic.mode === 'aggregate' ? 'network.traffic.tierTitleAggregate' : traffic.mode === 'inference' ? 'network.traffic.tierTitleInference' : 'network.traffic.tierTitle')}</h3>
                    {traffic.perTier.map((x) => (
                      <div key={x.tier} style={{ marginBottom: 8 }}>
                        <div className="row" style={{ fontSize: 12 }}>
                          <span style={{ width: 150 }}>{tierLabel(x.tier)}</span>
                          <span className="grow" />
                          <span>{t(trafficRateMode ? 'network.traffic.tierRowInference' : 'network.traffic.tierRow', { gb: fmt1(x.bytesPerStepGB), u: fmtPct(x.utilization, 1), avg: fmtPct(x.utilizationAvg, 1) })}</span>
                          <span style={{ marginLeft: 8 }}>{Number.isFinite(x.headroom) ? <StatusLabel severity={x.headroom < 0 ? 'error' : x.headroom < 0.2 ? 'warning' : 'good'}>{x.headroom >= 10 ? t('network.traffic.headroomBig') : t('network.traffic.headroom', { x: fmt1(x.headroom) })}</StatusLabel> : <StatusLabel severity="good">{t('network.traffic.noTraffic')}</StatusLabel>}</span>
                        </div>
                        <Meter ratio={x.utilization} label={t(traffic.mode === 'aggregate' ? 'network.traffic.meterLabelAggregate' : 'network.traffic.meterLabel', { tier: tierLabel(x.tier), cap: fmtInt(x.capacityGBps ?? 0) })} />
                      </div>
                    ))}
                    <p className="caption">{t(traffic.mode === 'aggregate' ? 'network.traffic.utilCaptionAggregate' : traffic.mode === 'inference' ? 'network.traffic.utilCaptionInference' : 'network.traffic.utilCaption')}</p>
                  </div>
                </div>
              </Section>

              {traffic.trafficTrace?.length ? (
                <Section title={t('network.traffic.timelineTitle')}>
                  <div className="card">
                    <LineChart
                      title={t(traffic.mode === 'aggregate' ? 'network.traffic.timelineChartAggregate' : 'network.traffic.timelineChartSingle')}
                      series={traffic.perTier
                        .filter((tier) => traffic.trafficTrace!.some((point) => point[TRAFFIC_TRACE_RATE_KEY[tier.tier]] > 0))
                        .map((tier) => ({
                          key: tier.tier,
                          name: tierLabel(tier.tier),
                          points: traffic.trafficTrace!.map((point) => ({ x: point.t, y: point[TRAFFIC_TRACE_RATE_KEY[tier.tier]] })),
                        }))}
                      xFormat={(value) => `${fmtInt(value)} s`}
                      yFormat={(value) => `${fmt1(value)} GB/s`}
                      yMin={0}
                      step
                    />
                    <p className="caption">{t(traffic.mode === 'aggregate' ? 'network.traffic.timelineCaptionAggregate' : traffic.mode === 'inference' ? 'network.traffic.timelineCaptionInference' : 'network.traffic.timelineCaptionTraining')}</p>
                  </div>
                </Section>
              ) : null}

              {traffic.quality && (
                <Section title={t('network.traffic.qualityTitle')}>
                  <div className="card">
                    <div className="row wrap" style={{ gap: 8 }}>
                      <StatusLabel severity={traffic.quality.level === 'calibrated' ? 'good' : traffic.quality.level === 'mixed' ? 'warning' : 'info'}>{t(`network.traffic.quality.${traffic.quality.level}`)}</StatusLabel>
                      <strong>{t('network.traffic.qualityCoverage', { n: traffic.quality.calibratedWorkloads, total: traffic.quality.workloadCount })}</strong>
                    </div>
                    <p className="hint" style={{ marginTop: 6 }}>{t('network.traffic.qualityMeaning')}</p>
                    {traffic.quality.offeredDemandWorkloads.length > 0 && <p className="hint warn-text">{t('network.traffic.qualityDemandWarning', { n: traffic.quality.offeredDemandWorkloads.length })}</p>}
                  </div>
                </Section>
              )}

              <Section title={t('network.l2l3.title')}>
                <div className="card">
                  <div className="row"><StatusLabel severity={traffic.l2l3.recommendation === 'l3' ? 'info' : 'good'}>{traffic.l2l3.recommendation === 'l3' ? t('network.l2l3.l3') : t('network.l2l3.l2')}</StatusLabel></div>
                  <p className="hint" style={{ marginTop: 6 }}>{traffic.l2l3.reason}</p>
                </div>
              </Section>

              {traffic.inference && (
                <Section title={t('network.inf.title')}>
                  <div className="grid-3">
                    <Stat label={t('network.inf.kv')} value={`${fmt1(traffic.inference.kvBytesPerToken / 1024)} KB`} delta={traffic.inference.attention.toUpperCase()} />
                    <Stat
                      label={t('network.inf.pd')}
                      value={traffic.inference.disaggregated ? `${fmtInt(traffic.inference.kvTransferGbps)} Gb/s` : '–'}
                      delta={t(traffic.inference.disaggregated ? 'network.inf.pdDelta' : 'network.inf.pdDisabled')}
                    />
                    <Stat label={t('network.inf.ep')} value={Number.isFinite(traffic.inference.epDecodeTokPerSPerUser) ? `${fmtInt(traffic.inference.epDecodeTokPerSPerUser)} tok/s/user` : '–'} delta={t('network.inf.epDelta')} />
                  </div>
                  {traffic.inference.prefillParallelism && traffic.inference.decodeParallelism && (
                    <p className="caption">
                      {traffic.inference.disaggregated
                        ? t('network.inf.topologyPd', {
                          ptp: traffic.inference.prefillParallelism.tp, ppp: traffic.inference.prefillParallelism.pp, pdp: traffic.inference.prefillReplicas ?? traffic.inference.prefillParallelism.dp ?? '–', pep: traffic.inference.prefillParallelism.ep, pcp: traffic.inference.prefillParallelism.cp, pg: traffic.inference.prefillInstanceGpus ?? 0,
                          dtp: traffic.inference.decodeParallelism.tp, dpp: traffic.inference.decodeParallelism.pp, ddp: traffic.inference.decodeReplicas ?? traffic.inference.decodeParallelism.dp ?? '–', dep: traffic.inference.decodeParallelism.ep, dcp: traffic.inference.decodeParallelism.cp, dg: traffic.inference.decodeInstanceGpus ?? 0,
                        })
                        : t('network.inf.topologyAggregated', {
                          tp: traffic.inference.decodeParallelism.tp, pp: traffic.inference.decodeParallelism.pp, dp: traffic.inference.decodeReplicas ?? traffic.inference.decodeParallelism.dp ?? '–', ep: traffic.inference.decodeParallelism.ep, cp: traffic.inference.decodeParallelism.cp, g: traffic.inference.decodeInstanceGpus ?? 0,
                        })}
                    </p>
                  )}
                </Section>
              )}

              <Section title={t('network.traffic.notes')}>
                <ul className="hint">{traffic.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
              </Section>
            </>
          )}
        </>
      )}

      {tab === 'schedule' && <ScheduleTab />}
      {tab === 'ip' && <IpTab />}
    </div>
  );
}

// ───────────── η in use ─────────────

function EtaSection({ lbOptions }: { lbOptions: { value: LoadBalancing; label: string }[] }) {
  const t = useT();
  const so = useApp((s) => s.project.network.scaleOut);
  const traffic = useApp((s) => s.analysis?.network.traffic);
  const update = useApp((s) => s.update);
  const setSO = (patch: Partial<ScaleOutNetwork>) => update((d) => { Object.assign(d.network.scaleOut, patch); });
  const eta = etaFor(so);
  return (
    <Section title={<span style={{ textTransform: 'none' }}>{t('network.eta.title')}</span>}>
      <div className="fields-2">
        <div>
          <div className="field">
            <label>{t('network.eta.fabric')}</label>
            <div className="row wrap" style={{ gap: 6 }}>
              <strong style={{ fontSize: 18 }}>{+eta.value.toFixed(3)}</strong>
              {eta.nominalValue !== undefined && <span className="hint">({t('network.eta.nominalOf', { v: eta.nominalValue })})</span>}
              <EvidenceBadge type={eta.sourceType} title={eta.citation} />
              <span className="badge">{LB_LABEL[eta.class]}</span>
            </div>
          </div>
          <p className="caption">{eta.citation}</p>
          {eta.conditions && <p className="caption">{t('network.eta.conditions')}: {eta.conditions}</p>}
          {eta.url && <p className="caption"><a href={eta.url} target="_blank" rel="noreferrer">{t('network.eta.source')}</a></p>}
          {eta.sourceType === 'nominal' && <div className="row" style={{ marginTop: 4 }}><StatusLabel severity="warning">{t('network.eta.nominalWarn')}</StatusLabel></div>}
          {so.etaCalibration && <button className="btn ghost sm" style={{ marginTop: 6 }} onClick={() => setSO({ etaCalibration: undefined })}>{t('network.eta.clearCal')}</button>}
        </div>
        <div>
          <div className="field">
            <label>{t('network.eta.host')}</label>
            <div className="row wrap" style={{ gap: 6 }}>
              <strong style={{ fontSize: 18 }}>{eta.host}</strong>
              <EvidenceBadge type={eta.hostSourceType} title={eta.hostCitation} />
            </div>
          </div>
          <p className="caption">{eta.hostCitation}</p>
          {eta.a2a !== undefined && (
            <div className="field" style={{ marginTop: 6 }}>
              <label>{t('network.eta.a2a')}</label>
              <div className="row wrap" style={{ gap: 6 }}>
                <strong>{eta.a2a.toFixed(3)}</strong> <EvidenceBadge type="user-measured" />
                {so.etaCalibrationA2a?.measuredAt && <span className="hint">{t('network.eta.measuredOn', { date: so.etaCalibrationA2a.measuredAt })}</span>}
                <button className="btn ghost sm" onClick={() => setSO({ etaCalibrationA2a: undefined })}>{t('network.eta.clearCalA2a')}</button>
              </div>
            </div>
          )}
          <SelectField label={t('network.eta.class')} value={eta.class} options={lbOptions} onChange={(v) => setSO({ loadBalancing: v })} />
          <NumberField label={t('network.eta.override')} step={0.05} min={0.05} max={1} value={so.etaOverride ?? 0} onChange={(v) => setSO({ etaOverride: v > 0 ? v : undefined })} hint={so.etaCalibration && so.etaOverride ? t('network.eta.overrideIgnored') : t('network.eta.overrideHint')} />
          {so.etaOverride ? <button className="btn ghost sm" onClick={() => setSO({ etaOverride: undefined })}>{t('network.eta.reset')}</button> : null}
        </div>
      </div>
      {traffic?.etaA2a !== undefined && <p className="caption">{t('network.eta.a2aUsed', { v: traffic.etaA2a.toFixed(3) })}</p>}
      <p className="caption">{t('network.eta.defaultsCaption')}</p>
    </Section>
  );
}

// ───────────── measurement method (the full kit lives in Docs › Test code, T7) ─────────────

function MeasurementMethod() {
  const t = useT();
  const cmd = [
    '# 1) same N nodes, two placements: hosts-packed.txt (one leaf / rail SU) and hosts-spread.txt (one node per leaf / SU → every ring edge crosses the spine)',
    'mpirun -np $((N*G)) -N $G --hostfile hosts-${PLACEMENT}.txt --bind-to numa \\',
    '  -x NCCL_IB_HCA==mlx5_0,...,mlx5_7 -x NCCL_ALGO=Ring -x NCCL_NVLS_ENABLE=0 -x NCCL_COLLNET_ENABLE=0 \\',
    '  -x NCCL_IB_QPS_PER_CONNECTION=1 -x NCCL_CROSS_NIC=0 -x NCCL_DEBUG=INFO \\',
    '  ./build/all_reduce_perf -b 1M -e 16G -f 2 -g 1 -n 20 -w 5 | tee ar_ring_${PLACEMENT}.log',
    'mpirun ...same... ./build/alltoall_perf -b 1M -e 16G -f 2 -g 1 -n 20 -w 5 | tee a2a_${PLACEMENT}.log',
    '# RoCEv2: add -x NCCL_IB_GID_INDEX=3 -x NCCL_IB_TC=<lossless TC>; AMD: rccl-tests with the same flags',
  ].join('\n');
  return (
    <Section title={t('network.method.title')}>
      <details>
        <summary className="hint" style={{ cursor: 'pointer' }}>{t('network.method.summary')}</summary>
        <ul className="hint" style={{ marginTop: 6 }}>
          <li>{t('network.method.def')}</li>
          <li>{t('network.method.packed')}</li>
          <li>{t('network.method.spread')}</li>
          <li>{t('network.method.size')}</li>
          <li>{t('network.method.env')}</li>
          <li>{t('network.method.footer')}</li>
          <li>{t('network.method.nvls')}</li>
          <li>{t('network.method.a2a')}</li>
          <li>{t('network.method.record')}</li>
        </ul>
        <div style={codeBlock}>{cmd}</div>
        <p className="caption" style={{ marginTop: 6 }}>{t('network.method.kit')}</p>
      </details>
    </Section>
  );
}

// ───────────── calibration from a pasted log ─────────────

function gpuRackOf(equipment: { catalogId: string }[]): CatalogItem | undefined {
  const counts = new Map<string, number>();
  for (const e of equipment) counts.set(e.catalogId, (counts.get(e.catalogId) ?? 0) + 1);
  let best: CatalogItem | undefined;
  let bestGpus = 0;
  for (const [id, n] of counts) {
    const item = findCatalogItem(id);
    const g = item?.category === 'gpu-rack' ? (item.compute?.gpus ?? 0) * n : 0;
    if (g > bestGpus) {
      bestGpus = g;
      best = item;
    }
  }
  return best;
}

function CalibrationBox() {
  const t = useT();
  const project = useApp((s) => s.project);
  const update = useApp((s) => s.update);
  const so = project.network.scaleOut;
  const setSO = (patch: Partial<ScaleOutNetwork>) => update((d) => { Object.assign(d.network.scaleOut, patch); });
  const [target, setTarget] = useState<'all_reduce' | 'alltoall'>('all_reduce');
  const [spreadLog, setSpreadLog] = useState('');
  const [packedLog, setPackedLog] = useState('');
  const [pick, setPick] = useState(0);
  const [nicGbps, setNicGbps] = useState<number | null>(null);
  const [nicsPerNode, setNicsPerNode] = useState<number | null>(null);
  const [rpn, setRpn] = useState<number | null>(null);
  const [ranks, setRanks] = useState<number | null>(null);
  const rack = useMemo(() => gpuRackOf(project.equipment), [project.equipment]);
  const c = rack?.compute;
  const spread = useMemo(() => parseCollectiveLog(spreadLog), [spreadLog]);
  const packed = useMemo(() => parseCollectiveLog(packedLog), [packedLog]);
  const m = spread.length ? spread[Math.min(pick, spread.length - 1)] : undefined;
  const pk = packed.length ? packed[0] : undefined;
  // defaults from the pasted log: AIDC kit logs are MOD-split (one GPU / NIC per node per communicator), others per node (core eta.ts)
  const defaults = nominalInputsFor(m, c ? { ...c, scaleUpDomain: c.scaleUp?.domainSize } : undefined);
  const nicEff = nicGbps ?? defaults.nicGbps;
  const nicsEff = nicsPerNode ?? defaults.nicsPerNode;
  const rpnEff = rpn ?? defaults.ranksPerNode;
  const ranksEff = ranks ?? defaults.ranks;
  const nominal = nominalBusbwGBps({ collective: target, nicGbps: nicEff, nicsPerNode: nicsEff, ranksPerNode: rpnEff, ranks: ranksEff });
  const cal: EtaCalibration | undefined = m ? calibrateEta({ spread: m, packed: pk, nominalGBps: nominal, measuredAt: today() }) : undefined;
  const blocked = !cal || !!cal.flags?.some((f) => f === 'not-network-bound' || f === 'no-rows');
  const mismatch = m && m.collective !== 'other' && m.collective !== target && !(target === 'all_reduce' && (m.collective === 'all_gather' || m.collective === 'reduce_scatter'));
  const applied = target === 'alltoall' ? so.etaCalibrationA2a : so.etaCalibration;

  return (
    <Section title={t('network.cal.title')}>
      <div className="row wrap" style={{ gap: 8, marginBottom: 6 }}>
        <span className="hint">{t('network.cal.target')}</span>
        <Seg value={target} options={[{ value: 'all_reduce', label: t('network.cal.targetAr') }, { value: 'alltoall', label: t('network.cal.targetA2a') }]} onChange={setTarget} />
      </div>
      <div className="fields-2">
        <div className="field">
          <label>{t('network.cal.spreadLog')}</label>
          <textarea style={monoArea} value={spreadLog} placeholder={t('network.cal.placeholder')} onChange={(e) => { setSpreadLog(e.target.value); setPick(0); }} spellCheck={false} data-testid="eta-spread-log" />
        </div>
        <div className="field">
          <label>{t('network.cal.packedLog')}</label>
          <textarea style={monoArea} value={packedLog} placeholder={t('network.cal.packedPlaceholder')} onChange={(e) => setPackedLog(e.target.value)} spellCheck={false} data-testid="eta-packed-log" />
        </div>
      </div>
      <div className="grid-4" style={{ marginTop: 6 }}>
        <NumberField label={t('network.cal.nicGbps')} unit="Gb/s" step={100} min={1} value={nicEff} onChange={(v) => setNicGbps(v > 0 ? v : null)} />
        <NumberField label={t('network.cal.nicsPerNode')} step={1} min={1} value={nicsEff} onChange={(v) => setNicsPerNode(v > 0 ? v : null)} />
        <NumberField label={t('network.cal.ranksPerNode')} step={1} min={1} value={rpnEff} onChange={(v) => setRpn(v > 0 ? v : null)} />
        <NumberField label={t('network.cal.ranks')} step={1} min={0} value={ranksEff ?? 0} onChange={(v) => setRanks(v > 0 ? v : null)} hint={target === 'alltoall' ? t('network.cal.ranksHint') : undefined} />
      </div>
      {defaults.split && !defaults.splitInferred ? <p className="caption" data-kit-split>{t('network.cal.kitSplit', { gpn: defaults.split, scope: m?.kit?.scope ?? '—', nodes: defaults.ranks ?? '—' })}</p> : null}
      {defaults.splitInferred ? <p className="caption warn" data-split-no-header>{t('network.cal.splitNoHeader', { groups: defaults.split ?? '—', nodes: defaults.ranks ?? '—' })}</p> : null}
      {defaults.domainGroup && target === 'alltoall' ? <p className="caption" data-a2a-domain>{t('network.cal.a2aDomain', { g: defaults.ranksPerNode })}</p> : null}
      <p className="caption">{t('network.cal.nominal', { v: nominal.toFixed(2), formula: target === 'alltoall' ? '(r/g)·(L/8)·(n−1)/(n−g)' : 'r·L/8' })}</p>

      {spreadLog.trim() && spread.length === 0 && <Empty>{t('network.cal.none')}</Empty>}
      {spread.length > 0 && (
        <>
          <h3 style={{ marginTop: 8 }}>{t('network.cal.parsed')}</h3>
          <DataTable
            columns={[
              { key: 'i', header: t('network.cal.col.run'), render: (x: (typeof spread)[number] & { i: number }) => (spread.length > 1 ? <button className={`btn sm ${x.i === pick ? '' : 'ghost'}`} onClick={() => setPick(x.i)}>#{x.i + 1}</button> : `#${x.i + 1}`) },
              { key: 'tool', header: t('network.cal.col.tool'), render: (x) => x.tool },
              { key: 'c', header: t('network.cal.col.collective'), render: (x) => x.collective },
              { key: 'r', header: t('network.cal.col.ranks'), num: true, render: (x) => `${x.ranks ?? '–'}${x.rankListTruncated ? ' *' : ''}` },
              { key: 'n', header: t('network.cal.col.nodes'), num: true, render: (x) => x.nodes ?? '–' },
              { key: 'rows', header: t('network.cal.col.rows'), num: true, render: (x) => x.rows.filter((r) => !r.inPlace).length },
              { key: 'l', header: t('network.cal.col.largest'), num: true, render: (x) => { const rows = x.rows.filter((r) => !r.inPlace); const last = rows[rows.length - 1]; return last ? `${gib(last.sizeB)} · ${last.busbwGBps} GB/s` : '–'; } },
              { key: 'f', header: t('network.cal.col.footer'), num: true, render: (x) => (x.avgBusbwGBps !== undefined ? <span title={t('network.cal.footerIgnored')}>{x.avgBusbwGBps} <span className="badge">{t('network.cal.ignored')}</span></span> : '–') },
            ]}
            rows={spread.map((x, i) => ({ ...x, i }))}
            rowKey={(x) => String(x.i)}
          />
          {m?.rankListTruncated && <p className="caption">{t('network.cal.truncated')}</p>}
          {mismatch && <div className="row" style={{ marginTop: 4 }}><StatusLabel severity="warning">{t('network.cal.collectiveMismatch', { got: m!.collective, want: target })}</StatusLabel></div>}
          {cal && (
            <div className="card" style={{ marginTop: 8 }}>
              <div className="grid-3">
                <Stat label={t('network.cal.etaTotal')} value={(cal.etaTotal ?? 0).toFixed(3)} delta={t('network.cal.plateau', { v: (cal.busbwLargeGBps ?? 0).toFixed(2), sizes: (cal.sizesB ?? []).map(gib).join(', ') })} />
                <Stat label={t('network.cal.etaHost')} value={(cal.etaHost ?? 0).toFixed(3)} delta={pk ? t('network.cal.hostMeasured') : t('network.cal.hostDefault')} />
                <Stat label={t('network.cal.etaFabric')} value={(cal.etaFabric ?? 0).toFixed(3)} delta={t('network.cal.fabricDelta')} />
              </div>
              <p className="caption" style={{ marginTop: 6 }}>{cal.basis}</p>
              {(cal.flags ?? []).length > 0 && (
                <div className="row wrap" style={{ gap: 6, marginTop: 4 }}>
                  {cal.flags!.map((f) => <StatusLabel key={f} severity={f === 'not-network-bound' || f === 'no-rows' ? 'error' : 'warning'}>{t(`network.cal.flag.${f}`)}</StatusLabel>)}
                </div>
              )}
              <div className="row" style={{ gap: 8, marginTop: 8 }}>
                <button className="btn" disabled={blocked} onClick={() => setSO(target === 'alltoall' ? { etaCalibrationA2a: cal } : { etaCalibration: cal })} data-testid="eta-apply">{t('network.cal.apply')}</button>
                {applied && <button className="btn ghost" onClick={() => setSO(target === 'alltoall' ? { etaCalibrationA2a: undefined } : { etaCalibration: undefined })}>{t('network.cal.clear')}</button>}
                {applied && <span className="hint">{t('network.cal.applied', { v: (applied.etaFabric ?? applied.eta).toFixed(3), date: applied.measuredAt ?? '–' })}</span>}
              </div>
            </div>
          )}
        </>
      )}
      {!spread.length && applied && (
        <div className="row" style={{ gap: 8, marginTop: 6 }}>
          <span className="hint">{t('network.cal.applied', { v: (applied.etaFabric ?? applied.eta).toFixed(3), date: applied.measuredAt ?? '–' })}</span>
          <button className="btn ghost sm" onClick={() => setSO(target === 'alltoall' ? { etaCalibrationA2a: undefined } : { etaCalibration: undefined })}>{t('network.cal.clear')}</button>
        </div>
      )}
    </Section>
  );
}

// ───────────── sensitivity: step time / train days vs η ─────────────

function SensitivitySection() {
  const t = useT();
  const project = useApp((s) => s.project);
  const analysis = useApp((s) => s.analysis);
  const traffic = analysis?.network.traffic;
  const sens = useMemo(() => {
    try {
      return projectEtaSensitivity(project);
    } catch {
      return undefined;
    }
  }, [project]);
  const days = analysis?.workloads.find((w) => w.workloadId === traffic?.workloadId)?.timeToTrainDays;
  if (!sens || !traffic) return null;
  const pct = sens.spread * 100;
  const daysAt = (step: number) => (days ?? 0) * (step / sens.current.stepTimeS);
  return (
    <Section title={<span style={{ textTransform: 'none' }}>{t('network.sens.title')}</span>}>
      <div className="grid-2">
        <div className="card">
          <LineChart
            title={t('network.sens.step')}
            series={[{ key: 'step', name: t('network.sens.stepSeries'), points: sens.points.map((p) => ({ x: p.eta, y: p.stepTimeS })) }]}
            xFormat={(v) => `η ${v.toFixed(2)}`}
            yFormat={(v) => `${v.toFixed(3)} s`}
            yMin={Math.min(...sens.points.map((p) => p.stepTimeS)) * 0.998}
            refLines={[{ y: sens.current.stepTimeS, label: t('network.sens.current', { eta: sens.current.eta.toFixed(3), v: `${sens.current.stepTimeS.toFixed(3)} s` }) }]}
            height={180}
          />
        </div>
        {days !== undefined && (
          <div className="card">
            <LineChart
              title={t('network.sens.days')}
              series={[{ key: 'days', name: t('network.common.days'), points: sens.points.map((p) => ({ x: p.eta, y: daysAt(p.stepTimeS) })) }]}
              xFormat={(v) => `η ${v.toFixed(2)}`}
              yFormat={(v) => v.toFixed(2)}
              yMin={Math.min(...sens.points.map((p) => daysAt(p.stepTimeS))) * 0.998}
              refLines={[{ y: days, label: t('network.sens.current', { eta: sens.current.eta.toFixed(3), v: `${days.toFixed(2)} d` }) }]}
              height={180}
            />
          </div>
        )}
      </div>
      {sens.hiddenByOverlap ? (
        <p className="caption" style={{ marginTop: 6 }}>
          {t('network.sens.hidden', { pct: pct.toFixed(2) })} {t('network.sens.metaCite')} <a href={META_BLOG} target="_blank" rel="noreferrer">Meta Engineering, 2024-03-12</a>
        </p>
      ) : !sens.etaBinds ? (
        <p className="caption" style={{ marginTop: 6 }}>{t('network.sens.noBind', { pct: pct.toFixed(2) })}</p>
      ) : (
        <p className="caption" style={{ marginTop: 6 }}>{t('network.sens.visible', { pct: pct.toFixed(1) })}</p>
      )}
      <p className="caption">{t('network.sens.daysCaption')}</p>
    </Section>
  );
}

// ───────────── overlap fractions per group ─────────────

function OverlapSection() {
  const t = useT();
  const project = useApp((s) => s.project);
  const traffic = useApp((s) => s.analysis?.network.traffic);
  const update = useApp((s) => s.update);
  const w = project.workloads.find((x) => x.id === traffic?.workloadId) ?? project.workloads.find((x) => x.kind === 'llm-pretrain' || x.kind === 'llm-finetune');
  if (!w?.training) return null;
  const ov = w.training.overlap ?? {};
  const framework: OverlapFramework = ov.framework ?? traffic?.overlapFramework ?? 'fsdp-prefetch';
  const setOverlap = (patch: Partial<NonNullable<NonNullable<typeof w.training>['overlap']>>, clear?: TrainingGroup) =>
    update((d) => {
      const x = d.workloads.find((y) => y.id === w.id);
      if (!x?.training) return;
      const next = { ...(x.training.overlap ?? {}), ...patch } as Record<string, unknown>;
      if (clear) delete next[clear];
      x.training.overlap = next as NonNullable<typeof x.training.overlap>;
    });
  const rows = TRAINING_GROUPS.map((g) => ({ g, o: traffic?.overlap?.[g] }));
  return (
    <Section title={t('network.ov.title')} actions={<button className="btn ghost sm" onClick={() => update((d) => { const x = d.workloads.find((y) => y.id === w.id); if (x?.training) x.training.overlap = undefined; })}>{t('network.ov.reset')}</button>}>
      <p className="hint">{t('network.ov.formula')}</p>
      <div style={{ maxWidth: 360 }}>
        <SelectField label={t('network.ov.framework')} value={framework} options={OVERLAP_FRAMEWORKS.map((f) => ({ value: f, label: t(`network.ov.fw.${f}`) }))} onChange={(v) => setOverlap({ framework: v })} hint={t('network.ov.workload', { name: w.name })} />
      </div>
      <DataTable
        columns={[
          { key: 'g', header: t('network.ov.col.group'), render: (r: (typeof rows)[number]) => r.g.toUpperCase() },
          {
            key: 'f',
            header: t('network.ov.col.f'),
            render: (r) => (
              <input
                type="number" min={0} max={1} step={0.05} style={{ width: 80 }}
                defaultValue={+((ov as Record<string, number | undefined>)[r.g] ?? r.o?.f ?? 0).toFixed(3)}
                key={`${r.g}-${(ov as Record<string, number | undefined>)[r.g] ?? 'd'}-${r.o?.f ?? 0}`}
                onBlur={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) setOverlap({ [r.g]: Math.min(1, Math.max(0, v)) }); }}
              />
            ),
          },
          { key: 'n', header: t('network.ov.col.nic'), num: true, render: (r) => (r.o ? `${r.o.nicCommS.toFixed(3)} s` : '–') },
          { key: 'w', header: t('network.ov.col.window'), num: true, render: (r) => (r.o ? `${r.o.windowS.toFixed(2)} s` : '–') },
          { key: 'e', header: t('network.ov.col.exposed'), num: true, render: (r) => (r.o ? `${r.o.exposedS.toFixed(4)} s` : '–') },
          { key: 's', header: t('network.ov.col.source'), render: (r) => (r.o ? <span title={r.o.citation}><EvidenceBadge type={r.o.sourceType} /> {r.o.measureIt && <span className="badge src-estimate">{t('network.ov.measureIt')}</span>} {(ov as Record<string, number | undefined>)[r.g] != null && <button className="btn ghost sm" onClick={() => setOverlap({}, r.g)}>{t('network.ov.useDefault')}</button>}</span> : '–') },
          { key: 'c', header: t('network.ov.col.citation'), render: (r) => <span className="hint" style={{ fontSize: 11 }}>{r.o?.url ? <a href={r.o.url} target="_blank" rel="noreferrer">{r.o.citation}</a> : r.o?.citation}</span> },
        ]}
        rows={rows}
        rowKey={(r) => r.g}
      />
      <p className="caption">{t('network.ov.measure')}</p>
    </Section>
  );
}

// ───────────── clusters (F2) ─────────────

function ClustersTab() {
  const t = useT();
  const project = useApp((s) => s.project);
  const analysis = useApp((s) => s.analysis);
  const update = useApp((s) => s.update);
  const [sel, setSel] = useState<string[]>([]);
  const [name, setName] = useState('');
  const hallName = (id: string) => project.halls.find((h) => h.id === id)?.name ?? id;
  const populated = new Set(project.equipment.map((e) => e.hallId));
  const defs = resolveClusters(project);
  const summaries: ClusterNetworkSummary[] = analysis?.network.clusters ?? defs.map((c) => ({ id: c.id, name: c.name, hallIds: c.hallIds, gpus: 0, fabrics: [], switches: 0, cables: 0 }));
  const smfTypes = cableTypes().filter((c) => mediumOf(c) === 'smf');
  const setClusters = (clusters: ClusterDef[] | undefined) => update((d) => { d.clusters = clusters; });
  const setIhc = (id: string, patch: NonNullable<ClusterDef['interHallCore']>) =>
    update((d) => {
      const base = d.clusters?.length ? d.clusters : resolveClusters(d);
      d.clusters = base.map((c) => (c.id === id ? { ...c, interHallCore: { ...(c.interHallCore ?? {}), ...patch } } : c));
    });
  const joined = defs.filter((c) => c.hallIds.length > 1);

  return (
    <>
      <Section title={t('network.cl.title')} actions={project.clusters?.length ? <button className="btn ghost sm" onClick={() => setClusters(undefined)}>{t('network.cl.reset')}</button> : undefined}>
        <p className="hint" style={{ marginBottom: 8 }}>{t('network.cl.intro')}</p>
        {summaries.length === 0 ? (
          <Empty>{t('network.cl.none')}</Empty>
        ) : (
          <DataTable
            columns={[
              { key: 'n', header: t('network.cl.col.name'), render: (c: ClusterNetworkSummary) => <span>{c.name} {c.hallIds.length > 1 ? <span className="badge src-announced">{t('network.cl.joined')}</span> : <span className="badge">{t('network.cl.single')}</span>}</span> },
              { key: 'h', header: t('network.cl.col.halls'), render: (c) => c.hallIds.map(hallName).join(' + ') },
              { key: 'g', header: t('network.cl.col.gpus'), num: true, render: (c) => fmtInt(c.gpus) },
              { key: 'f', header: t('network.cl.col.fabrics'), num: true, render: (c) => c.fabrics.length },
              { key: 's', header: t('network.cl.col.switches'), num: true, render: (c) => fmtInt(c.switches) },
              { key: 'k', header: t('network.cl.col.cables'), num: true, render: (c) => fmtInt(c.cables) },
              {
                key: 'i',
                header: t('network.cl.col.interHall'),
                render: (c) =>
                  c.interHall ? (
                    <span>
                      {t('network.cl.ihcSummary', { placed: c.interHall.placedSuperSpines, need: c.interHall.superSpines, trunks: fmtInt(c.interHall.trunks) })}{' '}
                      {c.interHall.placedSuperSpines < c.interHall.superSpines ? <StatusLabel severity="error">{t('network.cl.unplaced')}</StatusLabel> : c.interHall.overReach > 0 ? <StatusLabel severity="error">{t('network.cl.overReach')}</StatusLabel> : c.interHall.nearReach > 0 ? <StatusLabel severity="warning">{t('network.cl.nearReach')}</StatusLabel> : <StatusLabel severity="good">OK</StatusLabel>}
                    </span>
                  ) : (
                    <span className="hint">{t('network.cl.noTrunks')}</span>
                  ),
              },
              { key: 'a', header: '', render: (c) => (c.hallIds.length > 1 ? <button className="btn sm" onClick={() => setClusters(splitCluster(project, c.id))}>{t('network.cl.split')}</button> : null) },
            ]}
            rows={summaries}
            rowKey={(c) => c.id}
          />
        )}
      </Section>

      <Section title={t('network.cl.joinTitle')}>
        <p className="hint" style={{ marginBottom: 6 }}>{t('network.cl.joinHint')}</p>
        <div className="row wrap" style={{ gap: 12 }}>
          {project.halls.map((h) => (
            <Toggle key={h.id} label={`${h.name}${populated.has(h.id) ? '' : ` (${t('network.cl.emptyHall')})`}`} checked={sel.includes(h.id)} onChange={(v) => setSel((s) => (v ? [...s, h.id] : s.filter((x) => x !== h.id)))} />
          ))}
        </div>
        <div className="row wrap" style={{ gap: 8, marginTop: 6 }}>
          <div className="field" style={{ minWidth: 220 }}>
            <label>{t('network.cl.joinName')}</label>
            <input value={name} placeholder={sel.map(hallName).join(' + ')} onChange={(e) => setName(e.target.value)} />
          </div>
          <button className="btn" disabled={sel.length < 2} onClick={() => { setClusters(joinHalls(project, sel, name.trim() || undefined)); setSel([]); setName(''); }} data-testid="cluster-join">{t('network.cl.joinBtn')}</button>
        </div>
      </Section>

      {joined.map((c) => {
        const s = summaries.find((x) => x.id === c.id);
        const ih = s?.interHall;
        return (
          <Section key={c.id} title={t('network.cl.ihcTitle', { name: c.name })}>
            <div className="fields-2">
              <div>
                <SelectField label={t('network.cl.zoneHall')} value={c.interHallCore?.zoneHallId ?? c.hallIds[0]} options={c.hallIds.map((h) => ({ value: h, label: hallName(h) }))} onChange={(v) => setIhc(c.id, { zoneHallId: v })} />
                <SelectField label={t('network.cl.superSpineSw')} value={c.interHallCore?.spineCatalogId ?? ''} options={[{ value: '', label: t('network.cl.auto') }, ...switchOptionsFor(project.network.scaleOut.fabric)]} onChange={(v) => setIhc(c.id, { spineCatalogId: v || undefined })} />
                <SelectField label={t('network.cl.trunkCable')} value={c.interHallCore?.mediumCableTypeId ?? ''} options={[{ value: '', label: t('network.cl.autoSmf') }, ...smfTypes.map((x) => ({ value: x.id, label: `${x.name} (≤ ${x.maxReachM} m)` }))]} onChange={(v) => setIhc(c.id, { mediumCableTypeId: v || undefined })} />
              </div>
              <div>
                {ih ? (
                  <div className="grid-2">
                    <Stat label={t('network.cl.superSpines')} value={`${ih.placedSuperSpines} / ${ih.superSpines}`} delta={findCatalogItem(ih.superSpineCatalogId)?.name ?? ih.superSpineCatalogId} />
                    <Stat label={t('network.cl.trunks')} value={fmtInt(ih.trunks)} delta={ih.cableTypeId ? (cableTypes().find((x) => x.id === ih.cableTypeId)?.name ?? ih.cableTypeId) : '–'} />
                    <Stat label={t('network.cl.trunkLen')} value={`${fmt1(ih.meanTrunkM)} / ${fmt1(ih.maxTrunkM)} m`} delta={t('network.cl.meanMax')} />
                    <Stat label={t('network.cl.reach')} value={ih.reachM ? `${ih.reachM} m` : '–'} delta={t('network.cl.reachDelta', { over: ih.overReach, near: ih.nearReach })} />
                  </div>
                ) : (
                  <Empty>{t('network.cl.noAnalysis')}</Empty>
                )}
              </div>
            </div>
            {ih && (
              <p className="caption" style={{ marginTop: 6 }}>
                {t('network.cl.distances')}: {ih.hallDistancesM.map((d) => `${hallName(d.hallId)} ${fmt1(d.distanceM)} m`).join(' · ')}
              </p>
            )}
            <p className="caption">{t('network.cl.rackNote')}</p>
          </Section>
        );
      })}

      {analysis && summaries.map((c) => (
        <Section key={`f-${c.id}`} title={t('network.cl.fabricsOf', { name: c.name })}>
          <DataTable
            columns={[
              { key: 'n', header: t('network.col.fabric'), render: (f: FabricAnalysis) => f.name },
              { key: 't', header: t('network.col.tiers'), render: (f) => f.tiers.map((x) => `${x.name} ${x.switches}`).join(' / ') },
              { key: 'e', header: t('network.col.endpoints'), num: true, render: (f) => fmtInt(f.endpoints) },
              { key: 's', header: t('network.col.switches'), num: true, render: (f) => fmtInt(f.totalSwitches) },
            ]}
            rows={analysis.network.fabrics.filter((f) => f.clusterId === c.id)}
            rowKey={(f) => f.name}
          />
        </Section>
      ))}
    </>
  );
}

// ───────────── cable schedule ─────────────

function ScheduleTab() {
  const t = useT();
  const project = useApp((s) => s.project);
  const analysis = useApp((s) => s.analysis);
  const [q, setQ] = useState('');
  const data = useMemo(() => {
    if (!analysis) return undefined;
    try {
      const rows = buildCableSchedule(project, analysis);
      return { rows, summary: summarizeCableSchedule(rows, buildSwitchUnits(project, analysis)) };
    } catch (e) {
      return { error: String(e) };
    }
  }, [project, analysis]);
  if (!analysis) return <Empty>{t('network.common.noAnalysis')}</Empty>;
  if (!data || 'error' in data) return <Empty>{t('network.sch.error', { e: data && 'error' in data ? String(data.error) : '' })}</Empty>;
  const { rows, summary } = data;
  const needle = q.trim().toLowerCase();
  const filtered = needle ? rows.filter((r) => r.cableId.toLowerCase().includes(needle) || r.fromPort.toLowerCase().includes(needle) || r.toPort.toLowerCase().includes(needle) || r.cableTypeId.toLowerCase().includes(needle)) : rows;
  const types = new Map(cableTypes().map((c) => [c.id, c.name]));
  return (
    <>
      <Section title={t('network.sch.title')}>
        <p className="hint" style={{ marginBottom: 8 }}>{t('network.sch.hint')}</p>
        <div className="grid-4">
          <Stat label={t('network.sch.cables')} value={fmtInt(summary.cables)} delta={t('network.sch.matches', { n: fmtInt(analysis.network.cableRuns.reduce((s, r) => s + r.count, 0)) })} />
          <Stat label={t('network.sch.bundles')} value={fmtInt(summary.bundles)} delta="BSN" />
          <Stat label={t('network.sch.unresolved')} value={fmtInt(summary.unresolvedEnds)} delta={summary.unresolvedEnds ? t('network.sch.unresolvedBad') : 'OK'} />
          <Stat label={t('network.sch.overflow')} value={fmtInt(summary.overflowPorts)} delta={summary.overflowPorts ? t('network.sch.overflowBad') : 'OK'} />
        </div>
        <div style={{ marginTop: 8 }}>
          <DataTable
            columns={[
              { key: 'n', header: t('network.sch.net'), render: (x: (typeof summary.byNet)[number]) => x.net },
              { key: 'c', header: t('network.sch.cables'), num: true, render: (x) => fmtInt(x.cables) },
              { key: 'k', header: 'km', num: true, render: (x) => fmt1(x.lengthM / 1000) },
            ]}
            rows={summary.byNet}
            rowKey={(x) => x.net}
          />
        </div>
      </Section>
      <Section title={t('network.sch.rows')}>
        <div className="row wrap" style={{ gap: 8, marginBottom: 6 }}>
          <div className="field" style={{ minWidth: 260 }}>
            <label>{t('network.sch.search')}</label>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="IB-H1-000123 · DU01-A-07 · smf" data-testid="schedule-search" />
          </div>
          <span className="hint">{t('network.sch.showing', { n: fmtInt(Math.min(ROW_LIMIT, filtered.length)), total: fmtInt(filtered.length) })}</span>
        </div>
        <DataTable
          columns={[
            { key: 'id', header: t('network.sch.col.id'), render: (r: CableScheduleRow) => <span style={{ fontFamily: 'ui-monospace, monospace' }} title={r.labelA}>{r.cableId}</span> },
            { key: 'b', header: 'BSN', num: true, render: (r) => r.bsn ?? '' },
            { key: 't', header: t('network.sch.col.tier'), render: (r) => r.tier ?? '' },
            { key: 'f', header: t('network.sch.col.from'), render: (r) => <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11 }}>{r.fromPort}</span> },
            { key: 'to', header: t('network.sch.col.to'), render: (r) => <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11 }}>{r.toPort}</span> },
            { key: 'c', header: t('network.sch.col.type'), render: (r) => types.get(r.cableTypeId) ?? r.cableTypeId },
            { key: 'l', header: t('network.sch.col.length'), num: true, render: (r) => `${r.lengthM} m` },
            { key: 'w', header: t('network.sch.col.wave'), render: (r) => r.wave ?? '' },
          ]}
          rows={filtered.slice(0, ROW_LIMIT)}
          rowKey={(r) => r.cableId}
          maxHeight={480}
        />
      </Section>
    </>
  );
}

// ───────────── IP map: review views (location · rail / fabric · subnet) · block map · plan blocks ─────────────

type IprView = 'location' | 'rail' | 'subnet' | 'map' | 'plan';
type IprFamily = 'dual' | 'ipv4' | 'ipv6';
const IPR_ROW_H = 38;
const IPR_SUB_H = 24;
const TIER_TEXT: Record<string, string> = { 'endpoint-leaf': 'endpoint–leaf', 'leaf-spine': 'leaf–spine', 'spine-core': 'spine–core', uplink: 'uplink', 'inter-hall': 'inter-hall' };
const IPR_NETS: IpReviewNet[] = ['backend', 'frontend', 'storage', 'inband', 'oob'];
const IPR_TYPES: IpReviewDeviceType[] = ['node', 'switch', 'endpoint', 'link'];
const shortDev = (d: string | undefined) => (d ?? '').replace(/^H\d+\./, '');
const pctText = (u: number) => (u === 0 ? '0 %' : u < 0.001 ? '< 0.1 %' : `${(u * 100).toFixed(u < 0.1 ? 1 : 0)} %`);
const isIpQuery = (q: string) => /^\d+\.\d+\.\d+\.\d+(\/\d+)?$/.test(q) || /^[0-9a-f:]+(?:\/\d+)?$/i.test(q);

/** Scoped styles of the Network panel tab strip and the IP map review (kept here so shared CSS stays untouched). */
const NET_PANEL_CSS = `
[data-network-tabs] .seg.seg-wrap { gap: 6px; }
[data-network-tabs] .seg.seg-wrap button { padding: 8px 16px; font-size: 13px; min-height: 36px; font-weight: 550; }
[data-ipr-views] .seg.seg-wrap button { padding: 6px 12px; min-height: 32px; font-size: 12.5px; }
.ipr-head { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
.ipr-overview { display: grid; grid-template-columns: repeat(6,minmax(112px,1fr)); gap: 6px; }
.ipr-overview > div { min-width: 0; border: 1px solid var(--border); border-radius: var(--radius-sm,4px); background: var(--surface-1); padding: 7px 9px; display: flex; flex-direction: column; gap: 2px; }
.ipr-overview > div.warn { border-color: color-mix(in srgb,var(--warning) 55%,var(--border)); background: color-mix(in srgb,var(--warning) 7%,var(--surface-1)); }
.ipr-overview span { color: var(--text-muted); font-size: 10.5px; }
.ipr-overview strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; }
.ipr-overview small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); font-size: 10px; }
.ipr-config { padding: 5px 7px; border: 1px solid var(--border); border-radius: var(--radius-sm,4px); background: var(--surface-2); }
.ipr-config > label { display: inline-flex; align-items: center; gap: 5px; color: var(--text-muted); font-size: 11px; }
.ipr-config select,.ipr-config input { min-height: 28px; font-size: 11.5px; }
.ipr-config select { width: 58px; }
.ipr-config .ipr-prefix { flex: 1 1 285px; max-width: 430px; }
.ipr-config .ipr-prefix input { flex: 1; min-width: 170px; font-family: var(--mono,ui-monospace,monospace); }
.ipr-filters { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.ipr-filters select { min-height: 30px; font-size: 12px; max-width: 150px; min-width: 0; }
.ipr-filters select.on { border-color: var(--accent); color: var(--text-primary); }
.ipr-search { flex: 1 1 220px; min-width: 160px; min-height: 30px; font-size: 12px; box-sizing: border-box; }
.ipr-actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.ipr-list { border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-1); display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.ipr-cols { display: grid; column-gap: 10px; padding: 0 8px; height: 26px; flex: none; align-items: center; font-size: 11px; color: var(--text-muted); border-bottom: 1px solid var(--border-strong); background: var(--surface-2); white-space: nowrap; }
.ipr-row { display: grid; column-gap: 10px; padding: 0 8px; height: 100%; align-items: center; font-size: 12px; border-bottom: 1px solid var(--border); white-space: nowrap; cursor: pointer; box-sizing: border-box; }
.ipr-row > span, .ipr-cols > span, .ipr-sub > span { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.ipr-row.grp { font-weight: 560; color: var(--text-primary); }
.ipr-row.grp.d0 { background: var(--surface-2); }
.ipr-row.ent { color: var(--text-secondary); }
.ipr-row.ent.miss { color: var(--serious); }
.ipr-row:hover { background: var(--surface-3); }
.ipr-row.sel { background: var(--accent-soft); box-shadow: inset 3px 0 0 var(--accent); }
.ipr-chev { border: 0; background: transparent; color: var(--text-muted); width: 20px; height: 22px; padding: 0; cursor: pointer; font-size: 11px; vertical-align: middle; }
.ipr-chip { display: inline-block; font-size: 9.5px; letter-spacing: .02em; text-transform: uppercase; color: var(--text-muted); border: 1px solid var(--border); border-radius: 4px; padding: 0 4px; margin-right: 6px; line-height: 14px; font-weight: 500; vertical-align: 1px; }
.ipr-mono { font-family: var(--mono, ui-monospace, monospace); font-size: 11.5px; }
.ipr-address { display: flex; flex-direction: column; justify-content: center; min-width: 0; line-height: 15px; }
.ipr-address > span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ipr-address b { display: inline-block; width: 18px; margin-right: 3px; color: var(--text-muted); font-size: 9px; font-weight: 650; text-transform: uppercase; }
.ipr-address.ipv4 > span,.ipr-address.ipv6 > span { line-height: 28px; }
.ipr-family-pill { display: inline-block; min-width: 42px; padding: 1px 6px; border: 1px solid var(--border); border-radius: 9px; font: 10px var(--mono,ui-monospace,monospace); text-align: center; }
.ipr-map-view > .section:first-child { margin-bottom: 10px; }
.ipr-muted { color: var(--text-muted); font-weight: 400; }
.ipr-meter { display: inline-block; width: 46px; height: 6px; border-radius: 3px; background: var(--surface-3); overflow: hidden; vertical-align: middle; margin-right: 6px; }
.ipr-meter > i { display: block; height: 100%; background: var(--accent); }
[data-ipr] mark { background: color-mix(in srgb, var(--warning) 45%, transparent); color: inherit; border-radius: 2px; padding: 0 1px; }
.ipr-detail { border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-1); padding: 10px 12px; overflow: auto; min-height: 0; display: flex; flex-direction: column; gap: 8px; box-sizing: border-box; }
.ipr-detail h3 { margin: 0; font-size: 13px; display: flex; align-items: center; gap: 6px; }
.ipr-detail h4 { margin: 2px 0 0; font-size: 11.5px; color: var(--text-muted); font-weight: 600; }
.ipr-kv { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 3px 12px; font-size: 12px; margin: 0; }
.ipr-kv dt { color: var(--text-muted); }
.ipr-kv dd { margin: 0; overflow-wrap: anywhere; }
.ipr-sub { display: grid; column-gap: 10px; padding: 0 6px; height: 100%; align-items: center; font-size: 11.5px; border-bottom: 1px solid var(--border); white-space: nowrap; box-sizing: border-box; }
.ipr-box { border: 1px solid var(--border); border-radius: var(--radius-sm, 4px); overflow: hidden; flex: none; }
.ipr-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.ipr-chips span { font-family: var(--mono, ui-monospace, monospace); font-size: 11px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 4px; padding: 0 5px; }
@media (max-width: 1100px) { .ipr-overview { grid-template-columns: repeat(3,minmax(120px,1fr)); } }
@media (max-width: 650px) { .ipr-overview { grid-template-columns: repeat(2,minmax(110px,1fr)); } }
`;

/** Marks the first needle of `q` (in order of preference) that occurs in `text`. `ip`: an IPv4 query marks whole addresses only —
 *  a gateway search lists the hosts behind it, and "10.40.0.1" must not be marked inside "10.40.0.12" (QA ipmap review v2 2차). */
function Hl({ text, q, ip }: { text: string; q: string | string[]; ip?: boolean }) {
  if (!text) return <>{text}</>;
  const lower = text.toLowerCase();
  const find = (n: string, from: number) => {
    for (let k = lower.indexOf(n, from); k >= 0; k = lower.indexOf(n, k + 1)) {
      if (!ip || (!/[\d.]/.test(lower.charAt(k - 1)) && !/\d/.test(lower.charAt(k + n.length)))) return k;
    }
    return -1;
  };
  const needle = (Array.isArray(q) ? q : [q]).find((n) => !!n && find(n, 0) >= 0);
  if (!needle) return <>{text}</>;
  const out: ReactNode[] = [];
  let i = 0;
  for (let k = find(needle, 0); k >= 0; k = find(needle, i)) {
    if (k > i) out.push(text.slice(i, k));
    out.push(<mark key={k}>{text.slice(k, k + needle.length)}</mark>);
    i = k + needle.length;
  }
  if (i < text.length) out.push(text.slice(i));
  return <>{out}</>;
}

/** Fixed-row-height virtual list: only the visible rows (+ overscan) are in the DOM, so the full plan scrolls in-app. */
function VirtualList({ count, height, rowHeight, keyOf, render, resetKey, testId }: {
  count: number; height: number; rowHeight: number; keyOf: (i: number) => string; render: (i: number) => ReactNode; resetKey?: unknown; testId?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = 0;
    setTop(0);
  }, [resetKey]);
  const first = Math.max(0, Math.floor(top / rowHeight) - 8);
  const last = Math.min(count, Math.ceil((top + height) / rowHeight) + 8);
  const items: ReactNode[] = [];
  for (let i = first; i < last; i++) items.push(<div key={keyOf(i)} style={{ position: 'absolute', top: i * rowHeight, left: 0, right: 0, height: rowHeight }}>{render(i)}</div>);
  return (
    <div ref={ref} style={{ height: Math.max(0, height), overflowY: 'auto', overflowX: 'hidden', position: 'relative' }} onScroll={(e) => setTop(e.currentTarget.scrollTop)} data-testid={testId} data-rows={count}>
      <div style={{ height: count * rowHeight, position: 'relative' }}>{items}</div>
    </div>
  );
}

/** Height from the element's top to the bottom of the scrolling panel body (the review fills the panel instead of a short box). */
function useFillHeight(ref: RefObject<HTMLElement | null>, watch: RefObject<HTMLElement | null>, min: number, active: boolean): number {
  const [h, setH] = useState(560);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !active) return;
    const body = el.closest('.panel-body') as HTMLElement | null;
    const measure = () => {
      const node = ref.current;
      if (!node) return;
      if (!body) return setH(Math.max(min, Math.floor(window.innerHeight - node.getBoundingClientRect().top - 16)));
      const top = node.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop;
      const pad = parseFloat(getComputedStyle(body).paddingBottom) || 0;
      setH(Math.max(min, Math.floor(body.clientHeight - top - pad)));
    };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    if (body) ro?.observe(body);
    if (watch.current) ro?.observe(watch.current);
    window.addEventListener('resize', measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [ref, watch, min, active]);
  return h;
}

function useWidth(ref: RefObject<HTMLElement | null>, active: boolean): number {
  const [w, setW] = useState(600);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !active) return;
    const measure = () => setW(Math.floor(el.clientWidth));
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [ref, active]);
  return w;
}

interface IprRow { id: string; depth: number; group?: IpReviewGroup; entry?: IpReviewEntry }

function IpTab() {
  const t = useT();
  const uiLocale = useApp((s) => s.uiLocale);
  const project = useApp((s) => s.project);
  const analysis = useApp((s) => s.analysis);
  const update = useApp((s) => s.update);
  const setPage = useApp((s) => s.setPage);
  const wide = useApp((s) => s.panelWide && !s.panelCollapsed);
  const numbered = project.network.addressing?.fabricLinks === 'numbered';
  const dualStack = project.network.addressing?.mode !== 'ipv4';
  const planes = project.network.addressing?.planes ?? 1;
  const setAddressing = (patch: Partial<NonNullable<NetworkDesign['addressing']>>) => update((d) => { d.network.addressing = { ...(d.network.addressing ?? {}), ...patch }; });
  const setNumbered = (value: boolean) => setAddressing({ fabricLinks: value ? 'numbered' : 'unnumbered' });
  const [view, setView] = useState<IprView>('rail');
  const [family, setFamily] = useState<IprFamily>('dual');
  const [filter, setFilter] = useState<IpReviewFilter>({});
  const [queryText, setQueryText] = useState('');
  const [expanded, setExpanded] = useState<Record<string, Set<string>>>({});
  const [searchCollapsed, setSearchCollapsed] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const isReview = view === 'location' || view === 'rail' || view === 'subnet';

  useEffect(() => {
    const h = setTimeout(() => setFilter((f) => ((f.query ?? '') === queryText ? f : { ...f, query: queryText })), 180);
    return () => clearTimeout(h);
  }, [queryText]);
  useEffect(() => setSearchCollapsed(new Set()), [filter.query]);
  useEffect(() => { if (!dualStack && family !== 'ipv4') setFamily('ipv4'); }, [dualStack, family]);

  const review = useMemo(() => {
    if (!analysis) return undefined;
    try {
      return buildIpReview(project, analysis, { locale: uiLocale === 'ko' ? 'ko' : 'en' });
    } catch (e) {
      console.warn('[ip map]', e);
      return undefined;
    }
  }, [project, analysis, uiLocale]);
  const filtered = useMemo(() => (review ? filterIpReview(review, filter) : []), [review, filter]);
  // grouped trees of the last few (view, filter) states: grouping ~255k addresses takes ~1 s, so clearing a search or switching back to a
  // view reuses the tree (QA ipmap review v2 2차); a new review model (project change, numbered toggle) starts an empty cache
  const treeCache = useMemo(() => new Map<string, IpReviewGroup>(), [review]);
  const filterKey = [filter.hallId, filter.pod, filter.rackTag, filter.net, filter.rail, filter.deviceType, (filter.query ?? '').trim().toLowerCase()].map((x) => x ?? '').join('|');
  const tree = useMemo(() => {
    if (!review || !isReview) return undefined;
    const key = `${view}|${filterKey}`;
    const hit = treeCache.get(key);
    if (hit) return hit;
    const built = view === 'rail' ? groupIpPlanByRail(review, filtered) : view === 'subnet' ? groupIpPlanBySubnet(review, filtered) : groupIpPlanByLocation(review, filtered);
    if (treeCache.size >= 6) treeCache.delete(treeCache.keys().next().value!);
    treeCache.set(key, built);
    return built;
  }, [review, filtered, view, isReview, filterKey, treeCache]);
  const groupsById = useMemo(() => {
    const m = new Map<string, IpReviewGroup>();
    const walk = (g: IpReviewGroup) => {
      m.set(g.id, g);
      g.children.forEach(walk);
    };
    if (tree) walk(tree);
    return m;
  }, [tree]);

  const needle = (filter.query ?? '').trim().toLowerCase();
  const searching = needle.length > 0;
  const userOpen = expanded[view];
  const isOpen = useCallback((id: string, depth: number) => (searching ? !searchCollapsed.has(id) : userOpen ? userOpen.has(id) : depth === 0), [searching, searchCollapsed, userOpen]);
  const toggle = (id: string, depth: number) => {
    if (searching) {
      setSearchCollapsed((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      return;
    }
    setExpanded((prev) => {
      const cur = new Set(prev[view] ?? (tree ? tree.children.map((c) => c.id) : []));
      if (cur.has(id) || (!prev[view] && depth === 0 && cur.has(id))) cur.delete(id);
      else cur.add(id);
      return { ...prev, [view]: cur };
    });
  };
  const expandAll = () => {
    if (searching) setSearchCollapsed(new Set());
    else setExpanded((prev) => ({ ...prev, [view]: new Set([...groupsById.keys()].filter((k) => k !== 'root')) }));
  };
  const collapseAll = () => {
    if (searching) setSearchCollapsed(new Set([...groupsById.keys()]));
    else setExpanded((prev) => ({ ...prev, [view]: new Set() }));
  };

  const rows = useMemo(() => {
    const out: IprRow[] = [];
    if (!tree) return out;
    const rec = (g: IpReviewGroup, depth: number) => {
      for (const c of g.children) {
        out.push({ id: c.id, depth, group: c });
        if (isOpen(c.id, depth)) {
          rec(c, depth + 1);
          for (const e of c.entries) out.push({ id: `e:${e.key}`, depth: depth + 1, entry: e });
        }
      }
    };
    rec(tree, 0);
    return out;
  }, [tree, isOpen]);

  const selGroup = selected ? groupsById.get(selected) : undefined;
  const selEntry = selected?.startsWith('e:') && review ? filtered.find((e) => `e:${e.key}` === selected) : undefined;
  const selMembers = useMemo(() => (selGroup ? ipReviewGroupEntries(selGroup) : []), [selGroup]);

  const fillH = useFillHeight(bodyRef, headRef, 380, isReview && !!review);
  const bodyW = useWidth(bodyRef, isReview && !!review);
  const split = wide || bodyW >= 1100;
  const detailOpen = !split && !!(selGroup || selEntry);
  const detailH = detailOpen ? Math.max(180, Math.round(fillH * 0.38)) : 0;
  const listH = split ? fillH : fillH - detailH - (detailOpen ? 8 : 0);
  const listW = useWidth(listRef, isReview && !!review);
  const layout = listW >= 960 ? 'full' : listW >= 680 ? 'mid' : 'compact';
  const cols = layout === 'full' ? 'minmax(0,1.5fr) 200px minmax(0,1fr) 190px 130px' : layout === 'mid' ? 'minmax(0,1.4fr) 130px minmax(0,1fr) 140px 100px' : 'minmax(0,1.3fr) minmax(0,1fr) 92px';
  const showCounts = layout !== 'compact';

  if (!analysis) return <Empty>{t('network.common.noAnalysis')}</Empty>;
  if (!review) return <Empty>{t('network.common.noAnalysis')}</Empty>;
  const { plan } = review;
  const addressBlocks = [
    ...plan.blocks.map((b) => ({ ...b, family: 'IPv4' as const })),
    ...(plan.ipv6Blocks ?? []).map((b) => ({ ...b, family: 'IPv6' as const })),
  ];
  const mono = { fontFamily: 'var(--mono, ui-monospace, monospace)', fontSize: 11 } as const;
  const cidrOf = (key: string) => {
    const s = review.subnetByKey.get(key);
    return s ? prefixOf(s.start, s.size) ?? rangeLabel(s.start, s.size) : '';
  };
  const hallName = (id?: string) => review.halls.find((h) => h.id === id)?.name ?? id ?? '';
  const podName = (hallId?: string, pod?: string) => (pod === 'unassigned' ? t('network.ipr.unassigned') : review.pods.find((p) => p.hallId === hallId && p.id === pod)?.label ?? pod ?? '');

  const groupLabel = (g: IpReviewGroup): string => {
    switch (g.kind) {
      case 'net': return t(`network.ipr.net.${g.code}`);
      case 'rail': return g.code === 'no-rail' ? t('network.ipr.noRail') : t('network.ipr.rail', { n: g.rail ?? '' });
      case 'links': return t(g.id.includes('|up:') ? 'network.ipr.uplinks' : 'network.ipr.links', { tier: TIER_TEXT[g.code ?? ''] ?? g.code ?? '' });
      case 'none': return t(`network.ipr.none.${g.code}`);
      case 'pod': return g.code === 'unassigned' ? t('network.ipr.unassigned') : g.label;
      default: return g.label;
    }
  };
  const countsText = (g: IpReviewGroup): string => {
    const parts: string[] = [];
    if (g.nodes) parts.push(t('network.ipr.c.nodes', { n: fmtInt(g.nodes) }));
    if (g.switches && g.kind !== 'device' && g.kind !== 'switch') parts.push(t('network.ipr.c.switches', { n: fmtInt(g.switches) }));
    if (g.endpoints && g.kind !== 'device') parts.push(t('network.ipr.c.endpoints', { n: fmtInt(g.endpoints) }));
    if (g.nics) parts.push(t('network.ipr.c.nics', { n: fmtInt(g.nics) }));
    if (g.links) parts.push(t('network.ipr.c.links', { n: fmtInt(g.links) }));
    if (g.loopbacks && g.kind !== 'device') parts.push(t('network.ipr.c.loopbacks', { n: fmtInt(g.loopbacks) }));
    return parts.join(' · ');
  };
  const groupAddress = (g: IpReviewGroup): { v4: string; v6: string } => {
    const v4 = (g.kind === 'device' || g.kind === 'switch') && g.loopback
      ? `lo ${g.loopback}${g.subnetKeys.length > 1 ? ` · ${t('network.ipr.c.subnets', { n: g.subnetKeys.length })}` : ''}`
      : g.cidr ? g.cidr : !g.subnetKeys.length ? '' : g.subnetKeys.length === 1 ? cidrOf(g.subnetKeys[0]) : `${cidrOf(g.subnetKeys[0])} ${t('network.ipr.more', { n: g.subnetKeys.length - 1 })}`;
    const v6 = (g.kind === 'device' || g.kind === 'switch') && g.ipv6Loopback
      ? `lo ${g.ipv6Loopback}/128`
      : !g.ipv6Prefixes.length ? '' : g.ipv6Prefixes.length === 1 ? g.ipv6Prefixes[0] : `${g.ipv6Prefixes[0]} ${t('network.ipr.more', { n: g.ipv6Prefixes.length - 1 })}`;
    return { v4, v6 };
  };
  const groupGw = (g: IpReviewGroup): { v4: string; v6: string } => {
    const gw = g.gateways.length ? `${g.gateways[0]}${g.gateways.length > 1 ? ` ${t('network.ipr.more', { n: g.gateways.length - 1 })}` : ''}` : '';
    const gw6 = g.ipv6Gateways.length ? `${g.ipv6Gateways[0]}${g.ipv6Gateways.length > 1 ? ` ${t('network.ipr.more', { n: g.ipv6Gateways.length - 1 })}` : ''}` : '';
    const vl = g.vlans.length ? `VLAN ${g.vlans.join(',')}` : '';
    return { v4: [gw, vl].filter(Boolean).join(' · '), v6: gw6 };
  };
  const utilCell = (g: IpReviewGroup): ReactNode => {
    if ((g.kind === 'device' || g.kind === 'switch') && g.asn) return <span className="ipr-mono">AS {g.asn}</span>;
    if (!g.size) return '';
    return <><span className="ipr-meter"><i style={{ width: `${Math.max(g.used ? 3 : 0, Math.min(100, g.utilisation * 100))}%` }} /></span><span className="ipr-mono">{pctText(g.utilisation)}</span></>;
  };
  const entryName = (e: IpReviewEntry): string => {
    if (e.kind === 'link') return `${e.linkId} ${view === 'location' ? e.port ?? '' : shortDev(e.a)} → ${shortDev(e.b)}`;
    if (view === 'location') return e.port ?? (e.kind === 'loopback' ? 'loopback' : shortDev(e.device));
    return `${shortDev(e.device)}${e.port ? `:${e.port}` : ''}`;
  };
  const entryContext = (e: IpReviewEntry): string => {
    if (view === 'location') return [e.rail !== undefined ? t('network.ipr.rail', { n: e.rail }) : '', e.role ? TIER_TEXT[e.role] ?? e.role : '', e.switchDevice && e.kind !== 'link' && e.kind !== 'loopback' ? `→ ${shortDev(e.switchDevice)}` : ''].filter(Boolean).join(' · ');
    return [e.rackTag, view === 'subnet' && e.switchDevice ? `→ ${shortDev(e.switchDevice)}` : ''].filter(Boolean).join(' · ');
  };
  const entryAddresses = (e: IpReviewEntry): { v4: string; v6: string } => {
    const absent = e.unresolved ? t('network.ipr.unresolved') : e.noIp ? t('network.ipr.noIp') : '';
    const v4 = e.ip ? `${e.ip}/${e.prefix}` : e.kind === 'link' ? e.cidr ?? t('network.ipr.unnumbered') : absent;
    const v6 = e.ipv6 ? `${e.ipv6}/${e.ipv6Prefix}` : e.kind === 'link' ? e.ipv6Cidr ?? (e.unnumbered ? t('network.ipr.linkLocal') : '') : absent;
    return { v4, v6 };
  };
  const hq = isIpQuery(needle) && needle.includes('/') ? '' : needle;
  const hqIp = !!hq && isIpQuery(hq);
  // list names drop the hall prefix (shortDev), so `H1.DU05-B-01-U38:N01:fe0` is marked as `DU05-B-01-U38:N01:fe0`; the location view names
  // an entry by its port under its device row, so a `device:port` query marks the device row and the port
  const hqShort = hq.replace(/^h\d+\./, '');
  const hqCut = hqShort.lastIndexOf(':');
  const hlGroup = [hq, hqShort, hqCut > 0 ? hqShort.slice(0, hqCut) : ''];
  const hlEntryName = (e: IpReviewEntry) => (view === 'location' && hqCut > 0 && `${shortDev(e.device)}:${e.port ?? ''}`.toLowerCase().includes(hqShort) ? [hq, hqShort, hqShort.slice(hqCut + 1)] : [hq, hqShort]);
  const familyValue = (a: { v4: string; v6: string }, q: string | string[] = hlGroup): ReactNode => {
    const values = family === 'ipv4' ? [['4', a.v4]] : family === 'ipv6' ? [['6', a.v6]] : [['4', a.v4], ['6', a.v6]];
    return <span className={`ipr-address ${family}`}>{values.filter(([, v]) => !!v).map(([f, v]) => <span key={f}><b>v{f}</b><Hl text={v} q={q} ip={hqIp} /></span>)}</span>;
  };

  const renderRow = (r: IprRow) => {
    if (r.group) {
      const g = r.group;
      const open = isOpen(g.id, r.depth);
      const counts = countsText(g);
      return (
        <div
          className={`ipr-row grp d${Math.min(r.depth, 3)} ${selected === g.id ? 'sel' : ''}`} style={{ gridTemplateColumns: cols }} data-ipr-row={g.kind} data-ipr-id={g.id} data-open={open ? '1' : '0'}
          title={[groupLabel(g), counts, g.subnetKeys.slice(0, 12).map(cidrOf).join(' '), g.ipv6Prefixes.slice(0, 12).join(' '), g.gateways.slice(0, 6).join(' '), g.ipv6Gateways.slice(0, 6).join(' ')].filter(Boolean).join('\n')}
          onClick={() => {
            setSelected(g.id);
            if (!open) toggle(g.id, r.depth);
          }}
        >
          <span style={{ paddingLeft: r.depth * 14 }}>
            <button type="button" className="ipr-chev" data-ro-allow aria-expanded={open} aria-label={groupLabel(g)} onClick={(ev) => { ev.stopPropagation(); toggle(g.id, r.depth); }}>{open ? '▾' : '▸'}</button>
            <span className="ipr-chip">{t(`network.ipr.kind.${g.kind}`)}</span>
            <Hl text={groupLabel(g)} q={hlGroup} ip={hqIp} />
            {!showCounts && counts && <span className="ipr-muted"> · {counts}</span>}
          </span>
          {showCounts && <span className="ipr-muted">{counts}</span>}
          <span className="ipr-mono">{familyValue(groupAddress(g))}</span>
          {showCounts && <span className="ipr-mono">{familyValue(groupGw(g))}</span>}
          <span>{utilCell(g)}</span>
        </div>
      );
    }
    const e = r.entry!;
    return (
      <div className={`ipr-row ent ${e.unresolved ? 'miss' : ''} ${selected === r.id ? 'sel' : ''}`} style={{ gridTemplateColumns: cols }} data-ipr-row="entry" data-ipr-key={e.key} onClick={() => setSelected(r.id)} title={e.search.split('\n').slice(0, 8).join(' · ')}>
        <span style={{ paddingLeft: r.depth * 14 + 20 }}>
          <span className="ipr-chip">{t(`network.ipr.entry.${e.kind}`)}</span>
          <span className="ipr-mono"><Hl text={entryName(e)} q={hlEntryName(e)} ip={hqIp} /></span>
        </span>
        {showCounts && <span className="ipr-muted"><Hl text={entryContext(e)} q={hlGroup} ip={hqIp} /></span>}
        <span className="ipr-mono">{familyValue(entryAddresses(e))}</span>
        {showCounts && <span className="ipr-mono">{familyValue({ v4: [e.gw, e.vlan !== undefined ? `VLAN ${e.vlan}` : ''].filter(Boolean).join(' · '), v6: e.ipv6Gw ?? '' })}</span>}
        <span className="ipr-mono">{e.asn ? <Hl text={`AS ${e.asn}`} q={hlGroup} ip={hqIp} /> : ''}</span>
      </div>
    );
  };

  // Unicode letters stay (a KO selection "레일 3" → `…-레일_3.csv`, "미지정" is not emptied)
  const slug = (s: string) => s.replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 60);
  const csvView = () => tree && downloadText(ipReviewCsv(review, ipReviewGroupEntries(tree)), `${project.id}-ip-${view}.csv`, 'text/csv;charset=utf-8');
  const csvSelection = () => {
    if (selGroup) downloadText(ipReviewCsv(review, selMembers), `${project.id}-ip-${view}-${slug(groupLabel(selGroup))}.csv`, 'text/csv;charset=utf-8');
    else if (selEntry) downloadText(ipReviewCsv(review, [selEntry]), `${project.id}-ip-${slug(selEntry.key)}.csv`, 'text/csv;charset=utf-8');
  };
  const selName = selGroup ? groupLabel(selGroup) : selEntry ? entryName(selEntry) : '';

  const filterSelect = (label: string, value: string, options: { value: string; label: string }[], onChange: (v: string) => void, key: string) => (
    <select key={key} className={value ? 'on' : ''} title={label} aria-label={label} data-ro-allow data-ipr-filter={key} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{`${label}: ${t('network.ipr.filter.all')}`}</option>
      {options.map((o) => <option key={o.value} value={o.value}>{`${label}: ${o.label}`}</option>)}
    </select>
  );
  const hallsWithEntries = new Set(review.racks.map((r) => r.hallId));
  const multiHall = hallsWithEntries.size > 1;
  const podOptions = review.pods.filter((p) => !filter.hallId || p.hallId === filter.hallId).map((p) => ({ value: `${p.hallId}|${p.id}`, label: `${p.id === 'unassigned' ? t('network.ipr.unassigned') : p.label}${multiHall && !filter.hallId ? ` · ${hallName(p.hallId)}` : ''}` }));
  const rackOptions = review.racks.filter((r) => (!filter.hallId || r.hallId === filter.hallId) && (!filter.pod || r.pod === filter.pod)).map((r) => ({ value: `${r.hallId}|${r.tag}`, label: `${r.tag}${multiHall && !filter.hallId ? ` · ${hallName(r.hallId)}` : ''}` }));
  const groupCount = Math.max(0, groupsById.size - 1);
  const filtersActive = !!(filter.hallId || filter.pod || filter.rackTag || filter.net || filter.rail !== undefined || filter.deviceType || queryText);
  const ipv6Count = review.entries.filter((e) => !!(e.ipv6 || e.ipv6Cidr)).length;
  const unresolvedCount = review.entries.filter((e) => e.unresolved).length;
  const ipv6MissingCount = dualStack ? review.entries.filter((e) => (e.ip || (e.cidr && !e.unnumbered)) && !(e.ipv6 || e.ipv6Cidr)).length : 0;

  const detail = () => {
    if (!selGroup && !selEntry) return <div className="ipr-detail" data-ipr-detail><p className="hint" style={{ margin: 0 }}>{t('network.ipr.detail.empty')}</p></div>;
    const closeBtn = !split && <button type="button" className="btn ghost sm" data-ro-allow style={{ marginLeft: 'auto' }} onClick={() => setSelected(null)}>{t('network.ipr.detail.close')}</button>;
    const csvBtn = <button type="button" className="btn sm" data-ro-allow onClick={csvSelection} data-ipr-csv-selection>{t('network.ipr.csvSelection', { name: selName.length > 28 ? `${selName.slice(0, 27)}…` : selName })}</button>;
    if (selEntry) {
      const e = selEntry;
      const s = e.subnetKey ? review.subnetByKey.get(e.subnetKey) : undefined;
      const free = e.subnetKey ? review.freeBySubnet.get(e.subnetKey) : undefined;
      const kv: [string, ReactNode][] = [
        [t('network.ipr.filter.type'), t(`network.ipr.type.${e.deviceType}`)],
        [t('network.ipr.kind.device'), <span style={mono}>{e.device}{e.port ? `:${e.port}` : ''}</span>],
        ['IPv4', <span style={mono}>{entryAddresses(e).v4 || '—'}</span>],
        ...(e.gw ? [[t('network.ipr.ipv4Gw'), <span style={mono}>{e.gw}</span>] as [string, ReactNode]] : []),
        ...(dualStack ? [['IPv6', <span style={mono}>{entryAddresses(e).v6 || '—'}</span>] as [string, ReactNode]] : []),
        ...(e.ipv6Gw ? [[t('network.ipr.ipv6Gw'), <span style={mono}>{e.ipv6Gw}</span>] as [string, ReactNode]] : []),
        ...(e.vlan !== undefined ? [['VLAN', e.vlan] as [string, ReactNode]] : []),
        ...(e.asn ? [['ASN', <span style={mono}>{e.asn}</span>] as [string, ReactNode]] : []),
        ...(e.kind === 'link' ? [['A', <span style={mono}>{e.a}</span>], ['B', <span style={mono}>{e.b}</span>]] as [string, ReactNode][] : []),
        [t('network.ipr.filter.fabric'), t(`network.ipr.net.${e.net}`)],
        ...(e.rail !== undefined ? [[t('network.ipr.filter.rail'), e.rail] as [string, ReactNode]] : []),
        ...(e.switchDevice && e.kind !== 'link' ? [[t('network.ipr.kind.switch'), <span style={mono}>{e.switchDevice}</span>] as [string, ReactNode]] : []),
        [t('network.ipr.filter.hall'), hallName(e.hallId)],
        [t('network.ipr.filter.du'), podName(e.hallId, e.pod)],
        [t('network.ipr.filter.rack'), e.rackTag ?? ''],
        ...(e.role ? [[t('network.ipr.kind.tier'), TIER_TEXT[e.role] ?? e.role] as [string, ReactNode]] : []),
        ...(s ? [[t('network.ipr.kind.subnet'), <span style={mono}>{cidrOf(s.key)} · {s.label}</span>], [t('network.ipr.detail.free'), `${fmtInt(free?.free ?? 0)} · ${t('network.ipr.detail.used', { used: fmtInt(s.used), size: fmtInt(s.size) })}`]] as [string, ReactNode][] : []),
      ];
      return (
        <div className="ipr-detail" data-ipr-detail>
          <h3><span className="ipr-chip">{t(`network.ipr.entry.${e.kind}`)}</span><span style={mono}>{entryName(e)}</span>{closeBtn}</h3>
          <dl className="ipr-kv">{kv.map(([k, v], i) => <Fragment key={i}><dt>{k}</dt><dd>{v}</dd></Fragment>)}</dl>
          <div className="ipr-actions">{csvBtn}</div>
        </div>
      );
    }
    const g = selGroup!;
    const subH = Math.min(8, g.subnetKeys.length) * IPR_SUB_H;
    const kv: [string, ReactNode][] = [
      [t('network.ipr.col.counts'), countsText(g) || '—'],
      ...(g.size ? [[t('ipmap.legend'), `${pctText(g.utilisation)} · ${t('network.ipr.detail.used', { used: fmtInt(g.used), size: fmtInt(g.size) })}`] as [string, ReactNode]] : []),
      ...(g.cidr ? [['CIDR', <span style={mono}>{g.cidr}</span>] as [string, ReactNode]] : []),
      ...(g.purpose ? [[t('network.ip.col.purpose'), g.purpose] as [string, ReactNode]] : []),
      ...(g.loopback ? [[t('network.ipr.detail.loopback'), <span style={mono}>{g.loopback}/32</span>] as [string, ReactNode]] : []),
      ...(g.ipv6Loopback ? [[t('network.ipr.detail.loopback6'), <span style={mono}>{g.ipv6Loopback}/128</span>] as [string, ReactNode]] : []),
      ...(g.asn ? [[t('network.ipr.detail.asn'), <span style={mono}>{g.asn}</span>] as [string, ReactNode]] : []),
      ...(g.rail !== undefined ? [[t('network.ipr.filter.rail'), g.rail] as [string, ReactNode]] : []),
      ...(g.free ? [[t('network.ipr.detail.free'), fmtInt(g.free.free)], [t('network.ipr.detail.freeRanges'), <span style={mono}>{g.free.ranges.join(' · ')}{g.free.rangeCount > g.free.ranges.length ? ` ${t('network.ipr.more', { n: g.free.rangeCount - g.free.ranges.length })}` : ''}</span>]] as [string, ReactNode][] : []),
      ...(g.gateways.length ? [[t('network.ipr.detail.gateways'), <div className="ipr-chips">{g.gateways.slice(0, 24).map((x) => <span key={x}>{x}</span>)}{g.gateways.length > 24 && <em className="ipr-muted">{t('network.ipr.more', { n: g.gateways.length - 24 })}</em>}</div>] as [string, ReactNode]] : []),
      ...(g.ipv6Gateways.length ? [[t('network.ipr.detail.gateways6'), <div className="ipr-chips">{g.ipv6Gateways.slice(0, 24).map((x) => <span key={x}>{x}</span>)}{g.ipv6Gateways.length > 24 && <em className="ipr-muted">{t('network.ipr.more', { n: g.ipv6Gateways.length - 24 })}</em>}</div>] as [string, ReactNode]] : []),
      ...(g.ipv6Prefixes.length ? [[t('network.ipr.detail.prefixes6'), <div className="ipr-chips">{g.ipv6Prefixes.slice(0, 24).map((x) => <span key={x}>{x}</span>)}{g.ipv6Prefixes.length > 24 && <em className="ipr-muted">{t('network.ipr.more', { n: g.ipv6Prefixes.length - 24 })}</em>}</div>] as [string, ReactNode]] : []),
      ...(g.vlans.length ? [[t('network.ipr.detail.vlans'), g.vlans.join(', ')] as [string, ReactNode]] : []),
    ];
    return (
      <div className="ipr-detail" data-ipr-detail>
        <h3><span className="ipr-chip">{t(`network.ipr.kind.${g.kind}`)}</span><span>{groupLabel(g)}</span>{closeBtn}</h3>
        <dl className="ipr-kv">{kv.map(([k, v], i) => <Fragment key={i}><dt>{k}</dt><dd>{v}</dd></Fragment>)}</dl>
        <div className="ipr-actions">{csvBtn}</div>
        {g.subnetKeys.length > 0 && g.kind !== 'subnet' && (
          <>
            <h4>{t('network.ipr.detail.subnets', { n: fmtInt(g.subnetKeys.length) })}</h4>
            <div className="ipr-box">
              <VirtualList count={g.subnetKeys.length} height={subH} rowHeight={IPR_SUB_H} resetKey={g.id} keyOf={(i) => g.subnetKeys[i]} render={(i) => {
                const s = review.subnetByKey.get(g.subnetKeys[i])!;
                return <div className="ipr-sub" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.2fr) 88px 52px' }}><span className="ipr-mono">{cidrOf(s.key)}</span><span className="ipr-muted">{s.label}</span><span className="ipr-mono">{fmtInt(s.used)}/{fmtInt(s.size)}</span><span className="ipr-mono">{pctText(s.used / s.size)}</span></div>;
              }} />
            </div>
          </>
        )}
        <h4>{t('network.ipr.detail.members', { n: fmtInt(selMembers.length) })}</h4>
        <div className="ipr-box">
          <VirtualList count={selMembers.length} height={Math.min(selMembers.length, 12) * IPR_SUB_H} rowHeight={IPR_SUB_H} resetKey={g.id} keyOf={(i) => selMembers[i].key} render={(i) => {
            const e = selMembers[i];
            return <div className="ipr-sub" style={{ gridTemplateColumns: 'minmax(0,1.3fr) minmax(0,1.4fr) minmax(0,.8fr)' }}><span className="ipr-mono">{e.kind === 'link' ? e.linkId : `${shortDev(e.device)}${e.port ? `:${e.port}` : ''}`}</span><span className="ipr-mono">{familyValue(entryAddresses(e))}</span><span className="ipr-mono ipr-muted">{family === 'ipv6' ? e.ipv6Gw : e.gw ?? (e.asn ? `AS ${e.asn}` : '')}</span></div>;
          }} />
        </div>
      </div>
    );
  };

  return (
    <div data-ipr>
      <div ref={headRef} className="ipr-head">
        <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
          <div data-ipr-views>
            <Seg wrap value={view} onChange={(v) => { setView(v); setSelected(null); }} options={[
              { value: 'location', label: t('network.ipr.view.location') },
              { value: 'rail', label: t('network.ipr.view.rail') },
              { value: 'subnet', label: t('network.ipr.view.subnet') },
              { value: 'map', label: t('network.ipr.view.map') },
              { value: 'plan', label: t('network.ipr.view.plan') },
            ]} />
          </div>
          <span className="grow" />
          <span className="hint" style={{ cursor: 'help' }} title={t('network.ipr.hint')}>ⓘ</span>
        </div>
        <div className="ipr-overview" data-ipr-overview>
          <div><span>{t('network.ipr.summary.mode')}</span><strong>{dualStack ? t('network.ipr.dualStack') : 'IPv4'}</strong><small>{fmtInt(ipv6Count)} IPv6</small></div>
          <div><span>IPv4</span><strong className="ipr-mono">{plan.ipv4Prefix ?? `${project.network.addressing?.ipv4FirstOctet ?? 10}.0.0.0/8`}</strong><small>{t('network.ipr.summary.allocated', { n: fmtInt(review.entries.length) })}</small></div>
          <div><span>IPv6</span><strong className="ipr-mono">{plan.ipv6Prefix ?? '—'}</strong><small>{dualStack ? t('network.ipr.summary.prefixes', { n: plan.ipv6Blocks?.length ?? 0 }) : t('network.ipr.disabled')}</small></div>
          <div><span>{t('network.ipr.summary.fabric')}</span><strong>{numbered ? t('network.ipr.numbered') : t('network.ipr.unnumbered')}</strong><small>{numbered ? 'IPv4 /31 · IPv6 /127' : t('network.ipr.linkLocal')}</small></div>
          <div><span>{t('network.ipr.summary.rails')}</span><strong>{fmtInt(review.rails.length)}</strong><small>{t('network.ipr.summary.planes', { n: planes })}</small></div>
          <div className={unresolvedCount || review.map.outside.length || ipv6MissingCount ? 'warn' : ''}><span>{t('network.ipr.summary.validation')}</span><strong>{unresolvedCount + review.map.outside.length + ipv6MissingCount ? fmtInt(unresolvedCount + review.map.outside.length + ipv6MissingCount) : t('network.ipr.summary.ok')}</strong><small>{t('network.ipr.summary.issues', { unresolved: unresolvedCount, outside: review.map.outside.length, ipv6: ipv6MissingCount })}</small></div>
        </div>
        <div className="ipr-config row wrap" style={{ gap: 8, alignItems: 'center' }}>
          <Toggle label={t('network.ipr.dualStack')} checked={dualStack} onChange={(v) => setAddressing({ mode: v ? 'dual-stack' : 'ipv4' })} />
          <Toggle label={t('network.ip.numbered')} checked={numbered} onChange={setNumbered} />
          <label>{t('network.ipr.planes')}<select data-ro-allow value={planes} onChange={(e) => setAddressing({ planes: Number(e.target.value) })}>{[1, 2, 3, 4, 5, 6, 7, 8].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
          {dualStack && <label className="ipr-prefix">IPv6 /48<input key={`${project.id}|${project.network.addressing?.ipv6Prefix ?? ''}`} data-ro-allow defaultValue={project.network.addressing?.ipv6Prefix ?? plan.ipv6Prefix ?? ''} onBlur={(e) => { const value = e.currentTarget.value.trim(); if (value !== (project.network.addressing?.ipv6Prefix ?? plan.ipv6Prefix ?? '')) setAddressing({ ipv6Prefix: value || undefined }); }} /></label>}
          <button type="button" className="btn sm" data-ro-allow onClick={() => setPage('docs')}>{t('network.ipr.openOutput')}</button>
          {isReview && <div className="grow" />}
          {isReview && <Seg value={family} onChange={setFamily} options={dualStack ? [
            { value: 'dual', label: t('network.ipr.family.dual') }, { value: 'ipv4', label: 'IPv4' }, { value: 'ipv6', label: 'IPv6' },
          ] : [{ value: 'ipv4', label: 'IPv4' }]} />}
        </div>
        {isReview && (
          <div className="ipr-filters">
            {multiHall && filterSelect(t('network.ipr.filter.hall'), filter.hallId ?? '', review.halls.filter((h) => hallsWithEntries.has(h.id)).map((h) => ({ value: h.id, label: h.name })), (v) => setFilter((f) => ({ ...f, hallId: v || undefined, pod: undefined, rackTag: undefined })), 'hall')}
            {filterSelect(t('network.ipr.filter.du'), filter.pod ? `${filter.hallId}|${filter.pod}` : '', podOptions, (v) => setFilter((f) => { if (!v) return { ...f, pod: undefined, rackTag: undefined }; const i = v.indexOf('|'); return { ...f, hallId: v.slice(0, i), pod: v.slice(i + 1), rackTag: undefined }; }), 'du')}
            {filterSelect(t('network.ipr.filter.rack'), filter.rackTag ? `${filter.hallId}|${filter.rackTag}` : '', rackOptions, (v) => setFilter((f) => { if (!v) return { ...f, rackTag: undefined }; const i = v.indexOf('|'); return { ...f, hallId: v.slice(0, i), rackTag: v.slice(i + 1) }; }), 'rack')}
            {filterSelect(t('network.ipr.filter.fabric'), filter.net ?? '', IPR_NETS.map((n) => ({ value: n, label: t(`network.ipr.net.${n}`) })), (v) => setFilter((f) => ({ ...f, net: (v || undefined) as IpReviewNet | undefined })), 'fabric')}
            {review.rails.length > 0 && filterSelect(t('network.ipr.filter.rail'), filter.rail === undefined ? '' : String(filter.rail), review.rails.map((r) => ({ value: String(r), label: t('network.ipr.rail', { n: r }) })), (v) => setFilter((f) => ({ ...f, rail: v === '' ? undefined : Number(v) })), 'rail')}
            {filterSelect(t('network.ipr.filter.type'), filter.deviceType ?? '', IPR_TYPES.map((d) => ({ value: d, label: t(`network.ipr.type.${d}`) })), (v) => setFilter((f) => ({ ...f, deviceType: (v || undefined) as IpReviewDeviceType | undefined })), 'type')}
            <input className="ipr-search" data-ro-allow data-ipr-search value={queryText} onChange={(e) => setQueryText(e.target.value)} title={t('network.ipr.filter.search')} aria-label={t('network.ipr.filter.search')} placeholder={`${t('network.ipr.filter.search')} — ${t('network.ipr.filter.searchPh')}`} />
          </div>
        )}
        {isReview && (
          <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
            <span className="hint" data-ipr-summary style={{ fontSize: 11.5 }}>{t('network.ipr.summary', { shown: fmtInt(filtered.length), total: fmtInt(review.entries.length), groups: fmtInt(groupCount) })}</span>
            {review.map.outside.length > 0 && <span className="pill warn"><span className="dot" />{t('network.ipr.outside', { n: review.map.outside.length })}</span>}
            <span className="grow" />
            <div className="ipr-actions">
              {filtersActive && <button type="button" className="btn ghost sm" data-ro-allow onClick={() => { setFilter({}); setQueryText(''); }}>{t('network.ipr.filter.clear')}</button>}
              <button type="button" className="btn ghost sm" data-ro-allow onClick={expandAll} data-ipr-expand-all>{t('network.ipr.expandAll')}</button>
              <button type="button" className="btn ghost sm" data-ro-allow onClick={collapseAll}>{t('network.ipr.collapseAll')}</button>
              <button type="button" className="btn sm" data-ro-allow onClick={csvView} data-ipr-csv-view>{t('network.ipr.csvView')}</button>
              {split && (selGroup || selEntry) && <button type="button" className="btn sm" data-ro-allow onClick={csvSelection}>{t('network.ipr.csvSelection', { name: selName.length > 28 ? `${selName.slice(0, 27)}…` : selName })}</button>}
            </div>
          </div>
        )}
      </div>

      {view === 'map' && (
        <div className="ipr-map-view">
          {dualStack && plan.ipv6Blocks?.length ? (
            <Section title={t('network.ipr.map.ipv6Title')}>
              <p className="hint">{t('network.ipr.map.ipv6Hint')}</p>
              <DataTable
                columns={[
                  { key: 'n', header: t('network.ip.col.block'), render: (b: IpPlan['blocks'][number]) => b.name },
                  { key: 'c', header: 'IPv6 CIDR', render: (b) => <span style={mono}>{b.cidr}</span> },
                  { key: 'p', header: t('network.ip.col.purpose'), render: (b) => b.purpose },
                ]}
                rows={plan.ipv6Blocks}
                rowKey={(b) => b.name}
              />
            </Section>
          ) : null}
          <Section title={t('network.ipr.map.ipv4Title')}>
            <p className="hint">{t('network.ipr.map.ipv4Hint')}</p>
            <IpMapView map={review.map} />
          </Section>
        </div>
      )}
      {view === 'plan' && (
        <Section title={t('network.ip.title')}>
          <p className="hint" style={{ marginBottom: 8 }}>{t('network.ip.hint')}</p>
          <DataTable
            columns={[
              { key: 'f', header: t('network.ipr.family'), render: (b: typeof addressBlocks[number]) => <span className="ipr-family-pill">{b.family}</span> },
              { key: 'n', header: t('network.ip.col.block'), render: (b) => b.name },
              { key: 'c', header: 'CIDR', render: (b) => <span style={mono}>{b.cidr}</span> },
              { key: 'p', header: t('network.ip.col.purpose'), render: (b) => b.purpose },
            ]}
            rows={addressBlocks}
            rowKey={(b) => `${b.family}:${b.name}`}
          />
          <p className="hint">{t('network.ipr.outputHint')}</p>
          {plan.notes?.length ? <ul className="hint" style={{ marginTop: 6 }}>{plan.notes.map((n, i) => <li key={i}>{n}</li>)}</ul> : null}
        </Section>
      )}
      {isReview && (
        <div
          ref={bodyRef} data-ipr-body data-split={split ? '1' : '0'}
          style={{ height: fillH, display: 'grid', gap: 8, gridTemplateColumns: split ? 'minmax(0,1fr) minmax(300px, 32%)' : 'minmax(0,1fr)', gridTemplateRows: split ? 'minmax(0,1fr)' : detailOpen ? `${listH}px ${detailH}px` : 'minmax(0,1fr)' }}
        >
          <div ref={listRef} className="ipr-list">
            <div className="ipr-cols" style={{ gridTemplateColumns: cols }}>
              <span style={{ paddingLeft: 20 }}>{t('network.ipr.col.name')}</span>
              {showCounts && <span>{t('network.ipr.col.counts')}</span>}
              <span>{t('network.ipr.col.address')}</span>
              {showCounts && <span>{t('network.ipr.col.gw')}</span>}
              <span>{t('network.ipr.col.util')}</span>
            </div>
            {rows.length === 0
              ? <div style={{ padding: 16 }}><Empty>{t('network.ipr.empty')}</Empty></div>
              : <VirtualList count={rows.length} height={listH - 28} rowHeight={IPR_ROW_H} keyOf={(i) => rows[i].id} render={(i) => renderRow(rows[i])} resetKey={`${view}|${filter.query ?? ''}|${filter.hallId}|${filter.pod}|${filter.rackTag}|${filter.net}|${filter.rail}|${filter.deviceType}|${numbered}|${family}`} testId="ipr-list" />}
          </div>
          {(split || detailOpen) && detail()}
        </div>
      )}
    </div>
  );
}
