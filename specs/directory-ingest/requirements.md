# Requirements — Directory Ingest

## User story

As a developer using killrctx, I want to pick either files or a directory from a single
"Add source(s)" control so that I can ingest a folder of related files without needing a
separate button.

---

## Background

The browser's `<input type="file">` cannot combine `multiple` (multi-file pick) and
`webkitdirectory` (folder pick) on the same element — they are mutually exclusive. The
solution is **two hidden inputs** driven by one visible split-button: the main area opens
the file picker (existing behaviour); a small dropdown arrow opens the folder picker.
Both feed into the same `upload()` function.

---

## Requirements

### REQ-001 — Split-button control
The existing "+ Add source(s)" button becomes a split button: a main area (left) and a
small arrow toggle (right) separated by a thin divider.

**Acceptance criteria:**
- Clicking the **main area** opens the existing multi-file picker — behaviour unchanged.
- Clicking the **arrow** opens a small dropdown with a single option: "Add folder".
- Clicking "Add folder" opens the OS folder chooser (`webkitdirectory` input).
- Clicking anywhere outside the dropdown closes it without taking action.
- Both halves of the button are disabled while an upload is already in progress.
- The arrow toggle is keyboard-accessible (Enter/Space opens the dropdown).

### REQ-002 — Whitelist filtering
Only files whose extension matches the existing `SUPPORTED_EXTENSIONS` set are included
from the chosen directory. Files with other extensions are silently ignored.

**Acceptance criteria:**
- A directory with 5 `.pdf` and 3 `.exe` files queues exactly 5 files.
- No error is shown for ignored files.
- If the entire directory contains zero whitelisted files, an informational error is
  shown: "No supported files found in the selected folder."

### REQ-003 — Recursive subdirectories
`webkitdirectory` already delivers all files at every depth. The whitelist filter (REQ-002)
is applied to the full flat list the browser provides.

**Acceptance criteria:**
- A tree `root/sub/a.pdf` and `root/b.md` are both queued in one folder-add operation.

### REQ-004 — Duplicate / overwrite flow re-used
Directory-sourced files go through the same duplicate-detection and `OverwriteDialog`
flow as the existing file picker.

**Acceptance criteria:**
- If any file from the folder shares a name with an existing source, `OverwriteDialog` is
  shown listing the conflicts; behaviour is identical to the multi-file path.

### REQ-005 — Progress indicator re-used
The existing "Uploading N / M…" counter covers directory uploads with no new UI state.

**Acceptance criteria:**
- Uploading a folder with 4 files shows "Uploading 1 / 4…" → "Uploading 4 / 4…".

---

## Out of scope

- No server-side directory scanning.
- No preservation of subdirectory structure as metadata (files land flat in the notebook).
- No drag-and-drop of a folder.
- No changes to the API route or SQLite schema.
