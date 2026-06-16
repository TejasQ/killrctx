// ============================================================================
// /api/notebooks/[id]/notes/[noteId] — delete a single note
// ============================================================================
//
// _Basically_, a thin DELETE handler for any note type — podcast, summary,
// mindmap, outline, or qa. The UI calls this when the user hits the delete
// button on a note card. Each note type generates through its own route;
// they all share this one deletion endpoint since the operation is identical
// regardless of type.
//
// OpenRAG cleanup: text-based notes store the responseId from the generating
// chat() call in the `response_id` column. We delete the OpenRAG thread
// best-effort before removing the SQLite row — same pattern as conversation
// deletion in conversations/[convId]/route.ts. Podcast notes don't have a
// response_id (their pipeline uses a separate chat thread per podcast run,
// not stored here), so the cleanup is a no-op for them.
// ============================================================================

import { NextResponse } from "next/server";
import db, { Note } from "@/lib/db";
import { deleteConversation } from "@/lib/openrag";

export const runtime = "nodejs";

/** DELETE /api/notebooks/[id]/notes/[noteId] */
export async function DELETE(
  _: Request,
  ctx: { params: Promise<{ noteId: string }> },
) {
  const { noteId } = await ctx.params;

  const note = db.prepare("SELECT * FROM notes WHERE id = ?").get(noteId) as Note | undefined;
  if (!note) {
    return NextResponse.json({ ok: true }); // already gone — idempotent
  }

  db.prepare("DELETE FROM notes WHERE id = ?").run(noteId);

  // Clean up the OpenRAG thread best-effort. Notes that never had a response_id
  // (e.g. podcast rows) or where OpenRAG is unreachable are silently skipped.
  if (note.response_id) {
    try {
      await deleteConversation(note.response_id);
    } catch {
      // OpenRAG unreachable or thread already gone — not a hard failure.
    }
  }

  return NextResponse.json({ ok: true });
}
