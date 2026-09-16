import { buildServer } from './app.ts';

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '0.0.0.0';

const app = await buildServer({ logger: true, seed: process.env.AIDC_SEED !== '0' });
await app.listen({ port, host });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    app.log.info(`received ${sig}, shutting down`);
    void app.close().then(() => process.exit(0));
  });
}
