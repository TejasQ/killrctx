// ============================================================================
// /api/setup — one-time OpenRAG configuration
// ============================================================================
//
// _Basically_, this endpoint installs the default LLM + embedding model into
// the OpenRAG backend by calling its `/onboarding` route. It's the click
// target for the "Run one-time setup" button on the HealthGate.
//
// Why this is its own endpoint and not a docker-compose env var:
//   The choice of LLM/embedding model has to be written to OpenRAG's
//   internal settings store (so it persists across restarts and is visible
//   to the agent at request time). The only API for that is /onboarding.
//   We could have shelled out from the docker entrypoint, but a one-click
//   button at first launch is friendlier — especially because users may
//   want to change the model later without re-running compose.
//
// The "treat partial failure as success" trick:
//   /onboarding ALSO tries to push variables into Langflow as a side effect,
//   which usually fails on first boot (Langflow API key generation is
//   fragile; see comments in the upstream openrag-backend). The model
//   selection itself lands in /settings even when the Langflow step fails.
//   So we don't trust the HTTP status — we re-read /settings and check
//   whether the models actually got persisted.
// ============================================================================

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const baseUrl = process.env.OPENRAG_URL ?? "http://localhost:8000";

export async function POST() {
  // Defaults — reasonable for OpenAI free-tier credits. Override via env
  // if you'd rather use gpt-4o or a different embedding model.
  const llmProvider = "openai";
  const llmModel = process.env.OPENRAG_DEFAULT_LLM ?? "gpt-4o-mini";
  const embeddingProvider = "openai";
  const embeddingModel =
    process.env.SELECTED_EMBEDDING_MODEL ?? "text-embedding-3-small";

  try {
    // 120s timeout — /onboarding internally retries Langflow API-key
    // generation up to 15 times with backoff, which can take a while.
    const res = await fetch(`${baseUrl}/onboarding`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        llm_provider: llmProvider,
        llm_model: llmModel,
        embedding_provider: embeddingProvider,
        embedding_model: embeddingModel,
      }),
      signal: AbortSignal.timeout(120_000),
    });

    // Verify by re-reading /settings. The fields we care about are
    // agent.llm_model and knowledge.embedding_model — if both are set,
    // the chat path will work regardless of what /onboarding returned.
    const verify = await fetch(`${baseUrl}/settings`, { cache: "no-store" });
    const settings = (await verify.json().catch(() => ({}))) as {
      agent?: { llm_model?: string };
      knowledge?: { embedding_model?: string };
    };
    const persisted =
      !!settings.agent?.llm_model?.trim() &&
      !!settings.knowledge?.embedding_model?.trim();

    if (!persisted) {
      const body = await res.text().catch(() => "");
      return NextResponse.json(
        {
          ok: false,
          error: `setup failed (${res.status}): ${body.slice(0, 500)}`,
        },
        { status: 502 },
      );
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "setup failed" },
      { status: 502 },
    );
  }
}
