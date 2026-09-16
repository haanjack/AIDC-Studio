// IP / ASN plan formatting (stream T7; data from T2's buildIpPlan) — one combined CSV, one CSV per section and a
// printable HTML page with a section per table.
import type { IpPlan, Locale, Project } from '../model/types.ts';
import { csvFile } from './csv.ts';
import { escapeHtml, htmlPage, htmlTable } from './html.ts';
import { netStrings } from './netStrings.ts';
import { splitEndpoint, type PlanDevice } from './devices.ts';

export const IP_PLAN_SECTIONS = ['blocks', 'loopbacks', 'asns', 'p2p', 'hosts', 'oob'] as const;
export type IpPlanSection = (typeof IP_PLAN_SECTIONS)[number];

/** Fixed column order per section CSV. */
export const IP_PLAN_COLUMNS: Record<IpPlanSection, string[]> = {
  blocks: ['family', 'name', 'cidr', 'purpose'],
  loopbacks: ['device', 'hostname', 'role', 'ipv4', 'ipv6'],
  asns: ['device', 'hostname', 'role', 'asn'],
  p2p: ['hall', 'network', 'rail', 'link_id', 'a_device', 'a_port', 'b_device', 'b_port', 'ipv4_cidr', 'ipv6_cidr', 'ipv6_a', 'ipv6_b', 'unnumbered'],
  hosts: ['hall', 'network', 'plane', 'rail', 'switch', 'node', 'nic', 'ipv4', 'ipv4_gateway', 'ipv6', 'ipv6_gateway', 'vlan'],
  oob: ['hall', 'switch', 'device', 'hostname', 'ipv4', 'ipv4_gateway', 'ipv6', 'ipv6_gateway'],
};

/** Combined CSV column order (`section` first, union of the section columns). */
export const IP_PLAN_COMBINED_COLUMNS = ['section', ...new Set(IP_PLAN_SECTIONS.flatMap((s) => IP_PLAN_COLUMNS[s]))];

export function ipPlanRows(plan: IpPlan, devices: PlanDevice[] = []): Record<IpPlanSection, Record<string, unknown>[]> {
  const dev = new Map(devices.map((d) => [d.id, d]));
  const hn = (id: string) => dev.get(id)?.hostname ?? '';
  const role = (id: string) => dev.get(id)?.role ?? '';
  const byIp = (a: { ip: string }, b: { ip: string }) => ipKey(a.ip) - ipKey(b.ip);
  return {
    blocks: [
      ...plan.blocks.map((b) => ({ family: 'IPv4', name: b.name, cidr: b.cidr, purpose: b.purpose })),
      ...(plan.ipv6Blocks ?? []).map((b) => ({ family: 'IPv6', name: b.name, cidr: b.cidr, purpose: b.purpose })),
    ],
    loopbacks: [...plan.loopbacks].sort(byIp).map((l) => ({ device: l.deviceId, hostname: hn(l.deviceId), role: role(l.deviceId), ipv4: l.ip, ipv6: l.ipv6 ? `${l.ipv6}/128` : undefined })),
    asns: [...plan.asns].sort((a, b) => a.asn - b.asn || a.deviceId.localeCompare(b.deviceId)).map((a) => ({ device: a.deviceId, hostname: hn(a.deviceId), role: role(a.deviceId), asn: a.asn })),
    p2p: plan.p2p.map((p) => {
      const A = splitEndpoint(p.a), B = splitEndpoint(p.b);
      return { hall: p.hallId, network: p.network, rail: p.rail, link_id: p.linkId, a_device: A.device, a_port: A.port, b_device: B.device, b_port: B.port, ipv4_cidr: p.cidr, ipv6_cidr: p.ipv6Cidr, ipv6_a: p.ipv6A, ipv6_b: p.ipv6B, unnumbered: p.unnumbered };
    }),
    hosts: plan.hosts.map((h) => ({ hall: h.hallId, network: h.network, plane: h.plane, rail: h.rail, switch: h.switchDevice, node: h.nodeId, nic: h.nic, ipv4: h.ip, ipv4_gateway: h.gw, ipv6: h.ipv6, ipv6_gateway: h.ipv6Gw, vlan: h.vlan })),
    oob: [...plan.oob].sort(byIp).map((o) => ({ hall: o.hallId, switch: o.switchDevice, device: o.deviceId, hostname: hn(o.deviceId), ipv4: o.ip, ipv4_gateway: o.gw, ipv6: o.ipv6, ipv6_gateway: o.ipv6Gw })),
  };
}

