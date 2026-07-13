# backend-availability — Task List

## Tasks

- [x] TASK-01: [API] Rewrite `GET /api/health` to probe both backends in parallel and return `{ openrag, workbench }` each as `{ ok, url } | null`
- [x] TASK-02: [lib] Create `src/hooks/useBackendHealth.ts` — polls `/api/health` every 30 s, re-polls on tab focus, returns `{ openrag, workbench }` each `'up' | 'down' | 'unknown'`
- [x] TASK-03: [UI] Rewrite `src/components/HealthGate.tsx` as `HealthBanner` — slim amber banner, non-blocking, move `OpenRAGContext` provider inside it
- [x] TASK-04: [UI] Update `src/app/layout.tsx` — replace `<HealthGate>` with `<HealthBanner>`
- [x] TASK-05: [UI] Update `src/app/page.tsx` — call `useBackendHealth()` in `Home`, pass health to `BackendPicker`, disable offline/unconfigured options
- [x] TASK-06: [UI] Add `offline` prop to `SourcesPanel` in `src/app/notebooks/[id]/page.tsx` — disable upload, folder, URL, delete, retry when offline
- [x] TASK-07: [UI] Add `offline` prop to `ChatPanel` — disable send, input, new conv, delete conv; show offline notice when offline
- [x] TASK-08: [UI] Add `offline` prop to `StudioPanel` — disable type cards, generate, delete note, topic input when offline
- [x] TASK-09: [UI] Wire `offline` at the notebook page level — call `useBackendHealth()`, derive `offline` from `notebook.rag_backend`, pass to all three panels
- [x] TASK-10: [UI] Add dot badge to `BackendLogo` on home page — green = up, red = down, hidden = unknown (REQ-005)
- [x] TASK-11: [UI] Add Online / Offline — read only status pill to notebook header — always shown once health is known (REQ-005)
- [x] TASK-12: [UI] Add `disabled` prop to `ModelPickerPopover` — forwarded to trigger button; callers pass `disabled={offline}` with dimmed trigger span (REQ-004)
- [x] TASK-13: [UI] Hide document checkboxes in `SourcesPanel` when offline — `pointer-events-none opacity-0` (REQ-004)
- [x] TASK-14: [UI] Add Read only pill to offline notebook cards on home page — vertically centred in card flex row (REQ-005)
