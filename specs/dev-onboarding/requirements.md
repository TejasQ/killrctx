# Requirements — dev-onboarding

## User story

As a developer setting up or managing killrctx, I want a CLI control panel
(`npm run init`) that detects my local backend situation, shows me what's
configured, and lets me take targeted actions — so that I can go from
`git clone` to a working app, reconfigure a single backend without touching
others, or hand the setup off to an automated agent, all with one tool.

---

## Requirements

### REQ-001 — Control panel entry point
`npm run init` is the primary entry point. When invoked with no flags it shows
an interactive numbered menu. Every menu action is also available as a CLI flag
so scripts and agents can drive it without the interactive prompt.

**Acceptance criteria:**
- The script lives at `scripts/setup.mjs` and has a `#!/usr/bin/env node`
  shebang so it is directly executable (`./scripts/setup.mjs --status`).
- `package.json#scripts` contains convenience aliases that pass flags directly —
  no `--` separator required by the user:
  ```json
  "init":             "node scripts/setup.mjs",
  "init:status":      "node scripts/setup.mjs --status",
  "init:openrag":     "node scripts/setup.mjs --configure openrag",
  "init:workbench":   "node scripts/setup.mjs --configure workbench",
  "init:all":         "node scripts/setup.mjs --configure all",
  "init:launch":      "node scripts/setup.mjs --launch"
  ```
- `--help` prints the full flag reference. `--version` prints the package version.

### REQ-002 — Backend detection (unchanged)
The wizard probes for configured backends before showing any menu. Probe URLs
come from env vars, falling back to defaults only when no var is set:
- **OpenRAG** — `$OPENRAG_URL/health` (default: `http://localhost:3000/health`)
- **AI Workbench** — `$WORKBENCH_URL/healthz`
  (default: `http://localhost:8080/healthz`)

Before probing, the wizard loads `.env` then `.env.local` (local wins), so
custom URL values are honoured.

**Acceptance criteria:**
- Probe URLs are read from `OPENRAG_URL` / `WORKBENCH_URL` env vars.
- Fallback to the default ports only when the var is absent or blank.
- Detection runs with a visible spinner and a ≤3 s timeout per probe.
- Detection result shows UP/DOWN status, the URL probed, and whether the backend
  is already configured (has keys in `.env.local`):
  ```
  ✓  OpenRAG       http://localhost:3000  [up · configured]
  ✗  AI Workbench  http://localhost:8080  [offline · not configured]
  ```

### REQ-003 — Interactive numbered menu
After detection, the wizard displays a numbered action menu. The menu persists
after each action (user returns to the menu until they choose Exit or Start app).

**Acceptance criteria:**
- Menu options are always shown regardless of backend UP/DOWN state:
  ```
  [1]  Configure OpenRAG
  [2]  Configure AI Workbench
  [3]  Configure all running backends
  [4]  Show status
  [5]  Start app
  [6]  Exit
  ```
- Selecting [1] or [2] runs the configure flow for that backend (see REQ-004).
- Selecting [3] runs configure for every backend currently UP; skips DOWN ones
  with a message.
- Selecting [4] re-probes and reprints the detection status block.
- Selecting [5] writes `.env.local` and launches the app (see REQ-006).
- Selecting [6] exits 0 without writing or launching anything.
- After any configure action completes, the menu is reprinted.

### REQ-004 — Per-backend configure flow
Configuring a backend collects its API keys and writes `.env.local` immediately.
The flow is the same whether invoked from the menu or via `--configure`.

**Acceptance criteria:**

**Already-configured backends:**
- If the backend already has keys in `.env.local`, the wizard shows masked
  existing values (e.g. `[sk-…abc]`) and asks:
  `"Already configured. Reconfigure? No / Yes"` — default **No**.
- Selecting No skips key prompts and returns to the menu. The existing config
  is untouched.
- Selecting Yes proceeds to key prompts.
- This prompt appears regardless of whether the backend is currently UP or DOWN
  — the user may need to update keys for an offline backend.

**Offline (DOWN) backends:**
- If the backend is DOWN, a warning is shown before key prompts:
  `"⚠  AI Workbench is offline — keys will be saved but cannot be verified."`
- Key prompts still run normally. The URL is saved; keys are saved.
- Workbench ID auto-discovery is skipped (requires a live API).

**Key prompts (all backends):**
- OpenRAG: `OPENAI_API_KEY` (required), `OPENRAG_API_KEY` (optional).
- Workbench: no API key prompts (Workbench manages its own auth); ID
  auto-discovery runs when the backend is UP (see REQ-004a).
- ElevenLabs: `ELEVENLABS_API_KEY` (optional) — always shown, for both backends.
- Existing key values are shown masked; pressing Enter keeps them.
- Pasted values are never echoed in plain text (`type: 'invisible'`).
- `.env.local` is written immediately after the backend's prompts complete —
  not deferred until the user exits the menu.

