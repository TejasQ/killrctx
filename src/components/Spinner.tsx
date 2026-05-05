// ============================================================================
// Spinner.tsx — the one and only loading indicator in the app
// ============================================================================
//
// _Basically_, an SVG circle with a CSS rotation animation. Used wherever a
// background operation is in flight — file upload, chat send, podcast
// scripting, podcast synthesis, health-gate boot wait, etc.
//
// Why SVG and not a `<div className="animate-spin">`?
//   - Crisp at any size — vector, no aliasing.
//   - One element with `currentColor`, so it inherits the surrounding text
//     colour automatically (white in panels, accent-purple on buttons,
//     amber on the health gate).
//   - The dasharray/dashoffset trick gives the classic "arc rotating around
//     a circle" look that reads as "working" instantly. Pure CSS, no JS.
// ============================================================================

import type { SVGProps } from "react";

export type SpinnerSize = "xs" | "sm" | "md";

const sizes: Record<SpinnerSize, number> = {
  xs: 12,
  sm: 16,
  md: 20,
};

export default function Spinner({
  size = "sm",
  ...rest
}: { size?: SpinnerSize } & Omit<SVGProps<SVGSVGElement>, "size">) {
  const px = sizes[size];
  return (
    <svg
      role="status"
      aria-label="Loading"
      width={px}
      height={px}
      viewBox="0 0 24 24"
      fill="none"
      // `animate-spin` is Tailwind's built-in 1s linear infinite rotation.
      // `currentColor` lets us inherit text color from the parent.
      className="animate-spin"
      {...rest}
    >
      {/* faint full circle for a subtle "track" behind the moving arc */}
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
      {/* the visible arc — strokeDasharray sets a 60° arc, the rest is dash */}
      <path
        d="M 21 12 a 9 9 0 0 0 -9 -9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
