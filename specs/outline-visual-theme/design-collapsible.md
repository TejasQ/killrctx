# Design — Collapsible H2 Sections (REQ-006)

## Overview

`outlineComponents` renders markdown nodes in isolation — the `h2` renderer cannot
see its following siblings, so it cannot hide them on click. To make H2 sections
collapsible we must pre-process the markdown into explicit `{ heading, body }` pairs
*before* passing anything to ReactMarkdown.

The solution: a new `OutlineRenderer` component that splits raw markdown by H2
boundaries and renders each section as an independent accordion item. No new files —
`OutlineRenderer` lives in `page.tsx` alongside `outlineComponents`.

---

## UI changes — `src/app/notebooks/[id]/page.tsx`

### New helper: `splitOutlineSections(markdown)`

```ts
type OutlineSection = { heading: string; body: string };

function splitOutlineSections(markdown: string): OutlineSection[]
```

Walks the markdown string line by line. Every line that starts with `## ` (exactly
two hashes + space) begins a new section. Everything between two H2 boundaries (or
between the last H2 and EOF) is that section's body.

Lines before the first H2 (preamble, if any) are collected into a section with an
empty heading string and rendered without a collapsible wrapper.

This is a plain string split — no AST parsing, no remark dependency. Simple and
readable.

### New component: `OutlineRenderer`

```tsx
function OutlineRenderer({ content }: { content: string })
```

1. Calls `splitOutlineSections(fixMarkdown(content))`.
2. Renders the preamble section (empty heading) directly if present.
3. For each remaining section, renders a collapsible block:
   - A clickable H2 chip (same rose styling as `outlineComponents.h2`) with a
     `▾` / `▸` chevron on the right edge indicating open/closed state.
   - The section body rendered via `ReactMarkdown` with `outlineComponents` when
     expanded, hidden when collapsed.
4. Each section manages its own `open` boolean via `useState(true)` (starts expanded).

The H2 chip inside `OutlineRenderer` is rendered directly (not via ReactMarkdown's
`h2` renderer) because we need the `onClick` handler. `outlineComponents.h2` remains
unchanged — it still applies when H2s appear in non-collapsible contexts (e.g. the
in-flight streaming preview, which continues to use `outlineComponents` directly).

### Change: wire `OutlineRenderer` into `NoteCard` and expanded reading view

Replace the two `ReactMarkdown` calls that currently switch on `note.type === "outline"`
with `<OutlineRenderer content={...} />`.

The in-flight streaming preview in `StudioPanel` continues to use `ReactMarkdown`
with `outlineComponents` directly — sections are partially streamed so splitting by
H2 boundary would be unstable mid-stream.

---

## REQ coverage (additions)

| REQ-ID  | Design item |
|---------|-------------|
| REQ-006 | `splitOutlineSections` + `OutlineRenderer` with per-section `useState(true)` |
