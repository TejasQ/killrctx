// ============================================================================
// /api/notebooks/[id]/chat — send a message, get an answer
// ============================================================================
//
// _Basically_, the chat panel POSTs `{ content }` here. We:
//   1. Save the user turn so the UI re-renders it immediately on next refresh.
//   2. Look up the last assistant `response_id` so OpenRAG can thread the
//      conversation (no need to resend the full history).
//   3. Frame the user's prompt with a "use the retrieval tool first"
//      instruction (see below for *why* — this is the trick that makes
//      "explain" actually search the documents).
//   4. Call OpenRAG, save the assistant turn with its response_id, return
//      the answer.
//
// The framing trick deserves its own paragraph:
//   OpenRAG's agent has an internal system prompt with rules like "use
//   OpenSearch when the user references team names, product names, ...". A
//   one-word prompt like "explain" matches none of those rules, so the
//   agent skips retrieval and asks a clarifying question — *even when the
//   user has uploaded a paper*. We fix this by wrapping every prompt (when
//   the notebook has at least one document) with an explicit "retrieve from
//   the user's uploaded documents and cite filenames" directive. The agent
//   then always retrieves.
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import { v4 as uuid } from "uuid";
import db, { Notebook, Message } from "@/lib/db";
import { chat } from "@/lib/openrag";

export const runtime = "nodejs";

/**
 * POST /api/notebooks/[id]/chat
 * Body: { content: string }
 * Response: { answer: string } | { error: string } (502 on backend failure)
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const { content } = (await req.json()) as { content?: string };
  if (!content?.trim()) {
    return NextResponse.json({ error: "empty" }, { status: 400 });
  }

  const notebook = db
    .prepare("SELECT * FROM notebooks WHERE id = ?")
    .get(id) as Notebook | undefined;
  if (!notebook) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Find the most recent assistant turn with a response_id; that's what we
  // hand back to OpenRAG so it can pick up where the conversation left off.
  // If there's no prior assistant turn yet, this is the first message and
  // we send `previousResponseId: null`.
  const lastAssistant = db
    .prepare(
      "SELECT response_id FROM messages WHERE notebook_id = ? AND role = 'assistant' AND response_id IS NOT NULL ORDER BY created_at DESC LIMIT 1",
    )
    .get(id) as Pick<Message, "response_id"> | undefined;

  // Persist the user turn first so even if the OpenRAG call fails, the user
  // sees their own message in the transcript. (We could move this after the
  // success-path to keep transcripts "clean", but feedback wins.)
  db.prepare(
    "INSERT INTO messages (id, notebook_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(uuid(), id, "user", content, Date.now());

  // The "force retrieval" framing — see file header for the why. We only
  // wrap when there's actually something to retrieve; for an empty notebook
  // we send the prompt as-is so the agent can have a normal conversation
  // ("how do I add sources?" etc).
  const docCount = (
    db
      .prepare("SELECT COUNT(*) AS n FROM documents WHERE notebook_id = ?")
      .get(id) as { n: number }
  ).n;
  const grounded =
    docCount > 0
      ? `Use the OpenSearch Retrieval tool to find passages from the user's uploaded documents that answer the question below, then answer using only those passages and cite filenames inline. If the documents do not contain an answer, say so explicitly.\n\nUser question: ${content}`
      : content;

  let answer: string;
  let responseId: string;
  try {
    const r = await chat({
      prompt: grounded,
      previousResponseId: lastAssistant?.response_id ?? null,
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
    "INSERT INTO messages (id, notebook_id, role, content, response_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(uuid(), id, "assistant", answer, responseId, Date.now());

  return NextResponse.json({ answer });
}
