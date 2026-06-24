// ============================================================================
// MindMapRenderer.tsx — a React component that renders a mindmap note as a
//                        visual, interactive node graph using ReactFlow
// ============================================================================
//
// _Basically_, mindmap notes are stored as nested markdown lists (- item,
//   - child). This component parses that text into a tree, lays it out as a
// horizontal left-to-right graph, and hands the result to ReactFlow to render.
//
// Visual design principles applied here:
//   - All colours come from the app's Tailwind tokens (ink, panel, edge, accent)
//     via CSS variables — no hardcoded hex except the edge token (#222226) which
//     ReactFlow's style prop requires as a JS string.
//   - Nodes are sized by depth: root > branch > leaf.
//   - Each top-level branch inherits one hue from BRANCH_COLORS; depth drives
//     opacity within that hue so the hierarchy reads at a glance.
//   - Source/citation nodes (lines containing "(Source:") are visually muted
//     and smaller — they're references, not concepts.
//   - Fullscreen: a toggle button inside the graph mounts a fixed overlay so
//     the user can explore large maps without the Studio panel's constraints.
//
// Layout constants live at the top — change them to adjust the feel of the
// graph without touching the render logic.
// ============================================================================

"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import ReactFlow, {
  Background,
  Controls,
  Panel,
  type Node,
  type Edge,
} from "reactflow";
import "reactflow/dist/style.css";

// ── Layout constants ──────────────────────────────────────────────────────────
// JS pixel values — Tailwind can't drive ReactFlow's x/y coordinate math.
const NODE_X_STEP = 280; // horizontal gap between depth levels
const NODE_Y_STEP = 80;  // vertical gap between sibling nodes

// Per-depth node dimensions. Index = depth level; last entry applies to all
// deeper levels.
const DEPTH_STYLES: { width: number; height: number; fontSize: number; fontWeight: number }[] = [
  { width: 200, height: 44, fontSize: 15, fontWeight: 700 }, // depth 0 — root
  { width: 170, height: 38, fontSize: 13, fontWeight: 600 }, // depth 1 — branch
  { width: 150, height: 32, fontSize: 12, fontWeight: 400 }, // depth 2 — sub-branch
  { width: 140, height: 28, fontSize: 11, fontWeight: 400 }, // depth 3+ — leaf
];

// Source/citation nodes are smaller and muted.
const SOURCE_STYLE = { width: 130, height: 26, fontSize: 10, fontWeight: 400 };

// One hue per top-level branch. These are the same accent colours used by the
// note-type grid cards — intentional visual language continuity.
// Format: [border hex, background hex (with opacity in style)]
const BRANCH_COLORS = [
  { border: "#7c5cff", bg: "rgba(124,92,255,0.15)"  }, // accent purple
  { border: "#ec4899", bg: "rgba(236,72,153,0.15)"  }, // pink
  { border: "#0ea5e9", bg: "rgba(14,165,233,0.15)"  }, // sky
  { border: "#6366f1", bg: "rgba(99,102,241,0.15)"  }, // indigo
  { border: "#10b981", bg: "rgba(16,185,129,0.15)"  }, // emerald
  { border: "#f59e0b", bg: "rgba(245,158,11,0.15)"  }, // amber
];

// ── Tree type ─────────────────────────────────────────────────────────────────
type TreeNode = {
  id:       string;
  label:    string;
  depth:    number;
  // Index of the top-level branch this node belongs to (for colour inheritance).
  branchIndex: number;
  isSource: boolean;
  children: TreeNode[];
};

