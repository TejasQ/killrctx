# Task Plan — dev-onboarding

## Tasks

- [x] TASK-01: [deps] Add `cac`, `chalk`, `ora`, `prompts` to `devDependencies` in `package.json`
- [x] TASK-02: [deps] Run `npm install` to lock the new packages
- [x] TASK-03: [scripts] Add `"init"` and `"setup"` entries to `package.json#scripts`
- [x] TASK-04: [scripts] Create `scripts/setup.mjs` — skeleton with `main()`, banner, and imports
- [x] TASK-05: [scripts] Implement `detectBackends()` — parallel fetch probes with ora spinner
- [deferred] TASK-06: [scripts] Implement `ensureDocker()` — `docker info` probe, Colima auto-install (brew + `colima start`), Docker Desktop pause path, Cancel — superseded by detect-and-connect; see future option in requirements.md
- [deferred] TASK-07: [scripts] Implement `handleNoBackends()` — select menu, download compose files + `docker compose up -d`, poll health endpoint — superseded by detect-and-connect; see future option in requirements.md
- [x] TASK-08: [scripts] Implement `collectKeys()` — invisible prompts per detected backend + ElevenLabs
- [x] TASK-09: [scripts] Implement `writeEnvLocal()` — parse .env.example, merge, backup, write
- [x] TASK-10: [scripts] Implement `launchApp()` — success summary + spawn next dev + signal forwarding
- [x] TASK-11: [scripts] Wire `main()` — call all phases in order with error handling
- [x] TASK-12: [docs] Rewrite README `## Quick start` with `npm run init` as primary path + `<details>` manual block
- [x] TASK-13: [scripts] Simplify `promptBackendChoice()` — running backends only; exit with per-platform start instructions when no backend found
- [x] TASK-14: [scripts] Simplify `collectKeys()` — OpenRAG keys only; remove Workbench credential prompts (Astra/OpenRouter)
- [x] TASK-15: [scripts] Simplify `discoverWorkbenchConfig()` — read-only connect step; remove `isInstall` param and `fixOllamaEndpoints()` call
- [x] TASK-16: [scripts] Remove Docker/install helper functions (`installOpenRAG`, `installWorkbench`, `ensureDocker`, `fixOllamaEndpoints`, `detectInstalledDirs`, `resolveInstalledDir`, `startBackend`, `runDockerCompose`, `pollHealth`, `waitForChild`, `downloadFile`, `sleep`)
- [x] TASK-17: [docs] Update README quick start — start backend → run wizard → open app flow; remove `--skip-docker` from flags docs
- [x] TASK-18: [specs] Update spec files to reflect detect-and-connect direction

## Control-panel rewrite

- [x] TASK-19: [scripts] Add `init:status`, `init:openrag`, `init:workbench`, `init:all`, `init:launch` aliases to `package.json#scripts`
- [x] TASK-20: [scripts] Replace `--skip-launch` with full flag set: `--status`, `--configure <openrag|workbench|all>`, `--launch`, `--force`, `--skip-launch` via cac
- [x] TASK-21: [scripts] Implement persistent numbered menu loop `[1]–[6]`; menu reprints after each action
- [x] TASK-22: [scripts] Add "Already configured — reconfigure? No / Yes" prompt to configure flow; `--force` bypasses it
- [x] TASK-23: [scripts] Add offline warning before key prompts when backend is DOWN; skip Workbench ID discovery when DOWN
- [x] TASK-24: [scripts] Make writes per-backend and incremental; backup `.env.local` once per session only
- [x] TASK-25: [scripts] Drop dead `injectEnvValue()` function
- [x] TASK-26: [housekeeping] Add `.env.local.bak` to `.gitignore`

## Done criteria per task

- **TASK-01/02**: `package.json` devDependencies includes cac@^6, chalk@^5, ora@^8, prompts@^2; `node_modules` updated
- **TASK-03**: `npm run init` and `npm run setup` both resolve to `node scripts/setup.mjs`
- **TASK-04**: `node scripts/setup.mjs` runs without error, prints banner, exits cleanly
- **TASK-05**: Detection runs with spinner, prints ✓/✗ for each backend within 3 s
- **TASK-06** _(deferred)_: When Docker absent, menu shows Colima/Desktop/Cancel; Colima path runs brew install + colima start and re-checks docker info; Docker Desktop path pauses and re-checks; Cancel exits cleanly
- **TASK-07** _(deferred)_: No-backend path shows OpenRAG/Workbench/Skip menu; each install path downloads compose + runs docker compose up -d + polls health; Skip continues
- **TASK-08**: Prompts shown only for detected backends; keys not echoed
- **TASK-09**: `.env.local` written with correct values; backup created if pre-existing file exists
- **TASK-10**: After write, summary prints set/skipped keys; `next dev` starts and Ctrl-C propagates
- **TASK-11**: Full golden path (detect → choose backend → collect → write → launch) works end-to-end
- **TASK-12**: README leads with `npm run init`; `<details>` block holds old manual steps; no broken links
- **TASK-13**: When both backends absent, wizard prints start instructions and exits 0; when one or more running, shows only those in selection menu
- **TASK-14**: Workbench path shows connection URL prompt only; no Astra/OpenRouter key prompts
- **TASK-15**: `discoverWorkbenchConfig()` calls read-only Workbench API; user picks by name; no mutations; `fixOllamaEndpoints()` not called
- **TASK-16**: Script is ~200 lines; no Docker-related code; no child-process spawning for installs; `--skip-docker` flag absent
- **TASK-17**: README quick start reads: start backend → run wizard → open app; no mention of auto-install or Colima
- **TASK-18**: `requirements.md` and `design.md` reflect detect-and-connect; install path preserved under "Future option"
