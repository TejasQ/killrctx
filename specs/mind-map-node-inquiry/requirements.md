# Requirements — Mind Map Node Inquiry

## User story

As a researcher navigating a mind map, I want to click any node to open or continue
research conversations tied to that node — so that I can dig as deep as I want, return
to prior threads later, and see at a glance which parts of the map I've already explored.

---

## Requirements

### REQ-001 — Node click opens a conversation

Clicking a mind map node opens a conversation tied to that node in the chat panel.

**Acceptance criteria:**
- A single click on any node (that isn't the collapse-toggle chevron) triggers the action.
- If no conversations exist for this node yet, a new one is created and the framed
  question (see REQ-002) is sent automatically.
- If one or more conversations are already linked to this node, a small picker appears
  showing those conversations and a "New conversation" option.
  - Selecting an existing conversation switches to it in the chat panel (no message sent).
  - Selecting "New conversation" creates one and sends the framed question.
- The interaction works in all three mind-map display contexts: card, expanded, fullscreen.

### REQ-002 — Question is contextually framed

The question sent to chat is not just the bare node label. It is framed using the full
ancestor path (root → parent chain) and, if available, the mind-map topic so the LLM
has complete context about where in the map the node lives.

**Acceptance criteria:**
- The framed question includes the ancestor chain as readable breadcrumb context so
  that clicking "Attack Roll: d20" under "Reckless Attack → Abilities → Berserker Korg"
  produces a question like:
  `Tell me more about "Attack Roll: d20" (under: Berserker Korg > Abilities > Reckless Attack) in the context of Berserker Korg.`
- If the clicked node is at the root level (no ancestors), the `(under: …)` part is omitted.
- If no topic is set, the `in the context of …` suffix is omitted.
- The framed question appears as the user's message in the chat panel (visible in the
  transcript), not as a hidden system prompt.

### REQ-003 — Conversation persistence

Each node click is backed by a persistent link between the node and its conversation,
so the connection survives page reload and return visits.

**Acceptance criteria:**
- When a new conversation is created for a node, a `mind_map_links` record is written
  recording `(note_id, node_label, conversation_id)`.
- A node can have multiple `mind_map_links` records — one per conversation started
  from that node. There is no uniqueness constraint on `(note_id, node_label)`.
- If a linked conversation is deleted by the user, its link record is also removed.
  If all links for a node are deleted, the node returns to its unlinked visual state.
- Links are loaded alongside the note so they are available on the initial render
  without an extra fetch.

### REQ-004 — Unambiguous click targets

The collapse/expand chevron must not share a click target with the node body to prevent
accidental inquiry triggers when the user intends to collapse, and vice versa.

**Acceptance criteria:**
- The collapse/expand chevron is rendered **outside and to the right of the node box**,
  not inside it. It is its own independent click target.
- Clicking anywhere on the node body triggers inquiry (REQ-001).
- Clicking the external chevron triggers collapse/expand only — it does not also
  trigger inquiry.
- All nodes (leaf and parent) show a pointer cursor on hover over the node body.
- No persistent icon is added to leaf nodes — the pointer cursor alone signals
  clickability.

### REQ-006 — Linked nodes are visually distinct

Nodes that already have one or more linked conversations show a subtle visual indicator
so the user can see at a glance which parts of the map have prior research attached.

**Acceptance criteria:**
- A linked node displays a small persistent indicator (e.g. a coloured dot or count
  badge) that is always visible — not just on hover.
- An unlinked node shows no indicator.
- The indicator does not interfere with the node label text or the collapse chevron.

### REQ-005 — Chat panel is revealed when node is clicked from fullscreen

When a node is clicked while the mind map is in fullscreen mode, the fullscreen overlay
must close before the chat question is sent so that the user can see the chat panel
respond.

**Acceptance criteria:**
- Clicking a node in fullscreen mode exits fullscreen (returning to the expanded Studio
  reading view) before the chat question is fired.
- The exit happens first — the user sees the layout snap back to the three-panel view,
  then the chat panel activates with the question.
- Clicking a node in the non-fullscreen expanded view or card view fires the question
  without any layout change.

### REQ-007 — Foreign key cascades are enforced

All `ON DELETE CASCADE` relationships declared in the SQLite schema must actually fire.

**Acceptance criteria:**
- `PRAGMA foreign_keys = ON` is set on the database connection in `src/lib/db.ts`.
- Deleting a notebook removes all its conversations, documents, messages, notes, and
  mind map links without any manual cleanup in the API routes.

---

## Out of scope

- Streaming answers directly into the mind map canvas (no inline tooltips or popovers).
- Saving or annotating the inquiry result back onto the mind map node.
- A "cited by" back-link from the conversation message to the originating node.
- Any UI change to the conversation list beyond the auto-title behavior already present.
- Multi-node selection or batch inquiry.
