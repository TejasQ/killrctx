# Requirements — Workbench KB Document Sync

## User story

As a developer using the AI Workbench directly (bypassing killrctx), I want documents
I ingest through the Workbench UI to appear in the Sources panel when I open a
workbench-backed notebook, so the list always reflects reality.

## Requirements

### REQ-001 — Sync on load (background, non-blocking)
When `GET /api/notebooks/[id]` is called, the response is built immediately from
SQLite (fast, no waiting). Concurrently, a background task calls the Workbench KB
document list and inserts any documents missing from SQLite.

**Acceptance criteria:**
- The GET response returns the current SQLite rows without delay.
- A file uploaded directly via the Workbench UI appears in the Sources panel on the
  **next** page load or poll cycle (≤ 3 seconds, matching the existing poll interval).
- No manual user action is required.

### REQ-002 — Sync is non-destructive
Files present in our local `documents` table but absent from the Workbench KB are
**not** deleted from SQLite. (The Workbench KB is the source of truth for what exists;
our table is a superset cache.)

**Acceptance criteria:**
- Existing rows with `ingest_status = 'ready'` or `'indexing'` are left untouched
  during sync.

### REQ-003 — External documents show as ready
Documents inserted by the sync (i.e., not tracked locally) are inserted with
`ingest_status = 'ready'` because they already exist in the KB.

**Acceptance criteria:**
- Synced documents do not show a spinner or "indexing" state in the Sources panel.

### REQ-004 — Workbench-only
The sync logic runs **only** for workbench-backed notebooks (`rag_backend = 'workbench'`).
OpenRAG notebooks are unaffected.

**Acceptance criteria:**
- No extra HTTP calls for OpenRAG notebooks.

### REQ-005 — Graceful degradation
If the Workbench API is unreachable during sync, the request still succeeds and returns
whatever is already in SQLite. No 500 errors due to sync failure.

**Acceptance criteria:**
- Sync errors are caught and swallowed; the GET response is returned normally.

## Out of scope

- Removing local rows when a document is deleted from the Workbench UI.
- Two-way sync (we are read-only from the Workbench side for this feature).
- Syncing document byte counts or MIME types from the Workbench (we have no upload
  bytes on hand for externally ingested files).
- Any UI indication that a document was externally ingested vs. uploaded via our app.
