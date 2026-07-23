# Requirements — OpenRAG Filter Import

## User story

As a developer using killrctx, I want to import any OpenRAG knowledge filter that has no
corresponding local notebook so that I can work with data I already ingested directly in
OpenRAG — without having to re-upload every document.

---

## Requirements

### REQ-001 — Detect unlinked filters on the home page

When the home page loads, it must compare the filters that exist in OpenRAG against the
notebooks stored in SQLite and surface any filters that have no matching notebook.

**Acceptance criteria:**
- A new API endpoint lists all OpenRAG knowledge filters and returns those whose `id` is
  not stored as any notebook's `openrag_filter_id`.
- The home page calls this endpoint on mount, alongside the existing `GET /api/notebooks`.
- Filters where the user previously dismissed the import prompt must not re-appear
  (see REQ-004).

### REQ-002 — Import a filter as a new notebook

The user can choose to import an unlinked filter. The result must be indistinguishable
from a notebook created in-app: same SQLite row shape, same `openrag_filter_*` columns,
same default conversation.

**Acceptance criteria:**
- A new `POST /api/openrag-filters/import` route accepts a filter ID and creates a
  notebook row with `openrag_filter_id`, `openrag_filter_name`, `openrag_filter_icon`,
  `openrag_filter_color`, `openrag_filter_limit`, and `openrag_filter_score_threshold`
  all populated from the live filter payload.
- The notebook's `title` is set to the filter's `name`.
- A default "Conversation 1" row is created exactly as `POST /api/notebooks` does.
- The new notebook is returned in the response so the home page can prepend it to the
  list without a follow-up GET.

### REQ-003 — Existing documents appear as sources in the imported notebook

Any filenames already referenced in the filter's `data_sources` list must be visible in
the imported notebook's Sources panel as ready documents.

**Acceptance criteria:**
- The import route inserts one `documents` row for each filename in the filter's
  `queryData.filters.data_sources` list (excluding the wildcard `"*"`).
- Each inserted row has `ingest_status = 'ready'` (the file is already in OpenRAG),
  `bytes = 0` (we don't know the size), and `openrag_id = null` (no task ID).
- Filenames already present in SQLite for this notebook are skipped (idempotent).

### REQ-004 — Dismiss without importing

The user can dismiss an unlinked filter prompt so it stops appearing on future visits.

**Acceptance criteria:**
- Dismissing stores the filter ID in `localStorage` under the key
  `killrctx_dismissed_filter_ids` (JSON array).
- Dismissed filters are excluded from the unlinked list on subsequent page loads.
- Dismissal is local-only — no server state is written.

### REQ-005 — Import is OpenRAG-only

This feature applies only to the OpenRAG backend. Workbench notebooks are out of scope.

---

## Out of scope

- Importing a filter when OpenRAG is unreachable (the prompt simply does not appear).
- Syncing filter changes back to an imported notebook after import (the notebook then
  behaves like any other notebook: sources are managed through the app).
- Bulk-importing all filters at once (the user imports one at a time).
- Detecting that a locally-created notebook's filter was deleted in OpenRAG.
