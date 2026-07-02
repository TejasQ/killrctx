# Astra Workbench Backend — Design

## Overview

_Basically_, we're making the RAG backend a per-notebook choice. When you
create a notebook you pick "OpenRAG" or "Workbench". Each backend satisfies
the same TypeScript interface; API routes resolve the correct implementation
by reading the notebook's `rag_backend` column.

The AI Workbench at `:8080` already provides the complete RAG pipeline — we
just call its REST endpoints instead of the OpenRAG SDK. No custom agents, no
new Workbench workspace — we use what's already running.

---

## SQLite Changes

### New column on `notebooks`

```sql
ALTER TABLE notebooks ADD COLUMN rag_backend TEXT NOT NULL DEFAULT 'openrag';
```

Values: `'openrag'` | `'workbench'`

Migration: idempotent `ALTER TABLE ... ADD COLUMN` inside `getDb()` (same
pattern as existing migrations in db.ts). Existing notebooks get `'openrag'`.

### New columns for Workbench-specific state

```sql
ALTER TABLE notebooks ADD COLUMN workbench_kb_id TEXT;
ALTER TABLE notebooks ADD COLUMN workbench_embedding_service_id TEXT;
```

These are null for OpenRAG notebooks. For Workbench notebooks,
`workbench_kb_id` holds the UUID of the Knowledge Base created on the
Workbench.

### New columns on `conversations`

```sql
ALTER TABLE conversations ADD COLUMN workbench_agent_id TEXT;
ALTER TABLE conversations ADD COLUMN workbench_conversation_id TEXT;
```

Null for OpenRAG conversations. For Workbench conversations:
- `workbench_agent_id` — which Workbench agent this conversation uses
- `workbench_conversation_id` — the Workbench's conversation UUID (used in
  all chat API calls)

---

## New Module: `src/lib/rag.ts`

Shared interface + factory function.

```typescript
export interface RagBackend {
  // Chat
  chat(args: ChatArgs): Promise<{ response: string; responseId: string }>;
  chatStream(args: ChatArgs): AsyncIterable<StreamDelta>;

  // Documents
  ingestDocument(args: IngestArgs): Promise<{ taskId: string }>;
  getTaskStatus(taskId: string): Promise<TaskStatus>;
  deleteDocument(filename: string): Promise<void>;

  // Lifecycle (notebook-level)
  createNotebookResources(args: CreateResourcesArgs): Promise<NotebookResources>;
  deleteNotebookResources(args: DeleteResourcesArgs): Promise<void>;

  // Conversations
  createConversation(args: CreateConversationArgs): Promise<{ conversationId: string }>;
  deleteConversation(conversationId: string): Promise<void>;
}

export type StreamDelta = { type: 'token'; delta: string }
                        | { type: 'done'; responseId: string };

export function getBackend(ragBackend: 'openrag' | 'workbench'): RagBackend;
```

The factory returns the correct implementation. API routes do:
```typescript
const notebook = db.prepare('SELECT * FROM notebooks WHERE id = ?').get(id);
const rag = getBackend(notebook.rag_backend);
```

---

## New Module: `src/lib/backends/openrag.ts`

Refactored from current `src/lib/openrag.ts`. Implements `RagBackend` by
wrapping the existing OpenRAG SDK calls. The original `openrag.ts` stays as
the low-level SDK wrapper; the backends file adapts it to the interface.

No behaviour change for OpenRAG notebooks.

---

## New Module: `src/lib/backends/workbench.ts`

Implements `RagBackend` using `fetch()` against the Workbench REST API.

### Environment variables

```
WORKBENCH_URL=http://localhost:8080
WORKBENCH_WORKSPACE_ID=3edc36ab-77c5-483e-9e0a-65ed197148b8
WORKBENCH_API_KEY=            # optional — for secured deploys
WORKBENCH_DEFAULT_AGENT_ID=c50f58c8-b2ee-412d-989b-2b347adf4e41
WORKBENCH_CHUNKING_SERVICE_ID=e956eb47-77d8-41bd-ae49-8203b36fd572
```

### Method mapping