/** Sort key for dotted IPv4 (with optional /prefix); non-IPv4 strings sort last, stably. */
export function ipKey(ip: string): number {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)/.exec(ip);
  return m ? ((+m[1] * 256 + +m[2]) * 256 + +m[3]) * 256 + +m[4] : Number.MAX_SAFE_INTEGER;
}

/** Print-safe, script-free address map. Each lane uses the true position inside the site prefix. */
function addressPlanFigure(plan: IpPlan, locale: Locale): string {
  const S = netStrings(locale);
  const width = 1_080;
  const labelW = 390;
  const plotW = width - labelW - 18;
  const rowH = 23;
  const v4 = plan.blocks.flatMap((b, i) => {
    const m = /\/(\d+)$/.exec(b.cidr);
    const prefix = m ? Number(m[1]) : 32;
    const size = 2 ** (32 - prefix);
    const start = ipKey(b.cidr);
    const root = ipKey(plan.ipv4Prefix ?? `${b.cidr.split('.')[0]}.0.0.0/8`);
    return Number.isFinite(start) && start !== Number.MAX_SAFE_INTEGER ? [{ ...b, i, pos: Math.max(0, (start - root) / 2 ** 24), share: size / 2 ** 24 }] : [];
  });
  const v6 = (plan.ipv6Blocks ?? []).flatMap((b, i) => {
    const m = /:([0-9a-f])000::\/52$/i.exec(b.cidr);
    return m ? [{ ...b, i, pos: Number.parseInt(m[1], 16) / 16, share: 1 / 16 }] : [];
  });
  const rows = v4.length + v6.length + (v4.length && v6.length ? 2 : 1);
  const height = 30 + rows * rowH;
  const palette = ['#23689b', '#2f7f7b', '#6b73a8', '#8b6f47', '#587f4f', '#7d5e91'];
  let y = 24;
  const out = [`<figure id="ip-allocation-figure"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(S.ipMapTitle)}" style="font-family:'Noto Sans','Noto Sans KR','Segoe UI',sans-serif">`];
  const section = (title: string, blocks: { name: string; cidr: string; i: number; pos: number; share: number }[]) => {
    out.push(`<text x="8" y="${y}" font-size="15" font-weight="700" fill="#16181b">${escapeHtml(title)}</text>`);
    y += 10;
    for (const b of blocks) {
      y += rowH;
      const x = labelW + b.pos * plotW;
      const w = Math.max(1, b.share * plotW);
      out.push(`<text x="8" y="${y - 5}" font-size="11" font-weight="600" fill="#16181b">${escapeHtml(b.name)}</text>`);
      out.push(`<text x="138" y="${y - 5}" font-size="10.5" font-family="monospace" fill="#4a4f57">${escapeHtml(b.cidr)}</text>`);
      out.push(`<rect x="${labelW}" y="${y - 17}" width="${plotW}" height="14" rx="2" fill="#eef1f4" stroke="#c9ced4"/>`);
      out.push(`<rect x="${x.toFixed(2)}" y="${y - 16}" width="${w.toFixed(2)}" height="12" rx="1" fill="${palette[b.i % palette.length]}"/>`);
    }
    y += 12;
  };
  if (v4.length) section(S.ipMapV4, v4);
  if (v6.length) section(S.ipMapV6, v6);
  out.push(`</svg><figcaption>${escapeHtml(S.ipMapIntro)}</figcaption></figure>`);
  return out.join('');
}

export function ipPlanCsv(plan: IpPlan, devices: PlanDevice[] = []): string {
  const rows = ipPlanRows(plan, devices);
  return csvFile(IP_PLAN_SECTIONS.flatMap((s) => rows[s].map((r) => ({ section: s, ...r }))), IP_PLAN_COMBINED_COLUMNS);
}

export function ipPlanSectionCsv(plan: IpPlan, section: IpPlanSection, devices: PlanDevice[] = []): string {
  return csvFile(ipPlanRows(plan, devices)[section], IP_PLAN_COLUMNS[section]);
}

