// ============================================================================
// /api/notebooks/[id]/chat — send a message, stream the answer back
// ============================================================================
//
// _Basically_, the chat panel POSTs `{ content }` here and we stream the
// OpenRAG response back as Server-Sent Events so tokens appear as they
// arrive — no waiting for the full response before rendering begins.
//
// Flow:
//   1. Validate the request and look up the notebook + conversation.
//   2. Persist the user turn immediately (so it survives even if streaming fails).
//   3. Rename the conversation on the first message (same as before).
//   4. Open a streaming chat call to OpenRAG via chatStream().
//   5. Forward each "content" delta as an SSE `data` line.
//   6. On "done", persist the assembled assistant turn to SQLite and send a
//      final SSE event carrying the conversationTitle (if this was turn 1).
//   7. Close the stream.
//
// SSE event format (newline-delimited JSON in the `data:` field):
//   data: {"type":"delta","text":"hello"}
//   data: {"type":"done","conversationTitle":"…"}   ← only on first turn
//   data: {"type":"error","error":"…"}              ← on OpenRAG failure
//
// Why not a regular JSON response?
//   The chat route used to await the full OpenRAG response (~5–20 s for long
//   answers) before sending anything. Streaming lets the UI render tokens
//   live, which feels much faster even when total latency is unchanged.
// ============================================================================

import { NextRequest } from "next/server";
import { v4 as uuid } from "uuid";
import db, { Notebook, Message, buildQueryConfig } from "@/lib/db";
import { chatStream } from "@/lib/openrag";

export const runtime = "nodejs";

/**
 * POST /api/notebooks/[id]/chat
 * Body: { content: string; conversationId: string; selectedFilenames?: string[] }
 * Response: text/event-stream — SSE deltas then a final "done" or "error" event
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const { content, conversationId, selectedFilenames } = (await req.json()) as {
    content?: string;
    conversationId?: string;
    selectedFilenames?: string[];
  };

  if (!content?.trim()) {
    return new Response(JSON.stringify({ error: "empty" }), { status: 400 });
  }
  if (!conversationId?.trim()) {
    return new Response(JSON.stringify({ error: "conversationId is required" }), { status: 400 });
  }

  const notebook = db
    .prepare("SELECT * FROM notebooks WHERE id = ?")
    .get(id) as Notebook | undefined;
  if (!notebook) {
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  }

  const conversation = db
    .prepare("SELECT id FROM conversations WHERE id = ? AND notebook_id = ?")
    .get(conversationId, id);
  if (!conversation) {
    return new Response(JSON.stringify({ error: "conversation not found" }), { status: 404 });
  }

  const lastAssistant = db
    .prepare(
      `SELECT response_id FROM messages
       WHERE notebook_id = ? AND conversation_id = ?
         AND role = 'assistant' AND response_id IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(id, conversationId) as Pick<Message, "response_id"> | undefined;

  // Persist the user turn before streaming starts — even if the stream fails
  // the user sees their own message in the transcript.
  db.prepare(
    "INSERT INTO messages (id, notebook_id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(uuid(), id, conversationId, "user", content, Date.now());

  // On the first message, rename the conversation to the first 50 chars of content.
  const msgCount = (
    db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?")
      .get(conversationId) as { n: number }
  ).n;
  let updatedTitle: string | null = null;
  if (msgCount === 1) {
    const raw = content.trim();
    const titleFromContent = raw.length > 50 ? raw.slice(0, 47) + "…" : raw;
    db.prepare("UPDATE conversations SET title = ? WHERE id = ?").run(
      titleFromContent,
      conversationId,
    );
    updatedTitle = titleFromContent;
  }

  const qc = buildQueryConfig(notebook, selectedFilenames);

  // Light nudge only for the no-filter fallback path — same logic as before.
  const grounded =
    !qc.filterId && qc.sourcePaths
      ? `Search the uploaded documents and answer the following question based on what you find. Cite filenames inline where relevant.\n\nUser question: ${content}`
      : content;

  // Build the SSE stream and return it immediately so the browser can start
  // receiving tokens while OpenRAG is still generating.
  const stream = new ReadableStream({
    async start(controller) {
      function send(obj: Record<string, unknown>) {
        controller.enqueue(`data: ${JSON.stringify(obj)}\n\n`);
      }

      try {
        const events = await chatStream({
          prompt: grounded,
          previousResponseId: lastAssistant?.response_id ?? null,
          ...qc,
        });

        let assembled = "";
        let responseId = "";

        for await (const event of events) {
          if (event.type === "content") {
            assembled += event.delta;
            send({ type: "delta", text: event.delta });
          } else if (event.type === "done") {
            responseId = event.chatId ?? "";
          }
          // "sources" events are ignored — we don't surface sources in the UI yet.
        }

        // Persist the completed assistant turn to SQLite.
        db.prepare(
          "INSERT INTO messages (id, notebook_id, conversation_id, role, content, response_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run(uuid(), id, conversationId, "assistant", assembled, responseId, Date.now());

        console.log("[openrag] chat.stream ← responseId:", responseId, "  responseLength:", assembled.length);

        // Signal completion. Include the new conversation title only on turn 1.
        send({ type: "done", ...(updatedTitle ? { conversationTitle: updatedTitle } : {}) });
      } catch (err) {
        send({ type: "error", error: err instanceof Error ? err.message : "chat failed" });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
