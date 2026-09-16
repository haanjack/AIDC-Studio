// Scratch-only Vite config that wraps apps/web/vite.config.ts and records, per output chunk,
// which modules were rendered into the production bundle (incl. worker sub-builds).
// It never writes into the repo: output goes to $AIDC_LICENSE_GRAPH_OUT (required).
//
//   AIDC_LICENSE_GRAPH_OUT=/tmp/x node_modules/.bin/vite build --config tools/licenses/vite.license-graph.config.mjs
//   node tools/licenses/scan-npm.mjs --graph /tmp/x/module-graph.json
import { mergeConfig } from 'vite';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import base from '../../apps/web/vite.config.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.AIDC_LICENSE_GRAPH_OUT;
if (!OUT) throw new Error('set AIDC_LICENSE_GRAPH_OUT to a scratch directory (never the repo)');
mkdirSync(OUT, { recursive: true });

const graph = { chunks: {}, graphIds: {} };
function graphPlugin(label) {
  return {
    name: `aidc-license-graph-${label}`,
    buildEnd() {
      graph.graphIds[label] = [...(graph.graphIds[label] ?? []), ...this.getModuleIds()];
    },
    generateBundle(_opts, bundle) {
      for (const [file, c] of Object.entries(bundle)) {
        if (c.type !== 'chunk') { graph.chunks[`${label}:${file}`] = { asset: true }; continue; }
        const modules = {};
        for (const [id, m] of Object.entries(c.modules ?? {})) modules[id] = m.renderedLength;
        graph.chunks[`${label}:${file}`] = { modules };
      }
    },
    closeBundle() {
      writeFileSync(resolve(OUT, 'module-graph.json'), JSON.stringify(graph));
    },
  };
}

export default mergeConfig(base, {
  root: resolve(HERE, '../../apps/web'),
  plugins: [graphPlugin('main')],
  worker: { plugins: () => [graphPlugin('worker')] },
  build: { outDir: resolve(OUT, 'dist'), emptyOutDir: true, copyPublicDir: false },
});
