// ============================================================================
// backends/workbench.ts — RagBackend adapter for AI Workbench + Astra DB
// ============================================================================
//
// _Basically_, this talks to the AI Workbench REST API at localhost:8080 (or
// wherever WORKBENCH_URL points). The Workbench handles everything: chunking,
// embedding, vector storage in Astra, agent chat with retrieval tools, and
// streaming. We just call the right endpoints.
//
// Key entity mapping:
//   killrctx notebook  → Workbench Knowledge Base (one Astra collection)
//   killrctx conversation → Workbench Conversation (under an agent)
//   killrctx document  → Workbench KB Document
//
// All env vars are read lazily (inside functions, not at module load) so
// .env edits are picked up without restarting the dev server.
// ============================================================================

import type {
  RagBackend,
  ChatArgs,
  IngestArgs,
  TaskStatus,
  StreamDelta,
  NotebookResources,
  CreateResourcesArgs,
  DeleteResourcesArgs,
  CreateConversationArgs,
} from "../rag";
import type { Notebook } from "../db";

// ─── Config helpers ──────────────────────────────────────────────────────────

function baseUrl(): string {
  return process.env.WORKBENCH_URL ?? "http://localhost:8080";
}

function workspaceId(): string {
  const id = process.env.WORKBENCH_WORKSPACE_ID;
  if (!id) throw new Error("WORKBENCH_WORKSPACE_ID is not set");
  return id;
}

function defaultAgentId(): string {
  const id = process.env.WORKBENCH_DEFAULT_AGENT_ID;
  if (!id) throw new Error("WORKBENCH_DEFAULT_AGENT_ID is not set");
  return id;
}

function defaultEmbeddingServiceId(): string {
  const id = process.env.WORKBENCH_DEFAULT_EMBEDDING_SERVICE_ID;
  if (!id) throw new Error("WORKBENCH_DEFAULT_EMBEDDING_SERVICE_ID is not set");
  return id;
}

function chunkingServiceId(): string {
  const id = process.env.WORKBENCH_CHUNKING_SERVICE_ID;
  if (!id) throw new Error("WORKBENCH_CHUNKING_SERVICE_ID is not set");
  return id;
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  const key = process.env.WORKBENCH_API_KEY;
  if (key) h["Authorization"] = `Bearer ${key}`;
  return h;
}

/** Build the workspace-scoped API path. */
function wsPath(path: string): string {
  return `${baseUrl()}/api/v1/workspaces/${workspaceId()}${path}`;
}

// ─── Text-based file types (ingested via JSON text body, not file upload) ────

const TEXT_EXTENSIONS = new Set([
  ".csv", ".md", ".txt", ".html", ".asciidoc", ".tex", ".latex", ".json", ".jsonl",
]);

function isTextFile(filename: string): boolean {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}

// ─── Implementation ──────────────────────────────────────────────────────────

