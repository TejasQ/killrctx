// ============================================================================
// /api/podcasts/[id] — read a single podcast row
// ============================================================================
//
// _Basically_, this exists for the rare case where you want to poll one
// specific podcast without pulling the whole notebook. Today the UI uses
// the bundled /api/notebooks/[id] endpoint instead (which returns all
// podcasts for the notebook), so this route isn't strictly necessary —
// but it's cheap to keep and useful if you build a "share episode" link
// or a standalone player page later.
// ============================================================================

import { NextResponse } from "next/server";
import db, { Podcast } from "@/lib/db";

export const runtime = "nodejs";

/** GET /api/podcasts/[id] — single-row lookup. */
export async function GET(
  _: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const podcast = db
    .prepare("SELECT * FROM podcasts WHERE id = ?")
    .get(id) as Podcast | undefined;
  if (!podcast) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ podcast });
}
