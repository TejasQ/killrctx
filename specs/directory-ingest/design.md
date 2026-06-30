# Design — Directory Ingest

## Overview

All changes are confined to `SourcesPanel` in
`src/app/notebooks/[id]/page.tsx`. No API routes, no SQLite schema, no lib
changes. The browser's `webkitdirectory` attribute delivers a flat `FileList`
of every file at every depth inside the chosen folder; we filter that list
through the existing `SUPPORTED_EXTENSIONS` set and hand it to the existing
`upload()` function.

---

## UI changes

### Split button (`src/app/notebooks/[id]/page.tsx` — `SourcesPanel`)

The current "+ Add source(s)" button becomes a split button composed of two
adjacent `<button>` elements inside a shared container:

```
┌─────────────────────────────────┬───┐
│        + Add source(s)          │ ▾ │
└─────────────────────────────────┴───┘
```

- **Left half** (`flex-1`) — unchanged behaviour; clicks `inputRef` (the
  existing `multiple` file input).
- **Right half** (fixed `~28px` wide) — opens/closes a small dropdown anchored
  below itself. Contains one item: "📁 Add folder".
- A thin `border-l border-edge` separates the two halves visually.
- Both halves carry `disabled={!!uploading}`.

### Dropdown

A `position: absolute` `<div>` rendered below the split button when
`folderMenuOpen` state is `true`. One clickable row: "📁 Add folder" — fires
`folderInputRef.current?.click()` and closes the menu.

Dismissal: a `useEffect` adds a `mousedown` listener to `document` while the
menu is open; any click outside the container closes the menu. Listener is
removed on cleanup or when menu closes.

### Second hidden input

```tsx
<input
  ref={folderInputRef}
  type="file"
  // webkitdirectory makes the picker show folders; the browser returns
  // every file inside the chosen folder at all depths as a flat FileList.
  // @ts-expect-error — webkitdirectory is not in React's InputHTMLAttributes
  webkitdirectory=""
  className="hidden"
  onChange={(e) => {
    const raw = Array.from(e.target.files ?? []);
    const files = raw.filter((f) => {
      const ext = "." + f.name.split(".").pop()?.toLowerCase();
      return SUPPORTED_EXTENSIONS.has(ext);
    });
    if (raw.length > 0 && files.length === 0) {
      setError("No supported files found in the selected folder.");
      return;
    }
    if (files.length) upload(files);
    // Reset so the same folder can be re-selected if needed.
    if (folderInputRef.current) folderInputRef.current.value = "";
  }}
/>
```

### New state

| Name | Type | Purpose |
|------|------|---------|
| `folderMenuOpen` | `boolean` | Controls dropdown visibility |
| `folderInputRef` | `RefObject<HTMLInputElement>` | Ref to the `webkitdirectory` input |

No other state changes — `uploading`, `error`, `overwritePrompt` are all
re-used exactly as today.

---

## Data flow

```
User clicks "▾" arrow
  → folderMenuOpen = true
  → dropdown renders

User clicks "📁 Add folder"
  → folderInputRef.current.click()
  → folderMenuOpen = false
  → OS folder picker opens

User confirms folder
  → onChange fires with FileList (all files, all depths)
  → filter by SUPPORTED_EXTENSIONS
  → if none: setError("No supported files found in the selected folder.")
  → else: upload(files)   ← unchanged function, unchanged API
```

`upload()` already handles duplicates → `OverwriteDialog` → sequential POST →
progress counter. Nothing changes there.

---

## REQ coverage

| REQ-ID | Design item |
|--------|-------------|
| REQ-001 | Split button: left = file picker, right arrow + dropdown = folder picker |
| REQ-002 | `onChange` filter on `folderInputRef`; "No supported files" error |
| REQ-003 | `webkitdirectory` delivers all depths; filter applied to flat list |
| REQ-004 | `upload()` already runs duplicate check → `OverwriteDialog` |
| REQ-005 | `upload()` already drives `uploading` state counter |
