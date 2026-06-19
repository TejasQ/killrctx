# Design — Outline Visual Theme

## Overview

The Outline note type gets its own `markdownComponents` override — `outlineComponents`
— that replaces the generic renderers for `h2`, `h3`, `h4`, `ol`, and `li` with
depth-aware styled versions. Everything else (tables, code, blockquotes, etc.) falls
through to the shared `markdownComponents`.

The prompt in the route is sharpened to produce a three-level structure that the
visual theme is designed for.

No new files, no new DB columns, no API route changes.

Colors are drawn from the app's existing filter color palette:
**amber** (H2) → **teal** (H3) → **indigo** (H4).

---

## UI changes — `src/app/notebooks/[id]/page.tsx`

### New: `outlineComponents` constant

Defined immediately after `markdownComponents`. It spreads `markdownComponents` and
overrides five renderers:

```ts
const outlineComponents: Components = {
  ...markdownComponents,

  // H2 — top-level section (Roman numeral level). Thickest rail, amber.
  h2: ({ children }) => (
    <h2 className="mt-4 mb-1 border-l-4 border-amber-400/70 pl-3 text-sm font-bold text-amber-300 first:mt-0">
      {children}
    </h2>
  ),

  // H3 — subsection (letter level). Mid-weight rail, teal.
  h3: ({ children }) => (
    <h3 className="mt-3 mb-1 border-l-[3px] border-teal-400/60 pl-3 text-sm font-semibold text-teal-300">
      {children}
    </h3>
  ),

  // H4 — sub-subsection. Thinnest rail, indigo.
  h4: ({ children }) => (
    <h4 className="mt-2 mb-0.5 border-l-2 border-indigo-400/50 pl-3 text-xs font-semibold text-indigo-300">
      {children}
    </h4>
  ),

  // ol — inject a 1-based data-idx onto each child li so the li renderer
  // can draw a pill badge without needing the (untyped) `index` prop.
  ol: ({ children }) => (
    <ol className="mb-2 space-y-1 pl-1">
      {React.Children.map(children, (child, i) =>
        React.isValidElement(child)
          ? React.cloneElement(child as React.ReactElement<{ "data-idx": number }>, { "data-idx": i + 1 })
          : child
      )}
    </ol>
  ),

  // li — read the injected data-idx to render an amber pill badge.
  li: ({ children, ...rest }) => {
    const n = (rest as Record<string, unknown>)["data-idx"];
    return (
      <li className="flex items-start gap-2">
        {typeof n === "number" && (
          <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-amber-400/20 text-[10px] font-semibold text-amber-300">
            {n}
          </span>
        )}
        <span className="flex-1">{children}</span>
      </li>
    );
  },
};
```

**Why spread `markdownComponents`?** Tables, code blocks, blockquotes, strong, em, etc.
keep their existing dark-theme styles. Only the five outline-specific elements change.

### Change: `NoteCard` — use `outlineComponents` for outline notes

```tsx
<ReactMarkdown
  remarkPlugins={[remarkGfm]}
  components={note.type === "outline" ? outlineComponents : markdownComponents}
>
```

### Change: expanded reading view — use `outlineComponents` for outline notes

```tsx
<ReactMarkdown
  remarkPlugins={[remarkGfm]}
  components={expandedNote.type === "outline" ? outlineComponents : markdownComponents}
>
```

---

## Route changes — `src/app/api/notebooks/[id]/notes/[noteId]/route.ts`

### Change: sharpen the `outline` prompt

```ts
outline:
  "Write a structured hierarchical outline of the topics covered in the sources. " +
  "Use exactly three levels of structure:\n" +
  "  ## Roman numeral headings (## I, ## II, ## III …) for top-level sections.\n" +
  "  ### Letter headings (### A, ### B, ### C …) for subsections under each Roman numeral.\n" +
  "  Numbered lists (1. 2. 3.) for detail points under each letter heading.\n" +
  "Use only headings and numbered list items — no prose paragraphs, no bullet points.",
```

---

## REQ coverage

| REQ-ID  | Design item that covers it |
|---------|---------------------------|
| REQ-001 | `outlineComponents` h2/h3/h4 text color classes (amber/teal/indigo) |
| REQ-002 | `outlineComponents` h2/h3/h4 `border-l-*` classes |
| REQ-003 | `outlineComponents` `li` pill badge renderer |
| REQ-004 | Sharpened `outline` prompt in `NOTE_PROMPTS` |
| REQ-005 | `outlineComponents` spread from `markdownComponents`; conditional component selection in `NoteCard` and expanded view |
