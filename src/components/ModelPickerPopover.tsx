// ============================================================================
// ModelPickerPopover.tsx — inline popover for switching LLM or embedding model
// ============================================================================
//
// _Basically_, clicking the rainbow model label (or the embedding label in the
// Sources panel) opens this popover. It lists available models/agents, and
// saves the selection — but how it fetches and saves depends on which backend
// the notebook uses.
//
// OpenRAG notebooks:
//   - Fetches models from /api/openrag-models
//   - Saves via PATCH /api/openrag-settings (global setting)
//
// Workbench notebooks:
//   - LLM kind:       fetches agents from /api/workbench/agents,
//                     saves via PATCH /api/notebooks/[id]/conversations/[convId]
//   - Embedding kind: fetches from /api/workbench/embedding-services,
//                     saves via PATCH /api/notebooks/[id] (workbench_embedding_service_id)
//
// Props:
//   kind         — "llm" or "embedding"
//   currentValue — display string shown on the trigger while closed
//   onSaved      — called back after a successful save
//   backend      — "openrag" (default) or "workbench"
//   notebookId   — required when backend="workbench"
//   convId       — required when backend="workbench" and kind="llm"
//   children     — the clickable trigger element
// ============================================================================

"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Spinner from "./Spinner";
import type { OpenRAGSettings } from "./OpenRAGContext";

// What the popover hands back after a successful save — different shapes per backend.
export type PickerSaveResult =
  | { backend: "openrag"; settings: OpenRAGSettings }
  | { backend: "workbench"; kind: "llm"; agentId: string; agentName: string }
  | { backend: "workbench"; kind: "embedding"; embeddingServiceId: string; embeddingServiceName: string };

// A flat list item works for both OpenRAG model groups and Workbench agents/services.
type PickerItem = { value: string; label: string };

export default function ModelPickerPopover({
  kind,
  currentValue,
  currentLabel,
  onSaved,
  align = "left",
  backend = "openrag",
  notebookId,
  convId,
  children,
}: {
  kind: "llm" | "embedding";
  /** The ID used for checkmark matching in the list. */
  currentValue: string;
  /** Human-readable label shown on the trigger. Falls back to currentValue if omitted. */
  currentLabel?: string;
  onSaved: (result: PickerSaveResult) => void;
  align?: "left" | "right";
  backend?: "openrag" | "workbench";
  notebookId?: string;
  convId?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<PickerItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Fetch available options once on first open.
  useEffect(() => {
    if (!open || items !== null) return;
    setLoading(true);
    setError(null);

    const url = backend === "workbench"
      ? (kind === "llm" ? "/api/workbench/agents" : "/api/workbench/embedding-services")
      : "/api/openrag-models";

    fetch(url)
      .then((r) => r.json())
      .then((data) => {
        if (backend === "workbench") {
          // Workbench returns { items: [{ agentId, name } | { embeddingServiceId, name }] }
          const raw: { agentId?: string; embeddingServiceId?: string; name: string }[] = data.items ?? [];
          setItems(raw.map((x) => ({
            value: x.agentId ?? x.embeddingServiceId ?? "",
            label: x.name,
          })));
        } else {
          // OpenRAG returns { groups: [{ provider, label, language_models, embedding_models }] }
          const groups: { provider: string; label: string; language_models: { value: string; label: string }[]; embedding_models: { value: string; label: string }[] }[] = data.groups ?? [];
          const flat: PickerItem[] = [];
          for (const g of groups) {
            const models = kind === "llm" ? g.language_models : g.embedding_models;
            for (const m of models) {
              flat.push({ value: `${g.provider}/${m.value}`, label: `${g.label} / ${m.label}` });
            }
          }
          setItems(flat);
        }
      })
      .catch(() => setError("Could not load options"))
      .finally(() => setLoading(false));
  }, [open, items, backend, kind]);

  // Focus the search input when the popover opens.
  useEffect(() => {
    if (open) setTimeout(() => searchRef.current?.focus(), 50);
  }, [open]);

  // Close on click outside.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  async function select(item: PickerItem) {
    setSaving(true);
    setError(null);
    try {
      if (backend === "workbench") {
        if (kind === "llm") {
          // PATCH the active conversation's agent.
          const res = await fetch(`/api/notebooks/${notebookId}/conversations/${convId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ workbench_agent_id: item.value }),
          });
          if (!res.ok) throw new Error(`save failed (${res.status})`);
          onSaved({ backend: "workbench", kind: "llm", agentId: item.value, agentName: item.label });
        } else {
          // PATCH the notebook's embedding service.
          const res = await fetch(`/api/notebooks/${notebookId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ workbench_embedding_service_id: item.value }),
          });
          if (!res.ok) throw new Error(`save failed (${res.status})`);
          onSaved({ backend: "workbench", kind: "embedding", embeddingServiceId: item.value, embeddingServiceName: item.label });
        }
      } else {
        // OpenRAG: split "provider/model" back apart.
        const slashIdx = item.value.indexOf("/");
        const provider = item.value.slice(0, slashIdx);
        const model = item.value.slice(slashIdx + 1);
        const res = await fetch("/api/openrag-settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind, provider, model }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `save failed (${res.status})`);
        onSaved({ backend: "openrag", settings: data as OpenRAGSettings });
      }
      setOpen(false);
      setSearch("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "save failed");
    } finally {
      setSaving(false);
    }
  }

  const filtered = (items ?? []).filter(
    (item) => !search || item.label.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="relative" ref={popoverRef}>
      {/* Trigger — whatever the parent passes as children */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="cursor-pointer appearance-none bg-transparent p-0 border-0"
        disabled={saving}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        {saving ? (
          <span className="flex items-center gap-1 text-xs text-muted">
            <Spinner size="xs" /> Saving…
          </span>
        ) : (
          children
        )}
      </button>

      {open && (
        <div className={`absolute z-50 mt-1 w-72 rounded-lg border border-edge bg-panel shadow-xl ${align === "right" ? "right-0" : "left-0"}`}>
          {/* Search */}
          <div className="border-b border-edge px-3 py-2">
            <input
              ref={searchRef}
              type="text"
              placeholder="Search…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full bg-transparent text-xs text-white placeholder-muted outline-none"
            />
          </div>

          {/* List */}
          <div className="max-h-72 overflow-y-auto py-1">
            {loading && (
              <div className="flex items-center gap-2 px-3 py-4 text-xs text-muted">
                <Spinner size="xs" /> Loading…
              </div>
            )}
            {!loading && filtered.length === 0 && (
              <p className="px-3 py-4 text-xs text-muted">
                {error ?? (search ? "No matches" : "Nothing available")}
              </p>
            )}
            {filtered.map((item) => {
              const isActive = item.value === currentValue;
              return (
                <button
                  key={item.value}
                  onClick={() => select(item)}
                  className={`flex w-full items-center gap-2 px-5 py-1.5 text-left text-xs hover:bg-edge/60 ${
                    isActive ? "text-white" : "text-muted hover:text-white"
                  }`}
                >
                  <span className="w-3 shrink-0">{isActive ? "✓" : ""}</span>
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })}
          </div>

          {/* Inline error footer */}
          {error && !loading && (
            <div className="border-t border-edge px-3 py-2 text-xs text-red-300">
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