| Interface method | Workbench API call |
|---|---|
| `createNotebookResources` | `POST /workspaces/{wsId}/knowledge-bases` (creates KB with chosen embedding service + default chunking service) |
| `deleteNotebookResources` | `DELETE /workspaces/{wsId}/knowledge-bases/{kbId}` |
| `ingestDocument` | `POST /workspaces/{wsId}/knowledge-bases/{kbId}/ingest/file` (multipart, sync or async via job) |
| `getTaskStatus` | `GET /workspaces/{wsId}/jobs/{jobId}` (if async ingest) |
| `deleteDocument` | `DELETE /workspaces/{wsId}/knowledge-bases/{kbId}/documents/{docId}` |
| `createConversation` | `POST /workspaces/{wsId}/agents/{agentId}/conversations` with `knowledgeBaseIds: [kbId]` |
| `deleteConversation` | `DELETE /workspaces/{wsId}/agents/{agentId}/conversations/{convId}` |
| `chat` | `POST /workspaces/{wsId}/agents/{agentId}/conversations/{convId}/messages` |
| `chatStream` | `POST /workspaces/{wsId}/agents/{agentId}/conversations/{convId}/messages/stream` (SSE → AsyncIterable) |

### SSE parsing

The Workbench stream emits standard SSE (`event: token`, `data: {"delta":"..."}`)
terminated by `event: done`. We parse this into the shared `StreamDelta` type
using a simple line-based SSE reader over the fetch Response body.

---

## API Route Changes

### `POST /api/notebooks` (create)

New request body fields:
```json
{
  "title": "My Notebook",
  "rag_backend": "workbench",
  "workbench_embedding_service_id": "8f39749a-...",
  "workbench_agent_id": "c50f58c8-..."
}
```

On `rag_backend = "workbench"`:
1. Call `rag.createNotebookResources()` → gets back `kbId`
2. Store `rag_backend`, `workbench_kb_id`, `workbench_embedding_service_id` in SQLite

On `rag_backend = "openrag"`: existing behaviour (create filter, etc.)

### `DELETE /api/notebooks/[id]`

Reads `notebook.rag_backend`, calls the appropriate `deleteNotebookResources`.

### `POST /api/notebooks/[id]/documents`

Reads notebook backend, calls the appropriate `ingestDocument`.

### `DELETE /api/notebooks/[id]/documents/[docId]`

Reads notebook backend, calls the appropriate `deleteDocument`.

### `POST /api/notebooks/[id]/conversations`

New request body field for Workbench notebooks:
```json
{ "title": "...", "workbench_agent_id": "c50f58c8-..." }
```

Calls `rag.createConversation()` with the selected agent + notebook's KB.

### Chat routes (existing streaming route)

Read conversation's `workbench_agent_id` + `workbench_conversation_id`,
call `rag.chatStream()` with those values.

---

## UI Changes

### Notebook creation dialog

Add a backend picker (toggle or dropdown): "OpenRAG" / "AI Workbench".

When "AI Workbench" is selected, show:
- Embedding service picker (fetched from `GET /api/workbench/embedding-services`)
- Default agent picker (fetched from `GET /api/workbench/agents`)

### Conversation creation

For Workbench notebooks, show an agent picker (dropdown of available agents).
Defaults to the notebook's default agent.

### Minimal new API routes for UI data

```
GET /api/workbench/embedding-services → proxy to Workbench list
GET /api/workbench/agents             → proxy to Workbench list
```

These are thin proxies so the browser never talks to `:8080` directly.

---

## What stays unchanged

- `src/lib/openrag.ts` — still the low-level OpenRAG SDK wrapper (used by
  `backends/openrag.ts`)
- All UI components that render messages — they consume the same shape
  regardless of backend

## What adapts transparently

- **Podcast / Studio note generation** — these call `chat()` with a long
  prompt and get grounded text back. Once they route through `getBackend()`
  instead of importing `openrag.ts` directly, they work on either backend
  with no special handling. The Workbench agent's `search_kb` tool does the
  same retrieval step that OpenRAG's agent does.
- **ElevenLabs TTS** — completely backend-agnostic (it just needs a script
  string).

---

## REQ Coverage

| REQ-ID | Design item |
|--------|-------------|
| REQ-001 | `rag_backend` column + notebook creation logic |
| REQ-002 | `workbench.ingestDocument()` → `/ingest/file` |
| REQ-003 | `workbench.chatStream()` → `/messages/stream` SSE |
| REQ-004 | `workbench_agent_id` on conversations + agent picker UI |
| REQ-005 | `workbench_embedding_service_id` on notebook + creation picker |
| REQ-006 | `workbench.deleteNotebookResources()` → `DELETE /knowledge-bases/{kbId}` |
| REQ-007 | `workbench.deleteDocument()` → `DELETE /documents/{docId}` |
| REQ-008 | `workbench.createConversation()` / `deleteConversation()` |
