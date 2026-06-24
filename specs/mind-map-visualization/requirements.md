# Requirements — Mind Map Visualization

## User story

As a notebook user, I want mind map notes to be displayed as an interactive visual graph
so that I can explore the relationships between concepts more intuitively than reading a
nested list.

---

## Requirements

**REQ-001** — Visual rendering in expanded view  
When a `mindmap` note is opened in the full Studio expanded view, the content is
rendered as a graphical node-and-edge tree using ReactFlow.  
_Acceptance:_ The expanded view shows a zoomable, pannable node graph — not the raw
markdown list.

**REQ-002** — Visual rendering in inline card preview  
When a `mindmap` note's inline card is expanded (the ▸ toggle on the NoteCard), the
content is rendered as the same graphical node-and-edge tree, not the markdown list.  
_Acceptance:_ The inline preview shows the mind map graph in a fixed-height container.

**REQ-003** — Markdown list parsed to tree  
The existing mindmap content format (nested `- item` markdown lists) is parsed into a
hierarchical tree without requiring any change to the AI prompt or stored content.  
_Acceptance:_ Existing saved mindmap notes render correctly with no re-generation needed.

**REQ-004** — Root node visible  
The root concept (first top-level `- item`) is rendered as the centre/root node with
child nodes branching from it.  
_Acceptance:_ Root node is visually distinct (larger or differently styled).

**REQ-005** — Interactive controls  
The graph supports pan and zoom via mouse/trackpad.  
_Acceptance:_ User can pan by dragging the canvas and zoom with scroll wheel / pinch.

**REQ-006** — No new AI call or schema change  
The feature uses only the content already stored in the `notes` table. No new API
routes, no DB changes, no new OpenRAG prompts.  
_Acceptance:_ `git diff` shows no changes to `src/lib/db.ts` or any `api/` route file.

---

## Out of scope

- Editing the mind map (node drag-to-reposition is cosmetic only, not persisted)
- Exporting the mind map as an image or PDF
- Custom colour themes or node shapes per concept level
- Generating a new mindmap format — the existing nested-list format is kept as-is
- Any changes to how mindmap notes are generated or stored
