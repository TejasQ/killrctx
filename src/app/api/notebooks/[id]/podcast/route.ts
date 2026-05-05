// ============================================================================
// /api/notebooks/[id]/podcast — kick off podcast generation
// ============================================================================
//
// _Basically_, the "Generate" button POSTs here and gets back a podcast row
// in `status: "scripting"` *immediately* — the actual work (drafting the
// script with OpenRAG, then synthesizing each turn with ElevenLabs) runs in
// the background. The UI polls /api/notebooks/[id] every 3s while any
// podcast is non-terminal and watches the row transition through:
//
//     scripting -> synthesizing -> ready
//                              \-> failed
//
// Why fire-and-forget instead of awaiting the whole thing?
//   The pipeline can take 30-90 seconds end-to-end. Holding an HTTP
//   connection that long is bad for UX (no progress signal beyond "still
//   loading") and bumps into Next.js' default route timeouts. Returning
//   immediately + polling gives us a free progress indicator (the status
//   pill in the UI) and lets the user navigate away and come back.
//
// Why store the script and error text in the database?
//   - script: the user can read it via "Show script" without re-paying for
//     anything; great for debugging hallucinations.
//   - error:  if synthesis 402's because of a library voice, the actual
//     error message lands in the UI's red banner instead of disappearing
//     into server logs.
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import { join } from "node:path";
import { v4 as uuid } from "uuid";
import db, { Notebook, Podcast } from "@/lib/db";
import { draftScript, parseScript, synthesizeAndStitch } from "@/lib/podcast";

export const runtime = "nodejs";

// Tell Next.js this route can take up to 5 minutes — it doesn't (we return
// immediately) but the background task continues running on the server-side
// and we don't want Next.js to consider the function "done" too early in
// some deployment environments.
export const maxDuration = 300;

/**
 * POST /api/notebooks/[id]/podcast
 *
 * Body: { topic?: string, title?: string }
 *   topic — optional focus passed into the script prompt ("focus on X").
 *   title — optional human-readable title; defaults to "Episode <date>".
 *
 * Returns the freshly-inserted podcast row in `scripting` state. Subsequent
 * GETs of the notebook reflect the row's latest status.
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const { topic, title } = (await req.json().catch(() => ({}))) as {
    topic?: string;
    title?: string;
  };

  const notebook = db
    .prepare("SELECT * FROM notebooks WHERE id = ?")
    .get(id) as Notebook | undefined;
  if (!notebook) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const podcastId = uuid();
  const now = Date.now();
  db.prepare(
    "INSERT INTO podcasts (id, notebook_id, title, status, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(
    podcastId,
    id,
    title?.trim() || `Episode ${new Date(now).toLocaleString()}`,
    "scripting",
    now,
  );

  // Fire-and-forget the pipeline. `void (async () => {...})()` is the
  // idiomatic way in Next.js route handlers to launch a task that outlives
  // the response. The function captures `podcastId` so it can write status
  // updates back to the same row.
  void (async () => {
    try {
      // === Step 1: draft script ==============================================
      const script = await draftScript(topic);
      db.prepare(
        "UPDATE podcasts SET script = ?, status = ? WHERE id = ?",
      ).run(script, "synthesizing", podcastId);

      // === Step 2: parse turns ==============================================
      const turns = parseScript(script);
      if (turns.length === 0) {
        // The model ignored the strict HOST:/GUEST: format. Fail loudly
        // rather than synthesizing zero audio and reporting "ready".
        throw new Error(
          "Could not parse any HOST/GUEST turns from script",
        );
      }

      // === Step 3: synthesize and stitch ====================================
      // Output lives under public/podcasts/<id>.mp3 so Next.js serves it
      // statically without us writing a download route.
      const fileName = `${podcastId}.mp3`;
      const outPath = join(process.cwd(), "public", "podcasts", fileName);
      await synthesizeAndStitch(turns, outPath);

      db.prepare(
        "UPDATE podcasts SET status = ?, audio_url = ? WHERE id = ?",
      ).run("ready", `/podcasts/${fileName}`, podcastId);
    } catch (err) {
      // Any failure — script empty, parse failed, ElevenLabs 402 — gets
      // serialized into the row so the UI can display it. The user never
      // sees a silent failure.
      db.prepare(
        "UPDATE podcasts SET status = ?, error = ? WHERE id = ?",
      ).run(
        "failed",
        err instanceof Error ? err.message : String(err),
        podcastId,
      );
    }
  })();

  const podcast = db
    .prepare("SELECT * FROM podcasts WHERE id = ?")
    .get(podcastId) as Podcast;
  return NextResponse.json({ podcast });
}
