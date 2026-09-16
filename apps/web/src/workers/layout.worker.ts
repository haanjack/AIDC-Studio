/// <reference lib="webworker" />
import { autoSizeHall, resolveCatalog, setActiveCatalog, type AutoSizeRequest, type AutoSizeResult, type CatalogLibrary, type Project } from '@aidc/core';

/**
 * Layout worker (stream T4 #8): runs the engine-verified hall generation (`autoSizeHall`) off the UI thread. A 16-DU hall takes
 * up to ~9 s, which froze the panel when it ran on the main thread. Same pattern as fit.worker.ts: the worker has its own module
 * instance of core, so the project's effective catalog is activated per job. Cancel = the panel terminates the worker (the
 * posted project is a copy, so nothing is applied).
 */
export interface LayoutWorkerRun {
  type: 'run';
  id: number;
  /** a copy of the project; the worker mutates and returns it */
  project: Project;
  hallId: string;
  req: AutoSizeRequest;
  library?: CatalogLibrary | null;
}
export type LayoutWorkerRequest = LayoutWorkerRun;
export type LayoutWorkerResponse =
  | { type: 'progress'; id: number; phase: 'catalog' | 'generate' | 'done'; ms: number }
  | { type: 'done'; id: number; result: AutoSizeResult; project: Project; ms: number }
  | { type: 'error'; id: number; message: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (ev: MessageEvent<LayoutWorkerRequest>) => {
  const msg = ev.data;
  if (msg.type !== 'run') return;
  const t0 = performance.now();
  const progress = (phase: 'catalog' | 'generate' | 'done') => ctx.postMessage({ type: 'progress', id: msg.id, phase, ms: performance.now() - t0 } satisfies LayoutWorkerResponse);
  try {
    progress('catalog');
    setActiveCatalog(resolveCatalog(msg.project, msg.library ?? null));
    progress('generate');
    const result = autoSizeHall(msg.project, msg.hallId, msg.req);
    progress('done');
    ctx.postMessage({ type: 'done', id: msg.id, result, project: msg.project, ms: performance.now() - t0 } satisfies LayoutWorkerResponse);
  } catch (e) {
    ctx.postMessage({ type: 'error', id: msg.id, message: (e as Error).message } satisfies LayoutWorkerResponse);
  }
};
