// ============================================================================
// OpenRAGContext.tsx — shared OpenRAG settings available to any page
// ============================================================================
//
// _Basically_, once HealthGate confirms the backend is ready it has the LLM
// and embedding model names. This context holds those values so any component
// in the tree can display them without firing a second /api/health request.
//
// `setSettings` lets the ModelPickerPopover push fresh values after a save
// so the header label updates immediately without a full re-probe.
// ============================================================================

"use client";

import { createContext, useContext } from "react";

export type OpenRAGSettings = { llm: string; embedding: string };

type OpenRAGContextValue = {
  settings: OpenRAGSettings | null;
  setSettings: (s: OpenRAGSettings) => void;
};

const noop = () => {};

export const OpenRAGContext = createContext<OpenRAGContextValue>({
  settings: null,
  setSettings: noop,
});

/** Returns the OpenRAG settings and a setter, both provided by HealthGate. */
export function useOpenRAGSettings(): OpenRAGContextValue {
  return useContext(OpenRAGContext);
}
