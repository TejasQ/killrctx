// ============================================================================
// app/page.tsx — the landing page (the notebook list)
// ============================================================================
//
// _Basically_, this is the home screen: a list of every notebook in SQLite,
// sorted newest-first, plus a single-input form to create another. Click
// any card to navigate into /notebooks/<id> where the real work happens.
//
// Why a "use client" component instead of a server component?
//   We could render the initial list on the server, but then we'd need a
//   second client component for the create form anyway. Doing the whole
//   page client-side keeps the file in one piece and is fine for a tiny
//   list — there's no SEO concern for a private local app.
// ============================================================================

"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import Spinner from "@/components/Spinner";
import MenuButton from "@/components/MenuButton";

type Notebook = { id: string; title: string; created_at: number; rag_backend?: string };
type WbAgent = { agentId: string; name: string; description: string | null };
type WbEmbedding = { embeddingServiceId: string; name: string };

export default function Home() {
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  // id of the notebook currently being renamed, or null if none
  const [renamingId, setRenamingId] = useState<string | null>(null);
  // Backend selection for new notebook creation
  const [ragBackend, setRagBackend] = useState<"openrag" | "workbench">("openrag");
  const [wbAgents, setWbAgents] = useState<WbAgent[]>([]);
  const [wbEmbeddings, setWbEmbeddings] = useState<WbEmbedding[]>([]);
  const [wbAgentId, setWbAgentId] = useState("");
  const [wbEmbeddingId, setWbEmbeddingId] = useState("");

  // Fetch the list on mount. We do an optimistic prepend on create (below)
  // so we don't need to refetch after — but if you ever add deletion or
  // multi-tab usage, call `load()` again to resync.
  async function load() {
    const res = await fetch("/api/notebooks");
    const data = await res.json();
    setNotebooks(data.notebooks);
  }
  useEffect(() => {
    load();
    // Pre-fetch Workbench options so the picker is instant when selected.
    fetch("/api/workbench/agents").then((r) => r.json()).then((d) => {
      setWbAgents(d.items ?? []);
      if (d.items?.length) setWbAgentId(d.items[0].agentId);
    }).catch(() => {});
    fetch("/api/workbench/embedding-services").then((r) => r.json()).then((d) => {
      setWbEmbeddings(d.items ?? []);
      if (d.items?.length) setWbEmbeddingId(d.items[0].embeddingServiceId);
    }).catch(() => {});
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      const body: Record<string, string> = { title, rag_backend: ragBackend };
      if (ragBackend === "workbench") {
        if (wbAgentId) body.workbench_agent_id = wbAgentId;
        if (wbEmbeddingId) body.workbench_embedding_service_id = wbEmbeddingId;
      }
      const res = await fetch("/api/notebooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const { notebook } = await res.json();
      setTitle("");
      setNotebooks((n) => [notebook, ...n]);
    } finally {
      setCreating(false);
    }
  }

  // Optimistic remove: drop from local state first, then DELETE on the
  // server. If the server fails we'd ideally roll back, but for a single-
  // user local app we accept the rare desync over the latency.
  async function remove(nb: Notebook) {
    if (!confirm(`Delete "${nb.title}"? This removes the notebook and its chat history.`)) return;
    setNotebooks((n) => n.filter((x) => x.id !== nb.id));
    await fetch(`/api/notebooks/${nb.id}`, { method: "DELETE" });
  }

  async function rename(nb: Notebook, newTitle: string) {
    const trimmed = newTitle.trim();
    setRenamingId(null);
    if (!trimmed || trimmed === nb.title) return;
    // Optimistic update — swap the title in local state immediately.
    setNotebooks((n) => n.map((x) => (x.id === nb.id ? { ...x, title: trimmed } : x)));
    const res = await fetch(`/api/notebooks/${nb.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: trimmed }),
    });
    // Revert the optimistic update if the server rejected it.
    if (!res.ok) {
      setNotebooks((n) => n.map((x) => (x.id === nb.id ? { ...x, title: nb.title } : x)));
    }
  }

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <header className="mb-10">
        <h1 className="text-3xl font-semibold tracking-tight">Notebooks</h1>
        <p className="mt-1 text-sm text-muted">
          OpenRAG retrieval, grounded chat, and ElevenLabs-narrated podcasts.
        </p>
      </header>

      <form onSubmit={create} className="mb-8 space-y-2">
        <div className="flex gap-2">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="New notebook title"
            className="flex-1 rounded-lg border border-edge bg-panel px-3 py-2 text-sm outline-none focus:border-accent"
          />
          <select
            value={ragBackend}
            onChange={(e) => setRagBackend(e.target.value as "openrag" | "workbench")}
            className="rounded-lg border border-edge bg-panel px-2 py-2 text-xs"
          >
            <option value="openrag">OpenRAG</option>
            <option value="workbench">AI Workbench</option>
          </select>
          <button
            disabled={creating}
            className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {creating && <Spinner size="sm" />}
            {creating ? "Creating…" : "Create"}
          </button>
        </div>
        {ragBackend === "workbench" && (
          <div className="flex gap-2 text-xs">
            {wbEmbeddings.length > 0 && (
              <label className="flex items-center gap-1">
                <span className="text-muted">Embedding:</span>
                <select
                  value={wbEmbeddingId}
                  onChange={(e) => setWbEmbeddingId(e.target.value)}
                  className="rounded border border-edge bg-panel px-1.5 py-1"
                >
                  {wbEmbeddings.map((e) => (
                    <option key={e.embeddingServiceId} value={e.embeddingServiceId}>{e.name}</option>
                  ))}
                </select>
              </label>
            )}
            {wbAgents.length > 0 && (
              <label className="flex items-center gap-1">
                <span className="text-muted">Agent:</span>
                <select
                  value={wbAgentId}
                  onChange={(e) => setWbAgentId(e.target.value)}
                  className="rounded border border-edge bg-panel px-1.5 py-1"
                >
                  {wbAgents.map((a) => (
                    <option key={a.agentId} value={a.agentId}>{a.name}</option>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}
      </form>

      <ul className="grid gap-3">
        {notebooks.map((nb) => (
          <li
            key={nb.id}
            className="group relative rounded-lg border border-edge bg-panel transition hover:z-10 hover:border-accent"
          >
            {renamingId === nb.id ? (
              // Rename mode: full-card inline input, same height as the card.
              // Clicking away (onBlur) or pressing Enter commits; Escape cancels.
              <RenameInput
                defaultValue={nb.title}
                onCommit={(v) => rename(nb, v)}
                onCancel={() => setRenamingId(null)}
              />
            ) : (
              <Link
                href={`/notebooks/${nb.id}`}
                className="block px-4 py-3 pr-12"
              >
                <div className="text-sm font-medium">{nb.title}</div>
                <div className="text-xs text-muted">
                  {new Date(nb.created_at).toLocaleString()}
                </div>
              </Link>
            )}
            {renamingId !== nb.id && (
              <div className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 transition group-hover:opacity-100">
                <MenuButton
                  actions={[
                    {
                      label: "Rename",
                      onClick: () => setRenamingId(nb.id),
                    },
                    {
                      label: "Delete notebook",
                      variant: "danger",
                      onClick: () => remove(nb),
                    },
                  ]}
                />
              </div>
            )}
          </li>
        ))}
        {notebooks.length === 0 && (
          <li className="text-sm text-muted">
            No notebooks yet — create one above.
          </li>
        )}
      </ul>
    </main>
  );
}

// ============================================================================
// RenameInput — inline text field that replaces a notebook card's title row
// ============================================================================
// Rendered in place of the <Link> when a card enters rename mode. autoFocus
// lands the cursor immediately. Enter/blur commits; Escape cancels.
// ============================================================================
function RenameInput({
  defaultValue,
  onCommit,
  onCancel,
}: {
  defaultValue: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(defaultValue);
  const committed = useRef(false);

  function commit() {
    if (committed.current) return;
    committed.current = true;
    onCommit(value);
  }

  return (
    <div className="px-4 py-3 pr-12">
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); commit(); }
          if (e.key === "Escape") { e.preventDefault(); onCancel(); }
        }}
        className="w-full rounded border border-accent bg-transparent text-sm font-medium outline-none"
      />
      <div className="mt-0.5 text-xs text-muted">Enter to save · Esc to cancel</div>
    </div>
  );
}
