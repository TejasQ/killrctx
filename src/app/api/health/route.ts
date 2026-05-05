// ============================================================================
// /api/health — is the OpenRAG backend ready to serve requests?
// ============================================================================
//
// _Basically_, the HealthGate client component polls this endpoint every 2s
// at startup. We answer with one of three things:
//
//   { ready: true, settings: {...} }
//     OpenRAG is up *and* has both an LLM and an embedding model configured.
//     The UI dismisses the gate.
//
//   { ready: false, booting: true, reason: "..." }
//     We can't reach OpenRAG yet (network error, 503, timeout). OpenSearch
//     is probably still warming up. Keep polling.
//
//   { ready: false, needsSetup: true, reason: "..." }
//     OpenRAG is reachable, has an OPENAI_API_KEY loaded, but no models
//     have been selected yet. The user needs to click "Run one-time setup"
//     which POSTs /api/setup -> OpenRAG /onboarding.
//
// The whole gating concept exists because OpenSearch can take 30-90 seconds
// to boot, and during that window every chat/upload would 502. Showing a
// "Waiting for backend…" panel beats showing a broken app.
// ============================================================================

import { NextResponse } from "next/server";

export const runtime = "nodejs";
// `dynamic = force-dynamic` opts out of Next.js' static caching — we
// genuinely want a fresh probe on every poll.
export const dynamic = "force-dynamic";

const baseUrl = process.env.OPENRAG_URL ?? "http://localhost:8000";

export async function GET() {
  try {
    // No timeout here — we used to set 15s, but on slow OpenSearch boots
    // the request can sit waiting for several seconds and we'd rather wait
    // than retry-storm. The HealthGate's 2s interval naturally limits us.
    const res = await fetch(`${baseUrl}/settings`, { cache: "no-store" });

    if (!res.ok) {
      // 5xx from OpenRAG means it's reachable but not ready (still
      // initializing). Treat as a "booting" state, not a hard failure.
      return NextResponse.json(
        {
          ready: false,
          booting: true,
          reason: `OpenRAG starting up (HTTP ${res.status})`,
        },
        { status: 503 },
      );
    }

    const s = (await res.json()) as {
      agent?: { llm_model?: string; llm_provider?: string };
      knowledge?: { embedding_model?: string; embedding_provider?: string };
      providers?: Record<
        string,
        { has_api_key?: boolean; configured?: boolean }
      >;
    };

    const llmModel = s.agent?.llm_model?.trim();
    const llmProvider = s.agent?.llm_provider?.trim();
    const embModel = s.knowledge?.embedding_model?.trim();
    const embProvider = s.knowledge?.embedding_provider?.trim();

    // Without an API key on the provider, no amount of clicking will fix
    // anything — the user has to set OPENAI_API_KEY in .env and restart
    // docker compose. We surface that distinction so the UI shows the
    // right message instead of a useless "Run setup" button.
    const providerHasKey =
      !!llmProvider && s.providers?.[llmProvider]?.has_api_key === true;

    if (!llmModel || !embModel || !embProvider) {
      return NextResponse.json(
        {
          ready: false,
          needsSetup: providerHasKey,
          reason: !providerHasKey
            ? `OpenRAG provider ${llmProvider ?? "openai"} has no API key — set OPENAI_API_KEY in .env and restart docker compose`
            : "OpenRAG models not selected",
          settings: {
            llm: `${llmProvider ?? "?"}/${llmModel ?? "?"}`,
            embedding: `${embProvider ?? "?"}/${embModel ?? "?"}`,
          },
        },
        { status: 503 },
      );
    }

    return NextResponse.json({
      ready: true,
      settings: {
        llm: `${llmProvider}/${llmModel}`,
        embedding: `${embProvider}/${embModel}`,
      },
    });
  } catch {
    // fetch() throws on connection refused, DNS failure, etc — these are
    // all "OpenRAG isn't even up yet" cases, so we report booting.
    return NextResponse.json(
      { ready: false, booting: true, reason: "OpenRAG is starting up…" },
      { status: 503 },
    );
  }
}
