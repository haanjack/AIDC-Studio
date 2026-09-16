// Cable schedule formatting (stream T7; rows come from T2's buildCableSchedule) — CSV, printable HTML and the
// Cumulus PTM topology.dot used for LLDP cabling verification.
import { cableTypes } from '../catalog/catalog.ts';
import type { CableScheduleRow, Locale, Project } from '../model/types.ts';
import { csvFile } from './csv.ts';
import { escapeHtml, htmlPage, htmlTable } from './html.ts';
import { netStrings } from './netStrings.ts';
import { splitEndpoint, type PlanDevice } from './devices.ts';

/** Fixed CSV column order (DU-10438 §5.2.1 / §5.2.3 content + reach check). */
export const CABLE_SCHEDULE_COLUMNS = [
  'cable_id', 'bsn', 'fabric', 'tier', 'wave', 'a_rack', 'a_u', 'a_port', 'b_rack', 'b_u', 'b_port',
  'cable_type', 'cable_type_name', 'medium', 'speed_gbps', 'length_m', 'reach_m', 'reach_util_pct', 'reach_check', 'label_a', 'label_b',
] as const;

/** Reach utilisation at or above this share is flagged (DU-10438 "less than 90% of the max distance", acceptance-threshold). */
export const REACH_LIMIT = 0.9;

/** Optional detail T2 attaches to schedule rows (not part of the contract type). */
type RowExtra = CableScheduleRow & { bsn?: number; tier?: string; speedGbps?: number; fabricKey?: string };

export interface CableScheduleRecord {
  row: CableScheduleRow;
  bsn: number;
  tier?: string;
  speedGbps?: number;
  typeName: string;
  medium: string;
  reachM?: number;
  reachUtil?: number;
  check: 'ok' | 'over-90pct' | 'unknown-type';
}

/**
 * Records in schedule order. BSN = T2's bundling sequence number when present (it is printed in the labels), else one
 * number per (fabric, from rack, to rack, cable type) bundle in first-seen order (DU-10438 "group the cables by their
 * sequence number").
 */
export function cableScheduleRecords(rows: CableScheduleRow[]): CableScheduleRecord[] {
  const types = new Map(cableTypes().map((t) => [t.id, t]));
  const bsn = new Map<string, number>();
  return rows.map((row) => {
    const x = row as RowExtra;
    const key = `${row.fabric}|${row.fromRack}|${row.toRack}|${row.cableTypeId}`;
    if (!bsn.has(key)) bsn.set(key, bsn.size + 1);
    const t = types.get(row.cableTypeId);
    const reachM = t?.maxReachM;
    const reachUtil = reachM && reachM > 0 ? row.lengthM / reachM : undefined;
    return {
      row, bsn: typeof x.bsn === 'number' ? x.bsn : bsn.get(key)!, tier: x.tier, speedGbps: x.speedGbps ?? (t?.gbps || undefined), typeName: t?.name ?? row.cableTypeId,
      medium: t?.medium ?? t?.kind ?? '', reachM, reachUtil, check: reachUtil === undefined ? 'unknown-type' : reachUtil >= REACH_LIMIT ? 'over-90pct' : 'ok',
    };
  });
}

const r1 = (v: number) => Math.round(v * 10) / 10;

export function cableScheduleCsv(rows: CableScheduleRow[]): string {
  return csvFile(cableScheduleRecords(rows).map((r) => ({
    cable_id: r.row.cableId, bsn: r.bsn, fabric: r.row.fabric, tier: r.tier, wave: r.row.wave, a_rack: r.row.fromRack, a_u: r.row.fromU, a_port: r.row.fromPort,
    b_rack: r.row.toRack, b_u: r.row.toU, b_port: r.row.toPort, cable_type: r.row.cableTypeId, cable_type_name: r.typeName, medium: r.medium, speed_gbps: r.speedGbps,
    length_m: r1(r.row.lengthM), reach_m: r.reachM, reach_util_pct: r.reachUtil === undefined ? undefined : Math.round(r.reachUtil * 100), reach_check: r.check,
    label_a: r.row.labelA, label_b: r.row.labelB,
  })), [...CABLE_SCHEDULE_COLUMNS]);
}

