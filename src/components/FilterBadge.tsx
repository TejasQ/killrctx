// ============================================================================
// FilterBadge.tsx — a read-only chip that displays the notebook's filter name
// ============================================================================
//
// _Basically_, every notebook has a dedicated OpenRAG knowledge filter that
// scopes retrieval to only that notebook's documents. This chip shows which
// filter is active so the user knows their chat and Studio are isolated.
//
// Styling follows the reference repo (SonicDMG/rag-to-model-compare) which
// matches OpenRAG's own filter UI. The colour pattern is:
//
//   bg-{color}/10  text-{color}  border-{color}/20   (unselected/display state)
//
// We use teal — the reference repo's default fallback for filters with no
// explicit color set, which is what our queryData: {} filters produce.
// The funnel SVG path is taken directly from FilterSelector in that repo.
// ============================================================================

export default function FilterBadge({ name }: { name: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-teal-500/20 bg-teal-500/10 px-2.5 py-0.5 text-xs font-medium text-teal-400">
      {/* funnel icon — same SVG path used in rag-to-model-compare's FilterSelector */}
      <svg
        className="h-3 w-3 opacity-70"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z"
        />
      </svg>
      <span className="opacity-60">filter:</span> {name}
    </span>
  );
}
