# Requirements — Model & Provider Settings

## User story

As a killrctx user, I want to switch the LLM and embedding model used by OpenRAG
from within the app so that I can experiment with different models without leaving
the notebook UI.

## Requirements

### REQ-001 — LLM picker
The user can change the active LLM provider and model.
**Acceptance criteria:**
- A picker shows the currently active LLM (provider + model name).
- Models are grouped by provider; each provider fetched from OpenRAG's `/api/models/{provider}`.
- Only providers that are configured in OpenRAG are shown.
- Selecting a model (from any provider) saves both the provider and model to OpenRAG immediately.
- After saving, the rainbow model label in the header updates to reflect the new choice.

### REQ-002 — Embedding picker
The user can change the active embedding provider and model.
**Acceptance criteria:**
- A separate picker shows the currently active embedding model.
- Models are grouped by provider, same fetch pattern as REQ-001.
- Selecting a model saves it to OpenRAG immediately (same behaviour as OpenRAG's own UI).

### REQ-003 — Provider-aware model lists
Model lists are fetched from OpenRAG's `/api/models/{provider}` endpoints (one call per
configured provider), which in turn query each provider (e.g. Ollama's `/api/tags`).
**Acceptance criteria:**
- Models shown match what each provider actually has available.
- Providers with no models or a failed fetch are omitted from the grouped list.
- If all fetches fail, the picker falls back to showing the current model as a
  freehand-selectable item rather than blocking the user.

### REQ-004 — Placement
The two pickers live in different panels — where each concern naturally belongs.
**Acceptance criteria:**
- Clicking the rainbow model label in the header opens the LLM picker.
- An `emb:` label at the bottom of the Sources panel opens the embedding picker
  (embedding lives here because it controls how uploaded documents are indexed).
- Both pickers are inline popovers with a searchable grouped list.
- The rest of the header and Sources panel layout is not disrupted.

### REQ-005 — Saving feedback
The user gets clear feedback while a save is in-flight and if it fails.
**Acceptance criteria:**
- The picker shows a loading state while the `settings.update()` SDK call is in flight.
- On success the picker closes and the header label updates.
- On error a brief inline error message is shown; the picker stays open.

## Out of scope

- Changing the Ollama endpoint URL or any other provider credentials.
- Picking a provider (only the model within the already-configured provider).
- Any settings outside LLM model and embedding model.
- A dedicated settings page.
- Persisting the selection anywhere in our SQLite DB — OpenRAG owns this state.
