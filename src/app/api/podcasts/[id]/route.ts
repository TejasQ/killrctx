// ============================================================================
// /api/podcasts/[id] — read a single note row by id
// ============================================================================
//
// _Basically_, this exists for the rare case where you want to poll one
// specific note without pulling the whole notebook. Today the UI uses
// the bundled /api/notebooks/[id] endpoint instead, so this route isn't
// strictly necessary — but it's cheap to keep and useful if you build a
// "share episode" link or a standalone player page later.
// ============================================================================

import { NextResponse } from "next/server";
import db, { Note } from "@/lib/db";

export const runtime = "nodejs";

/** GET /api/podcasts/[id] — single-row lookup. */
export async function GET(
  _: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const note = db
    .prepare("SELECT * FROM notes WHERE id = ?")
    .get(id) as Note | undefined;
  if (!note) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ note });
}
