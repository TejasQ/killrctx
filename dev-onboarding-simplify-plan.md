# Plan — dev-onboarding: detect-and-connect simplification

## Overview

The current `npm run init` wizard tries to fully automate backend installation
(Colima, Docker, docker-compose pull, health-check polling, Ollama endpoint
patching). This is fragile: OpenRAG's upstream compose format changes, AI
Workbench's Docker networking requires platform-specific exceptions, and the two
platforms have different health-check behavior. Every platform added in the future
makes this worse.

**Decision:** Narrow setup.mjs to a detect-and-connect wizard. It probes for a
running backend, collects API keys and connection URLs, writes `.env.local`, and
launches the app. If nothing is running it tells the user exactly what to start
and where — it does not start it for them.

**What stays unchanged:**
- All app code: `src/lib/rag.ts`, `src/lib/backends/`, `/api/health`, `HealthGate.tsx`
- Package.json scripts (`npm run init` / `npm run setup`)
- The `cac` / `ora` / `chalk` / `prompts` dependencies (still needed)
- `specs/dev-onboarding/` — updated in place to reflect new direction

**Scope:**
1. Rewrite `scripts/setup.mjs` — strip all install logic
2. Update `README.md` — rewrite Quick start to match the new flow
3. Update `specs/dev-onboarding/` — mark install requirements as future option,
   add new detect-and-connect requirements

---

## Sub-tasks

---

### TASK-1 — Rewrite scripts/setup.mjs (detect-and-connect only)

**Status:** `[ ] pending`

**Intent:**
Strip all install automation from the wizard. The resulting script should be
~200 lines (down from ~880). It detects running backends, asks the user which
one they want to connect to, collects keys, writes `.env.local`, and launches
the app. If nothing is running it prints clear per-platform start instructions
and exits gracefully — no Docker, no Colima, no health-check polling for
startup.

**What gets removed:**
- `ensureDocker()` and all Docker runtime install logic (Colima + Homebrew bootstrap)
- `installOpenRAG()` — compose file download, seeding platform .env, startup poll
- `installWorkbench()` — same, plus `host.docker.internal` / Ollama endpoint workarounds
- `discoverWorkbenchConfig()` — live API UUID discovery (Workbench-specific; user can set these manually)
- `fixOllamaEndpoints()` — Docker networking patch
- `detectInstalledDirs()` — checking for stopped installs via docker-compose.yml on disk
- `startBackend()` — `docker compose up -d` for stopped installs
- `resolveInstalledDir()` — multi-install picker
- `runDockerCompose()` and `pollHealth()` helper functions

**What stays / gets simplified:**
- `printBanner()` — unchanged
- `loadEnvFile()` — unchanged
- `detectBackends()` — unchanged (parallel probe, 3s timeout, shows found/not-found)
- `promptBackendChoice()` — simplified: only shows running backends plus "Skip".
  If no backend is running, prints per-platform start instructions and exits with
  a helpful message instead of offering to install.
- `collectKeys()` — simplified: only prompts for connection URL and optional auth key.
  OpenRAG: `OPENAI_API_KEY` + optional `OPENRAG_API_KEY`. Workbench: connection URL
  only (no Astra/OpenRouter — those were set when the user installed Workbench).
  Always: `ELEVENLABS_API_KEY`.
- `discoverWorkbenchConfig()` — kept as a read-only connect step. When Workbench is
  running, the wizard queries the live API to auto-discover workspace/agent/chunking/
  embedding service IDs and writes them to `.env.local`. User picks by name, never
  pastes UUIDs. `fixOllamaEndpoints()` is removed (install-only concern).
- `writeEnvLocal()` — unchanged (writes connection URLs + collected keys + discovered IDs)
- `launchApp()` — unchanged
- `downloadFile()`, `waitForChild()`, `sleep()`, `injectEnvValue()`, `portPid()` —
  remove all except `injectEnvValue` and `portPid` which are still used

**New behavior when no backend is running:**
```
✗  OpenRAG       not found  (probed http://localhost:3000/health)
✗  AI Workbench  not found  (probed http://localhost:8080/healthz)

ℹ  No backend is running. Start one first, then re-run npm run init.

  OpenRAG (recommended):
    https://github.com/langflow-ai/openrag — follow Quick Start
    Default URL: http://localhost:3000

  AI Workbench:
    https://github.com/datastax/ai-workbench — follow Quick Start
    Default URL: http://localhost:8080
```

