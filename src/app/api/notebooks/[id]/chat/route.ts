// ============================================================================
// /api/notebooks/[id]/chat — send a message, get an answer
// ============================================================================
//
// _Basically_, the chat panel POSTs `{ content }` here. We:
//   1. Save the user turn so the UI re-renders it immediately on next refresh.
//   2. If this is the first message in the conversation, rename it to the
//      first 50 chars of the user's raw content — so our switcher title
//      matches what OpenRAG shows on their side (OpenRAG titles threads from
//      the first message it receives; ours should agree).
//   3. Look up the last assistant `response_id` so OpenRAG can thread the
//      conversation (no need to resend the full history).
//   4. Send the prompt. When a knowledge filter is active (the normal case),
//      the user's message goes as-is — the filter tells OpenRAG's agent which
//      documents to search, so no extra wrapping is needed or wanted.
//   5. Call OpenRAG, save the assistant turn with its response_id, return
//      the answer (plus the updated conversation title if it changed).
//
// Why we stopped wrapping the prompt:
//   We used to prepend "Use the OpenSearch Retrieval tool…Do NOT use general
//   knowledge" to every message. That worked before filters existed, but once
//   a filterId is in play the OpenRAG agent retrieves automatically. The hard
//   constraint caused the agent to refuse ("No relevant sources found") when
//   its internal confidence was below its own threshold — even when it had
//   relevant docs. Lesson: don't fight the agent when the filter is doing its
//   job. A light nudge is kept only for the rare no-filter fallback path.
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import { v4 as uuid } from "uuid";
import db, { Notebook, Message, buildQueryConfig } from "@/lib/db";
import { chat } from "@/lib/openrag";

export const runtime = "nodejs";

/**
 * POST /api/notebooks/[id]/chat
 * Body: { content: string; conversationId: string }
 * Response: { answer: string } | { error: string } (502 on backend failure)
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const { content, conversationId, selectedFilenames } = (await req.json()) as {
    content?: string;
    conversationId?: string;
    /** Filenames the user has checked in the Sources panel. When present,
     *  scope retrieval to only those files. When absent, use all ready docs. */
    selectedFilenames?: string[];
  };
  if (!content?.trim()) {
    return NextResponse.json({ error: "empty" }, { status: 400 });
  }
  if (!conversationId?.trim()) {
    return NextResponse.json({ error: "conversationId is required" }, { status: 400 });
  }

  const notebook = db
    .prepare("SELECT * FROM notebooks WHERE id = ?")
    .get(id) as Notebook | undefined;
  if (!notebook) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Guard: verify the conversation belongs to this notebook so a caller
  // can't insert messages or rename conversations in a different notebook.
  const conversation = db
    .prepare("SELECT id FROM conversations WHERE id = ? AND notebook_id = ?")
    .get(conversationId, id);
  if (!conversation) {
    return NextResponse.json({ error: "conversation not found" }, { status: 404 });
  }

  // Find the most recent assistant turn *in this conversation* with a
  // response_id — that's what we hand to OpenRAG to continue the thread.
  // Scoping to conversation_id means two conversations in the same notebook
  // each have independent OpenRAG threading.
  const lastAssistant = db
    .prepare(
      `SELECT response_id FROM messages
       WHERE notebook_id = ? AND conversation_id = ?
         AND role = 'assistant' AND response_id IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(id, conversationId) as Pick<Message, "response_id"> | undefined;

  // Persist the user turn first so even if the OpenRAG call fails, the user
  // sees their own message in the transcript. (We could move this after the
  // success-path to keep transcripts "clean", but feedback wins.)
  db.prepare(
    "INSERT INTO messages (id, notebook_id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(uuid(), id, conversationId, "user", content, Date.now());

  // If this is the first message in the conversation, rename it from the
  // auto-generated "Conversation N" to the first 50 chars of the user's raw
  // content. We check for exactly 1 message (the one we just inserted).
  // `updatedTitle` is returned to the client so the switcher updates live.
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

  const qc = buildQueryConfig(id, notebook, selectedFilenames);

  // When a filter is active the OpenRAG agent retrieves automatically — no
  // prompt wrapping needed. Light nudge only for the no-filter fallback path.
  const grounded =
    !qc.filterId && qc.sourcePaths
      ? `Search the uploaded documents and answer the following question based on what you find. Cite filenames inline where relevant.\n\nUser question: ${content}`
      : content;

  let answer: string;
  let responseId: string;
  try {
    const r = await chat({
      prompt: grounded,
      previousResponseId: lastAssistant?.response_id ?? null,
      ...qc,
    });
    answer = r.response;
    responseId = r.responseId;
  } catch (err) {
    // 502 (Bad Gateway) is the right status here — *we* are reachable but
    // our upstream (OpenRAG) failed. The client surfaces the error as a
    // red banner in the chat input.
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "chat failed" },
      { status: 502 },
    );
  }

  db.prepare(
    "INSERT INTO messages (id, notebook_id, conversation_id, role, content, response_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(uuid(), id, conversationId, "assistant", answer, responseId, Date.now());

  // Include the updated title only on the first message — the client uses it
  // to refresh the conversation switcher label without a full refresh.
  return NextResponse.json({ answer, ...(updatedTitle ? { conversationTitle: updatedTitle } : {}) });
}
