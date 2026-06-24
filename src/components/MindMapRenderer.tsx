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
//   - Expanding: child nodes fly out from their parent's position.
//   - Collapsing: child nodes fly back into their parent's position, then vanish.
//   - Source/citation nodes (lines containing "(Source:") are muted.
//   - Fullscreen: a toggle button inside the graph mounts a fixed overlay.
//
// Layout constants live at the top — change them to adjust the feel of the
// graph without touching the render logic.
// ============================================================================

"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactFlow, {
  Background,
  Controls,
  Handle,
  Panel,
  Position,
  ReactFlowProvider,
  useReactFlow,
  type Node,
  type Edge,
  type NodeProps,
} from "reactflow";
import "reactflow/dist/style.css";

// ── Animation constant ────────────────────────────────────────────────────────
// How long the fly-in / fly-out transition takes, in ms. Must match the CSS
// transition duration on MindMapNode below.
const ANIM_MS = 220;

// ── MindMapNode ───────────────────────────────────────────────────────────────
// Custom node type with handles ONLY on the left and right sides.
// ReactFlow's default node type has handles on all four sides and auto-picks
// the closest one — causing top/bottom connections on a horizontal layout.
// This node eliminates top/bottom handles entirely so lines always go L→R.
//
// The transition property here is what drives the expand/collapse animation —
// ReactFlow updates the node's `transform` (position) and we tween opacity/scale
// via data.animStyle so the node appears to fly in or out of its parent.
function MindMapNode({ data }: NodeProps) {
  const style: React.CSSProperties = {
    ...data.style,
    position:   "relative",
    transition: `opacity ${ANIM_MS}ms ease, transform ${ANIM_MS}ms ease`,
    ...data.animStyle,
  };
  return (
    <div style={style}>
      <Handle type="target" position={Position.Left}  style={{ visibility: "hidden" }} />
      {data.label}
      <Handle type="source" position={Position.Right} style={{ visibility: "hidden" }} />
    </div>
  );
}

