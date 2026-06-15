# Design — CRUD Operations for Notebooks, Sources, and Studio Items

---

## SQLite changes

### New table: `conversations`

```sql
CREATE TABLE IF NOT EXISTS conversations (
  id          TEXT PRIMARY KEY,
  notebook_id TEXT NOT NULL,
  title       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY(notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE
);
```

### Altered table: `messages` — add `conversation_id`

`messages` gets a `conversation_id` column that ties each turn to a specific
conversation thread. This requires a two-step migration (same idempotent
pattern as the existing `response_id` migration in `getDb()`):

1. `ALTER TABLE messages ADD COLUMN conversation_id TEXT` — safe to run even
   if the column already exists (caught by the surrounding try/catch).
2. After adding the column, for every existing notebook that has messages but
   no conversations row yet, synthesise a single default conversation row
   (`id = nb_<notebookId>_default`, `title = "Conversation 1"`) and
   `UPDATE messages SET conversation_id = <defaultId> WHERE notebook_id = ?`
   for that notebook.

This migration runs inside `getDb()` so it's automatic on first boot after the
update — no manual step required.

### New export type: `Conversation`

```ts
export type Conversation = {
  id: string;
  notebook_id: string;
  title: string;
  created_at: number;
};
```

Add to `src/lib/db.ts` alongside the existing row types.

---

## API routes

All new routes export `runtime = "nodejs"` (better-sqlite3 requirement).

### PATCH `/api/notebooks/[id]`  — rename notebook

- **File:** `src/app/api/notebooks/[id]/route.ts` (add `PATCH` export to
  existing file)
- **Body:** `{ title: string }`
- **Success:** `200 { notebook: Notebook }`
- **Errors:** `404` if notebook not found; `400` if title is blank after trim

```
PATCH /api/notebooks/:id
{ "title": "My New Title" }
→ 200 { "notebook": { id, title, ... } }
```

### POST `/api/notebooks/[id]/conversations` — create conversation

- **File:** `src/app/api/notebooks/[id]/conversations/route.ts` (new file)
- **Body:** `{ title?: string }` — defaults to `"Conversation <n+1>"` where
  `n` is the current count of conversations for this notebook.
- **Success:** `200 { conversation: Conversation }`
- **Errors:** `404` if notebook not found

### DELETE `/api/notebooks/[id]/conversations/[convId]` — delete conversation

- **File:** `src/app/api/notebooks/[id]/conversations/[convId]/route.ts`
  (new file)
- Deletes the `conversations` row; the `ON DELETE CASCADE` on the (new)
  `conversations → messages` foreign key cleans up messages automatically.
  
  > **Wait — messages currently foreign-key to `notebooks`, not
  > `conversations`.** After the migration we add a *second* FK column
  > (`conversation_id`) but SQLite doesn't let you add a FK retroactively via
  > `ALTER TABLE`. Instead, we delete messages explicitly:
  > `DELETE FROM messages WHERE conversation_id = ?` before deleting the
  > conversation row. Simple, explicit, no schema surgery needed.

- **Special case:** if this is the last conversation for the notebook, instead
  of leaving the notebook with no conversation: delete all messages for the
  conversation, then reset the conversation row in-place (generate a new `id`,
  reset `title` to `"Conversation 1"`, reset `created_at`). Return the
  replacement row as `{ conversation }` with status `200` so the client knows
  to switch to it.
- **Success (normal):** `200 { ok: true }`
- **Success (last conv):** `200 { conversation: Conversation }` — client
  switches active conversation to the returned row
- **Errors:** `404` if conversation not found for this notebook

### DELETE `/api/notebooks/[id]/podcasts/[podcastId]` — delete one podcast

- **File:** `src/app/api/notebooks/[id]/podcasts/[podcastId]/route.ts`
  (new file)
- Deletes the `podcasts` row from SQLite.
- If `audio_url` is non-null and matches `/podcasts/<id>.mp3`, deletes the
  file at `public/podcasts/<id>.mp3` using `fs.unlinkSync` (best-effort;
  swallow ENOENT).
- **Success:** `200 { ok: true }`
- **Errors:** `404` if podcast row not found for this notebook

### Bundle endpoint — include `conversations`

- **File:** `src/app/api/notebooks/[id]/route.ts` — update `GET` to also
  query conversations and include them in the response payload.

```ts
const conversations = db
  .prepare("SELECT * FROM conversations WHERE notebook_id = ? ORDER BY created_at ASC")
  .all(id) as Conversation[];

return NextResponse.json({ notebook, documents, messages, conversations, podcasts });
```

  > Messages are still returned flat (all conversations). The client filters
  > by `conversation_id` in state — no per-conversation message fetch needed.

### Chat route — scope `response_id` to conversation

- **File:** `src/app/api/notebooks/[id]/chat/route.ts`
- **Body change:** add `conversationId: string` to the expected body.
- The `lastAssistant` query becomes:
  ```sql
  SELECT response_id FROM messages
  WHERE notebook_id = ? AND conversation_id = ?
    AND role = 'assistant' AND response_id IS NOT NULL
  ORDER BY created_at DESC LIMIT 1
  ```
- `INSERT INTO messages` gains `conversation_id` in the column list.
- Return `400` if `conversationId` is missing or blank.

---

## `src/lib/db.ts` changes

