# Design — Model & Provider Settings

## Overview

The LLM picker lives in the notebook header (clicking the rainbow model label).
The embedding picker lives at the bottom of the Sources panel, next to where
documents are uploaded — this is the right home because embedding is about how
documents get indexed, not about chat.

Both popovers fetch live model lists from OpenRAG's `/api/models/{provider}`
endpoints (one per configured provider), group them by provider, and call
`client.settings.update()` via the SDK on selection. No SQLite changes —
OpenRAG owns this state entirely.

---

## Architecture

```
Header label click
  → ModelPickerPopover component (new)
      → GET /api/openrag-models  (new Next.js route)
          → fetch http://OPENRAG_URL/api/models/ollama   (GET)
          → fetch http://OPENRAG_URL/api/models/openai   (POST {})
          → fetch http://OPENRAG_URL/api/models/anthropic (POST {})
          → returns { groups: [{ provider, label, language_models, embedding_models }] }
      → on select → PATCH /api/openrag-settings  (new Next.js route)
          → client.settings.update({ llm_provider, llm_model })  or embedding variant
          → returns { llm, embedding }  (same shape as health route settings)
          → HealthGate context updated via callback
```

---

## Which providers to fetch

The raw `/settings` response (already fetched by the health route) includes a
`providers` map. Each entry has a `configured: boolean` field. We fetch models
only for configured providers to avoid noise from empty lists.

Known providers and their fetch method (from OpenRAG's own frontend code):

| Provider   | Endpoint                   | Method | Body               |
|------------|----------------------------|--------|--------------------|
| `ollama`   | `/api/models/ollama`       | GET    | —                  |
| `openai`   | `/api/models/openai`       | POST   | `{ api_key: "" }`  |
| `anthropic`| `/api/models/anthropic`    | POST   | `{ api_key: "" }`  |
| `watsonx`  | `/api/models/ibm`          | POST   | `{ endpoint, ... }`|

All calls are proxied through our own Next.js route — never called directly from
the browser, keeping the OpenRAG URL server-side only.

---

## New API routes

### `GET /api/openrag-models`

**File:** `src/app/api/openrag-models/route.ts`

Fetches all configured providers in parallel and returns their model lists.

Request: none

Response:
```ts
{
  groups: Array<{
    provider: string           // "ollama" | "openai" | "anthropic" | "watsonx"
    label: string              // display name e.g. "Ollama"
    language_models: Array<{ value: string; label: string; default: boolean }>
    embedding_models: Array<{ value: string; label: string; default: boolean }>
  }>
}
```

Error: `{ error: string }` with appropriate status.

Implementation notes:
- Call `client.settings.get()` first to get the provider `configured` map.
- Fire all provider fetches in parallel with `Promise.allSettled` — a single
  failing provider should not block the others.
- Providers that return an error or empty lists are omitted from `groups`.
- Export `runtime = "nodejs"`.

### `PATCH /api/openrag-settings`

**File:** `src/app/api/openrag-settings/route.ts`

Saves a new LLM or embedding selection to OpenRAG via the SDK.

Request body:
```ts
// LLM update
{ kind: "llm"; provider: string; model: string }
// Embedding update
{ kind: "embedding"; provider: string; model: string }
```

Response:
```ts
{ llm: string; embedding: string }  // updated "provider/model" strings
```

Error: `{ error: string }`.

Implementation:
- Call `client.settings.update()` with the appropriate fields.
- Re-read `client.settings.get()` after update to return fresh values.
- Export `runtime = "nodejs"`.

---

## `src/lib/openrag.ts` changes

Add two functions:

```ts
getModelsForProvider(provider: string): Promise<{ language_models: ...; embedding_models: ... }>
updateSettings(args: { llm_provider?: string; llm_model?: string; embedding_provider?: string; embedding_model?: string }): Promise<{ llm: string; embedding: string }>
```

`getModelsForProvider` calls the raw OpenRAG frontend URL directly (like the
health route does for `/settings`) because the SDK has no models endpoint. Each
provider needs a different HTTP method/body — a small switch handles this.

`updateSettings` uses `client.settings.update()` then `client.settings.get()` to
return the new confirmed values in our `"provider/model"` string format.

---

## `src/components/OpenRAGContext.tsx` changes

Extend the context to include a setter so the notebook page can push fresh
settings after a successful PATCH without a full health re-probe:

```ts
export type OpenRAGContextValue = {
  settings: OpenRAGSettings | null;
  setSettings: (s: OpenRAGSettings) => void;
};
```

`HealthGate` holds the state and passes both `settings` and `setSettings` through
the context. The notebook page reads `setSettings` and calls it after a successful
PATCH response.

---

## New UI component

### `ModelPickerPopover` — `src/components/ModelPickerPopover.tsx`

A self-contained popover that:
1. Fetches `/api/openrag-models` on first open (not on mount — lazy).
2. Renders a searchable grouped list (provider heading → model items).
3. On selection calls `PATCH /api/openrag-settings` and invokes an `onSaved`
   callback with the new `{ llm, embedding }` values.
4. Shows a spinner on the trigger while saving is in-flight.
5. Shows an inline error if the PATCH fails.

Props:
```ts
{
  kind: "llm" | "embedding"
  currentValue: string          // "provider/model" — shown on the trigger
  onSaved: (settings: OpenRAGSettings) => void
  children: ReactNode           // the clickable trigger element
}
```

The trigger is `children` (passed as-is) so the notebook page can pass in the
rainbow label span for the LLM picker and a plain `emb: …` label for the
embedding picker without the component needing to know about styling.

---

## `src/app/notebooks/[id]/page.tsx` changes

- Read `setSettings` from `useOpenRAGSettings()` (after context is extended).
- Wrap the rainbow model `<span>` in `<ModelPickerPopover kind="llm" …>`.
- Add a new `emb: {openragSettings.embedding}` label and wrap it in
  `<ModelPickerPopover kind="embedding" …>`.
- Both labels are right-side header, left of `collection:`.

Header right side after change:
```
model: ollama/gpt-oss:120b-cloud   emb: ollama/all-minilm:latest   collection: nb_…
                ↑ rainbow, clickable       ↑ muted, clickable
```

---

## REQ coverage

| REQ-ID  | Design item                                                                 |
|---------|-----------------------------------------------------------------------------|
| REQ-001 | `ModelPickerPopover kind="llm"` + `PATCH /api/openrag-settings`            |
| REQ-002 | `ModelPickerPopover kind="embedding"` + same PATCH route                   |
| REQ-003 | `GET /api/openrag-models` fetches all configured providers in parallel      |
| REQ-004 | Rainbow label in header (LLM) + `emb:` label in Sources panel footer (embedding) |
| REQ-005 | Spinner on trigger while saving; inline error on failure; `onSaved` updates context |
