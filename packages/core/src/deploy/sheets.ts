// Printable HTML renderings of the BOM by wave and the rack plan (stream T7, F5). Same content as the former
// Markdown deliverables (waveBomMarkdown / rackPlanMarkdown remain exported for compatibility but are not shipped).
import { findCatalogItem } from '../catalog/catalog.ts';
import type { Locale, Project, ProjectAnalysis, SpecSource } from '../model/types.ts';
import { makeFormatters } from '../docs/index.ts';
import { COMMON_WAVE, RACK_CATS, reconcileBom, waveOf, type BomGroup, type WaveBom } from './bom.ts';
import { escapeHtml, htmlPage, htmlTable } from './html.ts';
import type { RackPlan } from './rackplan.ts';
import { deployStrings } from './strings.ts';

export function waveBomHtml(project: Project, bom: WaveBom, locale: Locale, generatedAt: string, analysis?: ProjectAnalysis | null): string {
  const S = deployStrings(locale);
  const { n } = makeFormatters(locale);
  const src = (s: SpecSource) => S.sourceLabel[s] ?? s;
  const parts: string[] = [`<p>${escapeHtml(S.bomIntro)}</p>`];
  const waveIds = [...bom.waves.map((w) => w.id), COMMON_WAVE];
  const C = S.summaryCols;
  const sumRows = waveIds.map((wid) => {
    const ls = bom.lines.filter((l) => l.waveId === wid);
    const q = (g: BomGroup) => ls.filter((l) => l.group === g).reduce((s, l) => s + l.qty, 0);
    const eqs = project.equipment.filter((e) => waveOf(e, project) === wid);
    const gpus = eqs.reduce((s, e) => s + (findCatalogItem(e.catalogId)?.compute?.gpus ?? 0), 0);
    const kw = eqs.reduce((s, e) => { const it = findCatalogItem(e.catalogId); return s + (it && RACK_CATS.has(it.category) ? (it.power?.nameplateKW ?? 0) * (e.loadFactor ?? 1) : 0); }, 0);
    return [wid === COMMON_WAVE ? S.common : bom.waves.find((w) => w.id === wid)?.name ?? wid, n(q('racks')), n(gpus), n(q('switches')), n(q('cables')), n(q('transceivers')), n(q('cooling')), n(kw)];
  });
  const toc: { id: string; label: string; level: 1 | 2 }[] = [{ id: 'summary', label: S.summaryTitle, level: 1 }];
  parts.push(`<section class="chapter" id="summary"><h2>${escapeHtml(S.summaryTitle)}</h2>`, htmlTable([C.wave, C.racks, C.gpus, C.switches, C.cables, C.optics, C.cooling, C.kw], sumRows, { numericCols: [1, 2, 3, 4, 5, 6, 7] }), '</section>');
  for (const wid of waveIds) {
    const ls = bom.lines.filter((l) => l.waveId === wid);
    if (!ls.length) continue;
    const w = bom.waves.find((x) => x.id === wid);
    const id = `wave-${wid}`;
    toc.push({ id, label: w ? w.name : S.common, level: 1 });
    parts.push(`<section class="chapter" id="${escapeHtml(id)}"><h2>${escapeHtml(w ? w.name : S.common)}</h2>`);
    if (w) parts.push(`<ul><li>${escapeHtml(S.pods)}: ${escapeHtml(w.podIds.join(', ') || '-')}</li><li>${escapeHtml(S.target)}: ${escapeHtml(w.targetReadyDate ?? '-')}</li></ul>`);
    for (const g of [...new Set(ls.map((l) => l.group))]) {
      const gl = ls.filter((l) => l.group === g);
      parts.push(`<h3>${escapeHtml(S.groups[g])}</h3>`);
      if (g === 'cables') parts.push(htmlTable([S.item, S.lengthBin, S.qty, S.totalLength, S.source], gl.map((l) => [l.description, l.lengthBin ?? '', n(l.qty), `${n(l.totalLengthM ?? 0)} m`, src(l.source)]), { numericCols: [2, 3] }));
      // stream E (P5, proposal §6.3): standard and spec-status columns (display text, never internal keys)
      else if (gl.some((l) => l.standard)) parts.push(htmlTable([S.item, S.qty, S.unit, S.source, locale === 'ko' ? '표준' : 'Standard', locale === 'ko' ? '사양 상태' : 'Spec status', locale === 'ko' ? '구현 수준' : 'Implementation'], gl.map((l) => [l.description, n(l.qty, l.unit === 'm' ? 1 : 0), l.unit, src(l.source), l.standard ? `${l.standard} ${l.standardVersion ?? ''}`.trim() : '-', l.specStatus || '-', l.implementationLevel || '-']), { numericCols: [1] }));
      else parts.push(htmlTable([S.item, S.qty, S.unit, S.source], gl.map((l) => [l.description, n(l.qty, l.unit === 'm' ? 1 : 0), l.unit, src(l.source)]), { numericCols: [1] }));
    }
    parts.push('</section>');
  }
  const totals = new Map<string, { description: string; qty: number; unit: string; group: BomGroup }>();
  for (const l of bom.lines) {
    const k = `${l.group}|${l.itemId}`;
    const cur = totals.get(k) ?? { description: l.description.replace(` ${S.unplaced}`, ''), qty: 0, unit: l.unit, group: l.group };
    cur.qty += l.qty;
    totals.set(k, cur);
  }
  toc.push({ id: 'totals', label: S.totalsTitle, level: 1 });
  parts.push(`<section class="chapter" id="totals"><h2>${escapeHtml(S.totalsTitle)}</h2>`, htmlTable([S.group, S.item, S.qty, S.unit], [...totals.values()].map((t) => [S.groups[t.group], t.description, n(t.qty, t.unit === 'm' ? 1 : 0), t.unit]), { numericCols: [2] }));
  for (const note of bom.notes) parts.push(`<p class="note">${escapeHtml(note)}</p>`);
  parts.push('</section>');
  // polish v2 2차 (QA docs #3): scope of this BOM vs analysis.cost.bom, line by line
  toc.push({ id: 'reconciliation', label: S.reconTitle, level: 1 });
  parts.push(`<section class="chapter" id="reconciliation"><h2>${escapeHtml(S.reconTitle)}</h2><p>${escapeHtml(S.reconIntro)}</p>`);
  const costBom = analysis?.cost?.bom;
  if (costBom?.length) {
    const rec = reconcileBom(bom, costBom);
    const R = S.reconCols;
    const usd = (v: number) => n(Math.round(v));
    parts.push(htmlTable([R.scope, R.item, R.domain, R.costQty, R.waveQty, R.unit, R.usd], rec.rows.map((r) => [
      S.reconScope[r.scope] ?? r.scope, r.description, r.domain ?? '—', r.costQty !== undefined ? n(r.costQty, r.unit === 'ea' ? 0 : 1) : '—', r.waveQty !== undefined ? n(r.waveQty, r.unit === 'ea' ? 0 : 1) : '—', r.unit, usd(r.costUSD),
    ]), { numericCols: [3, 4, 6], id: 'bom-reconciliation' }));
    const scopeRows = Object.entries(rec.usdByScope).map(([k, v]) => [S.reconScope[k] ?? k, usd(v ?? 0)]);
    parts.push(`<h3>${escapeHtml(S.reconTotals)}</h3>`, htmlTable([R.scope, R.usd], [...scopeRows, [S.reconTotal, usd(rec.costTotalUSD)]], { numericCols: [1], id: 'bom-reconciliation-totals' }));
    if (rec.qtyMismatches) parts.push(`<p class="note">${escapeHtml(S.reconMismatch(rec.qtyMismatches))}</p>`);
  } else parts.push(`<p class="note">${escapeHtml(S.reconNoCost)}</p>`);
  parts.push('</section>');
  return htmlPage(S.bomTitle(project.name), parts.join('\n'), locale, { toc, subtitle: generatedAt, footer: `${project.name} · ${generatedAt}` });
}

