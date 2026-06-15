# Task Plan — CRUD Operations for Notebooks, Sources, and Studio Items

## Tasks

- [x] TASK-01: [DB] Add `Conversation` type and `conversations` table to `src/lib/db.ts`
- [x] TASK-02: [DB] Add `conversation_id` migration to `messages` table in `src/lib/db.ts` (ALTER + back-fill default conversation per notebook)
- [x] TASK-03: [API] Add `PATCH` handler to `src/app/api/notebooks/[id]/route.ts` for notebook rename
- [x] TASK-04: [API] Add `conversations` to the `GET` bundle in `src/app/api/notebooks/[id]/route.ts`
- [x] TASK-05: [API] Create `src/app/api/notebooks/[id]/conversations/route.ts` — `POST` to create a conversation
- [x] TASK-06: [API] Create `src/app/api/notebooks/[id]/conversations/[convId]/route.ts` — `DELETE` with last-conversation replacement logic
- [x] TASK-07: [API] Create `src/app/api/notebooks/[id]/podcasts/[podcastId]/route.ts` — `DELETE` podcast row + audio file
- [x] TASK-08: [API] Update `src/app/api/notebooks/[id]/chat/route.ts` — accept `conversationId`, scope `response_id` lookup and message inserts to it
- [x] TASK-09: [UI] Add `Conversation` type and `conversations`/`activeConvId` state to `NotebookPage`; wire into `refresh()` and pass props down
- [x] TASK-10: [UI] Add `InlineTitle` sub-component to `src/app/notebooks/[id]/page.tsx`; replace static header title
- [x] TASK-11: [UI] Add bulk-select (checkboxes + footer bar) to `SourcesPanel`
- [x] TASK-12: [UI] Add conversation switcher + New/Delete buttons to `ChatPanel` header; filter visible messages by `activeConvId`; pass `conversationId` in `send()`
- [x] TASK-13: [UI] Add bulk-select to `StudioPanel` and `PodcastCard`; wire to podcast delete API

## Done when

- TASK-02: `npx tsx -e "require('./src/lib/db').default.prepare('SELECT * FROM conversations').all()"` returns an array without throwing; existing notebooks have a default conversation row and their messages have a non-null `conversation_id`.
- TASK-06: DELETE of the last conversation returns `{ conversation }` (not `{ ok: true }`); the client always has a valid `activeConvId` after the call.
- TASK-08: Chat POST with a missing `conversationId` returns `400`; two conversations in the same notebook thread independently (different `response_id` chains).
- TASK-13: Deleting a podcast whose audio file doesn't exist (e.g. failed episode) doesn't throw — ENOENT is swallowed.
