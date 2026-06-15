// ============================================================================
// /api/notebooks/[id]/conversations/[convId] — delete a conversation thread
// ============================================================================
//
// _Basically_, the delete button in the conversation switcher calls DELETE
// here. We remove the conversation's messages first, then the conversation
// row itself (SQLite doesn't cascade from conversations → messages because
// messages are still foreign-keyed to notebooks, not conversations).
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
import db, { Conversation } from "@/lib/db";

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

    const replacement = db
      .prepare("SELECT * FROM conversations WHERE id = ?")
      .get(newId) as Conversation;
    return NextResponse.json({ conversation: replacement });
  }

  // Normal delete: remove the messages then the conversation row.
  db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(convId);
  db.prepare("DELETE FROM conversations WHERE id = ?").run(convId);
  return NextResponse.json({ ok: true });
}
