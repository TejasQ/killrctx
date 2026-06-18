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
// All communication goes through the official `openrag-sdk` client. Seven
// in-app CRUD operations are covered here:
//
//   client.chat.create()                 — send a prompt, get a grounded answer (non-streaming)
//   client.chat.stream()                 — send a prompt, stream token deltas as they arrive
//   client.chat.delete(chatId)           — remove a conversation thread from OpenRAG
//   client.documents.ingest()            — push a file through Docling → embed → index
//   client.documents.delete()            — remove all chunks for a filename
//   client.knowledgeFilters.create()     — create a per-notebook retrieval filter
//   client.knowledgeFilters.get/update() — sync filter's data_sources to ready filenames
//   client.knowledgeFilters.delete()     — remove a filter on notebook delete
//
// Setup and health-probe calls (POST /onboarding, GET /settings) are NOT
// handled here — those routes use raw fetch() because they need response
// fields the SDK's SettingsResponse doesn't expose (providers[].has_api_key).
// See src/app/api/health/route.ts and src/app/api/setup/route.ts.
//
// Model listing (GET /api/models/{provider}) and settings update are also
// handled here. The SDK has no models endpoint so we raw-fetch OpenRAG's
// frontend proxy for those — same pattern as the health route.
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

import { OpenRAGClient, type IngestResponse, type StreamEvent } from "openrag-sdk";

// ============================================================================
// Debounced filter sync — prevents race conditions on concurrent uploads.
//
// _Basically_, when 10 files upload in quick succession each POST handler
// fires syncFilterSources as a background task. Without debouncing, those
// 10 concurrent calls each do a get → update round-trip that can interleave
// and overwrite each other, leaving the filter with only the last file's view
// of the document list. Instead we:
//   1. Collect the filter ID into a per-filterId pending set (no-op for deletes
//      which pass an explicit list directly).
//   2. Reset a 1.5s debounce timer on every call.
//   3. When the timer fires, do ONE syncFilterSources with the full SQLite list.
//
// The callback is provided by the caller (the document route) because the
// database is not importable here (lib/openrag.ts has no dependency on lib/db.ts).
// ============================================================================
const _pendingSync = new Map<string, {
  timer: ReturnType<typeof setTimeout>;
  getFilenames: () => string[];
}>();

const SYNC_DEBOUNCE_MS = 1500;

/**
 * Schedule a debounced filter sync for a given filterId.
 *
 * `getFilenames` is called when the timer fires (not when scheduled) so it
 * always reads the freshest list from SQLite, including uploads that landed
 * after this call was made.
 */
export function scheduleSyncFilterSources(filterId: string, getFilenames: () => string[]): void {
  const existing = _pendingSync.get(filterId);
  if (existing) clearTimeout(existing.timer);

  const timer = setTimeout(async () => {
    _pendingSync.delete(filterId);
    try {
      await syncFilterSources(filterId, getFilenames());
    } catch {
      // Best-effort — same as all other filter operations.
    }
  }, SYNC_DEBOUNCE_MS);

  _pendingSync.set(filterId, { timer, getFilenames });
}

// ============================================================================

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
  filterId?: string | null;
  /** Filenames to scope retrieval to. Always sent as filters.data_sources
   *  so OpenRAG's agent searches only those files. When absent the filter's
   *  own data_sources list still applies via filterId. */
  sourcePaths?: string[] | null;
  /** limit and scoreThreshold come from the filter's own queryData config
   *  (fetched by getFilterMeta and cached in SQLite). Callers pass them
   *  through so we honour the values the user configured in OpenRAG. */
  limit?: number | null;
  scoreThreshold?: number | null;
}): Promise<{ response: string; responseId: string }> {
  const params = {
    message: args.prompt,
    chatId: args.previousResponseId ?? undefined,
    filterId: args.filterId ?? undefined,
    // Always send the file list when we have one — lets OpenRAG scope to the
    // exact set of documents the user has selected (or all ready docs).
    filters: args.sourcePaths?.length
      ? { data_sources: args.sourcePaths }
      : undefined,
    stream: false as const,
    // Use the filter's configured limit/scoreThreshold when available;
    // fall back to sensible defaults so the call always works.
    limit: args.limit ?? 8,
    scoreThreshold: args.scoreThreshold ?? undefined,
  };
  // Log the exact SDK call so we can verify filter/source scoping during testing.
  console.log("[openrag] chat.create →", JSON.stringify(params, null, 2));
  const r = await getClient().chat.create(params);
  console.log("[openrag] chat.create ← responseId:", r.chatId, "  responseLength:", r.response?.length);
  return { response: r.response, responseId: r.chatId ?? "" };
}

