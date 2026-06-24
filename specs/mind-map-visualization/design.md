# Design — Mind Map Visualization

## Overview

_Basically_, this feature is a pure UI addition. The mindmap content already exists as a
nested markdown list in the `notes` table. We add one new component file
(`MindMapRenderer`) that parses that list into a ReactFlow graph, then wire it into the
two places in `page.tsx` where mindmap content is currently rendered as raw markdown.

No DB changes. No API changes. No new prompts. No arbitrary colour values — node styles
use the existing Tailwind colour tokens (`panel`, `edge`, `accent`) defined in
`tailwind.config.ts`.

---

## New dependency

```bash
npm install reactflow
```

ReactFlow ships its own CSS that must be imported once in the app. We import it inside
`MindMapRenderer.tsx` itself so no global layout file needs to change.

## Changes to `tailwind.config.ts`

Two named height tokens are added so the component's container heights are not arbitrary
inline values:

```ts
height: {
  "mindmap-card":     "300px", // inline NoteCard preview
  "mindmap-expanded": "500px", // full Studio expanded view
}
```

These live in the config alongside the colour tokens — one place to change the feel of
the component.

---

## New file: `src/components/MindMapRenderer.tsx`

This is the only new file. It does two things:

### 1. Parse markdown list → tree

The AI generates content in this format:
```
- Root concept
  - Child A
    - Grandchild A1
    - Grandchild A2
  - Child B
```

A `parseMindMap(content: string)` function walks the lines, tracking indentation depth
to build a simple recursive tree:

```ts
type TreeNode = { id: string; label: string; children: TreeNode[] };
```

Rules:
- Lines that don't start with `- ` (after stripping leading spaces) are skipped.
- Depth is determined by `Math.floor(leadingSpaces / 2)` — matches the AI prompt's
  "indent child items with two spaces" instruction.
- Each node gets a stable `id` derived from its position in the tree (e.g. `"0"`,
  `"0-0"`, `"0-0-1"`).

### 2. Tree → ReactFlow nodes + edges

A `buildGraph(root: TreeNode)` function does a breadth-first walk and produces:

```ts
type FlowNode = { id: string; data: { label: string }; position: { x: number; y: number }; style?: React.CSSProperties };
type FlowEdge = { id: string; source: string; target: string };
```

**Layout:** horizontal tree, left-to-right.
- Each depth level is a fixed `X_STEP = 200` pixels to the right.
- Nodes at the same depth are stacked vertically with `Y_STEP = 60` pixels between them.
- The root sits at `{ x: 0, y: 0 }`. Child Y positions are centred on their parent's Y.

**Node styling** uses only existing Tailwind config tokens — no arbitrary hex values:
- Root node: `bg-accent/20 border-accent text-white` — visually distinct (REQ-004).
- All other nodes: `bg-panel border-edge text-muted` — matches the app's existing panel
  aesthetic without hardcoding colours.

### Component signature

```tsx
export default function MindMapRenderer({ content }: { content: string })
```

Renders a `<div>` whose height is controlled by a prop (`"card"` | `"expanded"`) that
maps to the Tailwind tokens added in `tailwind.config.ts`:
- `"card"` → `h-mindmap-card` (300 px, inline NoteCard preview)
- `"expanded"` → `h-mindmap-expanded` (500 px, full Studio view)

Updated signature:
```tsx
export default function MindMapRenderer({
  content,
  variant,
}: {
  content: string;
  variant: "card" | "expanded";
})
```

Inside: `<ReactFlow nodes={nodes} edges={edges} fitView />` with `<Controls />` and
`<Background />` sub-components from ReactFlow.

`fitView` is set so the whole graph is visible on first render regardless of note size.

---

## Changes to `src/app/notebooks/[id]/page.tsx`

Two targeted changes — both are `type === "mindmap"` branches inserted alongside the
existing `type === "outline"` branch.

### Change 1 — NoteCard inline preview (around line 1693)

Current:
```tsx
{note.type === "outline" ? (
  <OutlineRenderer content={note.content} topic={note.topic} />
) : (
  <ReactMarkdown ...>{fixMarkdown(note.content)}</ReactMarkdown>
)}
```

After:
```tsx
{note.type === "outline" ? (
  <OutlineRenderer content={note.content} topic={note.topic} />
) : note.type === "mindmap" ? (
  <MindMapRenderer content={note.content} />
) : (
  <ReactMarkdown ...>{fixMarkdown(note.content)}</ReactMarkdown>
)}
```

### Change 2 — Expanded (full Studio) view (around line 1479)

Current:
```tsx
expandedNote.type === "outline" ? (
  <OutlineRenderer content={expandedNote.content} topic={expandedNote.topic} />
) : (
  <ReactMarkdown ...>{fixMarkdown(expandedNote.content)}</ReactMarkdown>
)
```

After:
```tsx
expandedNote.type === "outline" ? (
  <OutlineRenderer content={expandedNote.content} topic={expandedNote.topic} />
) : expandedNote.type === "mindmap" ? (
  <MindMapRenderer content={expandedNote.content} />
) : (
  <ReactMarkdown ...>{fixMarkdown(expandedNote.content)}</ReactMarkdown>
)
```

Add the import at the top of `page.tsx`:
```tsx
import MindMapRenderer from "@/components/MindMapRenderer";
```

The expanded view's scrollable container (`overflow-y-auto`) is fine as-is — the
`MindMapRenderer` div has a fixed height so it won't fight the scroll container.

---

## REQ coverage table

| REQ-ID | Design item that covers it |
|--------|---------------------------|
| REQ-001 | Change 2 in `page.tsx` — expanded view uses `MindMapRenderer` |
| REQ-002 | Change 1 in `page.tsx` — NoteCard inline preview uses `MindMapRenderer` |
| REQ-003 | `parseMindMap()` reads existing `- item` nested list format, no content change needed |
| REQ-004 | Root node style in `buildGraph()` — visually distinct via CSS |
| REQ-005 | ReactFlow `<Controls />` provides zoom buttons; canvas pan is built-in |
| REQ-006 | No changes to `src/lib/db.ts` or any file under `src/app/api/` |
