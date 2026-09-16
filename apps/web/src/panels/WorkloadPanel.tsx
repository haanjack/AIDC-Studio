import { useMemo, useState, type ReactNode } from 'react';
import {
  acceleratorPeakSource, applyModelPreset, BENCHMARKS, calibrateFromBenchmark, calibrationRecord, catalogItems, REF_POD_TEMPLATE, effectiveShare,
  fillRemainder, findBenchmark, findCatalogItem, findModelPreset, INFERENCE_HBM_UTILIZATION, inferenceMemoryEstimate, inferenceParallelismFor, inferenceReplicaGpus, MFU_DEFAULT, MODEL_PRESETS, NODE_SPECS, normalizeShares, peakFlopsFor, podSizing,
  presetModifiedFields, scaleWarning, shareState, takeShareDetailed,
  type BenchmarkRow, type CalibrationPrecision, type CalibrationWarning, type CatalogItem, type SizingSuggestion, type UserMeasurement,
  type InferenceMemoryEstimate, type InferenceParallelism, type WorkloadAnalysis, type WorkloadBlueprint, type WorkloadKind,
} from '@aidc/core';
import { useApp } from '../store/appStore.ts';
import { WORKLOAD_TEMPLATES } from '../app/derived.ts';
import { downloadText } from '../app/api.ts';
import { fmt1, fmt2, fmtInt, fmtMoney, fmtPct, fmtPower } from '../app/format.ts';
import { useI18n } from '../i18n/index.ts';
import { BarChart, LineChart } from '../ui/charts.tsx';
import { DataTable, Empty, Field, NumberField, Section, Seg, SelectField, SourceBadge, Stat, StatusIcon, StatusLabel, TextField, Toggle } from '../ui/controls.tsx';
import { Icon } from '../ui/icons.tsx';
import { Term } from '../ui/Term.tsx';

/** Racks per neutral planning DU (2 rows × 12); vendor SU boundaries are selected later with a cited architecture. */
const RACKS_PER_POD = REF_POD_TEMPLATE.racksPerRow * 2;
/** Network + services share of IT power on top of the GPU racks (estimate). */
const NETWORK_SHARE = 0.08;
/** Perimeter CRAH zone on both row ends (CRAH depth + service clearance + aisle, DU generator) and margins (estimate). */
const CRAH_ZONE_M = 3.65;
const MARGIN_M = 1.0;
const SERVICES_ROW_M = 4.0;
/** MoE efficiency evidence rows (MLPerf® Training v6.0 results 6.0-0013 / 6.0-0102, same GB300 NVL72 type, 512 GPUs, NeMo 26.04; derived by AIDC Studio). */
const EVIDENCE_DENSE = 'mlperf-t60-llama405b-gb300-512-eth';
const EVIDENCE_MOE = 'mlperf-t60-dsv3-gb300-512';

type TargetKind = 'train-days' | 'tokens-per-s';
type Translate = (key: string, params?: Record<string, string | number>) => string;
type Tag = 'compute' | 'memory' | 'bytes' | 'calib' | 'power' | 'goodput';
const TAG_COLOR: Record<Tag, string> = { compute: '#93bdf0', memory: '#c9a9f2', bytes: '#7fd8b5', calib: '#e5b95e', power: '#f0a58f', goodput: '#cfd3d8' };

const isTrainingKind = (k: WorkloadKind) => k === 'llm-pretrain' || k === 'llm-finetune';

