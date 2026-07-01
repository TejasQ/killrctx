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

import { NextRequest, NextResponse } from "next/server";
import { v4 as uuid } from "uuid";
import db, { Conversation, Message, Notebook } from "@/lib/db";
import { deleteConversation as deleteOpenRagConversation } from "@/lib/openrag";
import { getBackend } from "@/lib/rag";

export const runtime = "nodejs";

/**
 * PATCH /api/notebooks/[id]/conversations/[convId]
 *
 * Body: { workbench_agent_id: string }
 *
 * Changes the Workbench agent bound to this conversation. Does not touch
 * the existing Workbench conversation thread — just updates the stored
 * agent ID so the next message uses the new agent.
 */
export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; convId: string }> },
) {
  const { convId } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { workbench_agent_id?: string };
  if (!body.workbench_agent_id) {
    return NextResponse.json({ error: "workbench_agent_id is required" }, { status: 400 });
  }
  const updated = db.prepare(
    "UPDATE conversations SET workbench_agent_id = ? WHERE id = ?",
  ).run(body.workbench_agent_id, convId);
  if (updated.changes === 0) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

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

  const notebook = db
    .prepare("SELECT * FROM notebooks WHERE id = ?")
    .get(id) as Notebook | undefined;
  const isWorkbench = notebook?.rag_backend === "workbench";

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

  // Helper: clean up the backend conversation thread (best-effort).
  async function cleanupBackendThread() {
    try {
      if (isWorkbench && conversation!.workbench_conversation_id && notebook) {
        const rag = getBackend("workbench");
        await rag.deleteConversation(conversation!.workbench_conversation_id, notebook);
      } else if (!isWorkbench && lastAssistant?.response_id) {
        await deleteOpenRagConversation(lastAssistant.response_id);
      }
    } catch {
      // Backend unreachable or thread already gone — not a hard failure.
    }
  }

  if (totalConvs === 1) {
    // Last conversation — reset in-place rather than delete.
    db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(convId);
    db.prepare("DELETE FROM conversations WHERE id = ?").run(convId);

    await cleanupBackendThread();

    const newId = uuid();
    if (isWorkbench && notebook) {
      const agentId = conversation.workbench_agent_id ?? process.env.WORKBENCH_DEFAULT_AGENT_ID ?? "";
      const rag = getBackend("workbench");
      try {
        const { conversationId } = await rag.createConversation({
          notebook,
          agentId,
          title: "Conversation 1",
        });
        db.prepare(
          "INSERT INTO conversations (id, notebook_id, title, created_at, workbench_agent_id, workbench_conversation_id) VALUES (?, ?, 'Conversation 1', ?, ?, ?)",
        ).run(newId, id, Date.now(), agentId, conversationId);
      } catch {
        db.prepare(
          "INSERT INTO conversations (id, notebook_id, title, created_at, workbench_agent_id) VALUES (?, ?, 'Conversation 1', ?, ?)",
        ).run(newId, id, Date.now(), agentId);
      }
    } else {
      db.prepare(
        "INSERT INTO conversations (id, notebook_id, title, created_at) VALUES (?, ?, 'Conversation 1', ?)",
      ).run(newId, id, Date.now());
    }

    const replacement = db
      .prepare("SELECT * FROM conversations WHERE id = ?")
      .get(newId) as Conversation;
    return NextResponse.json({ conversation: replacement });
  }

  // Normal delete: remove the messages then the conversation row.
  db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(convId);
  db.prepare("DELETE FROM conversations WHERE id = ?").run(convId);

  await cleanupBackendThread();

  return NextResponse.json({ ok: true });
}
