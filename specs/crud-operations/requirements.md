# Requirements — CRUD Operations for Notebooks, Sources, and Studio Items

**User story:** As a researcher, I want to rename my notebooks, bulk-delete
sources, bulk-delete studio (podcast) items, manage multiple chat conversations
per notebook, and switch between them so that I can keep my workspace
organised without losing prior context.

---

## Requirements

### REQ-001 — Rename notebook

**Feature:** The user can rename a notebook from the notebook view.

**Acceptance criteria:**
- The notebook title in the page header is click-to-edit (inline, not a
  modal). Clicking it turns it into a text input pre-filled with the current
  title.
- Pressing Enter or blurring the input saves the new title via a PATCH/PUT to
  the API. Pressing Escape cancels without saving.
- The page title updates immediately on save (no full refresh needed, though
  the next `refresh()` cycle will also pick it up).
- An empty or whitespace-only title is rejected client-side; the input shakes
  or shows a brief error and reverts to the previous title.
- The API route accepts `{ title: string }` and updates the `notebooks` row.

---

### REQ-002 — Bulk delete sources

**Feature:** The user can select multiple sources in the Sources panel and
delete them all in one action.

**Acceptance criteria:**
- A checkbox appears on each source row (visible on hover, or always visible
  when ≥1 source is checked).
- A "Delete selected (n)" button appears at the bottom of the Sources panel
  when ≥1 source is checked. Clicking it shows a confirm dialog then deletes
  all selected sources, one by one, reusing the existing single-delete API.
- "Select all" / "Deselect all" shortcut is available once any checkbox is
  visible.
- After deletion, the sources list refreshes and checkboxes are cleared.
- Zero selected → no bulk-delete button shown.

---

### REQ-003 — Bulk delete studio (podcast) items

**Feature:** The user can select multiple podcast cards in the Studio panel and
delete them all in one action.

**Acceptance criteria:**
- Same checkbox + bulk-delete pattern as REQ-002 but applied to podcast cards
  in the Studio panel.
- The API provides a `DELETE /api/notebooks/[id]/podcasts/[podcastId]` route
  that removes the row from SQLite and deletes the associated audio file on
  disk (if one exists).
- "Delete selected (n)" button appears in the Studio panel when ≥1 podcast is
  checked.
- In-flight podcasts (status: scripting / synthesizing) can be selected and
  deleted; the background task may still complete but the row will already be
  gone.
- After deletion the panel refreshes and checkboxes are cleared.

---

### REQ-004 — Multiple conversations per notebook

**Feature:** A notebook can hold more than one conversation. Each conversation
is an independent, named thread with its own message history and its own
OpenRAG `response_id` chain.

**Acceptance criteria:**
- The SQLite `messages` table gains a `conversation_id` column (TEXT, NOT
  NULL). All existing messages are migrated into a single default conversation
  per notebook.
- A `conversations` table tracks each thread: `id`, `notebook_id`, `title`,
  `created_at`.
- The Chat panel header shows the active conversation's title and a way to
  switch to another conversation in the same notebook.
- Only messages belonging to the active conversation are displayed.
- The `response_id` chain is scoped per conversation — starting a new
  conversation always begins a fresh OpenRAG thread.

---

### REQ-005 — Start and delete conversations

**Feature:** The user can create new conversations and delete ones they no
longer need.

**Acceptance criteria:**
- A "New conversation" button in the Chat panel header creates a new
  conversation row and switches the panel to it (empty state, fresh thread).
- The conversation switcher (from REQ-004) shows all conversations for the
  notebook, newest first.
- A delete action on a conversation (e.g. via the switcher UI) removes the
  conversation row and all its messages. It is not available on the currently
  active conversation unless it is the only one — in that case, deleting it
  clears the messages and resets the title (i.e. the conversation is replaced,
  not left orphaned).
- The API provides:
  - `POST /api/notebooks/[id]/conversations` — create a new conversation.
  - `DELETE /api/notebooks/[id]/conversations/[convId]` — delete a
    conversation and its messages.

---

## Out of scope

- Renaming conversations (titles are auto-generated; a rename feature is a
  separate, lower-value item).
- Renaming sources or podcast episodes.
- Multi-notebook operations (bulk delete across notebooks).
- Undo / undo history for any delete.
- Pagination or virtual scrolling for large source/podcast/conversation lists.
- Drag-to-reorder sources or podcasts.
- Per-message delete within a conversation.
