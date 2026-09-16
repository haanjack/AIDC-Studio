// LLM Q&A assistant (stream T8, DECISIONS-v2-2 §B/§C, r2-platform.md §3.4): grounded on the glossary, page help, the
// current screen and a compact analysis summary; streamed from the server proxy (POST /api/chat → OpenAI-compatible
// endpoint, e.g. vLLM). The browser never calls the model. Offline (no server / no LLM) → deterministic glossary answer.
import { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { analysisContextBlocks, findCatalogItem, offlineAnswer, type Locale } from '@aidc/core';
import { useApp, type PageId } from '../store/appStore.ts';
import { t as tNow, useI18n } from '../i18n/index.ts';
import { collabApi, PAGE_IDS, type LlmStatus } from '../app/collab.ts';
import { commonHeaders } from '../app/session.ts';
import { Markdown } from './markdown.tsx';
import { openHelpTerm, useHelp } from './HelpDrawer.tsx';

interface Msg {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  mode?: 'live' | 'offline';
  model?: string;
  streaming?: boolean;
  citations?: string[];
  invalid?: string[];
  labels?: Record<string, string>;
  error?: string;
}

interface AssistantState {
  messages: Msg[];
  includePage: boolean;
  status: LlmStatus | null;
  statusLoading: boolean;
  push(m: Msg): void;
  patch(id: number, p: Partial<Msg> | ((m: Msg) => Partial<Msg>)): void;
  clear(): void;
  setIncludePage(v: boolean): void;
  refreshStatus(): Promise<void>;
}

const INCLUDE_KEY = 'aidc:assistantIncludePage';

export const useAssistant = create<AssistantState>((set, get) => ({
  messages: [],
  // fix v2 2차 (QA security): opt-in — the page context and analysis blocks are not sent unless the user enables it
  includePage: (() => { try { return localStorage.getItem(INCLUDE_KEY) === '1'; } catch { return false; } })(),
  status: null,
  statusLoading: false,
  push: (m) => set({ messages: [...get().messages, m] }),
  patch: (id, p) => set({ messages: get().messages.map((m) => (m.id === id ? { ...m, ...(typeof p === 'function' ? p(m) : p) } : m)) }),
  clear: () => set({ messages: [] }),
  setIncludePage: (v) => {
    try { localStorage.setItem(INCLUDE_KEY, v ? '1' : '0'); } catch { /* storage blocked */ }
    set({ includePage: v });
  },
  async refreshStatus() {
    if (!useApp.getState().serverOnline) return set({ status: null, statusLoading: false });
    set({ statusLoading: true });
    try {
      const r = await collabApi.llmStatus();
      set({ status: r.status === 200 ? r.body : null, statusLoading: false });
    } catch {
      set({ status: null, statusLoading: false });
    }
  },
}));

let nextId = 1;
/** host of a remote LLM endpoint the user explicitly allowed to receive the page context (this session only) */
let remoteConfirmedHost: string | undefined;
let controller: AbortController | null = null;

/** Text description of the active screen (sent only with "include current screen"). */
function pageContextText(locale: Locale): string {
  const s = useApp.getState();
  const hall = s.project.halls.find((h) => h.id === s.hallId);
  const lines = [
    `page: ${s.page} — ${tNow(`shell.page.${s.page}.title`)}`,
    `project: ${s.project.name}`,
    hall ? `hall: ${hall.name} (${hall.width.toFixed(1)} × ${hall.depth.toFixed(1)} m, IT budget ${Math.round(hall.itPowerBudgetKW)} kW)` : '',
    `equipment in hall: ${s.project.equipment.filter((e) => e.hallId === s.hallId).length}`,
  ];
  if (s.selection.length) {
    const sel = s.selection.slice(0, 10).map((id) => {
      const e = s.project.equipment.find((x) => x.id === id);
      const item = e ? findCatalogItem(e.catalogId) : undefined;
      return e ? `${e.tag} = ${item?.name ?? e.catalogId} (${item?.category ?? '?'}) at (${e.position.x.toFixed(1)}, ${e.position.y.toFixed(1)}) m` : id;
    });
    lines.push(`selected: ${sel.join('; ')}${s.selection.length > 10 ? ` … +${s.selection.length - 10}` : ''}`);
  }
  if (s.thermal.metrics) lines.push(`thermal run: status ${s.thermal.status}, max rack inlet ${s.thermal.metrics.maxInletC.toFixed(1)} °C`);
  lines.push(`view: color mode ${s.colorMode}, camera ${s.cameraPreset}${s.editMode ? ', edit mode' : ''}`);
  lines.push(`answer language: ${locale}`);
  return lines.filter(Boolean).join('\n');
}

function parseSseBlock(block: string): { event: string; data: Record<string, unknown> } | null {
  const ev = /^event: ?(.*)$/m.exec(block)?.[1]?.trim() ?? 'message';
  const dataLines = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart());
  if (!dataLines.length) return null;
  try {
    return { event: ev, data: JSON.parse(dataLines.join('\n')) as Record<string, unknown> };
  } catch {
    return null;
  }
}

