// ============================================================================
// /api/notebooks/[id]/filter-meta — update the filter's icon and color
// ============================================================================
//
// _Basically_, when the user picks a new icon or color in FilterPickerPopover,
// this route saves it to OpenRAG and caches the result in SQLite so the next
// GET /api/notebooks/[id] returns the fresh values immediately.
//
// Why a separate route instead of PATCH /api/notebooks/[id]?
//   The existing PATCH only handles title rename. Keeping filter-meta separate
//   keeps both routes tiny and obvious about what they change.
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import db, { type Notebook } from "@/lib/db";
import { updateFilterMeta } from "@/lib/openrag";

export const runtime = "nodejs";

/**
 * PATCH /api/notebooks/[id]/filter-meta
 *
 * Body: { icon: string, color: string }
 *
 * Saves the icon and color to OpenRAG then updates the SQLite cache.
 * Returns { icon, color } so the caller can update local state without
 * waiting for the next full GET refresh.
 */
export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const { icon, color } = (await req.json()) as { icon?: string; color?: string };

  if (!icon || !color) {
    return NextResponse.json({ error: "icon and color are required" }, { status: 400 });
  }

  const notebook = db
    .prepare("SELECT openrag_filter_id FROM notebooks WHERE id = ?")
    .get(id) as Pick<Notebook, "openrag_filter_id"> | undefined;

  if (!notebook) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (!notebook.openrag_filter_id) {
    return NextResponse.json({ error: "notebook has no filter" }, { status: 400 });
  }

  await updateFilterMeta(notebook.openrag_filter_id, icon, color);

  // Keep SQLite cache in sync so the next GET returns fresh values immediately.
  db.prepare(
    "UPDATE notebooks SET openrag_filter_icon = ?, openrag_filter_color = ? WHERE id = ?",
  ).run(icon, color, id);

  return NextResponse.json({ icon, color });
}
