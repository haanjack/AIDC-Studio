# AIDC Studio — web app + API server (OS-independent container image).
#
# Stage "build" installs all dependencies, builds the web bundle and precompiles the API server (TypeScript → JS).
# Stage "runtime" contains production dependencies of @aidc/server only: no TypeScript, Vite, Vitest, tsx, esbuild or
# other build tools (LICENSE-AUDIT M9 / R-1.6). The build context excludes data/, assets/, docs/, tools/, tests and
# screenshots (.dockerignore); no third-party asset pack is copied into or expected by the image.
# Licence files: /app/LICENSE, /app/NOTICE, /app/THIRD_PARTY_NOTICES.md, /app/TRADEMARKS.md
# (the web notices also ship as /app/apps/web/dist/THIRD_PARTY_NOTICES.txt).

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/thermal/package.json packages/thermal/
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build -w @aidc/web
# Precompile the server with esbuild. Output keeps the source layout and file names (apps/server/src/main.ts,
# apps/server/src/thermal-worker.ts, packages/thermal/src/index.ts) because the server resolves the worker and the
# thermal module by those paths; the files contain plain ESM JavaScript, which Node 24 loads unchanged. Code splitting
# gives the worker and the thermal module one shared @aidc/core instance (as in the tsx dev setup).
# npm packages stay external and are installed in the runtime stage.
RUN node_modules/.bin/esbuild apps/server/src/main.ts apps/server/src/thermal-worker.ts packages/thermal/src/index.ts \
      --bundle --splitting --platform=node --format=esm --target=node24 \
      --external:fastify --external:@fastify/cors --external:@fastify/static --external:jszip \
      --outbase=. --outdir=/out '--out-extension:.js=.ts' '--chunk-names=apps/server/src/chunks/[name]-[hash]' \
      --log-level=warning

FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    AIDC_DATA_DIR=/data/projects \
    AIDC_PUBLIC_ASSETS=/app/apps/web/dist/assets
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/thermal/package.json packages/thermal/
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/
RUN npm ci --omit=dev --workspace @aidc/server --include-workspace-root=false --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force
COPY --from=build /out/ ./
COPY --from=build /app/apps/web/dist apps/web/dist
COPY engines engines
COPY LICENSE NOTICE THIRD_PARTY_NOTICES.md TRADEMARKS.md ./
RUN mkdir -p /data/projects
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/server/src/main.ts"]
