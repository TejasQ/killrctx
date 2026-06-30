// ============================================================================
// /api/notebooks/[id]/documents/url — ingest a web page by URL into OpenRAG
// ============================================================================
//
// _Basically_, this is the URL variant of the "+ Add source" button. The
// browser POSTs a JSON body with { url }, we fetch the page server-side,
// hand the HTML bytes to OpenRAG's ingest endpoint (Docling parses HTML fine),
// and save a pointer row in SQLite so the Sources panel can list it.
//
// We use the URL's hostname + path as the filename (e.g. "example.com/about")
// so it is human-readable in the list. The ".html" extension tells Docling
// to use its HTML pipeline rather than guessing.
//
// Same responsibility split as the file upload route:
//   - OpenRAG owns the content (chunks, embeddings, retrieval).
//   - We own a tiny pointer row (filename, bytes, ingest_status).
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import { v4 as uuid } from "uuid";
import db, { Notebook } from "@/lib/db";
import { ingestDocument, scheduleSyncFilterSources } from "@/lib/openrag";

export const runtime = "nodejs";

/**
 * POST /api/notebooks/[id]/documents/url
 *
 * Body: `{ "url": "https://example.com/article" }`
 *
 * The flow:
 *   1. 404 fast if the notebook ID doesn't exist.
 *   2. Fetch the URL's HTML content from the public internet.
 *   3. POST the HTML bytes to OpenRAG (same as a file upload).
 *   4. Save our pointer row.
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;

  const notebook = db
    .prepare("SELECT * FROM notebooks WHERE id = ?")
    .get(id) as Notebook | undefined;
  if (!notebook) {
    return NextResponse.json({ error: "notebook not found" }, { status: 404 });
  }

  const body = await req.json().catch(() => null);
  const url: unknown = body?.url;
  if (typeof url !== "string" || !url.startsWith("http")) {
    return NextResponse.json({ error: "valid url required" }, { status: 400 });
  }

  // Fetch the page. A 10s timeout prevents long hangs on slow or unreachable
  // URLs from blocking the request indefinitely.
  let htmlBytes: Buffer;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; killrctx/1.0)" },
    });
    clearTimeout(timer);
    if (!res.ok) {
      return NextResponse.json(
        { error: `URL returned ${res.status}` },
        { status: 502 },
      );
    }
    htmlBytes = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "fetch failed" },
      { status: 502 },
    );
  }

  // Build a readable filename from the URL (hostname + path, no query string).
  // Using .html extension so Docling routes it through the HTML pipeline.
  const parsed = new URL(url);
  const slug = (parsed.hostname + parsed.pathname)
    .replace(/\/+$/, "")   // strip trailing slash
    .replace(/[^a-zA-Z0-9._-]/g, "_"); // make filesystem-safe
  const filename = `${slug}.html`;

  // Overwrite existing row if the same URL was already added.
  const existingDoc = db
    .prepare("SELECT id FROM documents WHERE notebook_id = ? AND filename = ?")
    .get(id, filename) as { id: string } | undefined;

  let taskId: string;
  try {
    const r = await ingestDocument({
      filename,
      bytes: htmlBytes,
      contentType: "text/html",
    });
    taskId = r.taskId;
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "ingest failed" },
      { status: 502 },
    );
  }

  const docId = existingDoc?.id ?? uuid();
  if (existingDoc) {
    db.prepare(
      "UPDATE documents SET bytes = ?, mimetype = 'text/html', openrag_id = ?, ingest_status = 'indexing', ingest_error = NULL WHERE id = ?",
    ).run(htmlBytes.length, taskId || null, docId);
  } else {
    db.prepare(
      "INSERT INTO documents (id, notebook_id, filename, bytes, mimetype, openrag_id, ingest_status, created_at) VALUES (?, ?, ?, ?, 'text/html', ?, 'indexing', ?)",
    ).run(docId, id, filename, htmlBytes.length, taskId || null, Date.now());
  }

  const freshNotebook = db
    .prepare("SELECT openrag_filter_id FROM notebooks WHERE id = ?")
    .get(id) as { openrag_filter_id: string | null } | undefined;
  if (freshNotebook?.openrag_filter_id) {
    const filterId = freshNotebook.openrag_filter_id;
    scheduleSyncFilterSources(filterId, () =>
      (db
        .prepare("SELECT filename FROM documents WHERE notebook_id = ? AND ingest_status = 'ready'")
        .all(id) as { filename: string }[]
      ).map((r) => r.filename)
    );
  }

  return NextResponse.json({
    document: { id: docId, filename, bytes: htmlBytes.length },
  });
}
