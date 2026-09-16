# Standalone Distribution

## Status

Standalone packaging is designed but is not yet part of the release build. The supported deployment today is the Fastify server plus the Vite-built web application, run directly with Node.js or through Docker.

This document defines the target behaviour and recommended packaging architecture for a desktop-like distribution that does not require users to install Node.js or npm.

## Required behaviour

A standalone build must preserve the complete server-backed application:

- project storage and project administration;
- automatic and named version history;
- advisory edit locks and optimistic save conflicts;
- server-side export ZIPs and document generation;
- server-side thermal jobs where enabled;
- optional local-LLM proxy and server-side API-key storage;
- all generic public assets and exporter templates;
- a stable browser origin so browser settings and offline recovery remain available across restarts.

Opening `index.html` through `file://` is not sufficient because the application uses module scripts, workers, API endpoints, and origin-scoped browser storage.

## Recommended package shape

The preferred distribution is one signed launcher per supported operating system and architecture. The launcher contains or accompanies:

1. the bundled Fastify server;
2. the built web application;
3. the public generic models and credits;
4. engine/export templates;
5. a writable per-user data directory;
6. a small bootstrap that starts the loopback server and opens the default browser.

A Node.js Single Executable Application (SEA) is the preferred implementation when the selected Node.js release supports the required module format, worker loading, embedded assets, and target platform. A packaged Node runtime plus bundled application directory is the fallback. Electron or Tauri should be introduced only for a concrete native-window, kiosk, file-association, or GPU-compatibility requirement.

## Runtime layout

```text
standalone launcher
├── server bundle
├── web application assets
├── generic GLB/USD assets and credits
├── export templates
└── bootstrap
    ├── resolves the user data directory
    ├── binds to 127.0.0.1 by default
    ├── chooses or validates the configured port
    ├── starts the HTTP server
    └── opens the default browser unless disabled
```

## Data directories

Default writable locations should follow operating-system conventions:

| Platform | Default location |
|---|---|
| Linux | `$XDG_DATA_HOME/aidc-studio`, or `~/.local/share/aidc-studio` |
| Windows | `%APPDATA%\AIDC Studio` |
| macOS | `~/Library/Application Support/AIDC Studio` |

`AIDC_DATA_DIR` should override the default. Application binaries and embedded assets must remain read-only; projects, versions, settings, logs, and generated outputs belong in the writable data directory.

## Build design

1. Build the web application with the existing Vite configuration.
2. Bundle the server entry and dependencies for the selected Node.js runtime.
3. Bundle the thermal worker separately; do not rely on source-file URLs after packaging.
4. Collect the web build, generic public assets, engine templates, notices, and credits through an explicit allowlist.
5. Embed those files in the executable or place them in a signed, versioned resource directory.
6. Implement a read-only asset provider for static web and export files.
7. Resolve all writable paths from the per-user data root.
8. Bind to loopback by default and retain a stable configured origin.
9. Produce platform-specific signed artifacts in CI.
10. Run application, export, persistence, worker, licence-notice, and publication-boundary smoke tests against the packaged result.

## Known packaging constraints

- Server code and dependencies must use a module format supported by the chosen SEA or bundler path.
- Worker entry points and dynamic imports must be pre-bundled or loaded from extracted resources.
- Exporters currently read some templates and model files from disk; a standalone build must route those reads through embedded resources or a versioned extraction cache.
- Native code signing and notarisation differ by platform and cannot be treated as a post-release detail.
- Browser storage is origin-scoped. Randomising the port on every launch can make local settings appear lost.
- Server-side thermal is optional for interactive use because the browser worker already supports CFD-lite, but package parity should be an explicit release decision.

## Configuration

| Setting | Behaviour |
|---|---|
| Host | `127.0.0.1` by default; use an explicit LAN bind only when sharing is intended |
| Port | Stable configured port, default `8787`; allow an override through `PORT` |
| Data directory | OS-specific user profile; override through `AIDC_DATA_DIR` |
| LLM endpoint | `LLM_BASE_URL`, `LLM_MODEL`, and `LLM_API_KEY`, or the in-app server settings |
| LAN protection | Require `AIDC_SHARED_SECRET` when exposed beyond loopback |
| Browser launch | Enabled by default; provide a `--no-open` option |

## Release targets

Initial targets should be selected according to actual users and signing availability. A practical starting set is Linux x64, Windows x64, and macOS arm64. Each target should be built and tested on its native CI runner unless the packaging tool explicitly guarantees cross-target output.

## Release acceptance criteria

A standalone artifact is ready only when it can:

- start without a system Node.js/npm installation;
- retain projects and settings across upgrades;
- create, save, version, compare, restore, and export a project;
- run browser CFD-lite and the selected server thermal path;
- generate documents, drawings, and deployment ZIPs;
- serve every public asset with the correct content type;
- pass the licence-notice and publication-boundary checks;
- bind only to loopback by default;
- uninstall without deleting user project data unless explicitly requested.
