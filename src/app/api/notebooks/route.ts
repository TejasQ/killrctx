// ============================================================================
// /api/notebooks — list and create notebooks
// ============================================================================
//
// _Basically_, the home page calls GET to render its list and POST to create
// a new notebook before navigating to /notebooks/<id>.
//
// On creation we set up backend-specific resources:
//   - OpenRAG: create a knowledge filter for retrieval scoping
//   - Workbench: create a Knowledge Base (Astra collection) for this notebook
//
// Backend resource creation is best-effort — if the backend is down the
// notebook is still created; routes will retry on first use.
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import { v4 as uuid } from "uuid";
import db, { Notebook } from "@/lib/db";
import { createFilter } from "@/lib/openrag";
import { getBackend } from "@/lib/rag";

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
 * Body: {
 *   title?: string,
 *   rag_backend?: "openrag" | "workbench",
 *   workbench_embedding_service_id?: string,
 *   workbench_agent_id?: string
 * }
 *
 * Returns the freshly-inserted row so the client can navigate straight to it
 * without a follow-up GET.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    title?: string;
    rag_backend?: "openrag" | "workbench";
    workbench_embedding_service_id?: string;
    workbench_agent_id?: string;
  };

  const id = uuid();
  const collection = `nb_${id.replace(/-/g, "")}`;
  const resolvedTitle = body.title?.trim() || "Untitled notebook";
  const ragBackend = body.rag_backend ?? "openrag";
  const now = Date.now();

  db.prepare(
    "INSERT INTO notebooks (id, title, created_at, openrag_collection, rag_backend) VALUES (?, ?, ?, ?, ?)",
  ).run(id, resolvedTitle, now, collection, ragBackend);

  // Seed a default conversation so the Chat panel always has an activeConvId.
  const convId = uuid();

  if (ragBackend === "workbench") {
    // ── Workbench path: create a Knowledge Base on the Workbench ──
    const rag = getBackend("workbench");
    try {
      const { resourceId } = await rag.createNotebookResources({
        notebookId: id,
        notebookTitle: resolvedTitle,
        embeddingServiceId: body.workbench_embedding_service_id,
      });
      db.prepare(
        "UPDATE notebooks SET workbench_kb_id = ?, workbench_embedding_service_id = ? WHERE id = ?",
      ).run(resourceId, body.workbench_embedding_service_id ?? null, id);
    } catch {
      // Workbench unreachable — KB columns stay NULL; ingest will fail later
      // with a clear error message.
    }

    // Create the conversation on the Workbench too (needs the KB binding).
    const notebook = db.prepare("SELECT * FROM notebooks WHERE id = ?").get(id) as Notebook;
    const agentId = body.workbench_agent_id ?? process.env.WORKBENCH_DEFAULT_AGENT_ID ?? "";
    try {
      const { conversationId } = await rag.createConversation({
        notebook,
        agentId,
        title: "Conversation 1",
      });
      db.prepare(
        "INSERT INTO conversations (id, notebook_id, title, created_at, workbench_agent_id, workbench_conversation_id) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(convId, id, "Conversation 1", now, agentId, conversationId);
    } catch {
      // Fallback: create the SQLite row without a Workbench conversation.
      db.prepare(
        "INSERT INTO conversations (id, notebook_id, title, created_at, workbench_agent_id) VALUES (?, ?, ?, ?, ?)",
      ).run(convId, id, "Conversation 1", now, agentId);
    }
  } else {
    // ── OpenRAG path: create a knowledge filter ──
    db.prepare(
      "INSERT INTO conversations (id, notebook_id, title, created_at) VALUES (?, ?, ?, ?)",
    ).run(convId, id, "Conversation 1", now);

    try {
      const { filterId, filterName } = await createFilter(resolvedTitle);
      db.prepare(
        "UPDATE notebooks SET openrag_filter_id = ?, openrag_filter_name = ? WHERE id = ?",
      ).run(filterId, filterName, id);
    } catch {
      // OpenRAG down at creation time — filter columns stay NULL.
    }
  }

  const nb = db
    .prepare("SELECT * FROM notebooks WHERE id = ?")
    .get(id) as Notebook;
  return NextResponse.json({ notebook: nb });
}
