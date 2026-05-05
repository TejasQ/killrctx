// ============================================================================
// /api/notebooks/[id]/documents/[docId] — delete one source
// ============================================================================
//
// _Basically_, the 3-dot menu in the Sources panel calls DELETE here. We
// remove the row from our SQLite *and* ask OpenRAG to drop the corresponding
// chunks from OpenSearch so the chat agent doesn't keep retrieving from a
// document the user thinks they removed.
//
// The OpenRAG cleanup uses /documents/delete-by-filename — that endpoint
// removes every chunk whose `filename` field matches. It's an imperfect
// match (two documents with the same filename in the same notebook would
// both get nuked), but the upstream backend doesn't expose a per-id delete.
// Fine for a single-user app.
// ============================================================================

import { NextResponse } from "next/server";
import db, { Document } from "@/lib/db";

export const runtime = "nodejs";

const baseUrl = process.env.OPENRAG_URL ?? "http://localhost:8000";

/** DELETE /api/notebooks/[id]/documents/[docId] */
export async function DELETE(
  _: Request,
  ctx: { params: Promise<{ id: string; docId: string }> },
) {
  const { id, docId } = await ctx.params;

  const doc = db
    .prepare("SELECT * FROM documents WHERE id = ? AND notebook_id = ?")
    .get(docId, id) as Document | undefined;
  if (!doc) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Drop the SQLite pointer first — even if OpenRAG cleanup fails, the
  // user-visible source list reflects the user's intent. OpenRAG cleanup is
  // best-effort.
  db.prepare("DELETE FROM documents WHERE id = ?").run(docId);

  try {
    await fetch(`${baseUrl}/documents/delete-by-filename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: doc.filename }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    // Swallow — the row is already gone from our table; the chunks linger
    // until next OpenRAG restart at worst. Not a hard failure.
  }

  return NextResponse.json({ ok: true });
}
