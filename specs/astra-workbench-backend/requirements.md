# Astra Workbench Backend — Requirements

## User Story

As a user, I want to choose between OpenRAG and the AI Workbench (backed by
Astra DB) when creating a notebook, so that I can use either RAG backend
depending on my needs — and compare retrieval quality side by side.

---

## Requirements

### REQ-001: Per-notebook backend selection

When creating a notebook, the user picks a RAG backend: **OpenRAG** (default)
or **Workbench**. The choice is stored on the notebook and is immutable after
creation. Existing notebooks default to OpenRAG. New notebooks default to
OpenRAG unless the user explicitly selects Workbench.

**Acceptance:** Creating a notebook without specifying a backend uses OpenRAG.
Creating a notebook with backend = "workbench" persists that value; all
subsequent operations for that notebook route through the Workbench API.

### REQ-002: Document ingest via Workbench

Uploading a document to a Workbench-backed notebook ingests the file through
the AI Workbench into the notebook's dedicated Knowledge Base on Astra DB.

The Workbench `/ingest/file` endpoint supports: **PDF, DOCX, XLSX, and plain
text**. For text-based formats (CSV, Markdown, TXT, HTML, AsciiDoc, LaTeX),
we read the file content and send it via the Workbench `/ingest` (JSON text
body) endpoint instead.

Supported file types for Workbench notebooks:
- **File ingest** (binary upload): `.pdf`, `.docx`, `.xlsx`
- **Text ingest** (content as string): `.csv`, `.md`, `.txt`, `.html`,
  `.asciidoc`, `.tex`, `.latex`, `.json`, `.jsonl`

Unsupported for Workbench (no equivalent): `.pptx`, `.png`, `.jpg`, `.jpeg`,
`.webp`, `.tiff` (these remain OpenRAG-only). The UI should grey out or hide
unsupported types when a Workbench notebook is active.

**Acceptance:** A PDF uploaded to a Workbench notebook appears in the
Workbench's KB document list and is searchable via the agent. A CSV uploaded
is ingested as text and also searchable.

### REQ-003: Chat via Workbench agent (streaming)

Sending a message in a Workbench-backed notebook routes through the Workbench
agent streaming endpoint. The agent retrieves from the notebook's KB and
streams token deltas back to the UI.

**Acceptance:** Chat in a Workbench notebook streams tokens to the UI with the
same UX as OpenRAG chat.

### REQ-004: Per-conversation agent selection

Each conversation in a Workbench-backed notebook can target a different
Workbench agent. The user picks (or defaults) an agent when starting a new
conversation.

**Acceptance:** Two conversations in the same notebook can use different agents
(e.g. Bobby vs Sage); each conversation's replies come from the selected agent.

### REQ-005: Embedding service selection at notebook creation

When creating a Workbench-backed notebook, the user picks which Workbench
embedding service to use. This determines the vector dimensions and model for
that notebook's KB. Immutable after creation.

**Acceptance:** The created KB uses the selected embedding service ID.

### REQ-006: Notebook deletion cascades

Deleting a Workbench-backed notebook deletes the corresponding Knowledge Base
(and its vector collection) on the Workbench, plus all conversations.

**Acceptance:** After notebook deletion, the KB no longer exists on the
Workbench.

### REQ-007: Document deletion via Workbench

Deleting a document from a Workbench-backed notebook removes it from the
Workbench KB (cascades chunks).

**Acceptance:** After document deletion, the document and its chunks no longer
appear in the Workbench KB.

### REQ-008: Conversation lifecycle

Creating and deleting conversations in a Workbench-backed notebook maps to the
Workbench conversation CRUD endpoints.

**Acceptance:** Conversations are created/deleted on both the local SQLite and
the Workbench in sync.

---

## Out of Scope

- Modifying the OpenRAG backend — it stays as-is.
- Workbench workspace creation/management (we use the existing workspace).
- Workbench agent creation/editing (we use pre-existing agents).
- Reranking configuration.
- RLAC / multi-tenant principal management.
- Non-streaming chat (streaming-only for Workbench is fine).
- Migrating an existing notebook from one backend to the other.
