# backend-availability — Design

## Overview

Replace the hard-blocking `HealthGate` with a non-blocking health banner, make the
home page backend picker health-aware, and put every write action in `SourcesPanel`,
`ChatPanel`, and `StudioPanel` behind an `offline` guard when the notebook's backend
is down.

---

## 1. API route: `GET /api/health`

**File:** `src/app/api/health/route.ts` — **full rewrite**

Current behaviour: returns on the first backend it finds (Workbench if set, otherwise
OpenRAG). Does not probe both.

New behaviour: probe every configured backend in parallel, return a status object for
each one.

```ts
export const runtime = "nodejs"

// Response shape
{
  openrag:   { ok: boolean, url: string } | null,   // null = not configured
  workbench: { ok: boolean, url: string } | null,
}
```

- `null` means the env var for that backend is not set (not even a default URL).
- `{ ok: false }` means the var is set but the probe timed out or returned non-2xx.
- Probe timeout: 3 s each, both in parallel via `Promise.all`.
- OpenRAG probe: `GET {OPENRAG_URL}/health`
- Workbench probe: `GET {WORKBENCH_URL}/healthz`

---

## 2. Health polling hook

**New file:** `src/hooks/useBackendHealth.ts`

```ts
// Returns { openrag, workbench } — each is 'up' | 'down' | 'unknown'
// Polls /api/health every POLL_MS (30 s). First call fires immediately on mount.
export function useBackendHealth(): BackendHealth
```

- `'unknown'` = first fetch not yet complete (brief; renders nothing visible).
- `'up'` / `'down'` = last probe result.
- Polling interval: 30 s. On tab focus, re-poll immediately (uses `visibilitychange`).
- No React context — callers that need it just call the hook. Two callers today:
  `layout.tsx` (banner) and `page.tsx` (picker). Re-using the same hook is fine; each
  component has its own independent 30 s timer. They won't be perfectly synchronised
  but that's acceptable — this is not a real-time monitoring system.

---

## 3. `HealthGate` → `HealthBanner`

**File:** `src/components/HealthGate.tsx` — **full rewrite**, rename to `HealthBanner`

Current: full-viewport spinner until a backend responds; app is unusable.

New: a slim banner at the top of every page. Visible only when at least one configured
backend is `'down'`. Hidden when all configured backends are `'up'` or `'unknown'`.

```tsx
// Banner copy: "OpenRAG is offline — read-only mode" or
//              "AI Workbench is offline — read-only mode" or
//              "OpenRAG and AI Workbench are offline — read-only mode"
// One line, full width, amber background, 36px tall.
// No spinner. No "retrying" copy. The banner disappears automatically
// when the next poll succeeds.
```

The `OpenRAGContext` provider currently lives inside `HealthGate`'s ready branch.
Move it to wrap the children directly in `HealthBanner` regardless of status — the
context only fetches settings once, and an offline backend still returns its last
known values on the next successful poll.

---

## 4. `layout.tsx`

**File:** `src/app/layout.tsx` — **minor update**

- Replace `<HealthGate>` with `<HealthBanner>`.
- `HealthBanner` wraps `{children}` — same nesting, different component.

---

## 5. Home page: `BackendPicker`

**File:** `src/app/page.tsx`

`Home` calls `useBackendHealth()`. Passes `health` down to `BackendPicker`.

`BackendPicker` already shows both options as always-enabled. Change:

- `openrag` option: disabled when `health.openrag === 'down'` or the env var is unset.
- `workbench` option: disabled when `health.workbench === 'down'` or the env var is unset.
- Disabled options show a dim `(offline)` suffix instead of the URL.
- `'unknown'` = treat as enabled (don't block on first paint).

No other changes to `page.tsx`.

---

## 6. Notebook page: `offline` prop

**File:** `src/app/notebooks/[id]/page.tsx`

The page already knows `notebook.rag_backend` (`"openrag"` | `"workbench"`).

Add `useBackendHealth()` call at the top of the page component. Derive:

```ts
const offline =
  notebook != null &&
  health[notebook.rag_backend] === 'down'
```

Pass `offline: boolean` to all three panels.

### SourcesPanel changes (when `offline`)

- `+ Add source(s)` button: `disabled`
- Folder button: `disabled`
- URL button: `disabled` (and URL input if open: hidden)
- Bulk delete button: `disabled`
- Per-row Retry button: `disabled`
- No new UI elements needed — `disabled` on existing buttons is enough.
- Do NOT disable checkboxes (read = fine; the delete action that consumes selection is already disabled).

### ChatPanel changes (when `offline`)

- Send button: `disabled`
- Input field: `disabled`
- New conversation button: `disabled`
- Delete conversation button: `disabled`
- Show a one-line notice above the input: `"Backend offline — chat unavailable"`
- Do NOT hide conversation history (read = fine).

### StudioPanel changes (when `offline`)

- All type-selector cards: `disabled` (pointer-events-none + reduced opacity)
- Generate button: `disabled`
- Delete note button: `disabled` (per-card and in expanded view footer)
- Topic input: `disabled`
- In-flight previews: unaffected — a generation already running when offline hits
  is allowed to finish (the stream completes from the server side anyway).
- Do NOT hide existing notes (read = fine).

---

## 7. Prop changes summary

### `SourcesPanel`
Add `offline: boolean` to its props interface. Guard the four write paths.

### `ChatPanel`
Add `offline: boolean`. Guard send, new conv, delete conv, input.

### `StudioPanel`
Add `offline: boolean`. Guard type cards, generate, delete note.

---

## REQ coverage

| REQ-ID | Design item |
|--------|-------------|
| REQ-001 | `HealthBanner` replaces `HealthGate`; app loads without waiting for backend |
| REQ-002 | `useBackendHealth` polls every 30 s; banner appears/disappears automatically |
| REQ-003 | `BackendPicker` disables offline/unconfigured options; uses `useBackendHealth` |
| REQ-004 | `offline` prop in all three panels; all write actions disabled; reads allowed |
| REQ-004 | `/api/health` probes both backends in parallel |

---

## What this design deliberately does NOT do

- No per-panel "backend offline" overlay — disabled buttons are enough.
- No retry button in the banner — polling handles recovery automatically.
- No toast notifications — the banner is the only offline signal.
- No persisted offline state — everything is in-memory, reset on page load.
- No changes to `src/lib/` or any API route other than `/api/health`.