// Must be defined outside the render function so ReactFlow doesn't recreate
// the node type on every render (which causes nodes to remount and flicker).
const NODE_TYPES = { mindmap: MindMapNode };

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
// whose root is in `collapsedIds`. Layout is the same horizontal BFS as before.
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
    const ns        = nodeStyle(tn, depth, collapsed);
    const hasKids   = tn.children.length > 0;
    const data = hasKids
      ? { label, style: ns, onClick: () => onToggle(tn.id) }
      : { label, style: ns };
    nodes.push({
      id:         tn.id,
      data,
      position:   { x: depth * NODE_X_STEP, y: yMap[tn.id] },
      type:       "mindmap",
      // elementsSelectable=false on ReactFlow suppresses onNodeClick globally.
      // Opt collapsible nodes back in individually so clicks register without
      // showing a selection highlight on any node.
      selectable: hasKids,
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

// ── collectDescendantIds ──────────────────────────────────────────────────────
// Returns all descendant ids of a given node in the tree (not just direct
// children). Used to know which nodes to animate out on collapse.
function collectDescendantIds(tn: TreeNode): string[] {
  const ids: string[] = [];
  for (const child of tn.children) {
    ids.push(child.id);
    ids.push(...collectDescendantIds(child));
  }
  return ids;
}

// ── findNode ──────────────────────────────────────────────────────────────────
function findNode(root: TreeNode, id: string): TreeNode | null {
  if (root.id === id) return root;
  for (const child of root.children) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

// ── MindMapGraph ──────────────────────────────────────────────────────────────
// Inner component — needs to live inside ReactFlowProvider to use useReactFlow.
// Owns the collapse state and drives the fly-in / fly-out animation.
//
// Animation sequence:
//   Expand: add new nodes at parent's position (scale 0, opacity 0) →
//           next frame: move to real position (scale 1, opacity 1) → CSS plays.
//   Collapse: move departing nodes to parent's position (scale 0, opacity 0) →
//             wait ANIM_MS → apply new collapsed graph (nodes are gone).
function MindMapGraph({
  tree,
  variant,
  onFullscreenToggle,
  fullscreen,
}: {
  tree: TreeNode;
  variant: "card" | "expanded";
  onFullscreenToggle: () => void;
  fullscreen: boolean;
}) {
  const { setNodes, setEdges } = useReactFlow();
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  // animating: true while a collapse-out animation is in flight. Blocks
  // re-entrant toggles so two animations don't stomp each other.
  const animating = useRef(false);

  // Build the stable (non-animated) graph for the current collapse state.
  // We keep a ref to the last toggle callback so buildGraph doesn't need to
  // know about the animation — the toggle is intercepted at handleToggle.
  const handleToggleRef = useRef<(id: string) => void>(() => {});

  const { nodes: baseNodes, edges: baseEdges } = useMemo(
    () => buildGraph(tree, collapsedIds, (id) => handleToggleRef.current(id)),
    [tree, collapsedIds],
  );

  // Sync ReactFlow internal state whenever the base graph changes.
  // (Initial mount and after each animate-out completes.)
  useEffect(() => {
    setNodes(baseNodes);
    setEdges(baseEdges);
  }, [baseNodes, baseEdges, setNodes, setEdges]);

  const handleToggle = useCallback((id: string) => {
    if (animating.current) return;

    const isCollapsing = !collapsedIds.has(id);

    if (isCollapsing) {
      // ── Collapse animation ────────────────────────────────────────────────
      // 1. Find all descendant ids that are currently visible.
      // 2. Find the parent's current position in the live ReactFlow nodes.
      // 3. Move all descendants to the parent's position with opacity 0 /
      //    scale 0 — CSS transition plays the fly-in-reverse.
      // 4. After ANIM_MS, commit the new collapsed state (nodes disappear).
      animating.current = true;

      const subtreeRoot = findNode(tree, id);
      const departing   = subtreeRoot ? collectDescendantIds(subtreeRoot) : [];
      const departingSet = new Set(departing);

      setNodes((prev) => {
        const parentNode = prev.find((n) => n.id === id);
        const parentPos  = parentNode?.position ?? { x: 0, y: 0 };

        return prev.map((n) => {
          if (!departingSet.has(n.id)) return n;
          return {
            ...n,
            position: parentPos,
            data: {
              ...n.data,
              // scale(0) collapses the node to a point at the parent's location.
              animStyle: { opacity: 0, transform: "scale(0)" },
            },
          };
        });
      });

      setTimeout(() => {
        setCollapsedIds((prev) => {
          const next = new Set(prev);
          next.add(id);
          return next;
        });
        animating.current = false;
      }, ANIM_MS);

    } else {
      // ── Expand animation ──────────────────────────────────────────────────
      // Frame A: inject new nodes at the parent's position, scale(0) opacity(0).
      //          The browser paints this frame — nodes exist but are invisible.
      // Frame B (next rAF): set nodes to their real positions with no animStyle.
      //          The CSS transition on MindMapNode plays the fly-out.
      const nextCollapsed = new Set(collapsedIds);
      nextCollapsed.delete(id);

      const { nodes: nextNodes, edges: nextEdges } = buildGraph(
        tree,
        nextCollapsed,
        (nid) => handleToggleRef.current(nid),
      );

      // Frame A — place new nodes at parent origin, hidden.
      setNodes((prev) => {
        const parentNode  = prev.find((n) => n.id === id);
        const parentPos   = parentNode?.position ?? { x: 0, y: 0 };
        const existingIds = new Set(prev.map((n) => n.id));

        return nextNodes.map((n) => {
          if (existingIds.has(n.id)) return n;
          return {
            ...n,
            position: parentPos,
            data: { ...n.data, animStyle: { opacity: 0, transform: "scale(0)" } },
          };
        });
      });
      setEdges(nextEdges);

      // Frame B — move to real positions; removing animStyle lets the transition play.
      requestAnimationFrame(() => {
        setNodes(() => nextNodes);
        setCollapsedIds(nextCollapsed);
      });
    }
  }, [collapsedIds, tree, setNodes, setEdges]);

  // Keep the ref in sync so buildGraph always calls the latest handleToggle.
  handleToggleRef.current = handleToggle;

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      if (node.data?.onClick) node.data.onClick();
    },
    [],
  );

  const heightClass =
    variant === "expanded" ? "h-mindmap-expanded" : "h-mindmap-card";

  const graph = (
    <ReactFlow
      defaultNodes={baseNodes}
      defaultEdges={baseEdges}
      nodeTypes={NODE_TYPES}
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
          onClick={onFullscreenToggle}
          title={fullscreen ? "Exit fullscreen (Esc)" : "Fullscreen"}
          className="rounded border border-edge bg-panel px-2 py-1 text-xs text-muted hover:border-accent hover:text-white transition-colors"
        >
          {fullscreen ? "⊠" : "⛶"}
        </button>
      </Panel>
    </ReactFlow>
  );

  if (fullscreen) {
    return <div className="fixed inset-0 z-50 bg-ink">{graph}</div>;
  }

  return (
    <div className={`w-full ${heightClass} rounded-lg border border-edge bg-ink overflow-hidden`}>
      {graph}
    </div>
  );
}

// ── MindMapRenderer ───────────────────────────────────────────────────────────
// Outer shell: parses content, owns fullscreen state, wraps in ReactFlowProvider
// (required for useReactFlow inside MindMapGraph).
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

  const tree = useMemo(() => parseMindMap(content), [content]);

  const handleFullscreenToggle = useCallback(
    () => setFullscreen((f) => !f),
    [],
  );

  if (!tree) {
    return <p className="text-xs text-muted">No mind map content.</p>;
  }

  return (
    <ReactFlowProvider>
      <MindMapGraph
        tree={tree}
        variant={variant}
        onFullscreenToggle={handleFullscreenToggle}
        fullscreen={fullscreen}
      />
    </ReactFlowProvider>
  );
}
