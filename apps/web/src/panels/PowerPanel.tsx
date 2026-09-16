// stream E (P5, proposal §6.1): rack / rack-power standards parameter checks
import { StandardsChecksView } from '../ui/StandardsChecks.tsx';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import {
  evaluatePowerScenario, sweepPowerN1,
  type MaxQReport, type OneLineNode, type PowerDesign, type PowerElementResult, type PowerPath, type PowerRackOutcome, type PowerScenario,
  type PowerScenarioResult, type Project, type ProjectAnalysis, type Redundancy,
} from '@aidc/core';
import { useApp } from '../store/appStore.ts';
import { useT } from '../i18n/index.ts';
import { catalogOptions } from '../app/derived.ts';
import { fmt1, fmt2, fmtInt, fmtPct, fmtPower } from '../app/format.ts';
import { BarChart } from '../ui/charts.tsx';
import { DataTable, Empty, Meter, NumberField, SelectField, Stat, Toggle } from '../ui/controls.tsx';
import { OneLineDiagram, type OneLineNodeState } from '../ui/diagrams.tsx';
import { Term } from '../ui/Term.tsx';

/** Redundancy values (labels are the raw values; use redundancyOptions(t) for UI labels). */
export const REDUNDANCY_OPTIONS: { value: Redundancy; label: string }[] = (['N', 'N+1', 'N+2', '2N', '2N+1', 'DR', 'block-redundant'] as Redundancy[]).map((r) => ({
  value: r,
  label: r,
}));

/** Localised redundancy options (shared with CoolingPanel; labels from the power namespace). */
export function redundancyOptions(tr: (key: string) => string): { value: Redundancy; label: string }[] {
  return REDUNDANCY_OPTIONS.map((o) => ({ value: o.value, label: o.value === 'DR' ? tr('power.redundancy.DR') : o.value === 'block-redundant' ? tr('power.redundancy.block') : o.value }));
}

type Tr = ReturnType<typeof useT>;

// ───────────────────────── scenario result cache + hooks (also used by App → 3D overlay) ─────────────────────────

const resultCache = new WeakMap<ProjectAnalysis, { project: Project; map: Map<string, PowerScenarioResult> }>();

/** evaluatePowerScenario memoised per (analysis, project, scenario value) so the panel and the viewer share one evaluation. */
export function cachedPowerScenario(project: Project, analysis: ProjectAnalysis, scenario: PowerScenario): PowerScenarioResult {
  let entry = resultCache.get(analysis);
  if (!entry || entry.project !== project) {
    entry = { project, map: new Map() };
    resultCache.set(analysis, entry);
  }
  const key = JSON.stringify(scenario);
  let r = entry.map.get(key);
  if (!r) {
    r = evaluatePowerScenario(project, analysis, scenario);
    entry.map.set(key, r);
  }
  return r;
}

/** Active scenario result for the 3D overlay (null when no scenario is set: the overlay shows the normal state). */
export function usePowerScenarioResult(): PowerScenarioResult | null {
  const project = useApp((s) => s.project);
  const analysis = useApp((s) => s.analysis);
  const sc = useApp((s) => s.powerScenario);
  return useMemo(() => (analysis && sc ? cachedPowerScenario(project, analysis, sc) : null), [project, analysis, sc]);
}

/** Viewport toolbar toggle for the power overlay. */
export function PowerOverlayButton() {
  const tr = useT();
  const on = useApp((s) => !!s.overlays.powerPaths);
  const setOverlays = useApp((s) => s.setOverlays);
  return (
    <button className={`btn sm ${on ? 'active' : ''}`} title={tr('power.overlay.title')} onClick={() => setOverlays({ powerPaths: !on })} data-power-overlay>
      {tr('power.overlay.toggle')}
    </button>
  );
}

/** Select racks, highlight runs in the power overlay and bring the viewer forward. */
function useFocusPower() {
  return useCallback((ids: string[], highlight: string[]) => {
    const st = useApp.getState();
    const eqById = new Map(st.project.equipment.map((e) => [e.id, e]));
    const eq = ids.filter((id) => eqById.has(id));
    let hallId = eq.length ? eqById.get(eq[0])!.hallId : undefined;
    if (!hallId) hallId = (st.analysis?.power.paths ?? []).find((p) => highlight.includes(p.id) || (!!p.buswayId && highlight.includes(p.buswayId)))?.hallId;
    if (hallId && hallId !== st.hallId) st.setHall(hallId);
    st.setSelection(eq);
    st.setPowerHighlight(highlight);
    if (!st.overlays.powerPaths) st.setOverlays({ powerPaths: true });
    if (st.panelWide) st.setPanelWide(false);
    if (eq[0]) setTimeout(() => useApp.getState().viewerApi?.focusEquipment(eq[0]), 60);
  }, []);
}

