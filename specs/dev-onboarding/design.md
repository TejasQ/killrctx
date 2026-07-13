# Design — dev-onboarding

## Overview

`scripts/setup.mjs` is a single Node ESM script (~200 lines). It requires no
build step — `node scripts/setup.mjs` runs directly. It imports three npm
packages that we add to `devDependencies`: **ora** (braille spinners), **chalk**
(colour), and **prompts** (interactive CLI inputs). No TypeScript — keeping the
wizard plain JS makes it readable without a build step.

---

## New files

| Path | Purpose |
|------|---------|
| `scripts/setup.mjs` | The interactive setup wizard (entry point) |

---

## package.json changes

```json
"scripts": {
  "init":  "node scripts/setup.mjs",
  "setup": "node scripts/setup.mjs"
},
"devDependencies": {
  "cac":     "^6.7.14",
  "chalk":   "^5.4.1",
  "ora":     "^8.2.0",
  "prompts": "^2.4.2"
}
```

`"init"` is the canonical name; `"setup"` is an alias so either phrase works.

---

## scripts/setup.mjs — module structure

`cac` wraps the entry point, giving `--help`, `--version`, and optional
escape-hatch flags. The interactive wizard runs as the default command.

```js
import cac from 'cac'
const cli = cac('killrctx')
cli.version('0.1.0')
cli.help()
cli.option('--skip-launch', 'Write .env.local but do not start the app')
cli
  .command('[...args]', 'Interactive setup wizard')
  .action((_args, opts) => main(opts))
cli.parse()
```

The file is a single flat async `main(opts)` function so the flow reads
top-to-bottom without jumping between helpers. Helper functions are defined
after `main()`.

```
main(opts)
  ├── printBanner()              braille banner + title
  ├── detectBackends()           probe OpenRAG + Workbench in parallel
  ├── promptBackendChoice()      show running backends only; exit with instructions if none
  ├── collectKeys()              prompt loop for API keys (REQ-003)
  ├── discoverWorkbenchConfig()  read-only: query live Workbench API for resource IDs
  ├── writeEnvLocal()            merge .env.example + answers (REQ-005)
  └── launchApp()                spawn next dev                [skipped if --skip-launch]
```

### printBanner()
Prints a box-drawn header with the project name and a one-line description.
Uses chalk for colour. No external lib.

```
╔══════════════════════════════════════════════╗
║  killrctx  ·  self-hosted NotebookLM setup   ║
╚══════════════════════════════════════════════╝
```

### detectBackends() → `{ openrag: boolean, workbench: boolean, openragUrl: string, workbenchUrl: string }`

Before probing, the script loads environment variables from `.env.local` (if it
exists), then `.env` — using a minimal line-by-line reader (no external dotenv
lib). This means any custom `OPENRAG_URL` or `WORKBENCH_URL` a developer already
set is honoured automatically.

```js
const openragUrl   = env.OPENRAG_URL   || 'http://localhost:3000'
const workbenchUrl = env.WORKBENCH_URL || 'http://localhost:8080'
```

Runs two `fetch()` probes **in parallel** with a 3 s AbortController timeout each:

| Backend | Probe URL | Success condition |
|---------|-----------|-------------------|
| OpenRAG | `${openragUrl}/health` | HTTP 200 |
| Workbench | `${workbenchUrl}/api/v1/health` | HTTP 200 |

An `ora` spinner runs during the probe ("Detecting local backends…").
Result is printed as two status lines showing the actual URL probed:

```
  ✓  OpenRAG        found at http://localhost:3000
  ✗  AI Workbench   not found  (probed http://localhost:8080)
```

The resolved URLs are returned so `writeEnvLocal()` can use them to set
`OPENRAG_URL` / `WORKBENCH_URL` in `.env.local` rather than hardcoding defaults.

### promptBackendChoice()

Only shows backends that are currently running. If no backend is running, prints
per-platform start instructions and exits 0 with a friendly message:

```
ℹ  No backend is running. Start one first, then re-run npm run init.

  OpenRAG (recommended):
    https://github.com/langflow-ai/openrag — follow Quick Start
    Default URL: http://localhost:3000

  AI Workbench:
    https://github.com/datastax/ai-workbench — follow Quick Start
    Default URL: http://localhost:8080
```

If exactly one backend is running it is selected automatically. If both are
running, a `prompts.select` menu lets the user choose.

### collectKeys()

Runs a `prompts` sequence. Answers are returned as an object:

```ts
type Keys = {
  OPENAI_API_KEY:      string  // required when openrag present
  OPENRAG_API_KEY:     string  // optional
  ELEVENLABS_API_KEY:  string  // optional always
}
```

Prompt rules:
- Use `prompts({ type: 'invisible' })` for all API key inputs (no echo).
- If a backend is NOT detected, skip its key prompts entirely.
- Workbench path collects connection URL only — no Astra/OpenRouter key prompts.
- Each prompt has a descriptive `message` (e.g. `"OpenAI API key (from platform.openai.com/api-keys)"`)
  and a `hint` showing `"Leave blank to skip"` for optional keys.

### discoverWorkbenchConfig() → `WorkbenchIds`

Only called when Workbench is detected. Queries the live Workbench API using
read-only endpoints to discover available workspaces, agents, chunking services,
and embedding services. Presents `prompts.select` menus so the user picks by
name rather than pasting UUIDs.