**Expected outcomes:**
- `node scripts/setup.mjs` runs in < 5 seconds when a backend is already running
- Script is ~200 lines, no Docker-related code, no child-process spawning for installs
- `--skip-docker` flag is removed entirely (no Docker code remains to skip)
- `--skip-launch` and `--help` and `--version` still work
- Workbench connect path auto-discovers workspace/agent/service IDs from live API
- Existing `.env.local` detection, backup, and merge behavior unchanged
- App launches correctly after `.env.local` is written

**Relevant context:**
- `scripts/setup.mjs` — full rewrite
- `src/app/api/health/route.ts` — not changed; already handles running/booting states
- `src/components/HealthGate.tsx` — not changed
- Health probe endpoints: OpenRAG `/health`, AI Workbench `/healthz`

---

### TASK-2 — Update README.md quick start

**Status:** `[ ] pending`

**Intent:**
Rewrite the `## Quick start` section to match the new flow. The wizard no longer
installs anything, so the docs should set that expectation. Each backend gets a
clear "how to start it" path before running `npm run init`.

**Changes:**
- Replace the 5-step wizard description with the new 3-step flow:
  1. Start a backend (OpenRAG or AI Workbench — links to their quick starts)
  2. `npm run init` — detects, collects keys, writes `.env.local`, starts app
  3. Open `http://localhost:3001`
- Remove the `--skip-docker` flag from docs entirely
- Keep `--skip-launch` and `--help` in the flags example
- Update the `<details>Manual setup</details>` block to be accurate:
  it should describe manual `.env.local` editing as the alternative to the wizard,
  not a Docker compose workflow
- Preserve: architecture diagram, "Three relevant files", "How it _basically_ works",
  "Things that bit us", file layout — none of these change

**Expected outcomes:**
- Quick start reads: start backend → run wizard → open app
- No mention of auto-install, Colima, or Docker from setup.mjs
- Manual setup block accurately describes `.env.local` editing

**Relevant context:**
- `README.md` lines 44-95 (quick start + manual setup block)

---

### TASK-3 — Update specs/dev-onboarding/

**Status:** `[ ] pending`

**Intent:**
Keep the spec files in the repo (per user's decision). Update them to:
1. Mark REQ-004 (automated backend install) as **deferred / future option** with a
   note explaining why it was deferred (upstream fragility, platform-specific Docker
   exceptions)
2. Add new requirements that describe the detect-and-connect approach:
   - REQ-002 (backend detection) — unchanged
   - REQ-003 (key collection) — updated: Workbench path collects connection URL only,
     no Astra/OpenRouter prompts
   - New REQ: Workbench connect path auto-discovers workspace/agent/service IDs from
     live API (read-only; no patching of Ollama endpoints)
   - New REQ: "not found" exit — prints per-platform start instructions with links
     and exits 0 instead of offering to install
3. Update `todo.md` to mark install tasks as superseded and add new tasks for the
   simplification work
4. Update `design.md` to reflect the simplified module structure

The install path is preserved as a clearly-labelled "Future option" section so it
can be picked up later without losing the research and design that went into it.

**Expected outcomes:**
- `requirements.md`: REQ-004 moved to `## Future option — automated install` section
  with rationale; new REQ-004 (or renumbered) describes the "not found" exit behavior
- `design.md`: module structure updated to show simplified function list; removed
  functions noted under "Removed in v2 (detect-and-connect)"
- `todo.md`: install tasks (TASK-06, TASK-07 and sub-steps) marked `[deferred]`;
  new tasks added for the simplification

**Relevant context:**
- `specs/dev-onboarding/requirements.md`
- `specs/dev-onboarding/design.md`
- `specs/dev-onboarding/todo.md`

---

## Implementation order

Tasks are independent but should run in order so README and spec updates can
reference the final script behavior:

```
TASK-1 (setup.mjs rewrite)
  → TASK-2 (README reflects actual wizard behavior)
  → TASK-3 (spec reflects decisions made)
```

## Decisions recorded

| Question | Decision |
|---|---|
| `--skip-docker` flag | Remove entirely — no Docker code remains |
| Workbench key collection | Connection URL only; no Astra/OpenRouter prompts |
| `discoverWorkbenchConfig()` | Keep as read-only connect step; remove `fixOllamaEndpoints()` |

## Out of scope

- Any changes to app code (`src/`)
- Windows support
- Adding new backend platform support
- CI/headless mode
