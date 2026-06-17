# Task List — OpenRAG Filter Per Notebook

## Tasks

- [x] TASK-01: [DB] Add `openrag_filter_id` and `openrag_filter_name` migration to `getDb()` in `src/lib/db.ts`
- [x] TASK-02: [DB] Add `openrag_filter_id` and `openrag_filter_name` fields to the `Notebook` type in `src/lib/db.ts`
- [x] TASK-03: [lib] Add `createFilter()` and `deleteFilter()` to `src/lib/openrag.ts`
- [x] TASK-04: [lib] Add optional `filterId` param to `chat()` in `src/lib/openrag.ts`
- [x] TASK-05: [lib] Add optional `filterId` param to `generateNote()` in `src/lib/openrag.ts`
- [x] TASK-06: [lib] Add optional `filterId` param to `draftScript()` in `src/lib/podcast.ts`
- [x] TASK-07: [API] Update `POST /api/notebooks` to call `createFilter()` after insert and store the result
- [x] TASK-08: [API] Update `POST /api/notebooks/[id]/documents` to lazy-create filter if `openrag_filter_id` is NULL
- [x] TASK-09: [API] Update `POST /api/notebooks/[id]/chat` to pass `filterId` to `chat()`
- [x] TASK-10: [API] Update all four note routes (`summary`, `mindmap`, `outline`, `qa`) to pass `filterId` to `generateNote()`
- [x] TASK-11: [API] Update `POST /api/notebooks/[id]/podcast` to pass `filterId` to `draftScript()`
- [x] TASK-12: [API] Update `DELETE /api/notebooks/[id]` to cascade-delete filter, documents, and chat threads in OpenRAG before the SQLite delete
- [x] TASK-13: [UI] Create `src/components/FilterBadge.tsx` (teal pill + funnel icon, reference repo pattern)
- [x] TASK-14: [UI] Add `openrag_filter_id` and `openrag_filter_name` to the client-side `Notebook` type in `page.tsx` and render `<FilterBadge>` in the header

## Done when

All tasks are `[x]`, `npm run build` passes with zero errors, and a newly created
notebook shows the filter chip in the header left of the model picker.

## Follow-up

- Rename filter when notebook title changes (currently fixed at creation time).
- Scope Studio generation to filter for notebooks that existed before this feature
  (currently those fall back to no-filter behaviour).
- Display filter colour from `queryData.color` in `FilterBadge` if OpenRAG sets one.
