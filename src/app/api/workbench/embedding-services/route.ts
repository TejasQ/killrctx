// ============================================================================
// /api/workbench/embedding-services — list available Workbench embedding services
// ============================================================================
//
// _Basically_, a thin proxy so the browser can populate the embedding service
// picker when creating a Workbench-backed notebook. The browser never talks
// to the Workbench directly — this route does the fetch and returns the list.
// ============================================================================

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const base = process.env.WORKBENCH_URL ?? "http://localhost:8080";
  const wsId = process.env.WORKBENCH_WORKSPACE_ID;
  if (!wsId) {
    return NextResponse.json({ items: [] }, { status: 200 });
  }

  const h: Record<string, string> = {};
  const key = process.env.WORKBENCH_API_KEY;
  if (key) h["Authorization"] = `Bearer ${key}`;

  try {
    const res = await fetch(`${base}/api/v1/workspaces/${wsId}/embedding-services`, {
      headers: h,
      cache: "no-store",
    });
    if (!res.ok) {
      return NextResponse.json({ items: [] }, { status: 200 });
    }
    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ items: [] }, { status: 200 });
  }
}