export function ipPlanHtml(project: Project, plan: IpPlan, locale: Locale, generatedAt: string, devices: PlanDevice[] = []): string {
  const S = netStrings(locale);
  const C = S.ipCols;
  const rows = ipPlanRows(plan, devices);
  const total = IP_PLAN_SECTIONS.reduce((n, s) => n + rows[s].length, 0);
  const hallName = new Map(project.halls.map((h) => [h.id, h.name]));
  const railGroups = new Map<string, { hall: string; plane: number; rail: number; ipv4: Set<string>; ipv6: Set<string>; switches: Set<string>; endpoints: number }>();
  const v4Subnet = (address: string): string => {
    const [raw, p = '32'] = address.split('/');
    const prefix = Number(p);
    const n = ipKey(raw);
    if (!Number.isFinite(n) || n === Number.MAX_SAFE_INTEGER || prefix < 0 || prefix > 32) return address;
    const size = 2 ** (32 - prefix);
    const start = n - (n % size);
    return `${[(start >>> 24) & 255, (start >>> 16) & 255, (start >>> 8) & 255, start & 255].join('.')}/${prefix}`;
  };
  const v6Subnet = (address: string | undefined): string | undefined => {
    if (!address) return undefined;
    const raw = address.split('/')[0];
    const halves = raw.split('::');
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
    const words = [...left, ...new Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
    return words.length === 8 ? `${words.slice(0, 4).map((x) => Number.parseInt(x || '0', 16).toString(16)).join(':')}::/64` : undefined;
  };
  for (const h of plan.hosts) {
    if (h.network !== 'backend' || h.rail === undefined) continue;
    const plane = h.plane ?? 0;
    const key = `${h.hallId ?? ''}|${plane}|${h.rail}`;
    let g = railGroups.get(key);
    if (!g) {
      g = { hall: hallName.get(h.hallId ?? '') ?? h.hallId ?? '-', plane, rail: h.rail, ipv4: new Set(), ipv6: new Set(), switches: new Set(), endpoints: 0 };
      railGroups.set(key, g);
    }
    g.ipv4.add(v4Subnet(h.ip));
    const v6 = v6Subnet(h.ipv6);
    if (v6) g.ipv6.add(v6);
    if (h.switchDevice) g.switches.add(h.switchDevice);
    g.endpoints++;
  }
  const addressed = plan.hosts.length + plan.oob.length + plan.loopbacks.length + plan.p2p.filter((p) => !p.unnumbered).length;
  const summaryRows: (string | number)[][] = [
    [S.ipSummary.families, (plan.addressFamilies ?? ['ipv4']).map((x) => x.toUpperCase()).join(' + ')],
    [S.ipSummary.ipv4, plan.ipv4Prefix ?? plan.blocks[0]?.cidr ?? '-'],
    [S.ipSummary.ipv6, plan.ipv6Prefix ?? '-'],
    [S.ipSummary.fabric, plan.fabricLinks === 'numbered' ? S.numbered : S.unnumbered],
    [S.ipSummary.endpoints, addressed],
    [S.ipSummary.rails, railGroups.size],
    [S.ipSummary.notes, plan.notes?.length ?? 0],
  ];
  const summary = `<table class="meta"><tbody>${summaryRows.map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td class="mono">${escapeHtml(value)}</td></tr>`).join('')}</tbody></table>`;
  const parts: string[] = [`<p>${escapeHtml(S.ipIntro)}</p>`, `<section id="ip-summary"><h2>${escapeHtml(S.ipSummary.title)}</h2>${summary}<p class="note">${escapeHtml(S.ipV6CapacityNote)}</p>${plan.notes?.length ? `<ul>${plan.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>` : ''}</section>`];
  if (plan.blocks.length || plan.ipv6Blocks?.length) parts.push(`<section class="chapter" id="ip-map"><h2>${escapeHtml(S.ipMapTitle)}</h2>${addressPlanFigure(plan, locale)}</section>`);
  if (!total) parts.push(`<p class="note">${escapeHtml(S.notAvailable(S.ipTitle(project.name)))}</p>`);
  const str = (v: unknown) => (v === undefined || v === null || v === '' ? '-' : String(v));
  const roleLabel = (r: unknown) => S.roles[String(r)] ?? str(r);
  const tables: Record<IpPlanSection, () => string> = {
    blocks: () => htmlTable([C.family, C.name, C.cidr, C.purpose], rows.blocks.map((r) => [str(r.family), str(r.name), str(r.cidr), str(r.purpose)]), { monoCols: [2] }),
    loopbacks: () => htmlTable([C.device, C.hostname, C.role, C.ip, C.ipv6], rows.loopbacks.map((r) => [str(r.device), str(r.hostname), roleLabel(r.role), str(r.ipv4), str(r.ipv6)]), { monoCols: [0, 1, 3, 4] }),
    asns: () => htmlTable([C.device, C.hostname, C.role, C.asn], rows.asns.map((r) => [str(r.device), str(r.hostname), roleLabel(r.role), str(r.asn)]), { monoCols: [0, 1, 3], numericCols: [3] }),
    p2p: () => htmlTable([`${C.hall} · ${C.network} · ${C.rail}`, C.link, C.a, C.b, C.ip, C.ipv6, C.unnumbered], rows.p2p.map((r) => [[hallName.get(String(r.hall)) ?? r.hall, r.network, r.rail === undefined ? '' : `R${r.rail}`].filter((x) => x !== undefined && x !== '').join(' · '), str(r.link_id), [r.a_device, r.a_port].filter(Boolean).join(':'), [r.b_device, r.b_port].filter(Boolean).join(':'), str(r.ipv4_cidr), str(r.ipv6_cidr), r.unnumbered ? S.unnumbered : S.numbered]), { monoCols: [1, 2, 3, 4, 5] }),
    hosts: () => htmlTable([`${C.hall} · ${C.plane} · ${C.rail}`, C.network, C.switch, `${C.node}:${C.nic}`, C.ip, C.gw, C.ipv6, C.ipv6Gw, C.vlan], rows.hosts.map((r) => [[hallName.get(String(r.hall)) ?? r.hall, r.plane === undefined ? '' : `P${r.plane}`, r.rail === undefined ? '' : `R${r.rail}`].filter((x) => x !== undefined && x !== '').join(' · '), str(r.network), str(r.switch), [r.node, r.nic].filter(Boolean).join(':'), str(r.ipv4), str(r.ipv4_gateway), str(r.ipv6), str(r.ipv6_gateway), str(r.vlan)]), { monoCols: [2, 3, 4, 5, 6, 7], numericCols: [8] }),
    oob: () => htmlTable([C.hall, C.switch, C.device, C.hostname, C.ip, C.gw, C.ipv6, C.ipv6Gw], rows.oob.map((r) => [str(hallName.get(String(r.hall)) ?? r.hall), str(r.switch), str(r.device), str(r.hostname), str(r.ipv4), str(r.ipv4_gateway), str(r.ipv6), str(r.ipv6_gateway)]), { monoCols: [1, 2, 3, 4, 5, 6, 7] }),
  };
  if (railGroups.size) {
    const railRows = [...railGroups.values()].sort((a, b) => a.hall.localeCompare(b.hall, undefined, { numeric: true }) || a.plane - b.plane || a.rail - b.rail);
    parts.push(`<section class="chapter" id="ip-rails"><h2>${escapeHtml(S.ipRailTitle)} <span class="pill">${railRows.length}</span></h2><p>${escapeHtml(S.ipRailIntro)}</p>${htmlTable([C.hall, C.plane, C.rail, C.switch, 'IPv4', 'IPv6', C.endpoints], railRows.map((g) => [g.hall, g.plane, g.rail, [...g.switches].join(', '), S.ipSubnetCount(g.ipv4.size), [...g.ipv6].join(', ') || '-', g.endpoints]), { monoCols: [3, 4, 5], numericCols: [1, 2, 6] })}</section>`);
  }
  for (const s of IP_PLAN_SECTIONS) {
    parts.push(`<section class="chapter" id="ip-${s}"><h2>${escapeHtml(S.ipSections[s])} <span class="pill">${rows[s].length}</span></h2>`);
    parts.push(rows[s].length ? tables[s]() : `<p class="muted">${escapeHtml(S.empty)}</p>`);
    parts.push('</section>');
  }
  const toc = [
    { id: 'ip-summary', label: S.ipSummary.title, level: 1 as const },
    ...((plan.blocks.length || plan.ipv6Blocks?.length) ? [{ id: 'ip-map', label: S.ipMapTitle, level: 1 as const }] : []),
    ...(railGroups.size ? [{ id: 'ip-rails', label: `${S.ipRailTitle} (${railGroups.size})`, level: 1 as const }] : []),
    ...IP_PLAN_SECTIONS.map((s) => ({ id: `ip-${s}`, label: `${S.ipSections[s]} (${rows[s].length})`, level: 1 as const })),
  ];
  return htmlPage(S.ipTitle(project.name), parts.join('\n'), locale, { landscape: true, subtitle: S.generated(generatedAt), toc, footer: `${project.name} · ${S.generated(generatedAt)}` });
}
