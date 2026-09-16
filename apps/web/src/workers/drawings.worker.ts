/// <reference lib="webworker" />
import { buildSheet, cancelZip, openSheets, sessionKey, zipSheets, type DrawingsWorkerRequest, type DrawingsWorkerResponse } from '../panels/drawings/sheetJobs.ts';

/**
 * Drawing sheets worker (r4 stream D): list once per project generation, build sheets lazily by id (the panel asks for
 * the selected sheet ± 2 neighbours; a newer 'want' replaces the queue, so the selection always builds first), ZIP a
 * filtered set with progress. Results carry the generation key; the panel discards stale ones.
 */
const ctx = self as unknown as DedicatedWorkerGlobalScope;
const post = (m: DrawingsWorkerResponse) => ctx.postMessage(m);

let queue: string[] = [];
let queueKey = '';
let pumping = false;

function pump() {
  if (pumping) return;
  pumping = true;
  setTimeout(() => {
    pumping = false;
    const id = queue.shift();
    if (id === undefined) return;
    const key = queueKey;
    if (key !== sessionKey()) {
      queue = [];
      return;
    }
    try {
      const { sheet, ms } = buildSheet(key, id);
      post({ type: 'sheet', key, id, sheet, ms });
    } catch (e) {
      post({ type: 'sheet-error', key, id, message: (e as Error).message });
    }
    if (queue.length) pump();
  }, 0);
}

ctx.onmessage = (ev: MessageEvent<DrawingsWorkerRequest>) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'open': {
      queue = [];
      try {
        const { sheets, ms } = openSheets(msg, true);
        post({ type: 'list', key: msg.key, sheets, ms });
      } catch (e) {
        post({ type: 'list-error', key: msg.key, message: (e as Error).message });
      }
      return;
    }
    case 'want':
      queueKey = msg.key;
      queue = [...msg.ids];
      pump();
      return;
    case 'zip':
      void zipSheets(msg.key, msg.jobId, msg.ids, msg.projectId, msg.projectName, (done, total) => post({ type: 'zip-progress', jobId: msg.jobId, done, total }))
        .then(({ blob, files }) => post({ type: 'zip', jobId: msg.jobId, blob, files }))
        .catch((e: Error) => post({ type: 'zip-error', jobId: msg.jobId, message: e.message }));
      return;
    case 'cancel-zip':
      cancelZip(msg.jobId);
      return;
  }
};
