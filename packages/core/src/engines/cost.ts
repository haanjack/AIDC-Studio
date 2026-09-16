import { cableTypes, findCatalogItem } from '../catalog/catalog.ts';
import type { BomLine, CatalogItem, CostAnalysis, PowerAnalysis, SpecSource } from '../model/types.ts';
import { cableUnitUSD, type Ctx, IT_LOAD_CATEGORIES, itemPriceUSD } from './context.ts';
import type { CoolingResult } from './cooling.ts';
import type { NetworkResult } from './network.ts';

/**
 * BOM, CAPEX, OPEX and TCO.
 *
 *  Placed equipment is priced at catalog/override prices; plant sized by the engines (UPS, generators,
 *  transformers, busway runs, chillers, dry coolers) uses max(placed, required).
 *  Synthetic lines (estimates): UPS Li-ion batteries 420 USD/kWh, LV switchgear 260 k USD per transformer,
 *  HV (≥ 35 kV) customer substation 2.0 M USD + 60 k USD/MVA per feed (MV: 450 k USD per feed),
 *  electrical balance-of-system 6 % of power equipment, TCS manifolds/hoses 9 k USD per liquid-cooled rack,
 *  FWS piping 140 k USD/MW liquid heat, CHW piping 90 k USD/MW air heat, BMS/EPMS 180 USD/m²,
 *  fire detection & suppression 220 USD/m², containment 380 USD/m² walls + 320 USD/m² roof, cable tray 1.1 k USD/rack.
 *  Labor = Σ catalog installHours + 0.4 h/optical cable + 0.25 h/copper cable + 6 h/liquid rack piping, × laborUSDPerHour.
 *  OPEX = annual facility energy at 85 % average IT utilization × tariff + 2 % of CAPEX maintenance.
 */

