// ============================================================================
// MindMapRenderer.tsx — a React component that renders a mindmap note as a
//                        visual, interactive node graph using ReactFlow
// ============================================================================
//
// _Basically_, mindmap notes are stored as nested markdown lists (- item,
//   - child). This component parses that text into a tree, lays it out as a
// horizontal left-to-right graph, and hands the result to ReactFlow to render.
//
// Two variants control the container height:
//   "card"     → h-mindmap-card     (inline NoteCard preview)
//   "expanded" → h-mindmap-expanded (full Studio expanded view)
//
// Layout constants live at the top of this file — change them to adjust the
// feel of the graph without hunting through the render logic.
// ============================================================================

"use client";

import React, { useMemo } from "react";
import ReactFlow, { Background, Controls, type Node, type Edge } from "reactflow";
import "reactflow/dist/style.css";

// ── Layout constants ─────────────────────────────────────────────────────────
// Pixel values used for ReactFlow node positions. These are JS numbers, not
// Tailwind classes, because ReactFlow needs concrete x/y coordinates.
const NODE_X_STEP = 220; // horizontal gap between depth levels
const NODE_Y_STEP = 64;  // vertical gap between sibling nodes
const NODE_WIDTH  = 160; // used to centre the root relative to its children
const NODE_HEIGHT = 36;  // used to centre children relative to their parent

// ── Tree type ─────────────────────────────────────────────────────────────────
type TreeNode = { id: string; label: string; children: TreeNode[] };

// ── parseMindMap ──────────────────────────────────────────────────────────────
// Converts a nested markdown list string into a TreeNode tree.
// Only lines matching /^\s*- / are processed; all other lines are skipped.
// Depth is inferred from Math.floor(leadingSpaces / 2), matching the AI
// prompt's "indent with two spaces" instruction.
function parseMindMap(content: string): TreeNode | null {
  const lines = content.split("\n");
  // Stack tracks the current ancestor chain: stack[depth] = parent node.
  const stack: TreeNode[] = [];
  let root: TreeNode | null = null;

  for (const line of lines) {
    const match = line.match(/^(\s*)- (.+)/);
    if (!match) continue;

    const depth = Math.floor(match[1].length / 2);
    const label = match[2].trim();
    const id    = stack.slice(0, depth).map((n) => n.id).join("-") + (depth === 0 ? "0" : `-${stack[depth - 1]?.children.length ?? 0}`);

    const node: TreeNode = { id, label, children: [] };

    if (depth === 0) {
      root = node;
      stack[0] = node;
    } else {
      const parent = stack[depth - 1];
      if (parent) {
        parent.children.push(node);
        stack[depth] = node;
        // Clear any deeper entries so stale ancestors don't mislead id generation.
        stack.splice(depth + 1);
      }
    }
  }

  return root;
}

// ── buildGraph ────────────────────────────────────────────────────────────────
// BFS walk over the TreeNode tree → ReactFlow nodes[] + edges[].
// Layout: horizontal tree, left-to-right. Each depth level is NODE_X_STEP px
// to the right. Sibling nodes are spaced NODE_Y_STEP px apart vertically, and
// each parent is vertically centred over its children.
function buildGraph(root: TreeNode): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  // BFS queue carries the tree node + its depth level.
  const queue: { treeNode: TreeNode; depth: number; parentId: string | null }[] = [
    { treeNode: root, depth: 0, parentId: null },
  ];

  // First pass: assign each node a temporary row index within its depth so we
  // can calculate total height before positioning parents.
  // We use a two-pass approach: collect all nodes with depth/row, then resolve Y.
  type Positioned = { treeNode: TreeNode; depth: number; parentId: string | null };
  const positioned: Positioned[] = [];
  const depthCounters: Record<number, number> = {};

  const bfsQueue = [...queue];
  while (bfsQueue.length) {
    const item = bfsQueue.shift()!;
    depthCounters[item.depth] = (depthCounters[item.depth] ?? 0) + 1;
    positioned.push(item);
    for (const child of item.treeNode.children) {
      bfsQueue.push({ treeNode: child, depth: item.depth + 1, parentId: item.treeNode.id });
    }
  }

  // Second pass: assign Y by walking children of each node and centering the
  // parent over them. We recurse from the root, tracking a running Y counter
  // per subtree.
  let leafY = 0;
  const nodeYMap: Record<string, number> = {};

  function assignY(tn: TreeNode): number {
    if (tn.children.length === 0) {
      nodeYMap[tn.id] = leafY * NODE_Y_STEP;
      leafY++;
      return nodeYMap[tn.id];
    }
    const childYs = tn.children.map(assignY);
    nodeYMap[tn.id] = (childYs[0] + childYs[childYs.length - 1]) / 2;
    return nodeYMap[tn.id];
  }
  assignY(root);

  // Third pass: build ReactFlow nodes and edges from the positioned list.
  for (const { treeNode, depth, parentId } of positioned) {
    const isRoot = parentId === null;

    nodes.push({
      id:       treeNode.id,
      data:     { label: treeNode.label },
      position: { x: depth * NODE_X_STEP, y: nodeYMap[treeNode.id] },
      // Root node uses accent colours to stand out; children use panel colours.
      className: isRoot
        ? "rounded-lg border-2 px-3 py-1 text-sm font-semibold bg-accent/20 border-accent text-white"
        : "rounded-lg border px-3 py-1 text-xs bg-panel border-edge text-muted",
      // Tell ReactFlow the node has no default handles visible — we use edges only.
      style: { width: NODE_WIDTH, height: NODE_HEIGHT },
    });

    if (parentId !== null) {
      edges.push({
        id:     `e-${parentId}-${treeNode.id}`,
        source: parentId,
        target: treeNode.id,
        style:  { stroke: "#222226" }, // edge colour = `edge` token hex
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
  const { nodes, edges } = useMemo(() => {
    const root = parseMindMap(content);
    if (!root) return { nodes: [], edges: [] };
    return buildGraph(root);
  }, [content]);

  const heightClass = variant === "expanded" ? "h-mindmap-expanded" : "h-mindmap-card";

  if (nodes.length === 0) {
    return <p className="text-xs text-muted">No mind map content.</p>;
  }

  return (
    <div className={`w-full ${heightClass} rounded-lg border border-edge overflow-hidden`}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Controls showInteractive={false} />
        <Background color="#222226" gap={24} />
      </ReactFlow>
    </div>
  );
}
