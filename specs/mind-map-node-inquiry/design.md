# Design — Mind Map Node Inquiry

## Overview

_Basically_, clicking a mind map node shows you all prior research conversations tied
to that node, or starts a new one if none exist. The connection is persisted in a
`mind_map_links` table so the map remembers what you've explored even after page reload.

The core interaction:
- Unlinked node → create conversation, send framed question, write link
- Linked node → show picker with list of conversations + "New conversation" option

The visual signal: linked nodes display a small persistent count badge showing how many
conversations are attached.

---

## SQLite changes

### New table: `mind_map_links`

```sql
CREATE TABLE IF NOT EXISTS mind_map_links (
  id              TEXT PRIMARY KEY,
  note_id         TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  node_label      TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mind_map_links_note ON mind_map_links(note_id);
CREATE INDEX IF NOT EXISTS idx_mind_map_links_conv ON mind_map_links(conversation_id);
```

**No uniqueness constraint** on `(note_id, node_label)` — one node can have many linked
conversations. Indexed by both `note_id` (for bundle fetch) and `conversation_id` (for
cascade delete check).

**Cascade semantics — DB layer:**
- **Notebook deleted** → `notes` rows cascade-deleted (existing FK) → `mind_map_links`
  rows cascade-deleted via `note_id` FK. Full chain covered without extra logic.
- **Note deleted** → all `mind_map_links` for that `note_id` are removed by the DB.
- **Conversation deleted** → all `mind_map_links` for that `conversation_id` are removed
  by the DB.

SQLite `PRAGMA foreign_keys = ON` must be set on every connection for `ON DELETE CASCADE`
to fire. **This pragma is currently missing from `getDb()` in `src/lib/db.ts`** — the
schema declares `ON DELETE CASCADE` FKs but they are silently ignored today. Adding
`conn.pragma("foreign_keys = ON")` to `getDb()` fixes cascades for all existing tables
(notebooks→conversations, notebooks→documents, notebooks→messages, notebooks→notes) and
for the new `mind_map_links` table. This is a one-line fix with no migration needed.

**Cascade semantics — UI layer:**
The DB handles persistence, but `NotebookPage` holds `mindMapLinks` in React state.
State must be kept in sync when a note or conversation is deleted so count badges
disappear immediately without waiting for a full `refresh()`.

- **Note deleted** (`onDeleted` callback in `StudioPanel`): `NotebookPage` calls
  `refresh()` today, which re-fetches everything including links. No extra work needed.
- **Conversation deleted** (`onConvDeleted` callback): the existing handler updates
  `conversations` state but does **not** touch `mindMapLinks`. Add a filter step:
  ```ts
  setMindMapLinks((links) => links.filter((l) => l.conversation_id !== deletedId));
  ```
  This removes the badge immediately on the node whose linked conversation was just
  deleted.

**Migration:** Add the table and indexes in `src/lib/db.ts` `getDb()` using the same
`conn.exec` idempotent pattern as the existing schema.

---

## API route changes

### `GET /api/notebooks/[id]` — bundle route

Add `mind_map_links` to the response alongside `notes`. The bundle already includes
`notes`, `conversations`, and `messages` — links join naturally here.

Response shape change:
```ts
{
  notebook: Notebook;
  documents: Document[];
  conversations: Conversation[];
  messages: Message[];
  notes: Note[];
  mindMapLinks: MindMapLink[];  // NEW
}
```

Type:
```ts
type MindMapLink = {
  id:              string;
  note_id:         string;
  node_label:      string;
  conversation_id: string;
  created_at:      number;
};
```

SQL:
```sql
SELECT * FROM mind_map_links WHERE note_id IN (SELECT id FROM notes WHERE notebook_id = ?)
```

Returned sorted by `created_at DESC` so the picker shows most recent first.

---

### `POST /api/notebooks/[id]/conversations` — create conversation

Already exists. No change to the route — callers provide `{ title }` (optional).

After the feature is live, calls from `NotebookPage.handleNodeAsk` will provide a
custom title format:
```ts
{ title: `🔗 ${nodeLabel} — ${noteTitle}` }
```

The `🔗` prefix signals that this conversation is a mind-map citation. The user sees
"🔗 Attack Roll: d20 — Berserker Korg" in the conversation list and knows it came
from the map.

---

### `POST /api/notebooks/[id]/mind-map-links` — new route

Create a link record after a conversation is created for a node.

**Request:**
```json
{
  "noteId":         "uuid",
  "nodeLabel":      "Attack Roll: d20",
  "conversationId": "uuid"
}
```

**Response:**
```json
{
  "link": {
    "id": "uuid",
    "note_id": "uuid",
    "node_label": "Attack Roll: d20",
    "conversation_id": "uuid",
    "created_at": 1234567890
  }
}
```

