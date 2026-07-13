# Requirements — dev-onboarding

## User story

As a developer who just cloned killrctx, I want a single interactive setup
wizard (`npm run init`) that detects my local AI backend situation, collects
exactly the keys I need, writes `.env.local`, and starts the app — so that I
go from `git clone` to a working localhost in one command with zero manual
config-file editing.

---

## Requirements

### REQ-001 — Single entry-point command
`npm run init` (or `npm run setup`) launches an interactive CLI wizard.  
**Acceptance criteria:**
- The script lives at `scripts/setup.mjs` and is invoked via a `"init"` entry
  in `package.json#scripts`.
- No positional arguments required; everything is gathered interactively.

### REQ-002 — Backend detection
The wizard probes for two local backends before asking anything. Probe URLs come
from env vars, falling back to defaults only when no var is set:
- **OpenRAG** — `$OPENRAG_URL/health` (default: `http://localhost:3000/health`)
- **AI Workbench** — `$WORKBENCH_URL/api/v1/health` (default: `http://localhost:8080/api/v1/health`)

Before probing, the wizard loads any existing `.env.local`, then `.env`, so
custom `OPENRAG_URL` / `WORKBENCH_URL` values are honoured.

**Acceptance criteria:**
- Probe URLs are read from `OPENRAG_URL` / `WORKBENCH_URL` env vars.
- Fallback to the default ports only when the var is absent or blank.
- Detection runs with a visible spinner and a ≤3 s timeout per probe.
- Results are shown as a clear "found / not found" status before any prompt,
  including the actual URL probed.

### REQ-003 — Key-collection wizard (backend found)
If a backend is detected, the wizard asks the developer to paste the required
API keys for that backend in separate, clearly labelled steps.

**Acceptance criteria:**
- OpenRAG found → prompt for `OPENAI_API_KEY` (required) and
  `OPENRAG_API_KEY` (optional, skip if blank).
- Workbench found → prompt for connection URL only. Astra/OpenRouter keys are
  not collected here — they were set when the user configured Workbench and
  live in that platform's own config.
- ElevenLabs → always prompt for `ELEVENLABS_API_KEY` (can be skipped).
- Base URLs are inferred from the detected container, not prompted.
- Pasted values are never echoed back in plain text.

### REQ-004 — "Not found" exit (no backend running)
If neither backend is detected, the wizard prints clear per-platform start
instructions and exits 0. It does not offer to install anything.

**Acceptance criteria:**
- After printing the "not found" probe results, the wizard prints a message
  explaining that no backend is running.
- Per-platform start instructions are printed for each backend, including:
  - A link to the platform's Quick Start guide.
  - The default local URL to expect once it is running.
- The wizard exits 0 (clean exit, not an error).
- Example output:
  ```
  ℹ  No backend is running. Start one first, then re-run npm run init.

    OpenRAG (recommended):
      https://github.com/langflow-ai/openrag — follow Quick Start
      Default URL: http://localhost:3000

    AI Workbench:
      https://github.com/datastax/ai-workbench — follow Quick Start
      Default URL: http://localhost:8080
  ```

### REQ-004a — Workbench connect path (auto-discover IDs)
When AI Workbench is detected as running, the wizard queries the live Workbench
API to auto-discover workspace, agent, chunking service, and embedding service
IDs. The user selects resources by name — they never paste UUIDs.

**Acceptance criteria:**
- Wizard calls read-only Workbench API endpoints to list available workspaces,
  agents, and services.
- User picks by name from a `prompts.select` menu for each resource type.
- Selected IDs are written to `.env.local` (e.g. `WORKBENCH_WORKSPACE_ID`,
  `WORKBENCH_AGENT_ID`).
- No mutations are made to the Workbench instance — strictly read-only.
- If the API call fails (network error or empty list), the wizard falls back to
  a free-text prompt for the relevant ID.

### REQ-005 — .env.local writing
After key collection the wizard writes (or merges into) `.env.local` with the
values it gathered.

**Acceptance criteria:**
- `.env.local` is created from `.env.example` values as base, then overwritten
  with wizard answers.
- Pre-existing `.env.local` is backed up to `.env.local.bak` before writing.
- Only the keys the wizard collected are written; irrelevant keys keep their
  `.env.example` defaults.

### REQ-006 — App launch
After `.env.local` is written, the wizard starts `next dev` automatically.

**Acceptance criteria:**
- A success summary prints all set keys (keys only, not values).
- `npm run dev` starts as a child process; its stdout/stderr streams to the
  terminal.
