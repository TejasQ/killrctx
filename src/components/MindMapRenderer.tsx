// ============================================================================
// MindMapRenderer.tsx — a React component that renders a mindmap note as a
//                        visual, interactive node graph using ReactFlow.
//                        Fullscreen is handled at the NoteCard level, not here.
// ============================================================================
//
// _Basically_, mindmap notes are stored as nested markdown lists (- item,
//   - child). This component parses that text into a tree, lays it out as a
// horizontal left-to-right graph, and hands the result to ReactFlow to render.
//
// Visual design principles applied here:
//   - Solid dark fills per branch — matches the NotebookLM reference style.
//   - Each top-level branch gets one of BRANCH_COLORS. Deeper nodes use the
//     same hue but slightly darker fills.
//   - Nodes with children show a collapse chevron rendered as a SEPARATE
//     ReactFlow node floating just outside the right edge of the box. This
//     keeps the chevron click target completely distinct from the node body
//     click target (which triggers the node inquiry feature).
//   - Clicking a node body fires onNodeClick(label, linkedConvIds) so the
//     parent can open or create a linked conversation in the chat panel.
//   - Linked nodes (those with prior research conversations) show a small
//     blue count badge so users can see at a glance what they've explored.
//   - Expanding: child nodes fly out from their parent's position.
//   - Collapsing: child nodes fly back into their parent's position, then vanish.
//   - Source/citation nodes are muted and not clickable for inquiry.
//   - Fullscreen: controlled by the parent NoteCard, not by this component.
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
  Position,
  ReactFlowProvider,
  useReactFlow,
  type Node,
  type Edge,
  type NodeProps,
} from "reactflow";
import "reactflow/dist/style.css";
import type { MindMapLink } from "@/lib/db";

// ── Animation constant ────────────────────────────────────────────────────────
// How long the fly-in / fly-out transition takes, in ms. Must match the CSS
// transition duration on MindMapNode below.
const ANIM_MS = 380;

// ── MindMapNode ───────────────────────────────────────────────────────────────
// Custom node type with handles ONLY on the left and right sides.
// ReactFlow's default node type has handles on all four sides and auto-picks
// the closest one — causing top/bottom connections on a horizontal layout.
// This node eliminates top/bottom handles entirely so lines always go L→R.
//
// The inner div handles opacity/scale for the fly-in and fly-out animations.
// The outer wrapper (controlled by ReactFlow) handles position — its transition
// is set via the node-level `style` prop during layout shifts so surviving nodes
// glide to their new positions instead of snapping.
function MindMapNode({ data }: NodeProps) {
  const style: React.CSSProperties = {
    ...data.style,
    position:   "relative",
    // Animate opacity and scale for enter/exit. Transform is NOT here — that
    // would conflict with ReactFlow's own translate on the outer wrapper.
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

// ── ChevronNode ───────────────────────────────────────────────────────────────
// The collapse/expand toggle rendered as its own standalone ReactFlow node,
// positioned just outside the right edge of its parent node box.
//
// Why a separate node and not a span inside MindMapNode?
//   If the chevron lives inside the node, clicking it also fires the node's
//   onNodeClick (inquiry). Separating it into its own node gives it a completely
//   independent hit target so the two actions never collide.
//
// The chevron has no ReactFlow handles — it is purely decorative/interactive
// and does not participate in the edge graph.
function ChevronNode({ data }: NodeProps) {
  const style: React.CSSProperties = {
    width:          20,
    height:         20,
    borderRadius:   4,
    background:     "rgba(255,255,255,0.08)",
    border:         "1px solid rgba(255,255,255,0.12)",
    display:        "flex",
    alignItems:     "center",
    justifyContent: "center",
    fontSize:       11,
    color:          "rgba(255,255,255,0.6)",
    cursor:         "pointer",
    transition:     `opacity ${ANIM_MS}ms ease, transform ${ANIM_MS}ms ease`,
    userSelect:     "none",
    ...data.animStyle,
  };
  return <div style={style}>{data.label}</div>;
}

// Must be defined outside the render function so ReactFlow doesn't recreate
// the node type on every render (which causes nodes to remount and flicker).
const NODE_TYPES = { mindmap: MindMapNode, chevron: ChevronNode };

// ── Layout constants ──────────────────────────────────────────────────────────
const NODE_X_STEP     = 300; // horizontal gap between depth levels
const NODE_Y_STEP     = 68;  // vertical gap between sibling nodes
const CHEVRON_OFFSET  = 8;   // px gap between node right edge and chevron

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
// Solid fills per branch. cursor is always "pointer" on non-source nodes —
// every node is clickable for inquiry regardless of whether it has children.
function nodeStyle(tn: TreeNode, depth: number): React.CSSProperties {
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
      cursor:         "pointer",
    };
  }

  // Branch and leaf nodes: solid dark fill, full-opacity border.
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
    justifyContent: "center",
    padding:        "0 10px",
    cursor:         "pointer",
    // Subtle glow on branch-level nodes that have children.
    boxShadow:      depth === 1 && tn.children.length > 0
      ? `0 0 8px ${col.border}40`
      : undefined,
  };
}

