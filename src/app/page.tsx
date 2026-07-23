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

type Notebook = { id: string; title: string; created_at: number; rag_backend?: string; openrag_filter_id?: string | null };

// A filter that exists in OpenRAG but has no local notebook yet.
type UnlinkedFilter = { id: string; name: string; docCount: number };

const DISMISSED_KEY = "killrctx_dismissed_filter_ids";

export default function Home() {
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  // id of the notebook currently being renamed, or null if none
  const [renamingId, setRenamingId] = useState<string | null>(null);
  // Backend selection for new notebook creation.
  // We start with "openrag" as a safe default, but useEffect below will switch
  // to "workbench" if OpenRAG turns out to be unconfigured and Workbench is not.
  const [ragBackend, setRagBackend] = useState<"openrag" | "workbench">("openrag");
  const health = useBackendHealth();

  // Filters that exist in OpenRAG but have no local notebook.
  const [unlinkedFilters, setUnlinkedFilters] = useState<UnlinkedFilter[]>([]);
  // Filter IDs the user dismissed — persisted in localStorage.
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  // Which filter import is in flight (null = none).
  const [importing, setImporting] = useState<string | null>(null);

  // Once the first health poll completes, auto-select the only configured backend
  // so the user never lands on a picker option that can't work.
  useEffect(() => {
    if (health.openrag === "unknown" || health.workbench === "unknown") return;
    if (health.openrag === "unconfigured" && health.workbench !== "unconfigured") {
      setRagBackend("workbench");
    }
  }, [health.openrag, health.workbench]);

  // Fetch the list on mount. We do an optimistic prepend on create (below)
  // so we don't need to refetch after — but if you ever add deletion or
  // multi-tab usage, call `load()` again to resync.
  async function load() {
    const res = await fetch("/api/notebooks");
    const data = await res.json();
    setNotebooks(data.notebooks);
  }
  useEffect(() => { load(); }, []);

  // Fetch unlinked filters once OpenRAG is confirmed up.
  // Re-runs whenever health.openrag changes (e.g. after a cold start).
  useEffect(() => {
    if (health.openrag !== "up") return;
    const stored = localStorage.getItem(DISMISSED_KEY);
    const dismissed = new Set<string>(stored ? JSON.parse(stored) : []);
    setDismissedIds(dismissed);
    fetch("/api/openrag-filters/unlinked")
      .then((r) => r.json())
      .then((data: { filters: { id: string; name: string; queryData: { filters?: { data_sources?: string[] } } }[] }) => {
        const active = data.filters
          .filter((f) => !dismissed.has(f.id))
          .map((f) => ({
            id: f.id,
            name: f.name,
            docCount: (f.queryData?.filters?.data_sources ?? []).filter((s) => s !== "*").length,
          }));
        setUnlinkedFilters(active);
      })
      .catch(() => { /* OpenRAG down — no banner */ });
  }, [health.openrag]);

  async function reimportFilter(nb: Notebook) {
    if (!nb.openrag_filter_id) return;
    await fetch("/api/openrag-filters/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filterId: nb.openrag_filter_id }),
    });
    // Reload the full list so the Sources panel on next open reflects new docs.
    await load();
  }

  async function importFilter(filterId: string) {
    setImporting(filterId);
    try {
      const res = await fetch("/api/openrag-filters/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filterId }),
      });
      const { notebook } = await res.json();
      setNotebooks((n) => [notebook, ...n]);
      setUnlinkedFilters((f) => f.filter((x) => x.id !== filterId));
    } finally {
      setImporting(null);
    }
  }

  function dismissFilter(filterId: string) {
    const next = new Set(dismissedIds).add(filterId);
    setDismissedIds(next);
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...next]));
    setUnlinkedFilters((f) => f.filter((x) => x.id !== filterId));
  }

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

      <UnlinkedFilterBanner
        filters={unlinkedFilters}
        importing={importing}
        onImport={importFilter}
        onDismiss={dismissFilter}
      />

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
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{nb.title}</div>
                    <div className="text-xs text-muted">
                      {new Date(nb.created_at).toLocaleString()}
                    </div>
                  </div>
                  {health[(nb.rag_backend ?? "openrag") as "openrag" | "workbench"] === "down" && (
                    <span className="rounded-full border border-amber-600/50 bg-amber-950/60 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-amber-400">
                      Read only
                    </span>
                  )}
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
                    // Reimport is only meaningful for OpenRAG notebooks that have
                    // a linked filter — it pulls in any new data_sources filenames.
                    ...(nb.rag_backend !== "workbench" && nb.openrag_filter_id
                      ? [{
                          label: "Reimport sources",
                          onClick: () => reimportFilter(nb),
                        }]
                      : []),
                    {
                      label: "Delete notebook",
                      variant: "danger" as const,
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
// UnlinkedFilterBanner — amber strip listing filters with no local notebook
// ============================================================================
// Rendered between the create form and the notebook list. Each row shows the
// filter name, how many source files it has, and Import / Dismiss buttons.
// Disappears automatically once all entries are imported or dismissed.
// ============================================================================
function UnlinkedFilterBanner({
  filters,
  importing,
  onImport,
  onDismiss,
}: {
  filters: UnlinkedFilter[];
  importing: string | null;
  onImport: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  if (filters.length === 0) return null;

  return (
    <div className="mb-6 rounded-lg border border-amber-600/50 bg-amber-950/40 px-4 py-3">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-amber-400">
        OpenRAG filters without a notebook
      </p>
      <ul className="space-y-2">
        {filters.map((f) => (
          <li key={f.id} className="flex items-center justify-between gap-3 text-sm">
            <span className="text-amber-200/90">
              <span className="font-medium">{f.name}</span>
              {f.docCount > 0 && (
                <span className="ml-1.5 text-xs text-amber-400/70">
                  ({f.docCount} {f.docCount === 1 ? "source" : "sources"})
                </span>
              )}
            </span>
            <div className="flex shrink-0 gap-2">
              <button
                onClick={() => onImport(f.id)}
                disabled={importing === f.id}
                className="flex items-center gap-1.5 rounded border border-amber-600/50 bg-amber-900/50 px-2.5 py-1 text-xs font-medium text-amber-300 transition hover:bg-amber-800/60 disabled:opacity-50"
              >
                {importing === f.id && <Spinner size="sm" />}
                {importing === f.id ? "Importing…" : "Import"}
              </button>
              <button
                onClick={() => onDismiss(f.id)}
                disabled={importing === f.id}
                className="rounded border border-white/10 px-2.5 py-1 text-xs text-muted transition hover:text-white disabled:opacity-50"
              >
                Dismiss
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
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
// Only renders buttons for backends that are configured (env var set). An
// unconfigured backend is intentionally absent — we don't even show it.
// A configured-but-offline backend is shown disabled so the user can see
// something is wrong without being misled about availability.
// If only one backend is configured the picker renders a single static button
// (no toggle needed).
// ============================================================================
const ALL_BACKEND_OPTIONS = [
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
  // Hide any backend the user hasn't configured. "unknown" passes through so
  // we don't flash an empty picker on first paint before the poll returns.
  const options = ALL_BACKEND_OPTIONS.filter(
    (opt) => health[opt.value] !== "unconfigured"
  );

  // Nothing configured yet (still loading) — render nothing.
  if (options.length === 0) return null;

  return (
    <div className="flex rounded-lg border border-edge overflow-hidden">
      {options.map((opt) => {
        const active   = value === opt.value;
        const offline  = health[opt.value] === "down";
        // A single configured backend needs no toggle — render it as a static label.
        const clickable = options.length > 1 && !offline;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => clickable && onChange(opt.value)}
            disabled={offline || options.length === 1}
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

  // No dot when health is still loading, or when the backend isn't configured
  // (unconfigured notebooks belong to a setup that no longer exists — no point
  // marking them red; they just silently have no live backend).
  const dot = (status === "unknown" || status === "unconfigured") ? null : (
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
