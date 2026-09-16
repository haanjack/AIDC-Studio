import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NEUTRAL_REFERENCE_NAME, type Project } from '../../../packages/core/src/index.ts';
import { buildServer } from '../src/app.ts';

// Stream D (P4; DECISIONS-v2-2 §I DO-1, DO-7): new-project starting points — the vendor-neutral reference (default), an empty site
// with a standards profile preset (orv3-hpr-liquid preselected), and the vendor sample "NVIDIA reference".

let app: FastifyInstance;
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aidc-server-tpl-'));
  app = await buildServer({ dataDir: join(dir, 'projects'), webDist: join(dir, 'no-dist'), logger: false, seed: false });
});

afterAll(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

const create = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/projects', payload });

describe('POST /api/projects starting points', () => {
  it('reference (default): the vendor-neutral reference with its confirmed standards profile and default name', async () => {
    const res = await create({ pods: 1 });
    expect(res.statusCode).toBe(201);
    const p = res.json() as Project;
    expect(p.name).toBe(NEUTRAL_REFERENCE_NAME);
    expect(p.standards?.id).toBe('orv3-hpr-liquid');
    expect(p.halls[0].layoutPolicy?.templateId).toBe('std-orv3-hpr-liquid-du');
    expect(p.equipment.some((e) => e.catalogId === 'ubb8-oam-dlc-hpr-5x')).toBe(true);
    expect(p.equipment.some((e) => /nvidia|gb300/i.test(e.catalogId))).toBe(false);
  });

  it('nvidia-reference: the vendor sample with its exact name', async () => {
    const res = await create({ template: 'nvidia-reference', pods: 1 });
    expect(res.statusCode).toBe(201);
    const p = res.json() as Project;
    expect(p.name).toBe('NVIDIA reference');
    expect(p.equipment.some((e) => e.catalogId === 'nvidia-gb300-nvl72')).toBe(true);
    expect(p.halls[0].layoutPolicy?.templateId).toBe('rack-scale-liquid-du');
  });

  it('empty + preset: the preset profile and its standard template; default preset orv3-hpr-liquid; unknown presets are refused', async () => {
    const air = (await create({ template: 'empty', preset: 'eia-air', name: 'Air site' })).json() as Project;
    expect(air.standards?.id).toBe('eia-air');
    expect(air.halls[0].layoutPolicy?.templateId).toBe('std-eia-air-du');
    expect(air.equipment).toEqual([]);
    const def = (await create({ template: 'empty', name: 'Default site' })).json() as Project;
    expect(def.standards?.id).toBe('orv3-hpr-liquid');
    const bad = await create({ template: 'empty', preset: 'no-such-preset', name: 'Bad preset' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: 'unknown-preset' });
    expect((await create({ template: 'gb300', name: 'Bad template' })).statusCode).toBe(400);
  });
});
