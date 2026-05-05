// ============================================================================
// openrag.ts — the only file that talks to the OpenRAG backend
// ============================================================================
//
// _Basically_, OpenRAG is a self-hosted RAG (Retrieval-Augmented Generation)
// service. Think of it as: "give me a chat endpoint that secretly searches a
// vector database before answering". You feed it documents, it embeds and
// indexes them in OpenSearch, and then `/chat` calls become magic — the
// backend runs an OpenAI Responses-style agent that decides when to call its
// "OpenSearch Retrieval Tool" to ground its answers.
//
// Two endpoints, that's the whole API surface we need:
//
//   POST /chat
//     { prompt, previous_response_id?, stream, limit?, ... }
//       -> { response, response_id }
//     The agent loop. `previous_response_id` threads multi-turn conversations
//     without us having to send the full message history each time.
//
//   POST /router/upload_ingest          (multipart: file=<binary>)
//     File goes in -> backend pipes it through Docling (text/table/OCR
//     extraction) -> chunks it -> embeds with OpenAI text-embedding-3-small
//     -> writes vectors into the shared `documents` index.
//
// Things that surprised us building this:
//
//   - **No collections.** OpenRAG indexes everything into one shared
//     OpenSearch index. There's no per-notebook partitioning at ingest. We
//     fake isolation by framing prompts ("answer using only the user's
//     uploaded documents"), which works because the only documents in the
//     index are the user's own. For a real multi-tenant deploy, look at
//     OpenRAG's /knowledge-filter API.
//
//   - **120s timeout.** Long PDFs + cold OpenAI calls + slow Docker can
//     push /chat past 30s. AbortSignal.timeout(120_000) is generous but
//     safer than letting Next.js' default tear it down at exactly the wrong
//     moment.
//
//   - **Two ingest paths exist.** /langflow/upload_ingest needs Langflow
//     to mint an API key (which is fragile on first boot). /router/upload_ingest
//     bypasses Langflow entirely and goes straight through the backend's
//     own Docling -> embed -> index pipeline. We use the second path; see
//     OPENRAG_INGEST_PATH in .env.
//
// All env vars are read at call-time (not at module load) so .env edits are
// picked up on the next request without restarting `next dev`.
// ============================================================================

const defaultBaseUrl = "http://localhost:8000";
const defaultIngestPath = "/router/upload_ingest";

/**
 * Send a file to OpenRAG for ingestion. Returns the backend task ID — the
 * actual chunking + embedding happens asynchronously, but for files under a
 * few MB it's effectively done by the time this resolves. We don't poll the
 * task here; the file shows up in retrieval results when ready.
 */
export async function ingestDocument(args: {
  filename: string;
  bytes: Buffer;
  contentType: string;
}): Promise<{ taskId: string }> {
  const baseUrl = process.env.OPENRAG_URL ?? defaultBaseUrl;
  const ingestPath = process.env.OPENRAG_INGEST_PATH ?? defaultIngestPath;

  // FormData + Blob is how Node 18+ does multipart uploads natively. No
  // form-data package needed. The Blob constructor needs a Uint8Array view
  // because Buffer's typing isn't directly compatible.
  const form = new FormData();
  const blob = new Blob([new Uint8Array(args.bytes)], {
    type: args.contentType,
  });
  form.append("file", blob, args.filename);

  const res = await fetch(`${baseUrl}${ingestPath}`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `OpenRAG ingest failed (${res.status}): ${body.slice(0, 500)}`,
    );
  }
  const json = (await res.json().catch(() => ({}))) as { task_id?: string };
  return { taskId: json.task_id ?? "" };
}

/**
 * Send a prompt to OpenRAG and get the agent's reply. The agent decides
 * internally whether to call its retrieval tool — we don't tell it to. Our
 * only lever is `prompt` framing (see /api/notebooks/[id]/chat/route.ts,
 * which prepends a "use OpenSearch Retrieval first" instruction).
 *
 * `previousResponseId` chains turns into a stateful conversation. The
 * backend stores prior agent state under that ID and replays it; we just
 * keep the latest assistant `response_id` in our SQLite messages table.
 *
 * `limit` controls how many retrieval passages the tool can pull. Default 8
 * is fine for chat; podcasts use 12 for more variety.
 */
export async function chat(args: {
  prompt: string;
  previousResponseId?: string | null;
  limit?: number;
}): Promise<{ response: string; responseId: string }> {
  const baseUrl = process.env.OPENRAG_URL ?? defaultBaseUrl;

  const res = await fetch(`${baseUrl}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: args.prompt,
      // Field is `previous_response_id` (snake_case) — that's the upstream
      // OpenRAG schema, not a typo on our end.
      previous_response_id: args.previousResponseId ?? undefined,
      stream: false,
      limit: args.limit ?? 8,
    }),
    // Cold cache + slow LLM + Docker DNS hops can push past 30s. 120s is
    // the upper bound we'll wait before failing fast.
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `OpenRAG chat failed (${res.status}): ${body.slice(0, 500)}`,
    );
  }
  const json = (await res.json()) as {
    response: string;
    response_id: string;
  };
  return { response: json.response, responseId: json.response_id };
}