export function rackPlanHtml(project: Project, plan: RackPlan, locale: Locale, generatedAt: string): string {
  const S = deployStrings(locale);
  const { n } = makeFormatters(locale);
  const C = S.rackCols;
  const parts: string[] = [`<p>${escapeHtml(S.rackIntro)}</p>`];
  const toc: { id: string; label: string; level: 1 | 2 }[] = [];
  for (const hall of project.halls) {
    const rows = plan.rows.filter((r) => r.hallId === hall.id);
    if (!rows.length) continue;
    const id = `hall-${hall.id}`;
    toc.push({ id, label: hall.name, level: 1 });
    parts.push(`<section class="chapter" id="${escapeHtml(id)}"><h2>${escapeHtml(hall.name)} <span class="pill">${rows.length}</span></h2>`);
    parts.push(htmlTable([C.row, C.position, C.tag, C.type, C.category, C.wave, C.kw, C.weight, C.pod, C.role, C.x, C.y, C.rot], rows.map((r) => [
      r.row, r.position, r.tag, r.type, S.categories[r.category] ?? r.category, r.wave, n(r.kw, 1), n(r.weightKg), r.podId ?? '-', r.networkRole ?? '-', n(r.x, 2), n(r.y, 2), r.rotationDeg,
    ]), { numericCols: [1, 6, 7, 10, 11, 12], monoCols: [2] }));
    parts.push('</section>');
  }
  const U = S.umapCols;
  toc.push({ id: 'umaps', label: S.umapTitle, level: 1 });
  parts.push(`<section class="chapter" id="umaps"><h2>${escapeHtml(S.umapTitle)}</h2><p>${escapeHtml(S.umapIntro)}</p>`);
  for (const um of plan.umaps) {
    parts.push(`<h3>${escapeHtml(`${um.type} — ${S.categories[um.category] ?? um.category}`)}</h3>`);
    parts.push(`<ul><li>${escapeHtml(S.umapRacks(um.rackIds.length, um.tags.slice(0, 12).join(', ') + (um.tags.length > 12 ? ' …' : '')))}</li><li>${escapeHtml(S.ruUsed(um.ruUsed, um.ruCapacity, n(um.kw, 1), n(um.kwCapacity, 1)))}</li></ul>`);
    const freeTop = um.entries.length ? Math.min(...um.entries.map((e) => e.ruFrom)) - 1 : um.ruCapacity;
    const entries: (string | number)[][] = um.entries.map((e) => [e.ru, e.content, e.qty, S.sourceLabel[e.source] ?? e.source]);
    if (freeTop > 0) entries.push([freeTop === 1 ? 'U1' : `U1–U${freeTop}`, S.free, freeTop, S.sourceLabel.estimate]);
    parts.push(htmlTable([U.ru, U.content, U.qty, U.source], entries, { numericCols: [2] }));
  }
  parts.push('</section>');
  return htmlPage(S.rackTitle(project.name), parts.join('\n'), locale, { toc, subtitle: generatedAt, footer: `${project.name} · ${generatedAt}` });
}
