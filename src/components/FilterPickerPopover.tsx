// ============================================================================
// FilterPickerPopover.tsx — click-to-edit popover for filter icon and color
// ============================================================================
//
// _Basically_, wraps the FilterBadge in a button. Clicking it opens a small
// popover with color swatches and an icon grid — the same picker OpenRAG
// shows in its own filter editor. Selecting a color or icon saves immediately
// via PATCH /api/notebooks/[id]/filter-meta and calls onSaved so the badge
// updates without waiting for the next full refresh.
//
// Colors and icons match OpenRAG's scheme exactly (sourced from FilterForm.tsx
// in SonicDMG/rag-to-model-compare). Popover shell follows the same pattern
// as ModelPickerPopover.tsx.
// ============================================================================

"use client";

import { useEffect, useRef, useState } from "react";
import FilterBadge from "./FilterBadge";
import {
  Filter, Book, ScrollText, Library, Map, FileImage, Layers3, Database,
  Folder, Archive, MessagesSquare, SquareStack, Ghost, Gem, Swords, Bolt,
  Shield, Hammer, Globe, HardDrive, Upload, Cable, ShoppingCart, ShoppingBag,
  type LucideIcon,
} from "lucide-react";

// ─── data ─────────────────────────────────────────────────────────────────

const COLOR_OPTIONS: { value: string; bg: string }[] = [
  { value: "zinc",    bg: "bg-zinc-500"    },
  { value: "pink",    bg: "bg-pink-500"    },
  { value: "purple",  bg: "bg-purple-500"  },
  { value: "indigo",  bg: "bg-indigo-500"  },
  { value: "teal",    bg: "bg-teal-500"    },
  { value: "emerald", bg: "bg-emerald-500" },
  { value: "amber",   bg: "bg-amber-500"   },
  { value: "red",     bg: "bg-red-500"     },
];

const ICON_OPTIONS: { name: string; Icon: LucideIcon }[] = [
  { name: "filter",        Icon: Filter        },
  { name: "book",          Icon: Book          },
  { name: "scroll",        Icon: ScrollText    },
  { name: "library",       Icon: Library       },
  { name: "map",           Icon: Map           },
  { name: "image",         Icon: FileImage     },
  { name: "layers3",       Icon: Layers3       },
  { name: "database",      Icon: Database      },
  { name: "folder",        Icon: Folder        },
  { name: "archive",       Icon: Archive       },
  { name: "messagesSquare",Icon: MessagesSquare},
  { name: "squareStack",   Icon: SquareStack   },
  { name: "ghost",         Icon: Ghost         },
  { name: "gem",           Icon: Gem           },
  { name: "swords",        Icon: Swords        },
  { name: "bolt",          Icon: Bolt          },
  { name: "shield",        Icon: Shield        },
  { name: "hammer",        Icon: Hammer        },
  { name: "globe",         Icon: Globe         },
  { name: "hardDrive",     Icon: HardDrive     },
  { name: "upload",        Icon: Upload        },
  { name: "cable",         Icon: Cable         },
  { name: "shoppingCart",  Icon: ShoppingCart  },
  { name: "shoppingBag",   Icon: ShoppingBag   },
];

// ─── component ────────────────────────────────────────────────────────────

export default function FilterPickerPopover({
  notebookId,
  name,
  icon,
  color,
  onSaved,
}: {
  notebookId: string;
  name: string;
  icon: string | null;
  color: string | null;
  /** Called with fresh { icon, color } after a successful save. */
  onSaved: (icon: string, color: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Optimistic local selections — start from current values.
  const [localIcon, setLocalIcon] = useState(icon ?? "filter");
  const [localColor, setLocalColor] = useState(color ?? "teal");

  // Keep local state in sync if parent sends updated props (e.g. after refresh).
  useEffect(() => { setLocalIcon(icon ?? "filter"); }, [icon]);
  useEffect(() => { setLocalColor(color ?? "teal"); }, [color]);

  const popoverRef = useRef<HTMLDivElement>(null);

  // Close on outside click — discard unsaved local selections.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
        setError(null);
        // Reset to the last committed values so the badge doesn't stay on
        // a selection the user abandoned by clicking away.
        setLocalIcon(icon ?? "filter");
        setLocalColor(color ?? "teal");
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, icon, color]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/notebooks/${notebookId}/filter-meta`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ icon: localIcon, color: localColor }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `save failed (${res.status})`);
      onSaved(data.icon, data.color);
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="relative" ref={popoverRef}>
      {/* Trigger — the FilterBadge itself */}
      <button
        onClick={() => { setOpen((v) => !v); setError(null); }}
        className="cursor-pointer appearance-none bg-transparent p-0 border-0"
        aria-expanded={open}
        aria-haspopup="true"
        title="Edit filter icon and color"
      >
        <FilterBadge name={name} icon={localIcon} color={localColor} />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 left-0 w-72 rounded-lg border border-edge bg-panel shadow-xl p-3 space-y-3">

          {/* Color row */}
          <div>
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted">Color</p>
            <div className="flex gap-2">
              {COLOR_OPTIONS.map(({ value, bg }) => (
                <button
                  key={value}
                  onClick={() => setLocalColor(value)}
                  disabled={saving}
                  className={`h-6 w-6 rounded-full border-2 transition-all ${bg} ${
                    localColor === value
                      ? "border-white scale-110"
                      : "border-transparent hover:border-white/50"
                  }`}
                  title={value}
                  aria-pressed={localColor === value}
                />
              ))}
            </div>
          </div>

          {/* Icon grid */}
          <div>
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted">Icon</p>
            <div className="grid grid-cols-6 gap-1">
              {ICON_OPTIONS.map(({ name: iconName, Icon }) => (
                <button
                  key={iconName}
                  onClick={() => setLocalIcon(iconName)}
                  disabled={saving}
                  className={`flex h-8 w-8 items-center justify-center rounded border transition-all ${
                    localIcon === iconName
                      ? "border-white/60 bg-white/10 text-white"
                      : "border-transparent text-muted hover:border-edge hover:text-white"
                  }`}
                  title={iconName}
                  aria-pressed={localIcon === iconName}
                >
                  <Icon className="h-3.5 w-3.5" />
                </button>
              ))}
            </div>
          </div>

          {/* Update button + error feedback */}
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={() => void save()}
              disabled={saving}
              className="flex-1 rounded border border-edge bg-edge/40 py-1 text-xs text-white hover:bg-edge/70 disabled:opacity-50 transition-colors"
            >
              {saving ? "Saving…" : "Update"}
            </button>
            {error && (
              <span className="text-[10px] text-red-400">{error}</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
