// ============================================================================
// SourceCitation.tsx — expandable source pills showing all retrieved chunks
// ============================================================================
//
// _Basically_, after OpenRAG answers a question it tells us which document
// chunks it retrieved. This component groups them by filename (one pill per
// file) and expands to show every retrieved passage from that file when
// clicked — so the user can read the exact evidence the agent used.
//
// Grouping and score-sorting happen here (groupSourcesByFile). The caller
// passes the raw Source[] as-is from the SourcesEvent.
// ============================================================================

"use client";

import { useState } from "react";
import type { Source } from "openrag-sdk";

// Map MIME type strings to a single representative emoji.
function mimetypeIcon(mimetype: string | null | undefined): string {
  if (!mimetype) return "📎";
  if (mimetype.includes("pdf"))                                                         return "📄";
  if (mimetype.includes("csv") || mimetype.includes("spreadsheet") || mimetype.includes("excel")) return "📊";
  if (mimetype.includes("presentation") || mimetype.includes("pptx") || mimetype.includes("powerpoint")) return "📑";
  if (mimetype.includes("word") || mimetype.includes("docx"))                          return "📝";
  return "📎";
}

// Group all chunks by filename, sorted by score descending within each file.
function groupSourcesByFile(sources: Source[]): [string, Source[]][] {
  const grouped = new Map<string, Source[]>();
  for (const s of sources) {
    const existing = grouped.get(s.filename);
    if (existing) existing.push(s);
    else grouped.set(s.filename, [s]);
  }
  for (const chunks of grouped.values()) {
    chunks.sort((a, b) => b.score - a.score);
  }
  return Array.from(grouped.entries());
}

function SourcePill({ filename, chunks }: { filename: string; chunks: Source[] }) {
  const [open, setOpen] = useState(false);
  // Use the best-scoring chunk for the pill's mimetype icon.
  const best = chunks[0];

  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        title={`click to ${open ? "hide" : "show"} ${chunks.length === 1 ? "passage" : `${chunks.length} passages`}`}
        className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] transition-colors
          ${open
            ? "border-accent/40 bg-accent/10 text-accent"
            : "border-edge bg-ink text-muted hover:border-accent/30 hover:text-white"
          }`}
      >
        <span aria-hidden="true">{mimetypeIcon(best.mimetype)}</span>
        {filename}
        {chunks.length > 1 && (
          <span className="ml-0.5 rounded bg-edge px-1 text-[10px] text-muted/70">{chunks.length}</span>
        )}
        <span className="ml-0.5 opacity-50">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="mt-1.5 flex flex-col gap-1.5">
          {chunks.map((chunk, i) => (
            <div
              key={i}
              className="rounded border border-edge bg-ink/60 px-3 py-2 text-[11px] leading-relaxed text-muted"
            >
              {/* Passage header: score + page if available */}
              {chunk.page != null && (
                <div className="mb-1 text-[10px] text-muted/50">p.{chunk.page}</div>
              )}
              <div className="whitespace-pre-wrap">{chunk.text}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function SourceCitation({ sources }: { sources: Source[] }) {
  if (sources.length === 0) return null;

  const grouped = groupSourcesByFile(sources);

  return (
    <div className="mt-3 border-t border-edge pt-2">
      <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-muted/60">
        Sources
      </span>
      <div className="flex flex-wrap gap-1.5">
        {grouped.map(([filename, chunks]) => (
          <SourcePill key={filename} filename={filename} chunks={chunks} />
        ))}
      </div>
    </div>
  );
}
