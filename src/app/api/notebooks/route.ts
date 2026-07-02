// ============================================================================
// /api/notebooks — list and create notebooks
// ============================================================================
//
// _Basically_, the home page calls GET to render its list and POST to create
// a new notebook before navigating to /notebooks/<id>.
//
// On creation we write the SQLite row first and return immediately so the UI
// can navigate without waiting. Backend resource creation (KB on Workbench,
// filter on OpenRAG) then runs in the background and updates the row when done.
// The notebook page already tolerates NULL kb/filter IDs — it shows an error
// only if the user tries to ingest before the background job finishes.
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

  // Write the notebook row synchronously so the response can go back immediately.
  db.prepare(
    "INSERT INTO notebooks (id, title, created_at, openrag_collection, rag_backend) VALUES (?, ?, ?, ?, ?)",
  ).run(id, resolvedTitle, now, collection, ragBackend);

  // Seed a default conversation row synchronously too — the Chat panel needs
  // an activeConvId the moment the page loads. The Workbench conversation ID
  // gets backfilled by the background task below.
  const convId = uuid();
  const agentId = body.workbench_agent_id ?? process.env.WORKBENCH_DEFAULT_AGENT_ID ?? "";
  if (ragBackend === "workbench") {
    db.prepare(
      "INSERT INTO conversations (id, notebook_id, title, created_at, workbench_agent_id) VALUES (?, ?, ?, ?, ?)",
    ).run(convId, id, "Conversation 1", now, agentId);
  } else {
    db.prepare(
      "INSERT INTO conversations (id, notebook_id, title, created_at) VALUES (?, ?, ?, ?)",
    ).run(convId, id, "Conversation 1", now);
  }

  // Return the row immediately — the client doesn't need to wait for the
  // Workbench/OpenRAG calls to finish before navigating.
  const nb = db.prepare("SELECT * FROM notebooks WHERE id = ?").get(id) as Notebook;
  const response = NextResponse.json({ notebook: nb });

  // ── Background: create backend resources after responding ──
  //
  // void: we intentionally don't await. In the Node.js runtime the event loop
  // keeps running after the response is sent, so these awaits complete normally.
  if (ragBackend === "workbench") {
    // Resolve the embedding service ID here so the stored value is never NULL.
    const embeddingServiceId =
      body.workbench_embedding_service_id ??
      process.env.WORKBENCH_DEFAULT_EMBEDDING_SERVICE_ID;
    void createWorkbenchResources(id, resolvedTitle, convId, agentId, embeddingServiceId);
  } else {
    void createOpenragFilter(id, resolvedTitle);
  }

  return response;
}

// ─── Background helpers ───────────────────────────────────────────────────────
// These run after the response is already sent. Any error is swallowed — the
// notebook page will surface a clear message on first use if the IDs are still
// NULL.

async function createWorkbenchResources(
  notebookId: string,
  notebookTitle: string,
  convId: string,
  agentId: string,
  embeddingServiceId?: string,
) {
  const rag = getBackend("workbench");

  // Step 1: create the Knowledge Base and store its ID.
  let kbId: string | null = null;
  try {
    const { resourceId } = await rag.createNotebookResources({
      notebookId,
      notebookTitle,
      embeddingServiceId,
    });
    kbId = resourceId;
    db.prepare(
      "UPDATE notebooks SET workbench_kb_id = ?, workbench_embedding_service_id = ? WHERE id = ?",
    ).run(kbId, embeddingServiceId ?? null, notebookId);
  } catch {
    // Workbench unreachable — kb_id stays NULL.
    return;
  }

  // Step 2: create the Workbench conversation (needs the KB ID) and backfill
  // the workbench_conversation_id on the row we already inserted.
  const notebook = db.prepare("SELECT * FROM notebooks WHERE id = ?").get(notebookId) as Notebook;
  try {
    const { conversationId } = await rag.createConversation({
      notebook,
      agentId,
      title: "Conversation 1",
    });
    db.prepare(
      "UPDATE conversations SET workbench_conversation_id = ? WHERE id = ?",
    ).run(conversationId, convId);
  } catch {
    // Conversation creation failed — chat will fail with a clear error.
  }
}

async function createOpenragFilter(notebookId: string, notebookTitle: string) {
  try {
    const { filterId, filterName } = await createFilter(notebookTitle);
    db.prepare(
      "UPDATE notebooks SET openrag_filter_id = ?, openrag_filter_name = ? WHERE id = ?",
    ).run(filterId, filterName, notebookId);
  } catch {
    // OpenRAG down at creation time — filter columns stay NULL.
  }
}
