// stream E (P5, proposal §6.1): liquid / air standards parameter checks
import { StandardsChecksView } from '../ui/StandardsChecks.tsx';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  compareCoolingTopologiesForHall,
  coolingPlacementFor,
  currentCoolingTopology,
  findCatalogItem,
  planTopologyPlacement,
  RDHX_DOOR_META,
  regenerateCooling,
  regenerateCoolingReport,
  regenerateHallWithCooling,
  stripRdhxDoors,
  tcsLoopBudget,
  topologyPlacementOptions,
  type CoolingDesign,
  type CoolingPlacementOptions,
  type CoolingTopologyOption,
  type CoolingTopologyRow,
  type Hall,
  type Issue,
  type Project,
  type Redundancy,
} from '@aidc/core';
import {
  buildThermalVariant,
  type CoolerThermal,
  type RackThermal,
  type ThermalMetrics,
  type ThermalOptions,
  type ThermalVariantNote,
  type ThermalWorkerRequest,
  type ThermalWorkerResponse,
} from '@aidc/thermal';
import { libraryCache, useApp } from '../store/appStore.ts';
import { catalogOptions } from '../app/derived.ts';
import { fmt1, fmt2, fmtInt, fmtPct, fmtPower } from '../app/format.ts';
import { BarChart, LineChart } from '../ui/charts.tsx';
import { DataTable, Field, Meter, NumberField, Section, Seg, SelectField, Stat, StatusLabel, Toggle } from '../ui/controls.tsx';
import { Icon } from '../ui/icons.tsx';
import { redundancyOptions } from './PowerPanel.tsx';
import { Term } from '../ui/Term.tsx';
import { useT } from '../i18n/index.ts';
import { COOLING_PLACEMENT_ANCHOR, isCoolingPlacementIssue, scrollToCoolingPlacement as scrollToPlacement } from '../app/coolingNav.ts';

const ASHRAE_REC = 27;
const ASHRAE_ALLOW = 32;

type T = ReturnType<typeof useT>;

// ───────────────────────────── placement-section deep link (F8) ─────────────────────────────

export { COOLING_PLACEMENT_ANCHOR, isCoolingPlacementIssue, openCoolingPlacement } from '../app/coolingNav.ts';

// ───────────────────────────── panel ─────────────────────────────

export function CoolingPanel() {
  const t = useT();
  const project = useApp((s) => s.project);
  const analysis = useApp((s) => s.analysis);
  const update = useApp((s) => s.update);
  const hallId = useApp((s) => s.hallId);
  const setThermalOptions = useApp((s) => s.setThermalOptions);

  const c = project.cooling;
  const set = <K extends keyof CoolingDesign>(k: K, v: CoolingDesign[K]) => update((d) => { d.cooling[k] = v; });
  const hall = project.halls.find((h) => h.id === hallId) ?? project.halls[0];
  const ca = analysis?.cooling;

  // placement draft lives here so the topology table can pre-fill it ("이 방식으로 배치")
  const stored = coolingPlacementFor(hall);
  const storedKey = JSON.stringify(stored);
  const [draft, setDraft] = useState<CoolingPlacementOptions>(stored);
  // polish v2 2차: the topology whose "Place with this topology" filled the draft (applying it removes RDHx doors of the hall)
  const [topoOption, setTopoOption] = useState<CoolingTopologyOption | null>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setDraft(coolingPlacementFor(hall)), [hall.id, storedKey]);
  useEffect(() => {
    if (typeof location !== 'undefined' && location.hash === `#${COOLING_PLACEMENT_ANCHOR}`) setTimeout(scrollToPlacement, 120);
  }, []);

  return (
    <div>
      <Section title={t('standards.ui.checks.title')}>
        <div className="card" data-cooling-standards-checks><StandardsChecksView families={['liquid', 'air']} /></div>
      </Section>
      <Section title={t('cooling.design.title')}>
        <div className="fields-2">
          <div>
            <NumberField label={<Term id="fws">{t('cooling.fwsSupply')}</Term>} unit="°C" step={0.5} value={c.fwsSupplyC} onChange={(v) => set('fwsSupplyC', v)} hint={t('cooling.fwsSupply.hint')} />
            <NumberField label={t('cooling.fwsReturn')} unit="°C" step={0.5} value={c.fwsReturnC} onChange={(v) => set('fwsReturnC', v)} />
            <NumberField label={<Term id="tcs">{t('cooling.tcsSupply')}</Term>} unit="°C" step={0.5} value={c.tcsSupplyC} onChange={(v) => set('tcsSupplyC', v)} hint={t('cooling.tcsSupply.hint')} />
            <NumberField label={t('cooling.supplyAir')} unit="°C" step={0.5} value={c.supplyAirC} onChange={(v) => { set('supplyAirC', v); setThermalOptions({ supplyAirC: v }); }} />
            <SelectField
              label={<Term id="dry-cooler">{t('cooling.heatRejection')}</Term>}
              value={c.heatRejection}
              options={(['air-cooled-chiller', 'water-cooled-chiller', 'dry-cooler', 'hybrid'] as const).map((v) => ({ value: v, label: t(`cooling.hr.${v}`) }))}
              onChange={(v) => set('heatRejection', v)}
            />
            <Toggle label={<Term id="economizer">{t('cooling.economizer')}</Term>} checked={c.economizer} onChange={(v) => set('economizer', v)} />
          </div>
          <div>
            <SelectField label={<Term id="cdu">{t('cooling.cdu')}</Term>} value={c.cduCatalogId} options={catalogOptions(['cdu'])} onChange={(v) => set('cduCatalogId', v)} />
            <SelectField label={<Term id="crah">{t('cooling.crah')}</Term>} value={c.crahCatalogId} options={catalogOptions(['crah'])} onChange={(v) => set('crahCatalogId', v)} />
            <SelectField label={t('cooling.chiller')} value={c.chillerCatalogId} options={catalogOptions(['chiller', 'dry-cooler'])} onChange={(v) => set('chillerCatalogId', v)} />
            <SelectField label={t('cooling.cduRedundancy')} value={c.cduRedundancy} options={redundancyOptions(t)} onChange={(v) => set('cduRedundancy', v)} />
            <SelectField label={t('cooling.crahRedundancy')} value={c.crahRedundancy} options={redundancyOptions(t)} onChange={(v) => set('crahRedundancy', v)} />
            <SelectField label={t('cooling.chillerRedundancy')} value={c.chillerRedundancy} options={redundancyOptions(t)} onChange={(v) => set('chillerRedundancy', v)} />
          </div>
        </div>
      </Section>

      <PlacementSection hall={hall} draft={draft} setDraft={setDraft} topoOption={topoOption} />

      {ca && (
        <Section title={<Term id="heat-capture">{t('cooling.balance.title')}</Term>}>
          <div className="grid-3">
            <Stat label={<Term id="heat-capture">{t('cooling.liquidLoad')}</Term>} value={fmtPower(ca.liquidHeatKW)} delta={`TCS ${fmtInt(ca.cdus.tcsFlowLpm)} LPM`} />
            <Stat label={t('cooling.airLoad')} value={fmtPower(ca.airHeatKW)} delta={t('cooling.airflowNeeded', { v: fmt1(ca.crahs.requiredAirflowM3s) })} />
            <Stat label={<Term id="ppue">{t('cooling.ppue')}</Term>} value={fmt2(ca.partialPue)} delta={<><Term id="wue">WUE</Term> {fmt2(ca.wueLPerKWh)} L/kWh</>} />
          </div>
          <div className="card" style={{ marginTop: 10 }}>
            <BarChart
              title={t('cooling.paths.title')}
              data={[{ label: t('cooling.paths.itLoad'), values: { liquid: ca.liquidHeatKW, air: ca.airHeatKW } }]}
              series={[{ key: 'liquid', name: t('cooling.paths.liquid') }, { key: 'air', name: t('cooling.paths.air') }]}
              format={(v) => fmtPower(v)}
              labelWidth={80}
              rowHeight={40}
            />
            <DataTable
              columns={[
                { key: 'n', header: t('cooling.col.equipment'), render: (r: { n: string; units: number; unit: number; req: number }) => r.n },
                { key: 'u', header: t('cooling.col.qty'), num: true, render: (r) => r.units },
                { key: 'c', header: t('cooling.col.unitCap'), num: true, render: (r) => fmtPower(r.unit) },
                { key: 'r', header: t('cooling.col.required'), num: true, render: (r) => fmtPower(r.req) },
                { key: 'm', header: t('cooling.col.loadN'), render: (r) => <div style={{ minWidth: 80 }}><Meter ratio={r.units && r.unit ? r.req / (r.units * r.unit) : 0} /></div> },
              ]}
              rows={[
                { n: 'CDU', units: ca.cdus.units, unit: ca.cdus.unitKW, req: ca.cdus.requiredKW },
                { n: 'CRAH', units: ca.crahs.units, unit: ca.crahs.unitKW, req: ca.crahs.requiredKW },
                { n: t('cooling.chiller'), units: ca.chillers.units, unit: ca.chillers.unitKW, req: ca.chillers.requiredKW },
              ]}
              rowKey={(r) => r.n}
            />
            <p className="hint">{t('cooling.plantLine', { pump: fmtPower(ca.pumpKW), fan: fmtPower(ca.fanKW), chiller: fmtPower(ca.chillerKW), fws: fmtInt(ca.fwsFlowLpm) })}</p>
          </div>
        </Section>
      )}

      <TopologySection
        hall={hall}
        onPlace={(opts, option) => {
          setDraft(opts);
          setTopoOption(option);
          setTimeout(scrollToPlacement, 60);
        }}
      />

      <CfdSection hall={hall} />
      <VisualSection hall={hall} />

    </div>
  );
}

