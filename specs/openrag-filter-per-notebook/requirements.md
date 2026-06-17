# Requirements — OpenRAG Filter Per Notebook

## User story

As a developer using killrctx, I want each notebook to have its own dedicated OpenRAG
knowledge filter so that chat, document ingest, and AI generation are scoped to that
notebook's sources only — instead of searching across all uploaded documents globally.

---

## Requirements

### REQ-001 — Filter created on notebook creation

When a new notebook is created, a corresponding OpenRAG knowledge filter must be created
at the same time.

**Acceptance criteria:**
- `POST /api/notebooks` creates an OpenRAG filter via the SDK (`client.knowledgeFilters.create`)
  immediately after inserting the SQLite row.
- The filter's `name` is the notebook title (or "Untitled notebook" if none was given).
- The filter's `id` (returned by OpenRAG) is stored in a new `openrag_filter_id` column
  on the `notebooks` table.
- If OpenRAG is unreachable at creation time, the notebook is still created — the filter
  can be created lazily on next use (see REQ-007).
- There is exactly one filter per notebook. Re-running the creation endpoint should never
  produce a second filter for the same notebook.

### REQ-002 — Document ingest scoped to the notebook filter

When a file is ingested into a notebook, the resulting document must be associated with
that notebook's OpenRAG filter.

**Acceptance criteria:**
- The ingest call passes the notebook's `openrag_filter_id` to OpenRAG so the filter's
  `data_sources` is updated to include the filename.
  _(The reference implementation in SonicDMG/rag-to-model-compare shows this pattern.)_
- If the notebook has no filter yet (creation failed earlier), a filter is created
  before ingest proceeds.
- No duplicate filter creation: the route reads the existing `openrag_filter_id` from
  the database before creating any filter.

### REQ-003 — Chat uses the notebook filter

Every chat request passes the notebook's `openrag_filter_id` so retrieval is scoped to
only that notebook's documents.

**Acceptance criteria:**
- `chat.create()` is called with `filterId: notebook.openrag_filter_id`.
- If `openrag_filter_id` is null (filter creation failed), chat falls back to the
  current behaviour (no filterId), so the chat panel still works.

### REQ-004 — Filter info strip in the notebook header

The notebook page header displays the active filter name, to the **left** of the
existing model info/picker, styled to match OpenRAG's own filter UI (coloured
pill/badge, "filter: filtername" label pattern as seen in the
SonicDMG/rag-to-model-compare reference).

**Acceptance criteria:**
- The strip appears in the top header bar, to the left of the `model: <name>` chip,
  as "filter: \<name\>".
- Styling matches OpenRAG's filter badge colour convention: amber/orange palette
  (`#f59e0b` / `amber-400`) with a dark background tint, consistent with how OpenRAG
  renders filter labels in its own UI.
- The filter name is read from `openrag_filter_name` stored in SQLite — no round-trip
  to OpenRAG needed.
- The strip is shown whenever `openrag_filter_name` is non-null; hidden for old
  notebooks that pre-date this feature.

### REQ-005 — Cascade delete on notebook deletion

When a notebook is deleted, all related OpenRAG resources are cleaned up.

**Acceptance criteria:**
- `DELETE /api/notebooks/[id]` also:
  1. Calls `client.knowledgeFilters.delete(filterId)` to remove the OpenRAG filter.
  2. Calls `client.chat.delete(chatId)` for every conversation that has a
     `response_id` (existing behaviour for notes; now also for message threads).
  3. Calls `client.documents.delete(filename)` for every document in the notebook
     (existing documents-panel delete path; now triggered by notebook delete too).
- All three cleanups are best-effort: if any fails, the SQLite delete still proceeds.
- Existing `ON DELETE CASCADE` foreign keys in SQLite handle the local rows.

### REQ-006 — Filter name stored in SQLite

The notebook row stores enough information to display the filter strip without a
round-trip to OpenRAG.

**Acceptance criteria:**
- `notebooks` table gains `openrag_filter_id TEXT` (nullable) and
  `openrag_filter_name TEXT` (nullable) columns.
- `openrag_filter_name` is set to the filter name at creation time and is the value
  shown in the UI strip.

### REQ-007 — Lazy filter creation (fallback)

If OpenRAG was down when a notebook was created, the filter is created on the first
document ingest attempt.

**Acceptance criteria:**
- The document ingest route checks whether `openrag_filter_id` is NULL before calling
  `ingestDocument`.
- If NULL, it attempts filter creation, stores the result, then proceeds.
- This is a one-shot attempt per ingest request; it does not retry in the background.

### REQ-008 — Studio notes and podcast scoped to the notebook filter

All AI generation in the Studio panel (summary, mindmap, outline, Q&A, podcast) must
retrieve only from the notebook's own documents, not the global index.

**Acceptance criteria:**
- `generateNote()` in `src/lib/openrag.ts` accepts an optional `filterId` parameter
  and passes it to the underlying `chat()` call as `filterId`.
- `chat()` in `src/lib/openrag.ts` accepts an optional `filterId` parameter and
  forwards it to `client.chat.create({ filterId })`.
- Every note-generation route (`/api/notebooks/[id]/notes/*`) and the podcast route
  reads `notebook.openrag_filter_id` from SQLite and passes it to `generateNote()`.
- If `openrag_filter_id` is null, generation proceeds without a filter (same as today).

---

## Out of scope

- Renaming a filter when the notebook title changes (the filter name is fixed at
  creation time to keep things simple).
- Displaying the filter's query/data-source details beyond the name.
- Per-filter access control or sharing.
- Migrating existing notebooks to have filters (old notebooks will have null
  `openrag_filter_id` and will fall back to the no-filter chat behaviour).
- UI for manually picking or switching filters.
