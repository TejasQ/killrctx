// ============================================================================
// /api/health — is the OpenRAG backend ready to serve requests?
// ============================================================================
//
// _Basically_, the HealthGate client component polls this endpoint every 2s
// at startup. We use a dual-mode strategy to handle both local installs and
// external instances:
//
//   Local install (npm run openrag:up):
//     OPENRAG_INSTALL_URL (:8000) is reachable. We probe it with a raw fetch
//     because we need providers[].has_api_key from the response — the SDK
//     strips that field. This lets us distinguish "needs setup" from "no key".
//     Returns one of three states:
//       { ready: true }              — models configured, gate dismisses
//       { ready: false, needsSetup } — models missing, show setup button
//       { ready: false, booting }    — OpenSearch still warming up
//
//   External instance (remote/cloud/standard OpenRAG):
//     OPENRAG_INSTALL_URL is unreachable (port 8000 not published). We fall
//     back to client.settings.get() via OPENRAG_URL (:3000). If it responds,
//     the instance is operator-managed and we trust it's configured — report
//     ready: true immediately. If it also fails, report booting.
//
// See specs/openrag-sdk-migration/design.md — "Health check dual-mode strategy"
// for the full rationale.
// ============================================================================

import { NextResponse } from "next/server";
import { probeSettings } from "@/lib/openrag";

export const runtime = "nodejs";
// `dynamic = force-dynamic` opts out of Next.js' static caching — we
// genuinely want a fresh probe on every poll.
export const dynamic = "force-dynamic";

const installUrl = process.env.OPENRAG_INSTALL_URL ?? "http://localhost:8000";

export async function GET() {
  // ── Path 1: local install probe ─────────────────────────────────────────
  // Not using SDK: the raw /settings response includes providers[].has_api_key,
  // which the SDK's SettingsResponse strips out. We need that field to decide
  // whether to show "Run setup" vs "set your API key" in the HealthGate UI.
  try {
    const res = await fetch(`${installUrl}/settings`, {
      cache: "no-store",
      // Fail fast so we don't block the 2s poll cycle waiting for a port
      // that will never answer (external instance case).
      signal: AbortSignal.timeout(3_000),
    });

    if (res.ok) {
      const s = (await res.json()) as {
        agent?: { llm_model?: string; llm_provider?: string };
        knowledge?: { embedding_model?: string; embedding_provider?: string };
        providers?: Record<string, { has_api_key?: boolean }>;
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
    }

    // 5xx from the install URL — OpenSearch is probably still warming up.
    return NextResponse.json(
      { ready: false, booting: true, reason: `OpenRAG starting up (HTTP ${res.status})` },
      { status: 503 },
    );
  } catch {
    // Path 1 failed (connection refused, timeout) — not a local install.
    // Fall through to path 2.
  }

  // ── Path 2: external instance probe ─────────────────────────────────────
  // OPENRAG_INSTALL_URL isn't reachable. Try the SDK endpoint instead.
  // External instances are operator-managed — if settings.get() responds,
  // we trust the instance is configured and let the user in immediately.
  try {
    const settings = await probeSettings();
    return NextResponse.json({ ready: true, external: true, settings });
  } catch {
    // Neither path is reachable — still booting or misconfigured.
    return NextResponse.json(
      { ready: false, booting: true, reason: "OpenRAG is starting up…" },
      { status: 503 },
    );
  }
}