export function analyzeCostCtx(ctx: Ctx, r: { network: NetworkResult; cooling: CoolingResult; power: PowerAnalysis }): CostAnalysis {
  const { project } = ctx;
  const pr = project.pricing;
  const lines: BomLine[] = [];
  let laborHours = 0;

  const add = (domain: BomLine['domain'], itemId: string, description: string, qty: number, unit: BomLine['unit'], unitUSD: number, leadTimeWeeks?: number, source: SpecSource = 'estimate') => {
    if (!(qty > 0) || !Number.isFinite(unitUSD)) return;
    const id = `${domain}:${itemId}`;
    const existing = lines.find((l) => l.id === id);
    if (existing) {
      existing.totalUSD += qty * unitUSD;
      existing.qty += qty;
      existing.unitUSD = existing.totalUSD / existing.qty;
      return;
    }
    lines.push({ id, domain, itemId, description, qty, unit, unitUSD, totalUSD: qty * unitUSD, leadTimeWeeks, source });
  };
  const addItem = (domain: BomLine['domain'], item: CatalogItem | undefined, qty: number) => {
    if (!item || qty <= 0) return;
    add(domain, item.id, item.name, qty, 'ea', itemPriceUSD(project, item), item.cost.leadTimeWeeks, item.source);
    laborHours += qty * item.cost.installHours;
  };

  // IT & network racks (placed)
  const placedCount = new Map<string, { item: CatalogItem; n: number }>();
  for (const p of ctx.placed) {
    const cur = placedCount.get(p.item.id) ?? { item: p.item, n: 0 };
    cur.n++;
    placedCount.set(p.item.id, cur);
  }
  const placedOf = (category: string) => [...placedCount.values()].filter((v) => v.item.category === category);
  for (const { item, n } of placedCount.values()) {
    if (IT_LOAD_CATEGORIES.has(item.category)) addItem('it', item, n);
    else if (item.category === 'network-rack') addItem('network', item, n);
  }

  // switches
  const switches = new Map<string, number>();
  for (const plan of r.network.plans) switches.set(plan.sw.id, (switches.get(plan.sw.id) ?? 0) + plan.leaves + plan.spines + plan.cores);
  for (const [id, n] of switches) addItem('network', findCatalogItem(id), n);

  // cables & optics
  for (const c of r.network.analysis.cablesByType) {
    const t = cableTypes().find((x) => x.id === c.cableTypeId);
    if (!t || c.count <= 0) continue;
    const avgLen = c.totalLengthM / c.count;
    if (pr.cableOverrides[t.id] !== undefined) {
      add('cabling', t.id, `${t.name} (avg ${avgLen.toFixed(1)} m, incl. optics)`, c.count, 'ea', cableUnitUSD(project, t, avgLen), 12, t.source);
    } else {
      add('cabling', t.id, `${t.name} (avg ${avgLen.toFixed(1)} m)`, c.count, 'ea', t.cableUSD + t.cableUSDPerM * avgLen, 10, t.source);
      if (c.transceivers > 0) add('cabling', `${t.id}-optic`, `${t.name} — transceivers`, c.transceivers, 'ea', t.transceiverUSD, 16, t.source);
    }
    laborHours += c.count * (t.kind === 'dac' || t.kind === 'aec' || t.kind === 'acc' || t.kind === 'cat6a' ? 0.25 : 0.4);
  }

  // power
  const pd = project.power;
  const pw = r.power;
  const upsItem = findCatalogItem(pd.upsCatalogId);
  addItem('power', upsItem, pw.ups.units);
  const upsKWh = pw.ups.unitKVA * pd.powerFactor * (pd.batteryMinutes / 60);
  add('power', 'ups-battery', `Li-ion UPS battery string (${pd.batteryMinutes} min, ${Math.round(upsKWh)} kWh)`, pw.ups.units, 'ea', upsKWh * 420, 24);
  addItem('power', findCatalogItem(pd.generatorCatalogId), pw.generators.units);
  addItem('power', findCatalogItem(pd.transformerCatalogId), pw.transformers.units);
  add('power', 'lv-switchgear', 'LV main switchgear line-up (per transformer)', pw.transformers.units, 'ea', 260_000, 30);
  laborHours += pw.transformers.units * 80;
  addItem('power', findCatalogItem(pd.rppCatalogId), pw.rpps.units);
  for (const f of project.site.utility) {
    if (f.voltageKV >= 35) add('power', 'hv-substation', `Customer HV substation bay + main transformer (${f.voltageKV} kV)`, 1, 'ea', 2_000_000 + 60_000 * f.capacityMVA, 60);
    else add('power', 'mv-switchgear', `MV incoming switchgear (${f.voltageKV} kV)`, 1, 'ea', 450_000, 36);
  }
  if (pd.powerSmoothing === 'bess') {
    const bess = findCatalogItem('bess-2mw');
    addItem('power', bess, Math.ceil((pw.itDesignKW * 0.15) / (bess?.capacity?.powerKW ?? 2000)));
  }
  const powerEquip = lines.filter((l) => l.domain === 'power').reduce((s, l) => s + l.totalUSD, 0);
  add('power', 'elec-bos', 'Electrical balance of system (MV/LV cabling, grounding, EPMS)', 1, 'lot', powerEquip * 0.06);

  // cooling
  const cd = project.cooling;
  const ca = r.cooling.analysis;
  const cduPlaced = placedOf('cdu');
  if (cduPlaced.length) {
    const placedN = cduPlaced.reduce((s, v) => s + v.n, 0);
    cduPlaced.forEach((v) => addItem('cooling', v.item, v.n));
    if (ca.cdus.units > placedN) addItem('cooling', findCatalogItem(cd.cduCatalogId), ca.cdus.units - placedN);
  } else addItem('cooling', findCatalogItem(cd.cduCatalogId), ca.cdus.units);
  const crahPlaced = [...placedOf('crah'), ...placedOf('fan-wall')];
  const crahPlacedN = crahPlaced.reduce((s, v) => s + v.n, 0);
  crahPlaced.forEach((v) => addItem('cooling', v.item, v.n));
  if (ca.crahs.units > crahPlacedN) addItem('cooling', findCatalogItem(cd.crahCatalogId), ca.crahs.units - crahPlacedN);
  addItem('cooling', findCatalogItem(cd.chillerCatalogId), ca.chillers.units);
  addItem('cooling', findCatalogItem('drycooler-2000'), ca.dryCoolers?.units ?? 0);
  const liquidRacks = ctx.placed.filter((p) => (p.item.cooling?.liquidFraction ?? 0) > 0).length;
  add('cooling', 'tcs-manifold', 'TCS row manifolds, hoses & quick disconnects (per liquid-cooled rack)', liquidRacks, 'ea', 9_000, 14);
  laborHours += liquidRacks * 6;
  add('cooling', 'fws-piping', 'Facility water piping, valves & pumps (per MW liquid heat)', ca.liquidHeatKW / 1000, 'lot', 140_000, 20);
  add('cooling', 'chw-piping', 'Chilled water piping for CRAHs (per MW air heat)', ca.airHeatKW / 1000, 'lot', 90_000, 16);
  laborHours += ((ca.liquidHeatKW + ca.airHeatKW) / 1000) * 300;

  // facility / white space
  const hallArea = project.halls.reduce((s, h) => s + h.width * h.depth, 0);
  add('facility', 'shell', 'White-space shell & fit-out', hallArea, 'm2', pr.shellUSDPerM2);
  add('facility', 'bms', 'BMS / EPMS / DCIM integration', hallArea, 'm2', 180);
  add('facility', 'fire', 'Fire detection & suppression', hallArea, 'm2', 220);
  for (const c of project.containments) {
    const walls = 2 * (c.rect.w + c.rect.d) * c.height;
    const roof = c.roof ? c.rect.w * c.rect.d : 0;
    add('facility', 'containment', `${c.kind === 'hot-aisle' ? 'Hot' : 'Cold'}-aisle containment system`, 1, 'ea', walls * 380 + roof * 320, 12);
    laborHours += 40;
  }
  const rackCount = ctx.placed.filter((p) => IT_LOAD_CATEGORIES.has(p.item.category) || p.item.category === 'network-rack').length;
  add('facility', 'cable-tray', 'Overhead cable tray & fiber raceway (per rack)', rackCount, 'ea', 1_100, 8);

  // labor & contingency
  add('labor', 'install-labor', 'Installation, cabling & commissioning labor', Math.round(laborHours), 'h', pr.laborUSDPerHour);
  const subtotal = lines.reduce((s, l) => s + l.totalUSD, 0);
  add('contingency', 'contingency', `Contingency (${Math.round(pr.contingency * 100)} %)`, 1, 'lot', subtotal * pr.contingency);

  const byDomain: CostAnalysis['byDomain'] = { it: 0, network: 0, cabling: 0, power: 0, cooling: 0, facility: 0, labor: 0, contingency: 0 };
  for (const l of lines) byDomain[l.domain] += l.totalUSD;
  const capexUSD = lines.reduce((s, l) => s + l.totalUSD, 0);
  const avgFacilityKW = (pw.avgFacilityKW ?? pw.facilityKW) * 0.85;
  const energyMWhPerYear = (avgFacilityKW * 8760) / 1000;
  const opexUSDPerYear = energyMWhPerYear * 1000 * project.site.electricityUSDPerKWh + capexUSD * 0.02;

  return {
    bom: lines,
    capexUSD,
    byDomain,
    opexUSDPerYear,
    energyMWhPerYear,
    tcoUSD5y: capexUSD + 5 * opexUSDPerYear,
    usdPerGpu: ctx.gpus > 0 ? capexUSD / ctx.gpus : 0,
    usdPerMWIT: pw.itDesignKW > 0 ? capexUSD / (pw.itDesignKW / 1000) : 0,
  };
}
