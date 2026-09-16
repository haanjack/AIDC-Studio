// Per-DU rack row elevation sheets (area D2, DECISIONS-v2-2 §D "랙 입면도", docs/research/r3-rack-diagrams.md §4.1–4.5).
//
// For every row group (DU row, services row, network-core row, unassigned row) and each face, one A1-landscape sheet:
// racks side by side in floor order (front = viewed from the cold aisle, rear = viewed from the hot aisle, mirrored),
// per-rack header block (tag badge in the worst status colour, model, U used / free, design and peak kW vs rack capacity,
// A/B circuits, weight vs rack static rating, wave, status chips), U rulers on both sides of each rack, device blocks to
// vertical scale with schematic faceplates by category, run labels (slot range · model · U range · kW), inlet sensor
// badges at 0.5 / 1.2 / 1.9 m (simulated value or "no simulation"), key plan, legend, notes and a row summary table.
// Rows longer than one sheet split into segments (.1, .2 …). Vertical scale is true; horizontal spacing is expanded.
import type { Locale, Project } from '../model/types.ts';
import { deviceWords } from './i18n.ts';
import { INLET_RECOMMENDED_C, SPACE_THRESHOLDS, WEIGHT_THRESHOLDS, type RackContents, type RackRowGroup, type RackStatus, type RackUnitRow } from '../deploy/rackElevationsData.ts';
import type { RackSlotCategory } from '../layout/rackContents.ts';
import { INK, INK_SOFT, LINE_LIGHT, PAPER } from './palette.ts';
import { circle, fitText, hatchDef, line, rect, text, textWidth } from './svg.ts';

export type RackFace = 'front' | 'rear';

export const STATUS_COLOR: Record<RackStatus, string> = { green: '#2e9e5b', amber: '#e0a100', red: '#d0342c', grey: '#9aa0a6' };

/** Print tints per slot category (light fills, ink strokes). */
export const SLOT_COLOR: Record<RackSlotCategory, string> = {
  'compute-tray': '#c9d6e3', 'gpu-node': '#c9d6e3', 'scaleup-switch-tray': '#a9c4d8', 'power-shelf': '#e6d6b8', switch: '#ffe08a',
  'storage-shelf': '#e6dcf4', 'storage-controller': '#d6c8ec', 'cpu-server': '#dfe6ee', 'mgmt-server': '#d9dbdd', 'patch-panel': '#e2e4e6',
  'cable-manager': '#cfd2d6', stiffener: '#b9bec4', reserved: '#ffffff', blank: '#f6f7f8', other: '#e8e8e8',
};
const PDU_A = '#f28c00';
const PDU_B = '#1e3a8a';
const SUPPLY = '#2563d9';
const RETURN = '#d7302a';

