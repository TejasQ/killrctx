// ============================================================================
// /api/notebooks/[id]/podcasts/[podcastId] — delete one podcast episode
// ============================================================================
//
// _Basically_, the bulk-delete action in the Studio panel calls DELETE here
// once per selected podcast. We remove the SQLite row and, if a rendered
// audio file exists on disk, delete that too so we don't accumulate orphaned
// mp3 files under public/podcasts/.
//
// The audio file delete is best-effort: we swallow ENOENT (file was never
// created — e.g. the episode failed during scripting) and any other IO error
// so the row is always cleaned up regardless of disk state.
// ============================================================================

import { NextResponse } from "next/server";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import db, { Podcast } from "@/lib/db";

export const runtime = "nodejs";

/** DELETE /api/notebooks/[id]/podcasts/[podcastId] */
export async function DELETE(
  _: Request,
  ctx: { params: Promise<{ id: string; podcastId: string }> },
) {
  const { id, podcastId } = await ctx.params;

  const podcast = db
    .prepare("SELECT * FROM podcasts WHERE id = ? AND notebook_id = ?")
    .get(podcastId, id) as Podcast | undefined;
  if (!podcast) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Drop the row first so the Studio panel reflects the user's intent even
  // if the file cleanup below fails.
  db.prepare("DELETE FROM podcasts WHERE id = ?").run(podcastId);

  // Clean up the audio file if one was written. The pattern
  // `/podcasts/<id>.mp3` is set by the podcast generation route.
  if (podcast.audio_url) {
    // basename() strips any path components so a malformed audio_url like
    // "/podcasts/../../etc/passwd" can't escape the public/podcasts/ directory.
    const { basename } = await import("node:path");
    const safeFilename = basename(podcast.audio_url);
    const filePath = join(process.cwd(), "public", "podcasts", safeFilename);
    try {
      unlinkSync(filePath);
    } catch {
      // ENOENT or any other IO error — swallow. The row is already gone.
    }
  }

  return NextResponse.json({ ok: true });
}