1. Add `Conversation` type export.
2. Add `conversations` `CREATE TABLE IF NOT EXISTS` to the `conn.exec` block.
3. Add migration block (after the existing `response_id` migration) that:
   a. `ALTER TABLE messages ADD COLUMN conversation_id TEXT` (try/catch).
   b. For each notebook that has messages with `conversation_id IS NULL`,
      insert a default `conversations` row and back-fill `messages`.

---

## UI changes

### `src/app/notebooks/[id]/page.tsx`

#### State additions in `NotebookPage`

```ts
const [conversations, setConversations] = useState<Conversation[]>([]);
const [activeConvId, setActiveConvId] = useState<string | null>(null);
```

`refresh()` populates `conversations` from the bundle; after setting
`conversations`, if `activeConvId` is `null` (first load) set it to
`conversations[0]?.id ?? null`.

Add `Conversation` to the local type declarations at the top of the file.

#### Header — inline rename (REQ-001)

Replace the static `<h1>{notebook.title}</h1>` with an `InlineTitle`
sub-component (defined at the bottom of the same file):

```
InlineTitle({ title, onSave })
  - Renders a <span> when not editing; click → <input> with current value
  - Enter / blur → calls onSave(newTitle); trims; ignores empty
  - Escape → reverts to original
  - onSave calls PATCH /api/notebooks/[id], then setNotebook({ ...notebook, title })
```

No full `refresh()` needed — just update the notebook slice of state.

#### `SourcesPanel` — bulk delete (REQ-002)

New state:
```ts
const [selected, setSelected] = useState<Set<string>>(new Set());
```

- Each source `<li>` gains a checkbox (always rendered, opacity-0 until
  `selected.size > 0` or the row is hovered — same reveal pattern as the
  existing menu button).
- `selected.size > 0` → show a footer bar with "Select all", "Deselect all",
  and a red "Delete selected (n)" button.
- `bulkDelete()`: iterate `selected`, call
  `DELETE /api/notebooks/[id]/documents/[docId]` for each, then
  `setSelected(new Set())` and `onUploaded()`.
- The existing `remove(d)` single-delete function stays; it's reused by
  the existing 3-dot menu.

#### `ChatPanel` — conversation switcher + new/delete (REQ-004, REQ-005)

New props:
```ts
conversations: Conversation[]
activeConvId: string | null
onConvChange: (id: string) => void
onConvCreated: (conv: Conversation) => void
onConvDeleted: (deletedId: string, replacement?: Conversation) => void
```

Panel header becomes a two-row header:
```
┌──────────────────────────────────────────────┐
│ [▾ Conversation 1]          [+ New]  [🗑 Del] │
└──────────────────────────────────────────────┘
```

- The `[▾ Conversation 1]` is a `<select>` (or a custom dropdown built from
  `MenuButton` — a native `<select>` is simpler and good enough here) listing
  all conversations newest-first. `onChange` calls `onConvChange(id)`.
- `[+ New]` calls `POST /api/notebooks/[id]/conversations`, then
  `onConvCreated(newConv)` which appends to `conversations` and sets
  `activeConvId` to the new id.
- `[🗑 Del]` shows a confirm dialog then calls
  `DELETE /api/notebooks/[id]/conversations/[activeConvId]`. On `{ ok: true }`
  response calls `onConvDeleted(activeConvId)` which removes the conversation
  from state and switches `activeConvId` to the first remaining conversation.
  On `{ conversation }` (last-conv replacement) response calls
  `onConvDeleted(activeConvId, replacement)` which replaces the conversation
  in state and keeps `activeConvId` pointing at the replacement.

Messages rendered in the panel are filtered:
```ts
const visibleMessages = messages.filter(m => m.conversation_id === activeConvId);
```

Add `conversation_id` to the local `Message` type.

The `send()` function passes `conversationId: activeConvId` in the POST body.

#### `StudioPanel` — bulk delete (REQ-003)

New props added: `onDeleted: () => void`

New state:
```ts
const [selected, setSelected] = useState<Set<string>>(new Set());
```

Same checkbox + footer bar pattern as `SourcesPanel`. Each `PodcastCard` gets
a `checked` and `onToggle` prop so the card itself can render the checkbox.

`bulkDelete()`: iterate `selected`, call
`DELETE /api/notebooks/[id]/podcasts/[podcastId]` for each, then clear
selection and call `onDeleted()` (which re-uses the parent `refresh()`).

---

## Background work

No new fire-and-forget patterns needed. The podcast delete route is
synchronous (SQLite delete + `fs.unlinkSync`). The conversation delete route
is synchronous too.

The existing podcast generation background task writes to the `podcasts` row
by `id`. If the row is deleted while synthesis is running, the `UPDATE`
silently matches zero rows — that's fine, no crash.

---

## REQ coverage table

| REQ-ID  | Design item that covers it |
|---------|---------------------------|
| REQ-001 | `PATCH /api/notebooks/[id]` + `InlineTitle` component in page header |
| REQ-002 | `selected` state + `bulkDelete()` in `SourcesPanel`; reuses existing single-delete API |
| REQ-003 | `selected` state + `bulkDelete()` in `StudioPanel`; new `DELETE /api/notebooks/[id]/podcasts/[podcastId]` route |
| REQ-004 | New `conversations` table + `conversation_id` on `messages`; `conversations` included in bundle; `ChatPanel` switcher + message filter |
| REQ-005 | `POST /api/notebooks/[id]/conversations`; `DELETE /api/notebooks/[id]/conversations/[convId]`; New + Delete buttons in `ChatPanel` header |