type Dict = Record<string, string>;
const EN: Dict = {
  front: 'FRONT', rear: 'REAR', frontView: 'viewed from the cold aisle', rearView: 'viewed from the hot aisle — order mirrored', title: 'Rack elevations', row: 'row',
  du: 'DU', services: 'Services zone', 'network-core': 'Network core', unassigned: 'Unassigned racks', used: 'used', free: 'free', design: 'Design', peak: 'Peak', cap: 'cap',
  noCap: 'cap —', rating: 'rating', wave: 'wave', noSim: 'no simulation', stale: 'stale', sim: 'sim', legend: 'Legend', notes: 'Notes', summary: 'Row summary', keyPlan: 'Key plan',
  tag: 'Tag', model: 'Rack model', uUsed: 'U used / total', kw: 'Design / peak kW', capacity: 'Capacity kW', weight: 'Weight / rating kg', circuits: 'A / B circuits', inlet: 'Inlet B / M / T °C', status: 'Status',
  statusSpace: 'space', statusPower: 'power', statusWeight: 'weight', statusThermal: 'inlet',
  n1: 'All values are DESIGN values from the AIDC Studio project model or SIMULATED values (CFD-lite); nothing on this sheet is measured.',
  n2: 'Vertical scale true (1 U = 44.45 mm, 1 OU = 48 mm); horizontal spacing between racks not to scale. U numbered bottom-up from U1.',
  n3: 'Rack capacity = min(power shelves per side, composer cooling cap, network rack cap); slot kW inside rack-scale systems apportioned (estimate).',
  n4: 'Empty units are filled with blanking panels (hatched, in the BOM). Humidity is not modelled.',
  thermalNone: 'Inlet sensors: no CFD-lite simulation for this hall — badges show the design limits.',
  thermalStale: 'Inlet sensors: the CFD-lite snapshot is stale (layout changed since the run at {at}).',
  thermalSim: 'Inlet sensors: CFD-lite snapshot {at}, sampled at 0.5 / 1.2 / 1.9 m.',
  lgBlank: 'Blanking panel (auto)', lgReserved: 'Reserved position', lgPduA: '0U PDU / busway side A', lgPduB: '0U PDU / busway side B', lgBusbar: 'DC busbar', lgSupply: 'Liquid supply', lgReturn: 'Liquid return',
  lgStatus: 'Status: green < {s1}% space · < {p1}% power · < {w1}% weight · inlet 18–27 °C; amber to {s2}% / 100% / 100% / max inlet; red above',
  lgSensor: 'Inlet badge: value = simulated · hollow "—" = no simulation · dashed = stale',
  cat_compute: 'GPU compute tray / node', cat_nvs: 'NVLink / scale-up switch tray', cat_power: 'Power shelf', cat_switch: 'Network switch (ports: filled = cabled)', cat_storage: 'Storage', cat_server: 'CPU / management server', cat_patch: 'Patch panel', cat_stiff: 'Stiffener / spacer',
  continued: 'continued on', segment: 'segment', src: 'U-map source',
  capping: 'capping', peakOver: 'peak > cap', noSimShort: 'no sim', blank: 'Blank',
};
const KO: Dict = {
  front: '전면', rear: '후면', frontView: '냉복도에서 본 모습', rearView: '열복도에서 본 모습 — 순서 좌우 반전', title: '랙 입면도', row: '열',
  du: 'DU', services: '서비스 구역', 'network-core': '네트워크 코어', unassigned: '미할당 랙', used: '사용', free: '여유', design: '설계', peak: '피크', cap: '용량',
  noCap: '용량 —', rating: '정격', wave: '웨이브', noSim: '시뮬레이션 없음', stale: '오래됨', sim: '시뮬', legend: '범례', notes: '주석', summary: '열 요약', keyPlan: '키 플랜',
  tag: '태그', model: '랙 모델', uUsed: 'U 사용 / 전체', kw: '설계 / 피크 kW', capacity: '용량 kW', weight: '중량 / 정격 kg', circuits: 'A / B 회로', inlet: '흡기 하 / 중 / 상 °C', status: '상태',
  statusSpace: '공간', statusPower: '전력', statusWeight: '중량', statusThermal: '흡기',
  n1: '모든 값은 AIDC Studio 프로젝트 모델의 설계값 또는 CFD-lite 시뮬레이션값이며, 이 도면에 실측값은 없습니다.',
  n2: '수직 축척은 실척(1 U = 44.45 mm, 1 OU = 48 mm), 랙 사이 수평 간격은 비축척. U는 아래에서 위로 U1부터.',
  n3: '랙 용량 = min(측당 파워 셸프, 컴포저 냉각 상한, 네트워크 랙 상한); 랙 스케일 시스템 내부 장비별 kW는 배분 추정.',
  n4: '빈 U는 블랭크 패널로 채움(해치, BOM 반영). 습도는 모델링하지 않음.',
  thermalNone: '흡기 센서: 이 홀의 CFD-lite 시뮬레이션 없음 — 배지는 설계 한계값 표시.',
  thermalStale: '흡기 센서: CFD-lite 스냅숏이 오래됨({at} 실행 이후 배치 변경).',
  thermalSim: '흡기 센서: CFD-lite 스냅숏 {at}, 0.5 / 1.2 / 1.9 m 샘플.',
  lgBlank: '블랭크 패널(자동)', lgReserved: '예약 자리', lgPduA: '0U PDU / 버스웨이 A측', lgPduB: '0U PDU / 버스웨이 B측', lgBusbar: 'DC 버스바', lgSupply: '액체 공급', lgReturn: '액체 환수',
  lgStatus: '상태: 녹색 공간 < {s1}% · 전력 < {p1}% · 중량 < {w1}% · 흡기 18–27 °C; 황색 {s2}% / 100% / 100% / 최대 흡기까지; 적색 초과',
  lgSensor: '흡기 배지: 값 = 시뮬레이션 · 속 빈 "—" = 시뮬레이션 없음 · 점선 = 오래됨',
  cat_compute: 'GPU 컴퓨트 트레이 / 노드', cat_nvs: 'NVLink / 스케일업 스위치 트레이', cat_power: '파워 셸프', cat_switch: '네트워크 스위치(포트: 채움 = 케이블 연결)', cat_storage: '스토리지', cat_server: 'CPU / 관리 서버', cat_patch: '패치 패널', cat_stiff: '보강재 / 스페이서',
  continued: '다음 시트에 계속', segment: '구간', src: 'U-map 출처',
  capping: '캡핑 필요', peakOver: '피크 > 용량', noSimShort: '시뮬 없음', blank: '블랭크',
};
export const rackElevationStrings = (L: Locale): Dict => (L === 'ko' ? KO : EN);
const fmt = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(v[k] ?? ''));
const f1 = (v: number) => (Math.round(v * 10) / 10).toLocaleString('en-US', { maximumFractionDigits: 1 });
const f0 = (v: number) => Math.round(v).toLocaleString('en-US');

export const ELEV_SCALES = [15, 20, 25, 30];
const RULER_L = 7;
const GUTTER_R = 15;
const HEADER_H = 33;

export function groupTitle(g: RackRowGroup, L: Locale): string {
  const S = rackElevationStrings(L);
  const zone = g.zone === 'du' ? g.du : g.zone === 'services' ? `${S.services}${g.du !== 'SV' ? ` ${g.du}` : ''}` : g.zone === 'network-core' ? `${S['network-core']}${g.du !== 'NC' ? ` ${g.du}` : ''}` : S.unassigned;
  return `${zone} · ${S.row} ${g.row}`;
}