// ───────────────────────────── 냉각 설비 배치 (F8) ─────────────────────────────

const WALLS = ['N', 'S', 'E', 'W'] as const;
const STRATEGIES: CoolingPlacementOptions['crahStrategy'][] = ['perimeter', 'gallery-fan-wall', 'in-row', 'per-pod'];

function coolingCounts(p: Project, hallId: string) {
  let cdu = 0;
  let crah = 0;
  for (const e of p.equipment) {
    if (e.hallId !== hallId) continue;
    const cat = findCatalogItem(e.catalogId)?.category;
    if (cat === 'cdu') cdu++;
    else if (cat === 'crah' || cat === 'fan-wall') crah++;
  }
  return { cdu, crah };
}

function PlacementSection({ hall, draft, setDraft, topoOption }: { hall: Hall; draft: CoolingPlacementOptions; setDraft: (o: CoolingPlacementOptions) => void; topoOption: CoolingTopologyOption | null }) {
  const t = useT();
  const project = useApp((s) => s.project);
  const analysis = useApp((s) => s.analysis);
  const update = useApp((s) => s.update);
  const uiLocale = useApp((s) => s.uiLocale);
  const [appliedAt, setAppliedAt] = useState(0);
  const stored = coolingPlacementFor(hall);
  const ca = analysis?.cooling;

  const pods = useMemo(() => new Set(project.equipment.filter((e) => e.hallId === hall.id && e.podId).map((e) => e.podId!)), [project.equipment, hall.id]);
  const podRows = (ca?.perPod ?? []).filter((p) => pods.has(p.podId));
  const ph = ca?.perHall?.find((h) => h.hallId === hall.id);
  const cduReq = podRows.reduce((s, p) => s + p.cdusRequired, 0);
  const cduPlaced = podRows.reduce((s, p) => s + p.cdusPlaced, 0);
  const cduPerPodAuto = podRows.reduce((m, p) => Math.max(m, p.cdusRequired), 0);
  const cduRed = (draft.cduRedundancy ?? project.cooling.cduRedundancy) as Redundancy;
  const crahRed = (draft.crahRedundancy ?? project.cooling.crahRedundancy) as Redundancy;

  const labelOf = (k: keyof CoolingPlacementOptions, v: unknown): string => {
    if (v === undefined) return '–';
    if (k === 'cduPlacement') return t(`cooling.place.${String(v)}`);
    if (k === 'crahStrategy') return t(`cooling.strategy.${String(v)}`);
    if (v === 'auto') return t('cooling.place.auto');
    if (Array.isArray(v)) return v.join('/') || '–';
    return String(v);
  };
  const fieldLabel: Record<keyof CoolingPlacementOptions, string> = {
    cduPerPod: t('cooling.place.cduPerPod'),
    cduPlacement: t('cooling.place.cduPlacement'),
    crahCount: t('cooling.place.crahCount'),
    crahStrategy: t('cooling.place.crahStrategy'),
    crahWalls: t('cooling.place.walls'),
    cduRedundancy: t('cooling.cduRedundancy'),
    crahRedundancy: t('cooling.crahRedundancy'),
    cduGalleryWall: t('cooling.place.galleryWall'),
    crahCatalogId: t('cooling.crah'),
  };
  const changes = (Object.keys(fieldLabel) as (keyof CoolingPlacementOptions)[])
    .filter((k) => JSON.stringify(draft[k] ?? null) !== JSON.stringify(stored[k] ?? null))
    .map((k) => `${fieldLabel[k]} ${labelOf(k, stored[k])} → ${labelOf(k, draft[k])}`);
  const same = changes.length === 0;

  // T1's report = the would-be placement (counts, issues, secondary-loop routes); the contract signature is the fallback
  const report = useMemo(() => {
    try {
      return { ok: true as const, rep: regenerateCoolingReport(project, hall.id, draft) };
    } catch (e) {
      return { ok: false as const, msg: e instanceof Error ? e.message : String(e) };
    }
  }, [project, hall.id, draft]);
  const preview = useMemo(() => {
    if (same) return { kind: 'same' as const };
    if (!report.ok) return { kind: 'error' as const, msg: report.msg };
    const next = report.rep.project;
    if (next === project) return { kind: 'pending' as const };
    const before = coolingCounts(project, hall.id);
    const after = coolingCounts(next, hall.id);
    const nextIds = new Set(next.equipment.map((e) => e.id));
    const kept = project.equipment.filter((e) => {
      const cat = findCatalogItem(e.catalogId)?.category;
      return !(e.hallId === hall.id && (cat === 'cdu' || cat === 'crah' || cat === 'fan-wall')) && nextIds.has(e.id);
    }).length;
    return { kind: 'ok' as const, cdu0: before.cdu, cdu1: after.cdu, crah0: before.crah, crah1: after.crah, kept, issues: report.rep.issues };
  }, [project, hall.id, same, report]);

  // fix v2 2차 (QA): never apply a cooling-only regeneration whose report has errors (per-pod / in-row placed 2 of 10 CRAHs)
  const needsRegen = report.ok && (!!report.rep.requiresRegenerate || report.rep.issues.some((i) => i.severity === 'error'));
  const applyRegen = () => {
    const opts = structuredClone(draft);
    if (!update((d) => Object.assign(d, regenerateHallWithCooling(topoOption && topoOption !== 'rdhx' ? stripRdhxDoors(d, hall.id) : d, hall.id, opts)))) return;
    setAppliedAt(Date.now());
  };
  const apply = () => {
    if (needsRegen) return;
    const opts = structuredClone(draft);
    update((d) => {
      const src: Project = topoOption && topoOption !== 'rdhx' ? stripRdhxDoors(d, hall.id) : d;
      let next: Project = src;
      try {
        next = regenerateCooling(src, hall.id, opts);
      } catch {
        next = src;
      }
      if (next !== d) Object.assign(d, next);
      const h = d.halls.find((x) => x.id === hall.id);
      if (h) h.coolingPlacement = opts;
      if (opts.cduRedundancy) d.cooling.cduRedundancy = opts.cduRedundancy as Redundancy;
      if (opts.crahRedundancy) d.cooling.crahRedundancy = opts.crahRedundancy as Redundancy;
    });
    setAppliedAt(Date.now());
  };

  const tcs = useMemo(() => {
    if (report.ok && report.rep.loops.length) return report.rep.loops.map((l) => ({ podId: l.podId, trunkM: l.trunkM, headerM: l.headerM, equivalentM: l.equivalentM, status: l.status }));
    return tcsLoopBudget(project, hall.id, draft.cduPlacement);
  }, [report, project, hall.id, draft.cduPlacement]);
  const tcsMax = tcs.reduce((m, p) => Math.max(m, p.equivalentM), 0);
  const issues = (analysis?.issues ?? []).filter(isCoolingPlacementIssue).filter((i) => i.id.includes(hall.id) || [...pods].some((p) => i.id.endsWith(p)) || !/pod-|hall-/.test(i.id));
  const severityOf = (s: string) => (s === 'over' ? 'error' : s === 'warn' ? 'warning' : 'good') as 'error' | 'warning' | 'good';

  return (
    <div id={COOLING_PLACEMENT_ANCHOR}>
      <Section title={t('cooling.place.title')}>
        <p className="hint" style={{ marginTop: 0 }}>{t('cooling.place.intro', { hall: hall.name })}</p>
        <div className="grid-2">
          <Stat label={t('cooling.place.liquid')} value={fmtPower(ph?.liquidKW ?? 0)} delta={t('cooling.place.air') + ' ' + fmtPower(ph?.airKW ?? 0)} />
          <Stat
            label={t('cooling.place.cdus')}
            value={<StatusLabel severity={cduPlaced >= cduReq ? 'good' : 'error'}>{`${cduReq} / ${cduPlaced}`}</StatusLabel>}
            delta={t('cooling.place.cduDelta', { red: cduRed, pods: podRows.length })}
          />
          <Stat
            label={t('cooling.place.crahs')}
            value={<StatusLabel severity={(ph?.crahsPlaced ?? 0) >= (ph?.crahsRequired ?? 0) ? 'good' : 'error'}>{`${ph?.crahsRequired ?? 0} / ${ph?.crahsPlaced ?? 0}`}</StatusLabel>}
            delta={t('cooling.place.crahDelta', { red: crahRed, kw: fmtPower(ph?.crahCapacityKW ?? 0) })}
          />
          <Stat label={t('cooling.place.tcs.title')} value={<StatusLabel severity={severityOf(tcsMax > 80 ? 'over' : tcsMax > 60 ? 'warn' : 'ok')}>{`${fmt1(tcsMax)} m`}</StatusLabel>} delta={t('cooling.place.tcs.max', { m: fmt1(tcsMax) })} />
        </div>

        <div className="card" style={{ marginTop: 10 }}>
          <div className="fields-2">
            <div>
              <Field label={t('cooling.place.cduPerPod')} hint={<>{t('cooling.place.autoCdu', { n: cduPerPodAuto })}</>}>
                <div className="row">
                  <Seg
                    value={draft.cduPerPod === 'auto' ? 'auto' : 'manual'}
                    options={[{ value: 'auto', label: t('cooling.place.auto') }, { value: 'manual', label: t('cooling.place.manual') }]}
                    onChange={(v) => setDraft({ ...draft, cduPerPod: v === 'auto' ? 'auto' : Math.max(1, cduPerPodAuto || 2) })}
                  />
                  {draft.cduPerPod !== 'auto' && (
                    <input type="number" min={0} step={1} style={{ width: 70 }} value={draft.cduPerPod} onChange={(e) => setDraft({ ...draft, cduPerPod: Math.max(0, Math.round(Number(e.target.value) || 0)) })} />
                  )}
                </div>
              </Field>
              <Field label={t('cooling.place.cduPlacement')}>
                <Seg value={draft.cduPlacement} options={(['row-ends', 'ends-center', 'gallery'] as const).map((v) => ({ value: v, label: t(`cooling.place.${v}`) }))} onChange={(v) => setDraft({ ...draft, cduPlacement: v })} />
              </Field>
              {draft.cduPlacement === 'gallery' && (
                <Field label={t('cooling.place.galleryWall')}>
                  <Seg
                    value={draft.cduGalleryWall ?? 'auto'}
                    options={[{ value: 'auto', label: t('cooling.place.galleryWallAuto') }, ...WALLS.map((w) => ({ value: w, label: w }))]}
                    onChange={(v) => {
                      const { cduGalleryWall: _drop, ...rest } = draft;
                      void _drop;
                      setDraft(v === 'auto' ? rest : { ...rest, cduGalleryWall: v });
                    }}
                  />
                </Field>
              )}
              <SelectField label={t('cooling.cduRedundancy')} value={cduRed} options={redundancyOptions(t)} onChange={(v) => setDraft({ ...draft, cduRedundancy: v })} />
            </div>
            <div>
              <Field label={t('cooling.place.crahCount')} hint={<>{t('cooling.place.autoCrah', { n: ph?.crahsRequired ?? 0 })}</>}>
                <div className="row">
                  <Seg
                    value={draft.crahCount === 'auto' ? 'auto' : 'manual'}
                    options={[{ value: 'auto', label: t('cooling.place.auto') }, { value: 'manual', label: t('cooling.place.manual') }]}
                    onChange={(v) => setDraft({ ...draft, crahCount: v === 'auto' ? 'auto' : Math.max(1, ph?.crahsRequired ?? 2) })}
                  />
                  {draft.crahCount !== 'auto' && (
                    <input type="number" min={0} step={1} style={{ width: 70 }} value={draft.crahCount} onChange={(e) => setDraft({ ...draft, crahCount: Math.max(0, Math.round(Number(e.target.value) || 0)) })} />
                  )}
                </div>
              </Field>
              <SelectField label={t('cooling.place.crahStrategy')} value={draft.crahStrategy} options={STRATEGIES.map((v) => ({ value: v, label: t(`cooling.strategy.${v}`) }))} onChange={(v) => setDraft({ ...draft, crahStrategy: v })} />
              <Field label={t('cooling.place.walls')} hint={t('cooling.place.wallsHint')}>
                <div className="row">
                  {WALLS.map((w) => {
                    const on = draft.crahWalls?.includes(w) ?? false;
                    return (
                      <button
                        key={w}
                        className={`btn sm ${on ? 'active' : ''}`}
                        disabled={draft.crahStrategy !== 'perimeter' && draft.crahStrategy !== 'gallery-fan-wall'}
                        onClick={() => {
                          const cur = draft.crahWalls ?? [];
                          const next = on ? cur.filter((x) => x !== w) : [...cur, w];
                          setDraft({ ...draft, crahWalls: next.length ? WALLS.filter((x) => next.includes(x)) : undefined });
                        }}
                      >
                        {w}
                      </button>
                    );
                  })}
                </div>
              </Field>
              <SelectField label={t('cooling.crahRedundancy')} value={crahRed} options={redundancyOptions(t)} onChange={(v) => setDraft({ ...draft, crahRedundancy: v })} />
            </div>
          </div>

          <div className="hint" style={{ marginTop: 6 }}>
            <strong>{t('cooling.place.preview')}:</strong>{' '}
            {preview.kind === 'same' && t('cooling.place.noChange')}
            {preview.kind === 'pending' && t('cooling.place.previewPending')}
            {preview.kind === 'error' && t('cooling.place.previewError', { msg: preview.msg })}
            {preview.kind === 'ok' && t('cooling.place.previewCounts', { cdu0: preview.cdu0, cdu1: preview.cdu1, crah0: preview.crah0, crah1: preview.crah1, kept: preview.kept })}
          </div>
          {!same && <div className="hint">{t('cooling.place.changes', { list: changes.join(' · ') })}</div>}
          {preview.kind === 'ok' && preview.issues.length > 0 && (
            <div className="hint">
              {t('cooling.place.previewIssues', { n: preview.issues.length })}
              <ul style={{ margin: '2px 0', paddingLeft: 18 }}>
                {preview.issues.slice(0, 6).map((i) => (
                  <li key={i.id}>{uiLocale === 'en' ? (i.messageEn ?? i.message) : i.message}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn primary" disabled={same || needsRegen} onClick={apply} title={needsRegen ? t('cooling.place.needsRegen') : undefined}><Icon name="play" size={14} />{t('cooling.place.apply')}</button>
            {needsRegen && <button className="btn sm" onClick={applyRegen} data-cooling-regen-hall>{t('cooling.place.regenHall')}</button>}
            <button className="btn ghost" disabled={same} onClick={() => setDraft(stored)}>{t('cooling.place.reset')}</button>
            {appliedAt > 0 && same && <span className="secondary">{t('cooling.place.applied')}</span>}
          </div>
        </div>

        {tcs.length > 0 && (
          <div className="card" style={{ marginTop: 10 }}>
            <h3>{t('cooling.place.tcs.title')}</h3>
            <DataTable
              columns={[
                { key: 'p', header: t('cooling.place.tcs.pod'), render: (r: (typeof tcs)[number]) => <span className="mono">{r.podId}</span> },
                { key: 't', header: t('cooling.place.tcs.trunk'), num: true, render: (r) => fmt1(r.trunkM) },
                { key: 'h', header: t('cooling.place.tcs.header'), num: true, render: (r) => fmt1(r.headerM) },
                { key: 'e', header: t('cooling.place.tcs.equiv'), num: true, render: (r) => fmt1(r.equivalentM), sortValue: (r) => r.equivalentM },
                { key: 's', header: t('cooling.place.tcs.status'), render: (r) => <StatusLabel severity={severityOf(r.status)}>{t(`cooling.place.tcs.${r.status}`)}</StatusLabel> },
              ]}
              rows={tcs}
              rowKey={(r) => r.podId}
              maxHeight={180}
            />
            <p className="caption">{t('cooling.place.tcs.caption')}</p>
          </div>
        )}

        <div className="card" style={{ marginTop: 10 }}>
          <h3>{t('cooling.place.issues')}</h3>
          {issues.length === 0 ? (
            <StatusLabel severity="good">{t('cooling.place.noIssues')}</StatusLabel>
          ) : (
            issues.map((i) => (
              <div key={i.id} className={`issue ${i.severity}`}>
                <Icon name="warning" />
                <div>
                  <div className="msg">{uiLocale === 'en' ? (i.messageEn ?? i.message) : i.message}</div>
                  {i.suggestion && <div className="sug">→ {uiLocale === 'en' ? (i.suggestionEn ?? i.suggestion) : i.suggestion}</div>}
                </div>
              </div>
            ))
          )}
        </div>
      </Section>
    </div>
  );
}

// ───────────────────────────── 냉각 방식 비교 ─────────────────────────────

function srcLabel(t: T, s: string) {
  return t(`cooling.src.${s}`);
}

function TopologySection({ hall, onPlace }: { hall: Hall; onPlace: (opts: CoolingPlacementOptions, option: CoolingTopologyOption) => void }) {
  const t = useT();
  const project = useApp((s) => s.project);
  const analysis = useApp((s) => s.analysis);
  const rows = useMemo(() => (analysis ? compareCoolingTopologiesForHall(project, analysis, hall.id) : []), [project, analysis, hall.id]);
  const [sel, setSel] = useState<CoolingTopologyOption | null>(null);
  const optLabel = (o: CoolingTopologyOption) => t(`cooling.topo.opt.${o}`);
  const selected = rows.find((r) => r.option === sel);

  return (
    <Section title={t('cooling.topo.title')}>
      <p className="hint" style={{ marginTop: 0 }}>{t('cooling.topo.intro')}</p>
      {rows.length === 0 ? (
        <p className="hint">{t('cooling.topo.empty')}</p>
      ) : (
        <>
          <DataTable
            columns={[
              {
                key: 'o',
                header: t('cooling.topo.col.option'),
                render: (r: CoolingTopologyRow) => (
                  <span>
                    {optLabel(r.option)} {r.current && <span className="badge state-current">{t('cooling.topo.current')}</span>}
                  </span>
                ),
              },
              {
                key: 'u',
                header: t('cooling.topo.col.units'),
                num: true,
                sortValue: (r) => r.units,
                render: (r) => (
                  <span title={r.unitLabel}>
                    {fmtInt(r.units - (r.rackUnits ?? 0))} ({r.unitsN ?? '–'})
                    {r.rackUnits ? <div className="hint" style={{ fontSize: 11 }}>{t('cooling.topo.col.rackUnits', { n: fmtInt(r.rackUnits) })}</div> : null}
                  </span>
                ),
              },
              { key: 'i', header: t('cooling.topo.col.installed'), num: true, sortValue: (r) => r.installedKW, render: (r) => fmtInt(r.installedKW) },
              { key: 'r', header: t('cooling.topo.col.required'), num: true, sortValue: (r) => r.requiredKW ?? 0, render: (r) => fmtInt(r.requiredKW ?? 0) },
              {
                key: 's',
                header: t('cooling.topo.col.spare'),
                num: true,
                sortValue: (r) => r.sparePct,
                render: (r) => <StatusLabel severity={r.sparePct < 0 ? 'error' : r.sparePct < 5 ? 'warning' : 'good'}>{`${fmt1(r.sparePct)} %`}</StatusLabel>,
              },
              {
                key: 'w',
                header: <span title={t('cooling.topo.worstTip')}>{t('cooling.topo.col.worst')}</span>,
                num: true,
                sortValue: (r) => r.worstFailureResidualPct ?? 0,
                render: (r) => <StatusLabel severity={(r.worstFailureResidualPct ?? 0) >= 100 ? 'good' : 'warning'}>{`${fmtInt(r.worstFailureResidualPct ?? 0)} %`}</StatusLabel>,
              },
              {
                key: 'p',
                header: t('cooling.topo.col.positions'),
                num: true,
                sortValue: (r) => r.positionsLost,
                render: (r) => (
                  <span>
                    {fmt1(r.positionsLost)}
                    {r.itKWDisplaced ? <div className="hint" style={{ fontSize: 11 }}>{t('cooling.topo.itKW', { kw: fmtPower(r.itKWDisplaced) })}</div> : null}
                  </span>
                ),
              },
              { key: 'g', header: t('cooling.topo.col.space'), num: true, render: (r) => `${fmtInt(r.galleryM2)} / ${fmtInt(r.whiteSpaceM2 ?? 0)}` },
              { key: 'f', header: t('cooling.topo.col.fan'), num: true, sortValue: (r) => r.fanKW, render: (r) => fmt1(r.fanKW) },
              {
                key: 'c',
                header: <span title={t('cooling.topo.costEstimateTip')}>{t('cooling.topo.col.cost')}</span>,
                num: true,
                sortValue: (r) => r.relativeCost,
                render: (r) => (
                  <span title={t('cooling.topo.costEstimateTip')}>
                    {fmt2(r.relativeCost)} {r.costBasis === 'estimate' && <span className="badge src-estimate">{t('cooling.topo.costEstimate')}</span>}
                  </span>
                ),
              },
            ]}
            rows={rows}
            rowKey={(r) => r.option}
            selectedKeys={sel ? [sel] : []}
            onRowClick={(r) => setSel(r.option === sel ? null : r.option)}
          />

          <div className="grid-2" style={{ marginTop: 10 }}>
            <div className="card">
              <BarChart
                title={t('cooling.topo.chart.fan')}
                data={rows.map((r) => ({ id: r.option, label: optLabel(r.option), values: { fan: r.fanKW } }))}
                series={[{ key: 'fan', name: t('cooling.topo.series.fan') }]}
                format={(v) => `${fmt1(v)} kW`}
                labelWidth={110}
                onBarClick={(d) => setSel(d.id as CoolingTopologyOption)}
              />
            </div>
            <div className="card">
              <BarChart
                title={t('cooling.topo.chart.itLost')}
                data={rows.map((r) => ({ id: r.option, label: optLabel(r.option), values: { it: r.itKWDisplaced ?? 0 } }))}
                series={[{ key: 'it', name: t('cooling.topo.series.it'), color: 'var(--series-2)' }]}
                format={(v) => fmtPower(v)}
                labelWidth={110}
                onBarClick={(d) => setSel(d.id as CoolingTopologyOption)}
              />
            </div>
          </div>

          {selected && <TopologyDetail hall={hall} row={selected} onPlace={onPlace} />}
        </>
      )}
      <CfdCompare hall={hall} rows={rows} preferred={sel} />
    </Section>
  );
}

function TopologyDetail({ hall, row, onPlace }: { hall: Hall; row: CoolingTopologyRow; onPlace: (opts: CoolingPlacementOptions, option: CoolingTopologyOption) => void }) {
  const t = useT();
  const project = useApp((s) => s.project);
  const analysis = useApp((s) => s.analysis);
  const update = useApp((s) => s.update);
  // polish v2 2차 (QA M4): what the button would place — the compared units (catalog item, count) or the reason it cannot
  const plan = useMemo(() => {
    if (!analysis) return undefined;
    try {
      return planTopologyPlacement(project, analysis, hall.id, row, coolingPlacementFor(hall), regenerateCoolingReport);
    } catch {
      return undefined;
    }
  }, [project, analysis, hall, row]);
  const doorsNow = useMemo(() => project.equipment.filter((e) => e.hallId === hall.id && Number(e.meta?.[RDHX_DOOR_META] ?? 0) > 0).length, [project.equipment, hall.id]);
  const placeDoors = () =>
    update((d) => {
      if (!analysis) return;
      const p = planTopologyPlacement(d, analysis, hall.id, row, coolingPlacementFor(hall), regenerateCoolingReport);
      if (p.available && p.project) Object.assign(d, p.project);
    });
  const hint = !plan
    ? t('cooling.topo.applyAsHint')
    : plan.reason
      ? t(plan.reason)
      : plan.matchesRow
        ? `${t('cooling.topo.place.matches', { units: fmtInt(plan.placedUnits), kw: fmtInt(plan.placedKW) })} ${t('cooling.topo.applyAsHint')}`
        : t('cooling.topo.applyAsHint');
  return (
    <div className="card" style={{ marginTop: 10 }}>
      <h3>{t('cooling.topo.detail', { option: t(`cooling.topo.opt.${row.option}`) })}</h3>
      <div className="hint">{t('cooling.topo.unit', { unit: row.unitLabel ?? '–' })}</div>
      <div className="hint">
        {t('cooling.topo.water', { n: fmtInt(row.waterJoints ?? 0), yn: row.facilityWaterInHall ? t('cooling.yes') : t('cooling.no'), group: t(`cooling.topo.group.${row.redundancyGroup ?? 'hall'}`) })}
      </div>
      {row.worstFailureUnit && <div className="hint">{t('cooling.topo.worstUnit', { unit: row.worstFailureUnit, pct: fmtInt(row.worstFailureResidualPct ?? 0) })}</div>}
      {row.rackDutyKW !== undefined && <div className="hint">{t('cooling.topo.duty', { rated: fmtInt((row.rackUnits ?? 0) * (row.rackUnitKW ?? 0)), duty: fmtInt(row.rackDutyKW) })}</div>}
      <ul style={{ margin: '6px 0', paddingLeft: 18 }}>
        {(row.noteIds ?? []).map((n, i) => (
          <li key={n.key + i} className="hint">{t(n.key, n.params)}</li>
        ))}
      </ul>
      <DataTable
        columns={[
          { key: 'l', header: t('cooling.topo.coef.label'), render: (c: NonNullable<CoolingTopologyRow['coefficients']>[number]) => c.label },
          { key: 'v', header: t('cooling.topo.coef.value'), num: true, render: (c) => `${Number(c.value.toFixed(3)).toLocaleString()} ${c.unit}` },
          { key: 't', header: t('cooling.topo.coef.type'), render: (c) => <span className={`badge ${c.sourceType === 'estimate' ? 'src-estimate' : c.sourceType === 'vendor-claim' ? 'src-vendor-datasheet' : ''}`}>{srcLabel(t, c.sourceType)}</span> },
          { key: 's', header: t('cooling.topo.coef.source'), render: (c) => (c.url ? <a href={c.url} target="_blank" rel="noreferrer">{c.source}</a> : c.source) },
        ]}
        rows={row.coefficients ?? []}
        rowKey={(c) => c.key + c.label}
        maxHeight={220}
      />
      {row.option === 'rdhx' ? (
        <div className="row wrap" style={{ marginTop: 8 }}>
          <button className="btn primary sm" data-testid="topo-place-doors" disabled={!plan?.available || row.current} onClick={placeDoors}>{t('cooling.topo.placeDoors')}</button>
          {doorsNow > 0 && <button className="btn sm" onClick={() => update((d) => Object.assign(d, stripRdhxDoors(d, hall.id)))}>{t('cooling.topo.removeDoors')}</button>}
          <span className="hint">{doorsNow > 0 ? t('cooling.topo.doorsPlaced', { doors: fmtInt(doorsNow) }) : plan?.reason ? t(plan.reason) : t('cooling.topo.placeDoorsHint', { doors: fmtInt(row.rackUnits ?? 0), room: fmtInt(row.units - (row.rackUnits ?? 0)) })}</span>
        </div>
      ) : (
        <div className="row wrap" style={{ marginTop: 8 }}>
          <button className="btn primary sm" data-testid="topo-place" disabled={!plan?.available || !plan.opts || row.current} onClick={() => plan?.opts && onPlace(plan.opts as CoolingPlacementOptions, row.option)}>{t('cooling.topo.applyAs')}</button>
          <span className="hint">{hint}</span>
        </div>
      )}
    </div>
  );
}

// ───────────────────────────── CFD-lite: current vs one alternative ─────────────────────────────

interface CmpResult {
  option: CoolingTopologyOption;
  metrics: ThermalMetrics;
  notes: ThermalVariantNote[];
}
interface CmpState {
  status: 'idle' | 'running' | 'done' | 'error' | 'cancelled';
  phase?: 'current' | 'alternative';
  step: number;
  hallId?: string;
  current?: CmpResult;
  alternative?: CmpResult;
  unavailable?: { option: CoolingTopologyOption; reason: string; notes: ThermalVariantNote[] };
  error?: string;
}

// module-level so a running comparison survives page switches
let cmpState: CmpState = { status: 'idle', step: 0 };
const cmpListeners = new Set<() => void>();
const setCmp = (patch: Partial<CmpState>) => {
  cmpState = { ...cmpState, ...patch };
  cmpListeners.forEach((l) => l());
};
const subscribeCmp = (l: () => void) => {
  cmpListeners.add(l);
  return () => {
    cmpListeners.delete(l);
  };
};
let cmpWorker: Worker | null = null;
let cmpJob: string | null = null;
const cmpPending = new Map<string, { resolve: (m: ThermalMetrics) => void; reject: (e: Error) => void }>();

function cmpRun(project: Project, options: ThermalOptions): Promise<ThermalMetrics> {
  if (!cmpWorker) {
    cmpWorker = new Worker(new URL('../workers/thermal.worker.ts', import.meta.url), { type: 'module' });
    cmpWorker.onmessage = (ev: MessageEvent<ThermalWorkerResponse>) => {
      const msg = ev.data;
      const p = cmpPending.get(msg.jobId);
      if (!p) return;
      if (msg.type === 'progress') setCmp({ step: msg.metrics.step });
      else if (msg.type === 'done') {
        cmpPending.delete(msg.jobId);
        p.resolve(msg.result.metrics);
      } else {
        cmpPending.delete(msg.jobId);
        p.reject(new Error(msg.message));
      }
    };
    cmpWorker.onerror = (ev) => {
      for (const [id, p] of cmpPending) {
        cmpPending.delete(id);
        p.reject(new Error(ev.message));
      }
    };
  }
  const jobId = `cmp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  cmpJob = jobId;
  return new Promise((resolve, reject) => {
    cmpPending.set(jobId, { resolve, reject });
    const req: ThermalWorkerRequest = { type: 'run', jobId, project, options, library: { items: libraryCache.items, cables: libraryCache.cables } };
    cmpWorker!.postMessage(req);
  });
}

async function runCompare(project: Project, hall: Hall, base: ThermalOptions, alt: CoolingTopologyOption) {
  setCmp({ status: 'running', phase: 'current', step: 0, hallId: hall.id, current: undefined, alternative: undefined, unavailable: undefined, error: undefined });
  try {
    const cur = await cmpRun(project, base);
    setCmp({ current: { option: currentCoolingTopology(project, hall), metrics: cur, notes: [] }, phase: 'alternative', step: 0 });
    const v = buildThermalVariant(project, base, alt);
    if (!v.available) {
      setCmp({ status: 'done', unavailable: { option: alt, reason: v.reason ?? '', notes: v.notes } });
      return;
    }
    const m = await cmpRun(v.project, v.options);
    setCmp({ status: 'done', alternative: { option: alt, metrics: m, notes: v.notes } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setCmp({ status: msg === 'cancelled' ? 'cancelled' : 'error', error: msg });
  }
}

function cancelCompare() {
  if (cmpWorker && cmpJob) cmpWorker.postMessage({ type: 'cancel', jobId: cmpJob } satisfies ThermalWorkerRequest);
}

function CfdCompare({ hall, rows, preferred }: { hall: Hall; rows: CoolingTopologyRow[]; preferred: CoolingTopologyOption | null }) {
  const t = useT();
  const project = useApp((s) => s.project);
  const thermalOptions = useApp((s) => s.thermal.options);
  const st = useSyncExternalStore(subscribeCmp, () => cmpState);
  const current = currentCoolingTopology(project, hall);
  const alternatives = rows.map((r) => r.option).filter((o) => o !== current);
  const [alt, setAlt] = useState<CoolingTopologyOption>('rdhx');
  const [grid, setGrid] = useState(0.4);
  const [steps, setSteps] = useState(500);
  useEffect(() => {
    if (preferred && preferred !== current) setAlt(preferred);
  }, [preferred, current]);
  const running = st.status === 'running';
  const optLabel = (o: CoolingTopologyOption) => t(`cooling.topo.opt.${o}`);

  if (!rows.length) return null;
  const effectiveAlt = alternatives.includes(alt) ? alt : alternatives[0];
  const base: ThermalOptions = { ...thermalOptions, hallId: hall.id, cellSize: grid, maxSteps: steps };

  const metricRows: { k: string; label: string; get: (m: ThermalMetrics) => number | undefined; digits: number }[] = [
    { k: 'maxIn', label: t('cooling.cmp.maxInlet'), get: (m) => m.maxInletC, digits: 1 },
    { k: 'avgIn', label: t('cooling.cmp.avgInlet'), get: (m) => m.avgInletC, digits: 1 },
    { k: 'rci', label: t('cooling.cmp.rciHi'), get: (m) => m.rciHi, digits: 1 },
    { k: 'hot', label: t('cooling.cmp.hotAisle'), get: (m) => m.hotAisleAvgC, digits: 1 },
    { k: 'air', label: t('cooling.cmp.airHeat'), get: (m) => m.airHeatKW, digits: 0 },
    { k: 'rem', label: t('cooling.cmp.removed'), get: (m) => m.removedKW, digits: 0 },
    { k: 'door', label: t('cooling.cmp.door'), get: (m) => m.doorRemovedKW ?? 0, digits: 0 },
    // total-heat basis: with RDHx the air-side share is small, so (air − removed) / (air + doors)
    { k: 'bal', label: t('cooling.cmp.balance'), get: (m) => { const tot = m.airHeatKW + (m.doorRemovedKW ?? 0); return tot > 0 ? ((m.airHeatKW - m.removedKW) / tot) * 100 : 0; }, digits: 2 },
    { k: 'balAir', label: t('cooling.cmp.balanceAir'), get: (m) => m.balanceError * 100, digits: 2 },
    { k: 'steps', label: t('cooling.cmp.converged'), get: (m) => m.step, digits: 0 },
  ];
  const fmtN = (v: number | undefined, d: number) => (v == null || !Number.isFinite(v) ? '–' : v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }));
  const noteText = (ns: ThermalVariantNote[]) => ns.map((n) => t(n.key, n.params)).join(' ');
  const otherHall = st.hallId && st.hallId !== hall.id ? project.halls.find((h) => h.id === st.hallId)?.name ?? st.hallId : null;

  return (
    <div className="card" style={{ marginTop: 10 }}>
      <h3>{t('cooling.cmp.title')}</h3>
      <p className="hint" style={{ marginTop: 0 }}>{t('cooling.cmp.intro')}</p>
      <div className="fields-2">
        <div>
          <SelectField label={t('cooling.cmp.alternative')} value={effectiveAlt} options={alternatives.map((o) => ({ value: o, label: optLabel(o) }))} onChange={(v) => setAlt(v)} />
          <Field label={t('cooling.cmp.grid')}>
            <Seg value={grid} options={[0.3, 0.4, 0.5].map((v) => ({ value: v, label: `${v} m` }))} onChange={(v) => setGrid(v)} />
          </Field>
        </div>
        <div>
          <NumberField label={t('cooling.cmp.steps')} step={50} min={100} value={steps} onChange={(v) => setSteps(Math.round(v))} />
        </div>
      </div>
      <div className="row" style={{ marginTop: 6 }}>
        {running ? (
          <button className="btn danger" onClick={cancelCompare}><Icon name="stop" size={14} />{t('cooling.cmp.stop')}</button>
        ) : (
          <button className="btn primary" disabled={!effectiveAlt} onClick={() => void runCompare(project, hall, base, effectiveAlt)}><Icon name="play" size={14} />{t('cooling.cmp.run')}</button>
        )}
        <span className="secondary">
          {running && t('cooling.cmp.running', { phase: t(`cooling.cmp.phase.${st.phase ?? 'current'}`), step: st.step })}
          {st.status === 'done' && t('cooling.cmp.done')}
          {st.status === 'cancelled' && t('cooling.cmp.cancelled')}
          {st.status === 'error' && t('cooling.cmp.error', { msg: st.error ?? '' })}
        </span>
      </div>
      {otherHall && <p className="hint">{t('cooling.cmp.otherHall', { hall: otherHall })}</p>}
      {st.unavailable && <p className="hint">{t('cooling.cmp.unavailable', { option: optLabel(st.unavailable.option), reason: t(st.unavailable.reason) })}</p>}
      {st.current && (
        <div style={{ marginTop: 8 }}>
          <DataTable
            columns={[
              { key: 'k', header: t('cooling.cmp.metric'), render: (r: (typeof metricRows)[number]) => r.label },
              { key: 'c', header: `${optLabel(st.current.option)} (${t('cooling.topo.current')})`, num: true, render: (r) => fmtN(r.get(st.current!.metrics), r.digits) + (r.k === 'steps' ? (st.current!.metrics.converged ? ' ✓' : ' ✗') : '') },
              ...(st.alternative
                ? [
                    { key: 'a', header: optLabel(st.alternative.option), num: true, render: (r: (typeof metricRows)[number]) => fmtN(r.get(st.alternative!.metrics), r.digits) + (r.k === 'steps' ? (st.alternative!.metrics.converged ? ' ✓' : ' ✗') : '') },
                    {
                      key: 'd',
                      header: t('cooling.cmp.delta'),
                      num: true,
                      render: (r: (typeof metricRows)[number]) => {
                        if (r.k === 'steps') return '';
                        const a = r.get(st.alternative!.metrics);
                        const b = r.get(st.current!.metrics);
                        if (a == null || b == null) return '–';
                        const d = a - b;
                        return `${d >= 0 ? '+' : ''}${fmtN(d, r.digits)}`;
                      },
                    },
                  ]
                : []),
            ]}
            rows={metricRows}
            rowKey={(r) => r.k}
          />
          {st.alternative && st.alternative.notes.length > 0 && <p className="caption">{noteText(st.alternative.notes)}</p>}
          <p className="caption">{t('cooling.cmp.caption')}</p>
        </div>
      )}
    </div>
  );
}

// ───────────────────────────── CFD-lite (single run) ─────────────────────────────

function CfdSection({ hall }: { hall: Hall }) {
  const t = useT();
  const project = useApp((s) => s.project);
  const thermal = useApp((s) => s.thermal);
  const setThermalOptions = useApp((s) => s.setThermalOptions);
  const startThermal = useApp((s) => s.startThermal);
  const cancelThermal = useApp((s) => s.cancelThermal);
  const saveScenario = useApp((s) => s.saveThermalScenario);
  const removeScenario = useApp((s) => s.removeThermalScenario);
  const select = useApp((s) => s.select);
  const selection = useApp((s) => s.selection);
  const viewerApi = useApp((s) => s.viewerApi);
  const [scenarioName, setScenarioName] = useState('');
  const c = project.cooling;
  const m = thermal.metrics;
  const o = thermal.options;
  const running = thermal.status === 'running';
  const returnMode = o.includePlenum !== false && o.coolerReturn !== 'top' && hall.ceilingPlenumHeight > 0 ? 'plenum' : 'top';
  const inletSeverity = m ? (m.maxInletC > ASHRAE_ALLOW ? 'error' : m.maxInletC > ASHRAE_REC ? 'warning' : 'good') : 'info';

  return (
    <Section title={<Term id="cfd-lite">{t('cooling.cfd.title')}</Term>}>
      <div className="card">
        <div className="fields-2">
          <div>
            <div className="field"><label>{t('cooling.cfd.grid')}</label><Seg value={o.cellSize} options={[0.2, 0.3, 0.4, 0.5].map((v) => ({ value: v, label: `${v} m` }))} onChange={(v) => setThermalOptions({ cellSize: v })} /></div>
            <NumberField label={t('cooling.cfd.loadFactor')} step={0.05} min={0.1} max={1.2} value={o.loadFactor} onChange={(v) => setThermalOptions({ loadFactor: v })} hint={t('cooling.cfd.loadFactorHint')} />
            <NumberField label={t('cooling.supplyAir')} unit="°C" step={0.5} digits={1} value={o.supplyAirC ?? c.supplyAirC} onChange={(v) => setThermalOptions({ supplyAirC: v })} />
          </div>
          <div>
            <SelectField
              label={t('cooling.cfd.returnPath')}
              value={returnMode}
              options={[
                ...(hall.ceilingPlenumHeight > 0 ? [{ value: 'plenum' as const, label: t('cooling.cfd.returnPlenum') }] : []),
                { value: 'top' as const, label: t('cooling.cfd.returnTop') },
              ]}
              onChange={(v) => setThermalOptions(v === 'plenum' ? { includePlenum: true, coolerReturn: 'plenum' } : { includePlenum: false, coolerReturn: 'top' })}
              hint={t(returnMode === 'plenum' ? 'cooling.cfd.returnPlenumHint' : 'cooling.cfd.returnTopHint')}
            />
            <SelectField label={t('cooling.cfd.containment')} value={o.overrides?.containment ?? 'as-designed'} options={[{ value: 'as-designed', label: t('cooling.cfd.asDesigned') }, { value: 'none', label: t('cooling.cfd.removedOpt') }]} onChange={(v) => setThermalOptions({ overrides: { containment: v } })} />
            <SelectField label={t('cooling.cfd.blanking')} value={o.overrides?.blanking === false ? 'off' : 'on'} options={[{ value: 'on', label: t('cooling.cfd.installed') }, { value: 'off', label: t('cooling.cfd.notInstalled') }]} onChange={(v) => setThermalOptions({ overrides: { blanking: v === 'on' } })} />
            <NumberField label={t('cooling.cfd.maxSteps')} step={50} min={50} value={o.maxSteps ?? 600} onChange={(v) => setThermalOptions({ maxSteps: Math.round(v) })} />
          </div>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          {running ? (
            <button className="btn danger" onClick={cancelThermal}><Icon name="stop" size={14} />{t('cooling.cfd.stop')}</button>
          ) : (
            <button className="btn primary" onClick={startThermal}><Icon name="play" size={14} />{t('cooling.cfd.run', { hall: hall.name })}</button>
          )}
          <span className="secondary">
            {running
              ? t('cooling.cfd.progress', { step: m?.step ?? 0, max: o.maxSteps ?? 600, res: m ? m.residual.toExponential(2) : '–' })
              : thermal.status === 'done'
                ? t('cooling.cfd.doneStatus', { state: m?.converged ? t('cooling.cfd.convergedYes') : t('cooling.cfd.convergedNo'), sec: m ? (m.elapsedMs / 1000).toFixed(1) : 0 })
                : thermal.status === 'error'
                  ? t('cooling.cfd.error', { msg: thermal.error ?? '' })
                  : thermal.status === 'cancelled'
                    ? t('cooling.cfd.cancelled')
                    : t('cooling.cfd.idle')}
          </span>
        </div>
        {thermal.history.length > 2 && (
          <div style={{ marginTop: 10 }}>
            <LineChart
              title={t('cooling.cfd.chart')}
              series={[{ key: 'max', name: t('cooling.cfd.chartSeries'), points: thermal.history.map((h) => ({ x: h.step, y: h.maxInletC })) }]}
              height={150}
              xFormat={(v) => `${Math.round(v)}`}
              yFormat={(v) => v.toFixed(1)}
              area
              refLines={[{ y: ASHRAE_REC, label: t('cooling.cfd.ashraeRec') }]}
            />
          </div>
        )}
      </div>

      {m && (
        <>
          <div className="grid-3" style={{ marginTop: 10 }}>
            <Stat label={t('cooling.cfd.maxInlet')} value={<StatusLabel severity={inletSeverity}>{`${fmt1(m.maxInletC)} °C`}</StatusLabel>} delta={t('cooling.cfd.maxInletDelta', { avg: fmt1(m.avgInletC), allow: ASHRAE_ALLOW })} />
            <Stat label={<Term id="rci">RCI HI / LO</Term>} value={`${fmt1(m.rciHi)} / ${fmt1(m.rciLo)}`} delta={t('cooling.cfd.rciDelta')} />
            <Stat label={<><Term id="rti">RTI</Term> · <Term id="shi">SHI</Term></>} value={`${fmt1(m.rti)} · ${fmt2(m.shi)}`} delta={t('cooling.cfd.rtiDelta')} />
            <Stat label={t('cooling.airLoad')} value={fmtPower(m.airHeatKW)} delta={t('cooling.cfd.removedDelta', { kw: fmtPower(m.removedKW) })} />
            <Stat label={t('cooling.cfd.balance')} value={fmtPct(m.balanceError, 1)} delta={t('cooling.cfd.steps', { n: m.step })} />
            <Stat label={t('cooling.cfd.hotspot')} value={m.hotspots[0] ? `${fmt1(m.hotspots[0].tempC)} °C` : '–'} delta={m.hotspots[0] ? `(${m.hotspots[0].x.toFixed(1)}, ${m.hotspots[0].y.toFixed(1)}, ${m.hotspots[0].z.toFixed(1)}) m` : undefined} />
          </div>

          <div className="row" style={{ margin: '10px 0 4px' }}>
            <input type="text" placeholder={t('cooling.cfd.scenarioPlaceholder')} value={scenarioName} onChange={(e) => setScenarioName(e.target.value)} />
            <button
              className="btn"
              disabled={!m}
              onClick={() => {
                saveScenario(scenarioName || `${o.overrides?.containment === 'none' ? t('cooling.cfd.scenarioNoContainment') : t('cooling.cfd.scenarioDesign')} · ${Math.round(o.loadFactor * 100)}%`);
                setScenarioName('');
              }}
            >
              {t('cooling.cfd.saveScenario')}
            </button>
          </div>

          <div style={{ marginTop: 6 }}>
            <DataTable
              columns={[
                { key: 'tag', header: t('cooling.cfd.col.rackTop'), render: (r: RackThermal) => <span className="mono">{r.tag}</span> },
                { key: 'avg', header: t('cooling.cfd.col.avg'), num: true, render: (r) => fmt1(r.inletAvgC), sortValue: (r) => r.inletAvgC },
                { key: 'max', header: t('cooling.cfd.col.max'), num: true, render: (r) => <StatusLabel severity={r.inletMaxC > ASHRAE_ALLOW ? 'error' : r.inletMaxC > ASHRAE_REC ? 'warning' : 'good'}>{fmt1(r.inletMaxC)}</StatusLabel>, sortValue: (r) => r.inletMaxC },
                { key: 'ex', header: t('cooling.cfd.col.exhaust'), num: true, render: (r) => fmt1(r.exhaustC), sortValue: (r) => r.exhaustC },
                { key: 'kw', header: t('cooling.cfd.col.airKW'), num: true, render: (r) => fmt1(r.airKW), sortValue: (r) => r.airKW },
              ]}
              rows={m.racks}
              rowKey={(r) => r.id}
              initialSort={{ key: 'max', dir: -1 }}
              selectedKeys={selection}
              onRowClick={(r) => { select(r.id); viewerApi?.focusEquipment(r.id); }}
              maxHeight={240}
            />
          </div>
          <div style={{ marginTop: 8 }}>
            <DataTable
              columns={[
                { key: 'tag', header: 'CRAH', render: (r: CoolerThermal) => <span className="mono">{r.tag}</span> },
                { key: 'ret', header: t('cooling.cfd.col.return'), num: true, render: (r) => `${fmt1(r.returnC)} °C` },
                { key: 'sup', header: t('cooling.cfd.col.supply'), num: true, render: (r) => `${fmt1(r.supplyC)} °C` },
                { key: 'load', header: t('cooling.cfd.col.loadCap'), num: true, render: (r) => `${fmtInt(r.loadKW)} / ${fmtInt(r.capacityKW)} kW` },
                { key: 'm', header: '', render: (r) => <div style={{ minWidth: 70 }}><Meter ratio={r.capacityKW ? r.loadKW / r.capacityKW : 0} /></div> },
              ]}
              rows={m.coolers}
              rowKey={(r) => r.id}
              onRowClick={(r) => select(r.id)}
              maxHeight={200}
            />
          </div>
        </>
      )}

      {thermal.scenarios.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <DataTable
            columns={[
              { key: 'n', header: t('cooling.cfd.col.scenario'), render: (s: (typeof thermal.scenarios)[number]) => s.name },
              { key: 'lf', header: t('cooling.cfd.col.load'), num: true, render: (s) => fmtPct(s.options.loadFactor) },
              { key: 'mx', header: t('cooling.cfd.col.maxInlet'), num: true, render: (s) => `${fmt1(s.metrics.maxInletC)} °C` },
              { key: 'rci', header: 'RCI HI', num: true, render: (s) => fmt1(s.metrics.rciHi) },
              { key: 'rti', header: 'RTI', num: true, render: (s) => fmt1(s.metrics.rti) },
              { key: 'x', header: '', render: (s) => <button className="btn ghost sm" onClick={() => removeScenario(s.id)}><Icon name="trash" size={13} /></button> },
            ]}
            rows={thermal.scenarios}
            rowKey={(s) => s.id}
          />
        </div>
      )}
    </Section>
  );
}

// ───────────────────────────── visualisation ─────────────────────────────

function VisualSection({ hall }: { hall: Hall }) {
  const t = useT();
  const overlays = useApp((s) => s.overlays);
  const setOverlays = useApp((s) => s.setOverlays);
  const setThermalOverlay = useApp((s) => s.setThermalOverlay);
  const colorMode = useApp((s) => s.colorMode);
  const setColorMode = useApp((s) => s.setColorMode);
  const axisMax = overlays.thermal.axis === 'x' ? hall.width : overlays.thermal.axis === 'y' ? hall.depth : hall.clearHeight + hall.ceilingPlenumHeight;
  return (
    <Section title={t('cooling.viz.title')}>
      <div className="card">
        <div className="field"><label>{t('cooling.viz.field')}</label><Seg value={overlays.thermal.mode} options={(['off', 'slice', 'volume', 'both'] as const).map((v) => ({ value: v, label: t(`cooling.viz.${v}`) }))} onChange={(v) => setThermalOverlay({ mode: v })} /></div>
        <div className="field"><label>{t('cooling.viz.axis')}</label><Seg value={overlays.thermal.axis} options={[{ value: 'z', label: t('cooling.viz.horizontal') }, { value: 'y', label: 'Y' }, { value: 'x', label: 'X' }]} onChange={(v) => setThermalOverlay({ axis: v, position: v === 'z' ? 1.2 : v === 'x' ? hall.width / 2 : hall.depth / 2 })} /></div>
        <div className="field"><label>{t('cooling.viz.position', { m: overlays.thermal.position.toFixed(2) })}</label><input type="range" min={0} max={axisMax} step={0.05} value={overlays.thermal.position} onChange={(e) => setThermalOverlay({ position: Number(e.target.value) })} /></div>
        <div className="field"><label>{t('cooling.viz.opacity')}</label><input type="range" min={0.1} max={1} step={0.05} value={overlays.thermal.opacity} onChange={(e) => setThermalOverlay({ opacity: Number(e.target.value) })} /></div>
        <div className="fields-2">
          <NumberField label={t('cooling.viz.rangeMin')} unit="°C" value={overlays.thermal.rangeC[0]} onChange={(v) => setThermalOverlay({ rangeC: [v, overlays.thermal.rangeC[1]] })} />
          <NumberField label={t('cooling.viz.rangeMax')} unit="°C" value={overlays.thermal.rangeC[1]} onChange={(v) => setThermalOverlay({ rangeC: [overlays.thermal.rangeC[0], v] })} />
        </div>
        <div className="row wrap" style={{ gap: 14, marginTop: 6 }}>
          <Toggle label={t('cooling.viz.particles')} checked={overlays.airflow} onChange={(v) => setOverlays({ airflow: v })} />
          <Toggle label={t('cooling.viz.floorMap')} checked={overlays.heatmapFloor} onChange={(v) => setOverlays({ heatmapFloor: v })} />
          <Toggle label={t('cooling.viz.ceiling')} checked={overlays.ceiling} onChange={(v) => setOverlays({ ceiling: v })} />
          <Toggle label={t('cooling.viz.inletColor')} checked={colorMode === 'inlet-temp'} onChange={(v) => setColorMode(v ? 'inlet-temp' : 'realistic')} />
        </div>
      </div>
    </Section>
  );
}
