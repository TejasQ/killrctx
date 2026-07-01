# Astra Workbench Backend — Tasks

## Tasks

- [ ] TASK-01: [DB] Add `rag_backend`, `workbench_kb_id`, `workbench_embedding_service_id` columns to `notebooks` table in `src/lib/db.ts`
- [ ] TASK-02: [DB] Add `workbench_agent_id`, `workbench_conversation_id` columns to `conversations` table in `src/lib/db.ts`
- [ ] TASK-03: [DB] Update `Notebook` and `Conversation` types to include new columns
- [ ] TASK-04: [lib] Create `src/lib/rag.ts` — shared `RagBackend` interface + `getBackend()` factory
- [ ] TASK-05: [lib] Create `src/lib/backends/openrag.ts` — wraps existing `openrag.ts` to satisfy `RagBackend` interface
- [ ] TASK-06: [lib] Create `src/lib/backends/workbench.ts` — implements `RagBackend` against Workbench REST API (non-streaming methods)
- [ ] TASK-07: [lib] Implement `chatStream()` in `workbench.ts` — SSE fetch parsing into AsyncIterable<StreamDelta>
- [ ] TASK-08: [API] Create `GET /api/workbench/embedding-services` proxy route
- [ ] TASK-09: [API] Create `GET /api/workbench/agents` proxy route
- [ ] TASK-10: [API] Update `POST /api/notebooks` to handle `rag_backend = "workbench"` (create KB on Workbench)
- [ ] TASK-11: [API] Update `DELETE /api/notebooks/[id]` to delete Workbench KB when backend is "workbench"
- [ ] TASK-12: [API] Update `POST /api/notebooks/[id]/documents` to ingest via Workbench when backend is "workbench"
- [ ] TASK-13: [API] Update `DELETE /api/notebooks/[id]/documents/[docId]` for Workbench backend
- [ ] TASK-14: [API] Update `POST /api/notebooks/[id]/conversations` to create Workbench conversation with agent + KB binding
- [ ] TASK-15: [API] Update `DELETE /api/notebooks/[id]/conversations/[convId]` for Workbench backend
- [ ] TASK-16: [API] Update chat streaming route to use `getBackend()` and route through Workbench when applicable
- [ ] TASK-17: [UI] Add backend picker (OpenRAG / Workbench) to notebook creation dialog
- [ ] TASK-18: [UI] Add embedding service picker for Workbench notebooks (fetches from proxy route)
- [ ] TASK-19: [UI] Add agent picker to conversation creation for Workbench notebooks
- [ ] TASK-20: [UI] Disable podcast button for Workbench-backed notebooks
- [ ] TASK-21: [env] Add Workbench env vars to `.env.example`
- [ ] TASK-22: [verify] Run `npm run build`, confirm zero errors, manual smoke test
