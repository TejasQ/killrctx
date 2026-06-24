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
//   - Solid dark fills per branch (not transparent) — matches the reference
//     NotebookLM style where nodes are visually distinct blocks.
//   - Each top-level branch gets one of BRANCH_COLORS. Deeper nodes use the
//     same hue but slightly darker fills.
//   - Nodes with children show a collapse indicator (< when expanded, > when
//     collapsed). Clicking them toggles visibility of all descendants.
//   - Source/citation nodes (lines containing "(Source:") are muted.
//   - Fullscreen: a toggle button inside the graph mounts a fixed overlay.
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
const NODE_X_STEP = 300; // horizontal gap between depth levels
const NODE_Y_STEP = 68;  // vertical gap between sibling nodes

// Per-depth node dimensions. Index = depth level; last entry applies to all
// deeper levels.
const DEPTH_STYLES: { width: number; height: number; fontSize: number; fontWeight: number }[] = [
  { width: 210, height: 46, fontSize: 15, fontWeight: 700 }, // depth 0 — root
  { width: 180, height: 40, fontSize: 13, fontWeight: 600 }, // depth 1 — branch
  { width: 160, height: 34, fontSize: 12, fontWeight: 500 }, // depth 2 — sub-branch
  { width: 150, height: 30, fontSize: 11, fontWeight: 400 }, // depth 3+ — leaf
];

// Source/citation nodes are smaller and muted.
const SOURCE_STYLE = { width: 130, height: 26, fontSize: 10, fontWeight: 400 };

// Solid dark fills for each branch, inspired by the reference's muted-but-
// distinct color blocks. Each entry: [dark fill, border/accent].
// These are NOT rgba — the reference uses solid backgrounds.
const BRANCH_COLORS: { fill: string; border: string; text: string; childFill: string }[] = [
  { fill: "#1e1b4b", border: "#6366f1", text: "#c7d2fe", childFill: "#1a1840" }, // indigo
  { fill: "#134e4a", border: "#14b8a6", text: "#99f6e4", childFill: "#113d3a" }, // teal
  { fill: "#3b0764", border: "#a855f7", text: "#e9d5ff", childFill: "#2e0550" }, // purple
  { fill: "#1c1917", border: "#f97316", text: "#fed7aa", childFill: "#171412" }, // orange
  { fill: "#0c1a2e", border: "#3b82f6", text: "#bfdbfe", childFill: "#091525" }, // blue
  { fill: "#1a0a00", border: "#f59e0b", text: "#fde68a", childFill: "#140800" }, // amber
];

// ── TreeNode ──────────────────────────────────────────────────────────────────
type TreeNode = {
  id:          string;
  label:       string;
  depth:       number;
  branchIndex: number;
  isSource:    boolean;
  children:    TreeNode[];
};

// ── LEAKAGE_FILTERS ───────────────────────────────────────────────────────────
// Patterns that indicate LLM leakage: source citations, JSON fragments, or
// prose sentences that don't belong in a concept label.
const LEAKAGE_FILTERS: RegExp[] = [
  /\(Source:/i,
  /^\s*\{/,
  /^\s*"/,
  /[.!?]\s+[A-Z]/,
  /\{[^}]+\}/,
];
const MAX_LABEL_LENGTH = 60;

// ── parseMindMap ──────────────────────────────────────────────────────────────
function parseMindMap(content: string): TreeNode | null {
  const lines = content.split("\n");
  const stack: TreeNode[] = [];
  let root:        TreeNode | null = null;
  let branchCount = 0;

  for (const line of lines) {
    const match = line.match(/^(\s*)- (.+)/);
    if (!match) continue;

    const depth = Math.floor(match[1].length / 2);
    const label = match[2].trim();

    if (label.length > MAX_LABEL_LENGTH) continue;
    if (LEAKAGE_FILTERS.some((re) => re.test(label))) continue;

    const isSource = label.startsWith("(") && label.endsWith(")");

    const id =
      depth === 0
        ? "0"
        : stack
            .slice(0, depth)
            .map((n) => n.id)
            .join("-") + `-${stack[depth - 1]?.children.length ?? 0}`;

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
        stack.splice(depth + 1);
      }
    }
  }

  return root;
}

// ── nodeStyle ─────────────────────────────────────────────────────────────────
// Solid fills per branch — the key visual change from the previous version.
// The reference shows clearly readable blocks, not barely-tinted glass cards.
function nodeStyle(
  tn: TreeNode,
  depth: number,
  collapsed: boolean,
): React.CSSProperties {
  const ds   = DEPTH_STYLES[Math.min(depth, DEPTH_STYLES.length - 1)];
  const dims = tn.isSource ? SOURCE_STYLE : ds;
  const col  = BRANCH_COLORS[tn.branchIndex];

  if (tn.isSource) {
    return {
      width:          dims.width,
      height:         dims.height,
      fontSize:       dims.fontSize,
      fontWeight:     dims.fontWeight,
      background:     "#141416",
      border:         "1px solid #222226",
      borderRadius:   6,
      color:          "#8a8a92",
      display:        "flex",
      alignItems:     "center",
      justifyContent: "center",
      padding:        "0 8px",
      fontStyle:      "italic",
      opacity:        0.75,
    };
  }

  if (depth === 0) {
    return {
      width:          dims.width,
      height:         dims.height,
      fontSize:       dims.fontSize,
      fontWeight:     dims.fontWeight,
      background:     "#1e1b4b",
      border:         "2px solid #7c5cff",
      borderRadius:   10,
      color:          "#ffffff",
      display:        "flex",
      alignItems:     "center",
      justifyContent: "center",
      padding:        "0 12px",
      boxShadow:      "0 0 18px rgba(124,92,255,0.30)",
      cursor:         tn.children.length > 0 ? "pointer" : "default",
    };
  }

  // Branch and leaf nodes: solid dark fill, full-opacity border.
  // Child nodes use a slightly darker variant of the branch fill.
  const fill = depth === 1 ? col.fill : col.childFill;
  return {
    width:          dims.width,
    height:         dims.height,
    fontSize:       dims.fontSize,
    fontWeight:     dims.fontWeight,
    background:     fill,
    border:         `1px solid ${col.border}`,
    borderRadius:   8,
    color:          col.text,
    display:        "flex",
    alignItems:     "center",
    justifyContent: "space-between",
    padding:        "0 10px",
    gap:            "6px",
    cursor:         tn.children.length > 0 ? "pointer" : "default",
    // Subtle glow on branch-level nodes that have children.
    boxShadow:      depth === 1 && tn.children.length > 0
      ? `0 0 8px ${col.border}40`
      : undefined,
  };
}