/** Printable schedule, one section per fabric. Label text lives in the CSV (identical content, printed by the label tool). */
export function cableScheduleHtml(project: Project, rows: CableScheduleRow[], locale: Locale, generatedAt: string): string {
  const S = netStrings(locale);
  const C = S.cableCols;
  const recs = cableScheduleRecords(rows);
  const fabrics = [...new Set(recs.map((r) => r.row.fabric))];
  const tag = locale === 'ko' ? 'ko-KR' : 'en-US';
  const parts: string[] = [`<p>${escapeHtml(S.cableIntro)}</p>`, `<p class="note">${escapeHtml(S.reachRule)}</p>`];
  if (!recs.length) parts.push(`<p class="note">${escapeHtml(S.notAvailable(S.cableTitle(project.name)))}</p>`);
  else parts.push(`<p>${escapeHtml(S.cableSummary(recs.length.toLocaleString(tag), fabrics.length))}</p>`);
  const checkLabel = (c: CableScheduleRecord['check']) => (c === 'ok' ? S.reachOk : c === 'over-90pct' ? S.reachOver : S.reachUnknown);
  const toc: { id: string; label: string; level: 1 }[] = [];
  fabrics.forEach((f, fi) => {
    const fr = recs.filter((r) => r.row.fabric === f);
    const id = `fabric-${fi + 1}`;
    toc.push({ id, label: `${f} (${fr.length.toLocaleString(tag)})`, level: 1 });
    parts.push(`<section class="chapter" id="${id}"><h2>${escapeHtml(f)} <span class="pill">${fr.length.toLocaleString(tag)}</span></h2>`);
    parts.push(htmlTable(
      [C.id, C.bsn, C.wave, C.aPort, C.bPort, C.type, C.length, C.util, C.check],
      fr.map((r) => [r.row.cableId, r.bsn, r.row.wave ?? '-', r.row.fromPort, r.row.toPort, r.typeName, r1(r.row.lengthM).toLocaleString(tag), r.reachUtil === undefined ? '-' : `${Math.round(r.reachUtil * 100)} %`, checkLabel(r.check)]),
      { numericCols: [1, 6, 7], monoCols: [0, 3, 4] },
    ));
    parts.push('</section>');
  });
  return htmlPage(S.cableTitle(project.name), parts.join('\n'), locale, { landscape: true, toc, subtitle: S.generated(generatedAt), footer: `${project.name} · ${S.generated(generatedAt)}` });
}

const dq = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** Front-panel `P12` / `P12/2` → Cumulus `swp12` / `swp12s1` (split-port naming per the Cumulus Linux 5.18 user guide). */
export function nvuePortName(port: string, lanes = 1): string {
  const m = /^P(\d+)(?:\/(\d+))?$/.exec(port);
  if (!m) return port;
  return m[2] || lanes > 1 ? `swp${m[1]}s${Number(m[2] ?? 1) - 1}` : `swp${m[1]}`;
}

/**
 * Cumulus Linux PTM cabling plan (`/etc/ptm.d/topology.dot`). Edge syntax `"host":"port" -- "host":"port"` follows
 * the Cumulus Linux 5.18 PTM documentation; the `graph G { }` wrapper is not shown there → verify comment.
 * Switch ends resolve to generated hostnames and NVUE port names; server ends keep the node id and NIC name.
 */
export function topologyDot(rows: CableScheduleRow[], devices: PlanDevice[] = []): string {
  const byTia = new Map(devices.filter((d) => d.tia).map((d) => [d.tia!, d]));
  const breakout = new Set<string>();
  for (const r of rows) for (const p of [r.fromPort, r.toPort]) if (/:P\d+\/\d+$/.test(p)) breakout.add(splitEndpoint(p).device + ':' + /:P(\d+)\//.exec(p)![1]);
  const end = (p: string) => {
    const { device, port } = splitEndpoint(p);
    const d = byTia.get(device);
    if (!d || !port) return [device, port ?? ''];
    const num = /^P(\d+)/.exec(port)?.[1];
    return [d.hostname, nvuePortName(port, num && breakout.has(`${device}:${num}`) ? 2 : 1)];
  };
  const lines = [
    '// AIDC Studio cabling plan for Cumulus Linux PTM (copy to /etc/ptm.d/topology.dot, then check with ptmctl).',
    '// Source: NVIDIA Cumulus Linux 5.18 User Guide, Prescriptive Topology Manager (edge syntax verified).',
    '// Switch hostnames and swp names are the generated plan values (see switch-inventory.csv); they must match the LLDP system and port names.',
    '// verify: the "graph G { }" wrapper is not shown in the PTM documentation.',
    'graph G {',
  ];
  for (const r of rows) {
    const [ah, ap] = end(r.fromPort);
    const [bh, bp] = end(r.toPort);
    lines.push(`  ${dq(ah)}:${dq(ap)} -- ${dq(bh)}:${dq(bp)}`);
  }
  lines.push('}');
  return lines.join('\n') + '\n';
}