SQL:
```sql
INSERT INTO mind_map_links (id, note_id, node_label, conversation_id, created_at)
VALUES (?, ?, ?, ?, ?)
```

Validates that both `note_id` and `conversation_id` exist via FK checks. If either is
missing, returns 404.

---

## UI changes

### `src/lib/db.ts`

Export the new type:
```ts
export type MindMapLink = {
  id:              string;
  note_id:         string;
  node_label:      string;
  conversation_id: string;
  created_at:      number;
};
```

Add the `mind_map_links` table DDL + indexes to `getDb()` via `conn.exec`, same
idempotent pattern as the existing schema.

---

### `src/components/MindMapRenderer.tsx`

**Four changes:**

**1. External chevron** — unchanged from earlier design. Move collapse toggle outside
the node box as a separate ReactFlow node. See prior design.md for details.

**2. New props: `mindMapLinks` and `onNodeClick`.**

```ts
export default function MindMapRenderer({
  content,
  variant,
  noteId,          // NEW — identifies which note this map belongs to
  topic,           // NEW — frames the question
  mindMapLinks,    // NEW — array of { node_label, conversation_id }[]
  onNodeClick,     // NEW — called with (nodeLabel, linkedConvIds)
}: {
  content:       string;
  variant:       "card" | "expanded" | "fullscreen";
  noteId:        string;
  topic?:        string | null;
  mindMapLinks?: MindMapLink[];
  onNodeClick?:  (nodeLabel: string, linkedConvIds: string[]) => void;
})
```

`mindMapLinks` is the full array from the bundle. `MindMapRenderer` filters it to
`links.filter(l => l.note_id === noteId)` and builds a lookup:
```ts
const linksByLabel = useMemo(() => {
  const map = new Map<string, string[]>();
  for (const link of mindMapLinks ?? []) {
    if (link.note_id !== noteId) continue;
    if (!map.has(link.node_label)) map.set(link.node_label, []);
    map.get(link.node_label)!.push(link.conversation_id);
  }
  return map;
}, [mindMapLinks, noteId]);
```

**3. Visual link indicator — count badge.**

Linked nodes display a small badge showing the count of conversations, positioned in
the top-right corner of the node box. Implementation:

In `buildGraph()`, the `data.label` for each node is wrapped in a container that
includes a badge if `linksByLabel.has(tn.label)`:

```tsx
const linkedCount = linksByLabel.get(tn.label)?.length ?? 0;
const label = linkedCount > 0 ? (
  <span style={{ position: "relative", display: "inline-block", width: "100%" }}>
    {tn.label}
    <span style={{
      position: "absolute",
      top: -6,
      right: -6,
      width: 16,
      height: 16,
      borderRadius: "50%",
      background: "#3b82f6",
      color: "#fff",
      fontSize: 9,
      fontWeight: 600,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      pointerEvents: "none",  // doesn't block node clicks
    }}>
      {linkedCount}
    </span>
  </span>
) : tn.label;
```

**4. Node click handler.**

All nodes become `selectable: true`. `handleNodeClick` fires `onNodeClick(label, linkedConvIds)`.

---

### `src/app/notebooks/[id]/page.tsx`

**Six changes:**

**1. Load and manage `mindMapLinks` state.**

```ts
const [mindMapLinks, setMindMapLinks] = useState<MindMapLink[]>([]);
```

Updated in `refresh()` from the bundle response.

**2. `handleNodeClick(label: string, linkedConvIds: string[])` in `NotebookPage`.**

Replaces the prior `handleNodeAsk` design. Flow:

```ts
async function handleNodeClick(label: string, linkedConvIds: string[]) {
  // If fullscreen, close it — see REQ-005 (handled at NoteCard level, not here).
  
  if (linkedConvIds.length === 0) {
    // Unlinked node → create conversation, send question, write link.
    await createAndLink(label);
  } else if (linkedConvIds.length === 1) {
    // One conversation linked → open it immediately (no picker).
    setActiveConvId(linkedConvIds[0]);
  } else {
    // Multiple conversations → show picker.
    setNodePickerState({ label, convIds: linkedConvIds });
  }
}
```

**3. `createAndLink(label: string)` helper.**

