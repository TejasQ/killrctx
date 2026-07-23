# Design — OpenRAG Filter Import

---

## API routes

### `GET /api/openrag-filters/unlinked`

File: `src/app/api/openrag-filters/unlinked/route.ts`

- Calls `client.knowledgeFilters.search()` (no query arg = returns all filters, up to
  default limit of 20 from the SDK).
- Reads every `openrag_filter_id` from the `notebooks` table.
- Returns the filters whose `id` is NOT in that set.
- Response shape:
  ```json
  { "filters": [ { "id": "...", "name": "...", "queryData": { ... } } ] }
  ```
- If OpenRAG is unreachable, returns `{ "filters": [] }` — the home page simply shows
  nothing rather than an error.
- `export const runtime = "nodejs"` — better-sqlite3 requirement.

### `POST /api/openrag-filters/import`

File: `src/app/api/openrag-filters/import/route.ts`

Request body: `{ "filterId": "<openrag filter id>" }`

Steps (all synchronous where possible):
1. Fetch the full filter from OpenRAG via `client.knowledgeFilters.get(filterId)`.
2. Return 404 if the filter doesn't exist.
3. Check SQLite: if a notebook already has `openrag_filter_id = filterId`, return the
   existing notebook (idempotent — double-click safe).
4. Generate a new `uuid()` for the notebook and a `uuid()` for the default conversation.
5. Insert the `notebooks` row with all `openrag_filter_*` columns populated from the
   filter payload (same fields populated by the lazy `getFilterMeta` refresh in the GET
   bundle route — `icon`, `color`, `limit`, `scoreThreshold` all from `queryData`).
6. Insert the default `conversations` row (`"Conversation 1"`).
7. For each filename in `filter.queryData?.filters?.data_sources ?? []`:
   - Skip `"*"` (wildcard).
   - `INSERT OR IGNORE` a `documents` row: `ingest_status = 'ready'`, `bytes = 0`,
     `openrag_id = null`, `mimetype = null`.
8. Return the newly inserted notebook row.

Response shape: `{ "notebook": { ...Notebook } }`

`export const runtime = "nodejs"`

---

## `src/lib/openrag.ts` changes

Add one new exported function:

```ts
export async function listFilters(): Promise<{ id: string; name: string; queryData: KnowledgeFilterQueryData }[]>
```

Calls `getClient().knowledgeFilters.search()` (returns `KnowledgeFilter[]`).
Maps to the minimal shape the route needs — no new types required beyond the SDK's own.

---

## UI changes

File: `src/app/page.tsx`

### New state
```ts
const [unlinkedFilters, setUnlinkedFilters] = useState<UnlinkedFilter[]>([]);
const [dismissedIds, setDismissedIds]       = useState<Set<string>>(new Set());
const [importing, setImporting]             = useState<string | null>(null); // filterId in flight
```

`UnlinkedFilter` is a local type: `{ id: string; name: string; docCount: number }`.
`docCount` is derived from `filter.queryData?.filters?.data_sources?.filter(s => s !== '*').length ?? 0`.

### Data loading
After `load()` resolves, call `GET /api/openrag-filters/unlinked`. Read dismissed IDs
from `localStorage`. Set `unlinkedFilters` to filters not in the dismissed set.

Only fires when `health.openrag === "up"` — no point hitting the route when OpenRAG is down.

### Import action
```ts
async function importFilter(filterId: string) { ... }
```
- Sets `importing = filterId`.
- POSTs to `/api/openrag-filters/import`.
- On success: prepends the returned notebook to `notebooks`, removes the filter from
  `unlinkedFilters`.
- Clears `importing`.

### Dismiss action
```ts
function dismissFilter(filterId: string) { ... }
```
- Adds `filterId` to `dismissedIds` state.
- Persists the full set to `localStorage` under `killrctx_dismissed_filter_ids`.
- Removes the filter from `unlinkedFilters`.

### Render
Between the create form and the notebook list, render a `<UnlinkedFilterBanner>` when
`unlinkedFilters.length > 0`. This is a plain `<ul>` with one row per filter:

```
⚠ OpenRAG filter "My Research" (3 sources) has no notebook  [Import]  [Dismiss]
```

- "Import" calls `importFilter`. Shows a `<Spinner>` while `importing === filter.id`.
- "Dismiss" calls `dismissFilter`.
- The banner is hidden as soon as `unlinkedFilters` empties.

Styled to match the existing amber warning aesthetic already used on the page
(`amber-400` text, `amber-950/60` background, `amber-600/50` border).

---

## REQ coverage table

| REQ-ID  | Design item |
|---------|-------------|
| REQ-001 | `GET /api/openrag-filters/unlinked` + `listFilters()` + home page fetch on mount |
| REQ-002 | `POST /api/openrag-filters/import` steps 1–8 + `importFilter()` in UI |
| REQ-003 | Step 7 of the import route: `INSERT OR IGNORE` per `data_sources` filename |
| REQ-004 | `dismissFilter()` + `localStorage` + excluded at load time |
| REQ-005 | Routes only hit `openrag.*`; no Workbench branch needed |
