# Design — OpenRAG SDK Migration

## Overview

Three in-app CRUD operations are migrated from raw `fetch()` to the
`openrag-sdk` client. Setup and health routes are left unchanged but get a
comment explaining why. The SDK client lives exclusively in `src/lib/openrag.ts`.

---

## Health check — dual-mode strategy

The `/api/health` route must work in two deployment scenarios:

**Local install** (`npm run openrag:up`): `OPENRAG_INSTALL_URL` (`:8000`) is
reachable. The raw `/settings` response includes `providers[].has_api_key`,
which we need to distinguish "models not configured yet" from "no API key set".
The "Run one-time setup" button is only meaningful here.

**External instance** (remote, cloud, or any standard OpenRAG install that
doesn't expose `:8000`): `OPENRAG_INSTALL_URL` is unreachable. The instance is
operator-managed — models are already configured. We fall back to
`client.settings.get()` via the SDK. If it succeeds, we report `ready: true`
immediately; there's nothing to set up.

### Flow

```
1. Try fetch(OPENRAG_INSTALL_URL + "/settings")
   ├── success (2xx)  → full provider check → ready / needsSetup / booting
   └── failure (conn refused / timeout)
       2. Try client.settings.get()  (OPENRAG_URL, :3000)
          ├── success → report ready: true (external instance, assume configured)
          └── failure → report booting (nothing is reachable yet)
```

### Why "assume configured" on the SDK path?

External instances are managed by their operator — we have no `/onboarding`
endpoint to call and no way to know which provider they use. If `settings.get()`
succeeds, the instance is up and responding; that's sufficient to let the user
in. If models aren't configured on the remote side, the first chat call will
fail with a clear error rather than a silent gate loop.

---

## SDK method mapping

| Current | Endpoint | SDK call |
|---|---|---|
| `chat()` | `POST /chat` | `client.chat.create({ message, chatId, stream: false, limit })` |
| `ingestDocument()` | `POST /router/upload_ingest` | `client.documents.ingest({ file, filename, wait: false })` |
| _(inline in route)_ | `POST /documents/delete-by-filename` | `client.documents.delete(filename)` |

**Left as raw `fetch()` — no SDK equivalent:**

| Route | Endpoint | Why |
|---|---|---|
| `health/route.ts` | `GET /settings` | Raw JSON includes `providers[].has_api_key`; SDK's `SettingsResponse` omits it |
| `setup/route.ts` | `POST /onboarding` | No SDK method; `/onboarding` does model selection + Langflow wiring |
| `setup/route.ts` | `GET /settings` (verify) | Same `providers` shape issue |

---

## `src/lib/openrag.ts` changes

### Lazy client singleton

```ts
import { OpenRAGClient } from "openrag-sdk";

let _client: OpenRAGClient | null = null;

function getClient(): OpenRAGClient {
  if (_client) return _client;
  _client = new OpenRAGClient({
    // OPENRAG_URL is the SDK's documented default — points to the OpenRAG
    // frontend proxy (:3000). For direct backend access (:8000) see
    // OPENRAG_INSTALL_URL used by health/route.ts and setup/route.ts.
    baseUrl: process.env.OPENRAG_URL ?? "http://localhost:3000",
    apiKey: process.env.OPENRAG_API_KEY,  // undefined = no auth header sent
    timeout: 120_000,
  });
  return _client;
}
```

Same lazy-init pattern as `db.ts` — avoids module-load-time side effects during
`next build`'s parallel worker phase. One instance shared across all calls.

The existing `defaultBaseUrl` and `defaultIngestPath` module constants are
removed. `OPENRAG_INGEST_PATH` env var is no longer read — the SDK routes
ingest correctly without it.

### `chat()` — replace fetch body

```ts
const r = await getClient().chat.create({
  message: args.prompt,
  chatId: args.previousResponseId ?? undefined,  // SDK name for threading
  stream: false,
  limit: args.limit ?? 8,
});
return { response: r.response, responseId: r.chatId ?? "" };
```

`previousResponseId` (public param name) maps to `chatId` (SDK param name).
Both refer to the same OpenRAG conversation-threading ID. The `response_id`
column in SQLite stores this value; no schema change needed.

### `ingestDocument()` — replace fetch body

```ts
const blob = new Blob([new Uint8Array(args.bytes)], { type: args.contentType });
const file = new File([blob], args.filename, { type: args.contentType });
const r = await getClient().documents.ingest({ file, filename: args.filename, wait: false });
return { taskId: (r as IngestResponse).task_id ?? "" };
```

`wait: false` → SDK returns `IngestResponse` (has `task_id`), not the polled
`IngestTaskStatus`. Same fire-and-forget behaviour as before.

### `deleteDocument()` — new export

```ts
export async function deleteDocument(filename: string): Promise<void> {
  await getClient().documents.delete(filename);
}
```

Error handling (swallow) stays in the route handler, not here.

---

## `src/app/api/notebooks/[id]/documents/[docId]/route.ts` changes

- Remove the module-level `baseUrl` constant.
- Remove the inline `fetch()` call.
- Import `deleteDocument` from `@/lib/openrag` and call it inside the existing
  `try/catch` block. The swallow-on-error behaviour is unchanged.

---

## `src/app/api/health/route.ts` — comment only

Add a `// Not using SDK:` comment above the `fetch` call explaining that the
raw response shape (`providers[].has_api_key`) is required and not exposed by
the SDK's `SettingsResponse`.

No logic changes.

---

## `src/app/api/setup/route.ts` — comment only

Add a `// Not using SDK:` comment above each `fetch` call:
- `/onboarding` — no SDK method exists for this endpoint.
- `/settings` (verify) — needs `providers` field not in SDK's `SettingsResponse`.

No logic changes.

---

## `.env.example` change

Add under the `Next.js app -> OpenRAG backend` block:

```env
# Standard SDK URL — used by the openrag-sdk client for chat, ingest, delete.
OPENRAG_URL=http://localhost:3000
# Install URL — killrctx-specific, direct backend access for health/setup routes.
OPENRAG_INSTALL_URL=http://localhost:8000
# Optional — only needed when your OpenRAG instance requires an API key.
OPENRAG_API_KEY=
```

---

## No-change surfaces

- `src/lib/podcast.ts` — calls `chat()`; public signature unchanged.
- `src/app/api/notebooks/[id]/chat/route.ts` — calls `chat()`; unchanged.
- `src/app/api/notebooks/[id]/documents/route.ts` — calls `ingestDocument()`; unchanged.
- `src/app/api/health/route.ts` — logic unchanged; comment added.
- `src/app/api/setup/route.ts` — logic unchanged; comments added.
- All SQLite schema, DB types, UI components, and polling logic — untouched.
- `package.json` scripts (`openrag:up/down/logs`) — untouched.
- `OPENRAG_INGEST_PATH` env var in `.env.example` — left in place (harmless,
  and removing it would be a breaking change for anyone already using it).

---

## REQ coverage

| REQ-ID | Design item |
|--------|-------------|
| REQ-001 | `openrag-sdk` added to `dependencies` |
| REQ-002 | `getClient()` singleton in `openrag.ts`; no other file imports SDK |
| REQ-003 | `chat()` → `client.chat.create()` |
| REQ-004 | `ingestDocument()` → `client.documents.ingest({ wait: false })` |
| REQ-005 | `deleteDocument()` new export → `client.documents.delete()`; route updated |
| REQ-006 | `apiKey: process.env.OPENRAG_API_KEY` in constructor; `.env.example` updated |
| REQ-007 | `// Not using SDK:` comment in `health/route.ts` and `setup/route.ts` |
