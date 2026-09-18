import { useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_TEMPLATE_ID,
  LAYOUT_TEMPLATES,
  catalogItems,
  comparePlatformsForDisplay,
  findCatalogItem,
  platformSummary,
  platformEligibility,
  podSizing,
  registerPlatformInProject,
  registeredPlatformIds,
  resolveLayoutTemplate,
  type CatalogItem,
  type LayoutTemplate,
  type Project,
} from '@aidc/core';
import { fmtInt, fmtPower } from '../app/format.ts';
import { useT } from '../i18n/index.ts';
import { useApp } from '../store/appStore.ts';
import { NumberField, Section, SelectField, SourceBadge, Stat } from '../ui/controls.tsx';
import { Icon } from '../ui/icons.tsx';

type ScaleOutTopology = Project['network']['scaleOut']['topology'];

/**
 * Architecture is intentionally separate from Catalog and Layout:
 * - Catalog owns reusable asset/spec records.
 * - This page binds one asset to a compatible physical-interface template and repeat-unit count.
 * - Layout consumes that coherent setup and decides the hall geometry.
 */
const SETUP_TEMPLATES = LAYOUT_TEMPLATES;
const STANDARD_TEMPLATES = SETUP_TEMPLATES.filter((x) => x.group === 'standard');

function currentSetup(project: Project, hallId: string) {
  const hall = project.halls.find((x) => x.id === hallId) ?? project.halls[0];
  const resolved = resolveLayoutTemplate(hall?.layoutPolicy?.templateId ?? DEFAULT_TEMPLATE_ID, { project });
  const templateId = resolved?.id ?? DEFAULT_TEMPLATE_ID;
  const primary = project.equipment.find((e) => e.hallId === hall?.id && findCatalogItem(e.catalogId)?.category === 'gpu-rack' && typeof e.meta?.computeSlot !== 'string');
  const platformId = primary?.catalogId ?? resolved?.pod.gpuRackCatalogId ?? 'nvidia-gb300-nvl72';
  const pods = new Set(project.equipment.filter((e) => e.hallId === hall?.id && /^pod-\d+$/i.test(e.podId ?? '')).map((e) => e.podId)).size || 1;
  return { templateId, platformId, pods };
}

function templateCompatible(template: LayoutTemplate, platformId: string): boolean {
  if (template.id === 'custom') return true;
  if (template.referenceUnit && !template.referenceUnit.platformIds.includes(platformId)) return false;
  return platformEligibility(template.id, 'primary', platformId)?.eligible === true;
}

function preferredTemplate(platformId: string, currentId?: string): string {
  const compatible = SETUP_TEMPLATES.filter((x) => templateCompatible(x, platformId));
  if (currentId && compatible.some((x) => x.id === currentId)) return currentId;
  const registeredStandard = compatible.find((x) => x.group === 'standard' && registeredPlatformIds(x.id, 'primary').includes(platformId));
  return registeredStandard?.id ?? compatible.find((x) => x.group === 'standard')?.id ?? compatible[0]?.id ?? 'custom';
}

