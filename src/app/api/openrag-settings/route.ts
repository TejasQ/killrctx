// ============================================================================
// /api/openrag-settings — read or update the active LLM or embedding model
// ============================================================================
//
// _Basically_, the ModelPickerPopover calls PATCH here whenever the user picks
// a different model. GET is called on notebook page load so the model picker
// labels show the current model instead of staying hidden until after a save.
// ============================================================================

import { NextResponse } from "next/server";
import { probeSettings, updateSettings } from "@/lib/openrag";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const settings = await probeSettings();
    return NextResponse.json(settings);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "failed to read settings";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}

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
