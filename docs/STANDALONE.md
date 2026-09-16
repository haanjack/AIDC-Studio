# Standalone distribution — recommendation (DECISIONS-v2 #13)

Status: research recommendation, not yet built. Source: `docs/research/r2-platform.md` §6 (measured on this host, 2026-09-15). Labels: `official-config` = Node/vendor docs, `derived (host-measured)` = measured here, `estimate` = not measured.

## 1. What "standalone" has to deliver

AIDC Studio today is a Fastify server (`apps/server`) plus a Vite-built React app (`apps/web/dist`). The server provides the project store, version history, advisory locks, zip exports, the thermal job runner and the LLM proxy. A standalone build must keep all of these, run without a Node/npm toolchain on the target machine, and keep one stable browser origin so `localStorage` (UI language, display name, offline project copy) survives restarts.

## 2. Host facts (measured)

| Fact | Value | Label |
|---|---|---|
| Node on this host | v24.20.0 (LTS "Krypton"), linux x64, npm 11.19.0, ICU 78.3 | derived (host-measured) |
| `node --build-sea` | "bad option" on v24; added in **v25.5.0** | official-config |
| SEA on Node 24 | Stability 1.1; **CommonJS entry only** (`mainFormat: "module"` wrote a blob but the binary failed to load the ES module) | official-config + derived (host-measured) |
| `node:sea` API | `isSea`, `getAsset`, `getRawAsset`, `getAssetAsBlob`, `getAssetKeys` (≥ 24.8) | official-config |
| Supported SEA targets | Windows, macOS **arm64 only**, Linux (not Alpine, not s390x) | official-config |
| Proof of concept | Fastify 5 + 2 embedded assets, esbuild → CJS 1,427,801 B, blob 1,525,949 B, postject into node → **128,060,608 B** executable; `/api/health` → `{"ok":true,"sea":true}`, `/` served embedded `index.html` | derived (host-measured) |
| Real server bundle | `apps/server/src/main.ts` bundles as ESM without errors: 2,760,576 B from 455 inputs | derived (host-measured) |
| Asset volume | `apps/web/dist` 24 M, `apps/web/public/assets` 21 M; no external asset pack is needed (the product ships only its own generated models and a CC0 sky map since 2026-09-15) | derived (host-measured) |

## 3. Options

| Option | Verdict | Why |
|---|---|---|
| **Node SEA single binary** (bundled Fastify + embedded `dist` + public assets; opens the default browser at `http://127.0.0.1:<port>`) | **Recommended** | One file per OS/arch (~130 MB binary + ~45 MB assets, estimate). Same code path as the server deployment, so projects, versions, locks, exports and the LLM proxy all work. Only esbuild + postject are needed. |
| Pure static build (`dist` zip) | Secondary artefact | Tiny, but `file://` does not work: Vite emits module scripts and ES-module workers, and MDN documents the CORS failure. It still needs an HTTP server and loses every server feature. `localStorage` is per origin including port. |
| Electron 44.3.0 | Only on a concrete desktop requirement | 122,830,582 B runtime download before app code (measured). Consistent Chromium GPU stack, but a security-hardening and installer burden. |
| Tauri 2 | Not recommended | Linux uses webkit2gtk, so WebGL behaviour varies per OS (estimate). It would still need the Node server as a sidecar binary, i.e. the SEA build anyway. |

## 4. Build plan (SEA, Node 24)

1. **Entry refactor** (no behaviour change for the server deployment):
   - wrap the top-level `await` in `apps/server/src/main.ts` in `async function main()`, because esbuild rejects top-level await in CJS output;
   - `paths.ts`: when `require('node:sea').isSea()` is true, put data in the user profile (`$XDG_DATA_HOME/aidc-studio`, `%APPDATA%\AIDC Studio`, `~/Library/Application Support/AIDC Studio`) and read everything else from SEA assets.
2. **Static files**: replace `@fastify/static` with an asset route over `sea.getRawAsset(key)` plus a content-type map (as in the PoC). Alternative: extract the assets to a versioned cache directory on first start and keep `@fastify/static`.
3. **Thermal worker**: `new Worker(new URL('./thermal-worker.ts', import.meta.url))` and the dynamic import of `packages/thermal` do not survive bundling. Embed a pre-bundled worker as an asset and start it with `new Worker(code, { eval: true })`, or drop server-side thermal in standalone (the browser already runs `thermal.worker.ts`).
4. **Exports**: `export-zip.ts` reads `engines/` templates and `public/assets/models/*.glb` from disk; embed them as assets.
5. **Bundle**: `esbuild apps/server/src/main.ts --bundle --platform=node --format=cjs --outfile=build/sea/server.cjs`.
6. **Blob**: `sea-config.json` = `{ "main": "build/sea/server.cjs", "output": "build/sea/blob", "useCodeCache": true, "disableExperimentalSEAWarning": true, "assets": { "dist/…": "…" } }` → `node --experimental-sea-config sea-config.json`.
7. **Inject**: copy the `node` binary, then `npx postject aidc-studio NODE_SEA_BLOB build/sea/blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`. The harmless warning "Can't find string offset for section name '.note.100'" was seen. macOS adds `--macho-segment-name NODE_SEA` and re-signing; Windows needs signtool.
8. **Run**: fixed default port (`PORT`, default 8787) so the browser origin and its `localStorage` stay stable; `HOST=127.0.0.1` by default; open the browser unless `--no-open`.
9. **Targets**: linux-x64, win-x64, macOS-arm64. Build per target on that OS (or a CI matrix).

When the project moves to a Node release with `--build-sea` (v25.5.0+) and `useVfs` is released (Stability 1.0, `added: REPLACEME` on the main-branch docs), switch steps 6–7 to `node --build-sea` and consider keeping `@fastify/static` over the virtual file system.

## 5. Configuration in standalone mode

| Setting | How |
|---|---|
| Data directory | user profile (above); override with `AIDC_DATA_DIR` |
| LLM endpoint | env `LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY`, or the assistant settings panel (stored in `<data>/settings/llm.json`, key server-side only) |
| LAN sharing | bind `HOST=0.0.0.0` and set `AIDC_SHARED_SECRET`; there are no accounts |
| Third-party asset packs | none required (removed 2026-09-15; see NOTICE) |

## 6. Open questions (consultant)

- OS/arch set and code-signing certificates (Windows Authenticode, Apple Developer ID).
- Whether server-side thermal is needed in standalone (the browser worker covers interactive runs).
- Whether an Electron shell is wanted for file associations or kiosk use.
