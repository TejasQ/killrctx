# Design — Document Ingest Status

> **Amendment — error detail & waitForTask fix**
> Added after inspecting the live OpenRAG API response.
> 1. `files[path].error` contains the per-file failure reason. We store it in a new
>    `ingest_error TEXT` column on `documents`.
> 2. `waitForTask` in the SDK is a blocking poll loop — we should use `getTaskStatus`
>    (single fetch, no loop) for our background status checks.
> 3. Tooltip pattern: the app uses native `title="..."` attributes throughout
>    (lines 624, 632, 987 in page.tsx). No custom tooltip component needed.


## Overview

We already store an `openrag_id` (OpenRAG task ID) on every `documents` row. We just
never read it after upload. The plan is:

1. Add an `ingest_status` column to `documents` (`indexing | ready | failed`).
2. After ingest, write the initial status into that column.
3. Add a lightweight API route that polls OpenRAG's task status and updates the column.
4. The existing `refresh()` + polling `useEffect` pattern (already used for podcasts) drives
   the UI — no new polling infrastructure needed.
5. The Sources panel reads `ingest_status` off each document row and renders a spinner or
   error indicator inline.

---

## SQLite changes

Add `ingest_status TEXT` to the `documents` table. Default `'indexing'` — any row that
already exists in the DB predates this feature and was ingested with `wait: true`, so it
is safe to treat them as `'ready'`.

Migration (idempotent, inline in `getDb()`, same pattern as `response_id`):

```sql
ALTER TABLE documents ADD COLUMN ingest_status TEXT NOT NULL DEFAULT 'ready'
```

New rows written by the upload route use `'indexing'` explicitly. The default `'ready'`
means existing rows get the right state without a backfill loop.

Update the `Document` type:

```ts
ingest_status: "indexing" | "ready" | "failed"
```

---

## API routes

### New: `GET /api/notebooks/[id]/documents/[docId]/status`

Checks the OpenRAG task status for a single document and updates our SQLite row.

- Reads `openrag_id` and current `ingest_status` from SQLite.
- If already `ready` or `failed`, returns immediately (no OpenRAG call).
- Otherwise calls `getTaskStatus(openrag_id)` from `src/lib/openrag.ts`.
- Maps OpenRAG result → our status:
  - `successful_files > 0` → `ready`
  - `failed_files > 0` → `failed`
  - anything else → `indexing` (still in flight)
- Writes the new status to SQLite and returns `{ ingest_status }`.

### Modified: `POST /api/notebooks/[id]/documents`

After ingest (now `wait: false` — see lib changes below), write `ingest_status = 'indexing'`
into the new column instead of relying on the default.

---

## `src/lib/openrag.ts` changes

### Revert `wait: true` → `wait: false`

The `wait: true` change made in this branch was the wrong fix for the overwrite race.
The real fix is the status polling — we no longer need to block the upload route.
Reverting keeps uploads fast and non-blocking.

### New: `getTaskStatus(taskId)`

```ts
export async function getTaskStatus(taskId: string): Promise<"indexing" | "ready" | "failed">
```

Calls `getClient().documents.waitForTask(taskId)` — despite the name, with no `wait`
option this is just a single status fetch, not a blocking poll. Maps
`IngestTaskStatus` → our three states.

---

## UI changes

### `src/app/notebooks/[id]/page.tsx`

**State / polling:**
The existing podcast polling `useEffect` already calls `refresh()` every 3s while any
podcast is non-terminal. We add a parallel `useEffect` that does the same for documents:

```ts
useEffect(() => {
  const pending = documents.some((d) => d.ingest_status === "indexing");
  if (!pending) return;
  const t = setInterval(refresh, 3000);
  return () => clearInterval(t);
}, [documents]);
```

`refresh()` hits `GET /api/notebooks/[id]` which already returns all `documents` rows —
the new `ingest_status` column comes along for free.

**`Document` client type:** add `ingest_status: "indexing" | "ready" | "failed"`.

**Sources panel document row:** inline indicator next to the filename:
- `indexing` → `<Spinner size="xs" />` + "Indexing…" label in muted text
- `failed` → small red "✕ Failed" label
- `ready` → nothing (no clutter on the settled state)

---

## Why not poll the status route directly from the client?

The client already polls `GET /api/notebooks/[id]` (the bundle endpoint) every 3s for
podcasts. Piggybacking document status onto that same refresh is simpler than adding a
second per-document polling loop. The bundle route reads `ingest_status` straight from
SQLite — no OpenRAG call on every refresh. The status route is only called when the
bundle refresh shows a document is still `indexing`, which triggers the status-check
background update on the next page load / route hit.

Wait — that creates a gap: `refresh()` reads from SQLite, but SQLite only gets updated
when the status route is called. We need something to actually call the status route.

**Revised approach:** Instead of a separate status route, update the bundle route
(`GET /api/notebooks/[id]`) to fire-and-forget status checks for any `indexing` documents
before returning. This keeps one polling surface and one code path.

```ts
// In GET /api/notebooks/[id] — before building the response:
for (const doc of documents.filter(d => d.ingest_status === 'indexing' && d.openrag_id)) {
  void checkAndUpdateDocStatus(doc); // non-blocking, updates SQLite in background
}
```

`checkAndUpdateDocStatus` is a small async function in the route file itself.

---

## REQ coverage

| REQ-ID | Design item |
|--------|-------------|
| REQ-001 | Spinner in document row when `ingest_status === 'indexing'` |
| REQ-002 | Red "Failed" label in document row when `ingest_status === 'failed'` |
| REQ-003 | Bundle route fires status checks; client polls via existing `useEffect` |
| REQ-004 | `ingest_status` persisted in SQLite; survives page reload |
| REQ-005 | No changes to chat panel; chat is unaffected |
