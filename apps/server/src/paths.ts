import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = resolve(SERVER_DIR, '../..');

export const DEFAULTS = {
  dataDir: process.env.AIDC_DATA_DIR ?? resolve(REPO_ROOT, 'data/projects'),
  webDist: process.env.AIDC_WEB_DIST ?? resolve(REPO_ROOT, 'apps/web/dist'),
  publicAssets: process.env.AIDC_PUBLIC_ASSETS ?? resolve(REPO_ROOT, 'apps/web/public/assets'),
  templatesRoot: resolve(REPO_ROOT, 'engines'),
  thermalModule: resolve(REPO_ROOT, 'packages/thermal/src/index.ts'),
};
