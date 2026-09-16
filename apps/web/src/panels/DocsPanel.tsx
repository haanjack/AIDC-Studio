import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  DOC_CHAPTERS, NOS_TARGETS, NOS_TARGET_LABEL, docStrings,
  renderDesignDocumentHtml,
  type DesignNote, type DocSection, type ExportFormat as CoreExportFormat, type Locale, type NosTarget, type Project, type ProjectAnalysis,
} from '@aidc/core';
import { libraryCache, projectLocale, useApp } from '../store/appStore.ts';
import { createDocsWorkerClient, type DocsJob, type DocsJobResult, type DocsWorkerClient } from '../app/docsJobs.ts';
import { api, downloadBlob, downloadText } from '../app/api.ts';
import { Section, Select } from '../ui/controls.tsx';
import { Icon } from '../ui/icons.tsx';
import { Term } from '../ui/Term.tsx';
import { useT } from '../i18n';

const SECTION_IDS: DocSection[] = ['overview', 'site', 'space', 'power', 'cooling', 'network', 'workload', 'cost', 'schedule', 'risk'];

const EXPORTS: CoreExportFormat[] = ['deploy', 'docs', 'drawings', 'usd', 'godot', 'unreal', 'json', 'all'];

const LOCALE_LABEL: Record<Locale, string> = { en: 'English', ko: '한국어' }; // i18n-allow: language endonyms

/** yield to the browser so the busy state paints before the job is posted (generation itself runs in workers/docs.worker.ts) */
const nextFrame = () => new Promise<void>((r) => setTimeout(r, 30));

