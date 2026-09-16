// LLM Q&A proxy (stream T8, DECISIONS-v2-2 §B/§C, r2-platform.md §3).
//
// Endpoint: any OpenAI-compatible server (for example a local vLLM instance; base URL and model are deployment settings).
// Configuration: env LLM_BASE_URL / LLM_MODEL / LLM_API_KEY, overridden field by field by <dataDir>/../settings/llm.json
// (editable from the UI through PUT /api/llm/settings; the API key is stored server-side only and never returned).
//
// Data policy: the browser never calls the model. This server sends the question, the retrieved glossary/help blocks
// and — only when the client ticks "include current screen" — the page context and a compact analysis summary, to the
// configured endpoint and nowhere else. Prompts are not logged. /api/llm/status reports whether the endpoint is
// loopback, LAN or remote so the UI can warn before project data leaves the network.
//
// Routes:
//   GET  /api/llm/status    → { configured, available, baseUrl, host, locality, model, models[], maxModelLen, hasApiKey, source, error? }
//   GET  /api/llm/settings  → { baseUrl, model, hasApiKey, source, env: {…} }
//   PUT  /api/llm/settings  { baseUrl?, model?, apiKey? } (null/'' clears the override)
//   POST /api/chat          { question, locale, page?, history?, includePage?, pageContext?, analysisBlocks? } → text/event-stream
//   POST /api/llm/ask       alias of /api/chat (contract route)
// SSE events: `meta` { mode: 'live'|'offline', model?, reason?, labels } · `delta` { text } · `error` { status?, message }
//             · `done` { mode, text, citations, invalid, labels, usage?, finishReason? }
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  ASSISTANT_LIMITS, buildAssistantPrompt, offlineAnswer, validateCitations, type AssistantRequest, type Locale,
} from '../../../packages/core/src/index.ts';
import type { RouteContext } from './app.ts';

export interface LlmConfig {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}

export function llmConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  return { baseUrl: env.LLM_BASE_URL || undefined, model: env.LLM_MODEL || undefined, apiKey: env.LLM_API_KEY || undefined };
}

/** Probe timeout for GET {base}/models (DECISIONS task: 3 s). */
export const LLM_PROBE_TIMEOUT_MS = 3_000;
/** Time allowed until the upstream answers with headers (long prompts on a busy server) — estimate. */
export const LLM_HEADERS_TIMEOUT_MS = 60_000;
/** Hard cap for one streamed answer — estimate. */
export const LLM_STREAM_TIMEOUT_MS = 5 * 60_000;
/** Sampling temperature for grounded Q&A (lower than Gemma's 1.0 chat default to reduce invented numbers) — estimate. */
export const LLM_TEMPERATURE = 0.3;

export type Locality = 'loopback' | 'lan' | 'remote' | 'invalid';

/** Classify an endpoint host (loopback / private LAN / remote) for the data-egress warning. */
export function endpointLocality(baseUrl: string | undefined): Locality {
  if (!baseUrl) return 'invalid';
  let host: string;
  try {
    host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return 'invalid';
  }
  if (host === 'localhost' || host === '::1' || /^127\./.test(host) || host === '0.0.0.0') return 'loopback';
  if (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^169\.254\./.test(host)) return 'lan';
  if (/^(fc|fd)[0-9a-f]{2}:/.test(host) || /^fe80:/.test(host) || host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.internal') || !host.includes('.')) return 'lan';
  return 'remote';
}

export function normalizeBaseUrl(url: string): string | null {
  const u = url.trim().replace(/\/+$/, '');
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return u;
  } catch {
    return null;
  }
}

interface SettingsFile {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  updatedAt?: string;
}

interface Effective {
  cfg: LlmConfig;
  source: { baseUrl: 'settings' | 'env' | 'none'; model: 'settings' | 'env' | 'auto'; apiKey: 'settings' | 'env' | 'none' };
}

class LlmSettings {
  constructor(readonly file: string) {}

  async read(): Promise<SettingsFile> {
    try {
      const json = JSON.parse(await readFile(this.file, 'utf8')) as SettingsFile;
      return json && typeof json === 'object' ? json : {};
    } catch {
      return {};
    }
  }

