/**
 * Thermal solver benchmark on the reference hall.
 *
 *   npx tsx packages/thermal/scripts/run-reference.ts            # full run
 *   npx tsx packages/thermal/scripts/run-reference.ts --quick    # skip 0.2 m and the no-containment case
 *
 * Runs createNvidiaReferenceProject() hall-a (GB300 NVL72 rack-scale DUs, ducted hot-aisle containment) at several cell sizes /
 * load factors and prints convergence, timing and the standard air-management metrics. No third-party CFD data is used.
 */
import { createNvidiaReferenceProject, type Project } from '../../core/src/index.ts';
import { runThermal, zoneStats, type ThermalOptions } from '../src/index.ts';

const args = new Set(process.argv.slice(2));

const f1 = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : '—');
const f2 = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : '—');

async function timed(project: Project, options: ThermalOptions) {
  const t0 = performance.now();
  const r = await runThermal(project, options);
  return { r, seconds: (performance.now() - t0) / 1000 };
}

async function referenceHall() {
  const { project, pods } = createNvidiaReferenceProject();
  const hall = project.halls.find((h) => h.id === 'hall-a')!;
  const du01 = pods.find((p) => p.id === 'pod-01')!;
  const hac = project.containments.find((c) => c.podId === 'pod-01')!;
  const runs: { label: string; options: ThermalOptions }[] = [
    { label: '0.3 m · LF 1.0 · HAC', options: { hallId: 'hall-a', cellSize: 0.3, loadFactor: 1 } },
    { label: '0.3 m · LF 0.4 · HAC', options: { hallId: 'hall-a', cellSize: 0.3, loadFactor: 0.4 } },
  ];
  if (!args.has('--quick')) {
    runs.push({ label: '0.3 m · LF 1.0 · no containment', options: { hallId: 'hall-a', cellSize: 0.3, loadFactor: 1, overrides: { containment: 'none' } } });
    runs.push({ label: '0.2 m · LF 1.0 · HAC', options: { hallId: 'hall-a', cellSize: 0.2, loadFactor: 1 } });
  }
  console.log(`\n=== reference hall ${hall.width} × ${hall.depth} m, clear ${hall.clearHeight} m + plenum ${hall.ceilingPlenumHeight} m ===`);
  console.log('run | cells | steps | conv | ms/step | total s | maxInlet | avgInlet | RCI-HI | RTI | SHI | balance | DU01 hot aisle | plenum | cold aisle');
  for (const { label, options } of runs) {
    const { r, seconds } = await timed(project, options);
    const m = r.metrics;
    const hot = zoneStats(r, { x0: hac.rect.x + 1.5, x1: hac.rect.x + hac.rect.w - 1.5, y0: hac.rect.y, y1: hac.rect.y + hac.rect.d, z0: 0.3, z1: 2.2 });
    const plenum = zoneStats(r, { x0: du01.rect.x, x1: du01.rect.x + du01.rect.w, y0: du01.rect.y, y1: du01.rect.y + du01.rect.d, z0: hall.clearHeight, z1: hall.clearHeight + hall.ceilingPlenumHeight });
    const cold = zoneStats(r, { x0: du01.rect.x + 1.5, x1: du01.rect.x + du01.rect.w - 1.5, y0: du01.rect.y - 1.2, y1: du01.rect.y, z0: 0.3, z1: 2.0 });
    const cells = r.grid.nx * r.grid.ny * r.grid.nz;
    console.log(
      [
        label,
        cells,
        m.step,
        m.converged ? 'yes' : 'no',
        f1(m.elapsedMs / m.step),
        f1(seconds),
        f2(m.maxInletC),
        f2(m.avgInletC),
        f1(m.rciHi),
        f1(m.rti),
        m.shi.toFixed(3),
        `${(m.balanceError * 100).toFixed(2)}%`,
        f2(hot.avgC),
        f2(plenum.avgC),
        f2(cold.avgC),
      ].join(' | '),
    );
  }
}

await referenceHall();
