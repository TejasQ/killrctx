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
import { getBackend } from "@/lib/rag";

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

  const notebook = db
    .prepare("SELECT * FROM notebooks WHERE id = ?")
    .get(id) as Notebook | undefined;

  // Drop the SQLite pointer first — even if backend cleanup fails, the
  // user-visible source list reflects the user's intent.
  db.prepare("DELETE FROM documents WHERE id = ?").run(docId);

  // Backend cleanup (best-effort).
  try {
    if (notebook?.rag_backend === "workbench") {
      const rag = getBackend("workbench");
      await rag.deleteDocument(doc.filename, notebook);
    } else {
      await deleteDocument(doc.filename);
    }
  } catch {
    // Swallow — the row is already gone from our table.
  }

  // Filter sync (OpenRAG only — Workbench KBs are self-scoped).
  if (notebook?.rag_backend !== "workbench" && notebook?.openrag_filter_id) {
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