/** Sheet number: 2-DU01-A-F, 2-SV-A-R, 2-NC-A.2-F, 2-XX-<row>-F; multi-hall → 2-H2-… */
export function rackSheetNumber(g: RackRowGroup, face: RackFace, segment: number, segments: number, multiHall: boolean): string {
  // finish v2 2차 (QA m12): keep one separator inside compound row names (A-C2 → 2-SV-A-C2.1-F, not AC2.1)
  const row = g.row.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `2-${multiHall ? `${g.hallCode}-` : ''}${g.du}-${row}${segments > 1 ? `.${segment}` : ''}-${face === 'front' ? 'F' : 'R'}`;
}

export interface BandLayout { den: number; mmPerM: number; pitch: number; segments: RackContents[][] }

/** Largest scale (1:15 → 1:30) at which the row fits the band width; otherwise 1:30 and balanced segments. */
export function layoutRow(g: RackRowGroup, bandW: number, scales: readonly number[] = ELEV_SCALES): BandLayout {
  const maxW = Math.max(0.6, ...g.racks.map((r) => r.rack.widthM));
  for (const den of scales) {
    const mmPerM = 1000 / den;
    const pitch = maxW * mmPerM + RULER_L + GUTTER_R;
    const per = Math.max(1, Math.floor(bandW / pitch));
    if (g.racks.length <= per || den === scales[scales.length - 1]) {
      const nSeg = Math.ceil(g.racks.length / per);
      const size = Math.ceil(g.racks.length / nSeg);
      const segments: RackContents[][] = [];
      for (let i = 0; i < nSeg; i++) segments.push(g.racks.slice(i * size, (i + 1) * size));
      return { den, mmPerM, pitch, segments: segments.filter((s) => s.length) };
    }
  }
  return { den: 30, mmPerM: 1000 / 30, pitch: 60, segments: [g.racks] };
}

const catGroup = (c: RackSlotCategory) => (c === 'gpu-node' ? 'compute-tray' : c === 'mgmt-server' ? 'cpu-server' : c);

/** Draw the faceplate glyphs of one slot. */
function faceplate(u: RackUnitRow, face: RackFace, x: number, y: number, w: number, h: number, ids: { hatch: string }): string {
  const o: string[] = [];
  const blank = u.category === 'blank';
  o.push(rect(x, y, w, h, { fill: blank ? `url(#${ids.hatch})` : u.category === 'reserved' ? PAPER : SLOT_COLOR[u.category], stroke: blank ? LINE_LIGHT : INK_SOFT, sw: 0.1, ...(u.category === 'reserved' ? { dash: '0.8 0.5' } : {}) }));
  if (h < 1) return o.join('');
  const cy = y + h / 2;
  const gh = Math.min(0.9, h * 0.45);
  switch (u.category) {
    case 'compute-tray':
    case 'scaleup-switch-tray':
      if (face === 'front') {
        o.push(rect(x + 0.6, cy - gh / 2, 1.2, gh, { fill: INK_SOFT }), rect(x + w - 1.8, cy - gh / 2, 1.2, gh, { fill: INK_SOFT }));
        const n = u.category === 'compute-tray' ? 4 : 2;
        for (let i = 0; i < n; i++) o.push(rect(x + w * 0.3 + i * 1.6, cy - gh / 2, 1.1, gh, { fill: u.category === 'compute-tray' ? '#5b6b7a' : '#3f6f95' }));
      } else if (u.category === 'compute-tray') {
        o.push(circle(x + w * 0.2, cy, Math.min(0.45, h * 0.3), { fill: SUPPLY }), circle(x + w * 0.2 + 1.3, cy, Math.min(0.45, h * 0.3), { fill: RETURN }), rect(x + w * 0.55, cy - gh / 2, w * 0.3, gh, { fill: '#6c7a88' }));
      }
      break;
    case 'gpu-node':
      if (face === 'front') for (let i = 1; i < 6; i++) o.push(line(x + (w * i) / 6, y + h * 0.2, x + (w * i) / 6, y + h * 0.8, { stroke: INK_SOFT, sw: 0.12 }));
      else for (let i = 0; i < 2; i++) o.push(rect(x + 1 + i * (w * 0.22), y + h * 0.55, w * 0.18, h * 0.3, { fill: '#8d98a3' }));
      break;
    case 'power-shelf': {
      const n = 6;
      for (let i = 0; i < n; i++) o.push(rect(x + 1.5 + i * ((w - 3) / n), cy - gh / 2, (w - 3) / n - 0.4, gh, { fill: face === 'front' ? '#a58d5f' : '#7d6a45' }));
      o.push(rect(x, y, 0.8, h, { fill: u.side === 'B' ? PDU_B : PDU_A }));
      break;
    }
    case 'switch': {
      const ports = Math.max(4, Math.min(64, u.ports ?? 32));
      const rows = u.units >= 2 ? 2 : 1;
      const perRow = Math.ceil(ports / rows);
      const pw = (w - 4) / perRow;
      const used = u.ports ? Math.round(((u.portsUsed ?? 0) / u.ports) * ports) : 0;
      if (face === 'front') {
        for (let r = 0; r < rows; r++)
          for (let i = 0; i < perRow; i++) {
            const k = r * perRow + i;
            if (k >= ports) break;
            o.push(rect(x + 2 + i * pw + pw * 0.12, y + (h * (r + 0.25)) / rows, pw * 0.76, (h * 0.5) / rows, { fill: k < used ? INK : PAPER, stroke: INK_SOFT, sw: 0.06 }));
          }
      } else {
        o.push(rect(x + 1, y + h * 0.2, w * 0.18, h * 0.6, { fill: '#8d98a3' }), rect(x + w - 1 - w * 0.18, y + h * 0.2, w * 0.18, h * 0.6, { fill: '#8d98a3' }));
        for (let i = 0; i < 3; i++) o.push(circle(x + w * 0.38 + i * w * 0.1, cy, Math.min(h * 0.3, w * 0.04), { stroke: INK_SOFT, sw: 0.1 }));
      }
      break;
    }
    case 'storage-shelf':
    case 'storage-controller':
      if (face === 'front') for (let r = 0; r < Math.min(2, u.units); r++) for (let i = 0; i < 12; i++) o.push(rect(x + 1 + i * ((w - 2) / 12), y + 0.2 + (r * (h - 0.4)) / Math.min(2, u.units), (w - 2) / 12 - 0.25, (h - 0.4) / Math.min(2, u.units) - 0.2, { fill: '#b9a9d6' }));
      else o.push(rect(x + 1, y + h * 0.2, w * 0.3, h * 0.6, { fill: '#8d98a3' }), rect(x + w - 1 - w * 0.3, y + h * 0.2, w * 0.3, h * 0.6, { fill: '#8d98a3' }));
      break;
    case 'cpu-server':
    case 'mgmt-server':
      if (face === 'front') for (let i = 0; i < 4; i++) o.push(rect(x + 1 + i * 1.3, cy - gh / 2, 1, gh, { fill: '#8d98a3' }));
      else o.push(rect(x + w - 5, cy - gh / 2, 3.8, gh, { fill: '#8d98a3' }));
      break;
    case 'patch-panel':
      for (let i = 0; i < 24; i++) o.push(rect(x + 1.5 + i * ((w - 3) / 24), cy - gh / 2, (w - 3) / 24 - 0.25, gh, { fill: face === 'front' ? INK_SOFT : '#9aa0a6' }));
      break;
    case 'cable-manager':
      for (let i = 0; i < 12; i++) o.push(rect(x + 1 + i * ((w - 2) / 12), y + h * 0.1, 0.4, h * 0.8, { fill: INK_SOFT }));
      break;
    default:
      break;
  }
  return o.join('');
}

