// r4 stream D — worker-backed sheet listing and lazy per-sheet SVG build for the Drawings panel.
// One generation per (project, analysis) identity: the list arrives first, sheets build on demand (selected ± 2), kept in an
// LRU of 12; results of an older generation are discarded. The previous generation's LRU stays readable as "stale" so the
// preview does not blank while the new generation builds. ZIP runs in the worker with progress.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CatalogLibrary, DrawingSheet, DrawingSheetMeta, Project, ProjectAnalysis } from '@aidc/core';
import { Lru, LRU_SIZE } from './model.ts';
import { buildSheet, cancelZip, openSheets, zipSheets, type DrawingsWorkerRequest, type DrawingsWorkerResponse } from './sheetJobs.ts';

type Listener = (m: DrawingsWorkerResponse) => void;

/** a worker when module workers are available, else the same jobs inline (async, one sheet per macrotask) */
function createTransport(onMessage: Listener): { post(m: DrawingsWorkerRequest): void; dispose(): void } {
  let worker: Worker | null = null;
  try {
    worker = new Worker(new URL('../../workers/drawings.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    worker = null;
  }
  let lastOpen: DrawingsWorkerRequest | null = null;
  let api: { post(m: DrawingsWorkerRequest): void; dispose(): void };
  if (worker) {
    const w = worker;
    w.onmessage = (ev: MessageEvent<DrawingsWorkerResponse>) => onMessage(ev.data);
    w.onerror = (e) => {
      console.warn('[drawings] worker failed, building inline:', e.message);
      w.terminate();
      worker = null;
      if (lastOpen) api.post(lastOpen);
    };
  }
  // inline fallback
  let queue: string[] = [];
  let queueKey = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pump = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      const id = queue.shift();
      if (id === undefined) return;
      try {
        const { sheet, ms } = buildSheet(queueKey, id);
        onMessage({ type: 'sheet', key: queueKey, id, sheet, ms });
      } catch (e) {
        onMessage({ type: 'sheet-error', key: queueKey, id, message: (e as Error).message });
      }
      if (queue.length) pump();
    }, 0);
  };
  api = {
    post(m) {
      if (m.type === 'open') lastOpen = m;
      if (worker) {
        worker.postMessage(m);
        return;
      }
      switch (m.type) {
        case 'open':
          queue = [];
          setTimeout(() => {
            try {
              const r = openSheets(m, false);
              onMessage({ type: 'list', key: m.key, ...r });
            } catch (e) {
              onMessage({ type: 'list-error', key: m.key, message: (e as Error).message });
            }
          }, 0);
          return;
        case 'want':
          queueKey = m.key;
          queue = [...m.ids];
          pump();
          return;
        case 'zip':
          void zipSheets(m.key, m.jobId, m.ids, m.projectId, m.projectName, (done, total) => onMessage({ type: 'zip-progress', jobId: m.jobId, done, total }))
            .then(({ blob, files }) => onMessage({ type: 'zip', jobId: m.jobId, blob, files }))
            .catch((e: Error) => onMessage({ type: 'zip-error', jobId: m.jobId, message: e.message }));
          return;
        case 'cancel-zip':
          // same cancel flag as the worker: the running zipSheets loop checks it between sheets (QA r4 panel: was a no-op inline)
          cancelZip(m.jobId);
          return;
      }
    },
    dispose() {
      worker?.terminate();
      worker = null;
      clearTimeout(timer);
    },
  };
  return api;
}

let generation = 0;
const keyOf = new WeakMap<object, WeakMap<object, string>>();
const NO_ANALYSIS = {};
/** stable generation key for an identity pair */
function generationKey(project: Project, analysis: ProjectAnalysis | null): string {
  const a = (analysis ?? NO_ANALYSIS) as object;
  let inner = keyOf.get(project);
  if (!inner) keyOf.set(project, (inner = new WeakMap()));
  let k = inner.get(a);
  if (!k) inner.set(a, (k = `g${++generation}`));
  return k;
}

export interface SheetsState {
  key: string;
  /** null until the first list of this panel arrives */
  sheets: DrawingSheetMeta[] | null;
  /** the listed generation differs from the requested one (a newer list is on its way) */
  listing: boolean;
  listMs: number;
  listError: string | null;
  /** built sheet of the current generation */
  get(id: string): DrawingSheet | undefined;
  /** built sheet of the previous generation (shown dimmed while the current one builds) */
  getStale(id: string): DrawingSheet | undefined;
  buildMs(id: string): number | undefined;
  buildError(id: string): string | undefined;
  /** build these ids (priority order); already built ids are skipped */
  want(ids: string[]): void;
  zip(ids: string[], projectId: string, projectName: string, onProgress: (done: number, total: number) => void): Promise<{ blob: Blob; files: number }>;
  cancelZip(): void;
}

/** debounce (ms) between an edit and the re-list while a list is already shown (drags produce many project objects) */
const RELIST_DEBOUNCE_MS = 180;

