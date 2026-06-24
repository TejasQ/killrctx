# Tasks — Mind Map Visualization

- [x] TASK-01: [config] Add `mindmap-card` and `mindmap-expanded` height tokens to `tailwind.config.ts`
- [x] TASK-02: [bundle] Install `reactflow` npm dependency
- [x] TASK-03: [UI] Create `src/components/MindMapRenderer.tsx` with parser, layout, and ReactFlow render
- [x] TASK-04: [UI] Wire `MindMapRenderer` into the NoteCard inline preview in `page.tsx`
- [x] TASK-05: [UI] Wire `MindMapRenderer` into the expanded Studio view in `page.tsx`
- [x] TASK-06: [UI] Apply app theme to all nodes — dark backgrounds, edge/panel/ink tokens, no white fill
- [x] TASK-07: [UI] Size nodes by depth — root largest, branches medium, leaves smallest (font, padding, width)
- [x] TASK-08: [UI] Assign a distinct hue per top-level branch; depth drives opacity within that hue
- [x] TASK-09: [UI] Visually distinguish source/citation nodes — muted colour, italic label, smaller size
- [x] TASK-10: [UI] Add fullscreen mode — fixed overlay (inset-0 z-50), toggle button in graph corner, Escape to exit
- [x] TASK-11: [UI] Tune layout constants and fitView padding so the graph breathes and fits on first render
