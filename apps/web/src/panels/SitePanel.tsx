import { useEffect, useMemo, useState } from 'react';
import type { GrowthPattern, Hall, Keepout, PowerProfile, Site, UtilityFeed } from '@aidc/core';
import { projectGrowth, useApp } from '../store/appStore.ts';
import { fmt2, fmtDate, fmtInt, fmtPct, fmtPower } from '../app/format.ts';
import { DataTable, Meter, NumberField, Section, Select, SelectField, Stat, TextField } from '../ui/controls.tsx';
import { Term } from '../ui/Term.tsx';

import { Icon } from '../ui/icons.tsx';
import { useT } from '../i18n/index.ts';
import { HallMenu, useHallDialog } from '../ui/HallMenu.tsx';
// v2-2 project management: project name (rename) · client · description · Save as new project…
import { ProjectIdentitySection } from '../ui/ProjectMenu.tsx';
// stream E (P5, proposal §6.1): standards profile selector (project default)
import { ProjectStandardsSection } from '../ui/StandardsProfile.tsx';

export function SitePanel() {
  const project = useApp((s) => s.project);
  const analysis = useApp((s) => s.analysis);
  const update = useApp((s) => s.update);
  const setGrowth = useApp((s) => s.setGrowth);
  const hallId = useApp((s) => s.hallId);
  const setHall = useApp((s) => s.setHall);
  const openHallDialog = useHallDialog((s) => s.open);
  const site = project.site;
  const hall = project.halls.find((h) => h.id === hallId) ?? project.halls[0];
  const t = useT();
  const GROWTH_OPTIONS = useMemo<{ value: GrowthPattern; label: string }[]>(() => [
    { value: 'phased', label: t('site.growth.phased') },
    { value: 'single-build', label: t('site.growth.singleBuild') },
  ], [t]);
  const POWER_PROFILE_OPTIONS = useMemo<{ value: PowerProfile; label: string }[]>(() => [
    { value: 'iec', label: t('site.profile.iec') }, { value: 'nec', label: 'NEC 480 V' }, { value: 'kr', label: 'KR 22.9 kV · 415 V (KEPCO · KEC)' },
  ], [t]);
  const TIER_OPTIONS = useMemo<{ value: '' | NonNullable<Site['targetTier']>; label: string }[]>(() => [
    { value: '', label: t('site.tier.unset') }, { value: 'I', label: 'I' }, { value: 'II', label: 'II' }, { value: 'III', label: 'III' }, { value: 'IV', label: 'IV' },
  ], [t]);

  const setSite = <K extends keyof typeof site>(k: K, v: (typeof site)[K]) => update((d) => { d.site[k] = v; });
  const setClimate = (k: keyof typeof site.climate, v: number) => update((d) => { d.site.climate[k] = v; });
  const setFeed = (id: string, patch: Partial<UtilityFeed>) => update((d) => { Object.assign(d.site.utility.find((f) => f.id === id)!, patch); });
  const setHallField = <K extends keyof Hall>(k: K, v: Hall[K]) => update((d) => { (d.halls.find((h) => h.id === hall.id)! as Hall)[k] = v; });

  const p = analysis?.power;
  const ratio = p && p.utilityAvailableMVA > 0 ? p.utilityRequiredMVA / p.utilityAvailableMVA : 0;
  const space = analysis?.space.find((s) => s.hallId === hall.id);
  const hallPower = analysis?.power.perHall.find((h) => h.hallId === hall.id);

  return (
    <div>
      <ProjectIdentitySection />
      <Section title={t('site.section.site')}>
        <div className="fields-2">
          <div>
            <TextField label={t('site.field.name')} value={site.name} onChange={(v) => setSite('name', v)} />
            <TextField label={t('site.field.location')} value={site.location} onChange={(v) => setSite('location', v)} />
            <NumberField label={t('site.field.elevation')} unit="m" value={site.elevationM} onChange={(v) => setSite('elevationM', v)} />
            <NumberField label={t('site.field.electricityPrice')} unit="$/kWh" step={0.005} value={site.electricityUSDPerKWh} onChange={(v) => setSite('electricityUSDPerKWh', v)} />
            <NumberField label={t('site.field.carbon')} unit="kg/kWh" step={0.01} value={site.carbonKgPerKWh} onChange={(v) => setSite('carbonKgPerKWh', v)} />
          </div>
          <div>
            <NumberField label={t('site.field.dryBulb')} unit="°C" step={0.1} value={site.climate.designDryBulbC} onChange={(v) => setClimate('designDryBulbC', v)} hint={t('site.field.dryBulbHint')} />
            <NumberField label={t('site.field.wetBulb')} unit="°C" step={0.1} value={site.climate.designWetBulbC} onChange={(v) => setClimate('designWetBulbC', v)} />
            <NumberField label={t('site.field.annualMean')} unit="°C" step={0.1} value={site.climate.annualMeanC} onChange={(v) => setClimate('annualMeanC', v)} />
            <NumberField label={<Term id="economizer">{t('site.field.economizerHours')}</Term>} unit={t('site.field.hoursPerYearUnit')} step={100} value={site.climate.economizerHours} onChange={(v) => setClimate('economizerHours', v)} />
            <NumberField label={t('site.field.waterPrice')} unit="$/m³" step={0.1} value={site.waterUSDPerM3} onChange={(v) => setSite('waterUSDPerM3', v)} />
          </div>
        </div>
        <div className="fields-2">
          <div>
            <SelectField label={<Term id="growth">{t('site.field.growth')}</Term>} value={projectGrowth(project)} options={GROWTH_OPTIONS} onChange={(v) => setGrowth(v)} hint={t('site.field.growthHint')} />
          </div>
          <div>
            <SelectField label={<Term id="power-profile">{t('site.field.powerProfile')}</Term>} value={site.powerProfile ?? 'iec'} options={POWER_PROFILE_OPTIONS} onChange={(v) => setSite('powerProfile', v)} hint={t('site.field.powerProfileHint')} />
            {/* backlog T1a (DECISIONS-v2-2 §H): Site.targetTier drives the side-by-side electrical-room severity (info, warning at IV) */}
            <SelectField label={t('site.field.targetTier')} value={site.targetTier ?? ''} options={TIER_OPTIONS} onChange={(v) => update((d) => { if (v) d.site.targetTier = v; else delete d.site.targetTier; })} hint={t('site.field.targetTierHint')} />
          </div>
        </div>
      </Section>

      <ProjectStandardsSection />

      <Section
        title={t('site.feeds.title')}
        actions={
          <button className="btn sm" onClick={() => update((d) => {
            d.site.utility.push({ id: `feed-${Date.now().toString(36)}`, name: `Feed ${String.fromCharCode(65 + d.site.utility.length)}`, voltageKV: 154, capacityMVA: 40, substation: 'New S/S', availableFrom: d.schedule.projectStart });
          })}><Icon name="plus" size={13} />{t('site.feeds.add')}</button>
        }
      >
        {p && (
          <div className="card" style={{ marginBottom: 10 }}>
            <div className="grid-3">
              <Stat label={t('site.feeds.required')} value={`${fmt2(p.utilityRequiredMVA)} MVA`} delta={t('site.feeds.facilityLoad', { v: fmtPower(p.facilityKW) })} />
              <Stat label={<Term id="n-1-feed">{t('site.feeds.available')}</Term>} value={`${fmt2(p.utilityAvailableMVA)} MVA`} delta={t('site.feeds.count', { n: site.utility.length })} />
              <Stat label={t('site.feeds.headroom')} value={`${fmt2(p.utilityAvailableMVA - p.utilityRequiredMVA)} MVA`} delta={t('site.feeds.utilization', { v: fmtPct(ratio) })} />
            </div>
            <div style={{ marginTop: 8 }}><Meter ratio={ratio} /></div>
          </div>
        )}
        <DataTable
          columns={[
            { key: 'name', header: t('site.feeds.col.name'), render: (f: UtilityFeed) => <input type="text" defaultValue={f.name} onBlur={(e) => e.target.value !== f.name && setFeed(f.id, { name: e.target.value })} /> },
            { key: 'kv', header: 'kV', num: true, render: (f) => <input type="number" style={{ width: 70 }} defaultValue={f.voltageKV} onBlur={(e) => setFeed(f.id, { voltageKV: Number(e.target.value) })} /> },
            { key: 'mva', header: 'MVA', num: true, render: (f) => <input type="number" style={{ width: 70 }} defaultValue={f.capacityMVA} onBlur={(e) => setFeed(f.id, { capacityMVA: Number(e.target.value) })} /> },
            { key: 'ss', header: t('site.feeds.col.substation'), render: (f) => <input type="text" defaultValue={f.substation} onBlur={(e) => setFeed(f.id, { substation: e.target.value })} /> },
            { key: 'from', header: t('site.feeds.col.availableFrom'), render: (f) => <input type="date" value={f.availableFrom} onChange={(e) => setFeed(f.id, { availableFrom: e.target.value })} /> },
            { key: 'x', header: '', render: (f) => <button className="btn ghost sm" title={t('site.feeds.delete')} onClick={() => update((d) => { d.site.utility = d.site.utility.filter((x) => x.id !== f.id); })}><Icon name="trash" size={13} /></button> },
          ]}
          rows={site.utility}
          rowKey={(f) => f.id}
        />
        <p className="hint">{t('site.feeds.hint')}</p>
      </Section>

      <Section
        title={t('site.halls.title')}
        actions={
          <button className="btn sm" data-site-hall-add onClick={() => openHallDialog({ kind: 'add' })}><Icon name="plus" size={13} />{t('site.halls.add')}</button>
        }
      >
        <DataTable
          columns={[
            { key: 'n', header: t('site.halls.col.hall'), render: (h: Hall) => h.name },
            { key: 'a', header: t('site.halls.col.area'), num: true, render: (h) => `${fmtInt(h.width * h.depth)} m²` },
            { key: 'r', header: t('site.halls.col.racks'), num: true, render: (h) => fmtInt(analysis?.space.find((s) => s.hallId === h.id)?.rackCount) },
            { key: 'it', header: t('site.halls.col.itUsedBudget'), num: true, render: (h) => { const ph = analysis?.power.perHall.find((x) => x.hallId === h.id); return `${fmtPower(ph?.itKW)} / ${fmtPower(h.itPowerBudgetKW)}`; } },
            { key: 'u', header: t('site.halls.col.utilization'), render: (h) => { const ph = analysis?.power.perHall.find((x) => x.hallId === h.id); return <div style={{ minWidth: 80 }}><Meter ratio={ph?.utilization ?? 0} /></div>; } },
            { key: 'm', header: t('halls.col.actions'), render: (h) => <HallMenu hallId={h.id} /> },
          ]}
          rows={project.halls}
          rowKey={(h) => h.id}
          selectedKeys={[hall.id]}
          onRowClick={(h) => setHall(h.id)}
        />

        <div className="card" style={{ marginTop: 10 }}>
          <div className="row" style={{ marginBottom: 6 }}>
            <h3 style={{ margin: 0 }}>{hall.name}</h3>
            <span className="grow" />
            <button className="btn sm" data-site-hall-rename onClick={() => openHallDialog({ kind: 'rename', hallId: hall.id })}>{t('halls.menu.rename')}</button>
            <button className="btn danger sm" data-site-hall-delete disabled={project.halls.length <= 1} title={project.halls.length <= 1 ? t('halls.menu.lastHall') : undefined} onClick={() => openHallDialog({ kind: 'delete', hallId: hall.id })}>{t('site.hall.delete')}</button>
            <HallMenu hallId={hall.id} />
          </div>
          <div className="fields-2">
            <div>
              <HallNameField hall={hall} halls={project.halls} />
              <NumberField label={t('site.hall.width')} unit="m" step={0.6} value={hall.width} onChange={(v) => setHallField('width', v)} />
              <NumberField label={t('site.hall.depth')} unit="m" step={0.6} value={hall.depth} onChange={(v) => setHallField('depth', v)} />
              <NumberField label={t('site.hall.clearHeight')} unit="m" step={0.1} value={hall.clearHeight} onChange={(v) => setHallField('clearHeight', v)} />
              <NumberField label={t('site.hall.plenum')} unit="m" step={0.1} value={hall.ceilingPlenumHeight} onChange={(v) => setHallField('ceilingPlenumHeight', v)} />
              <NumberField label={<Term id="raised-floor">{t('site.hall.raisedFloor')}</Term>} unit="m" step={0.1} value={hall.raisedFloorHeight} onChange={(v) => setHallField('raisedFloorHeight', v)} />
            </div>
            <div>
              <NumberField label={<Term id="floor-load">{t('site.hall.floorLoad')}</Term>} unit="kg/m²" step={50} value={hall.floorLoadingKgPerM2} onChange={(v) => setHallField('floorLoadingKgPerM2', v)} />
              <NumberField label={<Term id="it-power-budget">{t('site.hall.itBudget')}</Term>} unit="kW" step={100} value={hall.itPowerBudgetKW} onChange={(v) => setHallField('itPowerBudgetKW', v)} hint={t('site.hall.itBudgetHint')} />
              <NumberField label={<Term id="cooling-budget">{t('site.hall.liquidBudget')}</Term>} unit="kW" step={100} value={hall.liquidCoolingBudgetKW} onChange={(v) => setHallField('liquidCoolingBudgetKW', v)} />
              <NumberField label={t('site.hall.airBudget')} unit="kW" step={100} value={hall.airCoolingBudgetKW} onChange={(v) => setHallField('airCoolingBudgetKW', v)} />
              <NumberField label={<Term id="tray">{t('site.hall.trayHeight')}</Term>} unit="m" step={0.1} value={hall.trayHeight} onChange={(v) => setHallField('trayHeight', v)} />
              <NumberField label={t('site.hall.grid')} unit="m" step={0.1} value={hall.tileSize} onChange={(v) => setHallField('tileSize', v)} />
            </div>
          </div>
          {space && (
            <div className="grid-4" style={{ marginTop: 10 }}>
              <Stat label={t('site.hall.stat.area')} value={`${fmtInt(space.areaM2)} m²`} delta={t('site.hall.stat.occupied', { v: fmtInt(space.occupiedM2) })} />
              <Stat label={t('site.hall.stat.utilization')} value={fmtPct(space.whiteSpaceUtilization)} delta={t('site.hall.stat.inclClearances')} />
              <Stat label={t('site.hall.stat.density')} value={`${fmt2(space.itDensityKWPerM2)} kW/m²`} delta={`GPU ${fmtInt(space.gpuCount)}`} />
              <Stat label={t('site.hall.stat.maxFloorLoad')} value={`${fmtInt(space.maxFloorLoadKgPerM2)}`} delta={t('site.hall.stat.allowed', { v: fmtInt(hall.floorLoadingKgPerM2) })} />
            </div>
          )}
          {hallPower && (
            <div style={{ marginTop: 10 }}>
              <div className="row"><span className="grow secondary">{t('site.hall.itPower')}</span><span className="nowrap">{fmtPower(hallPower.itKW)} / {fmtPower(hallPower.budgetKW)}</span></div>
              <Meter ratio={hallPower.utilization} />
            </div>
          )}
        </div>

        <div className="row" style={{ margin: '12px 0 6px' }}>
          <span className="secondary"><Term id="keepout">{t('site.keepouts.title')}</Term></span>
          <span className="grow" />
          <button className="btn sm" onClick={() => update((d) => {
            d.halls.find((h) => h.id === hall.id)!.keepouts.push({ id: `ko-${Date.now().toString(36)}`, kind: 'column', rect: { x: hall.width / 2, y: hall.depth / 2, w: 0.6, d: 0.6 }, label: 'Column' });
          })}><Icon name="plus" size={13} />{t('site.keepouts.add')}</button>
        </div>
        <DataTable
          columns={[
            { key: 'k', header: t('site.keepouts.col.kind'), render: (k: Keepout) => (
              <Select value={k.kind} options={(['column', 'door', 'egress', 'ramp', 'shaft', 'other'] as const).map((v) => ({ value: v, label: v }))}
                onChange={(v) => update((d) => { d.halls.find((h) => h.id === hall.id)!.keepouts.find((x) => x.id === k.id)!.kind = v; })} />
            ) },
            ...(['x', 'y', 'w', 'd'] as const).map((f) => ({
              key: f, header: f.toUpperCase(), num: true,
              render: (k: Keepout) => <input type="number" step={0.1} style={{ width: 64 }} defaultValue={k.rect[f]} onBlur={(e) => update((d) => { d.halls.find((h) => h.id === hall.id)!.keepouts.find((x) => x.id === k.id)!.rect[f] = Number(e.target.value); })} />,
            })),
            { key: 'l', header: t('site.keepouts.col.label'), render: (k: Keepout) => k.label ?? '' },
            { key: 'del', header: '', render: (k: Keepout) => <button className="btn ghost sm" onClick={() => update((d) => { const h = d.halls.find((x) => x.id === hall.id)!; h.keepouts = h.keepouts.filter((x) => x.id !== k.id); })}><Icon name="trash" size={13} /></button> },
          ]}
          rows={hall.keepouts}
          rowKey={(k) => k.id}
        />
        <p className="hint">{t('site.keepouts.availableFrom', { list: site.utility.map((f) => `${f.name} ${fmtDate(f.availableFrom)}`).join(' · ') })}</p>
      </Section>
    </div>
  );
}

