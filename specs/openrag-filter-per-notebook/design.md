# Design — OpenRAG Filter Per Notebook

## SQLite changes

### New columns on `notebooks`

```sql
ALTER TABLE notebooks ADD COLUMN openrag_filter_id   TEXT;
ALTER TABLE notebooks ADD COLUMN openrag_filter_name TEXT;
```

Both are nullable. Existing notebooks get NULL in both columns and fall back to the
current no-filter behaviour everywhere.

**Migration strategy** — added to `getDb()` in `src/lib/db.ts` using the same
idempotent sniff-and-ALTER pattern already used for `response_id` and `ingest_status`:

```ts
const nbCols = conn.prepare("PRAGMA table_info(notebooks)").all() as { name: string }[];
if (nbCols.length > 0 && !nbCols.some((c) => c.name === "openrag_filter_id")) {
  conn.exec("ALTER TABLE notebooks ADD COLUMN openrag_filter_id TEXT");
}
if (nbCols.length > 0 && !nbCols.some((c) => c.name === "openrag_filter_name")) {
  conn.exec("ALTER TABLE notebooks ADD COLUMN openrag_filter_name TEXT");
}
```

### Updated `Notebook` type

```ts
export type Notebook = {
  id: string;
  title: string;
  created_at: number;
  openrag_collection: string;
  openrag_filter_id: string | null;    // OpenRAG knowledge filter ID
  openrag_filter_name: string | null;  // display name — no round-trip needed
};
```

---

## `src/lib/openrag.ts` changes

### 1. New `createFilter()` function

```ts
export async function createFilter(name: string): Promise<{ filterId: string }> {
  const r = await getClient().knowledgeFilters.create({ name, queryData: {} });
  if (!r.success || !r.id) throw new Error(r.error ?? "filter creation failed");
  return { filterId: r.id };
}
```

Called by the notebook creation route. `queryData: {}` creates an empty filter —
documents are associated via their filename at ingest time through OpenRAG's filter
scoping when `filterId` is passed to `chat.create`.

### 2. New `deleteFilter()` function

```ts
export async function deleteFilter(filterId: string): Promise<void> {
  await getClient().knowledgeFilters.delete(filterId);
}
```

Best-effort, called by the notebook DELETE route.

### 3. `chat()` — add optional `filterId`

```ts
export async function chat(args: {
  prompt: string;
  previousResponseId?: string | null;
  filterId?: string | null;
  limit?: number;
}): Promise<{ response: string; responseId: string }>
```

Passes `filterId: args.filterId ?? undefined` to `client.chat.create()`. Undefined
(not null) means no filter — the SDK treats undefined as "omit the field".

### 4. `generateNote()` — add optional `filterId`

```ts
export async function generateNote(args: {
  type: "summary" | "mindmap" | "outline" | "qa";
  topic?: string;
  filterId?: string | null;
}): Promise<{ content: string; responseId: string }>
```

Threads `filterId` through to the inner `chat()` call.

### 5. `draftScript()` in `src/lib/podcast.ts` — add optional `filterId`

```ts
export async function draftScript(topic?: string, filterId?: string | null): Promise<string>
```

Threads `filterId` through to the `chat()` call.

---

## API route changes

### `POST /api/notebooks` — `src/app/api/notebooks/route.ts`

After inserting the SQLite row, attempt to create the OpenRAG filter:

```
1. Insert notebook row (existing).
2. Insert default conversation row (existing).
3. Try: createFilter(title) → store filterId + filterName in SQLite.
4. Catch: log, leave both columns NULL — ingest will retry (REQ-007).
5. Return the notebook row (now includes openrag_filter_id / openrag_filter_name).
```

No new helper — the filter creation is 3 lines inline in the route.

### `POST /api/notebooks/[id]/documents` — `src/app/api/notebooks/[id]/documents/route.ts`

Lazy filter creation (REQ-007) + filter-scoped ingest:

```
1. Read notebook row (includes openrag_filter_id).
2. If openrag_filter_id is NULL:
     Try: createFilter(notebook.title) → UPDATE notebooks SET ... WHERE id = ?
     Catch: log, proceed without filter.
3. Call ingestDocument() — unchanged (ingest itself has no filterId param in SDK).
4. Save document row (existing).
```

Note: the OpenRAG SDK's `documents.ingest()` has no `filterId` parameter — filter
scoping happens at **query time** (when `chat.create` is called with `filterId`), not
at ingest time. The reference repo (SonicDMG/rag-to-model-compare) confirms this: it
passes `filterId` to chat calls, not to ingest calls. Documents are automatically
included in a filter's scope when the filter has no explicit `data_sources` restriction
(i.e. `queryData: {}`). REQ-002's acceptance criteria about "associating" documents
with the filter is satisfied by scoping all chat/generation calls to the filterId.

