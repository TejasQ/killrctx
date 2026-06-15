# Task Plan — OpenRAG SDK Migration

## Tasks

- [x] TASK-01: [dep] Install `openrag-sdk` as a production dependency
- [x] TASK-02: [lib] Add `OpenRAGClient` singleton + `getClient()` to `src/lib/openrag.ts`
- [x] TASK-03: [lib] Replace `chat()` fetch with `client.chat.create()`
- [x] TASK-04: [lib] Replace `ingestDocument()` fetch with `client.documents.ingest()`
- [x] TASK-05: [lib] Add exported `deleteDocument()` using `client.documents.delete()`
- [x] TASK-06: [API] Update `documents/[docId]/route.ts` to call `deleteDocument()`
- [x] TASK-07: [API] Add `// Not using SDK:` comments to `health/route.ts`
- [x] TASK-08: [API] Add `// Not using SDK:` comments to `setup/route.ts`
- [x] TASK-09: [env] Add `OPENRAG_API_KEY` and `OPENRAG_INSTALL_URL` to `.env.example`
- [x] TASK-10: [verify] `npx tsc --noEmit` — zero errors
- [x] TASK-11: [verify] `npm run build` — zero errors
- [x] TASK-12: [env] Rename `OPENRAG_SDK_URL` → `OPENRAG_URL`; rename `OPENRAG_URL` → `OPENRAG_INSTALL_URL` across all files
- [x] TASK-13: [verify] `npx tsc --noEmit` — zero errors
- [x] TASK-14: [verify] `npm run build` — zero errors
