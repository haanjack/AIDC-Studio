/// <reference lib="webworker" />
import { resolveCatalog, setActiveCatalog } from '@aidc/core';
import { adoptDocsInput, runDocsJob, type DocsWorkerRequest, type DocsWorkerResponse } from '../app/docsJobs.ts';

/**
 * Docs deliverables worker (integration v2 2차): deployment bundle, NOS configs, test kit and offline export ZIPs off the UI thread.
 * Same pattern as fit.worker.ts — the worker has its own core module instance, so the project's catalog is activated per project.
 */
const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = async (ev: MessageEvent<DocsWorkerRequest>) => {
  const msg = ev.data;
  try {
    if (adoptDocsInput(msg) && msg.project) setActiveCatalog(resolveCatalog(msg.project, msg.library ?? null));
    const r = await runDocsJob(msg);
    ctx.postMessage({ id: msg.id, ...r } satisfies DocsWorkerResponse);
  } catch (e) {
    ctx.postMessage({ id: msg.id, type: 'error', message: (e as Error).message } satisfies DocsWorkerResponse);
  }
};
