// Deliverable generation jobs of the Docs panel (integration v2 2차, #15). The deployment bundle (cable schedule ≈ 20k rows, IP plan),
// NOS configs, the test kit and the offline export ZIP take ≈ 1.5 s on the reference hall, so they run in workers/docs.worker.ts.
// The same `runDocsJob` is the inline fallback when a module worker cannot be created (tests, old browsers).
import JSZip from 'jszip';
import {
  buildDeployBundle, buildExportFiles, generateNosConfigs, generateTestPlan, networkDeliverableData,
  type CatalogLibrary, type DeployFile, type ExportFormat, type Locale, type NosTarget, type Project, type ProjectAnalysis,
} from '@aidc/core';

export type DocsJob = { kind: 'file'; path: string } | { kind: 'files'; path: string } | { kind: 'nos'; target: NosTarget } | { kind: 'tests' } | { kind: 'export'; format: ExportFormat };

export interface DocsJobInput {
  /** cache key: project id · updatedAt · analysis generatedAt · deliverable locale */
  key: string;
  project?: Project;
  analysis?: ProjectAnalysis | null;
  locale: Locale;
  library?: CatalogLibrary | null;
  job: DocsJob;
  /** top-level folder inside the ZIP (nos / tests) */
  zipRoot?: string;
}

export type DocsJobResult =
  | { type: 'file'; file?: DeployFile }
  | { type: 'zip'; blob: Blob; files: number; verify?: number; single?: number; cross?: number };

export type DocsWorkerRequest = DocsJobInput & { id: number };
export type DocsWorkerResponse = ({ id: number } & DocsJobResult) | { id: number; type: 'error'; message: string };

type Cache = { key: string; project: Project; analysis: ProjectAnalysis | null; locale: Locale; bundle?: { files: DeployFile[]; data: ReturnType<typeof networkDeliverableData> } };
let cache: Cache | null = null;

/** Adopt the job's project (a new key) — returns true when the caller must activate the project's catalog. */
export function adoptDocsInput(input: DocsJobInput): boolean {
  if (input.project && (!cache || cache.key !== input.key)) {
    cache = { key: input.key, project: input.project, analysis: input.analysis ?? null, locale: input.locale };
    return true;
  }
  return false;
}

async function zipFiles(files: { path: string; content: string | Uint8Array }[], root?: string): Promise<Blob> {
  const zip = new JSZip();
  for (const f of files) zip.file(root ? `${root}/${f.path}` : f.path, f.content);
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

export async function runDocsJob(input: DocsJobInput): Promise<DocsJobResult> {
  adoptDocsInput(input);
  const c = cache;
  if (!c || c.key !== input.key) throw new Error('docs job: project data missing for this key');
  const { project, analysis, locale } = c;
  const bundle = () => {
    if (!analysis) throw new Error('docs job: no analysis');
    if (!c.bundle) {
      const data = networkDeliverableData(project, analysis);
      c.bundle = { data, files: buildDeployBundle(project, analysis, { locale, ...data }) };
    }
    return c.bundle;
  };
  const job = input.job;
  switch (job.kind) {
    case 'file':
      return { type: 'file', file: bundle().files.find((f) => f.path === job.path) };
    case 'files': {
      // finish v2 2차 (QA rack-elevations M5): a split document (index + chapters under <base>/) as one ZIP
      const base = job.path.replace(/\.html$/, '');
      const files = bundle().files.filter((f) => f.path === job.path || f.path.startsWith(`${base}/`));
      return { type: 'zip', blob: await zipFiles(files, input.zipRoot), files: files.length };
    }
    case 'nos': {
      const { data } = bundle();
      const files = generateNosConfigs(project, analysis!, data.ipPlan, job.target, { cableSchedule: data.cableSchedule });
      const verify = files.reduce((n, f) => n + (f.content.match(/verify:/g)?.length ?? 0), 0);
      return { type: 'zip', blob: await zipFiles(files, input.zipRoot), files: files.length, verify };
    }
    case 'tests': {
      const { data } = bundle();
      const files = generateTestPlan(project, analysis!, { locale, cableSchedule: data.cableSchedule, ipPlan: data.ipPlan });
      const count = (p: string) => Math.max(0, (files.find((f) => f.path === p)?.content ?? '').split('\n').filter((l) => l && !l.startsWith('#')).length);
      return { type: 'zip', blob: await zipFiles(files, input.zipRoot), files: files.length, single: count('inventory/hostfiles/single-leaf.txt'), cross: count('inventory/hostfiles/cross-spine.txt') };
    }
    case 'export': {
      // polish v2 2차 (QA docs #4): same aidc-<format>/ root and DEFLATE level as the server ZIP (apps/server/src/export-zip.ts);
      // engine templates and GLB models live on the server only
      const files = buildExportFiles(project, analysis, job.format);
      const entries = Object.entries(files).map(([path, content]) => ({ path, content }));
      return { type: 'zip', blob: await zipFiles(entries, `aidc-${job.format}`), files: entries.length };
    }
  }
}

export interface DocsWorkerClient {
  run(input: DocsJobInput & { project: Project; analysis: ProjectAnalysis | null }): Promise<DocsJobResult>;
  dispose(): void;
}

/** Worker-backed job runner; the project / analysis are posted once per key (structured clone), then only the job. */
export function createDocsWorkerClient(): DocsWorkerClient {
  let worker: Worker | null = null;
  try {
    worker = new Worker(new URL('../workers/docs.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    worker = null;
  }
  let seq = 0;
  let sentKey: string | null = null;
  const pending = new Map<number, { resolve: (r: DocsJobResult) => void; reject: (e: Error) => void }>();
  const fail = (msg: string) => {
    for (const p of pending.values()) p.reject(new Error(msg));
    pending.clear();
    worker?.terminate();
    worker = null; // later jobs run inline
    sentKey = null;
  };
  if (worker) {
    worker.onmessage = (ev: MessageEvent<DocsWorkerResponse>) => {
      const m = ev.data;
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.type === 'error') p.reject(new Error(m.message));
      else p.resolve(m);
    };
    worker.onerror = (e) => fail(e.message || 'docs worker failed');
  }
  return {
    run(input) {
      if (!worker) return runDocsJob(input);
      const id = ++seq;
      const fresh = sentKey !== input.key;
      const msg: DocsWorkerRequest = { id, key: input.key, locale: input.locale, job: input.job, zipRoot: input.zipRoot, ...(fresh ? { project: input.project, analysis: input.analysis, library: input.library } : {}) };
      sentKey = input.key;
      return new Promise<DocsJobResult>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker!.postMessage(msg);
      });
    },
    dispose() {
      worker?.terminate();
      worker = null;
      pending.clear();
    },
  };
}
