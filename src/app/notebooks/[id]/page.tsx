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

import { use, useEffect, useRef, useState } from "react";
import Link from "next/link";
import Spinner from "@/components/Spinner";
import MenuButton from "@/components/MenuButton";

// Row shapes returned by /api/notebooks/[id]. These mirror the SQLite types
// in lib/db.ts but only include fields the client actually uses.
type Notebook = { id: string; title: string; openrag_collection: string };
type Document = { id: string; filename: string; bytes: number };
type Message = { id: string; role: "user" | "assistant"; content: string };
type Podcast = {
  id: string;
  title: string;
  status: "pending" | "scripting" | "synthesizing" | "ready" | "failed";
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
  const [notebook, setNotebook] = useState<Notebook | null>(null);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [podcasts, setPodcasts] = useState<Podcast[]>([]);

  // One fetch, four state updates. Called on mount and after every mutating
  // action (upload, chat send, podcast create, source delete). The bundle
  // endpoint means we don't have a waterfall of four parallel fetches.
  async function refresh() {
    const res = await fetch(`/api/notebooks/${id}`);
    if (!res.ok) return;
    const data = await res.json();
    setNotebook(data.notebook);
    setDocuments(data.documents);
    setMessages(data.messages);
    setPodcasts(data.podcasts);
  }
  useEffect(() => {
    refresh();
  }, [id]);

  // Poll while any podcast is non-terminal. The interval is cleared as soon
  // as every podcast has hit `ready` or `failed`, so we're not hitting the
  // server forever. 3s is a comfortable rate — generation takes 30-90s, so
  // the user typically sees ~10 polls per episode.
  useEffect(() => {
    const pending = podcasts.some(
      (p) => p.status !== "ready" && p.status !== "failed",
    );
    if (!pending) return;
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [podcasts]);

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
          <h1 className="text-base font-medium">{notebook.title}</h1>
        </div>
        <div className="text-xs text-muted">collection: {notebook.openrag_collection}</div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[280px_1fr_360px] overflow-hidden">
        <SourcesPanel
          notebookId={id}
          documents={documents}
          onUploaded={refresh}
        />
        <ChatPanel notebookId={id} messages={messages} onSent={refresh} />
        <StudioPanel notebookId={id} podcasts={podcasts} onCreated={refresh} />
      </div>
    </div>
  );
}

