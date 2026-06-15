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

// Row shapes returned by /api/notebooks/[id]. These mirror the SQLite types
// in lib/db.ts but only include fields the client actually uses.
type Notebook = { id: string; title: string; openrag_collection: string };
type Document = { id: string; filename: string; bytes: number };
type Conversation = { id: string; notebook_id: string; title: string; created_at: number };
type Message = { id: string; conversation_id: string | null; role: "user" | "assistant"; content: string };
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
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [podcasts, setPodcasts] = useState<Podcast[]>([]);

  // One fetch, five state updates. Called on mount and after every mutating
  // action (upload, chat send, podcast create, source delete). The bundle
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
        </div>
        <div className="text-xs text-muted">collection: {notebook.openrag_collection}</div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[280px_1fr_360px] overflow-hidden">
        <SourcesPanel
          notebookId={id}
          documents={documents}
          onUploaded={refresh}
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
              setConversations((cs) => cs.filter((c) => c.id !== deletedId));
              setActiveConvId((prev) => {
                if (prev !== deletedId) return prev;
                // Switch to the first remaining conversation.
                return conversations.find((c) => c.id !== deletedId)?.id ?? null;
              });
            }
          }}
          onConvRenamed={(convId, title) =>
            setConversations((cs) =>
              cs.map((c) => (c.id === convId ? { ...c, title } : c)),
            )
          }
        />
        <StudioPanel notebookId={id} podcasts={podcasts} onCreated={refresh} onDeleted={refresh} />
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
}: {
  notebookId: string;
  documents: Document[];
  onUploaded: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);

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

  async function bulkDelete() {
    if (selected.size === 0) return;
    if (!confirm(`Delete ${selected.size} source${selected.size > 1 ? "s" : ""}? This removes their chunks from the index.`))
      return;
    setDeleting(true);
    try {
      for (const docId of selected) {
        await fetch(`/api/notebooks/${notebookId}/documents/${docId}`, {
          method: "DELETE",
        });
      }
    } finally {
      setSelected(new Set());
      setDeleting(false);
      onUploaded();
    }
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  const allSelected = documents.length > 0 && selected.size === documents.length;

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
                  <div className="text-xs text-muted">
                    {(d.bytes / 1024).toFixed(1)} KB
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
        <div className="flex items-center gap-2 border-t border-edge px-3 py-2">
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
      )}

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
}) {
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [creatingConv, setCreatingConv] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Only show messages for the active conversation.
  const visibleMessages = messages.filter((m) => m.conversation_id === activeConvId);

  // Auto-scroll to the bottom whenever the visible message list changes.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [visibleMessages]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || !activeConvId) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/notebooks/${notebookId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: input, conversationId: activeConvId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `chat failed (${res.status})`);
      }
      const data = await res.json();
      // On the first message the server renames the conversation to match
      // what OpenRAG will show — update the switcher label immediately.
      if (data.conversationTitle && activeConvId) {
        onConvRenamed(activeConvId, data.conversationTitle);
      }
      setInput("");
      onSent();
    } catch (e) {
      setError(e instanceof Error ? e.message : "chat failed");
    } finally {
      setSending(false);
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
      <div className="flex items-center gap-2 border-b border-edge bg-panel px-4 py-2">
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
          <div className="mx-auto max-w-lg pt-20 text-center text-sm text-muted">
            Add sources, then ask a question. Answers come from OpenRAG retrieval over
            your indexed documents.
          </div>
        ) : (
          <ul className="mx-auto max-w-2xl space-y-5">
            {visibleMessages.map((m) => (
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
// StudioPanel — right column
// ============================================================================
// "Generate podcast" form + the list of episodes (in any state). Podcast
// cards have checkboxes for bulk-delete; the bulk-delete bar appears at the
// bottom whenever ≥1 card is selected.
// ============================================================================
function StudioPanel({
  notebookId,
  podcasts,
  onCreated,
  onDeleted,
}: {
  notebookId: string;
  podcasts: Podcast[];
  onCreated: () => void;
  onDeleted: () => void;
}) {
  const [topic, setTopic] = useState("");
  const [generating, setGenerating] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);

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

  async function bulkDelete() {
    if (selected.size === 0) return;
    if (!confirm(`Delete ${selected.size} episode${selected.size > 1 ? "s" : ""}?`))
      return;
    setDeleting(true);
    try {
      for (const podcastId of selected) {
        await fetch(`/api/notebooks/${notebookId}/podcasts/${podcastId}`, {
          method: "DELETE",
        });
      }
    } finally {
      setSelected(new Set());
      setDeleting(false);
      onDeleted();
    }
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  const allSelected = podcasts.length > 0 && selected.size === podcasts.length;

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
            <PodcastCard
              key={p.id}
              podcast={p}
              checked={selected.has(p.id)}
              onToggle={() => toggleSelect(p.id)}
            />
          ))}
          {podcasts.length === 0 && (
            <p className="text-xs text-muted">No episodes yet.</p>
          )}
        </div>
      </div>

      {/* Bulk-delete bar — only visible when ≥1 episode is selected */}
      {selected.size > 0 && (
        <div className="flex items-center gap-2 border-t border-edge px-3 py-2">
          <button
            onClick={() =>
              setSelected(allSelected ? new Set() : new Set(podcasts.map((p) => p.id)))
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
      )}
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
// `checked` / `onToggle` wire the card into the StudioPanel bulk-select.
// ============================================================================
function PodcastCard({
  podcast,
  checked,
  onToggle,
}: {
  podcast: Podcast;
  checked: boolean;
  onToggle: () => void;
}) {
  const [showScript, setShowScript] = useState(false);
  return (
    <div className="group rounded-lg border border-edge p-3">
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          className={`h-3.5 w-3.5 flex-shrink-0 cursor-pointer appearance-none rounded-sm border border-edge bg-edge transition
            checked:border-accent checked:bg-accent
            ${checked ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
        />
        <div className="min-w-0 flex-1 text-sm font-medium truncate">{podcast.title}</div>
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

  // Keep draft in sync if the parent title changes (e.g. after a refresh).
  // Only update when not currently editing so we don't clobber the user's input.
  if (!editing && draft !== title) setDraft(title);

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

