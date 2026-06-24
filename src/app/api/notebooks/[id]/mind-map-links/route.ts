// ============================================================================
// /api/notebooks/[id]/mind-map-links — persist a node-to-conversation link
// ============================================================================
//
// _Basically_, when a user clicks a mind map node for the first time, the UI
// creates a conversation and then POSTs here to record which node it came from.
// This is what lets the map remember "Attack Roll: d20 has been researched"
// across page reloads and return visits.
//
// One node can have many links (one per conversation started from it). There
// is no uniqueness constraint — the UI decides when to create a new link vs.
// reuse an existing one via the `mindMapLinks` array in the bundle response.
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import { v4 as uuid } from "uuid";
import db, { MindMapLink } from "@/lib/db";

export const runtime = "nodejs";

/**
 * POST /api/notebooks/[id]/mind-map-links
 *
 * Body: { noteId: string; nodeLabel: string; nodePath: string; conversationId: string }
 * nodePath is the ancestor breadcrumb (e.g. "Berserker Korg > Abilities > Reckless Attack").
 * Empty string for root-level nodes.
 * Response: { link: MindMapLink }
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const { noteId, nodeLabel, nodePath, conversationId } = (await req.json()) as {
    noteId?: string;
    nodeLabel?: string;
    nodePath?: string;
    conversationId?: string;
  };

  if (!noteId?.trim() || !nodeLabel?.trim() || !conversationId?.trim()) {
    return NextResponse.json({ error: "noteId, nodeLabel, and conversationId are required" }, { status: 400 });
  }

  // Verify the note belongs to this notebook.
  const note = db
    .prepare("SELECT id FROM notes WHERE id = ? AND notebook_id = ?")
    .get(noteId, id);
  if (!note) {
    return NextResponse.json({ error: "note not found" }, { status: 404 });
  }

  // Verify the conversation belongs to this notebook.
  const conversation = db
    .prepare("SELECT id FROM conversations WHERE id = ? AND notebook_id = ?")
    .get(conversationId, id);
  if (!conversation) {
    return NextResponse.json({ error: "conversation not found" }, { status: 404 });
  }

  const linkId = uuid();
  db.prepare(
    "INSERT INTO mind_map_links (id, note_id, node_label, node_path, conversation_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(linkId, noteId, nodeLabel, nodePath ?? "", conversationId, Date.now());

  const link = db
    .prepare("SELECT * FROM mind_map_links WHERE id = ?")
    .get(linkId) as MindMapLink;

  return NextResponse.json({ link });
}
