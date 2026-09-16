import { useState } from 'react';
import { findCatalogItem, itemStandardsFields, type BomLine, type PricingSettings } from '@aidc/core';
import { useApp } from '../store/appStore.ts';
import { downloadText } from '../app/api.ts';
import { fmtInt, fmtMoney, fmtPower } from '../app/format.ts';
import { BarChart } from '../ui/charts.tsx';
import { DataTable, Empty, NumberField, Seg, SourceBadge, Stat } from '../ui/controls.tsx';
import { Icon } from '../ui/icons.tsx';
import { Term } from '../ui/Term.tsx';
import { useT } from '../i18n/index.ts';

const DOMAIN_KEY: Record<BomLine['domain'], string> = {
  it: 'cost.domain.it', network: 'cost.domain.network', cabling: 'cost.domain.cabling', power: 'cost.domain.power',
  cooling: 'cost.domain.cooling', facility: 'cost.domain.facility', labor: 'cost.domain.labor', contingency: 'cost.domain.contingency',
};

export function CostPanel() {
  const project = useApp((s) => s.project);
  const analysis = useApp((s) => s.analysis);
  const update = useApp((s) => s.update);
  const [domain, setDomain] = useState<'all' | BomLine['domain']>('all');
  const pr = project.pricing;
  const set = <K extends keyof PricingSettings>(k: K, v: PricingSettings[K]) => update((d) => { d.pricing[k] = v; });
  const cost = analysis?.cost;
  const money = (v: number) => fmtMoney(v, pr);
  const t = useT();
  const uiLocale = useApp((s) => s.uiLocale);
  const domainLabel = (k: string) => { const key = DOMAIN_KEY[k as BomLine['domain']]; return key ? t(key) : k; };

  const lines = (cost?.bom ?? []).filter((l) => domain === 'all' || l.domain === domain);
  const total = lines.reduce((a, l) => a + l.totalUSD, 0);

  return (
    <div className="grid-auto">
      <div className="card">
        <h3>{t('cost.pricing.title')}</h3>
        <div className="field"><label>{t('cost.pricing.currency')}</label><Seg value={pr.currency} options={[{ value: 'USD', label: 'USD' }, { value: 'KRW', label: 'KRW' }]} onChange={(v) => set('currency', v)} /></div>
        <NumberField label={t('cost.pricing.fx')} unit="₩/$" step={10} value={pr.fxKRWPerUSD} onChange={(v) => set('fxKRWPerUSD', v)} />
        <NumberField label={t('cost.pricing.labor')} unit="$/h" value={pr.laborUSDPerHour} onChange={(v) => set('laborUSDPerHour', v)} />
        <NumberField label={t('cost.pricing.shell')} unit="$/m²" step={100} value={pr.shellUSDPerM2} onChange={(v) => set('shellUSDPerM2', v)} />
        <NumberField label={<Term id="capex-opex">{t('cost.pricing.contingency')}</Term>} step={0.01} min={0} max={0.5} value={pr.contingency} onChange={(v) => set('contingency', v)} />
        <NumberField label={t('cost.pricing.itDepreciation')} unit={t('cost.pricing.yearsUnit')} value={pr.depreciationYears.it} onChange={(v) => update((d) => { d.pricing.depreciationYears.it = v; })} />
        <NumberField label={t('cost.pricing.facilityDepreciation')} unit={t('cost.pricing.yearsUnit')} value={pr.depreciationYears.facility} onChange={(v) => update((d) => { d.pricing.depreciationYears.facility = v; })} />
        <p className="hint">{t('cost.pricing.hint')}</p>
      </div>

      {!cost ? (
        <Empty>{t('cost.empty')}</Empty>
      ) : (
        <>
          <div className="card">
            <h3>{t('cost.summary.title')}</h3>
            <div className="grid-3">
              <Stat label={<Term id="capex-opex">CAPEX</Term>} value={money(cost.capexUSD)} />
              <Stat label={t('cost.summary.perGpu')} value={money(cost.usdPerGpu)} />
              <Stat label={t('cost.summary.perMwIt')} value={money(cost.usdPerMWIT)} />
              <Stat label={<Term id="capex-opex">{t('cost.summary.opexYear')}</Term>} value={money(cost.opexUSDPerYear)} delta={t('cost.summary.energy', { v: fmtInt(cost.energyMWhPerYear) })} />
              <Stat label={<Term id="capex-opex">{t('cost.summary.tco5y')}</Term>} value={money(cost.tcoUSD5y)} />
              <Stat label={t('cost.summary.facilityLoad')} value={fmtPower(analysis?.power.facilityKW)} />
            </div>
            <div style={{ marginTop: 12 }}>
              <BarChart
                title={t('cost.chart.byDomain')}
                data={Object.entries(cost.byDomain).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ label: domainLabel(k), id: k, values: { v } }))}
                series={[{ key: 'v', name: 'CAPEX' }]}
                format={money}
                labelWidth={90}
                onBarClick={(d) => setDomain((d.id as BomLine['domain']) ?? 'all')}
              />
            </div>
          </div>

          <div className="card" style={{ gridColumn: '1 / -1' }}>
            <div className="row" style={{ marginBottom: 8 }}>
              <h3 style={{ margin: 0 }}><Term id="bom">BOM</Term> {t('cost.bom.count', { n: lines.length })}</h3>
              <span className="grow" />
              <Seg value={domain} options={[{ value: 'all', label: t('cost.bom.all') }, ...(Object.keys(DOMAIN_KEY) as BomLine['domain'][]).map((k) => ({ value: k, label: domainLabel(k) }))]} onChange={setDomain} />
              <button className="btn sm" onClick={() => {
                // stream E (P5, proposal §6.3): standards columns as display text in the UI language (internal keys never exported)
                const header = 'domain,itemId,description,qty,unit,unitUSD,totalUSD,leadTimeWeeks,source,standard,standardVersion,specStatus,implementationLevel,verification';
                const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
                const csv = [header, ...cost.bom.map((l) => { const f = itemStandardsFields(findCatalogItem(l.itemId), uiLocale); return [l.domain, l.itemId, `"${l.description.replace(/"/g, '""')}"`, l.qty, l.unit, l.unitUSD.toFixed(2), l.totalUSD.toFixed(2), l.leadTimeWeeks ?? '', l.source, q(f.standard), q(f.standardVersion), q(f.specStatus), q(f.implementationLevel), q(f.verification)].join(','); })].join('\n');
                downloadText(csv, `${project.id}-bom.csv`, 'text/csv');
              }}><Icon name="download" size={13} />CSV</button>
            </div>
            <DataTable
              columns={[
                { key: 'd', header: t('cost.bom.col.domain'), render: (l: BomLine) => domainLabel(l.domain), sortValue: (l) => l.domain },
                { key: 'desc', header: t('cost.bom.col.item'), render: (l) => l.description },
                { key: 'q', header: t('cost.bom.col.qty'), num: true, render: (l) => `${fmtInt(l.qty)} ${l.unit}`, sortValue: (l) => l.qty },
                {
                  key: 'u', header: t('cost.bom.col.unitPrice'), num: true, sortValue: (l) => l.unitUSD,
                  render: (l) => findCatalogItem(l.itemId) ? (
                    <input type="number" style={{ width: 110 }} defaultValue={Math.round(l.unitUSD)} key={`${l.id}-${l.unitUSD}`}
                      onBlur={(e) => { const v = Number(e.target.value); if (Number.isFinite(v) && Math.round(v) !== Math.round(l.unitUSD)) update((d) => { d.pricing.itemOverrides[l.itemId] = v; }); }} />
                  ) : fmtInt(l.unitUSD),
                },
                { key: 't', header: t('cost.bom.col.amount'), num: true, render: (l) => money(l.totalUSD), sortValue: (l) => l.totalUSD },
                { key: 'lt', header: <Term id="lead-time">{t('cost.bom.col.leadTime')}</Term>, num: true, render: (l) => (l.leadTimeWeeks != null ? t('cost.bom.weeks', { n: l.leadTimeWeeks }) : '–'), sortValue: (l) => l.leadTimeWeeks ?? 0 },
                { key: 's', header: <Term id="spec-source">{t('cost.bom.col.source')}</Term>, render: (l) => <SourceBadge source={l.source} /> },
              ]}
              rows={lines}
              rowKey={(l) => l.id}
              initialSort={{ key: 't', dir: -1 }}
              maxHeight={560}
              footer={<tr><td colSpan={4}>{t('cost.bom.total')}</td><td className="num">{money(total)}</td><td colSpan={2} /></tr>}
            />
            {Object.keys(pr.itemOverrides).length > 0 && (
              <div className="row" style={{ marginTop: 6 }}>
                <span className="hint">{t('cost.bom.overrides', { n: Object.keys(pr.itemOverrides).length })}</span>
                <button className="btn ghost sm" onClick={() => update((d) => { d.pricing.itemOverrides = {}; })}>{t('cost.bom.resetOverrides')}</button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