// ── parseMindMap ──────────────────────────────────────────────────────────────
// Converts a nested markdown list string into a TreeNode tree.
// Only lines starting with "- " (after stripping leading spaces) are processed.
// Depth is Math.floor(leadingSpaces / 2), matching the AI prompt convention.
// Lines whose label contains "(Source:" are flagged as source nodes.
function parseMindMap(content: string): TreeNode | null {
  const lines = content.split("\n");
  const stack: TreeNode[] = [];
  let root:        TreeNode | null = null;
  let branchCount = 0; // increments for each depth-1 node to assign hue

  for (const line of lines) {
    const match = line.match(/^(\s*)- (.+)/);
    if (!match) continue;

    const depth    = Math.floor(match[1].length / 2);
    const label    = match[2].trim();
    const isSource = label.includes("(Source:");

    // Stable ID: join ancestor ids + position among siblings.
    const id =
      depth === 0
        ? "0"
        : stack
            .slice(0, depth)
            .map((n) => n.id)
            .join("-") + `-${stack[depth - 1]?.children.length ?? 0}`;

    // Branch index: depth-1 nodes each get the next colour; deeper nodes
    // inherit from their depth-1 ancestor via the stack.
    let branchIndex = 0;
    if (depth === 0) {
      branchIndex = 0;
    } else if (depth === 1) {
      branchIndex = branchCount % BRANCH_COLORS.length;
      branchCount++;
    } else {
      branchIndex = stack[1]?.branchIndex ?? 0;
    }

    const node: TreeNode = { id, label, depth, branchIndex, isSource, children: [] };

    if (depth === 0) {
      root     = node;
      stack[0] = node;
    } else {
      const parent = stack[depth - 1];
      if (parent) {
        parent.children.push(node);
        stack[depth] = node;
        stack.splice(depth + 1); // clear stale deeper ancestors
      }
    }
  }

  return root;
}

// ── nodeStyle ─────────────────────────────────────────────────────────────────
// Returns the inline `style` object for a ReactFlow node.
// We use inline styles (not className) because ReactFlow's default stylesheet
// has higher specificity than Tailwind utility classes on the node wrapper.
function nodeStyle(
  tn: TreeNode,
  depth: number,
): React.CSSProperties {
  const ds   = DEPTH_STYLES[Math.min(depth, DEPTH_STYLES.length - 1)];
  const dims = tn.isSource ? SOURCE_STYLE : ds;
  const col  = BRANCH_COLORS[tn.branchIndex];

  if (tn.isSource) {
    // Source nodes: muted, no branch colour, italic label handled via labelStyle.
    return {
      width:           dims.width,
      height:          dims.height,
      fontSize:        dims.fontSize,
      fontWeight:      dims.fontWeight,
      background:      "#141416",        // panel token
      border:          "1px solid #222226", // edge token
      borderRadius:    6,
      color:           "#8a8a92",        // muted token
      display:         "flex",
      alignItems:      "center",
      justifyContent:  "center",
      padding:         "0 8px",
      fontStyle:       "italic",
      opacity:         0.75,
    };
  }

  if (depth === 0) {
    // Root: accent-coloured, prominent.
    return {
      width:           dims.width,
      height:          dims.height,
      fontSize:        dims.fontSize,
      fontWeight:      dims.fontWeight,
      background:      "rgba(124,92,255,0.2)", // accent/20
      border:          "2px solid #7c5cff",    // accent token
      borderRadius:    10,
      color:           "#ffffff",
      display:         "flex",
      alignItems:      "center",
      justifyContent:  "center",
      padding:         "0 12px",
      boxShadow:       "0 0 16px rgba(124,92,255,0.25)",
    };
  }

  // Branch and leaf nodes: inherit the branch hue, fading with depth.
  const opacityFactor = Math.max(0.4, 1 - (depth - 1) * 0.2);
  return {
    width:           dims.width,
    height:          dims.height,
    fontSize:        dims.fontSize,
    fontWeight:      dims.fontWeight,
    background:      col.bg,
    border:          `1px solid ${col.border}`,
    borderRadius:    8,
    color:           depth === 1 ? "#ffffff" : "#d1d5db",
    display:         "flex",
    alignItems:      "center",
    justifyContent:  "center",
    padding:         "0 10px",
    opacity:         opacityFactor,
  };
}

