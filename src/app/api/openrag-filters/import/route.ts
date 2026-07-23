// ============================================================================
// /api/openrag-filters/import — create a local notebook from an OpenRAG filter
// ============================================================================
//
// _Basically_, when a user clicks "Import" on the unlinked-filter banner this
// route does the same work that POST /api/notebooks does — but instead of
// creating a fresh empty filter it *adopts* one that already exists in OpenRAG.
//
// The result is indistinguishable from a notebook created in-app:
//   - notebooks row with all openrag_filter_* columns populated
//   - a default "Conversation 1" conversations row
//   - one documents row per filename in the filter's data_sources (status=ready)
//
// Idempotent: if the filter is already linked to a notebook, returns that
// notebook rather than creating a duplicate.
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import { v4 as uuid } from "uuid";
import db, { Notebook } from "@/lib/db";
import { getFilterMeta } from "@/lib/openrag";
import { OpenRAGClient } from "openrag-sdk";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const { filterId } = (await req.json()) as { filterId: string };
  if (!filterId) {
    return NextResponse.json({ error: "filterId is required" }, { status: 400 });
  }

  // Fetch the full filter payload first — needed for both the fresh-create and
  // the reimport-into-existing-notebook paths below.
  const client = new OpenRAGClient({
    baseUrl: process.env.OPENRAG_URL ?? "http://localhost:3000",
    apiKey: process.env.OPENRAG_API_KEY,
  });
  const filter = await client.knowledgeFilters.get(filterId);
  if (!filter) {
    return NextResponse.json({ error: "filter not found in OpenRAG" }, { status: 404 });
  }

  // If a notebook already exists for this filter, sync any new data_sources
  // documents and return the existing notebook. This is the "reimport" path —
  // the user wants to pull in sources added to the filter since the last import.
  const existing = db
    .prepare("SELECT * FROM notebooks WHERE openrag_filter_id = ?")
    .get(filterId) as Notebook | undefined;
  if (existing) {
    syncDocuments(existing.id, filter.queryData?.filters?.data_sources ?? []);
    return NextResponse.json({ notebook: existing });
  }

  // Pull icon/color/limit/scoreThreshold out of queryData — same fields
  // the GET bundle route lazily refreshes via getFilterMeta().
  const qd = (filter.queryData ?? {}) as {
    icon?: string;
    color?: string;
    limit?: number;
    scoreThreshold?: number;
  };

  const id = uuid();
  const collection = `nb_${id.replace(/-/g, "")}`;
  const now = Date.now();

  db.prepare(`
    INSERT INTO notebooks
      (id, title, created_at, openrag_collection, rag_backend,
       openrag_filter_id, openrag_filter_name,
       openrag_filter_icon, openrag_filter_color,
       openrag_filter_limit, openrag_filter_score_threshold)
    VALUES (?, ?, ?, ?, 'openrag', ?, ?, ?, ?, ?, ?)
  `).run(
    id, filter.name, now, collection,
    filter.id, filter.name,
    qd.icon ?? null, qd.color ?? null,
    qd.limit ?? null, qd.scoreThreshold ?? null,
  );

  // Seed a default conversation so the Chat panel works immediately.
  db.prepare(
    "INSERT INTO conversations (id, notebook_id, title, created_at) VALUES (?, ?, ?, ?)",
  ).run(uuid(), id, "Conversation 1", now);

  syncDocuments(id, filter.queryData?.filters?.data_sources ?? []);

  const notebook = db.prepare("SELECT * FROM notebooks WHERE id = ?").get(id) as Notebook;
  return NextResponse.json({ notebook });
}

/**
 * Insert a documents row for each filename in `dataSources` that isn't already
 * in the notebook. Uses INSERT OR IGNORE so it's safe to call repeatedly.
 *
 * Skips the wildcard "*" — that's OpenRAG's "match all" sentinel, not a filename.
 */
function syncDocuments(notebookId: string, dataSources: string[]) {
  const now = Date.now();
  for (const filename of dataSources) {
    if (filename === "*") continue;
    db.prepare(`
      INSERT OR IGNORE INTO documents
        (id, notebook_id, filename, bytes, ingest_status, created_at)
      VALUES (?, ?, ?, 0, 'ready', ?)
    `).run(uuid(), notebookId, filename, now);
  }
}
