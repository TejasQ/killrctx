// ============================================================================
// rag.ts — shared RAG backend interface and factory
// ============================================================================
//
// _Basically_, this file defines what "a RAG backend" looks like to the rest
// of the app. Two implementations exist: OpenRAG (the original, backed by
// OpenSearch) and the AI Workbench (backed by Astra DB). API routes don't
// care which one they're talking to — they call getBackend(notebook.rag_backend)
// and get back an object with chat, ingest, and lifecycle methods.
//
// The interface is intentionally minimal: only the operations our API routes
// actually need. Backend-specific details (filter syncing, KB creation params)
// are handled inside each implementation, not exposed here.
// ============================================================================

import type { Notebook } from "./db";

// ─── Shared types ────────────────────────────────────────────────────────────

/** A single delta in a streaming chat response. */
export type StreamDelta =
  | { type: "token"; delta: string }
  | { type: "done"; responseId: string; response: string };

/** Arguments for chat calls (both sync and streaming). */
export type ChatArgs = {
  prompt: string;
  /** Workbench: conversationId to continue. OpenRAG: previousResponseId. */
  threadId?: string | null;
  /** Notebook row — backends read whatever they need from it. */
  notebook: Notebook;
  /** Source filenames to scope retrieval (OpenRAG only). */
  sourcePaths?: string[] | null;
  /** Retrieval limit (OpenRAG). */
  limit?: number | null;
  /** Score threshold (OpenRAG). */
  scoreThreshold?: number | null;
  /** Workbench agent ID (from conversation row). */
  workbenchAgentId?: string | null;
  /** Workbench conversation ID (from conversation row). */
  workbenchConversationId?: string | null;
};

/** Arguments for document ingestion. */
export type IngestArgs = {
  filename: string;
  bytes: Buffer;
  contentType: string;
  notebook: Notebook;
};

/** Ingest task status. */
export type TaskStatus = {
  status: "indexing" | "ready" | "failed";
  error: string | null;
};

/** Result of creating notebook-level resources on the backend. */
export type NotebookResources = {
  /** Workbench: the KB ID. OpenRAG: the filter ID. */
  resourceId: string;
  resourceName?: string;
};

/** Arguments for creating notebook resources. */
export type CreateResourcesArgs = {
  notebookId: string;
  notebookTitle: string;
  /** Workbench only: which embedding service to use. */
  embeddingServiceId?: string;
};

/** Arguments for deleting notebook resources. */
export type DeleteResourcesArgs = {
  notebook: Notebook;
};

/** Arguments for creating a conversation. */
export type CreateConversationArgs = {
  notebook: Notebook;
  /** Workbench: which agent to use for this conversation. */
  agentId?: string;
  title?: string;
};

// ─── Interface ───────────────────────────────────────────────────────────────

export interface RagBackend {
  /** Send a prompt and get the full response (non-streaming). */
  chat(args: ChatArgs): Promise<{ response: string; responseId: string }>;

  /** Send a prompt and stream token deltas as they arrive. */
  chatStream(args: ChatArgs): AsyncIterable<StreamDelta>;

  /** Ingest a document into the notebook's storage. */
  ingestDocument(args: IngestArgs): Promise<{ taskId: string }>;

  /** Check the status of an ingest task. */
  getTaskStatus(taskId: string, notebook: Notebook): Promise<TaskStatus>;

  /** Delete a document from the backend. */
  deleteDocument(filename: string, notebook: Notebook): Promise<void>;

  /** Create backend resources when a new notebook is created. */
  createNotebookResources(args: CreateResourcesArgs): Promise<NotebookResources>;

  /** Delete backend resources when a notebook is deleted. */
  deleteNotebookResources(args: DeleteResourcesArgs): Promise<void>;

  /** Create a conversation on the backend (Workbench only; OpenRAG is a no-op). */
  createConversation(args: CreateConversationArgs): Promise<{ conversationId: string | null }>;

  /** Delete a conversation on the backend. */
  deleteConversation(conversationId: string, notebook: Notebook, agentId?: string | null): Promise<void>;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

import { openragBackend } from "./backends/openrag";
import { workbenchBackend } from "./backends/workbench";

/**
 * Get the correct RAG backend implementation for a notebook.
 *
 * API routes call this with `notebook.rag_backend` and then use the
 * returned object for all RAG operations. Simple dispatch, no magic.
 */
export function getBackend(ragBackend: "openrag" | "workbench"): RagBackend {
  switch (ragBackend) {
    case "openrag":
      return openragBackend;
    case "workbench":
      return workbenchBackend;
  }
}
