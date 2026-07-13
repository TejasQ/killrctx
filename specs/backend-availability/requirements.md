# Requirements — backend-availability

## User story

As a killrctx user, I want the app to remain usable when one or more RAG backends
are offline, so that I can still browse my notebooks and read existing notes even
when OpenRAG or AI Workbench is not running.

---

## Requirements

### REQ-001 — Per-backend health probing
The app must probe all configured backends independently rather than stopping at
the first result. A "configured" backend means its URL env var is non-empty
(`OPENRAG_URL`, `WORKBENCH_URL`).

**Acceptance criteria:**
- `/api/health` probes every configured backend in parallel and returns a
  per-backend status map: `{ openrag?: "up"|"down", workbench?: "up"|"down" }`.
- A backend whose env var is blank/absent is treated as "not configured" and
  omitted from the map entirely (not `"down"`).
- The response includes a top-level `anyUp: boolean` indicating whether at least
  one configured backend is reachable.
- The existing `settings`, `needsSetup`, and `booting` fields are preserved on
  the per-backend entry where applicable (OpenRAG local install path).

### REQ-002 — No full-UI block when backends are offline
The app must never block the entire UI waiting for a RAG backend. The notebook
list and per-notebook read-only views must always be accessible regardless of
backend state.

**Acceptance criteria:**
- The current `HealthGate` hard-block (full-viewport spinner) is replaced by a
  non-blocking status banner.
- The banner is shown at the top of every page when one or more configured
  backends are offline.
- The banner names the offline backend(s) and includes a `npm run init` link.
- The banner is dismissible per session (survives page navigation, resets on
  app restart).
- If all backends are up, no banner is shown.

### REQ-003 — Per-backend notebook creation gating
When creating a new notebook, backends that are currently offline or not
configured must not be selectable.

**Acceptance criteria:**
- The `BackendPicker` component fetches current backend status from `/api/health`
  on mount.
- A backend that is `"down"` is rendered disabled and greyed out.
- A backend that is not configured (omitted from the health map) is rendered
  disabled and greyed out.
- Each disabled option shows a tooltip explaining why:
  `"OpenRAG is offline"` / `"AI Workbench is offline"` /
  `"AI Workbench is not configured — run npm run init"`.
- If only one backend is `"up"`, it is pre-selected.
- If no backend is `"up"`, both options are disabled and a message beneath the
  picker reads: `"Start a backend with npm run init to create notebooks"`.
- The "Create" button is disabled while no backend is `"up"`.

### REQ-004 — Per-notebook degraded mode
When a notebook's own RAG backend is offline, the notebook must open in a
degraded read-only mode rather than refusing to load or error out.

**Acceptance criteria:**
- The notebook page loads and renders all data already in SQLite: documents,
  conversations, messages, and notes.
- A non-blocking inline banner at the top of the notebook page identifies the
  degraded state and names the offline backend (e.g. `"OpenRAG is offline —
  this notebook is read-only"`).
- **Disabled while offline** (controls visible but non-interactive):
  - Chat input field — `placeholder` reads `"OpenRAG is offline"` or
    `"AI Workbench is offline"`.
  - Send button in Chat panel.
  - "New conversation" button in Chat panel.
  - All Studio panel "Generate" buttons.
  - "Upload" button in Sources panel.
  - "Add URL" button in Sources panel.
  - Document delete buttons in Sources panel.
  - Note delete buttons in Studio panel.
  - Note rename (inline title edit).
  - Notebook rename.
  - Notebook delete.
  - Model pickers (LLM and embedding) — visible but `disabled`, dimmed with
    `opacity-50 pointer-events-none`. Tooltip reads `"Backend offline"`.
  - Document checkboxes in Sources panel — `opacity-0 pointer-events-none`
    (selection only scopes chat queries, which cannot be sent anyway).
- **Enabled while offline** (purely read-only, no mutations):
  - Browsing all existing notes (read, expand, fullscreen, copy text).
  - Reading all messages in all conversations.
  - Listening to an already-generated podcast (audio URL is stored in SQLite).
  - Switching between conversations.

### REQ-005 — Always-visible connection state indicators
Users must always be able to tell at a glance whether a notebook's backend is
reachable, on both the home page and inside a notebook.

**Acceptance criteria:**
- **Home page — dot badge on backend logo:**
  - A small coloured circle is overlaid on the bottom-right corner of each
    notebook card's backend logo icon.
  - Green (`bg-green-400`) = backend is `"up"`.
  - Red (`bg-red-500`) = backend is `"down"`.
  - No dot when status is `"unknown"` (first poll still in flight).
  - A `ring-1 ring-panel` halo cuts the dot cleanly from the icon pixels.
  - `aria-label="online"` / `"offline"` for accessibility.
- **Home page — Read only pill on offline notebook cards:**
  - When a notebook's backend is `"down"`, a pill reading **Read only** appears
    inline in the card, vertically centred against the full card height.
  - Pill style matches the amber offline pill used inside the notebook header.
  - Not shown when status is `"up"` or `"unknown"`.
- **Notebook header — status pill:**
  - A pill is always rendered in the notebook header (once health is known).
  - Green (`border-green-600/50 bg-green-950/60 text-green-400`) reads **Online**
    when the backend is `"up"`.
  - Amber (`border-amber-600/50 bg-amber-950/60 text-amber-400`) reads
    **Offline — read only** when the backend is `"down"`.
  - No pill when status is `"unknown"`.

---

## Out of scope

- Automatic retry or reconnect — the 2 s health poll already handles reconnect.
- Offline document content viewing (file bytes live in OpenRAG/Workbench, not
  SQLite).
- Any new feature that only makes sense with a backend running.
- Changing env var names.
- Windows-specific fixes.