// ── nodeLabel ─────────────────────────────────────────────────────────────────
// Returns the node's display content. For linked nodes (those with prior
// research conversations) a small blue count badge is added in the top-right
// corner so the user can see at a glance which nodes have been explored.
//
// The badge uses `pointerEvents: none` so it never intercepts clicks — the
// node body click fires normally through it.
function nodeLabel(tn: TreeNode, linkedCount: number): React.ReactNode {
  if (linkedCount === 0) return tn.label;

  return (
    <span style={{ position: "relative", display: "inline-flex", alignItems: "center", width: "100%", overflow: "hidden" }}>
      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {tn.label}
      </span>
      {/* Badge: blue circle showing number of linked conversations */}
      <span style={{
        position:       "absolute",
        top:            -8,
        right:          -8,
        minWidth:       16,
        height:         16,
        borderRadius:   "50%",
        background:     "#3b82f6",
        color:          "#fff",
        fontSize:       9,
        fontWeight:     700,
        display:        "flex",
        alignItems:     "center",
        justifyContent: "center",
        padding:        "0 3px",
        pointerEvents:  "none",
        lineHeight:     1,
        boxShadow:      "0 0 6px rgba(59,130,246,0.6)",
      }}>
        {linkedCount}
      </span>
    </span>
  );
}