/** One-line "what this field affects" hint: impact tags + short text (rendered visibly under the control). */
function Affects({ tags, text, t }: { tags: Tag[]; text: string; t: Translate }) {
  return (
    <span>
      {tags.map((k) => (
        <span key={k} className="badge" style={{ color: TAG_COLOR[k], marginRight: 4, fontSize: 10, padding: '0 5px' }}>{t(`workload.tag.${k}`)}</span>
      ))}
      {text}
    </span>
  );
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  if (!/^https?:\/\//.test(href)) return <span title={href}>{children}</span>;
  return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
}

function InferenceParallelFields({ title, value, onChange, memory, t }: {
  title: string;
  value: InferenceParallelism;
  onChange: (next: InferenceParallelism) => void;
  memory?: InferenceMemoryEstimate;
  t: Translate;
}) {
  const minTp = memory?.minimumTp ?? 1;
  const set = (key: keyof InferenceParallelism, raw: number) => onChange({ ...value, [key]: Math.max(key === 'tp' ? minTp : 1, Math.round(raw)) });
  return (
    <div className="card" style={{ background: 'var(--surface-2)' }}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
        <strong>{title}</strong>
        <span className="badge">{t('workload.parallel.replicaGpus', { n: inferenceReplicaGpus(value) })}</span>
      </div>
      {memory && (
        <div style={{ marginBottom: 8 }}>
          <div className="row wrap" style={{ gap: 6 }}>
            <StatusLabel severity={memory.fits ? 'good' : 'error'}>{t(memory.fits ? 'workload.memory.fits' : 'workload.memory.oom')}</StatusLabel>
            <span className="hint">{t('workload.memory.breakdown', {
              weights: fmt1(memory.weightGBPerGpu), kv: fmt1(memory.kvGBPerGpu), used: fmt1(memory.totalGBPerGpu),
              usable: fmt1(memory.usableHbmGB), physical: fmt1(memory.gpuMemoryGB), pct: fmtPct(memory.hbmUtilization),
            })}</span>
          </div>
          <p className="caption" style={{ margin: '4px 0 0' }}>{t('workload.memory.basis', { wp: memory.weightPrecision.toUpperCase(), kvp: memory.kvPrecision.toUpperCase(), tokens: fmtInt(memory.tokenResidency) })}</p>
          {memory.minimumTp ? (
            <div className="row wrap" style={{ gap: 6, marginTop: 5 }}>
              <span className={`pill ${memory.crossesScaleUp ? 'warn' : 'good'}`}><span className="dot" />{t('workload.memory.minimumTp', { tp: memory.minimumTp })}</span>
              {memory.topology.tp !== memory.minimumTp && <button className="btn sm" onClick={() => onChange({ ...value, tp: memory.minimumTp! })}>{t('workload.memory.apply')}</button>}
              {memory.crossesScaleUp && <span className="hint">{t('workload.memory.scaleOutWarning')}</span>}
            </div>
          ) : <p className="hint warn-text" style={{ margin: '5px 0 0' }}>{t('workload.memory.noFit')}</p>}
        </div>
      )}
      <div className="fields-2">
        <NumberField label={t('workload.f.infTpOverride')} value={value.tp} min={minTp} onChange={(v) => set('tp', v)} hint={<Affects tags={['memory', 'bytes']} text={t('workload.h.infTp')} t={t} />} />
        <NumberField label="CP" value={value.cp} min={1} onChange={(v) => set('cp', v)} hint={<Affects tags={['memory', 'bytes']} text={t('workload.h.infCp')} t={t} />} />
        <NumberField label="PP" value={value.pp} min={1} onChange={(v) => set('pp', v)} hint={<Affects tags={['memory', 'bytes']} text={t('workload.h.infPp')} t={t} />} />
        <NumberField label="EP" value={value.ep} min={1} onChange={(v) => set('ep', v)} hint={<Affects tags={['memory', 'bytes']} text={t('workload.h.infEp')} t={t} />} />
      </div>
    </div>
  );
}

export function WorkloadPanel() {
  const project = useApp((s) => s.project);
  const analysis = useApp((s) => s.analysis);
  const update = useApp((s) => s.update);
  const notify = useApp((s) => s.notify);
  const sizingSuggestion = useApp((s) => s.sizingSuggestion);
  const setSizingSuggestion = useApp((s) => s.setSizingSuggestion);
  const setPage = useApp((s) => s.setPage);
  const { t, locale } = useI18n();
  const [selId, setSelId] = useState(project.workloads[0]?.id ?? '');
  const [tpl, setTpl] = useState(WORKLOAD_TEMPLATES[0].key);
  const [advOpen, setAdvOpen] = useState(false);
  const [shareWant, setShareWant] = useState(0.5);
  const wl = project.workloads.find((w) => w.id === selId) ?? project.workloads[0];
  const wa = analysis?.workloads.find((w) => w.workloadId === wl?.id);
  // shares are taken inside the cluster the job runs in (largest cluster — engines/workload.ts jobClusterGpus / traffic.ts)
  const clusterGpus = analysis?.network.clusters?.length ? Math.max(...analysis.network.clusters.map((c) => c.gpus)) : (analysis?.summary.gpus ?? 0);
  const shares = shareState(project.workloads);

  const setW = (fn: (w: WorkloadBlueprint) => void) => update((d) => { const w = d.workloads.find((x) => x.id === wl.id); if (w) fn(w); });
  const days = (v: number | undefined) => (v == null || !Number.isFinite(v) ? '–' : `${fmt1(v)} ${t('workload.u.days')}`);
  const notesOf = (a: WorkloadAnalysis) => (locale === 'ko' ? a.notes : a.notesEn?.length ? a.notesEn : a.notes);

  // The simulation always follows the dominant accelerator platform actually placed in Layout. The neutral fallback is
  // used only by the optional reverse-sizing what-if when no cluster has been placed yet.
  const placedGpuPlatform = useMemo(() => {
    const counts = new Map<string, { gpus: number; racks: number }>();
    for (const e of project.equipment) {
      const it = findCatalogItem(e.catalogId);
      if (it?.category !== 'gpu-rack' || typeof e.meta?.computeSlot === 'string') continue;
      const cur = counts.get(it.id) ?? { gpus: 0, racks: 0 };
      cur.gpus += it.compute?.gpus ?? 0;
      cur.racks += 1;
      counts.set(it.id, cur);
    }
    const primary = [...counts.entries()].sort((a, b) => b[1].gpus - a[1].gpus)[0];
    return primary ? { id: primary[0], ...primary[1] } : undefined;
  }, [project.equipment]);
  const placedGpuRack = placedGpuPlatform ? findCatalogItem(placedGpuPlatform.id) : undefined;
  const gpuRackId = placedGpuPlatform?.id ?? REF_POD_TEMPLATE.gpuRackCatalogId;
  const gpuRack = findCatalogItem(gpuRackId);
  const [targetKind, setTargetKind] = useState<TargetKind>('train-days');
  const [targetDays, setTargetDays] = useState(90);
  const [targetTps, setTargetTps] = useState(1_000_000);
  const [mfuOverride, setMfuOverride] = useState(0);
  const precision = wl?.training?.precision ?? 'bf16';
  const mfuDef = MFU_DEFAULT[precision] ?? MFU_DEFAULT.bf16;
  const mfu = mfuOverride > 0 ? mfuOverride : wl?.training?.mfuAssumed && wl.training.mfuAssumed > 0 ? wl.training.mfuAssumed : mfuDef.value;
  const sizing = useMemo(() => {
    const c = gpuRack?.compute;
    if (!wl || !gpuRack || !c || c.gpus <= 0) return null;
    const m = wl.model;
    const n = m.activeParamsB * 1e9;
    const flopsPerToken = (wl.training?.activationRecompute ? 8 : 6) * n + (wl.training?.activationRecompute ? 16 : 12) * m.layers * m.hiddenSize * m.seqLen;
    const peak = peakFlopsFor(c, precision);
    let gpus: number;
    let note: string;
    if (wl.kind === 'llm-inference') {
      const req = wa?.gpusRequired;
      if (!req || !wl.inference) return null;
      const scale = targetKind === 'tokens-per-s' ? targetTps / (wl.inference.requestsPerSec * (wl.inference.inputTokens + wl.inference.outputTokens)) : 1;
      gpus = Math.ceil(req * scale);
      note = targetKind === 'tokens-per-s' ? t('workload.size.noteInfScaled', { req: fmtInt(req), tps: fmtInt(targetTps) }) : t('workload.size.noteInf', { req: fmtInt(req), rps: wl.inference.requestsPerSec });
    } else if (wl.training) {
      const tpp = Math.max(1, wl.training.tp * (wl.training.cp ?? 1) * wl.training.pp);
      const goodput = wa?.goodput ?? 0.9;
      const raw = targetKind === 'train-days' ? (wl.training.tokensB * 1e9 * flopsPerToken) / (targetDays * 86400 * peak * mfu * goodput) : (targetTps * flopsPerToken) / (peak * mfu);
      gpus = Math.ceil(raw / tpp) * tpp;
      note = targetKind === 'train-days'
        ? t('workload.size.noteTrainDays', { tokens: fmt1(wl.training.tokensB / 1000), days: targetDays, mfu: fmtPct(mfu), goodput: fmtPct(goodput), tpp })
        : t('workload.size.noteTps', { tps: fmtInt(targetTps), mfu: fmtPct(mfu), tpp });
    } else return null;
    const racks = Math.ceil(gpus / c.gpus);
    const pods = Math.ceil(racks / RACKS_PER_POD);
    const itMW = (racks * (gpuRack.power?.nameplateKW ?? 0) * (1 + NETWORK_SHARE)) / 1000;
    let areaM2 = 0;
    try {
      const s = podSizing({ ...REF_POD_TEMPLATE, gpuRackCatalogId: gpuRack.id });
      const width = s.rowLength + 2 * CRAH_ZONE_M + 2 * MARGIN_M;
      areaM2 = width * (pods * (s.podDepth + REF_POD_TEMPLATE.outerAisleM) + SERVICES_ROW_M + 2 * MARGIN_M);
    } catch {
      areaM2 = pods * 24 * 0.72 * 5;
    }
    return { gpus, racks, pods, itMW, areaM2, note, peak };
  }, [wl, wa, gpuRack, precision, mfu, targetKind, targetDays, targetTps, t]);

  const storeSuggestion = () => {
    if (!wl || !sizing || !gpuRack) return;
    const s: SizingSuggestion = {
      workloadId: wl.id,
      workloadName: wl.name,
      gpuRackCatalogId: gpuRack.id,
      gpus: sizing.gpus,
      racks: sizing.racks,
      pods: sizing.pods,
      racksPerPod: RACKS_PER_POD,
      itMW: sizing.itMW,
      areaM2: sizing.areaM2,
      target: targetKind === 'train-days' ? { kind: 'train-days', days: targetDays } : { kind: 'tokens-per-s', tokensPerS: targetTps },
      mfu,
      source: 'estimate',
      createdAt: new Date().toISOString(),
    };
    setSizingSuggestion(s);
    notify(t('workload.size.toast', { gpus: fmtInt(s.gpus), pods: s.pods, mw: fmt1(s.itMW) }), 'ok');
    setPage('architecture');
  };

  // ── GPU shares ──
  const normalize = () => {
    if (!update((d) => { d.workloads = normalizeShares(d.workloads); })) return;
    notify(t('workload.share.normalized', { total: fmtPct(shares.total) }), 'ok');
  };
  const fitRest = () => update((d) => { d.workloads = fillRemainder(d.workloads, wl.id, { clusterGpus }); });
  const take = () => {
    const r = takeShareDetailed(project.workloads, wl.id, shareWant, { clusterGpus });
    if (!update((d) => { d.workloads = r.workloads.map((w) => structuredClone(w)); })) return;
    const others = Object.values(r.taken).reduce((s, v) => s + v, 0);
    notify(r.capped ? t('workload.share.takeCapped', { share: fmtPct(r.granted, 1), want: fmtPct(shareWant, 1) }) : t('workload.share.takeOk', { name: wl.name, share: fmtPct(r.granted, 1), others: fmtPct(others, 1) }), r.capped ? 'info' : 'ok');
  };

  // ── presets ──
  const applyPreset = (id: string) => setW((w) => {
    const p = id ? findModelPreset(id) : undefined;
    if (!p) { delete w.presetId; return; }
    w.model = applyModelPreset(w.model, p);
    w.presetId = p.id;
    if (!p.moe && w.training) w.training.ep = 1;
    if (w.inference) {
      const keys = ['parallelism', 'prefillParallelism', 'decodeParallelism'] as const;
      for (const key of keys) {
        const topology = w.inference[key];
        if (!topology) continue;
        topology.ep = p.moe ? Math.max(2, topology.ep) : 1;
      }
    }
    // fix v2 2차 (QA): an MoE preset on a dense training blueprint kept EP = 1 → 0 all-to-all bytes, optimistic step time
    if (p.moe && w.training && (w.training.ep ?? 1) <= 1) {
      const tplEp = WORKLOAD_TEMPLATES.find((x) => x.presetId === p.id)?.make().training?.ep;
      const experts = p.moe.experts ?? 1;
      const ep = tplEp && tplEp > 1 ? tplEp : Math.max(2, 2 ** Math.floor(Math.log2(Math.min(64, experts))));
      w.training.ep = ep;
      setTimeout(() => notify(t('workload.preset.epSet', { ep, name: p.name }), 'info'), 0);
    }
  });
  const preset = wl?.presetId ? findModelPreset(wl.presetId) : undefined;
  const modified = wl ? presetModifiedFields(wl) : [];
  const setInferenceServingMode = (mode: 'aggregated' | 'disaggregated') => setW((w) => {
    const cur = w.inference;
    if (!cur || cur.disaggregated === (mode === 'disaggregated')) return;
    if (mode === 'disaggregated') {
      const common = inferenceParallelismFor(cur, 'aggregated');
      cur.prefillParallelism ??= { ...common };
      cur.decodeParallelism ??= { ...common };
      cur.disaggregated = true;
    } else {
      const decode = inferenceParallelismFor(cur, 'decode');
      cur.parallelism ??= { ...decode };
      cur.disaggregated = false;
    }
  });

  const dense = findBenchmark(EVIDENCE_DENSE)?.derived?.tflopsPerGpu;
  const moe = findBenchmark(EVIDENCE_MOE)?.derived?.tflopsPerGpu;
  const tr = wl?.training;
  const inf = wl?.inference;
  const inferenceMemory = (() => {
    const c = placedGpuRack?.compute;
    if (!wl || !inf || !c?.gpuMemoryGB) return undefined;
    const estimate = (stage: 'aggregated' | 'prefill' | 'decode') => inferenceMemoryEstimate(wl, stage, inferenceParallelismFor(inf, stage), c.gpuMemoryGB, c.scaleUp.domainSize);
    return inf.disaggregated
      ? { prefill: estimate('prefill'), decode: estimate('decode') }
      : { aggregated: estimate('aggregated') };
  })();
  const kindOptions: { value: WorkloadKind; label: string }[] = (['llm-pretrain', 'llm-finetune', 'llm-inference', 'hpc-simulation'] as WorkloadKind[]).map((k) => ({ value: k, label: t(`workload.kind.${k}`) }));

  return (
    <div className="grid-auto">
      {/* ── A. explanation ── */}
      <div className="card" style={{ gridColumn: '1 / -1' }}>
        <h3>{t('workload.intro.title')}</h3>
        <p className="hint" style={{ marginTop: 0 }}>{t('workload.intro.what')}</p>
        <div className="fields-2">
          <div>
            <div className="section-title"><span><Icon name="check" size={12} /> {t('workload.intro.det.title')}</span><span className="line" /></div>
            <ul className="hint" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              <li><Affects tags={['compute']} text={t('workload.intro.det.compute')} t={t} /></li>
              <li><Affects tags={['memory']} text={t('workload.intro.det.memory')} t={t} /></li>
              <li><Affects tags={['bytes']} text={t('workload.intro.det.bytes')} t={t} /></li>
              <li><Affects tags={['power']} text={t('workload.intro.det.power')} t={t} /></li>
            </ul>
          </div>
          <div>
            <div className="section-title"><span><Icon name="warning" size={12} /> {t('workload.intro.cal.title')}</span><span className="line" /></div>
            <p className="hint" style={{ margin: '4px 0 0' }}><Affects tags={['calib']} text={t('workload.intro.cal.body')} t={t} /></p>
            <p className="hint" style={{ margin: '6px 0 0' }}><Term id="moe">MoE</Term> — {t('workload.intro.moe')}</p>
          </div>
        </div>
        {dense && moe && (
          <p className="caption" style={{ marginTop: 8 }}>
            <strong>{t('workload.intro.evidenceTitle')}</strong> {t('workload.intro.evidence', { dense: fmtInt(dense), moe: fmtInt(moe), ratio: (moe / dense).toFixed(2) })}{' '}
            <ExternalLink href={findBenchmark(EVIDENCE_DENSE)!.sourceUrl}>405B</ExternalLink> · <ExternalLink href={findBenchmark(EVIDENCE_MOE)!.sourceUrl}>DeepSeek-V3</ExternalLink>{' '}
            <span className="badge src-public-spec">{t('workload.src.derivedFromMeasured')}</span>
            <br /><span className="hint" style={{ fontSize: 11 }}>{t('workload.mlperf.notice')}</span>
          </p>
        )}
      </div>

      {/* ── B. placed-cluster simulation basis ── */}
      <div className="card" style={{ gridColumn: '1 / -1' }}>
        <div className="row wrap" style={{ justifyContent: 'space-between', gap: 8 }}>
          <h3 style={{ margin: 0 }}>{t('workload.hardware.title')}</h3>
          <div className="row wrap" style={{ gap: 6 }}>
            <button className="btn ghost sm" onClick={() => setPage('architecture')}><Icon name="architecture" size={13} />{t('workload.hardware.changePlatform')}</button>
            <button className="btn ghost sm" onClick={() => setPage('layout')}><Icon name="layout" size={13} />{t('workload.hardware.openLayout')}</button>
          </div>
        </div>
        {placedGpuRack?.compute ? (
          <>
            <div className="grid-4" style={{ marginTop: 10 }}>
              <Stat label={t('workload.hardware.platform')} value={placedGpuRack.name} delta={<span>{placedGpuRack.vendor} · <SourceBadge source={placedGpuRack.source} /></span>} />
              <Stat label={t('workload.hardware.cluster')} value={t('workload.hardware.gpus', { n: fmtInt(clusterGpus) })} delta={t('workload.hardware.primaryRacks', { racks: placedGpuPlatform?.racks ?? 0, gpus: placedGpuPlatform?.gpus ?? 0 })} />
              <Stat label={t('workload.hardware.hbm')} value={`${fmt1(placedGpuRack.compute.gpuMemoryGB)} GB/GPU`} delta={t('workload.hardware.usable', { n: fmt1(placedGpuRack.compute.gpuMemoryGB * INFERENCE_HBM_UTILIZATION), pct: fmtPct(INFERENCE_HBM_UTILIZATION) })} />
              <Stat
                label={t('workload.hardware.scaleUp')}
                value={placedGpuRack.compute.scaleUp.family ?? ({ nvlink: 'NVLink', ualink: 'UALink', 'esun-ethernet': 'ESUN Ethernet', pcie: 'PCIe', 'vendor-proprietary': t('workload.hardware.proprietary'), none: t('workload.hardware.none') }[placedGpuRack.compute.scaleUp.kind])}
                delta={t('workload.hardware.domain', { n: placedGpuRack.compute.scaleUp.domainSize })}
              />
            </div>
            <p className="hint" style={{ margin: '8px 0 0' }}>{t('workload.hardware.actual')}</p>
            {(placedGpuRack.vendor === 'Generic' || placedGpuRack.source === 'estimate') && <p className="hint warn-text" style={{ margin: '5px 0 0' }}>{t('workload.hardware.estimateWarning')}</p>}
          </>
        ) : (
          <div style={{ marginTop: 10 }}>
            <StatusLabel severity="warning">{t('workload.hardware.missing')}</StatusLabel>
            <p className="hint" style={{ margin: '6px 0 0' }}>{t('workload.hardware.missingBody')}</p>
          </div>
        )}
      </div>

      {/* ── C. blueprint list + share meter ── */}
      <div className="card">
        <h3>{t('workload.list.title')}</h3>
        <DataTable
          columns={[
            { key: 'n', header: t('workload.col.name'), render: (w: WorkloadBlueprint) => w.name },
            { key: 'k', header: t('workload.col.kind'), render: (w) => t(`workload.kind.${w.kind}`) },
            { key: 'g', header: t('workload.col.share'), num: true, render: (w) => shares.state === 'over' ? <span title={t('workload.share.scaledTitle')}>{fmtPct(w.gpuShare)} → {fmtPct(effectiveShare(project.workloads, w), 1)}</span> : fmtPct(w.gpuShare) },
            { key: 'r', header: t('workload.col.result'), num: true, render: (w) => { const a = analysis?.workloads.find((x) => x.workloadId === w.id); return a?.timeToTrainDays != null ? days(a.timeToTrainDays) : a?.gpusRequired != null ? `${fmtInt(a.gpusRequired)} GPU` : '–'; } },
            { key: 's', header: t('workload.col.status'), render: (w) => (
              <span className="row" style={{ gap: 4 }}>
                {w.presetId && <span className="badge" title={findModelPreset(w.presetId)?.sourceUrl}>{t('workload.badge.preset')}{presetModifiedFields(w).length ? '*' : ''}</span>}
                {w.calibration ? <span className="badge src-public-spec" title={w.calibration.source}>{t('workload.badge.calibrated')}</span> : isTrainingKind(w.kind) || w.kind === 'llm-inference' ? <span className="badge src-estimate" title={t('workload.badge.uncalibratedTitle')}>{t('workload.badge.uncalibrated')}</span> : null}
              </span>
            ) },
          ]}
          rows={project.workloads}
          rowKey={(w) => w.id}
          selectedKeys={wl ? [wl.id] : []}
          onRowClick={(w) => setSelId(w.id)}
        />
        <div style={{ marginTop: 10 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="hint">{t('workload.share.title')}</span>
            <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtPct(shares.total, 1)}</strong>
          </div>
          {/* share meter: 100 % is the healthy state, so only over-allocation is coloured (Meter's 85 % warning band does not apply) */}
          <div title={t('workload.share.title')} className={`meter ${shares.state === 'over' ? 'bad' : ''}`}>
            <div style={{ width: `${Math.min(100, Math.max(0, shares.total * 100))}%`, background: shares.state === 'over' ? undefined : shares.state === 'ok' ? 'var(--good)' : 'var(--accent)' }} />
          </div>
          <div className="row wrap" style={{ marginTop: 6, gap: 6 }}>
            {shares.state === 'ok' && <span className="pill good"><span className="dot" />{t('workload.share.ok')}</span>}
            {shares.state === 'unallocated' && <span className="pill warn"><span className="dot" />{t('workload.share.unallocated', { idle: fmtPct(shares.idle, 1), gpus: fmtInt(Math.floor(shares.idle * clusterGpus)) })}</span>}
            {shares.state === 'over' && <span className="pill bad"><span className="dot" />{t('workload.share.over', { total: fmtPct(shares.total, 1) })}</span>}
            <span className="grow" />
            <button className="btn sm" disabled={shares.state !== 'over'} onClick={normalize} title={t('workload.share.normalizeTitle')}>{t('workload.share.normalize')}</button>
            {wl && <button className="btn sm" onClick={fitRest} title={t('workload.share.fillTitle')}>{t('workload.share.fill')}</button>}
          </div>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <div className="grow"><SelectField label={t('workload.list.template')} value={tpl} options={WORKLOAD_TEMPLATES.map((x) => ({ value: x.key, label: t(x.labelKey) }))} onChange={setTpl} /></div>
          <button className="btn" onClick={() => { const w = WORKLOAD_TEMPLATES.find((x) => x.key === tpl)!.make(); update((d) => { d.workloads.push(w); }); setSelId(w.id); }}><Icon name="plus" size={13} />{t('workload.list.add')}</button>
        </div>
        {wl && (
          <div className="row wrap" style={{ marginTop: 6 }}>
            <button className="btn sm" onClick={() => downloadText(JSON.stringify(wl, null, 2), `${wl.id}.blueprint.json`, 'application/json')}><Icon name="download" size={13} />{t('workload.list.exportJson')}</button>
            <label className="btn sm" style={{ cursor: 'pointer' }}>
              <Icon name="upload" size={13} />{t('workload.list.import')}
              <input type="file" accept="application/json" style={{ display: 'none' }} onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                try {
                  const w = JSON.parse(await file.text()) as WorkloadBlueprint;
                  if (!w.kind || !w.model) throw new Error(t('workload.list.importError'));
                  w.id = `wl-${Math.random().toString(36).slice(2, 8)}`;
                  update((d) => { d.workloads.push(w); });
                  setSelId(w.id);
                } catch (err) { notify((err as Error).message, 'error'); }
              }} />
            </label>
            <span className="grow" />
            <button className="btn danger sm" onClick={() => { update((d) => { d.workloads = d.workloads.filter((x) => x.id !== wl.id); }); setSelId(''); }}><Icon name="trash" size={13} />{t('workload.list.delete')}</button>
          </div>
        )}
      </div>

      {/* ── C. grouped parameters ── */}
      {wl ? (
        <div className="card wl-form">
          <h3 className="row" style={{ gap: 8 }}>
            {t('workload.params.title')}
            {wl.calibration && <span className="badge src-public-spec" title={wl.calibration.source}>{t('workload.badge.calibrated')} · {wl.calibration.benchmarkId ?? t('workload.cal.userShort')}</span>}
          </h3>

          <Section title={t('workload.group.basic')}>
            <div className="fields-2">
              <TextField label={t('workload.f.name')} value={wl.name} onChange={(v) => setW((w) => { w.name = v; })} hint={<Affects tags={[]} text={t('workload.h.name')} t={t} />} />
              <SelectField label={t('workload.f.kind')} value={wl.kind} options={kindOptions} hint={<Affects tags={['compute', 'memory', 'bytes']} text={t('workload.h.kind')} t={t} />} onChange={(v) => setW((w) => {
                w.kind = v;
                if (v === 'llm-inference' && !w.inference) w.inference = {
                  requestsPerSec: 200, inputTokens: 2000, outputTokens: 500, ttftSloMs: 1000, tpotSloMs: 50, disaggregated: true, weightPrecision: 'fp8', kvPrecision: 'fp8',
                  parallelism: { tp: 2, pp: 1, ep: w.model.moe ? 2 : 1, cp: 1 },
                  prefillParallelism: { tp: 2, pp: 1, ep: w.model.moe ? 2 : 1, cp: 1 },
                  decodeParallelism: { tp: 2, pp: 1, ep: w.model.moe ? 2 : 1, cp: 1 },
                };
                if (v !== 'llm-inference' && !w.training) w.training = { tokensB: 1000, globalBatchTokensM: 8, precision: 'fp8', tp: 8, pp: 1, ep: 1, cp: 1, zeroStage: 1, microBatchSeqs: 1, checkpointEveryMin: 30, checkpointDurationS: 60, mtbfHoursPerGpu: 50000 };
              })} />
              <NumberField label={t('workload.f.share')} step={0.05} min={0.01} max={1} value={wl.gpuShare} onChange={(v) => setW((w) => { w.gpuShare = v; })} hint={<Affects tags={['compute', 'power']} text={t('workload.h.share', { gpus: fmtInt(Math.floor(effectiveShare(project.workloads, wl) * clusterGpus)) })} t={t} />} />
              <Field label={t('workload.f.shareWant')} hint={<Affects tags={[]} text={t('workload.h.shareWant')} t={t} />}>
                <div className="row" style={{ gap: 6 }}>
                  <div className="with-unit"><input type="number" style={{ width: 72 }} step={0.05} min={0} max={1} value={shareWant} onChange={(e) => setShareWant(Math.min(1, Math.max(0, Number(e.target.value) || 0)))} /></div>
                  <button className="btn sm" onClick={take}>{t('workload.share.take')}</button>
                </div>
              </Field>
              <NumberField label={t('workload.f.duration')} unit={t('workload.u.days')} value={wl.durationDays} onChange={(v) => setW((w) => { w.durationDays = v; })} hint={<Affects tags={['power']} text={t('workload.h.duration')} t={t} />} />
              <Field label={t('workload.f.preset')} hint={<Affects tags={['compute', 'memory', 'bytes']} text={t('workload.h.preset')} t={t} />}>
                <select value={wl.presetId ?? ''} onChange={(e) => applyPreset(e.target.value)}>
                  <option value="">{t('workload.preset.none')}</option>
                  <optgroup label={t('workload.preset.dense')}>
                    {MODEL_PRESETS.filter((p) => p.kind === 'dense').map((p) => <option key={p.id} value={p.id}>{p.name} · {p.paramsB}B</option>)}
                  </optgroup>
                  <optgroup label={t('workload.preset.moe')}>
                    {MODEL_PRESETS.filter((p) => p.kind === 'moe').map((p) => <option key={p.id} value={p.id}>{p.name} · {p.paramsB}B / A{p.activeParamsB}B</option>)}
                  </optgroup>
                </select>
              </Field>
            </div>
            {preset && (
              <div className="hint" style={{ fontSize: 11.5, marginTop: 2 }}>
                <span className="badge src-vendor-datasheet">{t('workload.src.officialConfig')}</span>{' '}
                <ExternalLink href={preset.sourceUrl}>{preset.org} · {preset.name}</ExternalLink>
                {preset.license ? ` · ${preset.license}` : ''}
                {preset.archSourceNote ? ` · ${t('workload.preset.mirror')}` : ''}
                {' · '}
                {modified.length
                  ? <><span className="badge src-estimate">{t('workload.preset.modified', { fields: modified.join(', ') })}</span> <button className="btn ghost sm" onClick={() => applyPreset(preset.id)}>{t('workload.preset.reapply')}</button></>
                  : <span className="badge src-public-spec">{t('workload.preset.unmodified')}</span>}
                {preset.contextLen < wl.model.seqLen && <div>{t('workload.preset.seqOverContext', { ctx: fmtInt(preset.contextLen) })}</div>}
              </div>
            )}
          </Section>

          <Section title={t('workload.group.model')}>
            <div className="fields-2">
              <NumberField label={t('workload.f.paramsB')} unit="B" value={wl.model.paramsB} onChange={(v) => setW((w) => { w.model.paramsB = v; })} hint={<Affects tags={['memory', 'bytes']} text={t('workload.h.paramsB')} t={t} />} />
              <NumberField label={t('workload.f.activeParamsB')} unit="B" value={wl.model.activeParamsB} onChange={(v) => setW((w) => { w.model.activeParamsB = v; })} hint={<Affects tags={['compute', 'calib']} text={t('workload.h.activeParamsB')} t={t} />} />
              <NumberField label={t('workload.f.layers')} value={wl.model.layers} onChange={(v) => setW((w) => { w.model.layers = v; })} hint={<Affects tags={['compute', 'bytes', 'memory']} text={t('workload.h.layers')} t={t} />} />
              <NumberField label={t('workload.f.hidden')} value={wl.model.hiddenSize} onChange={(v) => setW((w) => { w.model.hiddenSize = v; })} hint={<Affects tags={['compute', 'bytes']} text={t('workload.h.hidden')} t={t} />} />
              <NumberField label={t('workload.f.seqLen')} value={wl.model.seqLen} onChange={(v) => setW((w) => { w.model.seqLen = v; })} hint={<Affects tags={['compute', 'memory']} text={t('workload.h.seqLen')} t={t} />} />
            </div>
          </Section>

          {tr && wl.kind !== 'llm-inference' && (
            <>
              <Section title={<Term id="parallelism">{t('workload.group.parallel')}</Term>}>
                <div className="fields-2">
                  <NumberField label="TP" value={tr.tp} min={1} onChange={(v) => setW((w) => { w.training!.tp = Math.round(v); })} hint={<Affects tags={['bytes']} text={t('workload.h.tp')} t={t} />} />
                  <NumberField label="CP" value={tr.cp ?? 1} min={1} onChange={(v) => setW((w) => { w.training!.cp = Math.round(v); })} hint={<Affects tags={['bytes', 'memory']} text={t('workload.h.cp')} t={t} />} />
                  <NumberField label="PP" value={tr.pp} min={1} onChange={(v) => setW((w) => { w.training!.pp = Math.round(v); })} hint={<Affects tags={['bytes', 'compute']} text={t('workload.h.pp')} t={t} />} />
                  <NumberField label="EP" value={tr.ep} min={1} onChange={(v) => setW((w) => { w.training!.ep = Math.round(v); })} hint={<Affects tags={['bytes']} text={t('workload.h.ep')} t={t} />} />
                  <SelectField label={t('workload.f.zero')} value={String(tr.zeroStage ?? 1)} options={['0', '1', '2', '3'].map((v) => ({ value: v, label: t(`workload.zero.${v}`) }))} onChange={(v) => setW((w) => { w.training!.zeroStage = Number(v) as 0 | 1 | 2 | 3; })} hint={<Affects tags={['bytes', 'memory']} text={t('workload.h.zero')} t={t} />} />
                  <NumberField label={t('workload.f.microBatch')} unit="seq" value={tr.microBatchSeqs ?? 1} min={1} onChange={(v) => setW((w) => { w.training!.microBatchSeqs = Math.round(v); })} hint={<Affects tags={['compute', 'bytes']} text={t('workload.h.microBatch')} t={t} />} />
                </div>
              </Section>
              <Section title={t('workload.group.training')}>
                <div className="fields-2">
                  <NumberField label={t('workload.f.tokensB')} unit="B" value={tr.tokensB} onChange={(v) => setW((w) => { w.training!.tokensB = v; })} hint={<Affects tags={['compute']} text={t('workload.h.tokensB')} t={t} />} />
                  <NumberField label={t('workload.f.globalBatch')} unit="M tok" value={tr.globalBatchTokensM} onChange={(v) => setW((w) => { w.training!.globalBatchTokensM = v; })} hint={<Affects tags={['compute', 'bytes']} text={t('workload.h.globalBatch')} t={t} />} />
                  <SelectField label={t('workload.f.precision')} value={tr.precision} options={[{ value: 'fp4', label: 'FP4' }, { value: 'fp8', label: 'FP8' }, { value: 'bf16', label: 'BF16' }]} onChange={(v) => setW((w) => { w.training!.precision = v; })} hint={<Affects tags={['compute', 'memory', 'calib']} text={t('workload.h.precision')} t={t} />} />
                  <NumberField
                    label={<Term id="mfu">{t('workload.f.mfu')}</Term>} step={0.01} min={0} max={1} value={tr.mfuAssumed ?? 0}
                    onChange={(v) => setW((w) => { w.training!.mfuAssumed = v > 0 ? v : undefined; })}
                    hint={<Affects tags={['calib']} text={wl.calibration?.mode === 'training' ? t('workload.h.mfuCalibrated', { src: wl.calibration.benchmarkId ?? t('workload.cal.userShort') }) : t('workload.h.mfuDefault', { v: mfuDef.value, citation: mfuDef.citation })} t={t} />}
                  />
                  <NumberField label={<Term id="checkpoint">{t('workload.f.ckptEvery')}</Term>} unit={t('workload.u.min')} value={tr.checkpointEveryMin} onChange={(v) => setW((w) => { w.training!.checkpointEveryMin = v; })} hint={<Affects tags={['goodput', 'power']} text={t('workload.h.ckptEvery')} t={t} />} />
                  <NumberField label={t('workload.f.ckptDuration')} unit={t('workload.u.s')} value={tr.checkpointDurationS} onChange={(v) => setW((w) => { w.training!.checkpointDurationS = v; })} hint={<Affects tags={['goodput', 'power']} text={t('workload.h.ckptDuration')} t={t} />} />
                  <NumberField label={t('workload.f.mtbf')} unit="h" step={1000} value={tr.mtbfHoursPerGpu} onChange={(v) => setW((w) => { w.training!.mtbfHoursPerGpu = v; })} hint={<Affects tags={['goodput']} text={t('workload.h.mtbf')} t={t} />} />
                </div>
              </Section>
            </>
          )}
          {inf && wl.kind === 'llm-inference' && (
            <>
              <Section title={<Term id="parallelism">{t('workload.group.parallel')}</Term>}>
                <Field
                  label={<Term id="prefill-decode">{t('workload.f.servingMode')}</Term>}
                  hint={<Affects tags={['compute', 'memory', 'bytes']} text={t(inf.disaggregated ? 'workload.h.servingDisaggregated' : 'workload.h.servingAggregated')} t={t} />}
                >
                  <Seg
                    value={inf.disaggregated ? 'disaggregated' as const : 'aggregated' as const}
                    options={[
                      { value: 'aggregated' as const, label: t('workload.serving.aggregated') },
                      { value: 'disaggregated' as const, label: t('workload.serving.disaggregated') },
                    ]}
                    onChange={setInferenceServingMode}
                  />
                </Field>
                <p className="hint" style={{ margin: '0 0 8px' }}>{t('workload.group.parallelInf')}</p>
                <div className={inf.disaggregated ? 'grid-2' : undefined}>
                  {inf.disaggregated ? (
                    <>
                      <InferenceParallelFields
                        title={t('workload.parallel.prefill')}
                        value={inferenceParallelismFor(inf, 'prefill')}
                        onChange={(next) => setW((w) => { w.inference!.prefillParallelism = next; })}
                        memory={inferenceMemory?.prefill}
                        t={t}
                      />
                      <InferenceParallelFields
                        title={t('workload.parallel.decode')}
                        value={inferenceParallelismFor(inf, 'decode')}
                        onChange={(next) => setW((w) => { w.inference!.decodeParallelism = next; })}
                        memory={inferenceMemory?.decode}
                        t={t}
                      />
                    </>
                  ) : (
                    <InferenceParallelFields
                      title={t('workload.parallel.aggregated')}
                      value={inferenceParallelismFor(inf, 'aggregated')}
                      onChange={(next) => setW((w) => { w.inference!.parallelism = next; })}
                      memory={inferenceMemory?.aggregated}
                      t={t}
                    />
                  )}
                </div>
              </Section>
              <Section title={t('workload.group.inference')}>
                <div className="fields-2">
                  <NumberField label={t('workload.f.rps')} unit="req/s" value={inf.requestsPerSec} onChange={(v) => setW((w) => { w.inference!.requestsPerSec = v; })} hint={<Affects tags={['compute']} text={t('workload.h.rps')} t={t} />} />
                  <NumberField label={t('workload.f.inputTokens')} value={inf.inputTokens} onChange={(v) => setW((w) => { w.inference!.inputTokens = v; })} hint={<Affects tags={['compute', 'memory']} text={t('workload.h.inputTokens')} t={t} />} />
                  <NumberField label={t('workload.f.outputTokens')} value={inf.outputTokens} onChange={(v) => setW((w) => { w.inference!.outputTokens = v; })} hint={<Affects tags={['compute', 'calib']} text={t('workload.h.outputTokens')} t={t} />} />
                  <NumberField label={<Term id="ttft">TTFT SLO</Term>} unit="ms" value={inf.ttftSloMs} onChange={(v) => setW((w) => { w.inference!.ttftSloMs = v; })} hint={<Affects tags={['compute']} text={t('workload.h.ttft')} t={t} />} />
                  <NumberField label={<Term id="tpot">TPOT SLO</Term>} unit="ms" value={inf.tpotSloMs} onChange={(v) => setW((w) => { w.inference!.tpotSloMs = v; })} hint={<Affects tags={['compute', 'calib']} text={t('workload.h.tpot', { intv: fmt1(1000 / Math.max(1, inf.tpotSloMs)) })} t={t} />} />
                  <SelectField label={t('workload.f.weightPrecision')} value={inf.weightPrecision ?? 'fp8'} options={[{ value: 'fp16', label: 'FP16' }, { value: 'bf16', label: 'BF16' }, { value: 'fp8', label: 'FP8' }, { value: 'fp4', label: 'FP4' }]} onChange={(v) => setW((w) => { w.inference!.weightPrecision = v; })} hint={<Affects tags={['memory']} text={t('workload.h.weightPrecision')} t={t} />} />
                  <SelectField label={<Term id="kv-cache">{t('workload.f.kvPrecision')}</Term>} value={inf.kvPrecision ?? 'fp8'} options={[{ value: 'fp16', label: 'FP16' }, { value: 'bf16', label: 'BF16' }, { value: 'fp8', label: 'FP8' }, { value: 'fp4', label: 'FP4' }]} onChange={(v) => setW((w) => { w.inference!.kvPrecision = v; })} hint={<Affects tags={['memory', 'bytes']} text={t('workload.h.kvPrecision')} t={t} />} />
                </div>
              </Section>
            </>
          )}

          <details open={advOpen} onToggle={(e) => setAdvOpen((e.target as HTMLDetailsElement).open)} style={{ marginTop: 6 }}>
            <summary className="section-title" style={{ cursor: 'pointer', listStyle: 'revert' }}><span>{t('workload.group.advanced')}</span><span className="line" /></summary>
            <p className="hint" style={{ margin: '2px 0 6px' }}>{t('workload.group.advancedDesc')}</p>
            <div className="fields-2">
              <NumberField label={t('workload.f.numHeads')} value={wl.model.numHeads ?? Math.round(wl.model.hiddenSize / 128)} onChange={(v) => setW((w) => { w.model.numHeads = Math.round(v); })} hint={<Affects tags={['memory', 'bytes']} text={t('workload.h.numHeads')} t={t} />} />
              <NumberField label={<Term id="kv-cache">{t('workload.f.kvHeads')}</Term>} value={wl.model.kvHeads ?? wl.model.numHeads ?? Math.round(wl.model.hiddenSize / 128)} onChange={(v) => setW((w) => { w.model.kvHeads = Math.round(v); })} hint={<Affects tags={['memory', 'bytes']} text={t('workload.h.kvHeads')} t={t} />} />
              <NumberField label={t('workload.f.headDim')} value={wl.model.headDim ?? 0} min={0} onChange={(v) => setW((w) => { if (v > 0) w.model.headDim = Math.round(v); else delete w.model.headDim; })} hint={<Affects tags={['memory', 'bytes']} text={t('workload.h.headDim', { def: fmt1(wl.model.hiddenSize / Math.max(1, wl.model.numHeads ?? wl.model.hiddenSize / 128)) })} t={t} />} />
              <NumberField label={t('workload.f.vocab')} value={wl.model.vocab ?? 128256} onChange={(v) => setW((w) => { w.model.vocab = Math.round(v); })} hint={<Affects tags={['memory']} text={t('workload.h.vocab')} t={t} />} />
              <NumberField label={t('workload.f.attentionWindow')} value={wl.model.attentionWindow ?? 0} min={0} onChange={(v) => setW((w) => { if (v > 0) w.model.attentionWindow = Math.round(v); else delete w.model.attentionWindow; })} hint={<Affects tags={['memory']} text={t('workload.h.attentionWindow')} t={t} />} />
              <NumberField label={t('workload.f.globalLayerInterval')} value={wl.model.globalLayerInterval ?? 0} min={0} onChange={(v) => setW((w) => { if (v > 0) w.model.globalLayerInterval = Math.round(v); else delete w.model.globalLayerInterval; })} hint={<Affects tags={['memory']} text={t('workload.h.globalLayerInterval')} t={t} />} />
              <NumberField label={<Term id="moe">{t('workload.f.experts')}</Term>} value={wl.model.moe?.experts ?? 0} min={0} onChange={(v) => setW((w) => { if (v <= 0) delete w.model.moe; else w.model.moe = { ...w.model.moe, experts: Math.round(v), topK: w.model.moe?.topK ?? 8 }; })} hint={<Affects tags={['memory', 'bytes']} text={t('workload.h.experts')} t={t} />} />
              {wl.model.moe && (
                <>
                  <NumberField label={t('workload.f.topK')} value={wl.model.moe.topK} min={1} onChange={(v) => setW((w) => { if (w.model.moe) w.model.moe.topK = Math.round(v); })} hint={<Affects tags={['bytes']} text={t('workload.h.topK')} t={t} />} />
                  <NumberField label={t('workload.f.nodeLimit')} value={wl.model.moe.nodeLimit ?? 0} min={0} onChange={(v) => setW((w) => { if (!w.model.moe) return; if (v > 0) w.model.moe.nodeLimit = Math.round(v); else delete w.model.moe.nodeLimit; })} hint={<Affects tags={['bytes']} text={t('workload.h.nodeLimit')} t={t} />} />
                  <NumberField label={t('workload.f.shared')} value={wl.model.moe.shared ?? 0} min={0} onChange={(v) => setW((w) => { if (!w.model.moe) return; if (v > 0) w.model.moe.shared = Math.round(v); else delete w.model.moe.shared; })} hint={<Affects tags={['compute']} text={t('workload.h.shared')} t={t} />} />
                  <NumberField label={t('workload.f.denseLayers')} value={wl.model.moe.denseLayers ?? 0} min={0} onChange={(v) => setW((w) => { if (!w.model.moe) return; if (v > 0) w.model.moe.denseLayers = Math.round(v); else delete w.model.moe.denseLayers; })} hint={<Affects tags={['bytes']} text={t('workload.h.denseLayers')} t={t} />} />
                  <NumberField label={t('workload.f.moeLayerInterval')} value={wl.model.moe.moeLayerInterval ?? 0} min={0} onChange={(v) => setW((w) => { if (!w.model.moe) return; if (v > 0) w.model.moe.moeLayerInterval = Math.round(v); else delete w.model.moe.moeLayerInterval; })} hint={<Affects tags={['bytes']} text={t('workload.h.moeLayerInterval')} t={t} />} />
                </>
              )}
              <NumberField label={t('workload.f.mlaLatent')} value={wl.model.mla?.dLatent ?? 0} min={0} onChange={(v) => setW((w) => { if (v <= 0) delete w.model.mla; else w.model.mla = { dLatent: Math.round(v), dRope: w.model.mla?.dRope ?? 64 }; })} hint={<Affects tags={['memory', 'bytes']} text={t('workload.h.mlaLatent')} t={t} />} />
              {wl.model.mla && <NumberField label={t('workload.f.mlaRope')} value={wl.model.mla.dRope} min={0} onChange={(v) => setW((w) => { if (w.model.mla) w.model.mla.dRope = Math.round(v); })} hint={<Affects tags={['memory']} text={t('workload.h.mlaRope')} t={t} />} />}
              {tr && wl.kind !== 'llm-inference' && (
                <Field label={t('workload.f.recompute')} hint={<Affects tags={['compute']} text={t('workload.h.recompute')} t={t} />}>
                  <Toggle label={tr.activationRecompute ? t('workload.f.recomputeOn') : t('workload.f.recomputeOff')} checked={!!tr.activationRecompute} onChange={(v) => setW((w) => { w.training!.activationRecompute = v; })} />
                </Field>
              )}
            </div>
          </details>
        </div>
      ) : (
        <Empty>{t('workload.empty')}</Empty>
      )}

      {/* ── D. benchmark calibration ── */}
      {wl && gpuRack && (wl.kind !== 'hpc-simulation') && (
        <CalibrationCard key={wl.id} wl={wl} wa={wa} gpuRack={gpuRack} setW={setW} t={t} locale={locale} notify={notify} />
      )}

      {/* ── E. optional reverse-sizing what-if ── */}
      {wl && (
        <div className="card wl-form" style={{ gridColumn: '1 / -1' }}>
          <h3>{t('workload.size.title')}</h3>
          <div className="fields-2">
            <div>
              <SelectField label={t('workload.size.target')} value={targetKind} options={[{ value: 'train-days', label: t('workload.size.trainDays') }, { value: 'tokens-per-s', label: t('workload.size.tps') }]} onChange={setTargetKind} />
              {targetKind === 'train-days' ? (
                <NumberField label={t('workload.size.days')} unit={t('workload.u.days')} min={1} value={targetDays} onChange={setTargetDays} />
              ) : (
                <NumberField label={t('workload.size.tpsTarget')} unit="tok/s" step={100000} min={1} value={targetTps} onChange={setTargetTps} />
              )}
              <NumberField label={<Term id="mfu">{t('workload.size.mfu')}</Term>} step={0.01} min={0} max={1} value={mfuOverride} onChange={setMfuOverride} hint={t('workload.size.mfuHint', { mfu, src: wl.calibration?.mode === 'training' ? t('workload.size.mfuCalibration') : wl.training?.mfuAssumed ? t('workload.size.mfuBlueprint') : mfuDef.citation })} />
              <div className="field"><label>{t('workload.size.gpuRack')}</label><div className="row"><span>{gpuRack?.name ?? gpuRackId}</span>{gpuRack && <SourceBadge source={gpuRack.source} />}</div></div>
            </div>
            <div>
              {sizing ? (
                <>
                  <div className="grid-2">
                    <Stat label={t('workload.size.gpus')} value={fmtInt(sizing.gpus)} delta={t('workload.size.gpusDelta', { racks: fmtInt(sizing.racks), gpus: gpuRack?.compute?.gpus ?? 0 })} />
                    <Stat label={t('workload.size.pods')} value={fmtInt(sizing.pods)} delta={t('workload.size.podsDelta', { n: RACKS_PER_POD })} />
                    <Stat label={t('workload.size.it')} value={`${fmt2(sizing.itMW)} MW`} delta={t('workload.size.itDelta', { pct: fmtPct(NETWORK_SHARE) })} />
                    <Stat label={t('workload.size.area')} value={`${fmtInt(sizing.areaM2)} m²`} delta={t('workload.size.areaDelta')} />
                  </div>
                  <p className="caption">{sizing.note}. {t('workload.size.peak', { peak: fmt1(sizing.peak / 1e15), prec: precision })} <span className="badge src-estimate">{t('workload.size.estimate')}</span></p>
                  <div className="row" style={{ marginTop: 6 }}>
                    <button className="btn" onClick={storeSuggestion}><Icon name="architecture" size={13} />{t('workload.size.store')}</button>
                    {sizingSuggestion && <span className="pill good"><span className="dot" />{t('workload.size.saved', { name: sizingSuggestion.workloadName, gpus: fmtInt(sizingSuggestion.gpus), pods: sizingSuggestion.pods })}</span>}
                    {sizingSuggestion && <button className="btn ghost sm" onClick={() => setSizingSuggestion(null)}>{t('workload.size.clear')}</button>}
                  </div>
                </>
              ) : (
                <Empty>{wl.kind === 'llm-inference' ? t('workload.size.emptyInf') : t('workload.size.emptyTrain')}</Empty>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── F. simulation result ── */}
      {wa && wl && (
        <div className="card" style={{ gridColumn: '1 / -1' }}>
          <h3>{t('workload.res.title', { name: wl.name })}</h3>
          <div className="grid-4">
            <Stat label={t('workload.res.gpus')} value={fmtInt(wa.gpus)} />
            {wa.timeToTrainDays != null && <Stat label={t('workload.res.ttt')} value={days(wa.timeToTrainDays)} delta={<span><Term id="goodput">goodput</Term> {fmtPct(wa.goodput)}</span>} />}
            {wa.tokensPerSec != null && <Stat label={<Term id="tokens-per-sec">{t('workload.res.tput')}</Term>} value={`${fmtInt(wa.tokensPerSec)} tok/s`} delta={<span><Term id="mfu">MFU</Term> {fmtPct(wa.mfu)}{wl.calibration?.mode === 'training' ? ` · ${t('workload.badge.calibrated')}` : ''}</span>} />}
            {wa.stepTimeS != null && <Stat label={t('workload.res.step')} value={`${fmt2(wa.stepTimeS)} s`} delta={`${t('workload.res.stepDelta', { pct: fmtPct((wa.commTimeS ?? 0) / Math.max(1e-9, wa.stepTimeS)) })}${analysis?.network.traffic ? t('workload.res.effComm', { pct: fmtPct(analysis.network.traffic.commEfficiencyEffective) }) : ''}`} />}
            {wa.gpusRequired != null && <Stat label={t('workload.res.sloGpus')} value={fmtInt(wa.gpusRequired)} delta={`${t('workload.res.maxRps', { rps: fmt1(wa.maxRequestsPerSec) })}${wl.calibration?.mode === 'inference' ? ` · ${t('workload.badge.calibrated')}` : ''}`} />}
            {wa.ttftMs != null && <Stat label={t('workload.res.ttftTpot')} value={`${fmtInt(wa.ttftMs)} / ${fmtInt(wa.tpotMs)} ms`} />}
            {inf && wa.details && (inf.disaggregated ? (
              <>
                <Stat label={t('workload.res.prefillTopology')} value={`TP${wa.details.prefillTp}/PP${wa.details.prefillPp}/EP${wa.details.prefillEp}/CP${wa.details.prefillCp}`} delta={t('workload.res.instances', { n: wa.details.prefillReplicas ?? 0, g: wa.details.prefillInstanceGpus ?? 0 })} />
                <Stat label={t('workload.res.decodeTopology')} value={`TP${wa.details.decodeTp}/PP${wa.details.decodePp}/EP${wa.details.decodeEp}/CP${wa.details.decodeCp}`} delta={t('workload.res.instances', { n: wa.details.decodeReplicas ?? 0, g: wa.details.decodeInstanceGpus ?? 0 })} />
              </>
            ) : (
              <Stat label={t('workload.res.aggregatedTopology')} value={`TP${wa.details.decodeTp}/PP${wa.details.decodePp}/EP${wa.details.decodeEp}/CP${wa.details.decodeCp}`} delta={t('workload.res.instances', { n: wa.details.decodeReplicas ?? 0, g: wa.details.decodeInstanceGpus ?? 0 })} />
            ))}
            <Stat label={t('workload.res.power')} value={fmtPower(wa.avgPowerKW)} delta={t('workload.res.peak', { p: fmtPower(wa.peakPowerKW) })} />
            <Stat label={t('workload.res.energy')} value={`${fmtInt(wa.energyMWh)} MWh`} delta={`${fmtMoney(wa.energyCostUSD, project.pricing)}${wa.tokensPerKWh ? ` · ${fmtInt(wa.tokensPerKWh)} tok/kWh` : ''}`} />
          </div>
          {wa.stepTimeS != null && wa.computeTimeS != null && (
            <div style={{ marginTop: 12 }}>
              <BarChart
                title={t('workload.res.breakdown')}
                data={[{ label: t('workload.res.oneStep'), values: { compute: wa.computeTimeS, comm: wa.commTimeS ?? 0, other: Math.max(0, wa.stepTimeS - wa.computeTimeS - (wa.commTimeS ?? 0)) } }]}
                series={[{ key: 'compute', name: t('workload.res.compute') }, { key: 'comm', name: t('workload.res.comm') }, { key: 'other', name: t('workload.res.other') }]}
                format={(v) => `${v.toFixed(2)} s`} labelWidth={60} rowHeight={40}
              />
            </div>
          )}
          {wa.powerTrace.length > 1 && (
            <div style={{ marginTop: 12 }}>
              <LineChart
                title={t('workload.res.profile')}
                series={[{ key: 'p', name: t('workload.res.itPower'), points: wa.powerTrace.map((p) => ({ x: p.t, y: p.powerKW })) }]}
                height={220} area xFormat={(v) => `${Math.round(v)}s`} yFormat={(v) => fmtPower(v)} yMin={0}
                refLines={analysis?.power ? [{ y: analysis.power.itDesignKW, label: t('workload.res.itDesign', { p: fmtPower(analysis.power.itDesignKW) }) }] : undefined}
              />
            </div>
          )}
          {notesOf(wa).length > 0 && (
            <ul className="hint" style={{ marginTop: 10 }}>
              {notesOf(wa).map((n, i) => <li key={i}>{n}</li>)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ───────────── benchmark calibration card ─────────────

type CalMode = 'row' | 'user';

function CalibrationCard({ wl, wa, gpuRack, setW, t, locale, notify }: {
  wl: WorkloadBlueprint; wa: WorkloadAnalysis | undefined; gpuRack: CatalogItem; setW: (fn: (w: WorkloadBlueprint) => void) => void;
  t: Translate; locale: 'en' | 'ko'; notify: (text: string, kind?: 'info' | 'error' | 'ok') => void;
}) {
  const training = isTrainingKind(wl.kind);
  const rows = useMemo(() => BENCHMARKS.filter((b) => (training ? !/inference/i.test(b.suite) : /inference/i.test(b.suite))), [training]);
  const preferred = rows.find((b) => b.model === wl.presetId) ?? rows[0];
  const [mode, setMode] = useState<CalMode>('row');
  const [rowId, setRowId] = useState(wl.calibration?.benchmarkId ?? preferred?.id ?? '');
  const [userTps, setUserTps] = useState(0);
  const [userGpus, setUserGpus] = useState(0);
  const [userAcc, setUserAcc] = useState(gpuRack.id);
  const [userPrec, setUserPrec] = useState<CalibrationPrecision>(wl.training?.precision ?? 'fp8');
  const [userIntv, setUserIntv] = useState(0);
  const [userLabel, setUserLabel] = useState('');
  const [override, setOverride] = useState(false);
  const row = rows.find((b) => b.id === rowId);

  const accOptions = useMemo(() => {
    const racks = catalogItems().filter((i) => i.category === 'gpu-rack' && (i.compute?.gpus ?? 0) > 0).map((i) => ({ value: i.id, label: i.name }));
    const nodes = NODE_SPECS.filter((n) => n.gpu).map((n) => ({ value: n.id, label: n.name }));
    return [...racks, ...nodes];
  }, []);

  const input: BenchmarkRow | UserMeasurement | undefined = mode === 'row'
    ? row
    : userTps > 0 && userGpus > 0
      ? { tokensPerSec: userTps, gpus: userGpus, acceleratorCatalogId: userAcc, precision: training ? userPrec : undefined, interactivityTokPerSecPerUser: !training && userIntv > 0 ? userIntv : undefined, label: userLabel || undefined }
      : undefined;
  const result = useMemo(() => (input ? calibrateFromBenchmark(wl, input, gpuRack) : undefined), [input, wl, gpuRack]);
  const scaleW = result && training ? scaleWarning(result.sourceGpus, wa?.gpus ?? 0) : undefined;
  const warnings: CalibrationWarning[] = result ? [...result.warnings, ...(scaleW ? [scaleW] : [])] : [];
  const hardBlock = warnings.some((w) => w.severity === 'block' && w.code !== 'kind-mismatch');
  const kindBlock = warnings.some((w) => w.severity === 'block' && w.code === 'kind-mismatch');
  const value = training ? result?.mfu : result?.tokensPerSecPerGpu;
  const canApply = !!result && value !== undefined && !hardBlock && (!kindBlock || override);
  const srcName = acceleratorPeakSource(result?.sourceAcceleratorCatalogId)?.name ?? gpuRack.name;

  const apply = () => {
    if (!result || !input || !canApply) return;
    setW((w) => {
      const rec = calibrationRecord(result, input, scaleW ? [scaleW] : [], locale);
      rec.appliedAt = new Date().toISOString();
      if (kindBlock && override) rec.warnings = [...(rec.warnings ?? []), t('workload.cal.overrideNote')];
      w.calibration = rec;
      if (training && w.training && result.mfu !== undefined) w.training.mfuAssumed = Math.min(1, result.mfu);
    });
    notify(t('workload.cal.appliedToast', { name: wl.name }), 'ok');
  };
  const clear = () => {
    setW((w) => { delete w.calibration; if (w.training) delete w.training.mfuAssumed; });
    notify(t('workload.cal.clearedToast', { name: wl.name }), 'info');
  };

  return (
    <div className="card wl-form" style={{ gridColumn: '1 / -1' }}>
      <h3 className="row" style={{ gap: 8 }}>
        {t('workload.cal.title')}
        {wl.calibration ? <span className="badge src-public-spec">{t('workload.badge.calibrated')}</span> : <span className="badge src-estimate">{t('workload.badge.uncalibrated')}</span>}
      </h3>
      <p className="hint" style={{ marginTop: 0 }}>{training ? t('workload.cal.introTraining') : t('workload.cal.introInference')}</p>

      {wl.calibration && (
        <div className="card" style={{ background: 'var(--surface-2)', marginBottom: 10 }}>
          <div className="row wrap" style={{ gap: 8 }}>
            <StatusIcon severity="good" />
            <strong>{t('workload.cal.current')}</strong>
            {wl.calibration.mode === 'training' && wl.calibration.tflopsPerGpu != null && <span>{t('workload.cal.currentTraining', { tflops: fmtInt(wl.calibration.tflopsPerGpu / 1e12), mfu: fmtPct(wl.training?.mfuAssumed, 1) })}</span>}
            {wl.calibration.mode === 'inference' && wl.calibration.tokensPerSecPerGpu != null && <span>{t('workload.cal.currentInference', { tok: fmtInt(wl.calibration.tokensPerSecPerGpu), intv: wl.calibration.interactivityTokPerSecPerUser ?? '–' })}</span>}
            <span className="grow" />
            <button className="btn sm" onClick={clear}>{t('workload.cal.clear')}</button>
          </div>
          <div className="hint" style={{ fontSize: 11.5, marginTop: 4 }}>{t('workload.cal.sourceLabel')}: {wl.calibration.source}</div>
          {wl.calibration.conditions && <div className="hint" style={{ fontSize: 11.5 }}>{wl.calibration.conditions}</div>}
          {wl.calibration.transfer && <div className="hint" style={{ fontSize: 11.5 }}>{t('workload.cal.transferLabel')}: {wl.calibration.transfer}</div>}
          {wl.calibration.warnings?.map((w, i) => <div key={i} className="hint" style={{ fontSize: 11.5 }}><StatusIcon severity="warning" /> {w}</div>)}
        </div>
      )}

      <div className="row" style={{ marginBottom: 8 }}>
        <Seg value={mode} options={[{ value: 'row', label: t('workload.cal.modeRow') }, { value: 'user', label: t('workload.cal.modeUser') }]} onChange={setMode} />
      </div>
      <div className="fields-2">
        <div>
          {mode === 'row' ? (
            <DataTable
              maxHeight={300}
              columns={[
                { key: 's', header: t('workload.cal.col.suite'), render: (b: BenchmarkRow) => <span title={b.task}>{b.suite.replace(' (datacenter, closed)', '').replace('SemiAnalysis InferenceX (formerly InferenceMAX)', 'InferenceX')} {b.round}</span> },
                { key: 'm', header: t('workload.cal.col.model'), render: (b) => <span style={{ fontWeight: b.model === wl.presetId ? 600 : undefined }}>{b.model}</span> },
                { key: 'y', header: t('workload.cal.col.system'), render: (b) => <span title={b.system}>{b.accelerator}</span> },
                { key: 'g', header: 'G', num: true, render: (b) => (b.accelerators ? fmtInt(b.accelerators) : '–') },
                { key: 'v', header: t('workload.cal.col.value'), num: true, render: (b) => `${fmt2(b.value)} ${b.unit}` },
                { key: 'p', header: t('workload.cal.col.perGpu'), num: true, render: (b) => (b.derived?.tflopsPerGpu ? `${fmtInt(b.derived.tflopsPerGpu)} TF/s` : b.derived?.tokensPerSecPerGpu ? `${fmtInt(b.derived.outputTokensPerSecPerGpu ?? b.derived.tokensPerSecPerGpu)} tok/s` : '–') },
                { key: 't', header: t('workload.cal.col.source'), render: (b) => <span className={`badge ${b.sourceType === 'vendor-claim' ? 'src-estimate' : 'src-public-spec'}`}>{t(`workload.src.${b.sourceType}`)}</span> },
              ]}
              rows={rows}
              rowKey={(b) => b.id}
              selectedKeys={row ? [row.id] : []}
              onRowClick={(b) => { setRowId(b.id); setOverride(false); }}
            />
          ) : (
            <div className="fields-2">
              <NumberField label={training ? t('workload.cal.userTps') : t('workload.cal.userOutTps')} unit="tok/s" step={1000} min={0} value={userTps} onChange={setUserTps} />
              <NumberField label={t('workload.cal.userGpus')} min={0} value={userGpus} onChange={(v) => setUserGpus(Math.round(v))} />
              <SelectField label={t('workload.cal.userAcc')} value={userAcc} options={accOptions} onChange={setUserAcc} />
              {training
                ? <SelectField label={t('workload.f.precision')} value={userPrec} options={[{ value: 'fp4', label: 'FP4' }, { value: 'fp8', label: 'FP8' }, { value: 'bf16', label: 'BF16' }]} onChange={setUserPrec} />
                : <NumberField label={t('workload.cal.userIntv')} unit="tok/s/user" min={0} value={userIntv} onChange={setUserIntv} />}
              <TextField label={t('workload.cal.userLabel')} value={userLabel} onChange={setUserLabel} />
            </div>
          )}
          {mode === 'row' && row && (
            <p className="caption">
              {row.task} · {row.system}{row.parallelism ? ` · ${row.parallelism}` : ''}{row.precision ? ` · ${row.precision}` : ''} · <ExternalLink href={row.sourceUrl}>{t('workload.cal.sourceLink')}</ExternalLink>{row.resultId ? ` · ${row.resultId}` : ''}{/MLPerf/.test(row.suite) ? <><br />{t('workload.mlperf.notice')}</> : null}
            </p>
          )}
        </div>
        <div>
          {result ? (
            <>
              <div className="grid-2">
                {training ? (
                  <>
                    <Stat label={t('workload.cal.tflops')} value={result.tflopsPerGpu != null ? `${fmtInt(result.tflopsPerGpu / 1e12)} TFLOP/s` : '–'} delta={result.sourceTokensPerSecPerGpu != null ? t('workload.cal.srcTokens', { tok: fmt1(result.sourceTokensPerSecPerGpu) }) : undefined} />
                    <Stat label={<Term id="mfu">{t('workload.cal.mfu')}</Term>} value={fmtPct(result.mfu, 1)} delta={result.sourcePeakFlops ? t('workload.cal.basis', { prec: (result.sourcePrecision ?? '').toUpperCase(), peak: fmtInt(result.sourcePeakFlops / 1e12), acc: srcName }) : undefined} />
                    <Stat label={t('workload.cal.targetTflops')} value={result.targetTflopsPerGpu != null ? `${fmtInt(result.targetTflopsPerGpu / 1e12)} TFLOP/s` : '–'} delta={t('workload.cal.targetDelta', { rack: gpuRack.name, prec: (wl.training?.precision ?? '').toUpperCase(), factor: fmt2(result.transferFactor) })} />
                    <Stat label={t('workload.cal.sourceType')} value={t(`workload.src.${result.sourceType ?? 'user'}`)} delta={t('workload.cal.derivedNote')} />
                  </>
                ) : (
                  <>
                    <Stat label={<Term id="tokens-per-sec">{t('workload.cal.tokPerGpu')}</Term>} value={result.tokensPerSecPerGpu != null ? `${fmtInt(result.tokensPerSecPerGpu)} tok/s` : '–'} delta={t('workload.cal.targetRack', { rack: gpuRack.name })} />
                    <Stat label={t('workload.cal.interactivity')} value={result.interactivityTokPerSecPerUser ? `≤ ${fmt1(result.interactivityTokPerSecPerUser)}` : '–'} delta={t('workload.cal.interactivityDelta', { intv: fmt1(1000 / Math.max(1, wl.inference?.tpotSloMs ?? 1)) })} />
                    <Stat label={t('workload.cal.sourceType')} value={t(`workload.src.${result.sourceType ?? 'user'}`)} delta={t('workload.cal.derivedNote')} />
                  </>
                )}
              </div>
              {(locale === 'ko' ? result.transferKo : result.transferEn) && <p className="caption"><strong>{t('workload.cal.transferLabel')}:</strong> {locale === 'ko' ? result.transferKo : result.transferEn}</p>}
              {result.conditions && <p className="caption">{result.conditions}</p>}
              {warnings.length > 0 && (
                <ul className="hint" style={{ margin: '6px 0 0', paddingLeft: 0, listStyle: 'none' }}>
                  {warnings.map((w, i) => (
                    <li key={i} style={{ fontSize: 11.5, marginBottom: 3 }}><StatusIcon severity={w.severity === 'block' ? 'error' : w.severity === 'warn' ? 'warning' : 'info'} /> {locale === 'ko' ? w.ko : w.en}</li>
                  ))}
                </ul>
              )}
              <div className="row wrap" style={{ marginTop: 8, gap: 8 }}>
                {kindBlock && !hardBlock && <Toggle label={t('workload.cal.override')} checked={override} onChange={setOverride} />}
                <span className="grow" />
                <button className="btn primary" disabled={!canApply} onClick={apply}><Icon name="check" size={13} />{t('workload.cal.apply')}</button>
              </div>
            </>
          ) : (
            <Empty>{mode === 'row' ? t('workload.cal.pickRow') : t('workload.cal.enterMeasurement')}</Empty>
          )}
        </div>
      </div>
    </div>
  );
}
