import { useMemo, useState } from 'react';
import { effectiveStandardsProfile, inferHallOverrides, pinnedDocuments, STANDARDS_PRESET_IDS, type Hall, type StandardsPresetId } from '@aidc/core';
import { useApp } from '../store/appStore.ts';
import { useT } from '../i18n/index.ts';
import {
  HALL_OVERRIDE_FIELDS, PROFILE_FIELDS, confirmProfile, fieldOptions, hallOverrideField, matchingPresetId, profileFieldValue, profileFromPreset,
  setHallOverrideField, setProfileField, type ProfileField,
} from '../app/standardsUi.ts';
import { DataTable, Section, Select, SelectField, Seg, Toggle } from './controls.tsx';

/**
 * Standards profile selector (stream E / P5, OCP-DESIGN-PROPOSAL §6.1): project default in the Site panel, hall override in the
 * Layout panel. Preset dropdown, strictness (DO-3) and drafts (DO-4) toggles, expandable fields, pinned documents with status,
 * and the "inferred — confirm" banner for legacy projects. All labels come from the `standards` namespace (no internal keys).
 */
export function ProjectStandardsSection() {
  const t = useT();
  const project = useApp((s) => s.project);
  const update = useApp((s) => s.update);
  const p = project.standards;
  const [pick, setPick] = useState<StandardsPresetId>('orv3-hpr-liquid');
  const presetOptions = (withCustom: boolean) => [
    ...STANDARDS_PRESET_IDS.map((id) => ({ value: id as string, label: t(`standards.preset.${id}`) })),
    ...(withCustom ? [{ value: 'custom', label: t('standards.preset.custom') }] : []),
  ];
  const overrides = useMemo(() => {
    if (!p?.inferred) return {};
    try { return inferHallOverrides(project, p); } catch { return {}; }
  }, [project, p]);
  const pendingOverrides = Object.keys(overrides).filter((hid) => !project.halls.find((h) => h.id === hid)?.standards);

  if (!p) {
    return (
      <Section title={t('standards.ui.section')}>
        <div className="card" data-standards-profile="none">
          <p className="hint" style={{ marginTop: 0 }}>{t('standards.ui.none')}</p>
          <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
            <div style={{ minWidth: 260 }}><Select value={pick as string} options={presetOptions(false)} onChange={(v) => setPick(v as StandardsPresetId)} /></div>
            <button className="btn sm primary" data-standards-set onClick={() => update((d) => { d.standards = profileFromPreset(pick); })}>{t('standards.ui.setProfile')}</button>
          </div>
        </div>
      </Section>
    );
  }

  const presetId = matchingPresetId(p);
  const docs = pinnedDocuments(p);
  const setField = (f: ProfileField, v: string) => update((d) => { if (d.standards) d.standards = setProfileField(d.standards, f, v); });
  return (
    <Section title={t('standards.ui.section')}>
      <div className="card" data-standards-profile={p.inferred ? 'inferred' : 'confirmed'}>
        <p className="hint" style={{ marginTop: 0 }}>{t('standards.ui.hint')}</p>
        {p.inferred && (
          <div className="row wrap" style={{ gap: 8, alignItems: 'center', padding: '6px 8px', marginBottom: 8, borderLeft: '3px solid var(--warning)' }} data-standards-inferred>
            <span className="grow" style={{ minWidth: 200 }}>{t('standards.ui.inferredBanner')}</span>
            <button className="btn sm primary" data-standards-confirm onClick={() => update((d) => { if (d.standards) d.standards = confirmProfile(d.standards); })}>{t('standards.ui.confirm')}</button>
            {pendingOverrides.length > 0 && (
              <>
                <span className="hint" style={{ flexBasis: '100%' }}>{t('standards.ui.hallOverridesOffer', { n: pendingOverrides.length })}</span>
                <button className="btn sm" data-standards-hall-overrides onClick={() => update((d) => { for (const hid of pendingOverrides) { const h = d.halls.find((x) => x.id === hid); if (h) h.standards = overrides[hid]; } })}>{t('standards.ui.applyHallOverrides')}</button>
              </>
            )}
          </div>
        )}
        <div className="fields-2">
          <div data-standards-preset={presetId ?? 'custom'}>
            <SelectField label={t('standards.ui.preset')} value={presetId ?? 'custom'} options={presetOptions(!presetId)}
              onChange={(v) => { if (v !== 'custom') update((d) => { d.standards = profileFromPreset(v as StandardsPresetId, d.standards); }); }} />
          </div>
          <div>
            <div className="field" data-standards-strictness={p.strictness}>
              <label>{t('standards.ui.strictness')}</label>
              <Seg value={p.strictness} options={[{ value: 'advisory' as const, label: t('standards.strictness.advisory') }, { value: 'gate' as const, label: t('standards.strictness.gate') }]}
                onChange={(v) => update((d) => { if (d.standards) { d.standards.strictness = v; delete d.standards.inferred; } })} />
              <span className="hint">{t('standards.ui.strictnessHint')}</span>
            </div>
            <div data-standards-drafts={p.includeDraftSpecs ? 'on' : 'off'} title={t('standards.ui.draftsHint')}>
              <Toggle label={t('standards.ui.drafts')} checked={p.includeDraftSpecs} onChange={(v) => update((d) => { if (d.standards) d.standards.includeDraftSpecs = v; })} />
            </div>
          </div>
        </div>
        <details style={{ marginTop: 6 }} data-standards-fields>
          <summary className="small" style={{ cursor: 'pointer' }}>{t('standards.ui.fields')}</summary>
          <div className="fields-2" style={{ paddingTop: 6 }}>
            {[PROFILE_FIELDS.slice(0, 6), PROFILE_FIELDS.slice(6)].map((col, ci) => (
              <div key={ci}>
                {col.map((f) => {
                  const cur = profileFieldValue(p, f);
                  return (
                    <SelectField key={f} label={t(`standards.ui.field.${f}`)} value={cur}
                      options={fieldOptions(f, cur, p.includeDraftSpecs).map((o) => ({ value: o.value, label: o.draft ? t('standards.ui.draftOption', { label: t(`standards.${f}.${o.value}`) }) : t(`standards.${f}.${o.value}`) }))}
                      onChange={(v) => setField(f, v)} />
                  );
                })}
              </div>
            ))}
          </div>
        </details>
        <div className="secondary" style={{ fontSize: 12, margin: '10px 0 4px' }}>{t('standards.ui.pinned')}</div>
        {docs.length ? (
          <div data-standards-pinned>
            <DataTable
              columns={[
                { key: 'f', header: t('standards.ui.col.family'), render: (r: (typeof docs)[number]) => t(`standards.family.${r.family}`) },
                { key: 'd', header: t('standards.ui.col.document'), render: (r) => <span style={{ whiteSpace: 'normal' }}>{r.ref.title}</span> },
                { key: 'v', header: t('standards.ui.col.version'), render: (r) => r.ref.version },
                { key: 'dt', header: t('standards.ui.col.date'), render: (r) => r.ref.date || '—' },
                { key: 's', header: t('standards.ui.col.status'), render: (r) => <span className={`badge ${['draft', 'review', 'roadmap'].includes(r.ref.status) ? 'warn' : ''}`} data-doc-status={r.ref.status}>{t(`standards.status.${r.ref.status}`)}</span> },
                { key: 'l', header: t('standards.ui.col.licence'), render: (r) => t(`standards.licence.${r.ref.licence}`) },
                { key: 'u', header: t('standards.ui.col.link'), render: (r) => <a href={r.ref.url} target="_blank" rel="noreferrer">{t('standards.ui.link')}</a> },
              ]}
              rows={docs}
              rowKey={(r) => r.ref.id}
            />
          </div>
        ) : <p className="hint">{t('standards.ui.noPinned')}</p>}
        <p className="hint" style={{ marginBottom: 0 }}>{t('standards.ui.citationNote')}</p>
      </div>
    </Section>
  );
}

