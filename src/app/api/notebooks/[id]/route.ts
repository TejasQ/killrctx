// ============================================================================
// /api/notebooks/[id] — read, rename, or delete a single notebook
// ============================================================================
//
// _Basically_, the notebook page makes one GET to this route on mount (and
// every time something might have changed: an upload finishes, a chat reply
// lands, a podcast transitions states). The response bundles everything the
// UI needs in one round-trip — notebook metadata, documents, conversations,
// messages, notes — so we don't have a waterfall of separate fetches.
//
// Why a single fat endpoint instead of many small ones?
//   The page is dense and re-fetches frequently. Bundling cuts client-side
//   latency, eliminates intermediate loading states, and keeps the polling
//   loop (for in-progress podcasts) to one network call per tick.
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import db, { Notebook, Document, Message, Note, Conversation } from "@/lib/db";
import { getTaskStatus, getFilterMeta, deleteFilter, deleteDocument, deleteConversation } from "@/lib/openrag";

export const runtime = "nodejs";

/**
 * GET /api/notebooks/[id]
 *
 * Returns the notebook plus every related row in a single payload. Sort
 * orders are chosen for the UI:
 *   - documents:      newest first (most recently uploaded sits at the top)
 *   - conversations:  oldest first (stable list order for the switcher)
 *   - messages:       oldest first (chat reads top-to-bottom)
 *   - notes:          newest first (latest note shows at the top of Studio)
 */
export async function GET(
  _: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;

  const notebook = db
    .prepare("SELECT * FROM notebooks WHERE id = ?")
    .get(id) as Notebook | undefined;
  if (!notebook) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const documents = db
    .prepare(
      "SELECT * FROM documents WHERE notebook_id = ? ORDER BY created_at DESC",
    )
    .all(id) as Document[];
  const conversations = db
    .prepare(
      "SELECT * FROM conversations WHERE notebook_id = ? ORDER BY created_at ASC",
    )
    .all(id) as Conversation[];
  const messages = db
    .prepare(
      "SELECT * FROM messages WHERE notebook_id = ? ORDER BY created_at ASC",
    )
    .all(id) as Message[];
  const notes = db
    .prepare(
      "SELECT * FROM notes WHERE notebook_id = ? ORDER BY created_at DESC",
    )
    .all(id) as Note[];

  // For each document still marked 'indexing', fire a background status check
  // against OpenRAG and update SQLite so the next poll sees the new state.
  // Void — we don't wait for these; the client will pick up the result on its
  // next 3s refresh. Same fire-and-forget pattern as podcast generation.
  for (const doc of documents) {
    if (doc.ingest_status === "indexing" && doc.openrag_id) {
      void (async () => {
        try {
          const { status, error } = await getTaskStatus(doc.openrag_id!);
          if (status !== "indexing") {
            db.prepare("UPDATE documents SET ingest_status = ?, ingest_error = ? WHERE id = ?")
              .run(status, error, doc.id);
          }
        } catch {
          // OpenRAG unreachable — leave status as 'indexing', retry next poll.
        }
      })();
    }
  }

  // Fetch the filter's current icon and color from OpenRAG inline so the
  // client always sees the latest values the user set in OpenRAG's own UI.
  //
  // Why not fire-and-forget like the ingest-status poller?
  //   The ingest poller works because the page keeps polling until all
  //   documents are ready. Icon/color can change at any time with no active
  //   poll — a background write would only be visible on the *next* poll,
  //   which may never come. Fetching inline means every manual refresh (F5,
  //   chat send, upload) picks up the latest visual immediately.
  //
  //   The call is cheap: one small HTTP GET to OpenRAG. If OpenRAG is
  //   unreachable we fall back to the SQLite-cached values so the badge
  //   still renders. We also update SQLite so repeated GETs don't hit
  //   OpenRAG if nothing changed (the client sends the same value back).
  if (notebook.openrag_filter_id) {
    try {
      const meta = await getFilterMeta(notebook.openrag_filter_id);
      if (meta) {
        db.prepare(
          `UPDATE notebooks
           SET openrag_filter_icon = ?, openrag_filter_color = ?,
               openrag_filter_limit = ?, openrag_filter_score_threshold = ?
           WHERE id = ?`,
        ).run(meta.icon, meta.color, meta.limit, meta.scoreThreshold, id);
        // Mutate the already-fetched notebook object so this response
        // carries the fresh values without a second SELECT.
        notebook.openrag_filter_icon = meta.icon;
        notebook.openrag_filter_color = meta.color;
        notebook.openrag_filter_limit = meta.limit;
        notebook.openrag_filter_score_threshold = meta.scoreThreshold;
      }
    } catch {
      // OpenRAG unreachable — serve the SQLite-cached values as fallback.
    }
  }

  return NextResponse.json({ notebook, documents, conversations, messages, notes });
}

/**
 * PATCH /api/notebooks/[id]
 *
 * Body: { title: string }
 *
 * Renames the notebook. Returns the updated row.
 */
export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const { title } = (await req.json()) as { title?: string };
  const trimmed = title?.trim();
  if (!trimmed) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }

  const notebook = db
    .prepare("SELECT * FROM notebooks WHERE id = ?")
    .get(id) as Notebook | undefined;
  if (!notebook) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  db.prepare("UPDATE notebooks SET title = ? WHERE id = ?").run(trimmed, id);
  const updated = db
    .prepare("SELECT * FROM notebooks WHERE id = ?")
    .get(id) as Notebook;
  return NextResponse.json({ notebook: updated });
}

/**
 * DELETE /api/notebooks/[id]
 *
 * Cleans up all OpenRAG resources for the notebook (filter, document chunks,
 * chat threads from messages + notes) then drops the SQLite row. The schema's
 * `ON DELETE CASCADE` foreign keys handle child rows automatically.
 *
 * All OpenRAG deletions run in parallel via Promise.allSettled — failures are
 * swallowed so the SQLite delete always fires even when OpenRAG is unreachable.
 */
export async function DELETE(
  _: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;

  const notebook = db
    .prepare("SELECT * FROM notebooks WHERE id = ?")
    .get(id) as Notebook | undefined;

  if (notebook) {
    const documents = db
      .prepare("SELECT filename FROM documents WHERE notebook_id = ?")
      .all(id) as Pick<Document, "filename">[];

    // Collect every response_id that represents an OpenRAG chat thread —
    // both message threads (one per conversation) and note threads.
    const msgResponseIds = db
      .prepare(
        `SELECT DISTINCT response_id FROM messages
         WHERE notebook_id = ? AND response_id IS NOT NULL`,
      )
      .all(id) as { response_id: string }[];
    const noteResponseIds = db
      .prepare(
        "SELECT response_id FROM notes WHERE notebook_id = ? AND response_id IS NOT NULL",
      )
      .all(id) as { response_id: string }[];

    const cleanupTasks: Promise<unknown>[] = [];

    if (notebook.openrag_filter_id) {
      cleanupTasks.push(deleteFilter(notebook.openrag_filter_id));
    }
    for (const { filename } of documents) {
      cleanupTasks.push(deleteDocument(filename));
    }
    for (const { response_id } of [...msgResponseIds, ...noteResponseIds]) {
      cleanupTasks.push(deleteConversation(response_id));
    }

    // allSettled — never throws; we don't care which individual steps failed.
    await Promise.allSettled(cleanupTasks);
  }

  db.prepare("DELETE FROM notebooks WHERE id = ?").run(id);
  return NextResponse.json({ ok: true });
}