- The wizard exits when `next dev` exits (Ctrl-C propagates).

### REQ-007 — CLI framework + terminal UX
The wizard uses four libraries with distinct, non-overlapping roles:

| Library | Role |
|---------|------|
| `cac` | Entry-point flags — `--help`, `--version`, `--skip-launch` |
| `prompts` | Interactive menus and invisible key input |
| `ora` | Braille spinners and progress on all async waits |
| `chalk` | Colour and status symbols throughout |

**Acceptance criteria:**
- `cac` parses CLI flags; `--help` prints usage; `--version` prints the package version.
- `--skip-launch` writes `.env.local` and exits without starting `next dev`.
- `ora` with default braille frames (`⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏`) on all async waits.
- `chalk` colours: success green ✓, warning yellow ⚠, error red ✗, info blue ℹ.
- Section headers separated with a thin `─` rule.
- No plain `console.log` in the happy path — every line is a labelled status.

### REQ-008 — Updated README
The README `## Quick start` section is rewritten to reflect `npm run init` as
the primary path, with the manual `.env` flow demoted to a "Manual setup"
collapsible.

**Acceptance criteria:**
- README leads with `npm run init`.
- Quick start reads: start backend → run wizard → open app.
- Architecture diagram and "Things that bit us" sections are preserved.
- No broken links.

---

## Out of scope

- Windows support beyond what Node.js provides natively.
- `.env` (non-local) editing — wizard only touches `.env.local`.
- CI/CD or non-interactive (headless) mode.
- Key validation (calling the API to verify the key works).

---

## Future option — automated install

> **Why this was deferred:** The automated install path was designed but not
> implemented for the following reasons. OpenRAG's upstream `docker-compose.yml`
> format changes without notice, making a downloaded-and-run approach brittle.
> AI Workbench requires platform-specific Docker networking exceptions
> (`host.docker.internal` on macOS, direct bridge on Linux) and Ollama endpoint
> patching that differs per platform. The two backends also have different
> health-check behavior and startup timing. Every new backend platform added
> in the future would compound this maintenance surface. The detect-and-connect
> approach avoids all of this by requiring the user to start their backend once
> — a step that is well-documented by each platform's own Quick Start.

### REQ-F01 — Automated backend install (backend not found)
If neither backend is detected, the wizard offers to install one automatically
using Docker. Both backends are public Docker images — no account or license
required to pull and run them.

**Acceptance criteria:**
- A choice menu is shown: `(1) OpenRAG  (2) AI Workbench  (3) Skip`.
- Before attempting any install, the wizard checks that `docker` is available
  and reachable by running `docker info` silently.
- If `docker info` fails (CLI missing or no running daemon), the wizard does
  NOT exit — it first offers to install a Docker runtime automatically, with
  the same frictionless flow as the backend installs (download → run → continue).
- Docker runtime install choices: `(1) Colima  (2) Docker Desktop  (3) Cancel`.
  Colima is the recommended default (lightweight, brew-installable, no GUI).
  Docker Desktop is offered for users who prefer it.
- After a runtime is installed and started, the wizard re-checks `docker info`
  once. If it now succeeds, the backend install flow continues normally.
- **Choosing OpenRAG:**
  1. Creates a `../openrag/` sibling directory (relative to the killrctx repo root).
  2. Downloads `docker-compose.yml` from the upstream OpenRAG repo into that directory.
  3. Copies `.env.example` from that compose file's raw URL into `../openrag/.env`,
     then prompts for the user's `OPENAI_API_KEY` and writes it into that file.
  4. Runs `docker compose up -d` inside `../openrag/`.
  5. Polls `http://localhost:3000/health` (or `$OPENRAG_URL/health`) every 5 s,
     up to 5 min, with an ora spinner showing elapsed time.
  6. On success → continues to `collectKeys()`.
  7. On timeout → prints troubleshooting tips and exits 1.
- **Choosing AI Workbench:**
  1. Creates a `../ai-workbench/` sibling directory.
  2. Downloads the official `docker-compose.yml` from
     `https://raw.githubusercontent.com/datastax/ai-workbench/main/docker-compose.yml`
     into that directory.
  3. Runs `docker compose up -d` inside `../ai-workbench/`.
  4. Polls `http://localhost:8080/healthz` every 5 s, up to 3 min.
  5. On success → continues to `collectKeys()`.
  6. On timeout → prints troubleshooting tips and exits 1.
- **Choosing Skip:** continues to key collection with no backend configured.
- All Docker output streams to the terminal. An ora spinner tracks elapsed
  time in parallel.
