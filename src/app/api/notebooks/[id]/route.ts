// ============================================================================
// /api/notebooks/[id] — read or delete a single notebook (with everything in it)
// ============================================================================
//
// _Basically_, the notebook page makes one GET to this route on mount (and
// every time something might have changed: an upload finishes, a chat reply
// lands, a podcast transitions states). The response bundles everything the
// UI needs in one round-trip — notebook metadata, documents, messages,
// podcasts — so we don't have a waterfall of four separate fetches.
//
// Why a single fat endpoint instead of four small ones?
//   The page is dense and re-fetches frequently. Bundling cuts client-side
//   latency, eliminates intermediate loading states, and keeps the polling
//   loop (for in-progress podcasts) to one network call per tick.
// ============================================================================

import { NextResponse } from "next/server";
import db, { Notebook, Document, Message, Podcast } from "@/lib/db";

export const runtime = "nodejs";

/**
 * GET /api/notebooks/[id]
 *
 * Returns the notebook plus every related row in a single payload. Sort
 * orders are chosen for the UI:
 *   - documents: newest first (most recently uploaded sits at the top of
 *     the Sources panel)
 *   - messages:  oldest first (chat reads top-to-bottom)
 *   - podcasts:  newest first (latest episode shows at the top of Studio)
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
  const messages = db
    .prepare(
      "SELECT * FROM messages WHERE notebook_id = ? ORDER BY created_at ASC",
    )
    .all(id) as Message[];
  const podcasts = db
    .prepare(
      "SELECT * FROM podcasts WHERE notebook_id = ? ORDER BY created_at DESC",
    )
    .all(id) as Podcast[];

  return NextResponse.json({ notebook, documents, messages, podcasts });
}

/**
 * DELETE /api/notebooks/[id]
 *
 * Drops the notebook row; the schema's `ON DELETE CASCADE` foreign keys
 * clean up documents, messages and podcasts automatically. Note this only
 * cleans up *our* SQLite — the OpenSearch vectors still exist (we don't
 * have a "delete by notebook" path on the OpenRAG side yet).
 */
export async function DELETE(
  _: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  db.prepare("DELETE FROM notebooks WHERE id = ?").run(id);
  return NextResponse.json({ ok: true });
}