interface Run { units: RackUnitRow[]; uStart: number; uEnd: number }

/** Consecutive slots of the same category and model form one labelled run. */
function runsOf(units: RackUnitRow[]): Run[] {
  const runs: Run[] = [];
  for (const u of [...units].sort((a, b) => b.uStart - a.uStart)) {
    const last = runs[runs.length - 1];
    if (last && catGroup(last.units[0].category) === catGroup(u.category) && last.units[0].model === u.model && last.uStart === u.uEnd + 1) {
      last.units.push(u);
      last.uStart = u.uStart;
    } else runs.push({ units: [u], uStart: u.uStart, uEnd: u.uEnd });
  }
  return runs;
}

/**
 * finish v2 2차 (QA rack-elevations M2): U range first, then count × slot code and kW per unit; the model goes on a second line (runs of
 * 4 U or more) — the slot-id range lives in the rack contents table. Old labels ("10 × CT01–CT10 · Compute tray · U29–38 · 4.9 kW ea")
 * were cut to the rack width and lost the U range and kW.
 */
function runLabelLines(r: Run, unit: string, L: Locale): [string, string | undefined] {
  const a = r.units[0];
  const S = rackElevationStrings(L);
  const range = r.uStart === r.uEnd ? `${unit}${r.uStart}` : `${unit}${r.uStart}–${r.uEnd}`;
  if (a.category === 'blank') return [`${range} · ${S.blank} ${r.uEnd - r.uStart + 1}${unit}`, undefined];
  const code = (lab: string) => lab.replace(/\d+$/, '').replace(/[-·]$/, '') || lab;
  const what = r.units.length > 1 ? `${r.units.length} × ${code(a.label)}` : a.label;
  const kw = a.kwDesign > 0 ? ` · ${f1(a.kwDesign)} kW` : '';
  const model = deviceWords(L, a.category === 'switch' ? a.model : a.model.replace(/\s*\(.*\)$/, ''));
  return [`${range} · ${what}${kw}`, model];
}

export interface BandOptions { idPrefix: string; locale: Locale; face: RackFace; mmPerM: number; pitch: number }

/**
 * One row band (header blocks + racks) at (x, y). Returns markup, defs and size. The same band is embedded in the A1
 * sheets and in rack-elevations.html (`idPrefix` keeps pattern ids unique per inline SVG).
 */