export async function askAssistant(question: string): Promise<void> {
  const app = useApp.getState();
  const st = useAssistant.getState();
  const locale = app.uiLocale;
  const history = st.messages.filter((m) => !m.streaming && m.text && !m.error).slice(-8).map((m) => ({ role: m.role, content: m.text }));
  st.push({ id: nextId++, role: 'user', text: question });
  const botId = nextId++;
  st.push({ id: botId, role: 'assistant', text: '', streaming: true });

  if (!app.serverOnline) {
    const ans = offlineAnswer(question, locale, app.page);
    useAssistant.getState().patch(botId, { text: ans.text, citations: ans.citations, labels: ans.labels, mode: 'offline', streaming: false });
    return;
  }
  controller?.abort();
  controller = new AbortController();
  // a remote endpoint never receives the page context unless the user confirmed that host in this session
  const remote = st.status?.locality === 'remote';
  const sendPage = st.includePage && (!remote || remoteConfirmedHost === st.status?.host);
  const body = {
    question,
    locale,
    page: app.page,
    history,
    includePage: sendPage,
    ...(sendPage ? { pageContext: pageContextText(locale), analysisBlocks: analysisContextBlocks(app.project, app.analysis, locale) } : {}),
  };
  try {
    const res = await fetch('/api/chat', { method: 'POST', headers: { ...commonHeaders(), 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new Error(`${res.status} ${text.slice(0, 200)}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      buf += decoder.decode(r.value, { stream: true });
      let idx: number;
      while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '');
        const ev = parseSseBlock(block);
        if (!ev) continue;
        const patch = useAssistant.getState().patch;
        if (ev.event === 'meta') patch(botId, { mode: ev.data.mode as Msg['mode'], model: ev.data.model as string | undefined, labels: ev.data.labels as Record<string, string> });
        else if (ev.event === 'delta') patch(botId, (m) => ({ text: m.text + String(ev.data.text ?? '') }));
        else if (ev.event === 'error') patch(botId, { error: String(ev.data.message ?? 'error') });
        else if (ev.event === 'done') {
          patch(botId, {
            text: String(ev.data.text ?? ''),
            mode: ev.data.mode as Msg['mode'],
            citations: (ev.data.citations as string[]) ?? [],
            invalid: (ev.data.invalid as string[]) ?? [],
            labels: (ev.data.labels as Record<string, string>) ?? {},
            streaming: false,
          });
        }
      }
    }
    useAssistant.getState().patch(botId, { streaming: false });
  } catch (e) {
    const aborted = (e as Error).name === 'AbortError';
    useAssistant.getState().patch(botId, (m) => ({ streaming: false, error: aborted ? undefined : (e as Error).message, text: m.text || (aborted ? '…' : '') }));
  } finally {
    controller = null;
  }
}

const ANALYSIS_PAGE: Record<string, PageId> = { summary: 'overview', issues: 'overview', power: 'power', cooling: 'cooling', network: 'network', workload: 'workload', schedule: 'schedule' };

export function openCitation(id: string): void {
  const [kind, rest] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
  const app = useApp.getState();
  if (kind === 'term') openHelpTerm(rest);
  else if (kind === 'help' && PAGE_IDS.includes(rest as PageId)) {
    app.setPage(rest as PageId);
    useHelp.getState().openPage();
    app.setAssistantOpen(false);
  } else if (kind === 'page' && PAGE_IDS.includes(rest as PageId)) app.setPage(rest as PageId);
  else if (kind === 'analysis' && ANALYSIS_PAGE[rest]) app.setPage(ANALYSIS_PAGE[rest]);
}

/** Replace `[term:x]` citations by `[n]` markers (numbered by first appearance) and return the order. */
function numberCitations(text: string, extra: string[] = []): { text: string; order: string[] } {
  const order: string[] = [];
  const out = text.replace(/\[((?:term|help|page|analysis):[a-z0-9._-]+)\]/gi, (_w, id: string) => {
    const k = id.toLowerCase();
    let n = order.indexOf(k);
    if (n < 0) n = order.push(k) - 1;
    return ` ⁽${n + 1}⁾`;
  });
  for (const c of extra) if (!order.includes(c)) order.push(c);
  return { text: out.replace(/ +⁽/g, ' ⁽'), order };
}

export function AssistantButton() {
  const open = useApp((s) => s.assistantOpen);
  const setOpen = useApp((s) => s.setAssistantOpen);
  const { t } = useI18n();
  return (
    <button className={`btn ghost sm ${open ? 'active' : ''}`} title={t('shell.assistant.button')} aria-label={t('shell.assistant.button')} data-assistant-button
      onClick={() => { setOpen(!open); if (!open) useHelp.getState().close(); }}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z" />
        <path d="M9 10.5h.01M12 10.5h.01M15 10.5h.01" />
      </svg>
    </button>
  );
}

export function AssistantDrawer() {
  const open = useApp((s) => s.assistantOpen);
  const serverOnline = useApp((s) => s.serverOnline);
  const helpOpen = useHelp((s) => s.open);
  const { t } = useI18n();
  const a = useAssistant();
  const [input, setInput] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const streaming = a.messages.some((m) => m.streaming);

  useEffect(() => {
    if (open) void useAssistant.getState().refreshStatus();
  }, [open, serverOnline]);

  useEffect(() => {
    if (open && helpOpen) useApp.getState().setAssistantOpen(false);
  }, [helpOpen, open]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [a.messages]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') useApp.getState().setAssistantOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;

  const st = a.status;
  const live = !!st?.available;
  const statusText = !serverOnline
    ? t('shell.assistant.statusServerOffline')
    : a.statusLoading && !st
      ? t('shell.assistant.statusChecking')
      : live
        ? t('shell.assistant.statusLive', { model: st!.model ?? '?' })
        : st && !st.configured
          ? t('shell.assistant.statusNotConfigured')
          : t('shell.assistant.statusOffline');

  const send = () => {
    const q = input.trim();
    if (!q || streaming) return;
    setInput('');
    void askAssistant(q);
  };

  return (
    <aside className="help-drawer assistant-drawer" role="dialog" aria-label={t('shell.assistant.title')} data-assistant-drawer>
      <div className="help-head">
        <div className={`assistant-status ${live ? 'live' : 'offline'}`} title={st?.error ?? st?.baseUrl ?? ''} data-assistant-status={live ? 'live' : 'offline'}>
          <span className="dot" /><span className="label">{statusText}</span>
        </div>
        <span className="grow" />
        <button className={`btn ghost sm ${showSettings ? 'active' : ''}`} onClick={() => setShowSettings(!showSettings)} title={t('shell.assistant.settings')} data-assistant-settings>⚙</button>
        <button className="btn ghost sm" onClick={() => { controller?.abort(); a.clear(); }} disabled={!a.messages.length}>{t('shell.assistant.clear')}</button>
        <button className="btn ghost sm" onClick={() => useApp.getState().setAssistantOpen(false)} aria-label={t('shell.help.close')}>✕</button>
      </div>
      {showSettings && <AssistantSettings />}
      {st?.locality === 'remote' && <div className="assistant-warn" data-remote-warning>{t('shell.assistant.remoteWarning', { host: st.host })}</div>}
      <div className="help-body" ref={listRef}>
        {!a.messages.length ? <div className="hint" style={{ lineHeight: 1.6 }}>{t('shell.assistant.empty')}</div> : (
          <div className="assistant-msgs">
            {a.messages.map((m) => <MessageView key={m.id} m={m} />)}
          </div>
        )}
      </div>
      <div className="assistant-input">
        <label className="row" style={{ gap: 6, fontSize: 12 }} title={t('shell.assistant.includePageTitle')}>
          <input type="checkbox" checked={a.includePage && (st?.locality !== 'remote' || remoteConfirmedHost === st?.host)} onChange={(e) => {
            if (e.target.checked && st?.locality === 'remote') {
              if (!window.confirm(t('shell.assistant.remoteConfirm', { host: st.host ?? '' }))) return;
              remoteConfirmedHost = st.host;
            }
            a.setIncludePage(e.target.checked);
          }} data-include-page />
          {t('shell.assistant.includePage')}
          <span className="grow" />
        </label>
        <textarea value={input} placeholder={t('shell.assistant.placeholder')} onChange={(e) => setInput(e.target.value)} maxLength={2000} data-assistant-input
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
        <div className="row" style={{ gap: 6 }}>
          <span className="hint" style={{ flex: 1, fontSize: 11 }}>{t('shell.assistant.dataNote')}</span>
          {streaming
            ? <button className="btn sm" onClick={() => controller?.abort()}>{t('shell.assistant.stop')}</button>
            : <button className="btn sm primary" disabled={!input.trim()} onClick={send} data-assistant-send>{t('shell.assistant.send')}</button>}
        </div>
      </div>
    </aside>
  );
}

function MessageView({ m }: { m: Msg }) {
  const { t } = useI18n();
  const numbered = useMemo(() => numberCitations(m.text, m.streaming ? [] : m.citations ?? []), [m.text, m.citations, m.streaming]);
  if (m.role === 'user') return <div className="assistant-msg user">{m.text}</div>;
  return (
    <div className="assistant-msg bot" data-assistant-msg={m.mode ?? 'pending'}>
      <div className="meta">
        <strong>{t('shell.assistant.bot')}</strong>
        {m.mode && <span className="badge">{m.mode === 'live' ? `${t('shell.assistant.liveBadge')} · ${m.model ?? ''}` : t('shell.assistant.offlineBadge')}</span>}
      </div>
      <div className="md"><Markdown source={numbered.text || (m.streaming ? '' : '…')} />{m.streaming && <span className="caret" />}</div>
      {m.error && <div className="hint" style={{ color: 'var(--critical)' }}>{t('shell.assistant.error', { message: m.error })}</div>}
      {!m.streaming && numbered.order.length > 0 && (
        <div className="assistant-cites" data-citations>
          <span className="hint" style={{ fontSize: 11 }}>{t('shell.assistant.citations')}:</span>
          {numbered.order.map((id, i) => (
            <button key={id} className="cite-chip" onClick={() => openCitation(id)} title={id} data-cite={id}>{i + 1} · {m.labels?.[id] ?? id}</button>
          ))}
        </div>
      )}
      {!m.streaming && !!m.invalid?.length && <div className="hint" style={{ fontSize: 11 }}>{t('shell.assistant.invalidCitations', { n: m.invalid.length })}</div>}
    </div>
  );
}

function AssistantSettings() {
  const { t } = useI18n();
  const serverOnline = useApp((s) => s.serverOnline);
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [source, setSource] = useState('');
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!serverOnline) return;
    void collabApi.llmSettings().then((r) => {
      if (r.status !== 200) return;
      setBaseUrl(r.body.baseUrl ?? '');
      setModel(r.body.model ?? '');
      setHasKey(r.body.hasApiKey);
      setSource(`${r.body.source.baseUrl} / ${r.body.source.model}`);
    }).catch(() => undefined);
  }, [serverOnline]);

  if (!serverOnline) return <div className="assistant-settings hint">{t('shell.assistant.settingsNeedServer')}</div>;

  const save = async (): Promise<boolean> => {
    const patch: { baseUrl: string | null; model: string | null; apiKey?: string } = { baseUrl: baseUrl.trim() || null, model: model.trim() || null };
    if (apiKey) patch.apiKey = apiKey;
    const r = await collabApi.saveLlmSettings(patch);
    if (r.status !== 200) {
      setResult({ ok: false, text: r.body.error ?? String(r.status) });
      return false;
    }
    setApiKey('');
    setHasKey(r.body.hasApiKey);
    setSource(`${r.body.source.baseUrl} / ${r.body.source.model}`);
    return true;
  };

  const test = async () => {
    setBusy(true);
    setResult(null);
    if (await save()) {
      await useAssistant.getState().refreshStatus();
      const st = useAssistant.getState().status;
      setResult(st?.available
        ? { ok: true, text: t('shell.assistant.testOk', { models: st.models.map((m) => `${m.id}${m.maxModelLen ? ` (${m.maxModelLen.toLocaleString()} ctx)` : ''}`).join(', ') }) }
        : { ok: false, text: t('shell.assistant.testFail', { error: st?.error ?? 'not configured' }) });
    }
    setBusy(false);
  };

  return (
    <div className="assistant-settings" data-assistant-settings-panel>
      <label>{t('shell.assistant.baseUrl')}<input type="text" value={baseUrl} placeholder="http://127.0.0.1:8001/v1" onChange={(e) => setBaseUrl(e.target.value)} /></label>
      <label>{t('shell.assistant.model')}<input type="text" value={model} placeholder="lokeshe09/gemma-4-26B-A4B-it-INT8" onChange={(e) => setModel(e.target.value)} /></label>
      <label>{t('shell.assistant.apiKey')}<input type="password" value={apiKey} autoComplete="off" placeholder={hasKey ? '••••••••' : ''} onChange={(e) => setApiKey(e.target.value)} /></label>
      {hasKey && (
        <div className="row" style={{ gap: 6 }}>
          <span className="hint" style={{ flex: 1 }}>{t('shell.assistant.apiKeySet')}</span>
          <button className="btn sm ghost" onClick={() => void collabApi.saveLlmSettings({ apiKey: null }).then(() => setHasKey(false))}>{t('shell.assistant.clearKey')}</button>
        </div>
      )}
      <div className="row" style={{ gap: 6 }}>
        <span className="hint" style={{ flex: 1 }}>{source ? t('shell.assistant.settingsSource', { source }) : ''}</span>
        <button className="btn sm" disabled={busy} onClick={() => void save().then((ok) => ok && useApp.getState().notify(t('shell.assistant.settingsSaved'), 'ok'))}>{t('shell.assistant.saveSettings')}</button>
        <button className="btn sm primary" disabled={busy} onClick={() => void test()} data-assistant-test>{t('shell.assistant.test')}</button>
      </div>
      {result && <div className="hint" style={{ color: result.ok ? 'var(--good)' : 'var(--critical)' }} data-assistant-test-result>{result.text}</div>}
    </div>
  );
}