  async write(s: SettingsFile): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(s, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, this.file);
  }

  async effective(): Promise<Effective> {
    const env = llmConfigFromEnv();
    const file = await this.read();
    return {
      cfg: { baseUrl: file.baseUrl || env.baseUrl, model: file.model || env.model, apiKey: file.apiKey || env.apiKey },
      source: {
        baseUrl: file.baseUrl ? 'settings' : env.baseUrl ? 'env' : 'none',
        model: file.model ? 'settings' : env.model ? 'env' : 'auto',
        apiKey: file.apiKey ? 'settings' : env.apiKey ? 'env' : 'none',
      },
    };
  }
}

const authHeaders = (cfg: LlmConfig): Record<string, string> => (cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {});

interface ProbeResult {
  ok: boolean;
  models: { id: string; maxModelLen?: number }[];
  error?: string;
}

async function probeModels(cfg: LlmConfig, timeoutMs = LLM_PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  if (!cfg.baseUrl) return { ok: false, models: [], error: 'not configured' };
  try {
    const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/models`, { headers: authHeaders(cfg), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, models: [], error: `HTTP ${res.status}` };
    const body = (await res.json()) as { data?: { id?: unknown; max_model_len?: unknown }[] | null };
    const models = (body.data ?? [])
      .filter((m) => typeof m?.id === 'string')
      .map((m) => ({ id: m.id as string, ...(typeof m.max_model_len === 'number' ? { maxModelLen: m.max_model_len } : {}) }));
    return { ok: true, models };
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    return { ok: false, models: [], error: err.name === 'TimeoutError' ? `timeout after ${timeoutMs} ms` : err.cause?.code ?? err.message };
  }
}

function hostOf(url?: string): string {
  try {
    return url ? new URL(url).host : '';
  } catch {
    return '';
  }
}

function parseChatBody(body: unknown): AssistantRequest | string {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.question !== 'string' || !b.question.trim()) return 'question (non-empty string) is required';
  if (b.question.length > ASSISTANT_LIMITS.questionChars) return `question exceeds ${ASSISTANT_LIMITS.questionChars} characters`;
  const history = Array.isArray(b.history) ? (b.history as unknown[]) : [];
  if (history.length > 50) return 'history too long';
  const analysisBlocks = Array.isArray(b.analysisBlocks) ? (b.analysisBlocks as unknown[]) : [];
  if (analysisBlocks.length > 50) return 'too many analysis blocks';
  return {
    question: b.question,
    locale: (b.locale === 'ko' ? 'ko' : 'en') as Locale,
    page: typeof b.page === 'string' ? b.page.slice(0, 40) : undefined,
    includePage: b.includePage === true,
    pageContext: typeof b.pageContext === 'string' ? b.pageContext : undefined,
    history: history
      .map((h) => h as { role?: unknown; content?: unknown })
      .filter((h) => (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string')
      .map((h) => ({ role: h.role as 'user' | 'assistant', content: h.content as string })),
    analysisBlocks: analysisBlocks
      .map((x) => x as { id?: unknown; title?: unknown; text?: unknown })
      .filter((x) => typeof x.id === 'string' && typeof x.text === 'string')
      .map((x) => ({ id: x.id as string, title: typeof x.title === 'string' ? x.title : (x.id as string), text: x.text as string })),
  };
}

type Send = (event: string, data: unknown) => void;

function startSse(req: FastifyRequest, reply: FastifyReply): { send: Send; end: () => void; closed: () => boolean; onClose: (fn: () => void) => void } {
  reply.hijack();
  const raw = reply.raw;
  const origin = req.headers.origin;
  raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    ...(origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {}),
  });
  let ended = false;
  let closed = false;
  const listeners: (() => void)[] = [];
  raw.on('close', () => {
    closed = true;
    if (!ended) listeners.forEach((fn) => fn());
  });
  return {
    send: (event, data) => {
      if (closed || ended) return;
      raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    end: () => {
      if (ended) return;
      ended = true;
      if (!closed) raw.end();
    },
    closed: () => closed,
    onClose: (fn) => listeners.push(fn),
  };
}

function sendOffline(send: Send, parsed: AssistantRequest, reason: string) {
  const ans = offlineAnswer(parsed.question, parsed.locale, parsed.page);
  send('meta', { mode: 'offline', reason, labels: ans.labels });
  send('delta', { text: ans.text });
  send('done', { mode: 'offline', reason, text: ans.text, citations: ans.citations, invalid: [], labels: ans.labels });
}

export async function registerLlmRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const settings = new LlmSettings(resolve(ctx.dataDir, '..', 'settings', 'llm.json'));

  app.get('/api/llm/status', async () => {
    const { cfg, source } = await settings.effective();
    const probe = await probeModels(cfg);
    const model = cfg.model ?? probe.models[0]?.id;
    const served = probe.models.find((m) => m.id === model);
    const modelMissing = probe.ok && !!cfg.model && !served;
    return {
      configured: !!cfg.baseUrl,
      available: probe.ok && !!model && !modelMissing,
      baseUrl: cfg.baseUrl ?? null,
      host: hostOf(cfg.baseUrl),
      locality: endpointLocality(cfg.baseUrl),
      model: model ?? null,
      models: probe.models,
      maxModelLen: served?.maxModelLen ?? null,
      hasApiKey: !!cfg.apiKey,
      source,
      ...(probe.error ? { error: probe.error } : modelMissing ? { error: `model '${cfg.model}' is not served by the endpoint` } : {}),
    };
  });

  app.get('/api/llm/settings', async () => {
    const file = await settings.read();
    const env = llmConfigFromEnv();
    const { cfg, source } = await settings.effective();
    return {
      baseUrl: cfg.baseUrl ?? null,
      model: cfg.model ?? null,
      hasApiKey: !!cfg.apiKey,
      source,
      override: { baseUrl: file.baseUrl ?? null, model: file.model ?? null, hasApiKey: !!file.apiKey, updatedAt: file.updatedAt ?? null },
      env: { baseUrl: env.baseUrl ?? null, model: env.model ?? null, hasApiKey: !!env.apiKey },
      locality: endpointLocality(cfg.baseUrl),
    };
  });

  app.put('/api/llm/settings', { bodyLimit: 16 * 1024 }, async (req, reply) => {
    // fix v2 2차 (QA security): repointing the assistant sends every user's page context to that host — only a loopback client, a
    // client carrying the LAN shared secret (AIDC_SHARED_SECRET, checked for all /api/* in locks.ts), or LLM_SETTINGS_WRITABLE=1
    // may change it; remote endpoints additionally need LLM_ALLOW_REMOTE=1
    const secretSet = !!process.env.AIDC_SHARED_SECRET;
    const loopbackClient = endpointLocality(`http://${String(req.ip ?? '').replace(/^::ffff:/, '').replace(/^::1$/, '[::1]')}/`) === 'loopback';
    if (process.env.LLM_SETTINGS_WRITABLE !== '1' && !secretSet && !loopbackClient) {
      return reply.code(403).send({ error: 'LLM settings are read-only from the LAN: set AIDC_SHARED_SECRET (and send x-aidc-secret) or LLM_SETTINGS_WRITABLE=1 on the server' });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body !== 'object' || Array.isArray(body)) return reply.code(400).send({ error: 'body must be an object' });
    const next = await settings.read();
    for (const key of ['baseUrl', 'model', 'apiKey'] as const) {
      if (!(key in body)) continue;
      const v = body[key];
      if (v === null || v === '') {
        delete next[key];
        continue;
      }
      if (typeof v !== 'string' || v.length > 1000) return reply.code(400).send({ error: `${key} must be a string (≤ 1000 chars) or null` });
      if (key === 'baseUrl') {
        const n = normalizeBaseUrl(v);
        if (!n) return reply.code(400).send({ error: 'baseUrl must be an http(s) URL, e.g. http://127.0.0.1:8001/v1' });
        if (endpointLocality(n) === 'remote' && process.env.LLM_ALLOW_REMOTE !== '1') return reply.code(400).send({ error: 'remote LLM endpoints are disabled (project data would leave the network) — set LLM_ALLOW_REMOTE=1 on the server to allow them', remote: true });
        next.baseUrl = n;
      } else next[key] = v.trim();
    }
    next.updatedAt = new Date().toISOString();
    await settings.write(next);
    const { cfg, source } = await settings.effective();
    return { baseUrl: cfg.baseUrl ?? null, model: cfg.model ?? null, hasApiKey: !!cfg.apiKey, source, locality: endpointLocality(cfg.baseUrl) };
  });

  const chat = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = parseChatBody(req.body);
    if (typeof parsed === 'string') return reply.code(400).send({ error: parsed });
    const { cfg } = await settings.effective();
    const sse = startSse(req, reply);
    try {
      if (!cfg.baseUrl) {
        sendOffline(sse.send, parsed, 'not-configured');
        return;
      }
      let model = cfg.model;
      if (!model) {
        const probe = await probeModels(cfg);
        model = probe.models[0]?.id;
        if (!model) {
          sendOffline(sse.send, parsed, probe.error ? `unreachable: ${probe.error}` : 'no-model');
          return;
        }
      }
      const prompt = buildAssistantPrompt(parsed);
      const allowed = Object.keys(prompt.labels);
      const ctrl = new AbortController();
      sse.onClose(() => ctrl.abort(new Error('client disconnected')));
      const headersTimer = setTimeout(() => ctrl.abort(new Error(`no response within ${LLM_HEADERS_TIMEOUT_MS} ms`)), LLM_HEADERS_TIMEOUT_MS);
      const streamTimer = setTimeout(() => ctrl.abort(new Error(`answer exceeded ${LLM_STREAM_TIMEOUT_MS} ms`)), LLM_STREAM_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...authHeaders(cfg) },
          body: JSON.stringify({
            model,
            messages: prompt.messages,
            stream: true,
            stream_options: { include_usage: true },
            max_tokens: ASSISTANT_LIMITS.maxTokens,
            temperature: LLM_TEMPERATURE,
          }),
          signal: ctrl.signal,
        });
      } catch (e) {
        clearTimeout(headersTimer);
        clearTimeout(streamTimer);
        if (sse.closed()) return;
        const err = e as Error & { cause?: { code?: string } };
        sendOffline(sse.send, parsed, `unreachable: ${err.cause?.code ?? err.message}`);
        return;
      }
      clearTimeout(headersTimer);
      if (!res.ok || !res.body) {
        clearTimeout(streamTimer);
        let message = `HTTP ${res.status}`;
        try {
          const j = (await res.json()) as { error?: { message?: string } | string; message?: string };
          message = typeof j.error === 'string' ? j.error : j.error?.message ?? j.message ?? message;
        } catch {
          /* non-JSON error body */
        }
        sse.send('error', { status: res.status, message: message.slice(0, 500) });
        sendOffline(sse.send, parsed, `upstream-error ${res.status}`);
        return;
      }
      sse.send('meta', { mode: 'live', model, labels: prompt.labels });
      let text = '';
      let usage: unknown;
      let finishReason: string | undefined;
      let upstreamError: string | undefined;
      const decoder = new TextDecoder();
      let buf = '';
      const handleEvent = (chunk: string): boolean => {
        for (const line of chunk.split(/\r?\n/)) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data) continue;
          if (data === '[DONE]') return true;
          let obj: { error?: { message?: string } | string; choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[]; usage?: unknown };
          try {
            obj = JSON.parse(data);
          } catch {
            continue;
          }
          if (obj.error) {
            upstreamError = typeof obj.error === 'string' ? obj.error : obj.error.message ?? 'upstream error';
            continue;
          }
          const choice = obj.choices?.[0];
          const piece = choice?.delta?.content;
          if (piece) {
            text += piece;
            sse.send('delta', { text: piece });
          }
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          if (obj.usage) usage = obj.usage;
        }
        return false;
      };
      try {
        const reader = res.body.getReader();
        let done = false;
        while (!done) {
          const r = await reader.read();
          if (r.done) break;
          buf += decoder.decode(r.value, { stream: true });
          let idx: number;
          while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
            const chunk = buf.slice(0, idx);
            buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '');
            if (handleEvent(chunk)) {
              done = true;
              break;
            }
          }
        }
        if (!done && buf.trim()) handleEvent(buf);
        if (done) await reader.cancel().catch(() => undefined);
      } catch (e) {
        if (sse.closed()) return;
        upstreamError = (e as Error).message;
      } finally {
        clearTimeout(streamTimer);
      }
      if (upstreamError) sse.send('error', { message: upstreamError.slice(0, 500) });
      // defensive: drop a leading thought channel if a reasoning template leaked into content
      const visible = text.replace(/^\s*<\|channel>thought[\s\S]*?<channel\|>/, '');
      const checked = validateCitations(visible, allowed);
      sse.send('done', { mode: 'live', model, text: checked.text, citations: checked.valid, invalid: checked.invalid, labels: prompt.labels, usage, finishReason });
    } catch (e) {
      sse.send('error', { message: (e as Error).message });
    } finally {
      sse.end();
    }
  };

  app.post('/api/chat', { bodyLimit: ASSISTANT_LIMITS.bodyBytes }, chat);
  app.post('/api/llm/ask', { bodyLimit: ASSISTANT_LIMITS.bodyBytes }, chat);
}
