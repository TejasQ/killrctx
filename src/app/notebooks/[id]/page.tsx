// ============================================================================
// notebooks/[id]/page.tsx — the three-panel notebook view
// ============================================================================
//
// _Basically_, this is the whole product UI. NotebookLM-style three-column
// layout:
//
//   ┌──────────┬────────────────────┬──────────┐
//   │ Sources  │       Chat         │  Studio  │
//   │  (left)  │     (middle)       │  (right) │
//   └──────────┴────────────────────┴──────────┘
//
// One state hook (`refresh()`) reads the bundled /api/notebooks/[id] payload
// and fans it out into four `useState` lists. Every action in the page —
// upload, send, generate — calls back to `refresh` so the UI stays in sync
// without per-feature optimistic updates.
//
// Why one big page component instead of route-segmented children?
//   The three panels share state (the notebook payload) and need to call
//   each other's refresh. Splitting them into route segments would mean
//   prop-drilling or a context just to share a re-fetch function. One file
//   keeps it readable.
//
// Why `min-h-0` everywhere?
//   Grid/flex children default to `min-height: auto`, which lets their
//   content push them taller than the available row. Without `min-h-0` on
//   the grid + each column, the right sidebar (full of in-progress podcast
//   cards) would push the chat input off-screen. See the bug fix in commit
//   history.
// ============================================================================

"use client";

import React, { use, useEffect, useRef, useState } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import Spinner from "@/components/Spinner";
import { useOpenRAGSettings } from "@/components/OpenRAGContext";
import ModelPickerPopover from "@/components/ModelPickerPopover";
import FilterPickerPopover from "@/components/FilterPickerPopover";
import SourceCitation from "@/components/SourceCitation";
import type { Source } from "openrag-sdk";

// Row shapes returned by /api/notebooks/[id]. These mirror the SQLite types
// in lib/db.ts but only include fields the client actually uses.
type Notebook = { id: string; title: string; openrag_collection: string; openrag_filter_id: string | null; openrag_filter_name: string | null; openrag_filter_icon: string | null; openrag_filter_color: string | null };
type Document = { id: string; filename: string; bytes: number; ingest_status: "indexing" | "ready" | "failed"; ingest_error: string | null };
type Conversation = { id: string; notebook_id: string; title: string; created_at: number };
type Message = { id: string; conversation_id: string | null; role: "user" | "assistant"; content: string; sources_json: string | null };
type Note = {
  id: string;
  type: "podcast" | "summary" | "mindmap" | "outline" | "qa";
  title: string;
  content: string | null;
  status: "pending" | "scripting" | "synthesizing" | "ready" | "failed" | null;
  audio_url: string | null;
  script: string | null;
  error: string | null;
  created_at: number;
};

