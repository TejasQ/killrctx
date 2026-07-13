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
import { useBackendHealth } from "@/hooks/useBackendHealth";

type Notebook = { id: string; title: string; created_at: number; rag_backend?: string };

export default function Home() {
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  // id of the notebook currently being renamed, or null if none
  const [renamingId, setRenamingId] = useState<string | null>(null);
  // Backend selection for new notebook creation
  const [ragBackend, setRagBackend] = useState<"openrag" | "workbench">("openrag");
  const health = useBackendHealth();

  // Fetch the list on mount. We do an optimistic prepend on create (below)
  // so we don't need to refetch after — but if you ever add deletion or
  // multi-tab usage, call `load()` again to resync.
  async function load() {
    const res = await fetch("/api/notebooks");
    const data = await res.json();
    setNotebooks(data.notebooks);
  }
  useEffect(() => { load(); }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      const body: Record<string, string> = { title, rag_backend: ragBackend };
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
          {/* Backend picker: two logo-labelled toggle buttons instead of a plain select,
              so users can see the platform brand at a glance. */}
          <BackendPicker value={ragBackend} onChange={setRagBackend} health={health} />
          <button
            disabled={creating || (health.openrag !== "up" && health.workbench !== "up")}
            className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {creating && <Spinner size="sm" />}
            {creating ? "Creating…" : "Create"}
          </button>
        </div>
        {/* No backend up — explain why Create is disabled */}
        {health.openrag !== "unknown" && health.workbench !== "unknown" &&
         health.openrag !== "up"      && health.workbench !== "up" && (
          <p className="text-xs text-amber-400">
            No backend is reachable — start one with{" "}
            <code className="rounded bg-white/10 px-1 font-mono">npm run init</code>{" "}
            to create notebooks.
          </p>
        )}
        {ragBackend === "workbench" && health.workbench === "up" && (
          <p className="text-xs text-muted">
            AI Workbench notebook names are permanent — the Astra collection name is set at creation and cannot be changed.
          </p>
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
                <div className="flex items-center gap-2.5">
                  <BackendLogo backend={nb.rag_backend} health={health} />
                  <div>
                    <div className="text-sm font-medium">{nb.title}</div>
                    <div className="text-xs text-muted">
                      {new Date(nb.created_at).toLocaleString()}
                    </div>
                  </div>
                </div>
              </Link>
            )}
            {renamingId !== nb.id && (
              <div className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 transition group-hover:opacity-100">
                <MenuButton
                  actions={[
                    nb.rag_backend === "workbench"
                      ? {
                          label: "Rename",
                          disabled: true,
                          title: "AI Workbench Knowledge Base names cannot be changed after creation",
                          onClick: () => {},
                        }
                      : {
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

// ============================================================================
// BackendPicker — logo-labelled toggle buttons for choosing the RAG backend
// ============================================================================
// Two side-by-side buttons, each showing the platform logo + name. The active
// choice gets an accent border; the inactive one stays subdued. Buttons for
// offline/unconfigured backends are disabled and show "(offline)" instead of
// the URL so the user isn't left guessing why they can't select them.
// ============================================================================
const BACKEND_OPTIONS = [
  { value: "openrag",   label: "OpenRAG",     logo: "/assets/logo-openrag-dog.svg" },
  { value: "workbench", label: "AI Workbench", logo: "/assets/logo-astra.png" },
] as const;

import type { BackendHealth } from "@/hooks/useBackendHealth";

function BackendPicker({
  value,
  onChange,
  health,
}: {
  value: "openrag" | "workbench";
  onChange: (v: "openrag" | "workbench") => void;
  health: BackendHealth;
}) {
  return (
    <div className="flex rounded-lg border border-edge overflow-hidden">
      {BACKEND_OPTIONS.map((opt) => {
        const active  = value === opt.value;
        // "unknown" = first poll not yet back — don't disable on first paint.
        const offline = health[opt.value] === "down";
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => !offline && onChange(opt.value)}
            disabled={offline}
            className={[
              "flex items-center gap-1.5 px-2.5 py-2 text-xs transition",
              offline
                ? "cursor-not-allowed bg-panel text-muted opacity-50"
                : active
                  ? "bg-accent/10 border-accent text-accent font-medium ring-1 ring-inset ring-accent"
                  : "bg-panel text-muted hover:bg-surface",
            ].join(" ")}
            title={offline ? `${opt.label} is offline` : opt.label}
          >
            <img src={opt.logo} alt={opt.label} width={16} height={16} className="shrink-0 rounded-sm" />
            {opt.label}
            {offline && <span className="text-[10px] opacity-70">(offline)</span>}
          </button>
        );
      })}
    </div>
  );
}

// ============================================================================
// BackendLogo — tiny icon showing which RAG backend a notebook uses
// ============================================================================
// Rendered left of the notebook name on the home page. OpenRAG uses just the
// dog portion of logo-openrag.png (cropped via CSS); Astra uses its standalone
// icon mark logo-astra.png. Both are 20×20px to sit flush with the text line.
//
// A small dot badge is overlaid on the bottom-right corner of the icon:
//   green  = backend is up
//   red    = backend is down
//   hidden = health not yet known (first poll still in flight)
// ============================================================================
function BackendLogo({ backend, health }: { backend?: string; health: BackendHealth }) {
  const key    = backend === "workbench" ? "workbench" : "openrag";
  const status = health[key];

  const dot = status === "unknown" ? null : (
    <span
      aria-label={status === "up" ? "online" : "offline"}
      className={[
        "absolute bottom-0 right-0 h-2 w-2 rounded-full ring-1 ring-panel",
        status === "up" ? "bg-green-400" : "bg-red-500",
      ].join(" ")}
    />
  );

  if (backend === "workbench") {
    return (
      <div className="relative shrink-0 h-5 w-5">
        <img src="/assets/logo-astra.png" alt="Astra" width={20} height={20} className="rounded-sm" />
        {dot}
      </div>
    );
  }
  return (
    <div className="relative shrink-0 h-5 w-5">
      <img src="/assets/logo-openrag-dog.svg" alt="OpenRAG" width={20} height={20} />
      {dot}
    </div>
  );
}
