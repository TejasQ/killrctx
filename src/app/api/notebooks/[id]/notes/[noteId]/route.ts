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
import { getBackend } from "@/lib/rag";

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
    "Write a rich, well-structured summary of the key information in the sources.\n\n" +
    "Formatting rules (follow them exactly):\n" +
    "- Begin with a single # Title that names the subject.\n" +
    "- Use ## headings for major sections (e.g. Overview, Key Details, Agenda, Highlights).\n" +
    "- Use **bold labels** (e.g. **Date:**, **Location:**, **Hosted by:**) for concise metadata — put each on its own line.\n" +
    "- Use a blockquote (>) for any descriptive paragraph or abstract.\n" +
    "- When the source contains a schedule, list, or comparison, render it as a markdown table.\n" +
    "- Use bullet lists for sets of key facts, takeaways, or action items.\n" +
    "- Use **bold** for the most important terms or names inline.\n" +
    "- Do not produce a wall of prose. Every section should be visually distinct.",
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
    "Generate a comprehensive set of question-and-answer pairs that test understanding of the key facts in the sources.\n\n" +
    "Output format — follow this exactly, no deviations:\n\n" +
    "**Q: <question text>?**\n" +
    "A: <answer text>\n\n" +
    "**Q: <next question>?**\n" +
    "A: <next answer>\n\n" +
    "Rules:\n" +
    "- Every question line must start with **Q:** (bold) and end with ?\n" +
    "- Every answer line must start with A: (plain)\n" +
    "- Leave exactly one blank line between each pair\n" +
    "- Answers should be 1–3 sentences: concise but complete\n" +
    "- Cover basic facts, key relationships, and notable specifics\n" +
    "- No prose, no headings, no numbered prefixes, no text outside the Q/A pairs",
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

  console.log(`[notes] POST /${id}/notes/${type}`);

  if (!NOTE_TYPES.includes(type as NoteType)) {
    return new Response(JSON.stringify({ error: `unknown note type: ${type}` }), { status: 400 });
  }
  const noteType = type as NoteType;

  const { topic, title, selectedFilenames, workbenchAgentId } = (await req.json().catch(() => ({}))) as {
    topic?: string;
    title?: string;
    selectedFilenames?: string[];
    workbenchAgentId?: string;
  };

  const notebook = db
    .prepare("SELECT * FROM notebooks WHERE id = ?")
    .get(id) as Notebook | undefined;
  if (!notebook) {
    console.log(`[notes] notebook ${id} not found`);
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  }

  const isWorkbench = notebook.rag_backend === "workbench";
  console.log(`[notes] backend=${notebook.rag_backend} kb=${notebook.workbench_kb_id ?? "none"} type=${noteType}`);

  const qc = !isWorkbench
    ? buildQueryConfig(notebook, selectedFilenames)
    : { filterId: null, sourcePaths: null, limit: null, scoreThreshold: null };
  const base = NOTE_PROMPTS[noteType];
  const prompt = topic ? `Focus specifically on: ${topic}.\n\n${base}` : base;

  const stream = new ReadableStream({
    async start(controller) {
      function send(obj: Record<string, unknown>) {
        controller.enqueue(`data: ${JSON.stringify(obj)}\n\n`);
      }

      try {
        let assembled = "";
        let responseId = "";

        if (isWorkbench) {
          // ── Workbench streaming path ──
          //
          // Always create a fresh conversation for Studio generation.
          // Borrowing an existing user conversation is fragile — it may have
          // been created under a different agent, may have a null workbench_conversation_id
          // if the Workbench was unreachable at creation time, or may get its
          // message history polluted by Studio prompts. A dedicated ephemeral
          // conversation sidesteps all of that.
          const rag = getBackend("workbench");
          console.log(`[notes/workbench] creating conversation for ${noteType} generation agentId=${workbenchAgentId ?? "default"}`);
          const { conversationId } = await rag.createConversation({ notebook, agentId: workbenchAgentId });
          console.log(`[notes/workbench] conversation created: ${conversationId}`);

          try {
            const events = rag.chatStream({
              prompt,
              notebook,
              workbenchConversationId: conversationId,
            });
            let tokenCount = 0;
            for await (const event of events) {
              if (event.type === "token") {
                assembled += event.delta;
                send({ type: "delta", text: event.delta });
                tokenCount++;
              } else if (event.type === "done") {
                responseId = event.responseId;
                console.log(`[notes/workbench] stream done — ${tokenCount} tokens, responseId=${responseId}`);
              }
            }
          } finally {
            console.log(`[notes/workbench] deleting conversation ${conversationId}`);
            try { await rag.deleteConversation(conversationId, notebook, null); } catch { /* best-effort */ }
          }
        } else {
          // ── OpenRAG streaming path ──
          const events = await chatStream({ prompt, ...qc, limit: qc.limit ?? 12 });
          for await (const event of events) {
            if (event.type === "content") {
              assembled += event.delta;
              send({ type: "delta", text: event.delta });
            } else if (event.type === "done") {
              responseId = event.chatId ?? "";
            }
          }
        }

        // OpenRAG occasionally leaks tool-call JSON objects (e.g. {"search_query":
        // "..."}) directly into the streamed content alongside the real text.
        // For mindmap notes this breaks parseMindMap because the JSON prefix
        // on the first line prevents the root "- Topic" from matching.
        // Strip any {...} blobs before saving so the stored content is clean.
        if (noteType === "mindmap") {
          console.log("[mindmap] raw assembled START ---");
          console.log(JSON.stringify(assembled));
          console.log("[mindmap] raw assembled END ---");
          assembled = assembled.replace(/\{[^}]*\}/g, "").trim();
          console.log("[mindmap] cleaned assembled START ---");
          console.log(JSON.stringify(assembled));
          console.log("[mindmap] cleaned assembled END ---");
        }

        console.log(`[notes] saving note — type=${noteType} assembled.length=${assembled.length}`);

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
        console.log(`[notes] done — noteId=${noteId}`);
        send({ type: "done", note });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[notes] ERROR:`, err);
        send({ type: "error", error: msg });
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
