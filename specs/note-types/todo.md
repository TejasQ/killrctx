# Tasks — Note Types

## Tasks

- [ ] TASK-01: [DB] Add `notes` table and `Note` type to `src/lib/db.ts`; migrate
      existing `podcasts` rows into it; remove `Podcast` type
- [ ] TASK-02: [API] Update `GET /api/notebooks/[id]` to query `notes` instead of
      `podcasts`; swap `Podcast` import for `Note`
- [ ] TASK-03: [API] Update `POST /api/notebooks/[id]/podcast/route.ts` to write to
      `notes` table (add `type = 'podcast'` to insert; update all table references)
- [ ] TASK-04: [API] Delete `src/app/api/notebooks/[id]/podcasts/[podcastId]/route.ts`;
      add `DELETE /api/notebooks/[id]/notes/[noteId]/route.ts` in its place
- [ ] TASK-05: [lib] Add `generateNote()` to `src/lib/openrag.ts`
- [ ] TASK-06: [API] Add `POST /api/notebooks/[id]/notes/summary/route.ts`
- [ ] TASK-07: [API] Add `POST /api/notebooks/[id]/notes/mindmap/route.ts`
- [ ] TASK-08: [API] Add `POST /api/notebooks/[id]/notes/outline/route.ts`
- [ ] TASK-09: [API] Add `POST /api/notebooks/[id]/notes/qa/route.ts`
- [ ] TASK-10: [UI] Update `src/app/notebooks/[id]/page.tsx`: swap `Podcast` type for
      `Note`; rename `podcasts`/`setPodcasts` state to `notes`/`setNotes`; update
      `refresh()` and polling `useEffect`; update `StudioPanel` props
- [ ] TASK-11: [UI] Update `StudioPanel`: replace topic input with type-selector grid
      (3-col, icon + label + chevron per type); selected card opens inline generate
      panel (topic input + Generate button); routes to per-type endpoint on submit
- [ ] TASK-12: [UI] Update `StudioPanel` notes list: unified list of all note types,
      type icon + title + date per row, renders `PodcastCard` for podcast rows and
      `NoteCard` for text rows
- [ ] TASK-13: [UI] Add `NoteCard` component (type icon, title, click to expand/collapse
      markdown body, delete button on hover)