// ── buildGraph ────────────────────────────────────────────────────────────────
// BFS → ReactFlow nodes[] + edges[].
// Layout: horizontal left-to-right tree. Each depth level is NODE_X_STEP px to
// the right. Siblings are spaced NODE_Y_STEP px apart, parents centred over
// their children.
function buildGraph(root: TreeNode): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  // Collect all items in BFS order, recording parent relationship.
  type Item = { tn: TreeNode; depth: number; parentId: string | null };
  const all: Item[] = [];
  const queue: Item[] = [{ tn: root, depth: 0, parentId: null }];
  while (queue.length) {
    const item = queue.shift()!;
    all.push(item);
    for (const child of item.tn.children) {
      queue.push({ tn: child, depth: item.depth + 1, parentId: item.tn.id });
    }
  }

  // Assign Y positions: recurse from root, accumulate a leaf counter so each
  // leaf gets a unique row; parents centre over their children's Y range.
  let leafY = 0;
  const yMap: Record<string, number> = {};
  function assignY(tn: TreeNode): number {
    if (tn.children.length === 0) {
      yMap[tn.id] = leafY * NODE_Y_STEP;
      leafY++;
      return yMap[tn.id];
    }
    const childYs = tn.children.map(assignY);
    yMap[tn.id]   = (childYs[0] + childYs[childYs.length - 1]) / 2;
    return yMap[tn.id];
  }
  assignY(root);

  for (const { tn, depth, parentId } of all) {
    nodes.push({
      id:       tn.id,
      data:     { label: tn.label },
      position: { x: depth * NODE_X_STEP, y: yMap[tn.id] },
      style:    nodeStyle(tn, depth),
      // Suppress ReactFlow's default node chrome (handles, selection ring).
      type:     "default",
    });

    if (parentId !== null) {
      const col = BRANCH_COLORS[tn.branchIndex];
      edges.push({
        id:     `e-${parentId}-${tn.id}`,
        source: parentId,
        target: tn.id,
        style:  {
          stroke:      tn.isSource ? "#222226" : col.border,
          strokeWidth: depth === 1 ? 2 : 1,
          opacity:     tn.isSource ? 0.4 : 0.6,
        },
      });
    }
  }

  return { nodes, edges };
}

// ── MindMapRenderer ───────────────────────────────────────────────────────────
export default function MindMapRenderer({
  content,
  variant,
}: {
  content: string;
  variant: "card" | "expanded";
}) {
  const [fullscreen, setFullscreen] = useState(false);

  // Exit fullscreen on Escape.
  useEffect(() => {
    if (!fullscreen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setFullscreen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  const { nodes, edges } = useMemo(() => {
    const root = parseMindMap(content);
    if (!root) return { nodes: [], edges: [] };
    return buildGraph(root);
  }, [content]);

  const handleFullscreenToggle = useCallback(
    () => setFullscreen((f) => !f),
    [],
  );

  if (nodes.length === 0) {
    return <p className="text-xs text-muted">No mind map content.</p>;
  }

  const heightClass =
    variant === "expanded" ? "h-mindmap-expanded" : "h-mindmap-card";

  const graph = (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      fitView
      fitViewOptions={{ padding: 0.2 }}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      proOptions={{ hideAttribution: true }}
      // Override ReactFlow's default white node background globally.
      style={{ background: "#0b0b0c" }}
    >
      {/* Dark dot grid that matches the app's ink background */}
      <Background color="#222226" gap={28} size={1} />
      <Controls showInteractive={false} />
      {/* Fullscreen toggle — top-right corner of the graph */}
      <Panel position="top-right">
        <button
          onClick={handleFullscreenToggle}
          title={fullscreen ? "Exit fullscreen (Esc)" : "Fullscreen"}
          className="rounded border border-edge bg-panel px-2 py-1 text-xs text-muted hover:border-accent hover:text-white transition-colors"
        >
          {fullscreen ? "⊠" : "⛶"}
        </button>
      </Panel>
    </ReactFlow>
  );

  // Fullscreen: fixed overlay that fills the viewport.
  if (fullscreen) {
    return (
      <div className="fixed inset-0 z-50 bg-ink">
        {graph}
      </div>
    );
  }

  return (
    <div className={`w-full ${heightClass} rounded-lg border border-edge overflow-hidden`}>
      {graph}
    </div>
  );
}