/**
 * Same as chat() but yields token deltas as they arrive from OpenRAG.
 *
 * Returns an AsyncIterable of SDK StreamEvents. The caller is responsible
 * for draining the iterable — the final DoneEvent carries the chatId needed
 * to continue the thread on the next turn.
 *
 * Used by the streaming API routes for chat and note generation so the UI
 * can render tokens live instead of waiting for the complete response.
 */
export function chatStream(args: {
  prompt: string;
  previousResponseId?: string | null;
  filterId?: string | null;
  sourcePaths?: string[] | null;
  limit?: number | null;
  scoreThreshold?: number | null;
}): Promise<AsyncIterable<StreamEvent>> {
  const params = {
    message: args.prompt,
    chatId: args.previousResponseId ?? undefined,
    filterId: args.filterId ?? undefined,
    filters: args.sourcePaths?.length
      ? { data_sources: args.sourcePaths }
      : undefined,
    limit: args.limit ?? 8,
    scoreThreshold: args.scoreThreshold ?? undefined,
  };
  console.log("[openrag] chat.stream →", JSON.stringify(params, null, 2));
  // client.chat.stream() returns a ChatStream which is an AsyncIterable<StreamEvent>.
  return getClient().chat.stream(params);
}

/**
 * Send a file to OpenRAG for ingestion.
 *
 * `wait: false` returns immediately with a task_id. Ingest status is tracked
 * via `getTaskStatus()` and polled by the bundle route on every client refresh.
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
 * Fetch the current ingest status of a task from OpenRAG.
 *
 * Uses `getTaskStatus` (single HTTP fetch) not `waitForTask` (blocking poll loop).
 * Returns the status and, on failure, the first error message found in the
 * per-file `files` map from the OpenRAG task response.
 */
export async function getTaskStatus(
  taskId: string,
): Promise<{ status: "indexing" | "ready" | "failed"; error: string | null }> {
  // Cast to the internal shape — IngestTaskStatus.files is Record<string, unknown>.
  const r = (await getClient().documents.getTaskStatus(taskId)) as {
    successful_files: number;
    failed_files: number;
    files: Record<string, { error?: string | null }>;
  };

  if (r.failed_files > 0) {
    // Extract the first non-null error message from the per-file results.
    const error =
      Object.values(r.files).find((f) => f.error)?.error ?? "Ingest failed";
    return { status: "failed", error };
  }
  if (r.successful_files > 0) return { status: "ready", error: null };
  return { status: "indexing", error: null };
}

/**
 * Remove a conversation thread from OpenRAG by its chatId.
 *
 * The `chatId` is what OpenRAG calls the threading token — our SQLite column
 * stores it as `response_id`. Callers must only call this when a chatId
 * exists (i.e. the conversation had at least one assistant reply).
 *
 * Best-effort — callers swallow errors so the SQLite delete always succeeds
 * even if OpenRAG is unreachable.
 */
export async function deleteConversation(chatId: string): Promise<void> {
  await getClient().chat.delete(chatId);
}

/**
 * Create a named knowledge filter in OpenRAG scoped to this notebook.
 *
 * We start the filter with an empty data_sources array so there is never a
 * wildcard `["*"]` that would match every document in the index. The list is
 * populated by syncFilterSources as documents are ingested.
 *
 * Best-effort callers should catch and proceed without a filter if this throws
 * (e.g. OpenRAG unreachable at notebook creation time).
 */
export async function createFilter(name: string): Promise<{ filterId: string; filterName: string }> {
  const r = await getClient().knowledgeFilters.create({
    name,
    // Start with an empty data_sources list — not a wildcard.
    // syncFilterSources fills this in as documents become ready.
    queryData: { filters: { data_sources: [] } },
  });
  if (!r.success || !r.id) throw new Error(r.error ?? "filter creation failed");
  return { filterId: r.id, filterName: name };
}

/**
 * Delete a knowledge filter from OpenRAG by its ID.
 *
 * Best-effort — callers swallow errors so the SQLite delete always proceeds even
 * if OpenRAG is unreachable. See DELETE /api/notebooks/[id].
 */
export async function deleteFilter(filterId: string): Promise<void> {
  await getClient().knowledgeFilters.delete(filterId);
}

/**
 * Update the icon and color of a knowledge filter in OpenRAG.
 *
 * We spread the existing queryData and override only icon+color so the
 * data_sources / limit / scoreThreshold values are never clobbered.
 * Returns the confirmed values after update.
 */
export async function updateFilterMeta(
  filterId: string,
  icon: string,
  color: string,
): Promise<void> {
  const client = getClient();
  const current = await client.knowledgeFilters.get(filterId);
  if (!current) throw new Error("filter not found");
  await client.knowledgeFilters.update(filterId, {
    queryData: {
      ...current.queryData,
      icon,
      color,
    },
  });
}

