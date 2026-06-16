# Task List — Document Ingest Status

## Tasks

- [x] TASK-01: [DB] Add `ingest_status` column migration to `getDb()` in `src/lib/db.ts`
- [x] TASK-02: [DB] Add `ingest_status` field to the `Document` type in `src/lib/db.ts`
- [x] TASK-03: [lib] Add `getTaskStatus(taskId)` to `src/lib/openrag.ts` — calls `client.documents.waitForTask(taskId)` (single status fetch, not a blocking poll) and maps `IngestTaskStatus` → `"indexing" | "ready" | "failed"`
- [x] TASK-04: [lib] Revert `wait: true` → `wait: false` in `ingestDocument()` in `src/lib/openrag.ts` — polling replaces blocking
- [x] TASK-05: [API] Write `ingest_status = 'indexing'` on the new document row in `POST /api/notebooks/[id]/documents`
- [x] TASK-06: [API] In `GET /api/notebooks/[id]`, for each document where `ingest_status = 'indexing'` and `openrag_id` is set, fire-and-forget a call to `getTaskStatus()` and write the result back to SQLite — so the next poll sees the updated state
- [x] TASK-07: [UI] Add `ingest_status` to the client `Document` type in `page.tsx`
- [x] TASK-08: [UI] Add document polling `useEffect` to `NotebookPage` in `page.tsx` — mirrors the podcast polling: `setInterval(refresh, 3000)` while any document has `ingest_status === 'indexing'`
- [x] TASK-09: [UI] Render ingest status indicator on each document row in `SourcesPanel`: spinner + "Indexing…" when `indexing`, red "✕ Failed" when `failed`, nothing when `ready`

## Amendment tasks

- [ ] TASK-10: [DB] Add `ingest_error TEXT` column migration to `getDb()` and `Document` type
- [ ] TASK-11: [lib] Switch `getTaskStatus()` from `waitForTask` → `getTaskStatus` SDK method; extract and return error string from `files[*].error`
- [ ] TASK-12: [API] Write `ingest_error` alongside `ingest_status` when updating document rows
- [ ] TASK-13: [UI] Add `ingest_error` to client `Document` type; add `title={d.ingest_error ?? "Ingest failed"}` to the "✕ Failed" label
