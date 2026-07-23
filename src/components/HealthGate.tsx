// ============================================================================
// HealthGate.tsx — non-blocking offline banner + OpenRAG settings context
// ============================================================================
//
// _Basically_, this replaced the old full-viewport loading gate. The app now
// loads immediately regardless of backend state. This component:
//   1. Provides OpenRAGContext to the whole tree (settings start null; the
//      notebook page populates them via ModelPickerPopover saves).
//   2. Shows a slim amber banner at the top of every page when at least one
//      configured backend is offline. The banner disappears automatically when
//      the next poll succeeds (every 30 s via useBackendHealth).
//
// Why keep this as a wrapper instead of moving the banner into layout.tsx?
//   OpenRAGContext.Provider needs to wrap {children} so the notebook page can
//   read settings from any depth. Combining both responsibilities here keeps
//   layout.tsx clean.
// ============================================================================

"use client";

import { useState, type ReactNode } from "react";
import { OpenRAGContext, type OpenRAGSettings } from "./OpenRAGContext";
import { useBackendHealth } from "@/hooks/useBackendHealth";

export default function HealthGate({ children }: { children: ReactNode }) {
  // Holds model names set by ModelPickerPopover after a save. Starts null
  // (nothing to show) which is fine — the popover handles the null case.
  const [liveSettings, setLiveSettings] = useState<OpenRAGSettings | null>(null);
  // Dismissed per session — user clicked ✕. Resets on app restart.
  const [dismissed, setDismissed] = useState(false);

  const health = useBackendHealth();

  // Build the banner message from whichever configured backends are down.
  // "unknown" = first poll not yet back — don't show a false alarm banner.
  // "unconfigured" = env var not set — not an error, don't warn about it.
  const openragDown   = health.openrag   === "down";
  const workbenchDown = health.workbench === "down";

  // Only show the banner when at least one backend is confirmed down and the
  // user hasn't dismissed it this session. Auto-clears when health recovers
  // (the next successful poll will set a backend back to "up", making
  // showBanner false — which also resets dismissed so it can re-appear if
  // the backend goes down again).
  const bothDown = openragDown && workbenchDown;
  const showBanner = !dismissed && (openragDown || workbenchDown);

  // If health recovered while dismissed, clear the dismiss flag so the banner
  // can appear again on the next outage.
  const healthRecovered = !openragDown && !workbenchDown;
  if (dismissed && healthRecovered) setDismissed(false);

  let bannerText = "";
  if (showBanner) {
    if (bothDown) {
      bannerText = "OpenRAG and AI Workbench are offline — read-only mode";
    } else if (openragDown) {
      bannerText = "OpenRAG is offline — read-only mode";
    } else {
      bannerText = "AI Workbench is offline — read-only mode";
    }
  }

  return (
    <OpenRAGContext.Provider value={{ settings: liveSettings, setSettings: setLiveSettings }}>
      {showBanner && (
        <div className="relative flex items-center justify-center bg-amber-900/70 px-4 py-2 text-xs font-medium text-amber-200">
          {bannerText}
          <button
            onClick={() => setDismissed(true)}
            title="Dismiss"
            className="absolute right-3 top-1/2 -translate-y-1/2 text-amber-400 hover:text-amber-100"
          >
            ✕
          </button>
        </div>
      )}
      {children}
    </OpenRAGContext.Provider>
  );
}