/** backlog T3 (6): the hall-card name field applies the rename dialog's rules — trimmed, not blank, not used by another hall (case-insensitive);
 *  an invalid name is shown with an error and not saved (Escape restores the current name). Valid names go through `renameHall` (one undo step). */
function HallNameField({ hall, halls }: { hall: Hall; halls: Hall[] }) {
  const t = useT();
  const renameHall = useApp((s) => s.renameHall);
  const [text, setText] = useState(hall.name);
  useEffect(() => setText(hall.name), [hall.name]);
  const trimmed = text.trim();
  const blank = !trimmed;
  const taken = !blank && halls.some((h) => h.id !== hall.id && h.name.trim().toLowerCase() === trimmed.toLowerCase());
  const invalid = blank || taken;
  const commit = () => {
    if (invalid || trimmed === hall.name) return;
    renameHall(hall.id, trimmed);
  };
  const errId = `hall-name-err-${hall.id}`;
  return (
    <div className="field">
      <label htmlFor={`hall-name-${hall.id}`}>{t('site.hall.name')}</label>
      <input
        id={`hall-name-${hall.id}`} type="text" value={text} data-site-hall-name aria-invalid={invalid || undefined} aria-describedby={invalid ? errId : undefined}
        onChange={(e) => setText(e.target.value)} onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') setText(hall.name);
        }}
      />
      {invalid && <span id={errId} className="hint" role="alert" data-hall-name-error={blank ? 'empty' : 'taken'} style={{ margin: 0, color: 'var(--danger, #d64545)' }}>{t(blank ? 'site.hall.nameEmpty' : 'halls.field.nameTaken')}</span>}
    </div>
  );
}
