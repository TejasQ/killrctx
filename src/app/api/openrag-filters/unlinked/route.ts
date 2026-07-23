// ============================================================================
// /api/openrag-filters/unlinked — list OpenRAG filters with no local notebook
// ============================================================================
//
// _Basically_, this route tells the home page which OpenRAG knowledge filters
// exist "out there" but have no corresponding notebook in our SQLite database.
// The home page uses this to offer an import prompt so the user doesn't have
// to re-upload documents they already ingested directly in OpenRAG.
//
// Returns { filters: [] } on any OpenRAG error so the UI degrades silently —
// the home page simply shows no import prompt rather than an error banner.
// ============================================================================

import { NextResponse } from "next/server";
import db, { Notebook } from "@/lib/db";
import { listFilters } from "@/lib/openrag";

export const runtime = "nodejs";

export async function GET() {
  // Collect every filter ID that already has a local notebook.
  const linked = new Set(
    (db.prepare("SELECT openrag_filter_id FROM notebooks WHERE openrag_filter_id IS NOT NULL")
      .all() as Pick<Notebook, "openrag_filter_id">[])
      .map((r) => r.openrag_filter_id as string),
  );

  let allFilters: Awaited<ReturnType<typeof listFilters>>;
  try {
    allFilters = await listFilters();
  } catch {
    // OpenRAG unreachable — nothing to import.
    return NextResponse.json({ filters: [] });
  }

  const unlinked = allFilters.filter((f) => !linked.has(f.id));
  return NextResponse.json({ filters: unlinked });
}
