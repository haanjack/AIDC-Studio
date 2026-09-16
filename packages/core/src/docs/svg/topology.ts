// Network topology diagram as inline SVG (replaces the mermaid `flowchart BT`): one panel per fabric, tiers stacked
// bottom-up (endpoints → leaf → spine → core) with representative switch glyphs, Clos mesh lines between shown
// glyphs, counts, ports and oversubscription as visible text. Deterministic for identical input.
import type { FabricAnalysis, Locale } from '../../model/types.ts';
import { BAND, INK, INK2, RULE, SERIES, box, fit, line, svgRoot, text } from './common.ts';

export interface TopologySvgOptions {
  locale?: Locale;
  title?: string;
  /** catalog id → model name */
  modelOf?: (catalogId: string) => string | undefined;
}

const MAX_GLYPHS = 8;

export function fabricTopologySvg(fabrics: FabricAnalysis[], opts: TopologySvgOptions = {}): string {
  const L: Locale = opts.locale ?? 'en';
  const title = opts.title ?? (L === 'ko' ? '네트워크 토폴로지' : 'Network topology');
  const T = L === 'ko'
    ? { endpoints: '엔드포인트 링크', links: '링크', ports: '포트', os: '오버서브스크립션', infeasible: '불가', extrapolated: '외삽 (추정)', none: '패브릭 없음' }
    : { endpoints: 'endpoint links', links: 'links', ports: 'ports', os: 'oversubscription', infeasible: 'infeasible', extrapolated: 'extrapolated (estimate)', none: 'No fabrics' };
  if (!fabrics.length) return svgRoot(480, 60, title, [text(16, 34, T.none, { fill: INK2 })]);
  const cols = fabrics.length <= 2 ? fabrics.length : 2;
  const PW = 500, GAP = 18, M = 16, TIER_H = 92;
  const maxTiers = Math.max(...fabrics.map((f) => f.tiers.length));
  const PH = 44 + (maxTiers + 1) * TIER_H + 8;
  const rows = Math.ceil(fabrics.length / cols);
  const width = M * 2 + cols * PW + (cols - 1) * GAP;
  const height = M * 2 + rows * PH + (rows - 1) * GAP;
  const body: string[] = [];
  const nf = (v: number) => Math.round(v).toLocaleString('en-US');

  fabrics.forEach((f, fi) => {
    const color = SERIES[Math.min(fi, SERIES.length - 1)];
    const px = M + (fi % cols) * (PW + GAP);
    const py = M + Math.floor(fi / cols) * (PH + GAP);
    body.push(box(px, py, PW, PH, { fill: '#fff', stroke: RULE, rx: 4 }));
    body.push(box(px, py, PW, 30, { fill: BAND, rx: 4 }));
    body.push(box(px, py, 6, 30, { fill: color }));
    body.push(text(px + 14, py + 20, fit(f.name, 12, PW - 150), { size: 12, weight: 700 }));
    const badge = f.feasible === false ? T.infeasible : f.extrapolated ? T.extrapolated : '';
    const right = [f.topology ?? '', `${f.oversubscription}:1`].filter(Boolean).join(' · ');
    body.push(text(px + PW - 10, py + 20, fit(badge ? `${badge} · ${right}` : right, 10, 140), { size: 10, anchor: 'end', fill: INK2 }));

    const model = opts.modelOf?.(f.switchCatalogId) ?? f.switchCatalogId;
    const baseY = py + PH - 26; // endpoint bar y
    // endpoints bar
    const epLinks = f.links ?? f.endpoints;
    body.push(box(px + 40, baseY, PW - 80, 16, { fill: BAND, stroke: INK2, sw: 0.8, rx: 2, title: `${nf(f.endpoints)} endpoints` }));
    body.push(text(px + PW / 2, baseY + 12, `${T.endpoints} ${nf(epLinks)}${f.linkGbps ? ` · ${Math.round(f.linkGbps)}G` : ''}`, { size: 10, anchor: 'middle' }));

    let prevGlyphs: number[] = [];
    let prevY = baseY;
    f.tiers.forEach((t, ti) => {
      const y = baseY - (ti + 1) * TIER_H;
      const shown = Math.min(t.switches, MAX_GLYPHS);
      const ellipsis = t.switches > MAX_GLYPHS;
      const gw = 30, gh = 16;
      const slots = shown + (ellipsis ? 1 : 0);
      const span = PW - 190;
      const step = slots > 1 ? span / (slots - 1) : 0;
      const x0 = px + 150 + (slots > 1 ? 0 : span / 2);
      const glyphs: number[] = [];
      for (let i = 0; i < slots; i++) {
        const cx = x0 + i * step;
        if (ellipsis && i === slots - 2) {
          body.push(text(cx, y + 12, '…', { size: 14, anchor: 'middle', fill: INK2 }));
          continue;
        }
        glyphs.push(cx);
      }
      // links to the tier below (drawn first → under glyphs)
      if (ti === 0) {
        for (const gx of glyphs) body.push(line(gx, y + gh, gx, prevY, RULE, 0.8));
      } else {
        for (const a of prevGlyphs) for (const b of glyphs) body.push(line(a, prevY, b, y + gh, RULE, 0.6));
      }
      glyphs.forEach((gx) => body.push(box(gx - gw / 2, y, gw, gh, { fill: '#fff', stroke: color, sw: 1.4, rx: 2, title: `${t.name} · ${model}` })));
      // labels
      body.push(text(px + 12, y + 8, fit(`${t.name} × ${nf(t.switches)}`, 11.5, 132), { size: 11.5, weight: 600 }));
      body.push(text(px + 12, y + 22, fit(model, 9.5, 132), { size: 9.5, fill: INK2 }));
      body.push(text(px + 12, y + 34, `${t.portsPerSwitch} ${T.ports} · ${t.downlinks}↓ ${t.uplinks}↑`, { size: 9.5, fill: INK2 }));
      // link count annotation between this tier and the one below
      const lower = ti === 0 ? undefined : f.tiers[ti - 1];
      const nLinks = lower ? lower.uplinks * lower.switches : undefined;
      if (nLinks) body.push(text(px + PW - 12, y + gh + (prevY - y - gh) / 2 + 4, `${nf(nLinks)} ${T.links}`, { size: 9.5, anchor: 'end', fill: INK2 }));
      prevGlyphs = glyphs;
      prevY = y;
    });
  });
  return svgRoot(width, height, title, body);
}
