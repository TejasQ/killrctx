# Tasks — Mind Map Node Inquiry

## Tasks

- [x] TASK-01: [DB] Enable `PRAGMA foreign_keys = ON` in `getDb()` in `src/lib/db.ts`
- [x] TASK-02: [DB] Add `mind_map_links` table + indexes + `MindMapLink` export type to `src/lib/db.ts`
- [x] TASK-03: [API] Add `mindMapLinks` to bundle response in `GET /api/notebooks/[id]/route.ts`
- [x] TASK-04: [API] Create `POST /api/notebooks/[id]/mind-map-links/route.ts`
- [x] TASK-05: [UI] Move collapse chevron outside the node box in `src/components/MindMapRenderer.tsx`
- [x] TASK-06: [UI] Add `noteId`, `topic`, `mindMapLinks`, `onNodeClick` props to `MindMapRenderer`; build `linksByLabel` lookup; wire node clicks to `onNodeClick(label, linkedConvIds)`
- [x] TASK-07: [UI] Add count badge to linked nodes in `buildGraph()`
- [x] TASK-08: [UI] Add `mindMapLinks` state + `refresh()` update in `NotebookPage` (`src/app/notebooks/[id]/page.tsx`)
- [x] TASK-09: [UI] Add `pendingAsk` state + extract `sendText()` + add `pendingSend` / `onPendingSendConsumed` props to `ChatPanel`
- [x] TASK-10: [UI] Add `frameQuestion()` helper + `createAndLink()` + `handleNodeClick()` to `NotebookPage`
- [x] TASK-11: [UI] Add `NodePickerPopover` component + `nodePickerState` to `NotebookPage`
- [x] TASK-12: [UI] Scrub `mindMapLinks` on conversation delete in the `onConvDeleted` handler in `NotebookPage`
- [x] TASK-13: [UI] Thread `onNodeClick` through `StudioPanel` → `NoteCard` → all `MindMapRenderer` call sites; wrap with `setFullscreen(false)` in the fullscreen context
- [x] TASK-14: [UI] Ancestor-path framing — add `findAncestorLabels()` to `MindMapRenderer.tsx`; change `onAsk`/`onNodeClick` to carry `ancestorLabels: string[]`; update `frameQuestion` in `page.tsx` to include breadcrumb + topic