export async function getFilterMeta(
  filterId: string,
): Promise<{ icon: string | null; color: string | null; limit: number | null; scoreThreshold: number | null } | null> {
  const f = await getClient().knowledgeFilters.get(filterId);
  if (!f) return null;
  // icon, color, limit, and scoreThreshold are all stored inside queryData.
  // The SDK type declares limit and scoreThreshold there; icon and color are
  // undocumented but confirmed in the live filter payload.
  const qd = (f.queryData ?? {}) as {
    icon?: string;
    color?: string;
    limit?: number;
    scoreThreshold?: number;
  };
  return {
    icon: qd.icon ?? null,
    color: qd.color ?? null,
    limit: qd.limit ?? null,
    scoreThreshold: qd.scoreThreshold ?? null,
  };
}

/**
 * Sync a filter's data_sources list to exactly match the given set of filenames.
 *
 * Why a full sync instead of per-file append?
 *   OpenRAG initialises a new filter with data_sources: ["*"] (a wildcard).
 *   Appending to ["*"] leaves the wildcard in the list, which defeats the
 *   purpose of per-notebook scoping. A full replace guarantees the list is
 *   exactly the current set of indexed files, no more and no less.
 *
 * Best-effort — callers swallow errors; ingest still succeeds without it.
 */
export async function syncFilterSources(filterId: string, filenames: string[]): Promise<void> {
  const client = getClient();
  const current = await client.knowledgeFilters.get(filterId);
  if (!current) return; // filter not found — nothing to update

  // Only set data_sources — do NOT add owners/connector_types/document_types wildcards.
  // Adding those extra constraints caused OpenRAG to return 0 results.
  // The reference app (spec_coding_openrag_notebook_app) only sets data_sources here.
  await client.knowledgeFilters.update(filterId, {
    queryData: {
      ...current.queryData,
      filters: {
        // Preserve any existing filter sub-fields (document_types etc.) but
        // only if they're already set — don't introduce new wildcard constraints.
        ...current.queryData?.filters,
        // Replace data_sources with the exact set of ready filenames.
        // This clears the initial ["*"] wildcard OpenRAG sets on creation.
        data_sources: filenames,
      },
    },
  });
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
 * Used by the health route's external-instance path — returns the LLM and
 * embedding identifiers so the health route can surface them in the UI.
 * Throws on any network or HTTP error.
 */
export async function probeSettings(): Promise<{ llm: string; embedding: string }> {
  const s = await getClient().settings.get();
  const llm = `${s.agent.llm_provider ?? "?"}/${s.agent.llm_model ?? "?"}`;
  const embedding = `${s.knowledge.embedding_provider ?? "?"}/${s.knowledge.embedding_model ?? "?"}`;
  return { llm, embedding };
}

export type ModelOption = { value: string; label: string; default: boolean };
export type ProviderModels = { language_models: ModelOption[]; embedding_models: ModelOption[] };

/**
 * Fetch the model list for a single provider from OpenRAG's frontend proxy.
 *
 * Why raw fetch? The SDK has no models endpoint — only OpenRAG's own UI calls
 * these routes. We proxy through our server routes so OPENRAG_URL never leaks
 * to the browser.
 *
 * Each provider uses a different HTTP method (Ollama is GET; the rest are POST
 * with an optional api_key body). OpenRAG's backend fills in the stored key
 * when the body field is empty, so we can pass `{}` safely.
 */
export async function getModelsForProvider(provider: string): Promise<ProviderModels> {
  const base = process.env.OPENRAG_URL ?? "http://localhost:3000";

  // Ollama endpoint name in OpenRAG's router is "ollama"; IBM WatsonX is "ibm".
  const path = provider === "watsonx" ? "ibm" : provider;

  const res = provider === "ollama"
    ? await fetch(`${base}/api/models/${path}`, { cache: "no-store" })
    : await fetch(`${base}/api/models/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
        cache: "no-store",
      });

  if (!res.ok) throw new Error(`models/${path} returned ${res.status}`);
  return res.json() as Promise<ProviderModels>;
}

/**
 * Update the active LLM or embedding model in OpenRAG, then return the fresh
 * "provider/model" strings for both so callers can update the UI in one step.
 */
export async function updateSettings(args: {
  llm_provider?: string;
  llm_model?: string;
  embedding_provider?: string;
  embedding_model?: string;
}): Promise<{ llm: string; embedding: string }> {
  await getClient().settings.update(args);
  // Re-read to get confirmed values — update() only returns a message string.
  return probeSettings();
}