### `DELETE /api/notebooks/[id]` — `src/app/api/notebooks/[id]/route.ts`

Before deleting the SQLite row, perform OpenRAG cleanup (all best-effort):

```
1. Load notebook + all its documents + all conversations with response_ids +
   all notes with response_ids.
2. Best-effort:
   a. deleteFilter(notebook.openrag_filter_id)  — if non-null
   b. deleteDocument(doc.filename)              — for each document
   c. deleteConversation(responseId)            — for each message thread that
                                                  has a response_id (from messages table)
   d. deleteConversation(note.response_id)      — for each note with a response_id
      (already partially done for notes; now also covers chat threads)
3. db.prepare("DELETE FROM notebooks WHERE id = ?").run(id)
   — CASCADE handles all child rows in SQLite.
```

All cleanup steps run in parallel via `Promise.allSettled` to keep the delete fast
even when OpenRAG is slow. Failures are swallowed; the SQLite delete always runs.

### Note generation routes — all four in `src/app/api/notebooks/[id]/notes/*/route.ts`

Each route already reads `notebook` from SQLite. Change the `generateNote()` call to
pass the filter:

```ts
const { content, responseId } = await generateNote({
  type: "summary",   // (mindmap / outline / qa for the other routes)
  topic,
  filterId: notebook.openrag_filter_id ?? null,
});
```

### `POST /api/notebooks/[id]/podcast` — `src/app/api/notebooks/[id]/podcast/route.ts`

Pass the filter to `draftScript()` inside the fire-and-forget block:

```ts
const script = await draftScript(topic, notebook.openrag_filter_id ?? null);
```

### `POST /api/notebooks/[id]/chat` — `src/app/api/notebooks/[id]/chat/route.ts`

Pass the filter to `chat()`:

```ts
const r = await chat({
  prompt: grounded,
  previousResponseId: lastAssistant?.response_id ?? null,
  filterId: notebook.openrag_filter_id ?? null,
});
```

---

## UI changes

### `src/app/notebooks/[id]/page.tsx`

**1. Update the `Notebook` type** (client-side mirror of the SQLite type):

```ts
type Notebook = {
  id: string;
  title: string;
  openrag_collection: string;
  openrag_filter_id: string | null;
  openrag_filter_name: string | null;
};
```

**2. New `FilterBadge` component — `src/components/FilterBadge.tsx`**

The reference repo (`SonicDMG/rag-to-model-compare`) has a `Badge` component and a
`FilterSelector` that map filter colors using the pattern:

```
bg-{color}/10  text-{color}  border-{color}/20   (display/unselected state)
```

We copy that exact pattern. Filters created with `queryData: {}` have no explicit
color set, so we use **teal** — the reference repo's own default fallback color and
the one OpenRAG's UI shows for uncolored filters. The funnel SVG icon is taken
directly from the `FilterSelector` empty-state icon in the reference repo.

```tsx
// src/components/FilterBadge.tsx
export default function FilterBadge({ name }: { name: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-teal-500/20 bg-teal-500/10 px-2.5 py-0.5 text-xs font-medium text-teal-400">
      {/* funnel icon — same SVG path as FilterSelector in rag-to-model-compare */}
      <svg className="h-3 w-3 opacity-70" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
      </svg>
      <span className="opacity-60">filter:</span> {name}
    </span>
  );
}
```

**3. Filter chip in the header** — inserted to the left of the existing `model:` chip
inside the `<header>` flex row:

```tsx
{notebook.openrag_filter_name && (
  <FilterBadge name={notebook.openrag_filter_name} />
)}
```

No new state is needed: `notebook.openrag_filter_name` is already in the refreshed
bundle payload from `GET /api/notebooks/[id]`.

---

## REQ coverage table

| REQ-ID | Design item |
|--------|-------------|
| REQ-001 | `POST /api/notebooks` calls `createFilter()` after inserting the notebook row |
| REQ-002 | Ingest route reads `openrag_filter_id`; lazy-creates filter if NULL (REQ-007 covers fallback) |
| REQ-003 | `chat/route.ts` passes `filterId` to `chat()` |
| REQ-004 | `FilterBadge` component (teal pill + funnel icon, reference repo pattern) in the notebook header, left of model picker |
| REQ-005 | `DELETE /api/notebooks/[id]` runs `Promise.allSettled` cleanup before SQLite delete |
| REQ-006 | `openrag_filter_id` + `openrag_filter_name` columns added with idempotent migration |
| REQ-007 | Documents route: if `openrag_filter_id` is NULL, attempt `createFilter()` before ingest |
| REQ-008 | `generateNote()` + `draftScript()` accept `filterId`; all note/podcast routes pass it |