export const workbenchBackend: RagBackend = {
  async chat(args: ChatArgs) {
    const agentId = args.workbenchAgentId ?? defaultAgentId();
    const convId = args.workbenchConversationId;
    if (!convId) throw new Error("Workbench chat requires a conversation ID");

    const url = wsPath(`/agents/${agentId}/conversations/${convId}/messages`);
    const res = await fetch(url, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ content: args.prompt }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Workbench chat failed (${res.status}): ${body}`);
    }

    const data = (await res.json()) as {
      assistant: { messageId: string; content: string | null };
    };

    return {
      response: data.assistant.content ?? "",
      responseId: data.assistant.messageId,
    };
  },

  async *chatStream(args: ChatArgs): AsyncIterable<StreamDelta> {
    const agentId = args.workbenchAgentId ?? defaultAgentId();
    const convId = args.workbenchConversationId;
    if (!convId) throw new Error("Workbench chatStream requires a conversation ID");

    const url = wsPath(`/agents/${agentId}/conversations/${convId}/messages/stream`);
    console.log(`[workbench] POST ${url}`);
    const res = await fetch(url, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ content: args.prompt }),
    });

    console.log(`[workbench] chatStream response status: ${res.status}`);
    if (!res.ok) {
      const body = await res.text();
      console.error(`[workbench] chatStream error body: ${body}`);
      throw new Error(`Workbench stream failed (${res.status}): ${body}`);
    }

    if (!res.body) throw new Error("Workbench stream returned no body");

    // Parse SSE from the response body. The Workbench emits:
    //   event: token       data: {"delta":"..."}
    //   event: done        data: {full ChatMessage}
    //   event: error       data: {error details}
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullResponse = "";
    let currentEvent = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        // Keep the last incomplete line in the buffer.
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            const raw = line.slice(6);
            if (currentEvent === "token") {
              const parsed = JSON.parse(raw) as { delta: string };
              fullResponse += parsed.delta;
              yield { type: "token", delta: parsed.delta };
            } else if (currentEvent === "done") {
              const parsed = JSON.parse(raw) as { messageId: string };
              yield { type: "done", responseId: parsed.messageId, response: fullResponse };
              return;
            } else if (currentEvent === "error" || currentEvent === "stream-error") {
              const parsed = JSON.parse(raw) as { message?: string };
              throw new Error(`Workbench stream error: ${parsed.message ?? raw}`);
            }
            currentEvent = "";
          }
          // Blank lines and other lines are ignored.
        }
      }
    } finally {
      reader.releaseLock();
    }
  },

  async ingestDocument(args: IngestArgs) {
    const kbId = args.notebook.workbench_kb_id;
    if (!kbId) throw new Error("Notebook has no workbench_kb_id");

    if (isTextFile(args.filename)) {
      // Text-based files: send content as a JSON text body.
      const text = Buffer.from(args.bytes).toString("utf-8");
      const url = wsPath(`/knowledge-bases/${kbId}/ingest?async=true`);
      const res = await fetch(url, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          text,
          sourceFilename: args.filename,
          fileType: args.contentType,
          fileSize: args.bytes.length,
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Workbench text ingest failed (${res.status}): ${body}`);
      }

      const data = (await res.json()) as { job?: { jobId: string }; document?: { documentId: string } };
      return { taskId: data.job?.jobId ?? data.document?.documentId ?? "" };
    }

    // Binary files (PDF, DOCX, XLSX): multipart file upload.
    const url = wsPath(`/knowledge-bases/${kbId}/ingest/file?async=true`);
    const form = new FormData();
    const blob = new Blob([new Uint8Array(args.bytes)], { type: args.contentType });
    form.append("file", blob, args.filename);

    const h: Record<string, string> = {};
    const key = process.env.WORKBENCH_API_KEY;
    if (key) h["Authorization"] = `Bearer ${key}`;

    const res = await fetch(url, {
      method: "POST",
      headers: h,  // No Content-Type — FormData sets it with boundary.
      body: form,
    });

    if (!res.ok) {
      const body = await res.text();
      // 413 means the file exceeded the Workbench's per-route size ceiling.
      // Parse the structured error when possible so we can give a clean message.
      if (res.status === 413) {
        let hint = "The file is too large for the Workbench to ingest.";
        try {
          const parsed = JSON.parse(body) as { error?: { message?: string } };
          if (parsed.error?.message) hint = parsed.error.message;
        } catch { /* leave default hint */ }
        throw new Error(`File too large — ${hint}`);
      }
      throw new Error(`Workbench file ingest failed (${res.status}): ${body}`);
    }

    const data = (await res.json()) as { job?: { jobId: string }; document?: { documentId: string } };
    return { taskId: data.job?.jobId ?? data.document?.documentId ?? "" };
  },

  async getTaskStatus(taskId: string, notebook: Notebook): Promise<TaskStatus> {
    // The taskId is a job ID. Poll the job endpoint.
    const url = wsPath(`/jobs/${taskId}`);
    const res = await fetch(url, { headers: headers() });

    if (!res.ok) {
      // Job not found or already completed — treat as ready.
      if (res.status === 404) return { status: "ready", error: null };
      return { status: "failed", error: `Job fetch failed: ${res.status}` };
    }

    const data = (await res.json()) as { status: string; errorMessage?: string | null };
    switch (data.status) {
      case "succeeded":
      case "completed":
      case "ready":
        return { status: "ready", error: null };
      case "failed":
      case "error":
        return { status: "failed", error: data.errorMessage ?? "Ingest failed" };
      default:
        // "pending", "running", or any other in-progress value
        return { status: "indexing", error: null };
    }
  },

  async deleteDocument(filename: string, notebook: Notebook) {
    const kbId = notebook.workbench_kb_id;
    if (!kbId) return;

    // Find the document by filename, then delete it.
    const listUrl = wsPath(`/knowledge-bases/${kbId}/documents`);
    const res = await fetch(listUrl, { headers: headers() });
    if (!res.ok) return;

    const data = (await res.json()) as { items: { documentId: string; sourceFilename: string }[] };
    const doc = data.items.find((d) => d.sourceFilename === filename);
    if (!doc) return;

    const delUrl = wsPath(`/knowledge-bases/${kbId}/documents/${doc.documentId}`);
    await fetch(delUrl, { method: "DELETE", headers: headers() });
  },

  async createNotebookResources(args: CreateResourcesArgs): Promise<NotebookResources> {
    // Create a Knowledge Base on the Workbench for this notebook.
    // The KB name must match ^[A-Za-z][A-Za-z0-9_]{0,47}$ — sanitize the title.
    const safeName = args.notebookTitle
      .replace(/[^A-Za-z0-9_]/g, "_")
      .replace(/^([^A-Za-z])/, "N$1")
      .slice(0, 48) || "notebook";

    // Fall back to the env-var default when no embedding service was specified
    // (e.g. notebooks created before the model picker was added, or when the
    // picker was removed and the caller no longer passes this field).
    const embeddingServiceId = args.embeddingServiceId ?? defaultEmbeddingServiceId();

    const url = wsPath("/knowledge-bases");
    const res = await fetch(url, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        name: safeName,
        description: `Knowledge base for notebook: ${args.notebookTitle}`,
        embeddingServiceId,
        chunkingServiceId: chunkingServiceId(),
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Workbench KB creation failed (${res.status}): ${body}`);
    }

    const data = (await res.json()) as { knowledgeBaseId: string; name: string };
    return { resourceId: data.knowledgeBaseId, resourceName: data.name };
  },

  async renameNotebookResources() {
    // Workbench Knowledge Base names are immutable after creation.
    // This method is required by the RagBackend interface but is intentionally
    // a no-op — the route layer skips calling it for workbench notebooks.
  },

  async deleteNotebookResources(args: DeleteResourcesArgs) {
    const kbId = args.notebook.workbench_kb_id;
    if (!kbId) return;

    const url = wsPath(`/knowledge-bases/${kbId}`);
    await fetch(url, { method: "DELETE", headers: headers() });
  },

  async createConversation(args: CreateConversationArgs) {
    const agentId = args.agentId ?? defaultAgentId();
    const kbId = args.notebook.workbench_kb_id;

    const url = wsPath(`/agents/${agentId}/conversations`);
    console.log(`[workbench] createConversation POST ${url} kbId=${kbId ?? "none"}`);
    const res = await fetch(url, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        title: args.title ?? "Conversation",
        knowledgeBaseIds: kbId ? [kbId] : [],
      }),
    });

    console.log(`[workbench] createConversation response status: ${res.status}`);
    if (!res.ok) {
      const body = await res.text();
      console.error(`[workbench] createConversation error body: ${body}`);
      throw new Error(`Workbench conversation creation failed (${res.status}): ${body}`);
    }

    const data = (await res.json()) as { conversationId: string };
    console.log(`[workbench] createConversation created: ${data.conversationId}`);
    return { conversationId: data.conversationId };
  },

  async deleteConversation(conversationId: string, _notebook: Notebook, agentId?: string | null) {
    // Use the agent that owns the conversation; fall back to the default only
    // if the caller doesn't know which agent was used (e.g. legacy rows).
    const agent = agentId ?? defaultAgentId();
    const url = wsPath(`/agents/${agent}/conversations/${conversationId}`);
    await fetch(url, { method: "DELETE", headers: headers() });
  },
};