export function useSheets(project: Project, analysis: ProjectAnalysis | null, library: CatalogLibrary | null): SheetsState {
  const wantedKey = generationKey(project, analysis);
  const [, force] = useState(0);
  const rerender = useCallback(() => force((n) => n + 1), []);
  const st = useRef({
    listedKey: '',
    sentKey: '',
    sheets: null as DrawingSheetMeta[] | null,
    listMs: 0,
    listError: null as string | null,
    cache: new Lru<DrawingSheet>(LRU_SIZE),
    stale: new Lru<DrawingSheet>(LRU_SIZE),
    ms: new Map<string, number>(),
    errors: new Map<string, string>(),
    inflight: new Set<string>(),
    pendingWant: [] as string[],
    zipJob: 0,
    zips: new Map<number, { resolve: (r: { blob: Blob; files: number }) => void; reject: (e: Error) => void; onProgress: (d: number, t: number) => void }>(),
  });
  const transport = useRef<ReturnType<typeof createTransport> | null>(null);

  const onMessage = useCallback((m: DrawingsWorkerResponse) => {
    const s = st.current;
    switch (m.type) {
      case 'list':
        if (m.key !== s.sentKey) return; // stale generation
        s.listedKey = m.key;
        s.sheets = m.sheets;
        s.listMs = m.ms;
        s.listError = null;
        s.inflight.clear();
        if (s.pendingWant.length) {
          const ids = s.pendingWant;
          s.pendingWant = [];
          sendWant(ids);
        }
        rerender();
        return;
      case 'list-error':
        if (m.key !== s.sentKey) return;
        s.listError = m.message;
        rerender();
        return;
      case 'sheet':
        if (m.key !== s.listedKey) return;
        s.inflight.delete(m.id);
        s.cache.set(m.id, m.sheet);
        s.ms.set(m.id, m.ms);
        s.errors.delete(m.id);
        rerender();
        return;
      case 'sheet-error':
        if (m.key !== s.listedKey) return;
        s.inflight.delete(m.id);
        s.errors.set(m.id, m.message);
        rerender();
        return;
      case 'zip-progress':
        s.zips.get(m.jobId)?.onProgress(m.done, m.total);
        return;
      case 'zip':
        s.zips.get(m.jobId)?.resolve({ blob: m.blob, files: m.files });
        s.zips.delete(m.jobId);
        return;
      case 'zip-error':
        s.zips.get(m.jobId)?.reject(new Error(m.message));
        s.zips.delete(m.jobId);
        return;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sendWant = useCallback((ids: string[]) => {
    const s = st.current;
    const missing = ids.filter((id) => !s.cache.has(id) && !s.errors.has(id));
    if (!missing.length || !transport.current) return;
    // the queue is replaced by each want: re-send in-flight ids that are still wanted (a finished build is skipped by the cache check)
    for (const id of missing) s.inflight.add(id);
    transport.current.post({ type: 'want', key: s.listedKey, ids: missing });
  }, []);

  useEffect(() => {
    transport.current = createTransport(onMessage);
    return () => {
      transport.current?.dispose();
      transport.current = null;
    };
  }, [onMessage]);

  useEffect(() => {
    const s = st.current;
    if (s.sentKey === wantedKey || !transport.current) return;
    const send = () => {
      if (!transport.current) return;
      // keep the outgoing generation's built sheets readable while the new one builds
      for (const k of s.cache.keys()) s.stale.set(k, s.cache.get(k)!);
      s.cache = new Lru<DrawingSheet>(LRU_SIZE);
      s.ms.clear();
      s.errors.clear();
      s.inflight.clear();
      s.sentKey = wantedKey;
      transport.current.post({ type: 'open', key: wantedKey, project, analysis, library });
      rerender();
    };
    if (!s.sheets) {
      send();
      return;
    }
    const tm = setTimeout(send, RELIST_DEBOUNCE_MS);
    return () => clearTimeout(tm);
  }, [wantedKey, project, analysis, library, rerender]);

  const s = st.current;
  return {
      key: s.listedKey,
      sheets: s.sheets,
      listing: s.listedKey !== wantedKey,
      listMs: s.listMs,
      listError: s.listError,
      get: (id) => s.cache.get(id),
      getStale: (id) => s.stale.get(id),
      buildMs: (id) => s.ms.get(id),
      buildError: (id) => s.errors.get(id),
      want: (ids) => {
        if (s.listedKey !== s.sentKey) {
          s.pendingWant = ids;
          return;
        }
        sendWant(ids);
      },
      zip: (ids, projectId, projectName, onProgress) =>
        new Promise((resolve, reject) => {
          if (!transport.current) return reject(new Error('drawings: not ready'));
          const jobId = ++s.zipJob;
          s.zips.set(jobId, { resolve, reject, onProgress });
          transport.current.post({ type: 'zip', key: s.listedKey, jobId, ids, projectId, projectName });
        }),
      cancelZip: () => {
        for (const [jobId, z] of s.zips) {
          transport.current?.post({ type: 'cancel-zip', jobId });
          z.reject(new Error('cancelled'));
        }
        s.zips.clear();
      },
  };
}
