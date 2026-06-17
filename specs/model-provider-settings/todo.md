# Task List — Model & Provider Settings

## Tasks

- [x] TASK-01: [lib] Add `getModelsForProvider()` to `src/lib/openrag.ts`
  Fetches `GET /api/models/ollama` or `POST /api/models/{openai|anthropic|ibm}` from
  the OpenRAG frontend URL. Returns `{ language_models, embedding_models }`.
  Done when: calling it with `"ollama"` returns the live model list in a local dev run.

- [x] TASK-02: [lib] Add `updateSettings()` to `src/lib/openrag.ts`
  Calls `client.settings.update()` then `client.settings.get()` and returns
  `{ llm: "provider/model", embedding: "provider/model" }`.
  Done when: tsc passes with correct types.

- [x] TASK-03: [API] Add `GET /api/openrag-models` route
  New file `src/app/api/openrag-models/route.ts`. Calls `client.settings.get()`
  to find configured providers, then calls `getModelsForProvider()` for each in
  parallel via `Promise.allSettled`. Returns `{ groups: [...] }`.
  Done when: `curl http://localhost:3001/api/openrag-models` returns grouped models.

- [x] TASK-04: [API] Add `PATCH /api/openrag-settings` route
  New file `src/app/api/openrag-settings/route.ts`. Accepts
  `{ kind, provider, model }`, calls `updateSettings()`, returns `{ llm, embedding }`.
  Done when: a PATCH call updates the active model visible in OpenRAG's own UI.

- [x] TASK-05: [UI] Extend `OpenRAGContext` to expose a `setSettings` callback
  Update `src/components/OpenRAGContext.tsx`: change context value type from
  `OpenRAGSettings | null` to `{ settings: OpenRAGSettings | null; setSettings: ... }`.
  Update `HealthGate` to hold settings in state and provide both values.
  Update `useOpenRAGSettings()` hook to return the new shape.
  Done when: tsc passes and notebook page still compiles.

- [x] TASK-06: [UI] Build `ModelPickerPopover` component
  New file `src/components/ModelPickerPopover.tsx`. Fetches `/api/openrag-models`
  on first open, renders a searchable list grouped by provider, calls
  `PATCH /api/openrag-settings` on selection, invokes `onSaved` with fresh settings.
  Shows spinner on trigger while saving; inline error on failure.
  Props: `{ kind, currentValue, onSaved, align, children }`.
  Done when: component renders, fetches, and saves without TypeScript errors.

- [x] TASK-07: [UI] Wire LLM picker into notebook header
  In `src/app/notebooks/[id]/page.tsx`: read `{ settings, setSettings }` from
  context, wrap the existing rainbow model `<span>` in
  `<ModelPickerPopover kind="llm" align="right" onSaved={setSettings}>`.
  Done when: clicking the rainbow label opens the popover with live models.

- [x] TASK-08: [UI] Wire embedding picker into SourcesPanel
  In `src/app/notebooks/[id]/page.tsx`: pass `embeddingModel` and `onEmbeddingModelSaved`
  as new props to `SourcesPanel`. In `SourcesPanel`, a dedicated row below the header
  shows `model: provider/model` (rainbow) wrapped in
  `<ModelPickerPopover kind="embedding" onSaved={onEmbeddingModelSaved}>`.
  Done when: the model label appears in its own row and opens the picker correctly.

## Follow-up (out of scope for this PR)
- Provider credential management (setting Ollama endpoint, OpenAI key, etc.)
- Chunk size / overlap controls
