# Task Plan — dev-onboarding

## Tasks

- [x] TASK-01: [deps] Add `cac`, `chalk`, `ora`, `prompts` to `devDependencies` in `package.json`
- [x] TASK-02: [deps] Run `npm install` to lock the new packages
- [x] TASK-03: [scripts] Add `"init"` and `"setup"` entries to `package.json#scripts`
- [x] TASK-04: [scripts] Create `scripts/setup.mjs` — skeleton with `main()`, banner, and imports
- [x] TASK-05: [scripts] Implement `detectBackends()` — parallel fetch probes with ora spinner
- [x] TASK-06: [scripts] Implement `ensureDocker()` — `docker info` probe, Colima auto-install (brew + `colima start`), Docker Desktop pause path, Cancel
- [x] TASK-07: [scripts] Implement `handleNoBackends()` — select menu, download compose files + `docker compose up -d`, poll health endpoint
- [x] TASK-08: [scripts] Implement `collectKeys()` — invisible prompts per detected backend + ElevenLabs
- [x] TASK-09: [scripts] Implement `writeEnvLocal()` — parse .env.example, merge, backup, write
- [x] TASK-10: [scripts] Implement `launchApp()` — success summary + spawn next dev + signal forwarding
- [x] TASK-11: [scripts] Wire `main()` — call all phases in order with error handling
- [x] TASK-12: [docs] Rewrite README `## Quick start` with `npm run init` as primary path + `<details>` manual block

## Done criteria per task

- **TASK-01/02**: `package.json` devDependencies includes cac@^6, chalk@^5, ora@^8, prompts@^2; `node_modules` updated
- **TASK-03**: `npm run init` and `npm run setup` both resolve to `node scripts/setup.mjs`
- **TASK-04**: `node scripts/setup.mjs` runs without error, prints banner, exits cleanly
- **TASK-05**: Detection runs with spinner, prints ✓/✗ for each backend within 3 s
- **TASK-06**: When Docker absent, menu shows Colima/Desktop/Cancel; Colima path runs brew install + colima start and re-checks docker info; Docker Desktop path pauses and re-checks; Cancel exits cleanly
- **TASK-07**: No-backend path shows OpenRAG/Workbench/Skip menu; each install path downloads compose + runs docker compose up -d + polls health; Skip continues
- **TASK-08**: Prompts shown only for detected backends; keys not echoed
- **TASK-09**: `.env.local` written with correct values; backup created if pre-existing file exists
- **TASK-10**: After write, summary prints set/skipped keys; `next dev` starts and Ctrl-C propagates
- **TASK-11**: Full golden path (detect → ensure docker → install backend → collect → write → launch) works end-to-end
- **TASK-12**: README leads with `npm run init`; `<details>` block holds old manual steps; no broken links