function Pill({ tone, children }: { tone: 'good' | 'warn' | 'bad' | 'neutral'; children: ReactNode }) {
  return <span className={`pill ${tone === 'neutral' ? '' : tone}`}><span className="dot" />{children}</span>;
}

const SCENARIO_KINDS: PowerScenario['kind'][] = ['normal', 'busway-failure', 'rpp-failure', 'ups-module-failure', 'utility-loss', 'generator-failure'];
const NORMAL: PowerScenario = { kind: 'normal' };

// ───────────────────────── panel ─────────────────────────

export function PowerPanel() {
  const tr = useT();
  const project = useApp((s) => s.project);
  const analysis = useApp((s) => s.analysis);
  const update = useApp((s) => s.update);
  const stored = useApp((s) => s.powerScenario);
  const pw = project.power;
  const set = <K extends keyof PowerDesign>(k: K, v: PowerDesign[K]) => update((d) => { d.power[k] = v; });
  const a = analysis?.power;
  const scenario = stored ?? NORMAL;
  const result = useMemo(() => (analysis ? cachedPowerScenario(project, analysis, scenario) : null), [project, analysis, scenario]);
  const redundancy = useMemo(
    () => REDUNDANCY_OPTIONS.map((o) => ({ value: o.value, label: o.value === 'DR' ? tr('power.redundancy.DR') : o.value === 'block-redundant' ? tr('power.redundancy.block') : o.value })),
    [tr],
  );

  return (
    <div className="grid-auto">
      <div className="card" style={{ gridColumn: '1 / -1' }} data-power-standards-checks>
        <h3>{tr('standards.ui.checks.title')}</h3>
        <StandardsChecksView families={['rack', 'power']} />
      </div>
      <div className="card">
        <h3>{tr('power.params.title')}</h3>
        <div className="fields-2">
          <div>
            <SelectField label={tr('power.params.voltage')} value={pw.distributionVoltageV} options={[415, 480, 400, 380].map((v) => ({ value: v as PowerDesign['distributionVoltageV'], label: `${v} V` }))} onChange={(v) => set('distributionVoltageV', v)} />
            <SelectField label={<Term id="busway">{tr('power.params.distribution')}</Term>} value={pw.distribution} options={[{ value: 'busway', label: tr('power.params.dist.busway') }, { value: 'rpp', label: 'RPP' }, { value: 'hybrid', label: tr('power.params.dist.hybrid') }]} onChange={(v) => set('distribution', v)} />
            <SelectField label={<Term id="ups-topology">{tr('power.params.upsRedundancy')}</Term>} value={pw.upsRedundancy} options={redundancy} onChange={(v) => set('upsRedundancy', v)} />
            <SelectField label={<Term id="generator">{tr('power.params.genRedundancy')}</Term>} value={pw.generatorRedundancy} options={redundancy} onChange={(v) => set('generatorRedundancy', v)} />
            <SelectField label={tr('power.params.xfmrRedundancy')} value={pw.transformerRedundancy} options={redundancy} onChange={(v) => set('transformerRedundancy', v)} />
            <SelectField label={<Term id="power-smoothing">{tr('power.params.smoothing')}</Term>} value={pw.powerSmoothing} options={[{ value: 'none', label: tr('power.params.smoothing.none') }, { value: 'rack-level', label: tr('power.params.smoothing.rack') }, { value: 'bess', label: 'BESS' }]} onChange={(v) => set('powerSmoothing', v)} />
          </div>
          <div>
            <SelectField label="UPS" value={pw.upsCatalogId} options={catalogOptions(['ups'])} onChange={(v) => set('upsCatalogId', v)} />
            <SelectField label={tr('power.params.generator')} value={pw.generatorCatalogId} options={catalogOptions(['generator'])} onChange={(v) => set('generatorCatalogId', v)} />
            <SelectField label={tr('power.params.transformer')} value={pw.transformerCatalogId} options={catalogOptions(['transformer'])} onChange={(v) => set('transformerCatalogId', v)} />
            <SelectField label={<><Term id="rpp">RPP</Term>/<Term id="busway">{tr('power.params.busway')}</Term></>} value={pw.rppCatalogId} options={catalogOptions(['rpp'])} onChange={(v) => set('rppCatalogId', v)} />
            <NumberField label={tr('power.params.battery')} unit="min" value={pw.batteryMinutes} onChange={(v) => set('batteryMinutes', v)} />
            <NumberField label={<Term id="pf">{tr('power.params.pf')}</Term>} step={0.01} min={0.7} max={1} value={pw.powerFactor} onChange={(v) => set('powerFactor', v)} />
            <NumberField label={<Term id="derating">{tr('power.params.derating')}</Term>} step={0.05} min={0.5} max={1} value={pw.deratingFactor} onChange={(v) => set('deratingFactor', v)} hint={tr('power.params.deratingHint')} />
            <NumberField label={<Term id="diversity">{tr('power.params.diversity')}</Term>} step={0.05} min={0.3} max={1} value={pw.diversityFactor} onChange={(v) => set('diversityFactor', v)} hint={tr('power.params.diversityHint')} />
          </div>
        </div>
        <Toggle label={tr('power.params.mechOnUps')} checked={pw.mechanicalOnUps} onChange={(v) => set('mechanicalOnUps', v)} />
      </div>

      {!a || !analysis || !result ? (
        <Empty>{tr('power.empty')}</Empty>
      ) : (
        <>
          <PowerPlaneCard project={project} analysis={analysis} scenario={scenario} result={result} tr={tr} />
          <MaxQCard project={project} maxq={a.maxq} tr={tr} />

          <div className="card">
            <h3>{tr('power.load.title')}</h3>
            <div className="grid-3">
              <Stat label={<Term id="nameplate">{tr('power.load.nameplate')}</Term>} value={fmtPower(a.itNameplateKW)} delta={tr('power.load.design', { v: fmtPower(a.itDesignKW) })} />
              <Stat label={<Term id="edpp">{tr('power.load.peak')}</Term>} value={fmtPower(a.itPeakKW)} delta={tr('power.load.peakDelta')} />
              <Stat label={tr('power.load.facility')} value={fmtPower(a.facilityKW)} delta={<><Term id="pue">PUE</Term> {fmt2(a.pue)}</>} />
            </div>
            <div style={{ marginTop: 12 }}>
              <BarChart
                title={tr('power.load.chartTitle')}
                data={[{ label: tr('power.load.chartRow'), values: { it: a.itDesignKW, net: a.networkKW, mech: a.mechanicalKW, loss: a.lossesKW } }]}
                series={[{ key: 'it', name: 'IT' }, { key: 'net', name: tr('power.load.network') }, { key: 'mech', name: tr('power.load.mech') }, { key: 'loss', name: tr('power.load.losses') }]}
                format={(v) => fmtPower(v)}
                labelWidth={110}
                rowHeight={40}
              />
            </div>
          </div>

          <div className="card">
            <h3>{tr('power.infra.title')}</h3>
            <DataTable
              columns={[
                { key: 'n', header: tr('power.infra.col.item'), render: (r: { n: string; units: number; unit: string; inst: string; req: string; ratio: number }) => r.n },
                { key: 'u', header: tr('power.infra.col.units'), num: true, render: (r) => fmtInt(r.units) },
                { key: 'unit', header: tr('power.infra.col.unit'), num: true, render: (r) => r.unit },
                { key: 'i', header: tr('power.infra.col.installed'), num: true, render: (r) => `${r.inst} / ${r.req}` },
                { key: 'm', header: tr('power.infra.col.loading'), render: (r) => <div style={{ minWidth: 90 }}><Meter ratio={r.ratio} label={fmtPct(r.ratio)} /></div> },
              ]}
              rows={[
                { n: 'UPS', units: a.ups.units, unit: `${fmtInt(a.ups.unitKVA)} kVA`, inst: `${fmtInt(a.ups.installedKVA)}`, req: `${fmtInt(a.ups.requiredKVA)} kVA`, ratio: a.ups.installedKVA ? a.ups.requiredKVA / a.ups.installedKVA : 0 },
                { n: tr('power.infra.row.gen'), units: a.generators.units, unit: `${fmtInt(a.generators.unitKW)} kW`, inst: `${fmtInt(a.generators.installedKW)}`, req: `${fmtInt(a.generators.requiredKW)} kW`, ratio: a.generators.installedKW ? a.generators.requiredKW / a.generators.installedKW : 0 },
                { n: tr('power.infra.row.xfmr'), units: a.transformers.units, unit: `${fmtInt(a.transformers.unitKVA)} kVA`, inst: `${fmtInt(a.transformers.installedKVA)}`, req: `${fmtInt(a.transformers.requiredKVA)} kVA`, ratio: a.transformers.installedKVA ? a.transformers.requiredKVA / a.transformers.installedKVA : 0 },
                { n: tr('power.infra.row.rpp'), units: a.rpps.units, unit: `${fmtInt(a.rpps.unitKW)} kW`, inst: '—', req: '—', ratio: a.rpps.maxLoading },
              ]}
              rowKey={(r) => r.n}
            />
            <p className="hint">{tr('power.infra.hint')}</p>
            <p className="hint" data-power-rpp-rule>{tr('power.infra.rppRule', { profile: (project.site.powerProfile ?? 'iec').toUpperCase(), limit: fmtPct(a.rpps.limitFactor ?? project.power.deratingFactor) })}</p>
            {a.upsSizing && (
              <p className="hint" data-power-ups-sizing>
                {tr('power.ups.sizing', { blocks: a.upsSizing.activeBlocks, modules: a.upsSizing.blockModules, n: a.upsSizing.baseModules, pct: fmtPct(a.upsSizing.worstPct / 100, 1), cont: a.upsSizing.worstContingency, count: a.upsSizing.contingencies })}
                {a.upsSizing.override ? ` ${tr('power.ups.sizingOverride')}` : ''}
                {!a.upsSizing.survives ? ` ${tr('power.ups.sizingFail')}` : ''}
              </p>
            )}
          </div>

          {(a.rooms?.length ?? 0) > 0 && (
            <div className="card" data-power-rooms>
              <h3>{tr('power.rooms.title')}</h3>
              <DataTable
                columns={[
                  { key: 'room', header: tr('power.rooms.col.room'), render: (r: NonNullable<typeof a.rooms>[number]) => `${project.halls.find((h) => h.id === r.hallId)?.name ?? r.hallId} · ${r.side}` },
                  { key: 'wall', header: tr('power.rooms.col.wall'), render: (r) => r.wall ?? '—' },
                  { key: 'size', header: tr('power.rooms.col.size'), num: true, render: (r) => `${fmt1(r.rect.w)} × ${fmt1(r.rect.d)}` },
                  { key: 'eq', header: tr('power.rooms.col.equipment'), num: true, render: (r) => `${fmtInt(r.upsModules ?? 0)} · ${fmtInt(r.batteryCabinets ?? 0)} · ${fmtInt(r.switchboardSections ?? 0)}` },
                  { key: 'st', header: tr('power.rooms.col.status'), render: (r) => (r.conflict ? <Pill tone="warn">{tr(`power.rooms.conflict.${r.conflict}`)}</Pill> : <Pill tone="good">{r.relocatedFrom ? tr('power.rooms.moved', { wall: r.relocatedFrom }) : tr('power.rooms.ok')}</Pill>) },
                ]}
                rows={a.rooms ?? []}
                rowKey={(r) => r.id}
              />
              <p className="hint">{tr('power.rooms.hint')}</p>
            </div>
          )}

          <div className="card">
            <h3>{tr('power.utility.title')}</h3>
            <div className="row"><span className="grow secondary"><Term id="n-1-feed">{tr('power.utility.reqAvail')}</Term></span><span className="nowrap">{fmt2(a.utilityRequiredMVA)} / {fmt2(a.utilityAvailableMVA)} MVA</span></div>
            <Meter ratio={a.utilityAvailableMVA ? a.utilityRequiredMVA / a.utilityAvailableMVA : 0} />
            {a.perHall.map((h) => (
              <div key={h.hallId} style={{ marginTop: 10 }}>
                <div className="row"><span className="grow secondary">{project.halls.find((x) => x.id === h.hallId)?.name}</span><span className="nowrap">{fmtPower(h.itKW)} / {fmtPower(h.budgetKW)}</span></div>
                <Meter ratio={h.utilization} />
              </div>
            ))}
          </div>

          <OneLineCard analysis={analysis} result={result} tr={tr} />
        </>
      )}
    </div>
  );
}

