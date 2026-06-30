# Requirements — Retry Failed Ingest

## User story

As a developer using killrctx, I want a retry button on failed sources so that I can
re-ingest a document without having to find and re-add the file manually.

---

## Background

When ingest fails, the SQLite row stays with `ingest_status = 'failed'` and the UI shows
"✕ Failed". The original file bytes are **not** stored in SQLite — only the filename and
byte count. This means a server-side "retry" that silently replays the upload is not
possible; the file must come from the browser again.

The cleanest approach that avoids a new API route: a **"↺ Retry" button** on each failed
row opens a hidden `<input type="file">` pre-filtered to the failed file's extension. The
user picks the file (same or corrected version), and it flows through the existing
`upload()` function which already handles overwrites natively.

---

## Requirements

### REQ-001 — Retry button on failed rows
Every source row whose `ingest_status === "failed"` shows a small "↺ Retry" button
inline, replacing or appending to the existing "✕ Failed" indicator.

**Acceptance criteria:**
- The button is only visible on rows with `ingest_status === "failed"`.
- It is not shown on `"indexing"` or `"ready"` rows.
- Clicking it opens a file picker scoped to the failed file's extension (or the full
  `ACCEPT` string as a fallback).

### REQ-002 — Re-upload flows through existing `upload()` path
The file the user picks is passed directly to the existing `upload()` function with no
special-casing. The existing overwrite logic already handles re-ingesting a file with the
same name without a pre-delete.

**Acceptance criteria:**
- After picking the file, the Sources panel shows "Uploading…" using the existing
  progress state.
- The row transitions from `failed` → `indexing` → `ready` (or `failed` again) exactly
  as a fresh upload would.

### REQ-003 — One hidden input per retry, not per row
A single hidden `<input type="file">` is reused for all retries. When the retry button
is clicked, the input's `accept` attribute is updated to match the failed file's
extension and it is programmatically `.click()`-ed.

**Acceptance criteria:**
- Only one extra `<input>` element exists in the DOM regardless of how many failed rows
  there are.

### REQ-004 — Retry button disabled during upload
If an upload is already in progress (either from the main picker or a prior retry), the
retry button is disabled.

**Acceptance criteria:**
- `disabled={!!uploading}` applied to the retry button.

---

## Out of scope

- No server-side retry endpoint — the browser must re-supply the bytes.
- No automatic retry on failure.
- No retry for URL-ingested sources (the URL path has its own re-add flow).
- No changes to SQLite schema or API routes.