```ts
async function createAndLink(label: string) {
  // 1. Create conversation with formatted title.
  const res = await fetch(`/api/notebooks/${id}/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: `🔗 ${label} — ${notebook.title}` }),
  });
  const { conversation } = await res.json();
  
  // 2. Register in state and switch to it.
  setConversations((cs) => [...cs, conversation]);
  setActiveConvId(conversation.id);
  
  // 3. Send the framed question.
  setPendingAsk(frameQuestion(label, currentNote.topic));
  
  // 4. Write link record.
  const linkRes = await fetch(`/api/notebooks/${id}/mind-map-links`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      noteId: currentNote.id,
      nodeLabel: label,
      conversationId: conversation.id,
    }),
  });
  const { link } = await linkRes.json();
  setMindMapLinks((links) => [...links, link]);
}
```

`frameQuestion(label, topic)` is a small helper that builds the contextual string:
```ts
function frameQuestion(label: string, topic: string | null | undefined): string {
  if (topic?.trim()) {
    return `Tell me more about "${label}" in the context of ${topic.trim()}.`;
  }
  return `Tell me more about "${label}".`;
}
```

**4. Picker state + `NodePickerPopover` component.**

```ts
const [nodePickerState, setNodePickerState] = useState<{ label: string; convIds: string[] } | null>(null);
```

A small popover that appears over the mind map canvas (or near the clicked node, if
positioning is feasible) listing the linked conversations by title + a "New conversation"
button.

Component sketch:
```tsx
function NodePickerPopover({ label, convIds, conversations, onSelect, onNew, onClose }) {
  const linkedConvs = conversations.filter(c => convIds.includes(c.id));
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="rounded-lg border border-edge bg-panel p-4" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 text-sm font-semibold">{label}</div>
        <div className="space-y-2">
          {linkedConvs.map(c => (
            <button key={c.id} onClick={() => onSelect(c.id)} className="...">
              {c.title}
            </button>
          ))}
          <button onClick={onNew} className="...">+ New conversation</button>
        </div>
      </div>
    </div>
  );
}
```

Used in `NotebookPage`:
```tsx
{nodePickerState && (
  <NodePickerPopover
    label={nodePickerState.label}
    convIds={nodePickerState.convIds}
    conversations={conversations}
    onSelect={(convId) => { setActiveConvId(convId); setNodePickerState(null); }}
    onNew={() => { void createAndLink(nodePickerState.label); setNodePickerState(null); }}
    onClose={() => setNodePickerState(null)}
  />
)}
```

**5. `pendingAsk` + `ChatPanel.pendingSend` prop — unchanged from prior design.**

See earlier design.md. `ChatPanel` gets a `pendingSend` prop that triggers `sendText()`
in a `useEffect`.

**6. Thread `noteId`, `topic`, `mindMapLinks`, `onNodeClick` to `MindMapRenderer`.**

Three call sites:
- `NoteCard` card view
- `NoteCard` fullscreen (wraps `onNodeClick` to call `setFullscreen(false)` first)
- `StudioPanel` expanded reading view

All three receive:
```tsx
<MindMapRenderer
  content={note.content}
  variant="..."
  noteId={note.id}
  topic={note.topic}
  mindMapLinks={mindMapLinks}
  onNodeClick={handleNodeClick}
/>
```

---

## Data flow summary

```
Node click (MindMapRenderer)
  → onNodeClick(label, linkedConvIds)               [prop]
  [if fullscreen] → setFullscreen(false)            [NoteCard wraps callback]
  → StudioPanel.onNodeClick                         [prop]
  → NotebookPage.handleNodeClick                    [prop]
      [if no links] → createAndLink(label)
          → POST /conversations                     [fetch]
          → setConversations + setActiveConvId
          → setPendingAsk(frameQuestion(...))
          → POST /mind-map-links                    [fetch]
          → setMindMapLinks
      [if one link] → setActiveConvId(linkedConvIds[0])
      [if multiple] → setNodePickerState({ label, convIds })
          → user picks → setActiveConvId(picked)
          → user clicks "New" → createAndLink(label)
  → [if pendingAsk set] useEffect → ChatPanel.pendingSend
      → sendText(question)                          [existing SSE chat path]
```

---

## REQ coverage

| REQ-ID  | Design item that covers it |
|---------|---------------------------|
| REQ-001 | `handleNodeClick` checks `linkedConvIds.length` — 0 → create+send, 1 → switch, 2+ → picker |
| REQ-002 | `frameQuestion()` in `NotebookPage`; `topic` prop threaded down |
| REQ-003 | `mind_map_links` table with FK cascades; bundle route includes links; `POST /mind-map-links` route |
| REQ-004 | Chevron extracted to standalone ReactFlow node outside the box; `nodeLabel()` simplified; `cursor: pointer` on all non-source nodes |
| REQ-005 | `NoteCard` wraps `onNodeClick` — when fullscreen is active, calls `setFullscreen(false)` first, then `onNodeClick`. Closes the overlay and exposes the chat panel before the picker or question fires. Card and expanded views pass `onNodeClick` through unchanged. |
| REQ-006 | `buildGraph()` adds a count badge to `data.label` when `linksByLabel.has(tn.label)` — shows `linkedConvIds.length` in a small blue circle top-right of the node |
| REQ-007 | `conn.pragma("foreign_keys = ON")` added to `getDb()` in `src/lib/db.ts` — one line, enables all declared `ON DELETE CASCADE` FKs across every table |
