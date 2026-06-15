// ============================================================================
// openrag.ts — the only file that talks to the OpenRAG backend
// ============================================================================
//
// _Basically_, OpenRAG is a self-hosted RAG (Retrieval-Augmented Generation)
// service. Think of it as: "give me a chat endpoint that secretly searches a
// vector database before answering". You feed it documents, it embeds and
// indexes them in OpenSearch, and then chat calls become magic — the backend
// runs an agent that decides when to call its retrieval tool to ground answers.
//
// All communication goes through the official `openrag-sdk` client. Four
// in-app CRUD operations are covered here:
//
//   client.chat.create()        — send a prompt, get a grounded answer
//   client.chat.delete(chatId)  — remove a conversation thread from OpenRAG
//   client.documents.ingest()   — push a file through Docling → embed → index
//   client.documents.delete()   — remove all chunks for a filename
//
// Setup and health-probe calls (POST /onboarding, GET /settings) are NOT
// handled here — those routes use raw fetch() because they need response
// fields the SDK's SettingsResponse doesn't expose (providers[].has_api_key).
// See src/app/api/health/route.ts and src/app/api/setup/route.ts.
//
// Things that surprised us building this:
//
//   - **No collections.** OpenRAG indexes everything into one shared
//     OpenSearch index. There's no per-notebook partitioning at ingest. We
//     fake isolation by framing prompts ("answer using only the user's
//     uploaded documents"), which works because the only documents in the
//     index are the user's own. For a real multi-tenant deploy, look at
//     OpenRAG's knowledge-filter API.
//
//   - **120s timeout.** Long PDFs + cold OpenAI calls + slow Docker can
//     push chat past 30s. The timeout is set on the client constructor so
//     it applies to every SDK call without us having to thread AbortSignals
//     through each function.
//
//   - **Conversation threading.** The SDK calls it `chatId`; our SQLite
//     column is `response_id`. They hold the same value — the OpenRAG ID
//     that resumes a prior conversation turn.
//
// All env vars are read inside getClient() (not at module load) so .env
// edits are picked up on the next request without restarting `next dev`.
// ============================================================================

import { OpenRAGClient, type IngestResponse } from "openrag-sdk";

let _client: OpenRAGClient | null = null;

// Lazily construct the SDK client on first use.
//
// Why lazy? During `next build`, Next.js spawns parallel workers. If we
// constructed the client at module load time every worker would read env
// vars before .env is loaded. Deferring to first call is the same pattern
// used in src/lib/db.ts for the same reason.
function getClient(): OpenRAGClient {
  if (_client) return _client;
  _client = new OpenRAGClient({
    // OPENRAG_URL is the SDK's documented default — points to the OpenRAG
    // frontend proxy (:3000). For direct backend access (:8000), see
    // OPENRAG_INSTALL_URL used by health/route.ts and setup/route.ts.
    baseUrl: process.env.OPENRAG_URL ?? "http://localhost:3000",
    // apiKey is optional — local installs don't require auth. Remote or
    // secured instances should set OPENRAG_API_KEY in .env.
    apiKey: process.env.OPENRAG_API_KEY,
    timeout: 120_000,
  });
  return _client;
}

/**
 * Send a prompt to OpenRAG and get the agent's reply.
 *
 * `previousResponseId` chains turns into a stateful conversation. Pass the
 * last assistant `response_id` (stored in our SQLite messages table) and the
 * backend replays prior agent state under that ID — no need to resend history.
 *
 * `limit` controls how many retrieval passages the tool can pull. Default 8
 * is fine for chat; podcasts use 12 for more variety.
 */
export async function chat(args: {
  prompt: string;
  previousResponseId?: string | null;
  limit?: number;
}): Promise<{ response: string; responseId: string }> {
  const r = await getClient().chat.create({
    message: args.prompt,
    // The SDK calls this `chatId`; it is the same threading token we store
    // as `response_id` in SQLite. Undefined (not null) tells the SDK to
    // start a fresh conversation.
    chatId: args.previousResponseId ?? undefined,
    stream: false,
    limit: args.limit ?? 8,
  });
  return { response: r.response, responseId: r.chatId ?? "" };
}

/**
 * Send a file to OpenRAG for ingestion.
 *
 * `wait: false` fires and forgets — the SDK will not internally poll for
 * completion. The actual chunking + embedding happens asynchronously, but
 * for files under a few MB it's effectively done by the time the next chat
 * query runs. The returned task_id is stored in SQLite for debugging.
 */
export async function ingestDocument(args: {
  filename: string;
  bytes: Buffer;
  contentType: string;
}): Promise<{ taskId: string }> {
  const blob = new Blob([new Uint8Array(args.bytes)], { type: args.contentType });
  const file = new File([blob], args.filename, { type: args.contentType });
  const r = await getClient().documents.ingest({ file, filename: args.filename, wait: false });
  return { taskId: (r as IngestResponse).task_id ?? "" };
}

/**
 * Remove a conversation thread from OpenRAG by its chatId.
 *
 * The `chatId` is what OpenRAG calls the threading token — our SQLite column
 * stores it as `response_id`. If the conversation never had an assistant reply
 * there is no chatId to clean up, so callers should pass null/undefined and
 * this function becomes a no-op.
 *
 * Best-effort — callers swallow errors so the SQLite delete always succeeds
 * even if OpenRAG is unreachable.
 */
export async function deleteConversation(chatId: string): Promise<void> {
  await getClient().chat.delete(chatId);
}

/**
 * Remove all indexed chunks for a document filename from OpenRAG.
 *
 * Best-effort — callers should swallow errors (the SQLite pointer row is
 * already gone; lingering chunks are invisible to the user). See the DELETE
 * route in src/app/api/notebooks/[id]/documents/[docId]/route.ts.
 */
export async function deleteDocument(filename: string): Promise<void> {
  await getClient().documents.delete(filename);
}

/**
 * Probe the OpenRAG instance to verify it is reachable and responding.
 *
 * Used by the health route's external-instance path — if this resolves,
 * the instance is up. Throws on any network or HTTP error.
 */
export async function probeSettings(): Promise<void> {
  await getClient().settings.get();
}
