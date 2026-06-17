// ============================================================================
// ModelPickerPopover.tsx — inline popover for switching LLM or embedding model
// ============================================================================
//
// _Basically_, clicking the rainbow model label (or the embedding label in the
// Sources panel) opens this popover. It fetches the available models from
// /api/openrag-models on first open, groups them by provider, and saves the
// selection immediately via PATCH /api/openrag-settings.
//
// Props:
//   kind         — "llm" or "embedding": controls which column of models to show
//                  and which field PATCH updates.
//   currentValue — "provider/model" string shown on the trigger while closed.
//   onSaved      — called with fresh { llm, embedding } after a successful save.
//   children     — the clickable trigger element (rainbow span, emb label, etc).
// ============================================================================

"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Spinner from "./Spinner";
import type { OpenRAGSettings } from "./OpenRAGContext";
import type { ModelGroup } from "@/app/api/openrag-models/route";

export default function ModelPickerPopover({
  kind,
  currentValue,
  onSaved,
  align = "left",
  children,
}: {
  kind: "llm" | "embedding";
  currentValue: string;
  onSaved: (settings: OpenRAGSettings) => void;
  /** Which edge of the trigger the popover anchors to. Default "left". */
  align?: "left" | "right";
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [groups, setGroups] = useState<ModelGroup[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Fetch models once on first open, not on mount — no wasted requests for
  // users who never click the picker.
  useEffect(() => {
    if (!open || groups !== null) return;
    setLoading(true);
    setError(null);
    fetch("/api/openrag-models")
      .then((r) => r.json())
      .then((data: { groups: ModelGroup[] }) => setGroups(data.groups))
      .catch(() => setError("Could not load models"))
      .finally(() => setLoading(false));
  }, [open, groups]);

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

  async function select(provider: string, model: string) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/openrag-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, provider, model }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `save failed (${res.status})`);
      onSaved(data as OpenRAGSettings);
      setOpen(false);
      setSearch("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "save failed");
    } finally {
      setSaving(false);
    }
  }

  // Filter models by search term across all groups.
  const filteredGroups = (groups ?? [])
    .map((g) => {
      const models = kind === "llm" ? g.language_models : g.embedding_models;
      const filtered = search
        ? models.filter(
            (m) =>
              m.label.toLowerCase().includes(search.toLowerCase()) ||
              g.label.toLowerCase().includes(search.toLowerCase()),
          )
        : models;
      return { ...g, models: filtered };
    })
    .filter((g) => g.models.length > 0);

  // Split "provider/model" to highlight the active item.
  const [activeProvider, activeModel] = currentValue.split("/").length >= 2
    ? [currentValue.split("/")[0], currentValue.slice(currentValue.indexOf("/") + 1)]
    : ["", currentValue];

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
              placeholder="Search model…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full bg-transparent text-xs text-white placeholder-muted outline-none"
            />
          </div>

          {/* Model list */}
          <div className="max-h-72 overflow-y-auto py-1">
            {loading && (
              <div className="flex items-center gap-2 px-3 py-4 text-xs text-muted">
                <Spinner size="xs" /> Loading models…
              </div>
            )}
            {!loading && filteredGroups.length === 0 && (
              <p className="px-3 py-4 text-xs text-muted">
                {error ?? (search ? "No models match" : "No models available")}
              </p>
            )}
            {filteredGroups.map((g) => (
              <div key={g.provider}>
                {/* Provider heading */}
                <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted">
                  {g.label}
                </div>
                {g.models.map((m) => {
                  const isActive = g.provider === activeProvider && m.value === activeModel;
                  return (
                    <button
                      key={m.value}
                      onClick={() => select(g.provider, m.value)}
                      className={`flex w-full items-center gap-2 px-5 py-1.5 text-left text-xs hover:bg-edge/60 ${
                        isActive ? "text-white" : "text-muted hover:text-white"
                      }`}
                    >
                      {/* Checkmark placeholder keeps text aligned */}
                      <span className="w-3 shrink-0">{isActive ? "✓" : ""}</span>
                      <span className="truncate">{m.label}</span>
                    </button>
                  );
                })}
              </div>
            ))}
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
