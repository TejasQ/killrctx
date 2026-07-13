// ============================================================================
// /api/health — per-backend liveness probes for OpenRAG and AI Workbench
// ============================================================================
//
// _Basically_, this route tells the UI which backends are currently reachable
// so it can show an offline banner and disable write actions. It probes every
// configured backend in parallel and returns one status object per backend.
//
// Response shape:
//   {
//     openrag:   { ok: boolean, url: string } | null,  // null = env var not set
//     workbench: { ok: boolean, url: string } | null,
//   }
//
// "null" means the backend is not configured (env var absent or empty).
// "{ ok: false }" means configured but unreachable (timeout, non-2xx).
// "{ ok: true  }" means the probe returned 2xx.
// ============================================================================

import { NextResponse } from "next/server";

export const runtime = "nodejs";
// force-dynamic so Next.js never caches this — we want a real probe every poll.
export const dynamic = "force-dynamic";

const PROBE_TIMEOUT_MS = 3_000;

async function probe(url: string, path: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}${path}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function GET() {
  const openragUrl   = (process.env.OPENRAG_URL   ?? "").replace(/\/$/, "");
  const workbenchUrl = (process.env.WORKBENCH_URL ?? "").replace(/\/$/, "");

  // Probe both in parallel — neither waits for the other.
  const [openragOk, workbenchOk] = await Promise.all([
    openragUrl   ? probe(openragUrl,   "/health")  : Promise.resolve(false),
    workbenchUrl ? probe(workbenchUrl, "/healthz") : Promise.resolve(false),
  ]);

  return NextResponse.json({
    openrag:   openragUrl   ? { ok: openragOk,   url: openragUrl   } : null,
    workbench: workbenchUrl ? { ok: workbenchOk, url: workbenchUrl } : null,
  });
}