export function DocsPanel() {
  const t = useT();
  const project = useApp((s) => s.project);
  const analysis = useApp((s) => s.analysis);
  const update = useApp((s) => s.update);
  const replaceProject = useApp((s) => s.replaceProject);
  const serverOnline = useApp((s) => s.serverOnline);
  const thermal = useApp((s) => s.thermal);
  const viewerApi = useApp((s) => s.viewerApi);
  const notify = useApp((s) => s.notify);
  const setLocale = useApp((s) => s.setLocale);
  const [busy, setBusy] = useState<string | null>(null);
  const [nosTarget, setNosTarget] = useState<NosTarget>(project.network.scaleOut.fabric.startsWith('ib-') ? 'ib-ufm' : 'sonic');
  const [lastResult, setLastResult] = useState<string | null>(null);
  const workerRef = useRef<DocsWorkerClient | null>(null);
  useEffect(() => () => workerRef.current?.dispose(), []);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const locale = projectLocale(project);
  const S = docStrings(locale);
  const isIb = project.network.scaleOut.fabric.startsWith('ib-');

  const html = useMemo(() => {
    if (!analysis) return '';
    try {
      const m = thermal.metrics;
      return renderDesignDocumentHtml(project, analysis, { locale, includeBom: true, thermal: m ? { maxInletC: m.maxInletC, rciHi: m.rciHi, rti: m.rti } : undefined });
    } catch (e) {
      return `<!doctype html><p>${String((e as Error).message).replace(/[<&]/g, '')}</p>`;
    }
  }, [project, analysis, thermal.metrics, locale]);

  /** deliverable jobs run in a module worker (bundle cached there per project / analysis / locale); inline fallback without Worker */
  const job = (a: ProjectAnalysis | null, j: DocsJob, zipRoot?: string): Promise<DocsJobResult> => {
    workerRef.current ??= createDocsWorkerClient();
    const key = `${project.id}|${project.updatedAt}|${a?.generatedAt ?? 'none'}|${locale}`;
    return workerRef.current.run({ key, project, analysis: a, locale, library: libraryCache, job: j, zipRoot });
  };

  const run = async (id: string, fn: () => Promise<void> | void, errKey = 'docs.deploy.error') => {
    setBusy(id);
    try {
      await nextFrame();
      await fn();
    } catch (e) {
      notify(t(errKey, { msg: (e as Error).message }), 'error');
    } finally {
      setBusy(null);
    }
  };

  const downloadDeployFile = (path: string) =>
    run(`file:${path}`, async () => {
      if (!analysis) return;
      const r = await job(analysis, { kind: 'file', path });
      const f = r.type === 'file' ? r.file : undefined;
      if (!f) return;
      // finish v2 2차 (QA rack-elevations M5): above 16 DUs rack-elevations.html is an index whose chapters live in rack-elevations/ —
      // download index + chapters together so the links work
      if (path.endsWith('.html') && typeof f.content === 'string' && f.content.includes(`href="${path.replace(/\.html$/, '')}/`)) {
        const root = `${project.id}-${path.replace(/\.html$/, '')}-${locale}`;
        const z = await job(analysis, { kind: 'files', path }, root);
        if (z.type === 'zip') downloadBlob(z.blob, `${root}.zip`);
        return;
      }
      const type = path.endsWith('.csv') ? 'text/csv;charset=utf-8' : path.endsWith('.html') ? 'text/html;charset=utf-8' : 'text/plain;charset=utf-8';
      const base = path.replace(/\.(csv|html|dot)$/, '');
      const ext = path.slice(base.length);
      const name = `${project.id}-${base}${path.endsWith('.html') ? `-${locale}` : ''}${ext}`;
      if (typeof f.content === 'string') downloadText(f.content, name, type);
      else downloadBlob(new Blob([f.content as BlobPart], { type }), name);
    });

  const downloadNos = () =>
    run('nos', async () => {
      if (!analysis) return;
      const root = `${project.id}-nos-${nosTarget}`;
      const r = await job(analysis, { kind: 'nos', target: nosTarget }, root);
      if (r.type !== 'zip') return;
      downloadBlob(r.blob, `${root}.zip`);
      const msg = t('docs.nos.done', { target: NOS_TARGET_LABEL[nosTarget], files: r.files, verify: r.verify ?? 0 });
      setLastResult(msg);
      notify(msg, 'ok');
    });

  const downloadTests = () =>
    run('tests', async () => {
      if (!analysis) return;
      const root = `${project.id}-tests`;
      const r = await job(analysis, { kind: 'tests' }, root);
      if (r.type !== 'zip') return;
      downloadBlob(r.blob, `${root}.zip`);
      const msg = t('docs.tests.done', { files: r.files, single: r.single ?? 0, cross: r.cross ?? 0 });
      setLastResult(msg);
      notify(msg, 'ok');
    });

  const exportBundle = (format: CoreExportFormat) =>
    run(`export:${format}`, async () => {
      let blob: Blob;
      if (serverOnline) {
        blob = await api.exportBundle(format, project, analysis);
      } else {
        const r = await job(analysis, { kind: 'export', format });
        if (r.type !== 'zip') return;
        blob = r.blob;
      }
      downloadBlob(blob, `${project.id}-${format}.zip`);
      notify(t('docs.all.done', { format: format.toUpperCase(), suffix: serverOnline ? '' : t('docs.all.offline') }), 'ok');
    }, 'docs.all.failed');

  const printDoc = () => frameRef.current?.contentWindow?.print();
  // polish v2 2차 (QA docs #6): the tab gets a script-free wrapper page whose only content is a sandboxed srcdoc iframe (opaque origin,
  // no scripts), so the document never runs on the app origin even if a future block skipped escaping
  const openTab = () => {
    const attr = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    const wrapper = `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><title>${attr(`${project.name} — ${t('docs.design.title')}`)}</title><style>html,body{margin:0;height:100%;background:#fff}iframe{display:block;border:0;width:100%;height:100%}</style></head><body><iframe sandbox="allow-modals" title="${attr(t('docs.design.title'))}" srcdoc="${attr(html)}"></iframe></body></html>`;
    const url = URL.createObjectURL(new Blob([wrapper], { type: 'text/html;charset=utf-8' }));
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  const deliverables: { key: string; label: ReactNode; csv?: string; html?: string; other?: string }[] = [
    { key: 'bom', label: <Term id="bom">{t('docs.deploy.bom')}</Term>, csv: 'bom-by-wave.csv', html: 'bom-by-wave.html' },
    { key: 'rack', label: <Term id="rack-plan">{t('docs.deploy.rack')}</Term>, csv: 'rack-plan.csv', html: 'rack-plan.html' },
    { key: 'rack-elev', label: t('docs.deploy.rackElev'), csv: 'rack-summary.csv', html: 'rack-elevations.html', other: 'rack-contents.csv' },
    { key: 'cables', label: t('docs.deploy.cables'), csv: 'cable-schedule.csv', html: 'cable-schedule.html', other: 'topology.dot' },
    { key: 'ip', label: t('docs.deploy.ip'), csv: 'ip-plan.csv', html: 'ip-plan.html' },
    { key: 'inventory', label: t('docs.deploy.inventory'), csv: 'switch-inventory.csv' },
  ];
  const disabled = !analysis || busy != null;
  const fileBtn = (path: string | undefined, label: string) =>
    path ? (
      <button className="btn sm" disabled={disabled} data-deploy-file={path} onClick={() => void downloadDeployFile(path)}>
        <Icon name="download" size={13} />{busy === `file:${path}` ? t('docs.deploy.building') : label}
      </button>
    ) : null;

  return (
    <div className="grid-auto" style={{ gridTemplateColumns: 'minmax(360px, 460px) 1fr' }}>
      <div>
        <div className="card" data-docs-design>
          <div className="row" style={{ marginBottom: 6 }}>
            <h3 style={{ margin: 0 }}>{t('docs.design.title')}</h3>
            <span className="grow" />
            <span className="hint">{t('docs.language')}</span>
            <div style={{ width: 110 }}>
              <Select value={locale} options={(['en', 'ko'] as Locale[]).map((l) => ({ value: l, label: LOCALE_LABEL[l] }))} onChange={(v) => setLocale(v)} />
            </div>
          </div>
          <p className="hint" style={{ marginTop: 0 }}>{t('docs.design.desc')} {t('docs.languageHint')}</p>
          <div className="row wrap" style={{ gap: 6 }}>
            <button className="btn sm primary" data-ro-allow disabled={!html} onClick={() => downloadText(html, `${project.id}-design-document-${locale}.html`, 'text/html;charset=utf-8')}><Icon name="docs" size={13} />{t('docs.design.download')}</button>
            <button className="btn sm" data-ro-allow disabled={!html} onClick={printDoc}><Icon name="download" size={13} />{t('docs.design.print')}</button>
            <button className="btn sm" data-ro-allow disabled={!html} onClick={openTab} data-docs-new-tab><Icon name="docs" size={13} />{t('docs.design.newTab')}</button>
          </div>
          <details style={{ marginTop: 8 }}>
            <summary className="hint">{t('docs.design.outline', { lang: LOCALE_LABEL[locale] })}</summary>
            <ol className="hint" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              {DOC_CHAPTERS.map((c) => <li key={c}>{S.chapters[c].replace(/^\d+\.\s*/, '')}</li>)}
            </ol>
          </details>
        </div>

        <div className="card" data-docs-deploy data-ro-allow>
          <h3>{t('docs.deploy.title')}</h3>
          <p className="hint" style={{ marginTop: 0 }}>{t('docs.deploy.desc')}</p>
          {deliverables.map((d) => (
            <div key={d.key} className="row" style={{ padding: '5px 0', borderBottom: '1px solid var(--border)' }}>
              <div className="grow">{d.label}</div>
              <div className="row" style={{ gap: 4 }}>
                {fileBtn(d.csv, t('docs.csv'))}
                {fileBtn(d.html, t('docs.html'))}
                {fileBtn(d.other, d.other?.endsWith('.csv') ? `${t('docs.csv')} (${d.other.replace('.csv', '')})` : '.dot')}
              </div>
            </div>
          ))}
          <p className="hint" style={{ marginBottom: 0 }}>
            {analysis ? t('docs.deploy.summary', { racks: analysis.summary.racks, waves: project.schedule.waves.length }) : t('docs.design.waiting')} · {t('docs.deploy.labelNote')}
          </p>
          <p className="hint" style={{ marginBottom: 0 }} data-rack-elev-note>{t('docs.deploy.rackElevNote')}</p>
        </div>

        <div className="card" data-docs-nos data-ro-allow>
          <h3>{t('docs.nos.title')}</h3>
          <p className="hint" style={{ marginTop: 0 }}>{t('docs.nos.desc')}</p>
          <div className="row" style={{ gap: 6 }}>
            <span className="hint">{t('docs.nos.target')}</span>
            <div className="grow"><Select value={nosTarget} options={NOS_TARGETS.map((x) => ({ value: x, label: NOS_TARGET_LABEL[x] }))} onChange={(v) => setNosTarget(v)} /></div>
            <button className="btn sm primary" disabled={disabled} onClick={() => void downloadNos()}><Icon name="download" size={13} />{busy === 'nos' ? t('docs.deploy.building') : t('docs.nos.zip')}</button>
          </div>
          {isIb && nosTarget !== 'ib-ufm' && <p className="hint" style={{ marginBottom: 0 }}>{t('docs.nos.ibNote')}</p>}
        </div>

        <div className="card" data-docs-tests data-ro-allow>
          <h3>{t('docs.tests.title')}</h3>
          <p className="hint" style={{ marginTop: 0 }}>{t('docs.tests.desc')}</p>
          <button className="btn sm primary" disabled={disabled} onClick={() => void downloadTests()}><Icon name="download" size={13} />{busy === 'tests' ? t('docs.deploy.building') : t('docs.tests.zip')}</button>
          {lastResult && <p className="hint" style={{ marginBottom: 0 }} data-docs-last-result>{lastResult}</p>}
        </div>

        <div className="card" data-docs-all data-ro-allow>
          <h3>{t('docs.all.title')}</h3>
          {EXPORTS.map((f) => (
            <div key={f} className="row" style={{ padding: '5px 0', borderBottom: '1px solid var(--border)' }}>
              <div className="grow">
                <div>{t(`docs.export.${f}`)}</div>
                <div className="hint">{t(`docs.export.${f}Desc`)}</div>
              </div>
              <button className="btn sm" disabled={busy != null} onClick={() => void exportBundle(f)}>
                <Icon name="download" size={13} />{busy === `export:${f}` ? t('docs.all.building') : 'ZIP'}
              </button>
            </div>
          ))}
          <div className="row wrap" style={{ marginTop: 10 }}>
            <button className="btn sm" disabled={!viewerApi} onClick={async () => { if (!viewerApi) return; const buf = await viewerApi.exportGlb(); downloadBlob(new Blob([buf], { type: 'model/gltf-binary' }), `${project.id}.glb`); }}><Icon name="cube" size={13} />{t('docs.export.glb')}</button>
            <button className="btn sm" disabled={!viewerApi} onClick={() => { if (!viewerApi) return; const url = viewerApi.screenshot(); fetch(url).then((r) => r.blob()).then((b) => downloadBlob(b, `${project.id}.png`)); }}><Icon name="camera" size={13} />{t('docs.export.screenshot')}</button>
          </div>
        </div>

        <div className="card">
          <h3>{t('docs.project.title')}</h3>
          <div className="row wrap">
            <button className="btn sm" data-ro-allow onClick={() => downloadText(JSON.stringify(project, null, 2), `${project.id}.aidc.json`, 'application/json')}><Icon name="save" size={13} />{t('docs.project.save')}</button>
            <label className="btn sm" style={{ cursor: 'pointer' }}>
              <Icon name="upload" size={13} />{t('docs.project.load')}
              <input type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                try {
                  const p = JSON.parse(await file.text()) as Project;
                  if (p.schemaVersion !== 1 || !Array.isArray(p.halls)) throw new Error(t('docs.project.notProject'));
                  replaceProject(p);
                  if (serverOnline) await api.saveProject(p).catch(() => api.createProject(p));
                  notify(t('docs.project.loaded', { name: p.name }), 'ok');
                } catch (err) {
                  notify((err as Error).message, 'error');
                }
              }} />
            </label>
          </div>
          <p className="hint">{serverOnline ? t('docs.project.online') : t('docs.project.offline')}</p>
        </div>

        <Section title={t('docs.notes.title')} actions={<button className="btn sm" onClick={() => update((d) => { d.notes.push({ id: `note-${Date.now().toString(36)}`, section: 'risk', title: t('docs.notes.new'), body: '' }); })}><Icon name="plus" size={13} />{t('docs.notes.add')}</button>}>
          {project.notes.map((n) => <NoteEditor key={n.id} note={n} />)}
        </Section>
      </div>

      <div className="card" style={{ minHeight: 400, display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden' }} data-docs-preview data-locale={locale}>
        <div className="row" style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
          <h3 style={{ margin: 0 }}>{t('docs.preview.title')}</h3>
          <span className="grow" />
          <span className="hint">{LOCALE_LABEL[locale]}</span>
        </div>
        {html ? (
          <iframe
            ref={frameRef}
            title={t('docs.preview.title')}
            sandbox="allow-same-origin allow-modals"
            srcDoc={html}
            style={{ flex: 1, width: '100%', minHeight: 'calc(100vh - 160px)', border: 0, background: '#fff' }}
          />
        ) : (
          <p className="hint" style={{ padding: 12 }}>{t('docs.design.waiting')}</p>
        )}
      </div>
    </div>
  );
}

function NoteEditor({ note }: { note: DesignNote }) {
  const t = useT();
  const update = useApp((s) => s.update);
  const set = (patch: Partial<DesignNote>) => update((d) => { Object.assign(d.notes.find((x) => x.id === note.id)!, patch); });
  return (
    <div className="card">
      <div className="row">
        <div style={{ width: 150 }}><Select value={note.section} options={SECTION_IDS.map((v) => ({ value: v, label: t(`docs.section.${v}`) }))} onChange={(v) => set({ section: v })} /></div>
        <input type="text" defaultValue={note.title} onBlur={(e) => e.target.value !== note.title && set({ title: e.target.value })} />
        <button className="btn ghost sm" onClick={() => update((d) => { d.notes = d.notes.filter((x) => x.id !== note.id); })}><Icon name="trash" size={13} /></button>
      </div>
      <textarea rows={4} style={{ marginTop: 6 }} defaultValue={note.body} onBlur={(e) => e.target.value !== note.body && set({ body: e.target.value })} />
    </div>
  );
}
