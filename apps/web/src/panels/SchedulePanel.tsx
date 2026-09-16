import { computeCountsByPod, findCatalogItem, type DeploymentWave, type ScheduleSettings } from '@aidc/core';
import { useApp } from '../store/appStore.ts';
import { daysBetween, fmtDate, fmtInt, fmtPower } from '../app/format.ts';
import { LineChart } from '../ui/charts.tsx';
import { DataTable, Empty, NumberField, StatusLabel, Stat, TextField } from '../ui/controls.tsx';
import { Gantt } from '../ui/diagrams.tsx';
import { Term } from '../ui/Term.tsx';
import { useT } from '../i18n/index.ts';

export function SchedulePanel() {
  const project = useApp((s) => s.project);
  const analysis = useApp((s) => s.analysis);
  const update = useApp((s) => s.update);
  const sch = project.schedule;
  const sa = analysis?.schedule;
  const tr = useT();
  const set = <K extends keyof ScheduleSettings>(k: K, v: ScheduleSettings[K]) => update((d) => { d.schedule[k] = v; });
  const setCrew = (k: keyof ScheduleSettings['crews'], v: number) => update((d) => { d.schedule.crews[k] = v; });

  // stream T4 (#6): GPU and accelerator-slot chip counts per DU from catalog data (accelerator-slot racks are not GPUs)
  const countsByPod = computeCountsByPod(project.equipment, findCatalogItem);
  const hasAccelerators = [...countsByPod.values()].some((c) => c.accelerators > 0);

  return (
    <div className="grid-auto">
      <div className="card">
        <h3>{tr('schedule.settings.title')}</h3>
        <TextField type="date" label={tr('schedule.settings.start')} value={sch.projectStart} onChange={(v) => set('projectStart', v)} />
        <NumberField label={tr('schedule.settings.workDays')} min={4} max={7} value={sch.workDaysPerWeek} onChange={(v) => set('workDaysPerWeek', Math.round(v))} />
        <NumberField label={tr('schedule.settings.hoursPerDay')} min={6} max={24} value={sch.hoursPerDay} onChange={(v) => set('hoursPerDay', v)} />
        <NumberField label={tr('schedule.settings.crewSize')} min={2} value={sch.crewSize} onChange={(v) => set('crewSize', Math.round(v))} />
        <div className="section-title">{tr('schedule.settings.crews')}</div>
        <div className="fields-2">
          <NumberField label={tr('schedule.crew.electrical')} min={1} value={sch.crews.electrical} onChange={(v) => setCrew('electrical', Math.round(v))} />
          <NumberField label={tr('schedule.crew.mechanical')} min={1} value={sch.crews.mechanical} onChange={(v) => setCrew('mechanical', Math.round(v))} />
          <NumberField label={tr('schedule.crew.rackAndStack')} min={1} value={sch.crews.rackAndStack} onChange={(v) => setCrew('rackAndStack', Math.round(v))} />
          <NumberField label={tr('schedule.crew.cabling')} min={1} value={sch.crews.cabling} onChange={(v) => setCrew('cabling', Math.round(v))} />
          <NumberField label={tr('schedule.crew.commissioning')} min={1} value={sch.crews.commissioning} onChange={(v) => setCrew('commissioning', Math.round(v))} />
        </div>
      </div>

      <div className="card">
        <h3><Term id="wave">{tr('schedule.waves.title')}</Term></h3>
        <DataTable
          columns={[
            { key: 'n', header: tr('schedule.waves.col.wave'), render: (w: DeploymentWave) => <input type="text" defaultValue={w.name} onBlur={(e) => update((d) => { d.schedule.waves.find((x) => x.id === w.id)!.name = e.target.value; })} /> },
            { key: 'p', header: <Term id="du">DU</Term>, render: (w) => w.podIds.map((p) => p.replace('pod-', 'DU')).join(', ') || '—' },
            { key: 'g', header: 'GPU', num: true, render: (w) => fmtInt(w.podIds.reduce((a, p) => a + (countsByPod.get(p)?.gpus ?? 0), 0)) },
            ...(hasAccelerators ? [{ key: 'acc', header: <span title={tr('schedule.waves.col.acceleratorsTip')}>{tr('schedule.waves.col.accelerators')}</span>, num: true, render: (w: DeploymentWave) => fmtInt(w.podIds.reduce((a, p) => a + (countsByPod.get(p)?.accelerators ?? 0), 0)) }] : []),
            { key: 't', header: tr('schedule.waves.col.target'), render: (w) => <input type="date" value={w.targetReadyDate ?? ''} onChange={(e) => update((d) => { d.schedule.waves.find((x) => x.id === w.id)!.targetReadyDate = e.target.value || undefined; })} /> },
            {
              key: 'st', header: tr('schedule.waves.col.forecast'), render: (w) => {
                const m = sa?.milestones.find((x) => x.id.includes(w.id));
                if (!m) return '–';
                if (!w.targetReadyDate) return fmtDate(m.date);
                const late = daysBetween(w.targetReadyDate, m.date);
                return <StatusLabel severity={late > 0 ? 'warning' : 'good'}>{fmtDate(m.date)}{late > 0 ? ` ${tr('schedule.waves.late', { n: late })}` : ''}</StatusLabel>;
              },
            },
          ]}
          rows={sch.waves}
          rowKey={(w) => w.id}
        />
        {sa && (
          <div className="grid-3" style={{ marginTop: 10 }}>
            <Stat label={<Term id="rfs">{tr('schedule.stat.rfs')}</Term>} value={fmtDate(sa.readyForServiceDate)} delta={tr('schedule.stat.months', { n: Math.round(daysBetween(sch.projectStart, sa.readyForServiceDate) / 30.44) })} />
            <Stat label={tr('schedule.stat.laborHours')} value={fmtInt(sa.totalLaborHours)} delta={tr('schedule.stat.tasks', { n: sa.tasks.length })} />
            <Stat label={<Term id="critical-path">{tr('schedule.stat.criticalTasks')}</Term>} value={fmtInt(sa.tasks.filter((t) => t.critical).length)} />
          </div>
        )}
      </div>

      {!sa ? (
        <Empty>{tr('schedule.empty')}</Empty>
      ) : (
        <>
          <div className="card" style={{ gridColumn: '1 / -1' }}>
            <h3>{tr('schedule.gantt.title')} — <Term id="lead-time">{tr('schedule.gantt.leadTime')}</Term> · <Term id="critical-path">{tr('schedule.gantt.criticalPath')}</Term></h3>
            <Gantt schedule={sa} />
          </div>
          <div className="card">
            <LineChart
              title={tr('schedule.ramp.title')}
              series={[{ key: 'g', name: 'GPU', points: sa.capacityRamp.map((r) => ({ x: Date.parse(r.date), y: r.gpus })) }]}
              height={200} step area xFormat={(v) => new Date(v).toISOString().slice(2, 7).replace('-', '.')} yFormat={(v) => fmtInt(v)} yMin={0}
            />
          </div>
          <div className="card">
            <h3>{tr('schedule.milestones.title')}</h3>
            <DataTable
              columns={[
                { key: 'n', header: tr('schedule.milestones.col.milestone'), render: (m: (typeof sa.milestones)[number]) => m.name },
                { key: 'd', header: tr('schedule.milestones.col.date'), render: (m) => fmtDate(m.date), sortValue: (m) => m.date },
                { key: 'k', header: 'IT', num: true, render: (m) => { const r = sa.capacityRamp.find((x) => x.date === m.date); return r ? fmtPower(r.itKW) : '–'; } },
              ]}
              rows={sa.milestones}
              rowKey={(m) => m.id}
              initialSort={{ key: 'd', dir: 1 }}
            />
          </div>
        </>
      )}
    </div>
  );
}
