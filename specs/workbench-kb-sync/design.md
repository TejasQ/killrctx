# Design — Workbench KB Document Sync

## Overview

The sync is a single fire-and-forget block inside the existing
`GET /api/notebooks/[id]` handler, modelled after the ingest-status poller already
in that route. No new routes, no new DB columns, no new UI.

---

## SQLite changes

None. The existing `documents` table already has every column we need:

| column | value for synced row |
|---|---|
| `id` | `uuid()` |
| `notebook_id` | notebook's `id` |
| `filename` | `sourceFilename` from Workbench |
| `bytes` | `0` — we don't have the original bytes |
| `mimetype` | `null` — not available from the KB list |
| `openrag_id` | `null` — no ingest task to poll |
| `ingest_status` | `'ready'` (REQ-003) |
| `ingest_error` | `null` |
| `created_at` | `Date.now()` at sync time |

---

## `src/lib/backends/workbench.ts` changes

Add a new exported function `listDocuments(kbId: string): Promise<{ sourceFilename: string }[]>`.

`deleteDocument` already calls `GET /knowledge-bases/{kbId}/documents` and parses
`{ items: { documentId: string; sourceFilename: string }[] }`. Extract that HTTP call
into the new function and have `deleteDocument` call it, so there's no duplicated fetch
logic.

```ts
async function listDocuments(kbId: string): Promise<{ sourceFilename: string }[]> {
  const url = wsPath(`/knowledge-bases/${kbId}/documents`);
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) return [];
  const data = (await res.json()) as { items: { documentId: string; sourceFilename: string }[] };
  return data.items;
}
```

This function is **not** added to the `RagBackend` interface — it's workbench-specific
and only called from the route layer. The `workbench` module exports it directly.

---

## API route changes

### `GET /api/notebooks/[id]`  (`src/app/api/notebooks/[id]/route.ts`)

After building the SQLite response payload, add a fire-and-forget sync block that runs
only for workbench-backed notebooks:

```ts
// Fire-and-forget: insert any KB docs not yet in SQLite so external ingests
// show up on the next refresh (REQ-001).
if (notebook.rag_backend === "workbench" && notebook.workbench_kb_id) {
  void (async () => {
    try {
      const kbDocs = await listDocuments(notebook.workbench_kb_id!);
      const known = new Set(
        (db.prepare("SELECT filename FROM documents WHERE notebook_id = ?")
          .all(id) as { filename: string }[]).map((r) => r.filename)
      );
      for (const { sourceFilename } of kbDocs) {
        if (!known.has(sourceFilename)) {
          db.prepare(
            `INSERT INTO documents (id, notebook_id, filename, bytes, ingest_status, created_at)
             VALUES (?, ?, ?, 0, 'ready', ?)`
          ).run(uuid(), id, sourceFilename, Date.now());
        }
      }
    } catch {
      // Workbench unreachable — serve what SQLite has (REQ-005).
    }
  })();
}
```

The block fires **after** the response payload is assembled from SQLite, so the current
request always returns immediately (REQ-001). The next poll (≤ 3 s) picks up any new rows.

---

## UI changes

None. The Sources panel already renders every row from `documents` returned by the
GET payload. Newly synced rows will appear automatically on the next refresh.

---

## REQ coverage

| REQ-ID | Design item |
|--------|-------------|
| REQ-001 | Fire-and-forget block runs after payload is built; response is immediate |
| REQ-002 | Sync only inserts; no deletes |
| REQ-003 | Synced rows use `ingest_status = 'ready'` |
| REQ-004 | Block is gated on `notebook.rag_backend === "workbench"` |
| REQ-005 | `try/catch` swallows all errors from the Workbench call |
