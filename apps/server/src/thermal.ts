import { Worker } from 'node:worker_threads';
import { DEFAULTS } from './paths.ts';

export class ThermalNotReadyError extends Error {
  statusCode = 501;
}

type Msg = { type: 'progress'; step?: number } | { type: 'done'; result: unknown } | { type: 'not-ready' } | { type: 'error'; message: string };

/** Run the thermal solver in a worker thread (tsx loader flags are inherited through execArgv). */
export function runThermalJob(project: unknown, options: unknown, timeoutMs = 10 * 60_000, modulePath = DEFAULTS.thermalModule, library?: unknown): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const worker = new Worker(new URL('./thermal-worker.ts', import.meta.url), {
      workerData: { project, options, modulePath, library: library ?? null },
      execArgv: process.execArgv,
    });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(Object.assign(new Error(`thermal job timed out after ${timeoutMs} ms`), { statusCode: 504 }));
    }, timeoutMs);
    const finish = () => {
      clearTimeout(timer);
      void worker.terminate();
    };
    worker.on('message', (m: Msg) => {
      if (m.type === 'done') {
        finish();
        resolvePromise(m.result);
      } else if (m.type === 'not-ready') {
        finish();
        reject(new ThermalNotReadyError('thermal solver not available yet (packages/thermal exports no runThermal)'));
      } else if (m.type === 'error') {
        finish();
        reject(new Error(m.message));
      }
    });
    worker.on('error', (e) => {
      finish();
      reject(e);
    });
  });
}

function isTypedArray(v: unknown): v is ArrayBufferView {
  return ArrayBuffer.isView(v) && !(v instanceof DataView);
}

const b64 = (a: ArrayBufferView) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');

/** JSON-safe encoding of a ThermalResult: typed arrays → base64 (little-endian). */
export function encodeThermalResult(result: unknown): Record<string, unknown> {
  const r = (result ?? {}) as Record<string, unknown>;
  const temperature = r.T ?? r.temperature;
  const velocity = r.vel ?? r.velocity;
  const solid = r.solid;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    if (['T', 'temperature', 'vel', 'velocity', 'solid'].includes(k)) continue;
    out[k] = isTypedArray(v) ? { base64: b64(v), type: v.constructor.name } : v;
  }
  out.encoding = {
    temperature: 'Float32Array little-endian, index = i + nx*(j + ny*k)',
    velocity: 'Float32Array little-endian, xyz interleaved per cell',
    solid: 'Uint8Array',
  };
  out.temperature = isTypedArray(temperature) ? b64(temperature) : null;
  out.velocity = isTypedArray(velocity) ? b64(velocity) : null;
  out.solid = isTypedArray(solid) ? b64(solid) : null;
  return out;
}