// ───────────────────────── power plane ─────────────────────────

type CircuitRow = PowerScenarioResult['paths'][number] & { meta?: PowerPath; failed: boolean };

function PowerPlaneCard({ project, analysis, scenario, result, tr }: { project: Project; analysis: ProjectAnalysis; scenario: PowerScenario; result: PowerScenarioResult; tr: Tr }) {
  const setPowerScenario = useApp((s) => s.setPowerScenario);
  const highlight = useApp((s) => s.powerHighlight);
  const focus = useFocusPower();
  const [showSweep, setShowSweep] = useState(false);
  const busPaths = useMemo(() => new Map((analysis.power.paths ?? []).filter((p) => p.kind === 'busway').map((p) => [p.id, p])), [analysis]);
  const buswayIds = useMemo(() => [...new Set([...busPaths.values()].map((p) => p.buswayId).filter((x): x is string => !!x))].sort(), [busPaths]);
  const hallName = useMemo(() => new Map(project.halls.map((h) => [h.id, h.name])), [project.halls]);
  const tagOf = useMemo(() => new Map(project.equipment.map((e) => [e.id, e.tag])), [project.equipment]);
  const lf = scenario.loadFactor ?? 1;
  const sweep = useMemo(() => (showSweep ? sweepPowerN1(project, analysis, lf) : null), [showSweep, project, analysis, lf]);

  if (!busPaths.size) {
    return (
      <div className="card" style={{ gridColumn: '1 / -1' }}>
        <h3>{tr('power.plane.title')}</h3>
        <Empty>{tr('power.plane.empty')}</Empty>
      </div>
    );
  }
  const sum = result.summary!;
  const failed = new Set(result.failedIds ?? []);
  const apply = (next: PowerScenario) => setPowerScenario(next.kind === 'normal' && (next.loadFactor ?? 1) === 1 ? null : next);
  const targets: string[] =
    scenario.kind === 'busway-failure' ? [...busPaths.keys()].sort()
      : scenario.kind === 'rpp-failure' ? buswayIds
        : scenario.kind === 'ups-module-failure' ? analysis.power.oneLine.nodes.filter((n) => n.kind === 'ups' && n.path !== 'C').map((n) => n.id)
          : scenario.kind === 'utility-loss' ? project.site.utility.map((f) => f.id)
            : [];
  const rows: CircuitRow[] = result.paths.map((p) => {
    const meta = busPaths.get(p.id);
    return { ...p, meta, failed: failed.has(p.id) || (!!meta?.buswayId && failed.has(meta.buswayId)) };
  });
  const pathTone = (r: CircuitRow): ['good' | 'warn' | 'bad' | 'neutral', string] =>
    r.failed ? ['neutral', tr('power.state.failed')] : r.overloaded ? ['bad', tr('power.state.over')] : r.warn ? ['warn', tr('power.state.warn')] : ['good', tr('power.state.ok')];
  const elemTone = (e: PowerElementResult): 'good' | 'warn' | 'bad' | 'neutral' =>
    e.overloaded || e.state === 'shortfall' || e.state === 'lost' ? 'bad' : e.state === 'on-bypass' || e.state === 'transferred' || e.state === 'reduced-redundancy' ? 'warn' : e.state === 'standby' ? 'neutral' : 'good';
  const rackTone = (r: PowerRackOutcome): 'warn' | 'bad' | 'neutral' => (r.state === 'dropped' ? 'bad' : r.state === 'single-path' ? 'neutral' : 'warn');

  return (
    <div className="card" style={{ gridColumn: '1 / -1' }} data-power-plane>
      <div className="row">
        <h3 className="grow">{tr('power.plane.title')}</h3>
        <button className={`btn sm ${showSweep ? 'active' : ''}`} onClick={() => setShowSweep((v) => !v)} data-power-sweep data-ro-allow>{tr('power.plane.sweep')}</button>
        <button className="btn sm" onClick={() => focus([], highlight)} data-power-show3d data-ro-allow>{tr('power.plane.show3d')}</button>
      </div>
      {/* verify v2 2차: scenario / load / target / count are view state (setPowerScenario), not project edits — usable under a read-only lock */}
      <div className="fields-2" data-ro-allow>
        <div>
          <SelectField
            label={tr('power.plane.scenario')}
            value={scenario.kind}
            options={SCENARIO_KINDS.map((k) => ({ value: k, label: tr(`power.scenario.${k}`) }))}
            onChange={(k) => apply({ kind: k, loadFactor: scenario.loadFactor })}
          />
          <NumberField label={tr('power.plane.loadFactor')} unit="%" step={5} min={10} max={150} value={Math.round(lf * 100)} onChange={(v) => apply({ ...scenario, loadFactor: v / 100 })} />
        </div>
        <div>
          {scenario.kind !== 'normal' && (
            <>
              {targets.length > 0 && (
                <SelectField
                  label={tr('power.plane.target')}
                  value={scenario.targetIds?.[0] ?? ''}
                  options={[{ value: '', label: tr('power.plane.worstCase') }, ...targets.map((id) => ({ value: id, label: id }))]}
                  onChange={(v) => apply({ ...scenario, targetIds: v ? [v] : undefined })}
                />
              )}
              <NumberField
                label={tr('power.plane.count')}
                step={1}
                min={1}
                max={8}
                value={scenario.count ?? 1}
                onChange={(v) => apply({ ...scenario, count: Math.max(1, Math.round(v)) })}
                hint={scenario.targetIds?.length ? tr('power.plane.countHint') : undefined}
              />
            </>
          )}
        </div>
      </div>
      <p className="hint">{tr('power.plane.limit', { profile: sum.profile.toUpperCase(), limit: fmtPct(sum.limitFactor), warn: fmtPct(sum.warnAt) })}</p>

      <div className="grid-3" style={{ marginTop: 8 }} data-power-summary>
        <Stat label={tr('power.stat.worst')} value={fmtPct(sum.worstLoadingPct / 100, 1)} delta={tr('power.stat.worstDelta', { id: sum.worstPathId ?? '—' })} />
        <Stat label={tr('power.stat.overloaded')} value={fmtInt(sum.overloadedPaths)} delta={tr('power.stat.warn', { n: sum.warnPaths })} />
        <Stat label={tr('power.stat.dropped')} value={fmtInt(sum.droppedRacks)} delta={tr('power.stat.droppedDelta', { gpus: fmtInt(sum.droppedGpus), kw: fmtPower(sum.droppedKW) })} />
        <Stat label={tr('power.stat.capped')} value={`${fmtInt(sum.cappedRacks)} / ${fmtInt(sum.singlePathRacks)}`} delta={tr('power.stat.cappedDelta', { kw: fmtPower(sum.cappedKW), n: sum.bypassRacks })} />
        <Stat label={tr('power.stat.genset')} value={sum.gensetMarginPct === undefined ? '—' : `${fmt1(sum.gensetMarginPct)} %`} delta={sum.gensetMarginPct === undefined ? tr('power.stat.na') : undefined} />
        <Stat label={tr('power.stat.ups')} value={sum.upsMarginPct === undefined ? '—' : `${fmt1(sum.upsMarginPct)} %`} delta={tr('power.stat.upsDelta')} />
      </div>

      <h4 style={{ marginTop: 14 }}>{tr('power.table.runs')}</h4>
      <p className="hint">{tr('power.plane.selectHint')}</p>
      <DataTable
        columns={[
          { key: 'id', header: tr('power.col.run'), render: (r: CircuitRow) => <span className="mono">{r.id}</span>, sortValue: (r) => r.id },
          { key: 'hall', header: tr('power.col.hall'), render: (r) => hallName.get(r.meta?.hallId ?? '') ?? '—' },
          { key: 'side', header: tr('power.col.side'), render: (r) => r.meta?.side ?? '—' },
          { key: 'racks', header: tr('power.col.racks'), num: true, render: (r) => fmtInt(r.meta?.equipmentIds?.length ?? 0), sortValue: (r) => r.meta?.equipmentIds?.length ?? 0 },
          { key: 'len', header: tr('power.col.length'), num: true, render: (r) => `${fmt1(r.meta?.lengthM)} m`, sortValue: (r) => r.meta?.lengthM ?? 0 },
          { key: 'kw', header: tr('power.col.kw'), num: true, render: (r) => fmtPower(r.kw), sortValue: (r) => r.kw ?? 0 },
          { key: 'loading', header: tr('power.col.loading'), render: (r) => <div style={{ minWidth: 110 }}><Meter ratio={r.loadingPct / 100} label={fmtPct(r.loadingPct / 100, 1)} /></div>, sortValue: (r) => r.loadingPct },
          { key: 'state', header: tr('power.col.state'), render: (r) => { const [tone, label] = pathTone(r); return <Pill tone={tone}>{label}</Pill>; }, sortValue: (r) => (r.failed ? -1 : r.overloaded ? 2 : r.warn ? 1 : 0) },
        ]}
        rows={rows}
        rowKey={(r) => r.id}
        initialSort={{ key: 'loading', dir: -1 }}
        selectedKeys={highlight}
        maxHeight={320}
        onRowClick={(r) => focus(r.meta?.equipmentIds ?? [], [r.id])}
      />

      <div className="fields-2" style={{ marginTop: 14 }}>
        <div>
          <h4>{tr('power.table.elements')}</h4>
          <DataTable
            columns={[
              { key: 'label', header: tr('power.col.element'), render: (e: PowerElementResult) => e.label },
              { key: 'state', header: tr('power.col.state'), render: (e) => <Pill tone={elemTone(e)}>{e.overloaded && (e.state === 'normal' || e.state === 'carrying') ? tr('power.state.over') : tr(`power.elem.${e.state}`)}</Pill> },
              { key: 'load', header: tr('power.col.kw'), num: true, render: (e) => fmtPower(e.loadKW) },
              { key: 'cap', header: tr('power.col.capacity'), num: true, render: (e) => (e.capacityKW === undefined ? '—' : fmtPower(e.capacityKW)) },
              { key: 'ld', header: tr('power.col.loading'), render: (e) => (e.loadingPct === undefined ? '—' : <div style={{ minWidth: 90 }}><Meter ratio={e.loadingPct / 100} label={fmtPct(e.loadingPct / 100, 1)} /></div>) },
            ]}
            rows={result.elements ?? []}
            rowKey={(e) => e.id}
            maxHeight={280}
          />
        </div>
        <div>
          <h4>{tr('power.table.racks')}</h4>
          {(result.racks ?? []).length === 0 ? (
            <p className="hint">{tr('power.racks.none')}</p>
          ) : (
            <DataTable
              columns={[
                { key: 'rack', header: tr('power.col.rack'), render: (r: PowerRackOutcome) => tagOf.get(r.id) ?? r.id, sortValue: (r) => tagOf.get(r.id) ?? r.id },
                { key: 'state', header: tr('power.col.state'), render: (r) => <Pill tone={rackTone(r)}>{tr(`power.rack.${r.state}`)}</Pill>, sortValue: (r) => r.state },
                { key: 'ab', header: tr('power.col.kwAB'), num: true, render: (r) => `${fmt1(r.kwA)} / ${fmt1(r.kwB)}` },
                { key: 'reason', header: tr('power.col.reason'), render: (r) => <span className="secondary">{r.reason ?? ''}</span> },
              ]}
              rows={result.racks ?? []}
              rowKey={(r) => r.id}
              maxHeight={280}
              selectedKeys={useApp.getState().selection}
              onRowClick={(r) => focus([r.id], [r.id])}
            />
          )}
        </div>
      </div>

      <details style={{ marginTop: 10 }}>
        <summary className="secondary">{tr('power.notes')}</summary>
        <ul className="hint" style={{ margin: '6px 0 0 16px' }}>{result.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
      </details>

      {sweep && (
        <div style={{ marginTop: 14 }} data-power-sweep-table>
          <h4>{tr('power.sweep.title')}</h4>
          <p className="hint">{tr('power.sweep.summary', { n: sweep.contingencies, dropped: sweep.droppedRackIds.length })}</p>
          <DataTable
            columns={[
              { key: 'id', header: tr('power.col.element'), render: (r: (typeof sweep.rows)[number]) => <span className="mono">{r.id}</span>, sortValue: (r) => r.id },
              { key: 'normal', header: tr('power.col.normal'), num: true, render: (r) => fmtPct(r.normalPct / 100, 1), sortValue: (r) => r.normalPct },
              { key: 'worst', header: tr('power.col.worst'), render: (r) => <div style={{ minWidth: 110 }}><Meter ratio={r.worstPct / 100} label={fmtPct(r.worstPct / 100, 1)} /></div>, sortValue: (r) => r.worstPct },
              { key: 'c', header: tr('power.col.contingency'), render: (r) => <span className="secondary">{r.contingency}</span> },
            ]}
            rows={sweep.rows}
            rowKey={(r) => r.id}
            initialSort={{ key: 'worst', dir: -1 }}
            maxHeight={300}
            onRowClick={(r) => { const p = busPaths.get(r.id); if (p) focus(p.equipmentIds ?? [], [r.id]); }}
          />
        </div>
      )}
    </div>
  );
}

// ───────────────────────── Max-Q ─────────────────────────

function MaxQCard({ project, maxq, tr }: { project: Project; maxq: MaxQReport | undefined; tr: Tr }) {
  const update = useApp((s) => s.update);
  const opts = project.power.maxq ?? {};
  const setOpt = (patch: NonNullable<PowerDesign['maxq']>) => update((d) => { d.power.maxq = { ...(d.power.maxq ?? {}), ...patch }; });
  const hasVr = project.equipment.some((e) => e.catalogId === 'nvidia-vr-nvl72');
  if (!maxq) {
    return (
      <div className="card">
        <h3>{tr('power.maxq.title')}</h3>
        <Empty>{tr('power.maxq.none')}</Empty>
      </div>
    );
  }
  const racks = maxq.racks ?? 0;
  return (
    <div className="card" data-power-maxq>
      <h3>{tr('power.maxq.title')}</h3>
      <div className="grid-3">
        <Stat label={tr('power.maxq.budget')} value={fmtPower(maxq.budgetKW)} delta={tr('power.maxq.budgetDelta', { racks: fmtInt(racks), kw: fmtPower(maxq.allocationKWPerRack) })} />
        <Stat label={tr('power.maxq.draw')} value={fmtPower(maxq.drawKW)} delta={tr('power.maxq.drawDelta', { basis: tr(`power.maxq.draw.${maxq.drawBasis ?? 'peak'}`), kw: fmtPower(maxq.drawKWPerRack) })} />
        <Stat label={tr('power.maxq.stranded')} value={fmtPower(maxq.strandedKW)} delta={tr('power.maxq.strandedDelta', { pct: fmtPct(maxq.budgetKW ? maxq.strandedKW / maxq.budgetKW : 0, 1) })} />
        <Stat label={tr('power.maxq.extra')} value={`+${fmtInt(maxq.extraRacks)}`} delta={tr('power.maxq.extraDelta', { kw: fmtPower(maxq.newRackDrawKW), h: fmtPower(maxq.headroomKW) })} />
        <Stat label={tr('power.maxq.gpusPerMW')} value={`${fmtInt(maxq.gpusPerMWStatic)} → ${fmtInt(maxq.gpusPerMWDynamic)}`} delta={tr('power.maxq.gpusDelta', { pct: fmtPct(maxq.gpusPerMWStatic ? maxq.gpusPerMWDynamic / maxq.gpusPerMWStatic - 1 : 0, 1) })} />
        <Stat label={tr('power.maxq.capDepth')} value={fmtPct(maxq.capDepth ?? 0, 1)} delta={tr('power.maxq.capDelta')} />
      </div>
      <div style={{ marginTop: 12 }}>
        <BarChart
          title={tr('power.maxq.chart')}
          data={[
            { label: tr('power.maxq.static'), values: { g: maxq.gpusPerMWStatic } },
            { label: tr('power.maxq.dynamic'), values: { g: maxq.gpusPerMWDynamic } },
            ...(maxq.staticMaxQ && racks > 0 && maxq.budgetKW > 0 ? [{ label: tr('power.maxq.staticMaxQ', { q: maxq.staticMaxQ.settingKW }), values: { g: (maxq.staticMaxQ.racks * ((maxq.gpus ?? 0) / racks)) / (maxq.budgetKW / 1000) } }] : []),
          ]}
          series={[{ key: 'g', name: tr('power.maxq.gpusPerMW') }]}
          format={(v) => fmtInt(v)}
          labelWidth={150}
          rowHeight={32}
        />
      </div>
      <p className="hint">{tr('power.maxq.explain')}</p>
      <div className="fields-2">
        <SelectField
          label={tr('power.maxq.vrBasis')}
          value={opts.vrBasis ?? 'maxlps-docs'}
          options={[{ value: 'maxlps-docs', label: tr('power.maxq.vr.docs') }, { value: 'maxlps-blog', label: tr('power.maxq.vr.blog') }]}
          onChange={(v) => setOpt({ vrBasis: v })}
          hint={hasVr ? undefined : tr('power.maxq.vrHint')}
        />
        <div>
          <SelectField
            label={tr('power.maxq.budgetBasis')}
            value={opts.budgetBasis ?? 'allocation'}
            options={(['allocation', 'hall-budget', 'custom'] as const).map((v) => ({ value: v, label: tr(`power.maxq.budget.${v}`) }))}
            onChange={(v) => setOpt({ budgetBasis: v })}
            hint={tr('power.maxq.budgetHint')}
          />
          {opts.budgetBasis === 'custom' && (
            <NumberField label={tr('power.maxq.budgetKW')} unit="kW" step={100} min={0} value={opts.budgetKW ?? Math.round(maxq.allocatedKW ?? maxq.budgetKW)} onChange={(v) => setOpt({ budgetKW: Math.max(0, v) })} />
          )}
          <SelectField label={tr('power.maxq.drawBasis')} value={opts.drawBasis ?? 'peak'} options={[{ value: 'peak', label: tr('power.maxq.draw.peak') }, { value: 'avg', label: tr('power.maxq.draw.avg') }]} onChange={(v) => setOpt({ drawBasis: v })} />
          <NumberField label={tr('power.maxq.reserve')} unit="%" step={1} min={0} max={30} value={Math.round((opts.reserveFraction ?? 0) * 100)} onChange={(v) => setOpt({ reserveFraction: Math.max(0, v) / 100 })} hint={tr('power.maxq.reserveHint')} />
        </div>
      </div>
      <p className="hint">{tr('power.maxq.allocation', { basis: maxq.allocationBasis ?? '' })}</p>
      {maxq.utilization !== undefined && (
        <p className="hint" data-maxq-util>{maxq.utilization > 1 + 1e-9 ? tr('power.maxq.utilOver', { pct: fmtPct(maxq.utilization, 1) }) : tr('power.maxq.util', { pct: fmtPct(maxq.utilization, 1), kw: fmtPower(maxq.networkShareKW ?? 0) })}</p>
      )}
      <div className="secondary" style={{ fontSize: 12 }}>{tr('power.maxq.sources')}</div>
      <ul className="hint" style={{ margin: '4px 0 0 16px' }}>
        {(maxq.sources ?? []).map((s) => (
          <li key={s.label}>
            {s.url ? <a href={s.url} target="_blank" rel="noreferrer">{s.label}</a> : s.label} <span className="pill">{tr(`power.source.${s.sourceType}`)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ───────────────────────── one-line ─────────────────────────

function OneLineCard({ analysis, result, tr }: { analysis: ProjectAnalysis; result: PowerScenarioResult; tr: Tr }) {
  const focus = useFocusPower();
  const a = analysis.power;
  const nodeStates = useMemo(() => {
    const st: Record<string, OneLineNodeState> = {};
    for (const e of result.elements ?? []) {
      if (e.overloaded || e.state === 'shortfall') st[e.id] = 'over';
      else if (e.state === 'lost') st[e.id] = 'failed';
      else if (e.state === 'on-bypass' || e.state === 'transferred' || e.state === 'reduced-redundancy') st[e.id] = 'warn';
    }
    const failed = new Set(result.failedIds ?? []);
    const sideOf = new Map((a.paths ?? []).filter((p) => p.kind === 'busway').map((p) => [p.id, p]));
    for (const side of ['A', 'B'] as const) {
      const ps = result.paths.filter((p) => sideOf.get(p.id)?.side === side);
      if (ps.some((p) => p.overloaded)) st[`bus-${side}`] = 'over';
      else if (ps.some((p) => failed.has(p.id) || failed.has(sideOf.get(p.id)?.buswayId ?? ''))) st[`bus-${side}`] = 'failed';
      else if (ps.some((p) => p.warn)) st[`bus-${side}`] = 'warn';
    }
    return st;
  }, [result, a.paths]);
  const onNode = (n: OneLineNode) => {
    if (n.refs?.length) focus(n.refs, n.refs);
  };
  return (
    <div className="card" style={{ gridColumn: '1 / -1' }} data-power-oneline>
      <h3><Term id="one-line">{tr('power.oneline.title')}</Term></h3>
      <p className="hint">{tr('power.oneline.hint')}</p>
      {a.oneLine.nodes.length ? <OneLineDiagram oneLine={a.oneLine} nodeStates={nodeStates} onNodeClick={onNode} /> : <Empty>{tr('power.oneline.empty')}</Empty>}
    </div>
  );
}

