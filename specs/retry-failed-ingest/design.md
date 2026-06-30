# Design — Retry Failed Ingest

## Overview

All changes are confined to `SourcesPanel` in
`src/app/notebooks/[id]/page.tsx`. No API routes, no SQLite schema changes.
A single shared hidden `<input type="file">` is added; when a retry button is
clicked, its `accept` is set to the failed file's extension and it is
programmatically clicked. The selected file goes straight into the existing
`upload()` function.

---

## UI changes

### New hidden retry input

```tsx
<input
  ref={retryInputRef}
  type="file"
  className="hidden"
  onChange={(e) => {
    const file = e.target.files?.[0];
    if (retryInputRef.current) retryInputRef.current.value = "";
    if (file) upload([file]);
  }}
/>
```

One element regardless of how many failed rows exist. The `accept` attribute
is set imperatively just before `.click()` (see retry handler below).

### New state

| Name | Type | Purpose |
|------|------|---------|
| `retryInputRef` | `RefObject<HTMLInputElement>` | Ref to the shared retry file input |

No other state — `uploading` already covers progress and disabling.

### Retry handler (inline, not a named function)

Called from each failed row's button `onClick`:

```tsx
onClick={() => {
  const ext = "." + d.filename.split(".").pop()?.toLowerCase();
  if (retryInputRef.current) {
    retryInputRef.current.accept = SUPPORTED_EXTENSIONS.has(ext) ? ext : ACCEPT;
    retryInputRef.current.click();
  }
}}
```

Setting `accept` on the element before `.click()` scopes the OS picker to the
relevant file type. Falls back to the full `ACCEPT` string for any extension
not in the whitelist (shouldn't happen in practice, but safe).

### "↺ Retry" button in failed row

Replaces the plain `<span>` that currently shows "✕ Failed":

```tsx
{d.ingest_status === "failed" && (
  <>
    <span>·</span>
    <span
      className="cursor-help text-red-400"
      title={d.ingest_error ?? "Ingest failed"}
    >
      ✕ Failed
    </span>
    <button
      disabled={!!uploading}
      onClick={...retry handler...}
      className="text-xs text-accent hover:underline disabled:opacity-50"
      title="Re-upload this file to retry ingest"
    >
      ↺ Retry
    </button>
  </>
)}
```

The "✕ Failed" label is kept so the error tooltip (`title={d.ingest_error}`)
remains accessible. "↺ Retry" is appended after it.

---

## Data flow

```
User clicks "↺ Retry" on a failed row
  → retryInputRef.accept = file's extension
  → retryInputRef.click()  → OS file picker opens

User picks file
  → onChange fires with the single File
  → retryInputRef.value = ""   (reset so same file can be re-picked)
  → upload([file])             ← existing function, existing API

upload() runs
  → duplicate check → OverwriteDialog (name matches, so user confirms)
  → POST /api/notebooks/[id]/documents  (overwrite path — UPDATE in SQLite)
  → onUploaded() on success
  → row transitions: failed → indexing → ready (polled by existing refresh)
```

---

## REQ coverage

| REQ-ID | Design item |
|--------|-------------|
| REQ-001 | "↺ Retry" button rendered only when `d.ingest_status === "failed"` |
| REQ-002 | `upload([file])` called directly — overwrite path handles same-filename re-ingest |
| REQ-003 | Single `retryInputRef` input reused across all rows via imperatively-set `accept` |
| REQ-004 | `disabled={!!uploading}` on the retry button |