### REQ-004a — Workbench ID auto-discovery (unchanged behaviour)
When configuring AI Workbench and the backend is UP, the wizard queries the live
API to auto-discover workspace, agent, chunking service, and embedding service
IDs. The user selects by name — never pastes UUIDs.

**Acceptance criteria:**
- Wizard calls read-only Workbench API endpoints to list workspaces, agents, and
  services.
- User picks by name from a `prompts.select` menu for each resource type.
- If IDs are already in `.env.local`, the wizard shows them and skips re-picking
  unless the user chose to reconfigure (REQ-004 "already configured" branch).
- Selected IDs are written to `.env.local`.
- No mutations are made to the Workbench instance.
- If the API call fails or returns an empty list, the wizard falls back to a
  free-text prompt for the relevant ID.

### REQ-005 — CLI flags (non-interactive / headless)
Every menu action has a corresponding flag so agents and scripts can drive the
wizard without the interactive prompt.

**Acceptance criteria:**

| Flag | Behaviour |
|------|-----------|
| `--status` | Print detection status and exit 0. No prompts. |
| `--configure openrag` | Run REQ-004 configure flow for OpenRAG only, then exit. |
| `--configure workbench` | Run REQ-004 configure flow for AI Workbench only, then exit. |
| `--configure all` | Run REQ-004 configure flow for all currently UP backends, then exit. |
| `--launch` | Write `.env.local` from current state (no key prompts) and launch the app. |
| `--skip-launch` | Run configure (interactive or via `--configure`), do not start the app. |
| `--help` | Print usage and exit 0. |
| `--version` | Print package version and exit 0. |

- `--configure` without a value is an error: print usage and exit 1.
- `--configure` and `--launch` are mutually exclusive: print error and exit 1.
- All `--configure` paths honour the "already configured — reconfigure?"
  question unless `--force` is also passed (bypasses the confirmation and
  proceeds directly to key prompts).

### REQ-006 — .env.local writing
`.env.local` is written per-backend immediately after that backend's configure
flow completes. A final write happens before launch.

**Acceptance criteria:**
- `.env.local` is built from `.env.example` as the base template; configured
  values overwrite their matching keys line-by-line.
- Existing `.env.local` is backed up to `.env.local.bak` before the first write
  in a session.
- Only the keys touched in this session are overwritten; all other keys keep
  their current `.env.local` / `.env.example` values.
- Multiple backends can be configured in a single session; each write is
  incremental (OpenRAG keys do not erase Workbench keys and vice versa).

### REQ-007 — App launch
`[5] Start app` and `--launch` start `next dev` after writing `.env.local`.

**Acceptance criteria:**
- A success summary lists all keys set in this session (names only, no values).
- `next dev -p 3001` starts as a child process; its stdout/stderr streams to the
  terminal.
- Port 3001 collision is detected and the conflicting process is killed before
  starting (existing behaviour — unchanged).
- The wizard exits when `next dev` exits. Ctrl-C propagates to the next process
  group.

### REQ-008 — Terminal UX (unchanged)
The wizard continues to use the same four libraries for consistent UX.

| Library | Role |
|---------|------|
| `cac` | Entry-point flags |
| `prompts` | Interactive menus and invisible key input |
| `ora` | Braille spinners on all async waits |
| `chalk` | Colour and status symbols |

**Acceptance criteria:**
- `chalk` colours: success green ✓, warning yellow ⚠, error red ✗, info blue ℹ.
- Section headers separated with a thin `─` rule.
- Numbered menu items use `chalk.bold('[N]')` formatting matching the style in
  the image reference (bright bracket-number, plain label).

### REQ-009 — Updated README
The README `## Quick start` section reflects the control-panel model.

**Acceptance criteria:**
- README leads with `npm run init` for interactive setup.
- Documents the `npm run init:openrag`, `npm run init:workbench`, and
  `npm run init:status` convenience aliases.
- Notes that both backends can be configured independently and run simultaneously.
- Quick start reads: start backend(s) → run wizard → open app.
- Architecture diagram and "Things that bit us" sections are preserved.

---

## Out of scope

- Windows support beyond what Node.js provides natively.
- `.env` (non-local) editing — wizard only touches `.env.local`.
- Key validation (calling the API to verify a key is valid).
- Automated backend install (Docker) — see "Future option" section below.

---

## Future option — automated backend install

> **Why this was deferred:** The automated install path was designed but not
> implemented. OpenRAG's upstream `docker-compose.yml` format changes without
> notice. AI Workbench requires platform-specific Docker networking exceptions
> that differ between macOS and Linux. Every new backend platform would compound
> this maintenance surface. The detect-and-connect approach avoids all of this
> by requiring the user to start their backend once — a step well-documented by
> each platform's own Quick Start.

### REQ-F01 — Automated backend install (backend not found)
*(Full acceptance criteria preserved from original — unchanged.)*
If neither backend is detected, the wizard offers to install one automatically
using Docker. See original `dev-onboarding/requirements.md` REQ-F01 for the
full acceptance criteria.
