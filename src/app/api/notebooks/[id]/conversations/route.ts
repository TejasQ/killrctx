// ============================================================================
// /api/notebooks/[id]/conversations — create a new conversation thread
// ============================================================================
//
// _Basically_, the "New conversation" button in the Chat panel POSTs here.
// We insert a row into `conversations` and return it so the client can
// immediately switch the active conversation without a full refresh.
//
// Title defaults to "Conversation <n+1>" where n is the current count of
// conversations for this notebook — simple, predictable, no user input needed.
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import { v4 as uuid } from "uuid";
import db, { Notebook, Conversation } from "@/lib/db";

export const runtime = "nodejs";

/**
 * POST /api/notebooks/[id]/conversations
 *
 * Body: { title?: string }  (title defaults to "Conversation <n+1>")
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

  const { title } = (await req.json().catch(() => ({}))) as { title?: string };

  // Auto-number the title if none was provided.
  const count = (
    db
      .prepare("SELECT COUNT(*) AS n FROM conversations WHERE notebook_id = ?")
      .get(id) as { n: number }
  ).n;
  const resolvedTitle = title?.trim() || `Conversation ${count + 1}`;

  const convId = uuid();
  db.prepare(
    "INSERT INTO conversations (id, notebook_id, title, created_at) VALUES (?, ?, ?, ?)",
  ).run(convId, id, resolvedTitle, Date.now());

  const conversation = db
    .prepare("SELECT * FROM conversations WHERE id = ?")
    .get(convId) as Conversation;
  return NextResponse.json({ conversation });
}
