# Design — dev-onboarding

## Overview

`scripts/setup.mjs` is a single Node ESM script (~300 lines). It requires no
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
cli.option('--skip-docker', 'Skip Docker runtime check')
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
  ├── printBanner()           braille banner + title
  ├── detectBackends()        probe OpenRAG + Workbench in parallel
  ├── ensureDocker()          check / install Docker runtime   [skipped if --skip-docker]
  ├── handleNoBackends()      backend install wizard
  ├── collectKeys()           prompt loop for API keys (REQ-003)
  ├── writeEnvLocal()         merge .env.example + answers (REQ-005)
  └── launchApp()             spawn next dev                   [skipped if --skip-launch]
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

### ensureDocker() → `boolean`

Called before `handleNoBackends()`. Runs `docker info` silently
(`execSync('docker info', { stdio: 'ignore' })`).

If it succeeds → returns `true`, nothing to do.

If it fails → Docker CLI is missing or no daemon is running. Presents:

```
  ✗  No Docker runtime detected.

  Docker is needed to install OpenRAG or AI Workbench.
  Install one automatically?
    ❯ Colima          (recommended · lightweight · macOS/Linux · ~2 min)
      Docker Desktop  (GUI app · macOS/Windows/Linux · ~5 min)
      Cancel setup
```

**Colima install path** (macOS/Linux only):
1. Checks `brew` is available (`which brew`). If not, installs Homebrew first:
   - Downloads and runs the official Homebrew install script via
     `spawn('/bin/bash', ['-c', '$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)'], { stdio: 'inherit' })`.
2. Runs `brew install colima docker` (both needed — `colima` is the runtime,
   `docker` is the CLI client).
3. Runs `colima start` and waits for it to exit cleanly.
4. Re-checks `docker info`. If succeeds → returns `true` and continues.
5. On any error → prints failure message and exits 1.

**Docker Desktop install path**:
- On macOS: prints the download URL (`https://docs.docker.com/desktop/setup/install/mac-install/`) and instructs the user to install it manually, then pauses with "Press Enter when Docker Desktop is running…". Re-checks `docker info` after Enter.
- On Linux: prints the `apt`/`dnf` install instructions and pauses similarly.
- On Windows: prints the download URL and pauses.
- _Reason Docker Desktop is not auto-installed:_ it requires accepting a GUI license agreement; automation would silently skip that. Manual install is the right call.

**Cancel path:** calls `process.exit(0)` with a friendly goodbye message.

After `ensureDocker()` returns `true`, the backend install menu is shown normally.

### handleNoBackends()

Only called when `openrag === false && workbench === false`.

Calls `ensureDocker()` first, then presents the backend menu.

Presents a `prompts.select` menu:
```
No backend detected. Install one automatically?
  ❯ OpenRAG        (open-source · Docker · ~5 min)
    AI Workbench   (DataStax · Docker · ~3 min)
    Skip for now
```

**OpenRAG install path:**
1. `mkdir -p ../openrag`
2. Downloads `https://raw.githubusercontent.com/langflow-ai/openrag/main/docker-compose.yml`
   into `../openrag/docker-compose.yml` via `fetch()` + `fs.writeFile`.
3. Downloads `https://raw.githubusercontent.com/langflow-ai/openrag/main/.env.example`
   into `../openrag/.env` via `fetch()` + `fs.writeFile`.
4. Prompts (invisible) for `OPENAI_API_KEY`, writes it into `../openrag/.env`
   using the same line-replace helper used in `writeEnvLocal()`.
5. Runs `spawn('docker', ['compose', 'up', '-d'], { cwd: '../openrag', stdio: 'inherit' })`.
   Waits for the child to exit (non-zero → error + exit 1).
6. Polls `${openragUrl}/health` every 5 s, up to 5 min.
   Ora spinner shows `⠋ Starting OpenRAG… (42s elapsed)`.
7. On health success → sets `openrag = true`, continues to `collectKeys()`.
8. On 5-min timeout → prints tips (`docker compose logs`) and exits 1.

**Workbench install path:**
1. `mkdir -p ../ai-workbench`
2. Downloads `https://raw.githubusercontent.com/datastax/ai-workbench/main/docker-compose.yml`
   into `../ai-workbench/docker-compose.yml`.
3. Runs `spawn('docker', ['compose', 'up', '-d'], { cwd: '../ai-workbench', stdio: 'inherit' })`.
4. Polls `${workbenchUrl}/healthz` every 5 s, up to 3 min.
5. On health success → sets `workbench = true`, continues to `collectKeys()`.
6. On 3-min timeout → prints tips and exits 1.

**Skip path:** continues directly to `collectKeys()` with no backend configured.

All Docker output streams via `stdio: 'inherit'`. The ora spinner runs on a
`setInterval` alongside the child process so elapsed time is always visible.

### collectKeys()

Runs a `prompts` sequence. Answers are returned as an object:

```ts
type Keys = {
  OPENAI_API_KEY:      string  // required when openrag present
  OPENRAG_API_KEY:     string  // optional
  WORKBENCH_API_KEY:   string  // optional, only when workbench present
  ELEVENLABS_API_KEY:  string  // optional always
}
```

Prompt rules:
- Use `prompts({ type: 'invisible' })` for all API key inputs (no echo).
- If a backend is NOT detected, skip its key prompts entirely.
- Each prompt has a descriptive `message` (e.g. `"OpenAI API key (from platform.openai.com/api-keys)"`)
  and a `hint` showing `"Leave blank to skip"` for optional keys.

### writeEnvLocal()

1. Read `.env.example` as a string.
2. Parse it into an ordered array of `{ key, value, raw }` entries (preserving
   comments and blank lines using a simple line-by-line parser — no external lib).
3. For each key the wizard collected, find the matching line and replace its
   value in-place.
4. Also write the resolved URL vars (from the `detectBackends` return value,
   or defaults if the user just installed):
   - If `openrag` detected/installed: `OPENRAG_URL=<openragUrl>`
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
  ─ Skipped: OPENRAG_API_KEY, WORKBENCH_API_KEY

  Starting killrctx → http://localhost:3001
─────────────────────────────────────────────
```

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

```bash
git clone https://github.com/…/killrctx
cd killrctx
npm install
npm run init
```

`npm run init` is an interactive wizard that:
1. Detects OpenRAG / AI Workbench running locally
2. Offers to install OpenRAG via Docker if nothing is found
3. Collects your API keys (OpenAI, ElevenLabs)
4. Writes `.env.local` and starts the app

Open http://localhost:3001 — done.
```

The manual `cp .env.example .env` / `docker compose` flow moves under a
`<details>` collapsible labelled **Manual setup**.

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
| REQ-004 | `handleNoBackends()` — select menu, Docker install, Workbench notice |
| REQ-005 | `writeEnvLocal()` — merge .env.example, backup existing |
| REQ-006 | `launchApp()` — spawn next dev, signal forwarding |
| REQ-007 | `ora` + `chalk` throughout, braille frames, symbol+colour table |
| REQ-008 | README `## Quick start` rewrite + `<details>` manual block |
