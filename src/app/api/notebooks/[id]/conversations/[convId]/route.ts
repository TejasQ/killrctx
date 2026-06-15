// ============================================================================
// /api/notebooks/[id]/conversations/[convId] — delete a conversation thread
// ============================================================================
//
// _Basically_, the delete button in the conversation switcher calls DELETE
// here. We:
//   1. Look up the last assistant response_id for this conversation — that is
//      the OpenRAG chatId we need to clean up on their side.
//   2. Delete the conversation's messages from SQLite, then the conversation
//      row itself (no cascade because messages FK to notebooks, not convs).
//   3. Tell OpenRAG to drop the thread via client.chat.delete(chatId).
//      Best-effort — we swallow errors so SQLite is always cleaned up even
//      if OpenRAG is unreachable.
//
// Last-conversation special case:
//   A notebook must always have at least one conversation — otherwise the
//   Chat panel has nothing to show. If the user deletes the last one, instead
//   of leaving an orphaned notebook we: clear its messages, then reset the
//   conversation row in-place (new id, title "Conversation 1", fresh
//   created_at) and return it as `{ conversation }` so the client knows to
//   switch its activeConvId to the replacement.
//
// Response shapes:
//   Normal delete:        200 { ok: true }
//   Last-conv reset:      200 { conversation: Conversation }
// ============================================================================

import { NextResponse } from "next/server";
import { v4 as uuid } from "uuid";
import db, { Conversation, Message } from "@/lib/db";
import { deleteConversation as deleteOpenRagConversation } from "@/lib/openrag";

export const runtime = "nodejs";

/** DELETE /api/notebooks/[id]/conversations/[convId] */
export async function DELETE(
  _: Request,
  ctx: { params: Promise<{ id: string; convId: string }> },
) {
  const { id, convId } = await ctx.params;

  const conversation = db
    .prepare("SELECT * FROM conversations WHERE id = ? AND notebook_id = ?")
    .get(convId, id) as Conversation | undefined;
  if (!conversation) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Grab the last assistant response_id — this is the OpenRAG chatId for the
  // thread. We read it before deleting messages so it's still available.
  const lastAssistant = db
    .prepare(
      `SELECT response_id FROM messages
       WHERE conversation_id = ? AND role = 'assistant' AND response_id IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(convId) as Pick<Message, "response_id"> | undefined;

  const totalConvs = (
    db
      .prepare("SELECT COUNT(*) AS n FROM conversations WHERE notebook_id = ?")
      .get(id) as { n: number }
  ).n;

  if (totalConvs === 1) {
    // Last conversation — reset in-place rather than delete. Clear the
    // messages, then replace the row with a fresh id and title.
    db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(convId);
    db.prepare("DELETE FROM conversations WHERE id = ?").run(convId);

    const newId = uuid();
    db.prepare(
      "INSERT INTO conversations (id, notebook_id, title, created_at) VALUES (?, ?, 'Conversation 1', ?)",
    ).run(newId, id, Date.now());

    // Clean up the OpenRAG thread best-effort.
    if (lastAssistant?.response_id) {
      try {
        await deleteOpenRagConversation(lastAssistant.response_id);
      } catch {
        // OpenRAG unreachable or thread already gone — not a hard failure.
      }
    }

    const replacement = db
      .prepare("SELECT * FROM conversations WHERE id = ?")
      .get(newId) as Conversation;
    return NextResponse.json({ conversation: replacement });
  }

  // Normal delete: remove the messages then the conversation row.
  db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(convId);
  db.prepare("DELETE FROM conversations WHERE id = ?").run(convId);

  // Clean up the OpenRAG thread best-effort.
  if (lastAssistant?.response_id) {
    try {
      await deleteOpenRagConversation(lastAssistant.response_id);
    } catch {
      // OpenRAG unreachable or thread already gone — not a hard failure.
    }
  }

  return NextResponse.json({ ok: true });
}
