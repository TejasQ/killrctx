// ============================================================================
// useBackendHealth.ts — polls /api/health and returns per-backend status
// ============================================================================
//
// _Basically_, any component that needs to know whether OpenRAG or Workbench
// is reachable right now calls this hook. It fires once on mount, then re-polls
// every 30 s and immediately on tab focus (so a developer who starts a backend
// after opening the app sees the banner clear within seconds of switching back).
//
// Returns { openrag, workbench } where each value is:
//   'unknown'  — first fetch not yet complete (very brief, renders nothing)
//   'up'       — last probe returned ok: true
//   'down'     — last probe returned ok: false, or backend is not configured
// ============================================================================

"use client";

import { useEffect, useState } from "react";

export type BackendStatus = "unknown" | "up" | "down";

export interface BackendHealth {
  openrag:   BackendStatus;
  workbench: BackendStatus;
}

const POLL_MS = 30_000;

export function useBackendHealth(): BackendHealth {
  const [health, setHealth] = useState<BackendHealth>({
    openrag:   "unknown",
    workbench: "unknown",
  });

  useEffect(() => {
    async function poll() {
      try {
        const res  = await fetch("/api/health", { cache: "no-store" });
        const data = await res.json() as {
          openrag:   { ok: boolean } | null;
          workbench: { ok: boolean } | null;
        };
        setHealth({
          openrag:   data.openrag   == null ? "down" : data.openrag.ok   ? "up" : "down",
          workbench: data.workbench == null ? "down" : data.workbench.ok ? "up" : "down",
        });
      } catch {
        // Network error — treat both as down until the next poll succeeds.
        setHealth({ openrag: "down", workbench: "down" });
      }
    }

    poll();
    const interval = setInterval(poll, POLL_MS);

    // Re-poll immediately when the user switches back to this tab — they may
    // have started a backend while the tab was hidden.
    function onVisible() {
      if (document.visibilityState === "visible") poll();
    }
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return health;
}
