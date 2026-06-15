# Requirements — OpenRAG SDK Migration

## User story

As a developer running killrctx, I want the in-app CRUD operations (chat, document
ingest, document delete) to communicate with OpenRAG through the official
`openrag-sdk` TypeScript package instead of raw `fetch()` calls, so that
connection logic, auth, and error handling are delegated to the SDK.

---

## Scope boundary

This migration draws a hard line between two categories of OpenRAG calls:

**In-app CRUD — migrate to SDK (this PR):**
These are operations triggered by normal user activity in the running app.
The SDK has a direct, tested equivalent for each one.

| Call | Current | SDK replacement |
|---|---|---|
| Send a chat message | `POST /chat` via `fetch` | `client.chat.create()` |
| Ingest a document | `POST /router/upload_ingest` via `fetch` | `client.documents.ingest()` |
| Delete a document | `POST /documents/delete-by-filename` via `fetch` | `client.documents.delete()` |

**Setup / admin — leave as raw `fetch` (out of scope):**
These calls exist to probe or configure the OpenRAG instance itself, not to
do application work. The SDK does not provide 1:1 replacements.

| Call | Why it stays as fetch |
|---|---|
| `GET /settings` in `health/route.ts` | Needs `providers[].has_api_key` from the raw JSON — the SDK's `SettingsResponse` strips that field |
| `POST /onboarding` in `setup/route.ts` | No SDK equivalent; `/onboarding` does model selection + Langflow wiring |
| `GET /settings` (verify) in `setup/route.ts` | Same `providers` shape issue as the health check |

---

## Requirements

### REQ-001 — Install the SDK
`openrag-sdk` must be added as a production dependency at its latest stable
version. As of this spec, that is **`0.3.1`** (confirmed via
`npm show openrag-sdk dist-tags` — `latest: 0.3.1`). The `0.4.0-dev0`
pre-release must not be used.

**Acceptance criteria:**
- `openrag-sdk@0.3.1` (or newer stable if released before implementation)
  appears in `package.json` under `dependencies`.

### REQ-002 — SDK client owned by `openrag.ts`
A single `OpenRAGClient` instance must be constructed and owned exclusively
by `src/lib/openrag.ts`. No other file imports from `openrag-sdk` directly.

**Acceptance criteria:**
- `openrag-sdk` is imported only in `src/lib/openrag.ts`.
- The client is lazily initialised (not at module load time).

### REQ-003 — Chat via SDK
The `chat()` function in `src/lib/openrag.ts` must use `client.chat.create()`
instead of a raw `fetch()`.

**Acceptance criteria:**
- `chat()` returns the same `{ response, responseId }` shape as today.
- Conversation threading (`previousResponseId` → SDK `chatId`) is preserved.
- The 120 s timeout is configured on the client constructor.

### REQ-004 — Document ingest via SDK
`ingestDocument()` in `src/lib/openrag.ts` must use `client.documents.ingest()`
instead of a raw `fetch()` with manual `FormData` construction.

**Acceptance criteria:**
- `ingestDocument()` returns the same `{ taskId }` shape as today.
- Ingestion is fire-and-forget (`wait: false`) — no internal polling.

### REQ-005 — Document delete via SDK
A new exported function `deleteDocument(filename)` must be added to
`src/lib/openrag.ts` using `client.documents.delete()`. The route handler
`src/app/api/notebooks/[id]/documents/[docId]/route.ts` must call it instead
of its inline `fetch()`.

**Acceptance criteria:**
- `deleteDocument` is exported from `src/lib/openrag.ts`.
- No `fetch()` call targeting `OPENRAG_URL` remains in `[docId]/route.ts`.
- The route's "best-effort / swallow errors" behaviour is unchanged.

### REQ-006 — Env var naming convention
`OPENRAG_URL` is the SDK's documented default and must be used for the SDK
client (pointing at the OpenRAG frontend proxy, `:3000`). A separate
`OPENRAG_INSTALL_URL` var must be used by the health and setup routes for
direct backend access (`:8000`), making the distinction visible in config.

**Acceptance criteria:**
- `getClient()` reads `OPENRAG_URL` (default `http://localhost:3000`).
- `health/route.ts` and `setup/route.ts` read `OPENRAG_INSTALL_URL` (default
  `http://localhost:8000`).
- Both vars are documented in `.env.example` with comments explaining the
  difference.

### REQ-007 — Optional API key support
The SDK client must accept an optional `OPENRAG_API_KEY` env var for
deployments where the OpenRAG instance requires authentication.

**Acceptance criteria:**
- `OpenRAGClient` is constructed with `apiKey: process.env.OPENRAG_API_KEY`.
- `.env.example` documents the new var, clearly marked optional.

### REQ-008 — Setup and health routes are visibly separated
The two routes that keep raw `fetch()` calls (`health/route.ts`,
`setup/route.ts`) must have a clear comment explaining *why* they do not use
the SDK, so a future reader doesn't assume they were missed.

**Acceptance criteria:**
- Each of those two files contains a `// Not using SDK:` comment with a
  one-line reason.

---

---

## Out of scope

- `health/route.ts` and `setup/route.ts` fetch logic — left as raw `fetch`.
- Streaming chat responses.
- Removing or changing docker-compose / self-boot scripts.
- Any SQLite schema or DB type changes.
- Knowledge filters or per-notebook isolation.
- Upgrading any other dependency.
