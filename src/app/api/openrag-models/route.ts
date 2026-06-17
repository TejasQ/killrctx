// ============================================================================
// /api/openrag-models — list available models grouped by configured provider
// ============================================================================
//
// _Basically_, this route fans out to OpenRAG's per-provider model endpoints
// and returns everything in one grouped payload the picker popover can render.
//
// We call `settings.get()` first to know which providers are configured, then
// fire one `getModelsForProvider()` call per configured provider in parallel.
// Providers that fail or return empty lists are silently omitted — one broken
// provider shouldn't block the others from appearing.
//
// The browser never needs to know the OpenRAG URL; it stays server-side here.
// ============================================================================

import { NextResponse } from "next/server";
import { getModelsForProvider, type ModelOption } from "@/lib/openrag";
import { OpenRAGClient } from "openrag-sdk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Display labels for each provider slug.
const PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  ollama: "Ollama",
  watsonx: "IBM watsonx.ai",
};

export type ModelGroup = {
  provider: string;
  label: string;
  language_models: ModelOption[];
  embedding_models: ModelOption[];
};

export async function GET() {
  // Read the raw settings to find which providers are configured.
  // The SDK's SettingsResponse doesn't include the providers map, so we reach
  // into the client's internal _request helper the same way the health route
  // does — via a raw fetch to OPENRAG_URL/settings.
  const base = process.env.OPENRAG_URL ?? "http://localhost:3000";

  let configuredProviders: string[] = [];
  try {
    const res = await fetch(`${base}/settings`, { cache: "no-store" });
    if (res.ok) {
      const s = (await res.json()) as {
        providers?: Record<string, { configured?: boolean }>;
      };
      configuredProviders = Object.entries(s.providers ?? {})
        .filter(([, v]) => v.configured === true)
        .map(([k]) => k);
    }
  } catch {
    // If we can't reach settings, fall through with empty list.
  }

  // Always include the current provider even if not in the configured map,
  // so the picker isn't empty on external instances that don't expose /settings.
  // probeSettings() uses the SDK client internally.
  try {
    const sdk = new OpenRAGClient({
      baseUrl: process.env.OPENRAG_URL ?? "http://localhost:3000",
      apiKey: process.env.OPENRAG_API_KEY,
    });
    const current = await sdk.settings.get();
    const currentLlmProvider = current.agent.llm_provider;
    const currentEmbProvider = current.knowledge.embedding_provider;
    for (const p of [currentLlmProvider, currentEmbProvider]) {
      if (p && !configuredProviders.includes(p)) configuredProviders.push(p);
    }
  } catch {
    // best-effort
  }

  if (configuredProviders.length === 0) {
    return NextResponse.json({ groups: [] });
  }

  // Fetch all providers in parallel; silently drop failures.
  const results = await Promise.allSettled(
    configuredProviders.map(async (provider) => {
      const models = await getModelsForProvider(provider);
      return { provider, models };
    }),
  );

  const groups: ModelGroup[] = [];
  for (const result of results) {
    if (result.status === "rejected") continue;
    const { provider, models } = result.value;
    // Omit providers that returned no models at all.
    if (models.language_models.length === 0 && models.embedding_models.length === 0) continue;
    groups.push({
      provider,
      label: PROVIDER_LABELS[provider] ?? provider,
      language_models: models.language_models,
      embedding_models: models.embedding_models,
    });
  }

  return NextResponse.json({ groups });
}
