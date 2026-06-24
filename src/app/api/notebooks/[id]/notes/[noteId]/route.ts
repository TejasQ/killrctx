// ============================================================================
// /api/notebooks/[id]/notes/[noteId] — generate or delete a note
// ============================================================================
//
// _Basically_, this one route handles two operations distinguished by HTTP
// method:
//
//   POST   /api/notebooks/[id]/notes/[type]   — generate a new note (streaming)
//   DELETE /api/notebooks/[id]/notes/[noteId] — delete an existing note
//
// Next.js requires a single slug name for all dynamic segments at the same
// path level, so both operations share `[noteId]`. The POST handler treats
// the segment as a type name and validates it; the DELETE handler treats it
// as a row ID. They never collide because note IDs are UUIDs and type names
// are short lowercase words.
//
// The POST handler streams token deltas back as SSE so the UI can show the
// note being written in real time. Once streaming is complete, the assembled
// content is saved to SQLite and a final SSE event returns the saved note row.
//
// SSE event format (newline-delimited JSON in the `data:` field):
//   data: {"type":"delta","text":"hello"}
//   data: {"type":"done","note":{...}}   ← full saved note row
//   data: {"type":"error","error":"…"}
// ============================================================================

import { NextRequest } from "next/server";
import { v4 as uuid } from "uuid";
import db, { Notebook, Note, buildQueryConfig } from "@/lib/db";
import { chatStream, deleteConversation } from "@/lib/openrag";

export const runtime = "nodejs";

const NOTE_TYPES = ["summary", "mindmap", "outline", "qa"] as const;
type NoteType = (typeof NOTE_TYPES)[number];

const DEFAULT_TITLES: Record<NoteType, (date: string) => string> = {
  summary: (d) => `Summary ${d}`,
  mindmap: (d) => `Mind Map ${d}`,
  outline: (d) => `Outline ${d}`,
  qa:      (d) => `Q&A ${d}`,
};

// Each note type has a dedicated prompt. The optional `topic` narrows focus.
const NOTE_PROMPTS: Record<NoteType, string> = {
  summary:
    "Write a concise prose summary of the key information in the sources. " +
    "Focus on the most important facts, themes, and conclusions.",
  mindmap:
    "Create a mind map of the key concepts in the sources.\n" +
    "Output ONLY a nested markdown list in exactly this format — nothing else:\n" +
    "\n" +
    "- Root Topic\n" +
    "  - Branch One\n" +
    "    - Sub-branch A\n" +
    "      - Leaf Detail\n" +
    "    - Sub-branch B\n" +
    "  - Branch Two\n" +
    "    - Sub-branch C\n" +
    "      - Leaf Detail\n" +
    "\n" +
    "Strict constraints:\n" +
    "- Every item is 1–5 words. No sentences. No punctuation at the end.\n" +
    "- Use exactly two spaces per indent level. Use all 4 levels (root, branch, sub-branch, leaf).\n" +
    "- Each branch or sub-branch has 3–5 children. No flat lists.\n" +
    "- No source names, citations, document titles, or parenthetical notes.\n" +
    "- No prose, headings, blank lines, or any text outside the list.",
  outline:
    "Write a structured hierarchical outline of the topics covered in the sources. " +
    "Begin with a single H1 title (# Title) that names the subject of the outline in plain English — no filler phrases like 'Structured Outline of'. " +
    "Then use exactly four levels of structure:\n" +
    "  ## Roman numeral headings (## I, ## II, ## III …) for top-level sections.\n" +
    "  ### Letter headings (### A, ### B, ### C …) for subsections under each Roman numeral.\n" +
    "  #### Named subject headings (#### Name) for any distinct entity, person, or concept that has multiple detail points — only use this level when a subject has more than one detail worth listing.\n" +
    "  Numbered lists (1. 2. 3.) for detail points. Place them under the most specific heading they belong to.\n" +
    "Use only the H1 title, headings, and numbered list items — no prose paragraphs, no bullet points.",
  qa:
    "Generate a list of question-and-answer pairs covering the key facts in the sources. " +
    "Format each pair as:\n**Q: ...?**\nA: ...",
};

/**
 * POST /api/notebooks/[id]/notes/[type]
 *
 * Body: { topic?: string; title?: string; selectedFilenames?: string[] }
 *
 * Streams token deltas, then emits a final "done" event containing the
 * persisted note row so the UI can add it to the notes list.
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; noteId: string }> },
) {
  const { id, noteId: type } = await ctx.params;

  if (!NOTE_TYPES.includes(type as NoteType)) {
    return new Response(JSON.stringify({ error: `unknown note type: ${type}` }), { status: 400 });
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
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  }

  const qc = buildQueryConfig(notebook, selectedFilenames);
  const base = NOTE_PROMPTS[noteType];
  const prompt = topic ? `Focus specifically on: ${topic}.\n\n${base}` : base;

  const stream = new ReadableStream({
    async start(controller) {
      function send(obj: Record<string, unknown>) {
        controller.enqueue(`data: ${JSON.stringify(obj)}\n\n`);
      }

      try {
        // Notes use limit:12 for broader retrieval coverage over the full doc set.
        const events = await chatStream({ prompt, ...qc, limit: qc.limit ?? 12 });

        let assembled = "";
        let responseId = "";

        for await (const event of events) {
          if (event.type === "content") {
            assembled += event.delta;
            send({ type: "delta", text: event.delta });
          } else if (event.type === "done") {
            responseId = event.chatId ?? "";
          }
        }

        // Persist the note to SQLite once streaming is complete.
        const now = Date.now();
        const noteId = uuid();
        db.prepare(
          "INSERT INTO notes (id, notebook_id, type, title, topic, content, response_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          noteId,
          id,
          noteType,
          title?.trim() || DEFAULT_TITLES[noteType](new Date(now).toLocaleDateString()),
          topic?.trim() || null,
          assembled,
          responseId,
          now,
        );

        const note = db.prepare("SELECT * FROM notes WHERE id = ?").get(noteId) as Note;
        send({ type: "done", note });
      } catch (err) {
        send({ type: "error", error: err instanceof Error ? err.message : "note generation failed" });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
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
    return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } }); // already gone — idempotent
  }

  db.prepare("DELETE FROM notes WHERE id = ?").run(noteId);

  // Clean up the OpenRAG thread best-effort.
  if (note.response_id) {
    try {
      await deleteConversation(note.response_id);
    } catch {
      // OpenRAG unreachable or thread already gone — not a hard failure.
    }
  }

  return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
}