// ── collapseIndicator ─────────────────────────────────────────────────────────
// The < / > badge shown on nodes that have children, matching the reference UI.
// We render it as a separate tiny span inside the node label string.
// ReactFlow's `data.label` accepts a React element, so we pass JSX.
function nodeLabel(tn: TreeNode, collapsed: boolean): React.ReactNode {
  const hasChildren = tn.children.length > 0;
  if (!hasChildren || tn.isSource) return tn.label;

  const indicator = collapsed ? "›" : "‹";
  const indicatorStyle: React.CSSProperties = {
    display:        "inline-flex",
    alignItems:     "center",
    justifyContent: "center",
    width:          18,
    height:         18,
    borderRadius:   4,
    background:     "rgba(255,255,255,0.08)",
    fontSize:       11,
    lineHeight:     1,
    flexShrink:     0,
    color:          "inherit",
    opacity:        0.75,
  };

  return (
    <span style={{ display: "flex", alignItems: "center", gap: 6, width: "100%" }}>
      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {tn.label}
      </span>
      <span style={indicatorStyle}>{indicator}</span>
    </span>
  );
}

// ── buildGraph ────────────────────────────────────────────────────────────────
// Walks the tree and produces ReactFlow nodes[] + edges[], skipping any subtree
// whose root is in `collapsedIds`. Collapsed nodes still appear; their children
// do not. Layout is the same horizontal BFS as before.
function buildGraph(
  root: TreeNode,
  collapsedIds: Set<string>,
  onToggle: (id: string) => void,
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  type Item = { tn: TreeNode; depth: number; parentId: string | null };
  const all: Item[] = [];
  const queue: Item[] = [{ tn: root, depth: 0, parentId: null }];

  // BFS — but skip children of collapsed nodes.
  while (queue.length) {
    const item = queue.shift()!;
    all.push(item);
    // Only enqueue children if this node is NOT collapsed.
    if (!collapsedIds.has(item.tn.id)) {
      for (const child of item.tn.children) {
        queue.push({ tn: child, depth: item.depth + 1, parentId: item.tn.id });
      }
    }
  }

  // Y layout over the visible subset only.
  let leafY = 0;
  const yMap: Record<string, number> = {};
  function assignY(tn: TreeNode): number {
    // If collapsed, treat as a leaf even if it has children.
    if (tn.children.length === 0 || collapsedIds.has(tn.id)) {
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
    const collapsed = collapsedIds.has(tn.id);
    const label     = nodeLabel(tn, collapsed);
    // Nodes with children get an onClick stored in data so handleNodeClick can
    // fire the collapse toggle. Leaf nodes just carry the label.
    const data = tn.children.length > 0
      ? { label, onClick: () => onToggle(tn.id) }
      : { label };
    nodes.push({
      id:       tn.id,
      data,
      position: { x: depth * NODE_X_STEP, y: yMap[tn.id] },
      style:    nodeStyle(tn, depth, collapsed),
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
          strokeWidth: depth === 1 ? 2 : 1.5,
          opacity:     tn.isSource ? 0.4 : 0.7,
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
  // Set of node ids that are currently collapsed.
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());

  // Exit fullscreen on Escape.
  useEffect(() => {
    if (!fullscreen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setFullscreen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  // Parse the tree once; only depends on content.
  const tree = useMemo(() => parseMindMap(content), [content]);

  // Toggle collapsed state: collapse expands/collapses the direct subtree.
  const handleToggle = useCallback((id: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  // Rebuild the graph whenever the tree or collapsed state changes.
  const { nodes, edges } = useMemo(() => {
    if (!tree) return { nodes: [], edges: [] };
    return buildGraph(tree, collapsedIds, handleToggle);
  }, [tree, collapsedIds, handleToggle]);

  const handleFullscreenToggle = useCallback(
    () => setFullscreen((f) => !f),
    [],
  );

  // ReactFlow fires onNodeClick with the click target's node data.
  // We use it to trigger collapse instead of passing callbacks through data,
  // which avoids re-registering custom node types.
  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      // Only toggle if the node has the onClick handler (i.e. has children).
      if (node.data?.onClick) node.data.onClick();
    },
    [],
  );

  if (!tree || nodes.length === 0) {
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
      onNodeClick={handleNodeClick}
      proOptions={{ hideAttribution: true }}
      style={{ background: "#0b0b0c" }}
    >
      <Background color="#222226" gap={28} size={1} />
      <Controls showInteractive={false} />
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

  if (fullscreen) {
    return (
      <div className="fixed inset-0 z-50 bg-ink">
        {graph}
      </div>
    );
  }

  return (
    <div className={`w-full ${heightClass} rounded-lg border border-edge bg-ink overflow-hidden`}>
      {graph}
    </div>
  );
}