// ============================================================================
// SourcesPanel — left column
// ============================================================================
// The user adds files here. Multi-select is enabled (`multiple` on the file
// input); we upload them sequentially so OpenRAG/Docling never sees a stampede.
// Hover a row to reveal the 3-dot menu for per-source delete.
// ============================================================================
function SourcesPanel({
  notebookId,
  documents,
  onUploaded,
}: {
  notebookId: string;
  documents: Document[];
  onUploaded: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Upload files sequentially. The API route accepts one `file` per
  // request, so we loop here rather than batching multipart on the server.
  // Sequential (not parallel) keeps Docling/embedding load predictable on
  // the OpenRAG side and gives us a clean "n of m" progress indicator.
  async function upload(files: File[]) {
    if (files.length === 0) return;
    setError(null);
    setUploading({ done: 0, total: files.length });
    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        setUploading({ done: i, total: files.length });
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

  async function remove(d: Document) {
    if (!confirm(`Remove "${d.filename}"? This deletes its chunks from the index.`))
      return;
    await fetch(`/api/notebooks/${notebookId}/documents/${d.id}`, {
      method: "DELETE",
    });
    onUploaded(); // re-uses the parent's refresh function
  }

  return (
    <aside className="flex min-h-0 flex-col border-r border-edge bg-panel">
      <div className="border-b border-edge px-4 py-3 text-xs font-semibold uppercase tracking-wider text-muted">
        Sources
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
                className="group flex items-start gap-2 rounded-md border border-edge px-3 py-2 text-sm"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate">{d.filename}</div>
                  <div className="text-xs text-muted">
                    {(d.bytes / 1024).toFixed(1)} KB
                  </div>
                </div>
                <div className="opacity-0 transition group-hover:opacity-100">
                  <MenuButton
                    actions={[
                      {
                        label: "Delete source",
                        variant: "danger",
                        onClick: () => remove(d),
                      },
                    ]}
                  />
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
      <div className="border-t border-edge p-3">
        <input
          ref={inputRef}
          type="file"
          multiple
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
    </aside>
  );
}

// ============================================================================
// ChatPanel — middle column
// ============================================================================
// The conversation. New user messages get persisted optimistically by the
// server-side route, so the UI just calls `onSent()` (which re-fetches the
// bundle) after a successful POST. The agent's reply lands in the same
// re-fetch. Auto-scrolls to the bottom on every messages-array change.
// ============================================================================
function ChatPanel({
  notebookId,
  messages,
  onSent,
}: {
  notebookId: string;
  messages: Message[];
  onSent: () => void;
}) {
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll the message list to the bottom whenever a new turn lands.
  // Runs on the next paint thanks to useEffect, so the new <li> is in the
  // DOM by the time we measure scrollHeight.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim()) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/notebooks/${notebookId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: input }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `chat failed (${res.status})`);
      }
      setInput("");
      onSent();
    } catch (e) {
      setError(e instanceof Error ? e.message : "chat failed");
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="flex min-h-0 flex-col bg-ink">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-6">
        {messages.length === 0 && !sending ? (
          <div className="mx-auto max-w-lg pt-20 text-center text-sm text-muted">
            Add sources, then ask a question. Answers come from OpenRAG retrieval over
            your indexed documents.
          </div>
        ) : (
          <ul className="mx-auto max-w-2xl space-y-5">
            {messages.map((m) => (
              <li key={m.id} className="text-sm leading-relaxed">
                <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">
                  {m.role === "user" ? "You" : "Notebook"}
                </div>
                <div className="whitespace-pre-wrap rounded-lg border border-edge bg-panel px-4 py-3">
                  {m.content}
                </div>
              </li>
            ))}
            {sending && (
              <li className="flex items-center gap-2 text-xs text-muted">
                <Spinner size="xs" />
                Notebook is thinking…
              </li>
            )}
          </ul>
        )}
      </div>
      <form onSubmit={send} className="border-t border-edge bg-panel p-4">
        {error && (
          <p className="mx-auto mb-2 max-w-2xl rounded border border-red-900/50 bg-red-950/30 p-2 text-xs text-red-300">
            {error}
          </p>
        )}
        <div className="mx-auto flex max-w-2xl gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask anything about your sources…"
            className="flex-1 rounded-lg border border-edge bg-ink px-3 py-2 text-sm outline-none focus:border-accent"
          />
          <button
            disabled={sending || !input.trim()}
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
// StudioPanel — right column
// ============================================================================
// "Generate podcast" form + the list of episodes (in any state). The POST
// returns immediately with status: "scripting" — actual generation runs in
// the background on the server. The parent component polls every 3s while
// any podcast is non-terminal, so cards transition through their states
// without us having to do anything special here.
// ============================================================================
function StudioPanel({
  notebookId,
  podcasts,
  onCreated,
}: {
  notebookId: string;
  podcasts: Podcast[];
  onCreated: () => void;
}) {
  const [topic, setTopic] = useState("");
  const [generating, setGenerating] = useState(false);

  async function generate() {
    setGenerating(true);
    try {
      // POST returns the freshly-inserted podcast row (in `scripting`
      // state). We don't even read the response — `onCreated()` re-fetches
      // the bundle and the new card appears in the list.
      await fetch(`/api/notebooks/${notebookId}/podcast`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic }),
      });
      setTopic("");
      onCreated();
    } finally {
      setGenerating(false);
    }
  }

  return (
    <aside className="flex min-h-0 flex-col border-l border-edge bg-panel">
      <div className="border-b border-edge px-4 py-3 text-xs font-semibold uppercase tracking-wider text-muted">
        Studio
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-3">
        <div className="rounded-lg border border-edge p-3">
          <div className="text-sm font-medium">Generate podcast</div>
          <p className="mt-1 text-xs text-muted">
            OpenRAG drafts a two-host script grounded in your sources, ElevenLabs
            narrates each turn.
          </p>
          <input
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="Optional topic / focus"
            className="mt-3 w-full rounded-md border border-edge bg-ink px-2 py-1.5 text-sm outline-none focus:border-accent"
          />
          <button
            onClick={generate}
            disabled={generating}
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-md bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {generating && <Spinner size="sm" />}
            {generating ? "Queuing…" : "Generate"}
          </button>
        </div>

        <div className="mt-5 space-y-3">
          {podcasts.map((p) => (
            <PodcastCard key={p.id} podcast={p} />
          ))}
          {podcasts.length === 0 && (
            <p className="text-xs text-muted">No episodes yet.</p>
          )}
        </div>
      </div>
    </aside>
  );
}

// ============================================================================
// PodcastCard — one row per episode
// ============================================================================
// Renders three different "modes" depending on status: in-flight (just the
// title + status pill), ready (audio player), failed (error text). The
// script toggle is independent — it's available as soon as scripting
// finishes, which gives you something to read while synthesis runs.
// ============================================================================
function PodcastCard({ podcast }: { podcast: Podcast }) {
  const [showScript, setShowScript] = useState(false);
  return (
    <div className="rounded-lg border border-edge p-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">{podcast.title}</div>
        <StatusPill status={podcast.status} />
      </div>
      {podcast.status === "ready" && podcast.audio_url && (
        <audio controls src={podcast.audio_url} className="mt-2 w-full" />
      )}
      {podcast.status === "failed" && (
        <p className="mt-2 text-xs text-red-300">{podcast.error}</p>
      )}
      {podcast.script && (
        <button
          onClick={() => setShowScript((s) => !s)}
          className="mt-2 text-xs text-accent hover:underline"
        >
          {showScript ? "Hide script" : "Show script"}
        </button>
      )}
      {showScript && podcast.script && (
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-ink p-2 text-xs text-muted">
          {podcast.script}
        </pre>
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
function StatusPill({ status }: { status: Podcast["status"] }) {
  const inFlight =
    status === "pending" ||
    status === "scripting" ||
    status === "synthesizing";
  const map: Record<Podcast["status"], string> = {
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