export function drawRowBand(racks: RackContents[], x: number, y: number, o: BandOptions): { svg: string; defs: string[]; w: number; h: number } {
  const S = rackElevationStrings(o.locale);
  const L = o.locale;
  const ids = { hatch: `${o.idPrefix}-blank` };
  const defs = [hatchDef(ids.hatch, '#9aa0a6', 1.0, 0.12)];
  const out: string[] = [];
  const s = o.mmPerM;
  const order = o.face === 'front' ? racks : [...racks].reverse();
  const maxH = Math.max(...order.map((r) => Math.max(r.totalU * (r.unit === 'OU' ? 0.048 : 0.04445) + 0.2, 2.0)));
  const floorY = y + HEADER_H + 4 + maxH * s;
  order.forEach((r, i) => {
    const cx = x + i * o.pitch;
    const rw = r.rack.widthM * s;
    const rx = cx + RULER_L;
    const uMm = (r.unit === 'OU' ? 0.048 : 0.04445) * s;
    const frameH = r.totalU * uMm + 0.2 * s;
    const top = floorY - frameH;
    const u0Y = floorY - 0.1 * s; // bottom of U1 (plinth 100 mm)
    const hw = o.pitch - 2;
    const g: string[] = [`<g data-equipment-id="${r.rack.id}" data-face="${o.face}">`];
    // header block
    const hy = y;
    g.push(rect(cx, hy, hw, HEADER_H - 1, { fill: PAPER, stroke: INK_SOFT, sw: 0.2 }));
    const badge = `${r.rack.row}-${String(r.rack.position).padStart(2, '0')}`;
    const bw = textWidth(badge, 2.2) + 2;
    g.push(rect(cx + 1, hy + 1, bw, 3.6, { fill: STATUS_COLOR[r.status.overall], stroke: INK, sw: 0.15 }, 0.8));
    g.push(text(cx + 1 + bw / 2, hy + 3.7, badge, { size: 2.2, weight: 700, anchor: 'middle', fill: r.status.overall === 'amber' || r.status.overall === 'grey' ? INK : PAPER }));
    g.push(text(cx + bw + 2, hy + 3.7, fitText(`${r.rack.tag} · ${o.face === 'front' ? 'F' : 'R'}`, 2.0, hw - bw - 3), { size: 2.0, weight: 700, fill: INK }));
    // finish v2 2차 (QA rack-elevations M3 / m4): circuit loading against the circuit budget, the shelf margin when capping is required,
    // peak above capacity, floor load against the hall rating
    const circ = (side: 'A' | 'B') => {
      const c = r.circuits[side];
      return c ? `${side} C${c.circuit} ${c.kw !== undefined ? `${f0(c.kw)}/` : ''}${f0(c.limitKw)} kW${c.loadingPct !== undefined ? ` ${c.loadingPct}%` : ''}` : `${side} —`;
    };
    const pf = r.powerFlags ?? {};
    const lines = [
      `${r.rack.model} · ${r.totalU}${r.unit}`,
      `${r.unit} ${r.usedU}/${r.totalU} ${S.used} · ${r.freeU} ${S.free}`,
      `${S.design} ${f1(r.kwDesign)} / ${r.circuitBudgetKw !== undefined ? `${f1(r.circuitBudgetKw)} kW ${S.cap}` : S.noCap}${pf.shelfMarginPct !== undefined ? ` (${pf.shelfMarginPct}%${pf.capping ? `, ${S.capping}` : ''})` : ''}`,
      `${S.peak} ${f1(r.kwPeak)} kW${pf.peakOverKw !== undefined ? ` (${S.peakOver})` : ''} · ${S.wave} ${r.wave.name}`,
      `${circ('A')} · ${circ('B')}`,
      `${f0(r.weightKg)} kg / ${r.ratedLoadKg ? `${f0(r.ratedLoadKg)} ${S.rating}` : `${S.rating} —`} · ${f0(r.floorLoadKgM2)}/${f0(r.floorRatingKgM2)} kg/m²`,
    ];
    lines.forEach((t, k) => g.push(text(cx + 1, hy + 7.4 + k * 3.3, fitText(t, 1.8, hw - 2), { size: 1.8, fill: k === 0 ? INK : INK_SOFT })));
    // status chips: space · power · weight · inlet
    const chips: [RackStatus, string][] = [[r.status.space, S.statusSpace], [r.status.power, S.statusPower], [r.status.weight, S.statusWeight], [r.status.thermal, S.statusThermal]];
    const cw = (hw - 2) / 4;
    chips.forEach(([st, lab], k) => {
      g.push(rect(cx + 1 + k * cw, hy + HEADER_H - 5.2, cw - 0.6, 3.6, { fill: STATUS_COLOR[st], opacity: 0.9 }));
      g.push(text(cx + 1 + k * cw + (cw - 0.6) / 2, hy + HEADER_H - 2.5, fitText(lab, 1.8, cw - 1), { size: 1.8, anchor: 'middle', fill: st === 'amber' || st === 'grey' ? INK : PAPER }));
    });
    // frame, posts and plinth
    g.push(rect(rx, top, rw, frameH, { fill: PAPER, stroke: INK, sw: 0.35 }));
    g.push(rect(rx, floorY - 0.1 * s, rw, 0.1 * s, { fill: '#2a2c30' }));
    const post = Math.max(0.8, rw * 0.05);
    // U rulers on both sides
    for (let k = 1; k <= r.totalU; k++) {
      const yy = u0Y - k * uMm;
      const major = k % 5 === 0;
      g.push(line(rx - (major ? 1.8 : 0.9), yy, rx, yy, { stroke: LINE_LIGHT, sw: 0.1 }), line(rx + rw, yy, rx + rw + (major ? 1.8 : 0.9), yy, { stroke: LINE_LIGHT, sw: 0.1 }));
      if (major || k === 1 || k === r.totalU) {
        const ty = yy + uMm / 2 + 0.65;
        g.push(text(rx - 2.1, ty, String(k), { size: 1.8, anchor: 'end', fill: INK_SOFT }));
        g.push(text(rx + rw + 2.1, ty, String(k), { size: 1.8, fill: INK_SOFT }));
      }
    }
    g.push(text(rx - 2.1, top - 0.8, r.unit, { size: 1.8, anchor: 'end', fill: INK_SOFT }));
    // slots
    const ix = rx + post;
    const iw = rw - 2 * post;
    for (const u of r.units) {
      const by = u0Y - u.uEnd * uMm;
      g.push(`<g data-slot-u0="${u.uStart}" data-kind="${u.category}">${faceplate(u, o.face, ix, by + 0.06, iw, u.units * uMm - 0.12, ids)}</g>`);
    }
    // rear-only elements: 0U PDUs, busbar, manifold
    if (o.face === 'rear') {
      for (const z of r.zeroU) {
        if (z.kind === 'pdu-0u') g.push(rect(z.side === 'A' ? rx + rw - post : rx, u0Y - r.totalU * uMm, post, r.totalU * uMm, { fill: z.side === 'A' ? PDU_A : PDU_B, opacity: 0.85 }));
        if (z.kind === 'busbar') {
          const ps = r.units.filter((u) => u.category === 'power-shelf' || u.category === 'compute-tray');
          if (ps.length) {
            const lo = Math.min(...ps.map((u) => u.uStart));
            const hi = Math.max(...ps.map((u) => u.uEnd));
            g.push(rect(rx + rw / 2 - 0.5, u0Y - hi * uMm, 1, (hi - lo + 1) * uMm, { fill: '#6b5b2e', opacity: 0.55 }));
          }
        }
        if (z.kind === 'manifold') {
          g.push(line(rx + post + 0.4, u0Y - r.totalU * uMm, rx + post + 0.4, u0Y, { stroke: SUPPLY, sw: 0.5 }));
          g.push(line(rx + rw - post - 0.4, u0Y - r.totalU * uMm, rx + rw - post - 0.4, u0Y, { stroke: RETURN, sw: 0.5 }));
        }
      }
    }
    // run labels (inside the run, on a paper plate, only when the run is tall enough)
    for (const run of runsOf(r.units)) {
      const hgt = (run.uEnd - run.uStart + 1) * uMm;
      if (hgt < 2.6 || run.units[0].category === 'blank' && hgt < 6) continue;
      const [l1, l2] = runLabelLines(run, r.unit, L);
      const lines2 = l2 && run.uEnd - run.uStart + 1 >= 4 && hgt >= 5.6 ? [l1, l2] : [l1];
      const labs = lines2.map((t) => fitText(t, 1.8, iw - 1.5));
      const ly = u0Y - ((run.uStart - 1 + run.uEnd) / 2) * uMm;
      const tw = Math.min(iw - 1, Math.max(...labs.map((t) => textWidth(t, 1.8))) + 1);
      const ph = 2.5 * labs.length;
      g.push(rect(ix + (iw - tw) / 2, ly - ph / 2, tw, ph, { fill: PAPER, opacity: 0.88 }));
      labs.forEach((t, k) => g.push(text(ix + iw / 2, ly - ph / 2 + 1.9 + k * 2.5, t, { size: 1.8, anchor: 'middle', fill: k === 0 ? INK : INK_SOFT })));
    }
    // inlet sensors (front) / exhaust (rear), right gutter
    const bx = rx + rw + 5.2;
    const bwd = GUTTER_R - 6;
    if (o.face === 'front') {
      for (const sn of r.sensors) {
        const sy = floorY - sn.heightM * s;
        const has = sn.valueC !== undefined;
        g.push(rect(bx, sy - 1.6, bwd, 3.2, { fill: PAPER, stroke: has ? STATUS_COLOR[sn.status] : LINE_LIGHT, sw: has ? 0.45 : 0.2, ...(sn.state === 'stale' ? { dash: '0.6 0.4' } : {}) }, 0.8));
        g.push(text(bx + bwd / 2, sy + 0.65, has ? `${f1(sn.valueC!)}°` : fitText(S.noSimShort, 1.8, bwd - 0.6), { size: 1.8, anchor: 'middle', fill: has ? INK : INK_SOFT }));
        g.push(line(rx + rw + 3.8, sy, bx, sy, { stroke: LINE_LIGHT, sw: 0.1 }));
      }
    } else if (r.exhaustC !== undefined) {
      const sy = floorY - 1.9 * s;
      g.push(rect(bx, sy - 1.6, bwd, 3.2, { fill: PAPER, stroke: INK_SOFT, sw: 0.3 }, 0.8));
      g.push(text(bx + bwd / 2, sy + 0.65, `${f1(r.exhaustC)}°`, { size: 1.8, anchor: 'middle', fill: INK }));
    }
    // position under the rack
    g.push(text(rx + rw / 2, floorY + 3, `#${r.rack.position}`, { size: 1.8, anchor: 'middle', fill: INK_SOFT }));
    g.push('</g>');
    out.push(g.join(''));
  });
  const w = order.length * o.pitch;
  out.push(line(x, floorY, x + w, floorY, { stroke: INK, sw: 0.3 }));
  return { svg: out.join(''), defs, w, h: floorY - y + 4.5 };
}

