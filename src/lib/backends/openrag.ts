// ============================================================================
// backends/openrag.ts — RagBackend adapter for OpenRAG
// ============================================================================
//
// _Basically_, this wraps the existing functions in src/lib/openrag.ts to
// satisfy the shared RagBackend interface. No new behaviour — just plumbing
// so the rest of the app can talk to OpenRAG through the same API shape it
// uses for the Workbench backend.
//
// The low-level OpenRAG SDK calls still live in src/lib/openrag.ts. This
// file only adapts their signatures; it never constructs the SDK client or
// knows about OpenSearch/Langflow internals.
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

import * as openrag from "../openrag";

// ─── Implementation ──────────────────────────────────────────────────────────

export const openragBackend: RagBackend = {
  async chat(args: ChatArgs) {
    return openrag.chat({
      prompt: args.prompt,
      previousResponseId: args.threadId,
      filterId: args.notebook.openrag_filter_id,
      sourcePaths: args.sourcePaths,
      limit: args.limit,
      scoreThreshold: args.scoreThreshold,
    });
  },

  async *chatStream(args: ChatArgs): AsyncIterable<StreamDelta> {
    const stream = await openrag.chatStream({
      prompt: args.prompt,
      previousResponseId: args.threadId,
      filterId: args.notebook.openrag_filter_id,
      sourcePaths: args.sourcePaths,
      limit: args.limit,
      scoreThreshold: args.scoreThreshold,
    });

    let fullResponse = "";
    let responseId = "";

    for await (const event of stream) {
      // The OpenRAG SDK emits "content" (token delta), "sources", and "done".
      if (event.type === "content") {
        fullResponse += event.delta;
        yield { type: "token", delta: event.delta };
      } else if (event.type === "done") {
        responseId = event.chatId ?? "";
        yield { type: "done", responseId, response: fullResponse };
      }
      // "sources" events are ignored at this layer — they're handled by
      // the streaming route directly if needed.
    }
  },

  async ingestDocument(args: IngestArgs) {
    return openrag.ingestDocument({
      filename: args.filename,
      bytes: args.bytes,
      contentType: args.contentType,
    });
  },

  async getTaskStatus(taskId: string) {
    return openrag.getTaskStatus(taskId) as Promise<TaskStatus>;
  },

  async deleteDocument(filename: string) {
    await openrag.deleteDocument(filename);
  },

  async createNotebookResources(args: CreateResourcesArgs): Promise<NotebookResources> {
    const { filterId, filterName } = await openrag.createFilter(args.notebookTitle);
    return { resourceId: filterId, resourceName: filterName };
  },

  async deleteNotebookResources(args: DeleteResourcesArgs) {
    if (args.notebook.openrag_filter_id) {
      await openrag.deleteFilter(args.notebook.openrag_filter_id);
    }
  },

  async createConversation(_args: CreateConversationArgs) {
    // OpenRAG doesn't have a conversation resource — threading is implicit
    // via chatId. Return null so the caller knows there's nothing to store.
    return { conversationId: null };
  },

  async deleteConversation(conversationId: string) {
    // conversationId here is the OpenRAG chatId (response_id from messages).
    // Only delete if we have a real ID — early conversations may have none.
    if (conversationId) {
      await openrag.deleteConversation(conversationId);
    }
  },
};
