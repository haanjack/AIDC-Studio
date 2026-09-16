/// <reference lib="webworker" />
import { fitToSpace, resolveCatalog, setActiveCatalog, type CatalogLibrary, type FitCandidate, type FitOptions, type Project } from '@aidc/core';

/**
 * Fit-to-space worker (stream S1): runs `fitToSpace` off the UI thread. Same pattern as thermal.worker.ts — the
 * worker has its own module instance of core, so the project's effective catalog is activated per job.
 */
export interface FitWorkerRun {
  type: 'run';
  id: number;
  project: Project;
  hallId: string;
  opts: Omit<FitOptions, 'onProgress'>;
  /** server / web catalog library (builtin ∪ library ∪ project in the worker's own core instance) */
  library?: CatalogLibrary | null;
}
export type FitWorkerRequest = FitWorkerRun | { type: 'cancel'; id: number };
export type FitWorkerResponse =
  | { type: 'progress'; id: number; done: number; total: number }
  | { type: 'done'; id: number; candidates: FitCandidate[]; ms: number }
  | { type: 'error'; id: number; message: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (ev: MessageEvent<FitWorkerRequest>) => {
  const msg = ev.data;
  if (msg.type !== 'run') return;
  const t0 = performance.now();
  try {
    setActiveCatalog(resolveCatalog(msg.project, msg.library ?? null));
    const hall = msg.project.halls.find((h) => h.id === msg.hallId);
    if (!hall) throw new Error(`hall ${msg.hallId} not found`);
    const candidates = fitToSpace(msg.project, hall, {
      ...msg.opts,
      onProgress: (done, total) => ctx.postMessage({ type: 'progress', id: msg.id, done, total } satisfies FitWorkerResponse),
    });
    ctx.postMessage({ type: 'done', id: msg.id, candidates, ms: performance.now() - t0 } satisfies FitWorkerResponse);
  } catch (e) {
    ctx.postMessage({ type: 'error', id: msg.id, message: (e as Error).message } satisfies FitWorkerResponse);
  }
};
