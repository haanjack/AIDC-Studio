// Deployment schedule gantt as inline SVG (replaces the mermaid `gantt`). Rows grouped by phase (fixed phase →
// colour slot order, phase names printed as group headers so colour is never the only cue), critical-path tasks
// outlined in ink, milestones as diamonds on their own labelled rows, month / quarter axis. Every bar has a <title>
// hover with dates and duration; the same data is tabulated in chapter 10.
import type { Locale, ScheduleAnalysis, ScheduleTask } from '../../model/types.ts';
import { BAND, INK, INK2, RULE, SERIES, box, c, fit, legendItem, line, svgRoot, text } from './common.ts';

export const GANTT_PHASES: ScheduleTask['phase'][] = ['procurement', 'site', 'power', 'cooling', 'it', 'network', 'commissioning', 'handover'];

export interface GanttSvgOptions {
  locale?: Locale;
  title?: string;
  phaseLabel?: (phase: ScheduleTask['phase']) => string;
}

const day = (iso: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86_400_000 : NaN;
};
const isoOfDay = (d: number) => new Date(d * 86_400_000).toISOString().slice(0, 10);

export function scheduleGanttSvg(schedule: ScheduleAnalysis, opts: GanttSvgOptions = {}): string {
  const L: Locale = opts.locale ?? 'en';
  const title = opts.title ?? (L === 'ko' ? '배포 일정' : 'Deployment schedule');
  const T = L === 'ko' ? { critical: '핵심 경로', milestone: '마일스톤', days: '일', none: '일정 데이터 없음' } : { critical: 'critical path', milestone: 'milestone', days: 'd', none: 'No schedule data' };
  const tasks = schedule.tasks.filter((t) => Number.isFinite(day(t.start)) && Number.isFinite(day(t.end)));
  if (!tasks.length) return svgRoot(480, 60, title, [text(16, 34, T.none, { fill: INK2 })]);
  const phaseLabel = opts.phaseLabel ?? ((p) => p);
  const ms = schedule.milestones.filter((m) => Number.isFinite(day(m.date)));
  const d0 = Math.min(...tasks.map((t) => day(t.start)), ...ms.map((m) => day(m.date)));
  const d1 = Math.max(...tasks.map((t) => day(t.end)), ...ms.map((m) => day(m.date)));
  // axis from the first of the start month to the first of the month after the end
  const s = new Date(d0 * 86_400_000), e = new Date(d1 * 86_400_000);
  const a0 = Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), 1) / 86_400_000;
  const a1 = Date.UTC(e.getUTCFullYear(), e.getUTCMonth() + 1, 1) / 86_400_000;
  const months: number[] = [];
  for (let y = s.getUTCFullYear(), mo = s.getUTCMonth(); ; mo++) {
    const d = Date.UTC(y, mo, 1) / 86_400_000;
    if (d > a1) break;
    months.push(d);
  }
  const quarterly = months.length > 30;

  const LABEL_W = 250, CHART_W = 700, M = 14, ROW = 17, HEAD = 18, TOP = 62;
  const phases = GANTT_PHASES.filter((p) => tasks.some((t) => t.phase === p));
  const rowsCount = phases.reduce((n, p) => n + 1 + tasks.filter((t) => t.phase === p).length, 0) + (ms.length ? 1 + ms.length : 0);
  const width = M * 2 + LABEL_W + CHART_W;
  const height = TOP + rowsCount * ROW + phases.length * (HEAD - ROW) + (ms.length ? HEAD - ROW : 0) + M + 6;
  const X0 = M + LABEL_W;
  const sx = (d: number) => X0 + ((d - a0) / Math.max(1, a1 - a0)) * CHART_W;
  const body: string[] = [];

  // legend (phases in fixed order + critical outline + milestone)
  let lx = M;
  let ly = 18;
  const legend = (color: string, label: string, kind: 'rect' | 'outline' | 'diamond') => {
    let [m, w] = legendItem(lx, ly, color, label, kind);
    if (lx + w > width - M && lx > M) {
      lx = M;
      ly += 16;
      [m, w] = legendItem(lx, ly, color, label, kind);
    }
    body.push(m);
    lx += w;
  };
  for (const p of phases) legend(SERIES[GANTT_PHASES.indexOf(p)], phaseLabel(p), 'rect');
  legend(INK, T.critical, 'outline');
  if (ms.length) legend(INK2, T.milestone, 'diamond');

  // axis + grid
  const axisY = TOP - 8;
  months.forEach((d, i) => {
    const date = new Date(d * 86_400_000);
    const isQ = date.getUTCMonth() % 3 === 0;
    if (quarterly && !isQ) return;
    const x = sx(d);
    body.push(line(x, axisY + 2, x, height - M, i === 0 ? INK2 : RULE, isQ ? 0.8 : 0.4));
    if (x < X0 + CHART_W - 20) {
      const label = quarterly ? `${date.getUTCFullYear()} Q${Math.floor(date.getUTCMonth() / 3) + 1}` : isQ || months.length <= 14 ? `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}` : String(date.getUTCMonth() + 1).padStart(2, '0');
      body.push(text(x + 2, axisY, label, { size: 9, fill: INK2 }));
    }
  });

  let y = TOP;
  for (const p of phases) {
    const color = SERIES[GANTT_PHASES.indexOf(p)];
    body.push(box(M, y, width - 2 * M, HEAD - 2, { fill: BAND }));
    body.push(box(M, y, 4, HEAD - 2, { fill: color }));
    body.push(text(M + 10, y + 12, phaseLabel(p), { size: 10.5, weight: 700 }));
    y += HEAD;
    for (const t of tasks.filter((x) => x.phase === p)) {
      const x1 = sx(day(t.start));
      const x2 = Math.max(x1 + 2, sx(day(t.end)));
      const tip = `${t.name} · ${t.start} → ${t.end} · ${t.durationDays} ${T.days}${t.critical ? ` · ${T.critical}` : ''}`;
      body.push(text(M + 12, y + 11.5, fit(t.name, 9.5, LABEL_W - 20), { size: 9.5, fill: t.critical ? INK : INK2, weight: t.critical ? 600 : undefined }));
      body.push(box(x1, y + 3, x2 - x1, ROW - 7, { fill: color, stroke: t.critical ? INK : 'rgba(0,0,0,0.25)', sw: t.critical ? 1.6 : 0.6, rx: 2, title: tip }));
      y += ROW;
    }
  }
  if (ms.length) {
    body.push(box(M, y, width - 2 * M, HEAD - 2, { fill: BAND }));
    body.push(text(M + 10, y + 12, L === 'ko' ? '마일스톤' : 'Milestones', { size: 10.5, weight: 700 }));
    y += HEAD;
    for (const m of [...ms].sort((a, b) => day(a.date) - day(b.date) || a.name.localeCompare(b.name))) {
      const x = sx(day(m.date));
      const cy = y + ROW / 2;
      body.push(text(M + 12, y + 11.5, fit(`${m.name} (${isoOfDay(day(m.date))})`, 9.5, LABEL_W - 20), { size: 9.5, fill: INK2 }));
      body.push(line(X0, cy, x, cy, RULE, 0.5, '2 2'));
      body.push(`<path d="M${c(x)} ${c(cy - 6)} L${c(x + 6)} ${c(cy)} L${c(x)} ${c(cy + 6)} L${c(x - 6)} ${c(cy)} Z" fill="${INK2}" stroke="${INK}" stroke-width="0.8"><title>${m.name} · ${m.date}</title></path>`);
      y += ROW;
    }
  }
  return svgRoot(width, height, title, body);
}
