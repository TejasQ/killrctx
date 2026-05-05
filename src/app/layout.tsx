// ============================================================================
// app/layout.tsx — the root layout, wraps every page
// ============================================================================
//
// _Basically_, this is the outermost shell. It does three things:
//   1. Loads global CSS (Tailwind base + our custom dark palette).
//   2. Sets <head> metadata.
//   3. Wraps `children` in <HealthGate> so no page renders until the
//      OpenRAG backend reports ready. See components/HealthGate.tsx for the
//      gate's three states (booting / needs setup / ready).
//
// Single-language `<html lang="en">` — if you ever ship localized content,
// flip this dynamically based on the request locale.
// ============================================================================

import "./globals.css";
import type { ReactNode } from "react";
import HealthGate from "@/components/HealthGate";

export const metadata = {
  title: "killrctx",
  description: "Self-hosted RAG notebooks with AI podcast generation.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/* Every route in the app is gated behind OpenRAG readiness. */}
        <HealthGate>{children}</HealthGate>
      </body>
    </html>
  );
}
