// ============================================================================
// /api/notebooks/[id]/documents — upload a file and ingest it into OpenRAG
// ============================================================================
//
// _Basically_, this is the "+ Add source" button. The browser POSTs a
// multipart form, we read the file bytes, hand them to OpenRAG's ingest
// endpoint (which runs them through Docling -> embed -> OpenSearch), and
// then save a row in our SQLite so the UI can list it.
//
// Two-step responsibility split:
//   - OpenRAG owns the actual content (chunks, embeddings, retrieval).
//   - We own a tiny "list of files the user uploaded" pointer table so the
//     Sources panel renders without round-tripping OpenRAG.
//
// We don't store the file on disk ourselves — once it's in OpenSearch we
// don't need it. If you wanted a "download original" feature later, you'd
// add a writeFileSync here under public/uploads or similar.
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import { v4 as uuid } from "uuid";
import db, { Notebook } from "@/lib/db";
import { ingestDocument } from "@/lib/openrag";

export const runtime = "nodejs";

/**
 * POST /api/notebooks/[id]/documents
 *
 * Multipart body: `file=<binary>`
 *
 * The flow:
 *   1. 404 fast if the notebook ID doesn't exist.
 *   2. Read the uploaded File into a Buffer (Next.js gives us a web File).
 *   3. POST the Buffer to OpenRAG. This is the slow part — Docling parsing
 *      + embedding can take 10-60s depending on file size.
 *   4. Save our pointer row.
 *
 * If OpenRAG ingest fails we return 502 (gateway error) without saving the
 * pointer row, so the UI doesn't lie about what got ingested.
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

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file missing" }, { status: 400 });
  }

  // arrayBuffer() loads the whole file into memory — fine for ≤ a few MB
  // (typical PDFs/markdown). For multi-100MB uploads you'd switch to a
  // streaming form parser.
  const bytes = Buffer.from(await file.arrayBuffer());

  let taskId: string;
  try {
    const r = await ingestDocument({
      filename: file.name,
      bytes,
      contentType: file.type || "application/octet-stream",
    });
    taskId = r.taskId;
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "ingest failed" },
      { status: 502 },
    );
  }

  // Save the pointer row only after OpenRAG accepted the file. `openrag_id`
  // is the backend task ID — useful for debugging via /tasks/<id>.
  const docId = uuid();
  db.prepare(
    "INSERT INTO documents (id, notebook_id, filename, bytes, openrag_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(docId, id, file.name, bytes.length, taskId || null, Date.now());

  return NextResponse.json({
    document: { id: docId, filename: file.name, bytes: bytes.length },
  });
}
