// ============================================================================
// /api/notebooks — list and create notebooks
// ============================================================================
//
// _Basically_, the home page calls GET to render its list and POST to create
// a new notebook before navigating to /notebooks/<id>.
//
// We mint a `openrag_collection` string per notebook (`nb_<uuid-no-dashes>`)
// even though OpenRAG doesn't currently use it — see lib/openrag.ts for the
// "all-documents-in-one-index" caveat. Storing it now means we can flip on
// /knowledge-filter later without a schema migration.
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import { v4 as uuid } from "uuid";
import db, { Notebook } from "@/lib/db";

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

  db.prepare(
    "INSERT INTO notebooks (id, title, created_at, openrag_collection) VALUES (?, ?, ?, ?)",
  ).run(id, title?.trim() || "Untitled notebook", Date.now(), collection);

  const nb = db
    .prepare("SELECT * FROM notebooks WHERE id = ?")
    .get(id) as Notebook;
  return NextResponse.json({ notebook: nb });
}
