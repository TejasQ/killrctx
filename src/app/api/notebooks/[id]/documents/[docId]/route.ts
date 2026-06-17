// ============================================================================
// /api/notebooks/[id]/documents/[docId] — delete one source
// ============================================================================
//
// _Basically_, the 3-dot menu in the Sources panel calls DELETE here. We
// remove the row from our SQLite *and* ask OpenRAG to drop the corresponding
// chunks from OpenSearch so the chat agent doesn't keep retrieving from a
// document the user thinks they removed.
//
// After deletion we also sync the notebook's filter data_sources to the
// remaining documents so the filter stays accurate.
//
// The OpenRAG cleanup uses deleteDocument() from src/lib/openrag.ts, which
// calls client.documents.delete(filename). It removes every chunk whose
// `filename` field matches — an imperfect match (two documents with the same
// filename would both get nuked), but the upstream backend doesn't expose a
// per-id delete. Fine for a single-user app.
// ============================================================================

import { NextResponse } from "next/server";
import db, { Document, Notebook } from "@/lib/db";
import { deleteDocument, scheduleSyncFilterSources } from "@/lib/openrag";

export const runtime = "nodejs";

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
    await deleteDocument(doc.filename);
  } catch {
    // Swallow — the row is already gone from our table; the chunks linger
    // until next OpenRAG restart at worst. Not a hard failure.
  }

  // Schedule a debounced filter sync. Bulk-deletes call this route once per
  // file in quick succession — debouncing means only one get → update fires
  // after all the deletes settle, with the final SQLite state as ground truth.
  const notebook = db
    .prepare("SELECT openrag_filter_id FROM notebooks WHERE id = ?")
    .get(id) as Pick<Notebook, "openrag_filter_id"> | undefined;
  if (notebook?.openrag_filter_id) {
    const filterId = notebook.openrag_filter_id;
    scheduleSyncFilterSources(filterId, () =>
      (db
        .prepare("SELECT filename FROM documents WHERE notebook_id = ?")
        .all(id) as { filename: string }[]
      ).map((r) => r.filename)
    );
  }

  return NextResponse.json({ ok: true });
}
