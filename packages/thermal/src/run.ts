import type { Project } from '../../core/src/index.ts';
import { buildThermalCase } from './case.ts';
import { ThermalSolver } from './solver.ts';
import type { ThermalMetrics, ThermalOptions, ThermalResult, ThermalWorkerRequest, ThermalWorkerResponse } from './types.ts';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const yieldTick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Budget of solver work between event-loop yields (ms). */
const CHUNK_MS = 50;

export async function runThermal(
  project: Project,
  options: ThermalOptions,
  hooks: { onProgress?: (m: ThermalMetrics, snapshot?: ThermalResult) => void; snapshotEvery?: number; signal?: AbortSignal } = {},
): Promise<ThermalResult> {
  const solver = new ThermalSolver(buildThermalCase(project, options));
  const maxSteps = options.maxSteps ?? 600;
  const snapshotEvery = hooks.snapshotEvery ?? 0;
  let lastSnapshotStep = 0;
  let chunkStart = now();
  let metrics: ThermalMetrics | undefined;
  while (solver.steps < maxSteps && !solver.isConverged) {
    if (hooks.signal?.aborted) throw new Error('aborted');
    metrics = solver.step(1);
    if (now() - chunkStart >= CHUNK_MS) {
      if (hooks.onProgress) {
        let snap: ThermalResult | undefined;
        if (snapshotEvery > 0 && solver.steps - lastSnapshotStep >= snapshotEvery) {
          snap = solver.snapshot();
          lastSnapshotStep = solver.steps;
        }
        hooks.onProgress(snap ? snap.metrics : metrics, snap);
      }
      await yieldTick();
      chunkStart = now();
    }
  }
  if (hooks.signal?.aborted) throw new Error('aborted');
  return solver.snapshot();
}

function transferables(r: ThermalResult): Transferable[] {
  return [r.temperature.buffer, r.velocity.buffer, r.solid.buffer] as Transferable[];
}

const jobs = new Map<string, AbortController>();

/**
 * Web Worker message handler:
 *   self.onmessage = (e) => handleThermalWorkerMessage(e.data, (m, t) => self.postMessage(m, { transfer: t ?? [] }));
 */
export function handleThermalWorkerMessage(req: ThermalWorkerRequest, post: (msg: ThermalWorkerResponse, transfer?: Transferable[]) => void): void {
  if (req.type === 'cancel') {
    jobs.get(req.jobId)?.abort();
    return;
  }
  if (req.type !== 'run') return;
  const controller = new AbortController();
  jobs.get(req.jobId)?.abort();
  jobs.set(req.jobId, controller);
  const { jobId } = req;
  void (async () => {
    try {
      const result = await runThermal(req.project, req.options, {
        snapshotEvery: req.snapshotEvery,
        signal: controller.signal,
        onProgress: (metrics, snapshot) => post({ type: 'progress', jobId, metrics, snapshot }, snapshot ? transferables(snapshot) : undefined),
      });
      post({ type: 'done', jobId, result }, transferables(result));
    } catch (e) {
      const message = controller.signal.aborted ? 'cancelled' : e instanceof Error ? e.message : String(e);
      post({ type: 'error', jobId, message });
    } finally {
      if (jobs.get(jobId) === controller) jobs.delete(jobId);
    }
  })();
}
