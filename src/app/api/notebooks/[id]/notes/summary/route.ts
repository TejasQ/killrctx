// ============================================================================
// /api/notebooks/[id]/notes/summary — generate a Summary note
// ============================================================================
//
// _Basically_, POSTing here asks OpenRAG to summarise the notebook's sources
// and saves the result as a note row. Each note type has its own route so the
// pipeline for each type stays fully self-contained and new types can be added
// without touching existing ones.
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import { v4 as uuid } from "uuid";
import db, { Notebook, Note } from "@/lib/db";
import { generateNote } from "@/lib/openrag";

export const runtime = "nodejs";

/** POST /api/notebooks/[id]/notes/summary */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const { topic, title } = (await req.json().catch(() => ({}))) as {
    topic?: string;
    title?: string;
  };

  const notebook = db
    .prepare("SELECT * FROM notebooks WHERE id = ?")
    .get(id) as Notebook | undefined;
  if (!notebook) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const { content, responseId } = await generateNote({ type: "summary", topic });
  const now = Date.now();
  const noteId = uuid();
  db.prepare(
    "INSERT INTO notes (id, notebook_id, type, title, content, response_id, created_at) VALUES (?, ?, 'summary', ?, ?, ?, ?)",
  ).run(noteId, id, title?.trim() || `Summary ${new Date(now).toLocaleDateString()}`, content, responseId, now);

  const note = db.prepare("SELECT * FROM notes WHERE id = ?").get(noteId) as Note;
  return NextResponse.json({ note });
}
