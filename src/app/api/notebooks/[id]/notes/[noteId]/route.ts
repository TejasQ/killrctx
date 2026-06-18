// ============================================================================
// /api/notebooks/[id]/notes/[noteId] — generate or delete a note
// ============================================================================
//
// _Basically_, this one route handles two operations distinguished by HTTP
// method:
//
//   POST   /api/notebooks/[id]/notes/[type]   — generate a new note
//   DELETE /api/notebooks/[id]/notes/[noteId] — delete an existing note
//
// Next.js requires a single slug name for all dynamic segments at the same
// path level, so both operations share `[noteId]`. The POST handler treats
// the segment as a type name and validates it; the DELETE handler treats it
// as a row ID. They never collide because note IDs are UUIDs and type names
// are short lowercase words.
//
// All note types (summary, mindmap, outline, qa) go through the same
// generate path — same OpenRAG query setup via buildQueryConfig, same
// generateNote() call. The only thing that differs is the `type` string,
// which selects the prompt inside generateNote(). Podcast is a separate route
// because it has a multi-step async pipeline (script → TTS → stitch) that
// can't fit the synchronous generate-and-return pattern here.
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import { v4 as uuid } from "uuid";
import db, { Notebook, Note, buildQueryConfig } from "@/lib/db";
import { generateNote, deleteConversation } from "@/lib/openrag";

export const runtime = "nodejs";

const NOTE_TYPES = ["summary", "mindmap", "outline", "qa"] as const;
type NoteType = (typeof NOTE_TYPES)[number];

const DEFAULT_TITLES: Record<NoteType, (date: string) => string> = {
  summary: (d) => `Summary ${d}`,
  mindmap: (d) => `Mind Map ${d}`,
  outline: (d) => `Outline ${d}`,
  qa:      (d) => `Q&A ${d}`,
};

/**
 * POST /api/notebooks/[id]/notes/[type]
 *
 * Body: { topic?: string; title?: string; selectedFilenames?: string[] }
 *
 * Generates a new text note of the given type and returns the saved row.
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; noteId: string }> },
) {
  const { id, noteId: type } = await ctx.params;

  if (!NOTE_TYPES.includes(type as NoteType)) {
    return NextResponse.json({ error: `unknown note type: ${type}` }, { status: 400 });
  }
  const noteType = type as NoteType;

  const { topic, title, selectedFilenames } = (await req.json().catch(() => ({}))) as {
    topic?: string;
    title?: string;
    selectedFilenames?: string[];
  };

  const notebook = db
    .prepare("SELECT * FROM notebooks WHERE id = ?")
    .get(id) as Notebook | undefined;
  if (!notebook) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const qc = buildQueryConfig(id, notebook, selectedFilenames);
  const { content, responseId } = await generateNote({ type: noteType, topic, ...qc });

  const now = Date.now();
  const noteId = uuid();
  db.prepare(
    "INSERT INTO notes (id, notebook_id, type, title, content, response_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(noteId, id, noteType, title?.trim() || DEFAULT_TITLES[noteType](new Date(now).toLocaleDateString()), content, responseId, now);

  const note = db.prepare("SELECT * FROM notes WHERE id = ?").get(noteId) as Note;
  return NextResponse.json({ note });
}

/**
 * DELETE /api/notebooks/[id]/notes/[noteId]
 *
 * Removes the note row and cleans up its OpenRAG thread (best-effort).
 */
export async function DELETE(
  _: Request,
  ctx: { params: Promise<{ noteId: string }> },
) {
  const { noteId } = await ctx.params;

  const note = db.prepare("SELECT * FROM notes WHERE id = ?").get(noteId) as Note | undefined;
  if (!note) {
    return NextResponse.json({ ok: true }); // already gone — idempotent
  }

  db.prepare("DELETE FROM notes WHERE id = ?").run(noteId);

  // Clean up the OpenRAG thread best-effort. All note types — including
  // podcasts — store a response_id from their generating chat() call.
  // The check handles the edge case of notes created before this was added,
  // or where OpenRAG was unreachable during generation.
  if (note.response_id) {
    try {
      await deleteConversation(note.response_id);
    } catch {
      // OpenRAG unreachable or thread already gone — not a hard failure.
    }
  }

  return NextResponse.json({ ok: true });
}