// ── buildGraph ────────────────────────────────────────────────────────────────
// Walks the tree and produces ReactFlow nodes[] + edges[], skipping any subtree
// whose root is in `collapsedIds`. Layout is a horizontal BFS.
//
// Chevron nodes are emitted as separate ReactFlow nodes for every parent node
// (nodes with children) — positioned OUTSIDE the right edge of their parent box.
// This keeps collapse/expand clicks separate from node-body inquiry clicks.
function buildGraph(
  root:          TreeNode,
  collapsedIds:  Set<string>,
  onToggle:      (id: string) => void,
  onAsk:         (id: string, label: string) => void,
  linksByKey:    Map<string, string[]>,
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
    const ns          = nodeStyle(tn, depth);
    const dims        = tn.isSource ? SOURCE_STYLE : DEPTH_STYLES[Math.min(depth, DEPTH_STYLES.length - 1)];
    const hasKids     = tn.children.length > 0;
    // Build the composite key for this node. We need ancestors so we call
    // findAncestorLabels here — O(depth) per node, negligible for mind maps.
    const ancestors   = findAncestorLabels(root, tn.id) ?? [];
    const key         = nodeKey(tn.label, ancestors);
    const linkedCount = tn.isSource ? 0 : (linksByKey.get(key)?.length ?? 0);
    const label       = nodeLabel(tn, linkedCount);

    // Node body — clicking fires inquiry (onAsk), not collapse.
    nodes.push({
      id:       tn.id,
      type:     "mindmap",
      position: { x: depth * NODE_X_STEP, y: yMap[tn.id] },
      // All non-source nodes are selectable so onNodeClick fires for leaves too.
      selectable: !tn.isSource,
      data: {
        label,
        style: ns,
        // onClick is called by MindMapGraph's handleNodeClick.
        // Pass id so handleAskRef can resolve ancestor labels from the tree root.
        ...(!tn.isSource && { onClick: () => onAsk(tn.id, tn.label) }),
      },
    });

    // Chevron — emitted as a sibling node outside the right edge of its parent.
    // Only for nodes that have children.
    if (hasKids) {
      const collapsed   = collapsedIds.has(tn.id);
      const chevronId   = `chevron-${tn.id}`;
      const chevronSize = 20;
      nodes.push({
        id:         chevronId,
        type:       "chevron",
        selectable: true,
        // Position: centred vertically on the parent, just past its right edge.
        position: {
          x: depth * NODE_X_STEP + dims.width + CHEVRON_OFFSET,
          y: yMap[tn.id] + (dims.height - chevronSize) / 2,
        },
        data: {
          label:   collapsed ? "›" : "‹",
          onClick: () => onToggle(tn.id),
        },
      });
    }

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
// Also returns the paired chevron IDs since they must animate together.
function collectDescendantIds(tn: TreeNode): string[] {
  const ids: string[] = [];
  for (const child of tn.children) {
    ids.push(child.id);
    ids.push(`chevron-${child.id}`);
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

// ── nodeKey ───────────────────────────────────────────────────────────────────
// Composite identity for a node: its label plus the ancestor path joined by "|".
// Two nodes with the same label under different parents produce different keys,
// so "Attack Roll: d20 (under Reckless Attack)" ≠ "Attack Roll: d20 (under Rage Strike)".
function nodeKey(label: string, ancestorLabels: string[]): string {
  return `${label}|${ancestorLabels.join(" > ")}`;
}

// ── findAncestorLabels ────────────────────────────────────────────────────────
// Returns the labels of every ancestor of `targetId`, from root down to (but
// NOT including) the target itself.  Used to build the breadcrumb context that
// gets included in the framed question so the LLM knows e.g. that
// "Attack Roll: d20" lives under "Reckless Attack → Abilities → Berserker Korg".
function findAncestorLabels(root: TreeNode, targetId: string, path: string[] = []): string[] | null {
  if (root.id === targetId) return path;
  for (const child of root.children) {
    const result = findAncestorLabels(child, targetId, [...path, root.label]);
    if (result !== null) return result;
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
  linksByKey,
  onNodeClick,
}: {
  tree:         TreeNode;
  variant:      "card" | "expanded" | "fullscreen";
  linksByKey:   Map<string, string[]>;
  onNodeClick:  (label: string, linkedConvIds: string[], ancestorLabels: string[]) => void;
}) {
  const { setNodes, setEdges, setCenter, fitView } = useReactFlow();
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  // animating: true while a collapse-out animation is in flight. Blocks
  // re-entrant toggles so two animations don't stomp each other.
  const animating = useRef(false);
  // skipNextSync: set by collapse so the useEffect doesn't re-snap node
  // positions after the animation — we handle the final state ourselves.
  const skipNextSync = useRef(false);

  // Keep toggle and ask refs so buildGraph closures always call the latest.
  const handleToggleRef = useRef<(id: string) => void>(() => {});
  const handleAskRef    = useRef<(id: string, label: string) => void>(() => {});

  const { nodes: baseNodes, edges: baseEdges } = useMemo(
    () => buildGraph(
      tree,
      collapsedIds,
      (id) => handleToggleRef.current(id),
      (id, label) => handleAskRef.current(id, label),
      linksByKey,
    ),
    [tree, collapsedIds, linksByKey],
  );

  // Sync ReactFlow internal state on initial mount and whenever baseNodes
  // changes for reasons other than a collapse animation.
  useEffect(() => {
    if (skipNextSync.current) {
      skipNextSync.current = false;
      return;
    }
    setNodes(baseNodes);
    setEdges(baseEdges);
  }, [baseNodes, baseEdges, setNodes, setEdges]);

  const handleToggle = useCallback((id: string) => {
    if (animating.current) return;

    const isCollapsing = !collapsedIds.has(id);

    if (isCollapsing) {
      // ── Collapse animation ────────────────────────────────────────────────
      animating.current = true;

      const subtreeRoot  = findNode(tree, id);
      const departing    = subtreeRoot ? collectDescendantIds(subtreeRoot) : [];
      const departingSet = new Set(departing);

      // Phase 1: fade+shrink departing nodes and their edges simultaneously.
      setNodes((prev) =>
        prev.map((n) => {
          if (!departingSet.has(n.id)) return n;
          return {
            ...n,
            data: { ...n.data, animStyle: { opacity: 0, transform: "scale(0)" } },
          };
        }),
      );
      setEdges((prev) => prev.map((e) =>
        departingSet.has(e.source) || departingSet.has(e.target)
          ? { ...e, style: { ...e.style, opacity: 0, transition: `opacity ${ANIM_MS}ms ease` } }
          : e,
      ));

      setTimeout(() => {
        // Phase 2: compute post-collapse layout, remove departed nodes+edges,
        // then lerp surviving nodes to their new positions.
        const nextCollapsed = new Set(collapsedIds);
        nextCollapsed.add(id);
        const { nodes: nextNodes, edges: nextEdges } = buildGraph(
          tree,
          nextCollapsed,
          (nid) => handleToggleRef.current(nid),
          (id, label) => handleAskRef.current(id, label),
          linksByKey,
        );
        const nextPosById = new Map(nextNodes.map((n) => [n.id, n.position]));

        const parentFinal = nextPosById.get(id);
        const parentMeta  = nextNodes.find((n) => n.id === id);
        if (parentFinal && parentMeta) {
          setCenter(
            parentFinal.x + (parentMeta.width  ?? 0) / 2,
            parentFinal.y + (parentMeta.height ?? 0) / 2,
            { duration: ANIM_MS },
          );
        }

        let startNodes: Node[] = [];
        setNodes((prev) => {
          startNodes = prev.filter((n) => !departingSet.has(n.id));
          return startNodes;
        });
        setEdges((prev) => prev.filter(
          (e) => !departingSet.has(e.source) && !departingSet.has(e.target),
        ));

        const startTime = performance.now();
        function tick() {
          const elapsed = performance.now() - startTime;
          const raw     = Math.min(elapsed / ANIM_MS, 1);
          const t = raw < 0.5 ? 4 * raw ** 3 : 1 - (-2 * raw + 2) ** 3 / 2;

          setNodes((prev) =>
            prev.map((n) => {
              const from = startNodes.find((s) => s.id === n.id)?.position;
              const to   = nextPosById.get(n.id);
              if (!from || !to) return n;
              return {
                ...n,
                position: {
                  x: from.x + (to.x - from.x) * t,
                  y: from.y + (to.y - from.y) * t,
                },
              };
            }),
          );

          if (raw < 1) {
            requestAnimationFrame(tick);
          } else {
            setNodes((prev) =>
              prev.map((n) => {
                const to = nextPosById.get(n.id);
                return to ? { ...n, position: to } : n;
              }),
            );
            setEdges(nextEdges);
            skipNextSync.current = true;
            setCollapsedIds(nextCollapsed);
            animating.current = false;
          }
        }
        requestAnimationFrame(tick);
      }, ANIM_MS);

    } else {
      // ── Expand animation ──────────────────────────────────────────────────
      const nextCollapsed = new Set(collapsedIds);
      nextCollapsed.delete(id);

      const { nodes: nextNodes, edges: nextEdges } = buildGraph(
        tree,
        nextCollapsed,
        (nid) => handleToggleRef.current(nid),
        (id, label) => handleAskRef.current(id, label),
        linksByKey,
      );

      let newNodeIds: string[] = [];

      setNodes((prev) => {
        const parentNode  = prev.find((n) => n.id === id);
        const parentPos   = parentNode?.position ?? { x: 0, y: 0 };
        const existingIds = new Set(prev.map((n) => n.id));
        newNodeIds = nextNodes.map((n) => n.id).filter((nid) => !existingIds.has(nid));

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

      requestAnimationFrame(() => {
        setNodes(() => nextNodes);
        skipNextSync.current = true;
        setCollapsedIds(nextCollapsed);

        setTimeout(() => {
          fitView({
            nodes:    [{ id }, ...newNodeIds.map((nid) => ({ id: nid }))],
            duration: ANIM_MS,
            padding:  0.25,
          });
        }, ANIM_MS);
      });
    }
  }, [collapsedIds, tree, linksByKey, setNodes, setEdges]);

  // Keep refs in sync so buildGraph closures always call the latest handlers.
  handleToggleRef.current = handleToggle;
  handleAskRef.current = (id: string, label: string) => {
    const ancestorLabels  = findAncestorLabels(tree, id) ?? [];
    // Look up by composite key so two nodes with the same label under different
    // parents don't collide — e.g. "Attack Roll: d20" under Reckless Attack vs.
    // the same label under Rage Strike are distinct entries in linksByKey.
    const key             = nodeKey(label, ancestorLabels);
    const linkedConvIds   = linksByKey.get(key) ?? [];
    onNodeClick(label, linkedConvIds, ancestorLabels);
  };

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      if (node.data?.onClick) node.data.onClick();
    },
    [],
  );

  const containerClass =
    variant === "fullscreen"
      ? "w-full h-full bg-ink overflow-hidden"
      : variant === "expanded"
      ? "w-full h-mindmap-expanded rounded-lg border border-edge bg-ink overflow-hidden"
      : "w-full h-mindmap-card rounded-lg border border-edge bg-ink overflow-hidden";

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
    </ReactFlow>
  );

  return <div className={containerClass}>{graph}</div>;
}

// ── MindMapRenderer ───────────────────────────────────────────────────────────
// Outer shell: parses content, builds the linksByKey lookup, wraps in
// ReactFlowProvider (required for useReactFlow inside MindMapGraph).
// Fullscreen is owned by the parent NoteCard, not this component.
export default function MindMapRenderer({
  content,
  variant,
  noteId,
  mindMapLinks,
  onNodeClick,
}: {
  content:      string;
  variant:      "card" | "expanded" | "fullscreen";
  noteId:       string;
  mindMapLinks?: MindMapLink[];
  onNodeClick?: (nodeLabel: string, linkedConvIds: string[], ancestorLabels: string[]) => void;
}) {
  const tree = useMemo(() => parseMindMap(content), [content]);

  // Build a composite-key → conversationId[] map scoped to this note.
  // Key = nodeKey(node_label, node_path) so two nodes sharing a label under
  // different parents are distinct entries and don't cross-contaminate badges.
  const linksByKey = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const link of mindMapLinks ?? []) {
      if (link.note_id !== noteId) continue;
      // node_path is stored as the ancestor string "A > B > C", split back to
      // an array so nodeKey() can rejoin it consistently.
      const ancestors = link.node_path ? link.node_path.split(" > ") : [];
      const key = nodeKey(link.node_label, ancestors);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(link.conversation_id);
    }
    return map;
  }, [mindMapLinks, noteId]);

  // No-op click handler when the parent hasn't wired one up (e.g. card preview).
  const handleNodeClick = onNodeClick ?? (() => {});

  if (!tree) {
    return <p className="text-xs text-muted">No mind map content.</p>;
  }

  return (
    <ReactFlowProvider>
      <MindMapGraph
        tree={tree}
        variant={variant}
        linksByKey={linksByKey}
        onNodeClick={handleNodeClick}
      />
    </ReactFlowProvider>
  );
}