```ts
type WorkbenchIds = {
  WORKBENCH_WORKSPACE_ID:  string
  WORKBENCH_AGENT_ID:      string
  WORKBENCH_CHUNKING_ID:   string
  WORKBENCH_EMBEDDING_ID:  string
}
```

No mutations are made to the Workbench instance. If any API call fails or
returns an empty list, the function falls back to a free-text `prompts` input
for that specific ID.

### writeEnvLocal()

1. Read `.env.example` as a string.
2. Parse it into an ordered array of `{ key, value, raw }` entries (preserving
   comments and blank lines using a simple line-by-line parser — no external lib).
3. For each key the wizard collected, find the matching line and replace its
   value in-place.
4. Also write the resolved URL vars (from the `detectBackends` return value):
   - If `openrag` detected: `OPENRAG_URL=<openragUrl>`
   - If `workbench` detected: `WORKBENCH_URL=<workbenchUrl>`
5. If `.env.local` already exists, rename it to `.env.local.bak`.
6. Write the merged result to `.env.local`.

The parser is ~20 lines of `str.split('\n')` — no external dotenv write lib.

### launchApp()

```js
const child = spawn('npm', ['run', 'dev'], { stdio: 'inherit', env: process.env })
process.on('SIGINT',  () => child.kill('SIGINT'))
process.on('SIGTERM', () => child.kill('SIGTERM'))
child.on('exit', (code) => process.exit(code ?? 0))
```

Prints a success summary first:
```
─────────────────────────────────────────────
  ✓ .env.local written
  ✓ Keys set: OPENAI_API_KEY, ELEVENLABS_API_KEY
  ─ Skipped: OPENRAG_API_KEY

  Starting killrctx → http://localhost:3001
─────────────────────────────────────────────
```

---

## Removed in v2 (detect-and-connect)

These functions existed in the v1 design and were removed when the wizard was
simplified to detect-and-connect only. They are preserved as a future option in
[`requirements.md`](./requirements.md) under "Future option — automated install".

| Function | Reason removed |
|----------|---------------|
| `ensureDocker()` | No Docker operations remain — nothing to check |
| `installOpenRAG()` | Install path deferred; compose format changes make this brittle |
| `installWorkbench()` | Install path deferred; host.docker.internal + Ollama patching differ per platform |
| `fixOllamaEndpoints()` | Install-only concern; not needed for connect path |
| `detectInstalledDirs()` | Checked for stopped installs on disk — no installs means nothing to detect |
| `resolveInstalledDir()` | Multi-install picker — no installs means no dirs to resolve |
| `startBackend()` | `docker compose up -d` for stopped installs — deferred with install path |
| `runDockerCompose()` | Helper for compose child-process spawning — deferred with install path |
| `pollHealth()` | Startup health-check polling — only needed during install |
| `waitForChild()` | Generic child-process wait helper — no child processes spawned |
| `downloadFile()` | compose file + .env.example download — deferred with install path |
| `sleep()` | Used only in polling loops — polling removed |

---

## Terminal UX details (REQ-007)

- `ora` version 8 (ESM) with default braille spinner frames `⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏`.
- Colour scheme via chalk:

| State | Colour | Symbol |
|-------|--------|--------|
| success | green | ✓ |
| warning | yellow | ⚠ |
| error | red | ✗ |
| info | blue | ℹ |
| running | cyan | spinner |

- Section separators: `chalk.dim('─'.repeat(50))`.
- No `console.log` in the happy path; every line goes through a tiny `log()`
  wrapper that prefixes the symbol and colour.

---

## README changes (REQ-008)

The `## Quick start` section is replaced with:

```markdown
## Quick start

1. Start a backend:
   - **OpenRAG** — https://github.com/langflow-ai/openrag (follow Quick Start)
   - **AI Workbench** — https://github.com/datastax/ai-workbench (follow Quick Start)

2. Clone and run the wizard:
   ```bash
   git clone https://github.com/…/killrctx
   cd killrctx
   npm install
   npm run init
   ```

3. Open http://localhost:3001 — done.
```

The manual `cp .env.example .env` flow moves under a `<details>` collapsible
labelled **Manual setup**.

---

## Dependencies to add

```
npm install --save-dev chalk ora prompts
```

Versions: chalk@5 (ESM), ora@8 (ESM), prompts@2 (CJS, but we import it in
`setup.mjs` with `import prompts from 'prompts'` which Node handles fine).

---

## REQ coverage

| REQ-ID | Design coverage |
|--------|----------------|
| REQ-001 | `scripts/setup.mjs` + `package.json` `"init"` / `"setup"` scripts |
| REQ-002 | `detectBackends()` — parallel fetch with 3 s timeout |
| REQ-003 | `collectKeys()` — invisible prompts per detected backend |
| REQ-004 | `promptBackendChoice()` — exit with start instructions when no backend found |
| REQ-004a | `discoverWorkbenchConfig()` — read-only API query, select by name |
| REQ-005 | `writeEnvLocal()` — merge .env.example, backup existing |
| REQ-006 | `launchApp()` — spawn next dev, signal forwarding |
| REQ-007 | `ora` + `chalk` throughout, braille frames, symbol+colour table |
| REQ-008 | README `## Quick start` rewrite + `<details>` manual block |
