// v2 2차 contract: the T8 route modules are registered from app.ts. The 501 stubs are now live
// (behaviour tests: llm.test.ts, collab.test.ts); this file keeps a route smoke test + the env-config pin.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/app.ts';
import { llmConfigFromEnv } from '../src/llm.ts';

let app: FastifyInstance;
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aidc-contract22-'));
  app = await buildServer({ dataDir: join(dir, 'projects'), webDist: join(dir, 'no-dist'), logger: false, seed: false });
});

afterAll(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

describe('v2 2차 T8 routes are live', () => {
  it.each([
    ['GET', '/api/llm/status'],
    ['GET', '/api/llm/settings'],
    ['GET', '/api/projects/p1/versions'],
    ['GET', '/api/projects/p1/versions/v1'],
    ['GET', '/api/projects/p1/diff?from=v1&to=current'],
    ['GET', '/api/projects/p1/lock'],
    ['DELETE', '/api/projects/p1/lock'],
  ] as const)('%s %s is not a 501 stub', async (method, url) => {
    const res = await app.inject({ method, url });
    expect(res.statusCode).not.toBe(501);
    expect(res.statusCode).toBeLessThan(500);
  });

  it('llmConfigFromEnv reads LLM_BASE_URL / LLM_MODEL / LLM_API_KEY', () => {
    expect(llmConfigFromEnv({ LLM_BASE_URL: 'http://127.0.0.1:8001/v1', LLM_MODEL: 'm', LLM_API_KEY: '' })).toEqual({ baseUrl: 'http://127.0.0.1:8001/v1', model: 'm', apiKey: undefined });
  });
});
