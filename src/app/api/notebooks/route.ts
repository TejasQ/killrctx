// ============================================================================
// /api/notebooks — list and create notebooks
// ============================================================================
//
// _Basically_, the home page calls GET to render its list and POST to create
// a new notebook before navigating to /notebooks/<id>.
//
// On creation we also create an OpenRAG knowledge filter for the notebook so
// every chat, note, and podcast call can scope retrieval to only this
// notebook's documents. The filter ID + name are stored in SQLite so the UI
// can display the filter chip without a round-trip to OpenRAG.
//
// Filter creation is best-effort — if OpenRAG is down the notebook is still
// created; the document ingest route will retry (see documents/route.ts).
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import { v4 as uuid } from "uuid";
import db, { Notebook } from "@/lib/db";
import { createFilter } from "@/lib/openrag";

// Force Node.js runtime — better-sqlite3 is a native module and won't load
// under the Edge runtime.
export const runtime = "nodejs";

/** GET /api/notebooks — newest first, used by the home-page card grid. */
export async function GET() {
  const rows = db
    .prepare("SELECT * FROM notebooks ORDER BY created_at DESC")
    .all() as Notebook[];
  return NextResponse.json({ notebooks: rows });
}

/**
 * POST /api/notebooks — create a notebook.
 *
 * Body: { title?: string }   (defaults to "Untitled notebook")
 *
 * Returns the freshly-inserted row so the client can navigate straight to it
 * without a follow-up GET.
 */
export async function POST(req: NextRequest) {
  const { title } = (await req.json()) as { title?: string };

  const id = uuid();
  // `nb_<id>` form is reserved for future OpenRAG /knowledge-filter
  // partitioning. Right now nothing reads this field.
  const collection = `nb_${id.replace(/-/g, "")}`;

  const resolvedTitle = title?.trim() || "Untitled notebook";
  const now = Date.now();
  db.prepare(
    "INSERT INTO notebooks (id, title, created_at, openrag_collection) VALUES (?, ?, ?, ?)",
  ).run(id, resolvedTitle, now, collection);

  // Seed a default conversation so the Chat panel always has an activeConvId.
  const convId = uuid();
  db.prepare(
    "INSERT INTO conversations (id, notebook_id, title, created_at) VALUES (?, ?, ?, ?)",
  ).run(convId, id, "Conversation 1", now);

  // Create the OpenRAG knowledge filter. Best-effort — if OpenRAG is unreachable
  // the notebook row already exists; the ingest route will retry on first upload.
  try {
    const { filterId, filterName } = await createFilter(resolvedTitle);
    db.prepare(
      "UPDATE notebooks SET openrag_filter_id = ?, openrag_filter_name = ? WHERE id = ?",
    ).run(filterId, filterName, id);
  } catch {
    // OpenRAG down at creation time — filter columns stay NULL.
  }

  const nb = db
    .prepare("SELECT * FROM notebooks WHERE id = ?")
    .get(id) as Notebook;
  return NextResponse.json({ notebook: nb });
}
