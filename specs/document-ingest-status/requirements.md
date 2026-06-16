# Requirements — Document Ingest Status

## User story

As a notebook user, I want to see the indexing progress of each uploaded file so that I
know when it is ready to query and understand why a file might have failed.

---

## Requirements

**REQ-001 — Per-file ingest status indicator**
Each document row in the Sources panel shows its current OpenRAG ingest status.
- Acceptance: a spinner (or equivalent) is visible next to a file while it is indexing.
- Acceptance: the spinner disappears and the row looks "settled" once indexing is complete.

**REQ-002 — Error state**
If OpenRAG reports a failed ingest, the document row shows a visible error indicator.
- Acceptance: a red/error state is visible on the row (icon, tint, or label).
- Acceptance: the error state persists until the file is deleted.

**REQ-003 — Status is polled automatically**
The UI discovers status changes without requiring a manual page refresh.
- Acceptance: a file that is indexing eventually transitions to ready without user action.

**REQ-004 — Status survives page reload**
If the user reloads the page while a file is still indexing, the spinner reappears.
- Acceptance: status is persisted in SQLite, not only in client memory.

**REQ-005 — Status does not affect chat usability**
Files that are still indexing do not block the user from chatting; they simply may not
return results for that file yet.
- Acceptance: the chat input remains enabled while files are indexing.

---

## Out of scope

- Showing granular ingest progress (percentage, chunk count) — status only (indexing / ready / failed).
- Retry button for failed files — delete and re-upload is sufficient for now.
- Push/websocket updates — polling is fine.
- Per-notebook or aggregate "all ready" indicator.
- Any changes to the podcast or chat panels.