/** Hall override of the project profile (Layout panel). Only fields set here differ from the project profile. */
export function HallStandardsSection({ hall }: { hall: Hall }) {
  const t = useT();
  const project = useApp((s) => s.project);
  const update = useApp((s) => s.update);
  const base = project.standards;
  const has = !!hall.standards && Object.keys(hall.standards).length > 0;
  const [open, setOpen] = useState(has);
  const eff = effectiveStandardsProfile(project, hall);
  // preset label when the profile matches one, otherwise the rack form (avoids repeating the rack form twice)
  const profileText = (x: NonNullable<typeof eff>) => { const id = matchingPresetId(x); return id ? t(`standards.preset.${id}`) : `${t('standards.preset.custom')} · ${t(`standards.rackForm.${x.rackForm}`)}`; };
  const setField = (f: ProfileField, v: string | undefined) => update((d) => {
    const h = d.halls.find((x) => x.id === hall.id);
    if (!h) return;
    const next = setHallOverrideField(h.standards, f, v);
    if (next) h.standards = next;
    else delete h.standards;
  });
  return (
    <details style={{ margin: '0 0 10px' }} data-hall-standards={has ? 'override' : 'inherit'} open={has || undefined}>
      <summary className="small" style={{ cursor: 'pointer' }}>{t('standards.ui.hallSection', { hall: hall.name })}</summary>
      <div style={{ paddingTop: 6 }}>
        {!base || !eff ? (
          <p className="hint">{t('standards.ui.noProjectProfile')}</p>
        ) : (
          <>
            <Toggle label={t('standards.ui.hallOverride')} checked={open || has} onChange={(v) => { setOpen(v); if (!v) update((d) => { const h = d.halls.find((x) => x.id === hall.id); if (h) delete h.standards; }); }} />
            {!(open || has) && <p className="hint">{t('standards.ui.hallInherit', { profile: profileText(base) })}</p>}
            {(open || has) && (
              <div className="fields-2" style={{ paddingTop: 4 }}>
                {[HALL_OVERRIDE_FIELDS.slice(0, 4), HALL_OVERRIDE_FIELDS.slice(4)].map((col, ci) => (
                  <div key={ci}>
                    {col.map((f) => {
                      const own = hallOverrideField(hall.standards, f);
                      const projectValue = profileFieldValue(base, f);
                      return (
                        <SelectField key={f} label={t(`standards.ui.field.${f}`)} value={own ?? ''}
                          options={[{ value: '', label: t('standards.ui.useProject', { value: t(`standards.${f}.${projectValue}`) }) }, ...fieldOptions(f, own, eff.includeDraftSpecs).map((o) => ({ value: o.value, label: o.draft ? t('standards.ui.draftOption', { label: t(`standards.${f}.${o.value}`) }) : t(`standards.${f}.${o.value}`) }))]}
                          onChange={(v) => setField(f, v || undefined)} />
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
            <p className="hint" style={{ margin: '2px 0 0' }} data-hall-standards-effective>{t('standards.ui.effective', { profile: profileText(eff) })}</p>
          </>
        )}
      </div>
    </details>
  );
}
