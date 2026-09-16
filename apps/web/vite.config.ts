import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const __dirname = import.meta.dirname;
const API = process.env.AIDC_API ?? 'http://localhost:8787';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@aidc/core': resolve(__dirname, '../../packages/core/src/index.ts'),
      '@aidc/thermal': resolve(__dirname, '../../packages/thermal/src/index.ts'),
    },
  },
  optimizeDeps: { exclude: ['@aidc/core', '@aidc/thermal'] },
  worker: { format: 'es' },
  server: {
    port: 5173,
    proxy: { '/api': { target: API, changeOrigin: true } },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        viewer: resolve(__dirname, 'viewer-harness.html'),
      },
    },
  },
});