export function ArchitecturePanel() {
  const t = useT();
  const locale = useApp((s) => s.uiLocale);
  const project = useApp((s) => s.project);
  const hallId = useApp((s) => s.hallId);
  const update = useApp((s) => s.update);
  const setPage = useApp((s) => s.setPage);
  const notify = useApp((s) => s.notify);
  const setPending = useApp((s) => s.setPendingGeneratorSetup);
  const pendingRackId = useApp((s) => s.pendingArchitectureRackId);
  const setPendingRackId = useApp((s) => s.setPendingArchitectureRackId);
  const sizingSuggestion = useApp((s) => s.sizingSuggestion);
  const libraryVersion = useApp((s) => s.libraryVersion);
  const uiLocale = useApp((s) => s.uiLocale);
  void libraryVersion;

  const initial = currentSetup(project, hallId);
  const [platformId, setPlatformIdState] = useState(initial.platformId);
  const [templateId, setTemplateId] = useState(initial.templateId);
  const [pods, setPods] = useState(initial.pods);
  const [topology, setTopology] = useState<ScaleOutTopology>(project.network.scaleOut.topology);

  useEffect(() => {
    const next = currentSetup(project, hallId);
    setPlatformIdState(next.platformId);
    setTemplateId(next.templateId);
    setPods(next.pods);
    setTopology(project.network.scaleOut.topology);
    // Switching halls should reload that hall's architecture; ordinary edits must not erase this draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, hallId]);

  useEffect(() => {
    if (!sizingSuggestion) return;
    setPlatformIdState(sizingSuggestion.gpuRackCatalogId);
    setTemplateId((cur) => preferredTemplate(sizingSuggestion.gpuRackCatalogId, cur));
    setPods(Math.max(1, sizingSuggestion.pods));
  }, [sizingSuggestion?.createdAt]);

  useEffect(() => {
    if (!pendingRackId) return;
    const item = findCatalogItem(pendingRackId);
    if (item?.category === 'gpu-rack') {
      setPlatformIdState(item.id);
      setTemplateId((cur) => preferredTemplate(item.id, cur));
      notify(t('architecture.toast.platformPrefilled', { platform: item.name }), 'info');
    } else {
      notify(t('architecture.toast.platformUnknown'), 'error');
    }
    setPendingRackId(null);
  }, [pendingRackId, notify, setPendingRackId, t]);

  const platforms = useMemo(
    () => catalogItems()
      .filter((x) => x.category === 'gpu-rack' && x.meta?.placeable !== false)
      .sort(comparePlatformsForDisplay),
    [libraryVersion],
  );
  const platform = findCatalogItem(platformId);
  const psum = platform ? platformSummary(platform, locale) : null;
  const compatible = SETUP_TEMPLATES.filter((x) => templateCompatible(x, platformId));
  const template = resolveLayoutTemplate(templateId, { project });
  const eligibility = template ? platformEligibility(template.id, 'primary', platformId) : undefined;
  const registered = !!template && registeredPlatformIds(template.id, 'primary', { project }).includes(platformId);
  const valid = template?.id === 'custom' || eligibility?.eligible === true;
  const sizing = useMemo(() => {
    if (!template || !platform) return null;
    try {
      return podSizing({ ...template.pod, gpuRackCatalogId: platform.id });
    } catch {
      return null;
    }
  }, [template, platform]);
  const scaleUp = platform?.compute?.scaleUp;
  const referenceUnit = template?.referenceUnit && platform && template.referenceUnit.platformIds.includes(platform.id)
    ? template.referenceUnit
    : null;
  const referenceUnits = referenceUnit && sizing ? (sizing.racks * pods) / referenceUnit.computeRacksPerUnit : null;
  const scaleUpName = scaleUp
    ? (scaleUp.family ?? ({ nvlink: 'NVLink', ualink: 'UALink', 'esun-ethernet': 'ESUN Ethernet', pcie: 'PCIe', 'vendor-proprietary': t('architecture.scaleUp.proprietary'), none: t('architecture.scaleUp.none') }[scaleUp.kind]))
    : t('architecture.scaleUp.none');

  const choosePlatform = (id: string) => {
    setPlatformIdState(id);
    setTemplateId(preferredTemplate(id, templateId));
  };
  const handoff = (page: 'site' | 'layout') => {
    if (!template || !platform || !valid) return;
    if (!update((d) => {
      d.network.scaleOut.topology = topology;
      if (!registeredPlatformIds(template.id, 'primary', { project: d }).includes(platform.id)) registerPlatformInProject(d, template.id, 'primary', platform.id);
    })) return;
    setPending({ templateId: template.id, platformId: platform.id, pods: Math.max(1, Math.round(pods)) });
    notify(t('architecture.toast.queued', { platform: platform.name, template: template.name }), 'ok');
    setPage(page);
  };

  return (
    <div>
      <Section title={t('architecture.setup.title')}>
        <div className="card">
          <div className="fields-2">
            <div>
              <SelectField
                label={t('architecture.field.platform')}
                value={platformId}
                options={platforms.map((x) => ({ value: x.id, label: x.name }))}
                onChange={choosePlatform}
                hint={t('architecture.field.platformHint')}
              />
              {platform && (
                <div className="small" style={{ padding: '7px 9px', background: 'var(--surface-2)', borderRadius: 6, marginBottom: 8 }}>
                  <div className="row wrap"><strong>{platform.vendor} · {platform.model}</strong><SourceBadge source={platform.source} /></div>
                  {psum && <div>{psum.plain}</div>}
                  {psum && (
                    <div className="muted">
                      {t('architecture.summary.class', { class: psum.className })}
                      {psum.classId ? ` · ${t('architecture.summary.implements', { classId: psum.classId })}` : ''}
                    </div>
                  )}
                  {psum && psum.specs.length > 0 && <div className="muted">{t('architecture.summary.specs', { specs: psum.specs.join(', ') })}</div>}
                  <div className="muted">{platform.dims.w} × {platform.dims.d} × {platform.dims.h} m · {fmtInt(platform.weightKg)} kg · {platform.formFactor?.rack ?? t('architecture.value.undeclared')}</div>
                </div>
              )}
              <SelectField
                label={t('architecture.field.template')}
                value={templateId}
                options={(compatible.length ? compatible : [LAYOUT_TEMPLATES.find((x) => x.id === 'custom')!]).map((x) => ({
                  value: x.id,
                  label: `${t(x.group === 'standard' ? 'architecture.template.standard' : x.group === 'vendor-sample' ? 'architecture.template.reference' : 'architecture.template.custom')} · ${x.name}`,
                }))}
                onChange={setTemplateId}
                hint={t('architecture.field.templateHint', { n: compatible.length })}
              />
            </div>
            <div>
              <NumberField label={t('architecture.field.units')} min={1} max={400} step={1} value={pods} onChange={(v) => setPods(Math.max(1, Math.round(v)))} hint={t('architecture.field.unitsHint')} />
              <SelectField
                label={t('architecture.field.topology')}
                value={topology}
                options={(['rail-optimized', 'fat-tree', 'leaf-spine'] as ScaleOutTopology[]).map((x) => ({ value: x, label: t(`architecture.topology.${x}`) }))}
                onChange={setTopology}
                hint={t('architecture.field.topologyHint')}
              />
              {template && (
                <div className="small" style={{ padding: '7px 9px', borderLeft: `3px solid ${valid ? 'var(--good)' : 'var(--critical)'}`, background: 'var(--surface-2)' }} data-architecture-compat={valid ? 'ok' : 'blocked'}>
                  <div className="row wrap"><strong>{valid ? t('architecture.compat.ok') : t('architecture.compat.blocked')}</strong><SourceBadge source={template.source} />{registered && <span className="badge">{t('architecture.compat.registered')}</span>}</div>
                  <div className="muted">{template.description}</div>
                  {!valid && eligibility?.reasons.map((r) => <div key={r.rule}>• {t('architecture.compat.reason', { reason: uiLocale === 'ko' ? r.ko : r.en })}</div>)}
                </div>
              )}
            </div>
          </div>

          {sizing && platform && template && (
            <div className="grid-4" style={{ marginTop: 10 }}>
              <Stat label={t('architecture.stat.computeRacks')} value={fmtInt(sizing.racks * pods)} delta={t('architecture.stat.perUnit', { n: sizing.racks })} />
              <Stat label={t('architecture.stat.accelerators')} value={fmtInt(sizing.racks * pods * (platform.compute?.gpus ?? 0))} delta={t('architecture.stat.perRack', { n: platform.compute?.gpus ?? 0 })} />
              <Stat label={t('architecture.stat.computePower')} value={fmtPower(sizing.racks * pods * (platform.power?.nameplateKW ?? 0))} delta={t('architecture.stat.nameplate')} />
              <Stat label={t('architecture.stat.containment')} value={(template.pod.rowsPerPod ?? 2) === 2 ? t(`architecture.containment.${template.pod.containment}`) : t('architecture.containment.single')} delta={t('architecture.stat.rows', { n: template.pod.rowsPerPod ?? 2, racks: template.pod.racksPerRow })} />
            </div>
          )}

          {scaleUp && scaleUp.kind !== 'none' && (
            <div
              className="small"
              style={{
                marginTop: 10,
                padding: '8px 10px',
                borderLeft: '3px solid var(--accent)',
                background: 'var(--surface-2)',
                lineHeight: 1.45,
                whiteSpace: 'normal',
                overflowWrap: 'anywhere',
              }}
              data-scale-up-domain
            >
              <strong>{t('architecture.scaleUp.title')}:</strong>{' '}
              {t('architecture.scaleUp.summary', { n: scaleUp.domainSize, fabric: scaleUpName, scope: t(scaleUp.spansRacks ? 'architecture.scaleUp.multiRack' : 'architecture.scaleUp.inRack') })}{' '}
              <span className="muted">{t('architecture.scaleUp.notSu')}</span>
            </div>
          )}
          {referenceUnit && referenceUnits != null ? (
            <div className="small" style={{ marginTop: 10, padding: '8px 10px', borderLeft: '3px solid var(--good)', background: 'var(--surface-2)', lineHeight: 1.45, whiteSpace: 'normal', overflowWrap: 'anywhere' }} data-reference-unit-evidence>
              <strong>{t('architecture.referenceUnit.title')}:</strong>{' '}
              {t('architecture.referenceUnit.summary', { racks: referenceUnit.computeRacksPerUnit, label: referenceUnit.label, total: fmtInt(referenceUnits) })}{' '}
              <a href={referenceUnit.sourceUrl} target="_blank" rel="noreferrer">{referenceUnit.sourceLabel}</a>
              {referenceUnit.note && <> <span className="muted">{referenceUnit.note}</span></>}
            </div>
          ) : platform && (
            <div className="small" style={{ marginTop: 10, padding: '8px 10px', borderLeft: '3px solid var(--border-strong)', background: 'var(--surface-2)', lineHeight: 1.45, whiteSpace: 'normal' }} data-reference-unit-evidence="undeclared">
              <strong>{t('architecture.referenceUnit.title')}:</strong> {t('architecture.referenceUnit.undeclared')}
            </div>
          )}

          <div className="row wrap" style={{ marginTop: 12 }}>
            <button className="btn primary" disabled={!valid || !sizing} onClick={() => handoff('layout')}><Icon name="layout" size={14} />{t('architecture.action.layout')}</button>
            <button className="btn" disabled={!valid || !sizing} onClick={() => handoff('site')}><Icon name="site" size={14} />{t('architecture.action.site')}</button>
            <span className="hint">{t('architecture.action.hint')}</span>
          </div>
        </div>
      </Section>

      <Section title={t('architecture.baseline.title')}>
        <div className="card">
          <p className="hint" style={{ marginTop: 0 }}>{t('architecture.baseline.desc')}</p>
          <div className="grid-2">
            {STANDARD_TEMPLATES.map((x) => {
              const slot = x.computeSlots[0];
              const def = findCatalogItem(slot.defaultPlatform ?? x.pod.gpuRackCatalogId);
              const dsum = def ? platformSummary(def, locale) : null;
              return (
                <button key={x.id} className={`card ${templateId === x.id ? 'active' : ''}`} style={{ textAlign: 'left', cursor: 'pointer', margin: 0 }} onClick={() => setTemplateId(x.id)} disabled={!templateCompatible(x, platformId)}>
                  <div className="row wrap"><strong>{x.name}</strong><span className="badge std-level">{t('architecture.badge.ocpInterface')}</span><SourceBadge source={x.source} /></div>
                  <div className="caption">{dsum ? dsum.plain : x.profile?.rackForm ?? '—'} · {t('architecture.baseline.platforms', { n: slot.platforms.length })}</div>
                </button>
              );
            })}
          </div>
          <p className="caption" style={{ marginBottom: 0 }}>
            {t('architecture.baseline.estimateNote')}<br />
            {t('architecture.baseline.source')}{' '}
            <a href="https://www.opencompute.org/wiki/Open_Rack/SpecsAndDesigns" target="_blank" rel="noreferrer">Open Rack specifications</a>
            {' · '}<a href="https://www.opencompute.org/wiki/Cooling_Environments/Cold_Plate" target="_blank" rel="noreferrer">liquid-cooling interfaces</a>
          </p>
        </div>
      </Section>
    </div>
  );
}
