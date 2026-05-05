// ============================================================================
// MenuButton.tsx — the small "⋯" overflow menu used everywhere
// ============================================================================
//
// _Basically_, click the three dots, see a list of actions, click one of
// them. Used by the home page (delete notebook) and the Sources panel
// (delete source). Closes on outside-click or Escape.
//
// Why a hand-rolled menu and not a library?
//   We need exactly one type of menu, the trigger is a 24px button, and
//   pulling in @headlessui or radix-ui for this would be six more deps and
//   more configuration than just writing it. The whole thing is ~40 lines.
//
// Accessibility shortcuts:
//   - Trigger has aria-label="More actions".
//   - Menu items are real <button>s so they're keyboard-focusable.
//   - Escape closes; outside-click closes via a global listener attached
//     while open.
// ============================================================================

"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

export type MenuAction = {
  /** Label shown in the menu item. Keep it short. */
  label: string;
  /** Click handler — runs after the menu auto-closes. */
  onClick: () => void;
  /** Visual variant: "danger" tints the row red (delete actions). */
  variant?: "default" | "danger";
};

export default function MenuButton({
  actions,
  children,
}: {
  actions: MenuAction[];
  /** Optional custom trigger; defaults to a "⋯" icon button. */
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape. Listeners are only attached while the
  // menu is open so we don't cost anything when it's idle.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          // Prevent the click from bubbling up to a parent <Link> or row
          // handler — without this, clicking the menu trigger on a notebook
          // card would also navigate into the notebook.
          e.preventDefault();
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className="rounded p-1 text-muted hover:bg-edge hover:text-white"
      >
        {children ?? <DotsIcon />}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-10 mt-1 min-w-[140px] overflow-hidden rounded-md border border-edge bg-panel py-1 text-sm shadow-lg"
        >
          {actions.map((a) => (
            <button
              key={a.label}
              role="menuitem"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setOpen(false);
                a.onClick();
              }}
              className={`block w-full px-3 py-1.5 text-left ${
                a.variant === "danger"
                  ? "text-red-300 hover:bg-red-950/40"
                  : "hover:bg-edge"
              }`}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function DotsIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <circle cx="3" cy="8" r="1.4" />
      <circle cx="8" cy="8" r="1.4" />
      <circle cx="13" cy="8" r="1.4" />
    </svg>
  );
}
