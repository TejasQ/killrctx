// ============================================================================
// /api/notebooks/[id]/notes/mindmap — generate a Mind Map note
// ============================================================================
//
// _Basically_, POSTing here asks OpenRAG to produce a hierarchical mind map
// of the notebook's sources and saves it as a note row. Each note type has
// its own route so the pipeline stays self-contained.
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import { v4 as uuid } from "uuid";
import db, { Notebook, Note } from "@/lib/db";
import { generateNote } from "@/lib/openrag";

export const runtime = "nodejs";

/** POST /api/notebooks/[id]/notes/mindmap */
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

  const { content, responseId } = await generateNote({ type: "mindmap", topic, filterId: notebook.openrag_filter_id ?? null });
  const now = Date.now();
  const noteId = uuid();
  db.prepare(
    "INSERT INTO notes (id, notebook_id, type, title, content, response_id, created_at) VALUES (?, ?, 'mindmap', ?, ?, ?, ?)",
  ).run(noteId, id, title?.trim() || `Mind Map ${new Date(now).toLocaleDateString()}`, content, responseId, now);

  const note = db.prepare("SELECT * FROM notes WHERE id = ?").get(noteId) as Note;
  return NextResponse.json({ note });
}
