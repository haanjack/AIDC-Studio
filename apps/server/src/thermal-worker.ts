import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { resolveCatalog, setActiveCatalog, type CatalogLibrary, type Project } from '../../../packages/core/src/index.ts';

// Runs @aidc/thermal off the main event loop. Messages: progress | done | not-ready | error.
const { project, options, modulePath, library } = workerData as { project: unknown; options: unknown; modulePath: string; library?: CatalogLibrary | null };

async function main() {
  // the worker has its own module instance of core → activate the project's effective catalog here
  setActiveCatalog(resolveCatalog(project as Project, library ?? undefined));
  const mod = (await import(pathToFileURL(modulePath).href)) as Record<string, unknown>;
  const run = mod.runThermal;
  if (typeof run !== 'function') {
    parentPort!.postMessage({ type: 'not-ready' });
    return;
  }
  let last = 0;
  const result = await (run as (p: unknown, o: unknown, h: unknown) => Promise<unknown>)(project, options, {
    onProgress: (p: { step?: number; residual?: number } | undefined) => {
      const now = Date.now();
      if (now - last > 1000) {
        last = now;
        parentPort!.postMessage({ type: 'progress', step: p?.step, residual: p?.residual });
      }
    },
  });
  parentPort!.postMessage({ type: 'done', result });
}

main().catch((e: unknown) => parentPort!.postMessage({ type: 'error', message: e instanceof Error ? e.message : String(e) }));
