/// <reference lib="webworker" />
import { resolveCatalog, setActiveCatalog } from '@aidc/core';
import { handleThermalWorkerMessage, type ThermalWorkerRequest } from '@aidc/thermal';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (ev: MessageEvent<ThermalWorkerRequest>) => {
  // the worker has its own module instance of core → activate the project's effective catalog when a job arrives
  // (the library layer is posted with the job: a fresh worker module has nothing activated, so builtin ∪ library ∪ project)
  if (ev.data.type === 'run') setActiveCatalog(resolveCatalog(ev.data.project, ev.data.library ?? null));
  // T4: ThermalOptions.inRowCoolers / rdhx / sidecars / roomCoolers (cooling-topology variants built on the main thread
  // by buildThermalVariant) arrive in ev.data.options and are passed through unchanged — they are plain structured-clone data.
  if (ev.data.type === 'run' && !Array.isArray(ev.data.options.inRowCoolers ?? [])) {
    ctx.postMessage({ type: 'error', jobId: ev.data.jobId, message: 'thermal: options.inRowCoolers must be an array' });
    return;
  }
  handleThermalWorkerMessage(ev.data, (msg, transfer) => ctx.postMessage(msg, transfer ?? []));
};
