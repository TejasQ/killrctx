// ============================================================================
// /api/notebooks/[id]/conversations — create a new conversation thread
// ============================================================================
//
// _Basically_, the "New conversation" button in the Chat panel POSTs here.
// We insert a row into `conversations` and return it so the client can
// immediately switch the active conversation without a full refresh.
//
// For Workbench notebooks we also create the conversation on the Workbench
// (binding the notebook's KB so the agent can search it).
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import { v4 as uuid } from "uuid";
import db, { Notebook, Conversation } from "@/lib/db";
import { getBackend } from "@/lib/rag";

export const runtime = "nodejs";

/**
 * POST /api/notebooks/[id]/conversations
 *
 * Body: { title?: string, workbench_agent_id?: string }
 * Response: { conversation: Conversation }
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;

  const notebook = db
    .prepare("SELECT * FROM notebooks WHERE id = ?")
    .get(id) as Notebook | undefined;
  if (!notebook) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    title?: string;
    workbench_agent_id?: string;
  };

  // Auto-number the title if none was provided.
  const count = (
    db
      .prepare("SELECT COUNT(*) AS n FROM conversations WHERE notebook_id = ?")
      .get(id) as { n: number }
  ).n;
  const resolvedTitle = body.title?.trim() || `Conversation ${count + 1}`;

  const convId = uuid();

  if (notebook.rag_backend === "workbench") {
    const agentId = body.workbench_agent_id ?? process.env.WORKBENCH_DEFAULT_AGENT_ID ?? "";
    const rag = getBackend("workbench");
    try {
      const { conversationId } = await rag.createConversation({
        notebook,
        agentId,
        title: resolvedTitle,
      });
      db.prepare(
        "INSERT INTO conversations (id, notebook_id, title, created_at, workbench_agent_id, workbench_conversation_id) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(convId, id, resolvedTitle, Date.now(), agentId, conversationId);
    } catch {
      // Workbench unreachable — create the SQLite row without a remote conversation.
      db.prepare(
        "INSERT INTO conversations (id, notebook_id, title, created_at, workbench_agent_id) VALUES (?, ?, ?, ?, ?)",
      ).run(convId, id, resolvedTitle, Date.now(), agentId);
    }
  } else {
    db.prepare(
      "INSERT INTO conversations (id, notebook_id, title, created_at) VALUES (?, ?, ?, ?)",
    ).run(convId, id, resolvedTitle, Date.now());
  }

  const conversation = db
    .prepare("SELECT * FROM conversations WHERE id = ?")
    .get(convId) as Conversation;
  return NextResponse.json({ conversation });
}