export default function NotebookPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // Next 15+ delivers `params` as a Promise; React's `use()` unwraps it.
  const { id } = use(params);
  const { settings: openragSettings, setSettings: setOpenragSettings } = useOpenRAGSettings();
  const [notebook, setNotebook] = useState<Notebook | null>(null);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  // Doc IDs the user has checked in the Sources panel. Empty = all docs in scope.
  const [selectedDocIds, setSelectedDocIds] = useState<Set<string>>(new Set());
  const [sourcesCollapsed, setSourcesCollapsed] = useState(false);
  const [sourcesWidth, setSourcesWidth] = useState(280); // px, min 180 max 520
  const [sourcesDragging, setSourcesDragging] = useState(false);
  const [studioCollapsed, setStudioCollapsed] = useState(false);
  const [studioWidth, setStudioWidth] = useState(360); // px, min 280 max 720
  const [studioDragging, setStudioDragging] = useState(false);
  // True while a note is open in full reading view — widens the Studio column.
  const [studioExpanded, setStudioExpanded] = useState(false);

  // Drag-to-resize Sources panel. Called from the handle inside SourcesPanel
  // on mousedown; we attach mousemove/mouseup to the window so the drag stays
  // live even if the cursor moves outside the handle.
  function startSourcesResize(startX: number) {
    const startWidth = sourcesWidth;
    setSourcesDragging(true);
    function onMove(e: MouseEvent) {
      const next = Math.max(180, startWidth + e.clientX - startX);
      setSourcesWidth(next);
    }
    function onUp() {
      setSourcesDragging(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  // Drag-to-resize Studio panel. Handle is on the left edge; dragging left
  // widens the panel so the delta is subtracted rather than added.
  function startStudioResize(startX: number) {
    const startWidth = studioWidth;
    setStudioDragging(true);
    function onMove(e: MouseEvent) {
      const next = Math.max(280, startWidth - (e.clientX - startX));
      setStudioWidth(next);
    }
    function onUp() {
      setStudioDragging(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  // One fetch, five state updates. Called on mount and after every mutating
  // action (upload, chat send, note create, source delete). The bundle
  // endpoint means we don't have a waterfall of parallel fetches.
  async function refresh() {
    const res = await fetch(`/api/notebooks/${id}`);
    if (!res.ok) return;
    const data = await res.json();
    setNotebook(data.notebook);
    setDocuments(data.documents);
    setConversations(data.conversations ?? []);
    // On first load (activeConvId is null), default to the first conversation.
    // On subsequent refreshes, keep whatever the user already selected.
    setActiveConvId((prev) => prev ?? data.conversations?.[0]?.id ?? null);
    setMessages(data.messages);
    setNotes(data.notes);
  }
  useEffect(() => {
    refresh();
  }, [id]);

  // Poll while any podcast note is non-terminal. The interval is cleared as
  // soon as every podcast has hit `ready` or `failed`. Text-based note types
  // generate synchronously so they never need polling.
  useEffect(() => {
    const pending = notes.some(
      (n) => n.type === "podcast" && n.status !== "ready" && n.status !== "failed",
    );
    if (!pending) return;
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [notes]);

  // Poll while any document is still being indexed by OpenRAG. Same pattern
  // as the podcast poller above — clears itself once all documents are settled.
  useEffect(() => {
    const indexing = documents.some((d) => d.ingest_status === "indexing");
    if (!indexing) return;
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [documents]);

  if (!notebook) {
    return <div className="p-8 text-sm text-muted">Loading…</div>;
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-edge px-4 py-3">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-sm text-muted hover:text-white">
            ← Notebooks
          </Link>
          <InlineTitle
            title={notebook.title}
            onSave={async (newTitle) => {
              const res = await fetch(`/api/notebooks/${id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ title: newTitle }),
              });
              if (res.ok) {
                const { notebook: updated } = await res.json();
                setNotebook(updated);
              }
            }}
          />
          {notebook.openrag_filter_name && (
            <FilterPickerPopover
              notebookId={notebook.id}
              name={notebook.openrag_filter_name}
              icon={notebook.openrag_filter_icon}
              color={notebook.openrag_filter_color}
              onSaved={(icon, color) =>
                setNotebook((prev) => prev ? { ...prev, openrag_filter_icon: icon, openrag_filter_color: color } : prev)
              }
            />
          )}
        </div>
        <div className="flex items-center gap-4 text-xs text-muted">
          {openragSettings && (
            <ModelPickerPopover
              kind="llm"
              currentValue={openragSettings.llm}
              onSaved={setOpenragSettings}
              align="right"
            >
              <span title="Click to change model">
                model:{" "}
                <span
                  className="animate-rainbow bg-[length:200%_auto] bg-clip-text font-medium text-transparent"
                  style={{
                    backgroundImage:
                      "linear-gradient(90deg, #f87171, #fb923c, #facc15, #4ade80, #60a5fa, #c084fc, #f87171)",
                  }}
                >
                  {openragSettings.llm}
                </span>
              </span>
            </ModelPickerPopover>
          )}
          <span>collection: {notebook.openrag_collection}</span>
        </div>
      </header>

      <div
        style={{
          gridTemplateColumns: `${sourcesCollapsed ? "48px" : `${sourcesWidth}px`} 1fr ${studioCollapsed ? "48px" : studioExpanded ? `${Math.max(studioWidth, 680)}px` : `${studioWidth}px`}`,
          // Only animate during collapse/expand, not while drag-resizing.
          transition: sourcesDragging || studioDragging ? "none" : "grid-template-columns 200ms ease",
        }}
        className="grid min-h-0 flex-1 overflow-hidden"
      >
        <SourcesPanel
          notebookId={id}
          documents={documents}
          onUploaded={refresh}
          embeddingModel={openragSettings?.embedding ?? null}
          onEmbeddingModelSaved={setOpenragSettings}
          collapsed={sourcesCollapsed}
          onToggle={() => setSourcesCollapsed((v) => !v)}
          onResizeDrag={startSourcesResize}
          selectedDocIds={selectedDocIds}
          onSelectionChange={setSelectedDocIds}
        />
        <ChatPanel
          notebookId={id}
          messages={messages}
          conversations={conversations}
          activeConvId={activeConvId}
          onSent={refresh}
          onConvChange={setActiveConvId}
          onConvCreated={(conv) => {
            setConversations((cs) => [...cs, conv]);
            setActiveConvId(conv.id);
          }}
          onConvDeleted={(deletedId, replacement) => {
            if (replacement) {
              setConversations((cs) =>
                cs.map((c) => (c.id === deletedId ? replacement : c)),
              );
              setActiveConvId(replacement.id);
            } else {
              // Derive next active id from the post-delete list in the same
              // updater so we never read the stale `conversations` closure.
              setConversations((cs) => {
                const next = cs.filter((c) => c.id !== deletedId);
                setActiveConvId((prev) =>
                  prev !== deletedId ? prev : (next[0]?.id ?? null),
                );
                return next;
              });
            }
          }}
          onConvRenamed={(convId, title) =>
            setConversations((cs) =>
              cs.map((c) => (c.id === convId ? { ...c, title } : c)),
            )
          }
          selectedFilenames={
            selectedDocIds.size > 0
              ? documents.filter((d) => selectedDocIds.has(d.id)).map((d) => d.filename)
              : []
          }
        />
        <StudioPanel
          notebookId={id}
          notes={notes}
          onCreated={refresh}
          onDeleted={refresh}
          onExpandChange={setStudioExpanded}
          collapsed={studioCollapsed}
          onToggle={() => setStudioCollapsed((v) => !v)}
          onResizeDrag={startStudioResize}
          selectedFilenames={
            selectedDocIds.size > 0
              ? documents.filter((d) => selectedDocIds.has(d.id)).map((d) => d.filename)
              : []
          }
        />
      </div>
    </div>
  );
}

// ============================================================================
// SourcesPanel — left column
// ============================================================================
// The user adds files here. Multi-select is enabled (`multiple` on the file
// input); we upload them sequentially so OpenRAG/Docling never sees a stampede.
// Hover a row to reveal its checkbox; check ≥1 to show the bulk-delete bar.
// ============================================================================
function SourcesPanel({
  notebookId,
  documents,
  onUploaded,
  embeddingModel,
  onEmbeddingModelSaved,
  collapsed,
  onToggle,
  onResizeDrag,
  selectedDocIds,
  onSelectionChange,
}: {
  notebookId: string;
  documents: Document[];
  onUploaded: () => void;
  embeddingModel: string | null;
  onEmbeddingModelSaved: (s: import("@/components/OpenRAGContext").OpenRAGSettings) => void;
  collapsed: boolean;
  onToggle: () => void;
  onResizeDrag: (startX: number) => void;
  selectedDocIds: Set<string>;
  onSelectionChange: (ids: Set<string>) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // File types confirmed to work with Docling ingest. Used for the file
  // picker's accept attribute and to reject unsupported files before they
  // hit the server. Based on the Docling InputFormat enum, minus formats
  // that either errored in practice (gif) or require special pipeline
  // configuration we don't have (audio/asr, obscure XML patent formats).
  const SUPPORTED_EXTENSIONS = new Set([
    ".pdf", ".docx", ".pptx", ".xlsx", ".csv",
    ".md", ".html", ".txt", ".asciidoc",
    ".png", ".jpg", ".jpeg", ".webp", ".tiff",
    ".latex", ".tex",
  ]);
  const ACCEPT = [...SUPPORTED_EXTENSIONS].join(",");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Selection state is lifted to page level so ChatPanel and StudioPanel can
  // scope their queries to checked files. `selectedDocIds` / `onSelectionChange`
  // are passed down as props; rename locally for readability.
  const selected = selectedDocIds;
  const setSelected = onSelectionChange;
  const [deleting, setDeleting] = useState(false);
  // When duplicates are detected, we park the pending files here and show
  // OverwriteDialog. The dialog resolves a Promise with the filenames the
  // user chose to overwrite — upload() awaits that before continuing.
  const [overwritePrompt, setOverwritePrompt] = useState<{
    duplicates: File[];
    resolve: (toOverwrite: File[]) => void;
  } | null>(null);

  function askOverwrite(duplicates: File[]): Promise<File[]> {
    return new Promise((resolve) => setOverwritePrompt({ duplicates, resolve }));
  }

  // Upload files sequentially. The API route accepts one `file` per
  // request, so we loop here rather than batching multipart on the server.
  // Sequential (not parallel) keeps Docling/embedding load predictable on
  // the OpenRAG side and gives us a clean "n of m" progress indicator.
  async function upload(files: File[]) {
    if (files.length === 0) return;
    setError(null);

    // Reject unsupported file types before hitting the server.
    const unsupported = files.filter((f) => {
      const ext = "." + f.name.split(".").pop()?.toLowerCase();
      return !SUPPORTED_EXTENSIONS.has(ext);
    });
    if (unsupported.length > 0) {
      setError(
        `Unsupported file type${unsupported.length > 1 ? "s" : ""}: ${unsupported.map((f) => f.name).join(", ")}`,
      );
      return;
    }

    // Check for duplicates before starting. If any selected files share a
    // filename with an existing source, show OverwriteDialog so the user can
    // pick which ones to overwrite. The API handles overwrite natively —
    // no pre-delete needed; the SQLite row is updated in place.
    const duplicates = files.filter((f) => documents.some((d) => d.filename === f.name));
    let filesToUpload = files;
    if (duplicates.length > 0) {
      const toOverwrite = await askOverwrite(duplicates);
      // Keep non-duplicates + approved overwrites; drop the rest.
      const overwriteNames = new Set(toOverwrite.map((f) => f.name));
      filesToUpload = files.filter(
        (f) => !duplicates.includes(f) || overwriteNames.has(f.name),
      );
    }

    if (filesToUpload.length === 0) return;
    setUploading({ done: 0, total: filesToUpload.length });
    try {
      for (let i = 0; i < filesToUpload.length; i++) {
        const file = filesToUpload[i];
        setUploading({ done: i, total: filesToUpload.length });
        const form = new FormData();
        form.append("file", file);
        const res = await fetch(`/api/notebooks/${notebookId}/documents`, {
          method: "POST",
          body: form,
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(
            `${file.name}: ${data.error ?? `upload failed (${res.status})`}`,
          );
        }
        // Refresh between each file so the user sees sources appear one
        // at a time rather than in a single end-of-batch jump.
        onUploaded();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "upload failed");
    } finally {
      setUploading(null);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function bulkDelete() {
    if (selected.size === 0) return;
    if (!confirm(`Delete ${selected.size} source${selected.size > 1 ? "s" : ""}? This removes their chunks from the index.`))
      return;
    setDeleting(true);
    setDeleteError(null);
    const failed: string[] = [];
    try {
      for (const docId of selected) {
        const res = await fetch(`/api/notebooks/${notebookId}/documents/${docId}`, {
          method: "DELETE",
        });
        if (!res.ok) failed.push(docId);
      }
      if (failed.length > 0) {
        setDeleteError(`${failed.length} source${failed.length > 1 ? "s" : ""} could not be deleted.`);
      }
    } finally {
      setSelected(new Set());
      setDeleting(false);
      onUploaded();
    }
  }

  function toggleSelect(id: string) {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  }

  const allSelected = documents.length > 0 && selected.size === documents.length;

  if (collapsed) {
    return (
      <aside className="flex min-h-0 flex-col items-center border-r border-edge bg-panel py-3 gap-3">
        <button onClick={onToggle} className="text-muted hover:text-white" title="Expand Sources">
          ≡
        </button>
        <span className="text-[10px] text-muted [writing-mode:vertical-rl] rotate-180 tracking-wider uppercase">
          Sources
        </span>
      </aside>
    );
  }

  return (
    <>
    <aside className="relative flex min-h-0 flex-col border-r border-edge bg-panel">
      {/* Drag handle — sits on the right edge, 8px wide so it's easy to grab */}
      <div
        onMouseDown={(e) => { e.preventDefault(); onResizeDrag(e.clientX); }}
        className="absolute right-0 top-0 h-full w-2 cursor-col-resize z-10 hover:bg-accent/20 active:bg-accent/30"
        title="Drag to resize"
      />
      {/* Row 1: title + collapse */}
      <div className="flex h-10 items-center justify-between border-b border-edge px-4">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted">Sources</span>
        <button onClick={onToggle} className="text-xs text-muted hover:text-white" title="Collapse Sources">
          ‹
        </button>
      </div>
      {/* Row 2: embedding model picker */}
      {embeddingModel && (
        <div className="flex items-center border-b border-edge px-4 py-2">
          <ModelPickerPopover
            kind="embedding"
            currentValue={embeddingModel}
            onSaved={onEmbeddingModelSaved}
          >
            <span title="Click to change embedding model" className="text-xs text-muted">
              model:{" "}
              <span
                className="animate-rainbow bg-[length:200%_auto] bg-clip-text font-medium text-transparent"
                style={{
                  backgroundImage:
                    "linear-gradient(90deg, #f87171, #fb923c, #facc15, #4ade80, #60a5fa, #c084fc, #f87171)",
                }}
              >
                {embeddingModel}
              </span>
            </span>
          </ModelPickerPopover>
        </div>
      )}
      {/* Row 3: add source button */}
      <div className="border-b border-edge px-3 py-2">
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            if (files.length) upload(files);
          }}
        />
        <button
          onClick={() => inputRef.current?.click()}
          disabled={!!uploading}
          className="flex w-full items-center justify-center gap-2 rounded-md bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {uploading && <Spinner size="sm" />}
          {uploading
            ? uploading.total > 1
              ? `Uploading ${uploading.done + 1} / ${uploading.total}…`
              : "Uploading…"
            : "+ Add source(s)"}
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {documents.length === 0 ? (
          <p className="text-xs text-muted">
            Upload PDFs, text, or markdown. They go through Docling → OpenSearch and
            become retrievable from chat and podcast generation.
          </p>
        ) : (
          <ul className="space-y-2">
            {documents.map((d) => (
              <li
                key={d.id}
                className="group flex items-center gap-2 rounded-md border border-edge px-3 py-2 text-sm"
              >
                {/* Checkbox — always in the DOM; fades in on hover or when any
                    box is already checked so layout never shifts. Styled to
                    match the dark palette rather than the system native look. */}
                <input
                  type="checkbox"
                  checked={selected.has(d.id)}
                  onChange={() => toggleSelect(d.id)}
                  className={`h-3.5 w-3.5 flex-shrink-0 cursor-pointer appearance-none rounded-sm border border-edge bg-edge transition
                    checked:border-accent checked:bg-accent
                    ${selected.size > 0 ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate">{d.filename}</div>
                  <div className="flex items-center gap-1.5 text-xs text-muted">
                    <span>{(d.bytes / 1024).toFixed(1)} KB</span>
                    {d.ingest_status === "indexing" && (
                      <>
                        <span>·</span>
                        <Spinner size="xs" />
                        <span>Indexing…</span>
                      </>
                    )}
                    {d.ingest_status === "failed" && (
                      <>
                        <span>·</span>
                        <span
                          className="cursor-help text-red-400"
                          title={d.ingest_error ?? "Ingest failed"}
                        >
                          ✕ Failed
                        </span>
                      </>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
        {error && (
          <p className="mt-3 rounded border border-red-900/50 bg-red-950/30 p-2 text-xs text-red-300">
            {error}
          </p>
        )}
      </div>

      {/* Bulk-delete bar — only visible when ≥1 source is selected */}
      {selected.size > 0 && (
        <div className="flex flex-col gap-1 border-t border-edge px-3 py-2">
          {deleteError && (
            <p className="text-xs text-red-300">{deleteError}</p>
          )}
          <div className="flex items-center gap-2">
            <button
              onClick={() =>
                setSelected(allSelected ? new Set() : new Set(documents.map((d) => d.id)))
              }
              className="text-xs text-muted hover:text-white"
            >
              {allSelected ? "Deselect all" : "Select all"}
            </button>
            <button
              onClick={bulkDelete}
              disabled={deleting}
              className="ml-auto flex items-center gap-1.5 rounded-md bg-red-900/60 px-3 py-1.5 text-xs font-medium text-red-200 hover:bg-red-900 disabled:opacity-50"
            >
              {deleting && <Spinner size="xs" />}
              Delete selected ({selected.size})
            </button>
          </div>
        </div>
      )}

    </aside>

    {overwritePrompt && (
      <OverwriteDialog
        duplicates={overwritePrompt.duplicates}
        onDone={(toOverwrite) => {
          overwritePrompt.resolve(toOverwrite);
          setOverwritePrompt(null);
        }}
      />
    )}
    </>
  );
}

// ============================================================================
// markdownComponents — Tailwind-styled element overrides for react-markdown.
// _Basically_, react-markdown renders bare HTML elements by default; without
// these overrides they inherit no visual styling in the dark theme.
// remarkGfm (passed as a plugin at the call site) enables tables, strikethrough,
// and task lists (GitHub Flavored Markdown).
// ============================================================================

// Group all chunks by filename, sorted by score descending within each file.
// Returns a stable-ordered array of [filename, chunks[]] pairs so SourceCitation
// can render one pill per file showing all retrieved passages on expand.
function groupSourcesByFile(sources: Source[]): [string, Source[]][] {
  const grouped = new Map<string, Source[]>();
  for (const s of sources) {
    const existing = grouped.get(s.filename);
    if (existing) existing.push(s);
    else grouped.set(s.filename, [s]);
  }
  // Sort chunks within each file by score descending so the best passage leads.
  for (const chunks of grouped.values()) {
    chunks.sort((a, b) => b.score - a.score);
  }
  return Array.from(grouped.entries());
}

// The LLM sometimes emits blank lines between table rows, which breaks GFM
// table parsing — the parser sees the blank line as ending the block and falls
// back to rendering raw pipe characters. This strips those spurious blank lines
// so the table is contiguous and parses correctly.
function fixMarkdown(raw: string): string {
  return raw
    // Strip "(Source: ...)" lines the LLM agent emits when narrating its tool calls.
    .replace(/\(Source:[^)]*\)/g, "")
    // Strip {"search_query": "..."} JSON blobs the agent emits inline.
    .replace(/\{"search_query":\s*"[^"]*"\}/g, "")
    // Strip {"expression": "..."} JSON blobs the agent emits inline.
    .replace(/\{"expression":\s*"[^"]*"\}/g, "")
    // Collapse any blank lines left behind by the stripping above.
    .replace(/\n{3,}/g, "\n\n")
    // Remove table-row blank lines that break react-markdown's GFM table parser.
    .replace(/(\|[^\n]*\n)\n+(?=\|)/g, "$1");
}

const markdownComponents: Components = {
  table: ({ children }) => (
    <div className="mb-3 overflow-x-auto rounded-lg border border-edge">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-edge/60">{children}</thead>,
  tbody: ({ children }) => <tbody>{children}</tbody>,
  tr: ({ children }) => (
    // tbody rows alternate: odd gets a faint tint; thead rows are covered by bg-edge/60.
    <tr className="border-b border-edge last:border-0 odd:bg-white/[0.02]">{children}</tr>
  ),
  th: ({ children }) => (
    <th className="border-r border-edge px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted last:border-r-0">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-r border-edge px-3 py-2 last:border-r-0">{children}</td>
  ),
  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  h1: ({ children }) => <h1 className="mb-2 text-base font-bold">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-2 text-sm font-bold">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-1 text-sm font-semibold">{children}</h3>,
  ul: ({ children }) => <ul className="mb-2 list-disc pl-5 space-y-0.5">{children}</ul>,
  ol: ({ children }) => <ol className="mb-2 list-decimal pl-5 space-y-0.5">{children}</ol>,
  li: ({ children }) => <li>{children}</li>,
  code: ({ children, className }) => {
    // react-markdown passes a `language-*` className for fenced code blocks.
    const isBlock = className?.startsWith("language-");
    return isBlock ? (
      <code className="block rounded bg-ink px-3 py-2 font-mono text-xs whitespace-pre-wrap">
        {children}
      </code>
    ) : (
      <code className="rounded bg-ink px-1 font-mono text-xs">{children}</code>
    );
  },
  pre: ({ children }) => (
    <pre className="mb-2 overflow-x-auto rounded border border-edge">{children}</pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="mb-2 border-l-2 border-accent pl-3 text-muted">{children}</blockquote>
  ),
  strong: ({ children }) => <strong className="font-semibold text-white">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent underline hover:text-accent/80">
      {children}
    </a>
  ),
  hr: () => <hr className="my-3 border-edge" />,
};

// ============================================================================
// outlineComponents — markdown renderer override for Outline notes only
// ============================================================================
//
// _Basically_, an outline is a depth-first hierarchy and the visual design
// should reinforce depth at a glance. We spread markdownComponents so tables,
// code, blockquotes, etc. inherit their existing styles; we only replace the
// five elements that carry structural meaning in an outline.
//
// Colors: amber (H2) → orange (H3) → rose (H4), with matching left-border
// rails that get thinner at each level. Ordered-list items get a small pill
// badge instead of a plain numeral so section numbers feel like landmarks.
// ============================================================================
const outlineComponents: Components = {
  ...markdownComponents,

  // H2 — inline text chip, rose.
  h2: ({ children }) => (
    <h2 className="mt-4 mb-1 first:mt-0">
      <span className="inline-block rounded border border-rose-400/30 bg-rose-500/10 px-2 py-0.5 text-sm font-bold text-rose-300">
        {children}
      </span>
    </h2>
  ),

  // H3 — inline text chip, teal.
  h3: ({ children }) => (
    <h3 className="mt-3 mb-1">
      <span className="inline-block rounded border border-teal-400/25 bg-teal-500/10 px-2 py-0.5 text-sm font-semibold text-teal-300">
        {children}
      </span>
    </h3>
  ),

  // H4 — inline text chip, indigo.
  h4: ({ children }) => (
    <h4 className="mt-2 mb-0.5">
      <span className="inline-block rounded border border-indigo-400/20 bg-indigo-500/10 px-2 py-0.5 text-xs font-semibold text-indigo-300">
        {children}
      </span>
    </h4>
  ),

  // ol — connector line runs down the left side of the list, linking items
  // back to their parent heading visually. Also injects data-idx onto each
  // <li> for pill badges (counting only valid elements to avoid the ×2 skip
  // caused by whitespace text nodes between tags).
  ol: ({ children }) => {
    let elementCount = 0;
    return (
      <ol className="mb-2 space-y-1 border-l border-zinc-700/50 pl-3 ml-3">
        {React.Children.map(children, (child) => {
          if (!React.isValidElement(child)) return child;
          elementCount += 1;
          return React.cloneElement(
            child as React.ReactElement<{ "data-idx": number }>,
            { "data-idx": elementCount },
          );
        })}
      </ol>
    );
  },

  // ul — same connector line treatment as ol, without the index injection.
  ul: ({ children }) => (
    <ul className="mb-2 space-y-1 border-l border-zinc-700/50 pl-3 ml-3">{children}</ul>
  ),

  // li — amber pill badge for numbered items (ol); teal dot for bullets (ul).
  // data-idx is injected by the ol renderer above; its absence means we're
  // inside a ul, so we show a small teal dot instead.
  li: ({ children, ...rest }) => {
    const n = (rest as Record<string, unknown>)["data-idx"];
    return (
      <li className="flex items-start gap-2">
        {typeof n === "number" ? (
          <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-zinc-500/20 text-[10px] font-semibold text-zinc-400">
            {n}
          </span>
        ) : (
          <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-500/60" />
        )}
        <span className="flex-1">{children}</span>
      </li>
    );
  },
};


// ChatPanel — middle column
// ============================================================================
// The conversation. A header bar lets the user pick a prior conversation or
// start a new one. Only messages belonging to the active conversation are
// shown — all messages are fetched together in the bundle and filtered here.
// Auto-scrolls to the bottom on every visible-messages change.
// ============================================================================
function ChatPanel({
  notebookId,
  messages,
  conversations,
  activeConvId,
  onSent,
  onConvChange,
  onConvCreated,
  onConvDeleted,
  onConvRenamed,
  selectedFilenames,
}: {
  notebookId: string;
  messages: Message[];
  conversations: Conversation[];
  activeConvId: string | null;
  onSent: () => void;
  onConvChange: (id: string) => void;
  onConvCreated: (conv: Conversation) => void;
  onConvDeleted: (deletedId: string, replacement?: Conversation) => void;
  onConvRenamed: (convId: string, title: string) => void;
  /** Filenames checked in Sources panel; empty = use all notebook docs. */
  selectedFilenames: string[];
}) {
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  // Streaming assistant reply being built token-by-token. Shown live in the
  // transcript while sending=true; cleared and replaced by a real message row
  // from SQLite once the stream ends and onSent() triggers a refresh.
  const [streamingText, setStreamingText] = useState("");
  // Sources keyed by message ID. The special key "streaming" holds sources for
  // the in-flight reply so they show during streaming. After onSent() triggers
  // a refresh, pendingSourcesRef carries the sources across the async gap and
  // a useEffect re-keys them to the real SQLite message ID.
  const [messageSources, setMessageSources] = useState<Map<string, Source[]>>(new Map());
  // Holds the sources for the most recent stream until the real message ID is known.
  const pendingSourcesRef = useRef<Source[] | null>(null);
  const [creatingConv, setCreatingConv] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Only show messages for the active conversation.
  const visibleMessages = messages.filter((m) => m.conversation_id === activeConvId);

  // Seed messageSources from persisted sources_json on every messages refresh.
  // This covers: initial load, conversation switch, and post-send refresh.
  // We only update entries that aren't already in state so we don't clobber
  // sources that just arrived via the live streaming path.
  useEffect(() => {
    const toAdd: [string, Source[]][] = [];
    for (const m of messages) {
      if (m.role === "assistant" && m.sources_json) {
        try {
          toAdd.push([m.id, JSON.parse(m.sources_json) as Source[]]);
        } catch {
          // Malformed JSON — skip silently.
        }
      }
    }
    if (toAdd.length === 0) return;
    setMessageSources((prev) => {
      // Only add entries that aren't already present — the streaming path may
      // have already set the entry for the most recent message.
      const next = new Map(prev);
      for (const [id, sources] of toAdd) {
        if (!next.has(id)) next.set(id, sources);
      }
      return next;
    });
  }, [messages]);

  // After onSent() refreshes the message list, the real assistant message row
  // arrives with its SQLite ID. Re-key the pending sources from "streaming" to
  // that ID so they survive the streaming→stored transition.
  useEffect(() => {
    if (!pendingSourcesRef.current) return;
    const lastAssistant = [...visibleMessages].reverse().find((m) => m.role === "assistant");
    if (!lastAssistant) return;
    const sources = pendingSourcesRef.current;
    pendingSourcesRef.current = null;
    setMessageSources((prev) => {
      const next = new Map(prev);
      next.delete("streaming");
      next.set(lastAssistant.id, sources);
      return next;
    });
  }, [visibleMessages]);

  // Auto-scroll to the bottom whenever the visible message list or streaming
  // text changes — keeps the latest tokens in view as they arrive.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [visibleMessages, streamingText]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || !activeConvId) return;
    setSending(true);
    setStreamingText("");
    setError(null);
    // Clear previous turn's streaming sources so they don't show on the new bubble.
    setMessageSources((prev) => { const m = new Map(prev); m.delete("streaming"); return m; });
    const sentInput = input;
    setInput("");

    try {
      const res = await fetch(`/api/notebooks/${notebookId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: sentInput,
          conversationId: activeConvId,
          // Only send when non-empty — the route treats absence as "all docs".
          ...(selectedFilenames.length > 0 && { selectedFilenames }),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `chat failed (${res.status})`);
      }

      // Read the SSE stream line by line, appending each delta to streamingText.
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE lines are terminated by \n\n — process all complete events.
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";

        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith("data:")) continue;
          const payload = JSON.parse(line.slice(5).trim()) as {
            type: string;
            text?: string;
            conversationTitle?: string;
            error?: string;
            sources?: Source[];
          };

          if (payload.type === "delta" && payload.text) {
            setStreamingText((prev) => prev + payload.text);
          } else if (payload.type === "sources" && Array.isArray(payload.sources)) {
            const sources = payload.sources as Source[];
            // Store in ref so we can re-key to the real message ID after refresh.
            pendingSourcesRef.current = sources;
            // Also set "streaming" key so the footer shows during live streaming.
            setMessageSources((prev) => new Map(prev).set("streaming", sources));
          } else if (payload.type === "done") {
            if (payload.conversationTitle && activeConvId) {
              onConvRenamed(activeConvId, payload.conversationTitle);
            }
          } else if (payload.type === "error") {
            throw new Error(payload.error ?? "chat failed");
          }
        }
      }

      onSent(); // triggers refresh — replaces streamingText with the real message row
    } catch (e) {
      setError(e instanceof Error ? e.message : "chat failed");
    } finally {
      setSending(false);
      setStreamingText("");
    }
  }

  async function newConversation() {
    setCreatingConv(true);
    try {
      const res = await fetch(`/api/notebooks/${notebookId}/conversations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (res.ok) {
        const { conversation } = await res.json();
        onConvCreated(conversation);
      }
    } finally {
      setCreatingConv(false);
    }
  }

  async function deleteConversation() {
    if (!activeConvId) return;
    const activeConv = conversations.find((c) => c.id === activeConvId);
    if (!confirm(`Delete "${activeConv?.title ?? "this conversation"}"? Its messages will be removed.`))
      return;
    const res = await fetch(
      `/api/notebooks/${notebookId}/conversations/${activeConvId}`,
      { method: "DELETE" },
    );
    if (res.ok) {
      const data = await res.json();
      // If this was the last conversation the API returns a replacement row.
      onConvDeleted(activeConvId, data.conversation ?? undefined);
    }
  }

  return (
    <section className="flex min-h-0 flex-col bg-ink">
      {/* Conversation switcher header */}
      <div className="flex h-10 items-center gap-2 border-b border-edge bg-panel px-4">
        <select
          value={activeConvId ?? ""}
          onChange={(e) => onConvChange(e.target.value)}
          className="flex-1 truncate rounded border border-edge bg-ink px-2 py-1 text-sm outline-none focus:border-accent"
        >
          {conversations.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>
        <button
          onClick={newConversation}
          disabled={creatingConv}
          title="New conversation"
          className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted hover:bg-edge hover:text-white disabled:opacity-50"
        >
          {creatingConv ? <Spinner size="xs" /> : "+"}
          New
        </button>
        <button
          onClick={deleteConversation}
          title="Delete this conversation"
          className="rounded px-2 py-1 text-xs text-muted hover:bg-red-950/40 hover:text-red-300"
        >
          Delete
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-6">
        {visibleMessages.length === 0 && !sending ? (
          <div className="pt-20 text-center text-sm text-muted">
            Add sources, then ask a question. Answers come from OpenRAG retrieval over
            your indexed documents.
          </div>
        ) : (
          <ul className="space-y-5">
            {visibleMessages.map((m) => (
              <li key={m.id} className="text-sm leading-relaxed">
                <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">
                  {m.role === "user" ? "You" : "Notebook"}
                </div>
                <div className="rounded-lg border border-edge bg-panel px-4 py-3">
                  {m.role === "user" ? (
                    // User messages are plain text — no need to parse markdown.
                    <span className="whitespace-pre-wrap">{m.content}</span>
                  ) : (
                    // Assistant responses often contain markdown (headers, lists,
                    // code blocks). ReactMarkdown turns them into real HTML elements
                    // so they render correctly instead of showing raw syntax.
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                      {fixMarkdown(m.content)}
                    </ReactMarkdown>
                  )}
                  {m.role === "assistant" && messageSources.get(m.id) && (
                    <SourceCitation sources={messageSources.get(m.id)!} />
                  )}
                </div>
              </li>
            ))}
            {/* Show the streaming reply live as tokens arrive. Once sending
                ends, onSent() triggers a refresh that loads the real message row
                from SQLite and this placeholder disappears. */}
            {sending && (
              <li className="text-sm leading-relaxed">
                <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">
                  Notebook
                </div>
                <div className="rounded-lg border border-edge bg-panel px-4 py-3">
                  {streamingText ? (
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                      {fixMarkdown(streamingText)}
                    </ReactMarkdown>
                  ) : (
                    <span className="flex items-center gap-2 text-xs text-muted">
                      <Spinner size="xs" />
                      Thinking…
                    </span>
                  )}
                  {messageSources.get("streaming") && (
                    <SourceCitation sources={messageSources.get("streaming")!} />
                  )}
                </div>
              </li>
            )}
          </ul>
        )}
      </div>
      <form onSubmit={send} className="border-t border-edge bg-panel p-4">
        {error && (
          <p className="mb-2 rounded border border-red-900/50 bg-red-950/30 p-2 text-xs text-red-300">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask anything about your sources…"
            disabled={sending}
            className="flex-1 rounded-lg border border-edge bg-ink px-3 py-2 text-sm outline-none focus:border-accent disabled:opacity-50"
          />
          <button
            disabled={sending || !input.trim() || !activeConvId}
            className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {sending && <Spinner size="sm" />}
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
      </form>
    </section>
  );
}

// ============================================================================
// NOTE_TYPES — metadata for the type-selector grid
// ============================================================================
// Each entry drives one card in the 3-column grid: icon, display label, and
// the API path suffix used when POSTing to generate. Podcast uses its own
// dedicated route; the rest go through /notes/<type>.
// ============================================================================
const NOTE_TYPES = [
  { type: "podcast",  label: "Podcast",  icon: "🎙", color: "bg-cyan-500/10    border-cyan-500/20    hover:border-cyan-400/50    hover:bg-cyan-500/15",    activeColor: "border-cyan-400/70    bg-cyan-500/20    shadow-[0_0_12px_rgba(34,211,238,0.15)]",    route: (id: string) => `/api/notebooks/${id}/podcast` },
  { type: "summary",  label: "Summary",  icon: "☰",  color: "bg-fuchsia-500/10 border-fuchsia-500/20 hover:border-fuchsia-400/50 hover:bg-fuchsia-500/15", activeColor: "border-fuchsia-400/70 bg-fuchsia-500/20 shadow-[0_0_12px_rgba(217,70,239,0.15)]",  route: (id: string) => `/api/notebooks/${id}/notes/summary` },
  { type: "mindmap",  label: "Mind Map", icon: "✦",  color: "bg-violet-500/10  border-violet-500/20  hover:border-violet-400/50  hover:bg-violet-500/15",  activeColor: "border-violet-400/70  bg-violet-500/20  shadow-[0_0_12px_rgba(139,92,246,0.15)]",  route: (id: string) => `/api/notebooks/${id}/notes/mindmap` },
  { type: "outline",  label: "Outline",  icon: "≡",  color: "bg-pink-500/10    border-pink-500/20    hover:border-pink-400/50    hover:bg-pink-500/15",    activeColor: "border-pink-400/70    bg-pink-500/20    shadow-[0_0_12px_rgba(236,72,153,0.15)]",    route: (id: string) => `/api/notebooks/${id}/notes/outline` },
  { type: "qa",       label: "Q&A",      icon: "?",  color: "bg-indigo-500/10  border-indigo-500/20  hover:border-indigo-400/50  hover:bg-indigo-500/15",  activeColor: "border-indigo-400/70  bg-indigo-500/20  shadow-[0_0_12px_rgba(99,102,241,0.15)]",   route: (id: string) => `/api/notebooks/${id}/notes/qa` },
] as const;

type NoteTypeKey = (typeof NOTE_TYPES)[number]["type"];

// ============================================================================
// StudioPanel — right column
// ============================================================================
// Two modes:
//   list view   — type-selector grid + generate panel + notes list
//   expanded view — full-panel reading view for a single note, with a
//                   "Studio › Title" breadcrumb and a back (×) button
// ============================================================================
function StudioPanel({
  notebookId,
  notes,
  onCreated,
  onDeleted,
  onExpandChange,
  collapsed,
  onToggle,
  onResizeDrag,
  selectedFilenames,
}: {
  notebookId: string;
  notes: Note[];
  onCreated: () => void;
  onDeleted: () => void;
  onExpandChange: (expanded: boolean) => void;
  collapsed: boolean;
  onToggle: () => void;
  onResizeDrag: (startX: number) => void;
  /** Filenames checked in Sources panel; empty = use all notebook docs. */
  selectedFilenames: string[];
}) {
  // Which type card is currently selected (null = grid only, no generate panel).
  const [activeType, setActiveType] = useState<NoteTypeKey | null>(null);
  const [topic, setTopic] = useState("");
  // Map of type → partial streamed content for every in-flight generation.
  // Multiple types can generate simultaneously; each has its own preview.
  const [inFlight, setInFlight] = useState<Map<NoteTypeKey, string>>(new Map());
  // ID of the note currently open in full reading view (null = list view).
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const expandedNote = expandedId ? notes.find((n) => n.id === expandedId) ?? null : null;

  // Tell the parent grid to widen/narrow whenever expanded state changes.
  useEffect(() => { onExpandChange(expandedId !== null); }, [expandedId]);

  // _Basically_, this is fire-and-forget: it kicks off the stream and returns
  // immediately so the user can queue up another type without waiting.
  function generate() {
    if (!activeType) return;
    const typeKey = activeType;
    const entry = NOTE_TYPES.find((t) => t.type === typeKey)!;

    // Mark this type as in-flight with an empty preview string.
    setInFlight((prev) => new Map(prev).set(typeKey, ""));
    // Snapshot topic now; clear UI immediately so the user can type a new one.
    const capturedTopic = topic;
    setTopic("");
    setActiveType(null);

    // Run the stream in the background — no await at the call site.
    void (async () => {
      try {
        const res = await fetch(entry.route(notebookId), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            topic: capturedTopic,
            // Only send when non-empty — the route treats absence as "all docs".
            ...(selectedFilenames.length > 0 && { selectedFilenames }),
          }),
        });

        if (!res.ok) return;

        // Drain the SSE stream — append deltas to this type's preview slot.
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";

          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data:")) continue;
            const payload = JSON.parse(line.slice(5).trim()) as {
              type: string;
              text?: string;
            };
            if (payload.type === "delta" && payload.text) {
              setInFlight((prev) => {
                const next = new Map(prev);
                next.set(typeKey, (next.get(typeKey) ?? "") + payload.text);
                return next;
              });
            }
          }
        }

        onCreated();
      } finally {
        // Remove this type from the in-flight map whether it succeeded or failed.
        setInFlight((prev) => {
          const next = new Map(prev);
          next.delete(typeKey);
          return next;
        });
      }
    })();
  }

  async function deleteNote(noteId: string) {
    // If the deleted note is currently expanded, return to list view.
    if (expandedId === noteId) setExpandedId(null);
    await fetch(`/api/notebooks/${notebookId}/notes/${noteId}`, { method: "DELETE" });
    onDeleted();
  }

  // Shared drag handle element — placed on the left edge of every Studio view.
  const resizeHandle = (
    <div
      onMouseDown={(e) => { e.preventDefault(); onResizeDrag(e.clientX); }}
      className="absolute left-0 top-0 h-full w-2 cursor-col-resize z-10 hover:bg-accent/20 active:bg-accent/30"
      title="Drag to resize"
    />
  );

  // ── Collapsed strip ────────────────────────────────────────────────────────
  if (collapsed) {
    return (
      <aside className="relative flex min-h-0 flex-col items-center border-l border-edge bg-panel py-3 gap-3">
        {resizeHandle}
        <button onClick={onToggle} className="text-muted hover:text-white" title="Expand Studio">
          ✦
        </button>
        <span className="text-[10px] text-muted [writing-mode:vertical-rl] tracking-wider uppercase">
          Studio
        </span>
      </aside>
    );
  }

  // ── Expanded reading view ──────────────────────────────────────────────────
  if (expandedNote) {
    const meta = NOTE_TYPES.find((t) => t.type === expandedNote.type);
    return (
      <aside className="relative flex min-h-0 flex-col border-l border-edge bg-panel">
        {resizeHandle}
        {/* Breadcrumb header: "Studio › Note title" with collapse toggle */}
        <div className="flex h-10 items-center justify-between border-b border-edge px-4">
          <div className="flex items-center gap-1.5 text-xs text-muted">
            <button onClick={onToggle} className="font-semibold uppercase tracking-wider hover:text-white" title="Collapse Studio">Studio</button>
            <span>›</span>
            <span className="truncate max-w-[160px] text-white">{expandedNote.title}</span>
          </div>
          <button
            onClick={() => setExpandedId(null)}
            className="rounded p-1 text-muted hover:text-white"
            title="Back to Studio"
          >
            ✕
          </button>
        </div>
        {/* Full scrollable content */}
        <div className="flex-1 overflow-y-auto px-4 py-4 text-sm">
          {expandedNote.type === "podcast" ? (
            // Podcast expanded view: audio player + script
            <PodcastCard note={expandedNote} onDelete={() => deleteNote(expandedNote.id)} />
          ) : expandedNote.content ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={expandedNote.type === "outline" ? outlineComponents : markdownComponents}>
              {expandedNote.content}
            </ReactMarkdown>
          ) : (
            <p className="text-xs text-muted">No content yet.</p>
          )}
        </div>
        {/* Footer: type label + delete */}
        <div className="flex items-center justify-between border-t border-edge px-4 py-2">
          <span className="text-xs text-muted">{meta?.icon} {meta?.label}</span>
          <button
            onClick={() => deleteNote(expandedNote.id)}
            className="text-xs text-muted hover:text-red-300"
          >
            Delete note
          </button>
        </div>
      </aside>
    );
  }

  // ── List view ──────────────────────────────────────────────────────────────
  return (
    <aside className="relative flex min-h-0 flex-col border-l border-edge bg-panel">
      {resizeHandle}
      <div className="flex h-10 items-center justify-between border-b border-edge px-4">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted">Studio</span>
        <button onClick={onToggle} className="text-xs text-muted hover:text-white" title="Collapse Studio">
          ›
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-3">

        {/* Type-selector grid — 3 columns, each card is icon + label + chevron.
            A card with an active generation shows a spinner instead of the chevron. */}
        <div className="grid grid-cols-3 gap-2">
          {NOTE_TYPES.map(({ type, label, icon, color, activeColor }) => {
            const active = activeType === type;
            const streaming = inFlight.has(type);
            return (
              <button
                key={type}
                onClick={() => setActiveType(active ? null : type)}
                className={`flex items-center justify-between rounded-lg border p-2.5 text-left transition
                  ${active ? activeColor : color}
                  ${active ? "text-white" : "text-zinc-300"}`}
              >
                <div className="flex flex-col gap-1">
                  <span className="text-base leading-none">{icon}</span>
                  <span className="text-xs font-medium leading-none">{label}</span>
                </div>
                {streaming ? <Spinner size="xs" /> : <span className="text-xs opacity-50">›</span>}
              </button>
            );
          })}
        </div>

        {/* Inline generate panel — only visible when a type is selected */}
        {activeType && (
          <div className="mt-3 rounded-lg border border-edge bg-ink/40 p-3">
            <div className="text-xs font-medium text-muted">
              {NOTE_TYPES.find((t) => t.type === activeType)?.label}
            </div>
            <input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="Optional topic / focus"
              className="mt-2 w-full rounded-md border border-edge bg-ink px-2 py-1.5 text-sm outline-none focus:border-accent"
            />
            <button
              onClick={generate}
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-md bg-accent px-3 py-2 text-sm font-medium text-white"
            >
              Generate
            </button>
          </div>
        )}

        {/* In-flight previews — one per active generation, shown as live streams.
            Each disappears once its stream completes and the note is saved. */}
        {Array.from(inFlight.entries()).map(([type, partial]) => {
          const meta = NOTE_TYPES.find((t) => t.type === type)!;
          return (
            <div key={type} className="mt-3 rounded-lg border border-edge bg-ink/40 p-3">
              <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted">
                <Spinner size="xs" />
                {meta.icon} {meta.label} — generating…
              </div>
              <div className="max-h-48 overflow-y-auto rounded-md border border-edge bg-ink p-2 text-xs text-zinc-300">
                {partial ? (
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                    {fixMarkdown(partial)}
                  </ReactMarkdown>
                ) : (
                  <span className="text-muted">Writing…</span>
                )}
              </div>
            </div>
          );
        })}

        {/* Notes list — all types unified, newest first */}
        <div className="mt-5 space-y-3">
          {notes.map((note) =>
            note.type === "podcast" ? (
              <PodcastCard key={note.id} note={note} onDelete={() => deleteNote(note.id)} />
            ) : (
              <NoteCard
                key={note.id}
                note={note}
                onDelete={() => deleteNote(note.id)}
                onExpand={() => setExpandedId(note.id)}
              />
            )
          )}
          {notes.length === 0 && inFlight.size === 0 && (
            <p className="text-xs text-muted">No notes yet. Pick a type above to generate one.</p>
          )}
        </div>
      </div>
    </aside>
  );
}

// ============================================================================
// PodcastCard — card for a podcast note
// ============================================================================
// Renders three different "modes" depending on status: in-flight (title +
// status pill), ready (audio player), failed (error text). The script toggle
// is independent — available as soon as scripting finishes.
// ============================================================================
function PodcastCard({ note, onDelete }: { note: Note; onDelete: () => void }) {
  const [showScript, setShowScript] = useState(false);
  const icon = NOTE_TYPES.find((t) => t.type === "podcast")!.icon;
  return (
    <div className="group rounded-lg border border-edge p-3">
      <div className="flex items-center gap-2">
        <span className="text-sm">{icon}</span>
        <div className="min-w-0 flex-1 text-sm font-medium truncate">{note.title}</div>
        <StatusPill status={note.status} />
        <button
          onClick={onDelete}
          className="ml-1 text-xs text-muted opacity-0 hover:text-red-300 group-hover:opacity-100"
        >
          ✕
        </button>
      </div>
      {note.status === "ready" && note.audio_url && (
        <audio controls src={note.audio_url} className="mt-2 w-full" />
      )}
      {note.status === "failed" && (
        <p className="mt-2 text-xs text-red-300">{note.error}</p>
      )}
      {note.script && (
        <button
          onClick={() => setShowScript((s) => !s)}
          className="mt-2 text-xs text-accent hover:underline"
        >
          {showScript ? "Hide script" : "Show script"}
        </button>
      )}
      {showScript && note.script && (
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-ink p-2 text-xs text-muted">
          {note.script}
        </pre>
      )}
    </div>
  );
}

// ============================================================================
// NoteCard — card for text-based note types (summary, mindmap, outline, qa)
// ============================================================================
// Click the row to expand/collapse an inline preview. The ⤢ button opens
// the full reading view (fills the Studio panel). Delete on hover.
// ============================================================================
function NoteCard({ note, onDelete, onExpand }: { note: Note; onDelete: () => void; onExpand: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const meta = NOTE_TYPES.find((t) => t.type === note.type);
  return (
    <div className="group rounded-lg border border-edge">
      {/* Row is a div so the action buttons inside it are valid HTML */}
      <div
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full cursor-pointer items-center gap-2 p-3 text-left"
      >
        <span className="text-sm">{meta?.icon}</span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium truncate">{note.title}</div>
          <div className="text-[10px] text-muted">{meta?.label}</div>
        </div>
        <span className="text-xs text-muted">{expanded ? "▾" : "▸"}</span>
        {/* Expand to full reading view */}
        <button
          onClick={(e) => { e.stopPropagation(); onExpand(); }}
          className="text-xs text-muted opacity-0 hover:text-white group-hover:opacity-100"
          title="Open full view"
        >
          ⤢
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="text-xs text-muted opacity-0 hover:text-red-300 group-hover:opacity-100"
          title="Delete note"
        >
          ✕
        </button>
      </div>
      {expanded && note.content && (
        <div className="border-t border-edge px-3 py-2 text-sm">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={note.type === "outline" ? outlineComponents : markdownComponents}>
            {fixMarkdown(note.content)}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// StatusPill — a tiny coloured chip showing podcast lifecycle state
// ============================================================================
// `inFlight` covers the three non-terminal states. Adding a spinner inside
// the pill is the cheapest way to make the card visually breathe while
// the user waits.
// ============================================================================
type PodcastStatus = "pending" | "scripting" | "synthesizing" | "ready" | "failed";
function StatusPill({ status }: { status: PodcastStatus | null }) {
  if (!status) return null;
  const inFlight =
    status === "pending" ||
    status === "scripting" ||
    status === "synthesizing";
  const map: Record<PodcastStatus, string> = {
    pending: "bg-zinc-800 text-zinc-300",
    scripting: "bg-amber-950/40 text-amber-300",
    synthesizing: "bg-blue-950/40 text-blue-300",
    ready: "bg-emerald-950/40 text-emerald-300",
    failed: "bg-red-950/40 text-red-300",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${map[status]}`}
    >
      {inFlight && <Spinner size="xs" />}
      {status}
    </span>
  );
}

// ============================================================================
// InlineTitle — click-to-edit notebook title in the page header
// ============================================================================
// Renders as plain text normally. Clicking it swaps in an <input> pre-filled
// with the current value. Enter or blur saves; Escape reverts. An empty or
// whitespace-only title is rejected and the previous value is restored.
// ============================================================================
function InlineTitle({
  title,
  onSave,
}: {
  title: string;
  onSave: (newTitle: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);

  // Keep draft in sync if the parent title changes while not editing.
  // useEffect avoids calling setState during render, which React warns about.
  useEffect(() => {
    if (!editing) setDraft(title);
  }, [title, editing]);

  function startEdit() {
    setDraft(title);
    setEditing(true);
  }

  async function commit() {
    const trimmed = draft.trim();
    if (!trimmed) {
      // Reject empty — revert to original without calling the API.
      setDraft(title);
      setEditing(false);
      return;
    }
    setEditing(false);
    await onSave(trimmed);
  }

  function cancel() {
    setDraft(title);
    setEditing(false);
  }

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); commit(); }
          if (e.key === "Escape") cancel();
        }}
        className="rounded border border-accent bg-transparent px-1 text-base font-medium outline-none"
      />
    );
  }

  return (
    <button
      onClick={startEdit}
      title="Click to rename"
      className="rounded px-1 text-base font-medium hover:bg-edge"
    >
      {title}
    </button>
  );
}


// ============================================================================
// OverwriteDialog — modal shown when the user uploads a file that already
// exists in the notebook.
// _Basically_, it lists the duplicate filenames with a checkbox each, and an
// "Overwrite selected" button. Resolves via onDone() with the files the user
// approved — the caller deletes those before re-uploading.
// ============================================================================
function OverwriteDialog({
  duplicates,
  onDone,
}: {
  duplicates: File[];
  onDone: (toOverwrite: File[]) => void;
}) {
  const [checked, setChecked] = useState<Set<string>>(
    // Default: all duplicates selected for overwrite.
    new Set(duplicates.map((f) => f.name)),
  );

  function toggle(name: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  }

  const allChecked = checked.size === duplicates.length;

  return (
    // Backdrop
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-sm rounded-lg border border-edge bg-panel p-5 shadow-xl">
        <h2 className="mb-1 text-sm font-semibold text-white">
          {duplicates.length === 1 ? "File already exists" : "Files already exist"}
        </h2>
        <p className="mb-4 text-xs text-muted">
          Select which files to overwrite. Unchecked files will be skipped.
        </p>

        <ul className="mb-4 space-y-2">
          {duplicates.map((f) => (
            <li key={f.name} className="flex items-center gap-2">
              <input
                type="checkbox"
                id={`ow-${f.name}`}
                checked={checked.has(f.name)}
                onChange={() => toggle(f.name)}
                className="h-3.5 w-3.5 flex-shrink-0 cursor-pointer appearance-none rounded-sm border border-edge bg-edge
                  checked:border-accent checked:bg-accent"
              />
              <label
                htmlFor={`ow-${f.name}`}
                className="cursor-pointer truncate text-xs text-white"
              >
                {f.name}
              </label>
            </li>
          ))}
        </ul>

        {/* Select-all toggle */}
        <button
          onClick={() =>
            setChecked(allChecked ? new Set() : new Set(duplicates.map((f) => f.name)))
          }
          className="mb-4 text-xs text-muted hover:text-white"
        >
          {allChecked ? "Deselect all" : "Select all"}
        </button>

        <div className="flex justify-end gap-2">
          <button
            onClick={() => onDone([])}
            className="rounded px-3 py-1.5 text-xs text-muted hover:bg-edge hover:text-white"
          >
            Skip all
          </button>
          <button
            onClick={() => onDone(duplicates.filter((f) => checked.has(f.name)))}
            className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent/80 disabled:opacity-50"
          >
            {checked.size === 0
              ? "Continue without overwriting"
              : `Overwrite ${checked.size === duplicates.length ? "all" : checked.size}`}
          </button>
        </div>
      </div>
    </div>
  );
}
