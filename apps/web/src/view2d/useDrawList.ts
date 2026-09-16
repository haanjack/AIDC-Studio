// r4 stream C: worker-backed draw lists for the 2D pane. One shared worker; the project + analysis are posted once per change
// (a generation number discards stale scenes); build requests are keyed so an unchanged request never rebuilds.
import { useEffect, useRef, useState } from 'react';
import type { Project, ProjectAnalysis } from '@aidc/core';
import type { BuildRequest, DrawlistWorkerRequest, DrawlistWorkerResponse, ExportSvgRequest, Scene2D } from './scene.ts';

let worker: Worker | null = null;
let gen = 0;
let postedProject: Project | null = null;
let postedAnalysis: ProjectAnalysis | null | undefined;
const listeners = new Set<(m: DrawlistWorkerResponse) => void>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./drawlist.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev: MessageEvent<DrawlistWorkerResponse>) => {
      for (const l of listeners) l(ev.data);
    };
  }
  return worker;
}

function send(m: DrawlistWorkerRequest) {
  getWorker().postMessage(m);
}

/** Post the project when it changed; returns the current generation. */
export function syncProject(project: Project, analysis: ProjectAnalysis | null): number {
  if (project !== postedProject || analysis !== postedAnalysis) {
    gen++;
    postedProject = project;
    postedAnalysis = analysis;
    send({ type: 'project', gen, project, analysis });
  }
  return gen;
}

export interface DrawListState {
  scene: Scene2D | null;
  loading: boolean;
  error: string | null;
}

/** Build (or reuse) the scene for a request. `req` null = nothing to show. */
export function useDrawList(project: Project, analysis: ProjectAnalysis | null, req: Omit<BuildRequest, 'type' | 'key'> | null): DrawListState {
  const [state, setState] = useState<DrawListState>({ scene: null, loading: false, error: null });
  const want = useRef<string>('');
  const g = syncProject(project, analysis);
  const key = req ? `${g}|${JSON.stringify(req)}` : '';
  useEffect(() => {
    const onMsg = (m: DrawlistWorkerResponse) => {
      if (m.type === 'scene' && m.scene.key === want.current && m.gen === gen) setState({ scene: m.scene, loading: false, error: null });
      else if (m.type === 'clearance' && m.key === want.current && m.gen === gen)
        setState((s) => (s.scene && s.scene.key === m.key ? { ...s, scene: { ...s.scene, clearance: m.clearance, auditPending: false, ms: { ...s.scene.ms, audit: m.auditMs } } } : s));
      else if (m.type === 'error' && m.key === want.current) setState((s) => ({ ...s, loading: false, error: m.message }));
    };
    listeners.add(onMsg);
    return () => {
      listeners.delete(onMsg);
    };
  }, []);
  useEffect(() => {
    want.current = key;
    if (!req) {
      setState({ scene: null, loading: false, error: null });
      return;
    }
    setState((s) => ({ ...s, loading: true }));
    send({ type: 'build', key, ...req });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}

let exportSeq = 0;
/** "Export current view" as SVG, built in the worker from the same draw list. */
export function exportSvgInWorker(project: Project, analysis: ProjectAnalysis | null, r: Omit<ExportSvgRequest, 'type' | 'key'>): Promise<string> {
  syncProject(project, analysis);
  const key = `svg-${++exportSeq}`;
  return new Promise((resolve, reject) => {
    const onMsg = (m: DrawlistWorkerResponse) => {
      if (m.type === 'svg' && m.key === key) {
        listeners.delete(onMsg);
        resolve(m.svg);
      } else if (m.type === 'error' && m.key === key) {
        listeners.delete(onMsg);
        reject(new Error(m.message));
      }
    };
    listeners.add(onMsg);
    send({ type: 'export-svg', key, ...r });
  });
}