/** Small key plan: hall outline, all racks light, this row dark, eye arrow on the viewing side. */
export function drawRowKeyPlan(project: Project, g: RackRowGroup, face: RackFace, x: number, y: number, w: number, h: number, L: Locale): string {
  const hall = project.halls.find((hh) => hh.id === g.hallId);
  if (!hall || !(hall.width > 0) || !(hall.depth > 0)) return '';
  const S = rackElevationStrings(L);
  const s = Math.min((w - 4) / hall.width, (h - 7) / hall.depth);
  const ox = x + (w - hall.width * s) / 2;
  const oy = y + 5 + (h - 7 - hall.depth * s) / 2;
  const o: string[] = [rect(x, y, w, h, { fill: PAPER, stroke: INK_SOFT, sw: 0.2 }), text(x + 1.5, y + 3.2, S.keyPlan, { size: 1.8, fill: INK_SOFT })];
  o.push(rect(ox, oy, hall.width * s, hall.depth * s, { fill: '#f3f4f5', stroke: INK, sw: 0.25 }));
  const mine = new Set(g.racks.map((r) => r.rack.id));
  // plan y grows downward on paper: paper y = oy + (depth − y)·s
  for (const e of project.equipment) {
    if (e.hallId !== hall.id || !e.rowId && !e.podId) continue;
    const px = ox + e.position.x * s;
    const py = oy + (hall.depth - e.position.y) * s;
    o.push(rect(px - 0.35, py - 0.35, 0.7, 0.7, { fill: mine.has(e.id) ? INK : '#c3c7cb' }));
  }
  // eye marker on the viewing side of the row
  const xs = g.racks.map((r) => r.rack.x);
  const ys = g.racks.map((r) => r.rack.y);
  const mx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const my = (Math.min(...ys) + Math.max(...ys)) / 2;
  const dir = { '+Y': [0, 1], '-Y': [0, -1], '+X': [1, 0], '-X': [-1, 0] }[g.facing];
  const k = face === 'front' ? 1 : -1;
  const ex = ox + (mx + dir[0] * 2.2 * k) * s;
  const ey = oy + (hall.depth - (my + dir[1] * 2.2 * k)) * s;
  o.push(circle(ex, ey, 1.1, { fill: face === 'front' ? '#0f7c8c' : '#8a4b1f' }));
  o.push(line(ex, ey, ox + mx * s, oy + (hall.depth - my) * s, { stroke: face === 'front' ? '#0f7c8c' : '#8a4b1f', sw: 0.3 }));
  return o.join('');
}

