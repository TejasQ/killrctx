// ============================================================================
// HealthGate.tsx — block the UI until the OpenRAG backend is ready
// ============================================================================
//
// _Basically_, OpenSearch + Langflow + the OpenRAG backend take 30-90
// seconds to boot. If we let users start clicking around before the
// backend is healthy, every click hits a 502 and the app feels broken.
// This component sits at the root of the layout tree and renders a
// status panel until /api/health says everything's ready.
//
// Four states the gate shows:
//   1. **Connecting**  First probe in flight — we don't know anything yet.
//   2. **Booting**     Local install detected; OpenSearch is still warming up.
//                      Shows a spinner and "Waiting for local OpenRAG…".
//   3. **Needs setup** Local install reachable but no models configured yet.
//                      Shows "Run one-time setup" button.
//   4. **Ready**       Pass through to children. If external=true, skipped
//                      the booting phase entirely.
//
// Why poll instead of streaming with SSE/WebSockets?
//   The 2s tick is fine for a startup probe, doesn't need a long-lived
//   connection through Next.js' dev proxy, and the ref-based cleanup makes
//   it survive Strict Mode's double-effect dance.
// ============================================================================

"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Spinner from "./Spinner";

type Settings = { llm: string; embedding: string };
type Health =
  | { ready: true; external?: boolean; settings: Settings }
  | {
      ready: false;
      reason: string;
      // Local install reachable + API key loaded but models not selected.
      needsSetup?: boolean;
      // Nothing reachable yet — keep polling.
      booting?: boolean;
      settings?: Settings;
    };

export default function HealthGate({ children }: { children: ReactNode }) {
  const [health, setHealth] = useState<Health | null>(null);
  const [setupRunning, setSetupRunning] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);

  // `useRef` (not state) for the cancellation flag — we read it inside an
  // async tick that may resolve after the component unmounts. State updates
  // post-unmount would warn; a ref read is silent.
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick() {
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        const data = (await res.json()) as Health;
        if (cancelledRef.current) return;
        setHealth(data);
        // Schedule the next tick only if we're not already ready. Once
        // ready, we stop polling forever (no need to keep checking).
        if (!data.ready) timer = setTimeout(tick, 2000);
      } catch {
        // Network error or non-JSON response — treat as "still booting"
        // and try again in 2s.
        if (cancelledRef.current) return;
        setHealth({ ready: false, reason: "Health check failed" });
        timer = setTimeout(tick, 2000);
      }
    }

    tick();
    return () => {
      cancelledRef.current = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  // POST /api/setup — installs default LLM + embedding model in OpenRAG
  // by calling its /onboarding endpoint. The next health-tick will pick
  // up the new configuration and the gate will dismiss automatically.
  async function runSetup() {
    setSetupRunning(true);
    setSetupError(null);
    try {
      const res = await fetch("/api/setup", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!data.ok) {
        throw new Error(data.error ?? `setup failed (${res.status})`);
      }
    } catch (e) {
      setSetupError(e instanceof Error ? e.message : "setup failed");
    } finally {
      setSetupRunning(false);
    }
  }

  if (!health || !health.ready) {
    const needsSetup = health && !health.ready && health.needsSetup === true;
    // First probe still in flight — show a neutral connecting message.
    const connecting = health === null;
    // Booting = local install detected, OpenSearch warming up.
    const booting = health && !health.ready && health.booting === true;

    return (
      <div className="flex min-h-screen items-center justify-center bg-ink p-8">
        <div className="w-full max-w-md rounded-lg border border-edge bg-panel p-6 text-sm">
          <div className="mb-2 flex items-center gap-2 text-amber-300">
            <Spinner size="sm" />
            <span className="font-medium">
              {connecting
                ? "Connecting to OpenRAG…"
                : booting
                  ? "Waiting for local OpenRAG to start…"
                  : needsSetup
                    ? "OpenRAG needs one-time setup"
                    : "Connecting to OpenRAG…"}
            </span>
          </div>
          <p className="text-xs text-muted">
            {connecting
              ? "Probing /api/health…"
              : health?.reason}
          </p>
          {health && "settings" in health && health.settings && (
            <dl className="mt-4 space-y-1 text-xs text-muted">
              <div>
                <dt className="inline font-semibold">LLM:</dt>{" "}
                <dd className="inline">{health.settings.llm}</dd>
              </div>
              <div>
                <dt className="inline font-semibold">Embedding:</dt>{" "}
                <dd className="inline">{health.settings.embedding}</dd>
              </div>
            </dl>
          )}
          {needsSetup && (
            <div className="mt-4">
              <button
                onClick={runSetup}
                disabled={setupRunning}
                className="flex w-full items-center justify-center gap-2 rounded-md bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {setupRunning && <Spinner size="sm" />}
                {setupRunning ? "Configuring…" : "Run one-time setup"}
              </button>
              {setupError && (
                <p className="mt-2 rounded border border-red-900/50 bg-red-950/30 p-2 text-xs text-red-300">
                  {setupError}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
