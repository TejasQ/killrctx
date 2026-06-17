// ============================================================================
// /api/openrag-settings — update the active LLM or embedding model in OpenRAG
// ============================================================================
//
// _Basically_, the ModelPickerPopover calls this whenever the user picks a
// different model. We forward the selection to OpenRAG via the SDK, then
// re-read the confirmed values and return them so the caller can update the
// header label and Sources panel in one round-trip.
// ============================================================================

import { NextResponse } from "next/server";
import { updateSettings } from "@/lib/openrag";

export const runtime = "nodejs";

export async function PATCH(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    kind: "llm" | "embedding";
    provider: string;
    model: string;
  } | null;

  if (!body || !body.kind || !body.provider || !body.model) {
    return NextResponse.json({ error: "kind, provider, and model are required" }, { status: 400 });
  }

  try {
    const updated =
      body.kind === "llm"
        ? await updateSettings({ llm_provider: body.provider, llm_model: body.model })
        : await updateSettings({ embedding_provider: body.provider, embedding_model: body.model });

    return NextResponse.json(updated);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "failed to update settings";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