/** Legend, notes and the row summary table below the band. */
export function drawRowFooter(racks: RackContents[], g: RackRowGroup, face: RackFace, x: number, y: number, w: number, h: number, L: Locale, hatchId: string): string {
  const S = rackElevationStrings(L);
  const o: string[] = [];
  // summary table (left 62 %)
  const tw = w * 0.62;
  const cols: [string, number][] = [[S.tag, 0.15], [S.model, 0.17], [S.uUsed, 0.08], [S.kw, 0.1], [S.capacity, 0.07], [S.weight, 0.11], [S.circuits, 0.14], [S.inlet, 0.1], [S.status, 0.08]];
  o.push(text(x, y + 3, S.summary, { size: 2.4, weight: 700, fill: INK }));
  let cx = x;
  const rowH = 3.6;
  const ty = y + 5;
  cols.forEach(([c, f]) => {
    o.push(text(cx + 0.8, ty + 2.7, fitText(c, 1.8, tw * f - 1.2), { size: 1.8, weight: 700, fill: INK }));
    cx += tw * f;
  });
  o.push(line(x, ty + rowH, x + tw, ty + rowH, { stroke: INK, sw: 0.2 }));
  const maxRows = Math.max(1, Math.floor((h - 10) / rowH) - 1);
  const list = (face === 'front' ? racks : [...racks].reverse()).slice(0, maxRows);
  list.forEach((r, i) => {
    const yy = ty + rowH * (i + 1);
    const inlet = r.sensors.map((sn) => (sn.valueC !== undefined ? f1(sn.valueC) : '—')).join(' / ');
    const cells = [r.rack.tag, `${r.rack.model} · ${r.totalU}${r.unit}`, `${r.usedU}/${r.totalU}`, `${f1(r.kwDesign)} / ${f1(r.kwPeak)}`, r.circuitBudgetKw !== undefined ? f1(r.circuitBudgetKw) : '—', `${f0(r.weightKg)} / ${r.ratedLoadKg ? f0(r.ratedLoadKg) : '—'}`, `${r.circuits.A?.label ?? '—'} / ${r.circuits.B?.label ?? '—'}`, inlet, ''];
    let c2 = x;
    cells.forEach((v, k) => {
      if (k === cells.length - 1) o.push(rect(c2 + 0.8, yy + 0.7, 2.4, 2.4, { fill: STATUS_COLOR[r.status.overall] }));
      else o.push(text(c2 + 0.8, yy + 2.7, fitText(v, 1.8, tw * cols[k][1] - 1.2), { size: 1.8, fill: INK }));
      c2 += tw * cols[k][1];
    });
    o.push(line(x, yy + rowH, x + tw, yy + rowH, { stroke: LINE_LIGHT, sw: 0.1 }));
  });
  // legend (right)
  const lx = x + tw + 6;
  const lw = w - tw - 6;
  o.push(text(lx, y + 3, S.legend, { size: 2.4, weight: 700, fill: INK }));
  const sw: [string, string, string?][] = [
    [SLOT_COLOR['compute-tray'], S.cat_compute], [SLOT_COLOR['scaleup-switch-tray'], S.cat_nvs], [SLOT_COLOR['power-shelf'], S.cat_power], [SLOT_COLOR.switch, S.cat_switch],
    [SLOT_COLOR['storage-shelf'], S.cat_storage], [SLOT_COLOR['cpu-server'], S.cat_server], [SLOT_COLOR['patch-panel'], S.cat_patch], [SLOT_COLOR.stiffener, S.cat_stiff],
    [`url(#${hatchId})`, S.lgBlank], [PAPER, S.lgReserved, '0.8 0.5'], [PDU_A, S.lgPduA], [PDU_B, S.lgPduB], ['#6b5b2e', S.lgBusbar], [SUPPLY, S.lgSupply], [RETURN, S.lgReturn],
  ];
  const colW = lw / 2;
  sw.forEach(([c, lab, dash], i) => {
    const col = i % 2;
    const rr = Math.floor(i / 2);
    const px = lx + col * colW;
    const py = y + 6 + rr * 3.8;
    o.push(rect(px, py, 5, 2.6, { fill: c, stroke: INK_SOFT, sw: 0.12, ...(dash ? { dash } : {}) }));
    o.push(text(px + 6.2, py + 2.1, fitText(lab, 1.8, colW - 7.5), { size: 1.8, fill: INK }));
  });
  let ly = y + 6 + Math.ceil(sw.length / 2) * 3.8 + 2;
  (['green', 'amber', 'red', 'grey'] as RackStatus[]).forEach((st, i) => o.push(rect(lx + i * 6, ly, 5, 2.6, { fill: STATUS_COLOR[st] })));
  o.push(text(lx + 25, ly + 2.1, fitText(fmt(S.lgStatus, { s1: SPACE_THRESHOLDS.amber * 100, s2: SPACE_THRESHOLDS.red * 100, p1: 90, w1: WEIGHT_THRESHOLDS.amber * 100 }), 1.8, lw - 26), { size: 1.8, fill: INK }));
  ly += 4.2;
  o.push(rect(lx, ly, 5, 2.6, { fill: PAPER, stroke: LINE_LIGHT, sw: 0.2 }, 0.6));
  o.push(text(lx + 6.2, ly + 2.1, fitText(S.lgSensor, 1.8, lw - 7.5), { size: 1.8, fill: INK }));
  ly += 6;
  // notes
  o.push(text(lx, ly + 2, S.notes, { size: 2.4, weight: 700, fill: INK }));
  const th = racks[0]?.thermal;
  const thermalNote = !th || th.state === 'none' ? S.thermalNone : th.state === 'stale' ? fmt(S.thermalStale, { at: th.at ?? '' }) : fmt(S.thermalSim, { at: th.at ?? '' });
  const sources = [...new Set(racks.map((r) => `${r.rack.model}: ${deviceWords(L, r.note)}`))];
  const notes = [S.n1, S.n2, S.n3, S.n4, thermalNote, `${face === 'front' ? S.frontView : S.rearView} (${g.facing})`, ...sources.map((t) => `${S.src} — ${t}`)];
  let ny = ly + 5.5;
  for (const n of notes) {
    // wrap to the legend width
    const words = n.split(' ');
    let cur = '';
    for (const wd of words) {
      const next = cur ? `${cur} ${wd}` : wd;
      if (textWidth(next, 1.8) > lw - 2 && cur) {
        if (ny < y + h - 1) o.push(text(lx, ny, cur, { size: 1.8, fill: INK_SOFT }));
        ny += 2.7;
        cur = wd;
      } else cur = next;
    }
    if (cur && ny < y + h - 1) o.push(text(lx, ny, cur, { size: 1.8, fill: INK_SOFT }));
    ny += 3.2;
  }
  return o.join('');
}

export const INLET_LIMITS_C = INLET_RECOMMENDED_C;
