# killrctx — _basically_ a self-hosted NotebookLM

This is a teaching project. It builds a NotebookLM-style app on top of three
public pieces — **OpenRAG**, **ElevenLabs**, and **Next.js** — and the goal of
the codebase is for the wiring to be readable, not impressive. **THE SOURCE
CODE IS NOT SCARY!** Almost every file has a header comment that explains
_why_ it exists; the file paths in this README link directly to those.

You upload PDFs / markdown / text into a "notebook", chat with them, and
generate two-host podcast episodes about them. _Basically_, that's it.

```
[ You ]
   │
   ▼
[ Next.js UI ─ /notebooks/:id ]                    ← src/app/notebooks/[id]/page.tsx
   │
   ├──── upload    ─▶ /api/notebooks/[id]/documents ─▶ OpenRAG /router/upload_ingest
   │                                                     │
   │                                                     ▼
   │                                          Docling → embed → OpenSearch
   │
   ├──── chat      ─▶ /api/notebooks/[id]/chat       ─▶ OpenRAG /chat (agent loop)
   │                                                     │
   │                                                     ▼
   │                                          retrieves from OpenSearch
   │
   └──── podcast   ─▶ /api/notebooks/[id]/podcast    ─▶ OpenRAG /chat (script draft)
                                                         │
                                                         ▼
                                                ElevenLabs /v1/text-to-speech (per turn)
                                                         │
                                                         ▼
                                                public/podcasts/<id>.mp3
```

We don't do anything tricky on the AI side. OpenRAG is the agent; we just
frame prompts and persist metadata. ElevenLabs synthesizes one MP3 per
script turn and we concatenate the bytes — that's the entire "stitching"
algorithm.

---

## Quick start

```bash
cp .env.example .env
# Fill in the four <<< SET ME >>> values:
#   OPENAI_API_KEY              -> from https://platform.openai.com/api-keys
#   ELEVENLABS_API_KEY          -> from https://elevenlabs.io/app/settings/api-keys
#   OPENSEARCH_PASSWORD         -> any strong password (upper+lower+digit+special)
#   plus the four secrets generated with `openssl rand -hex 32` and
#   LANGFLOW_SECRET_KEY which is generated with the python one-liner in the file

docker compose up -d --build   # OpenRAG stack: ~30s on a warm cache, 4-5 min cold
npm install
npm run dev                    # Next.js on :3001
```

Open http://localhost:3001. The first time you load it the UI shows a
"Waiting for OpenRAG backend…" panel — that's [HealthGate](src/components/HealthGate.tsx)
polling [/api/health](src/app/api/health/route.ts) until OpenSearch comes up.
Once it does, you'll see a "Run one-time setup" button that installs the
default LLM (`gpt-4o-mini`) and embedding model (`text-embedding-3-small`)
into OpenRAG via [/api/setup](src/app/api/setup/route.ts).

Then click "Create" → drop a PDF in → ask a question → click "Generate" in
Studio.

---

## Three relevant files (the ones to read first)

| File | What's inside |
| :--- | :--- |
| [`src/lib/openrag.ts`](src/lib/openrag.ts) | Two functions — `chat()` and `ingestDocument()`. Everything that talks to OpenRAG goes through here. |
| [`src/lib/podcast.ts`](src/lib/podcast.ts) | The whole "Generate podcast" feature in three steps: draft script → parse turns → synthesize and stitch MP3s. |
| [`src/app/notebooks/[id]/page.tsx`](src/app/notebooks/[id]/page.tsx) | The three-panel UI (Sources / Chat / Studio). |

After those, [`src/lib/db.ts`](src/lib/db.ts) (SQLite) and
[`src/lib/elevenlabs.ts`](src/lib/elevenlabs.ts) (TTS) round out everything
that isn't routing.

---

## How it _basically_ works

### 1. The backend stack (Docker)

[`docker-compose.yml`](docker-compose.yml) spins up four sibling containers:

- **opensearch** — vector + full-text database. We disable the security
  plugin (`DISABLE_SECURITY_PLUGIN=true`) for fast local boot. See the file
  comments for the why.
- **docling** — PDF/HTML/markdown extractor. Loads ~700 MB of OCR models at
  startup; runs on `:5001`.
- **langflow** — flow editor. We don't actually use it from the Next.js
  app, but the OpenRAG backend still expects it to be reachable.
- **openrag-backend** — the FastAPI service we POST to. We rebuild this
  from a custom [`Dockerfile`](docker/openrag-backend.Dockerfile) that
  patches two lines so the backend talks to our security-off OpenSearch
  over plain http (the upstream image hardcodes TLS+auth).

### 2. The Next.js app

`next dev` runs on `:3001`. There's a [`HealthGate`](src/components/HealthGate.tsx)
at the root layout that blocks the UI until the backend reports ready, so
you never see a half-broken app while OpenSearch is booting.

The API routes are thin — most of them are 30-50 lines. They read/write
[SQLite](src/lib/db.ts) for metadata and forward the heavy lifting to OpenRAG
or ElevenLabs.

### 3. The retrieval trick

By default OpenRAG's agent only calls its retrieval tool when the user's
prompt matches certain keywords. A short prompt like "explain" doesn't
match anything, so the agent just asks a clarifying question — which is
useless when the user has clearly uploaded a paper they want explained.

Our [chat route](src/app/api/notebooks/[id]/chat/route.ts) wraps every
prompt (when the notebook has at least one document) with an explicit
"use the retrieval tool first, ground your answer in the passages, cite
filenames" directive. The agent then always retrieves. Five-line fix.

### 4. The podcast trick

[`synthesizeAndStitch`](src/lib/podcast.ts) does something that surprised
me: it concatenates raw MP3 bytes from sequential ElevenLabs calls into a
single playable file. No ffmpeg, no re-encoding. MP3 is frame-based and has
no global header to fix up, so as long as every chunk uses the same encoder
parameters (mp3_44100_128 in our case), bytewise concatenation is a valid
MP3.

---

## Things that bit us (and how)

These are documented inline at the relevant code paths, but listed here so
you don't have to grep:

- **OpenSearch boot is slow.** The security plugin runs a demo installer
  on every restart. We disable it (`DISABLE_SECURITY_PLUGIN=true`). See
  [docker-compose.yml](docker-compose.yml).
- **The backend hardcodes TLS+auth on its OpenSearch client.** Once
  security is disabled, those connections fail. Our
  [Dockerfile patch](docker/openrag-backend.Dockerfile) `sed`s two lines.
- **Langflow needs a Fernet key, not hex.** The upstream `.env.example`
  said `openssl rand -hex 32`; that produces an invalid Fernet key and
  Langflow's API-key generation 400's forever. We use a base64-encoded
  Python one-liner instead.
- **Docling isn't in upstream OpenRAG compose.** The upstream README tells
  you to `uvx docling-serve run` on the host; we add it as a sibling
  container so `docker compose up` is one command.
- **ElevenLabs reclassifies "default" voices into the paid library.**
  Voice IDs that worked yesterday return `402 paid_plan_required` today.
  See [`src/lib/elevenlabs.ts`](src/lib/elevenlabs.ts) for the curated
  allowlist of IDs verified working on free-tier keys.
- **Next.js dev caches `.env` at module load.** Edit a voice ID and
  retry without restarting? You get the old value. Our env reads now
  happen per-call.

---

## File layout

```
src/app/
  layout.tsx                                     root layout + HealthGate
  page.tsx                                       home (notebook list, create, delete)
  notebooks/[id]/page.tsx                        the three-panel notebook view
  api/
    health/route.ts                              backend readiness probe
    setup/route.ts                               one-time OpenRAG onboarding
    notebooks/route.ts                           list & create
    notebooks/[id]/route.ts                      bundle (notebook + documents + messages + podcasts)
    notebooks/[id]/chat/route.ts                 send a message, get an answer
    notebooks/[id]/documents/route.ts            upload a file
    notebooks/[id]/documents/[docId]/route.ts    delete a source
    notebooks/[id]/podcast/route.ts              kick off podcast generation
    podcasts/[id]/route.ts                       single-podcast lookup

src/components/
  HealthGate.tsx                                 wait-for-backend gate
  Spinner.tsx                                    one SVG spinner used everywhere
  MenuButton.tsx                                 the "⋯" overflow menu

src/lib/
  openrag.ts                                     chat() + ingestDocument()
  elevenlabs.ts                                  tts() + voice ID allowlist
  podcast.ts                                     draftScript + parseScript + synthesizeAndStitch
  db.ts                                          SQLite schema (lazy-init, WAL)

docker/
  openrag-backend.Dockerfile                     sed-patches the upstream image

docker-compose.yml                               opensearch + docling + langflow + openrag-backend
```

---

## What this project is _not_

- **Multi-tenant.** Everyone shares one OpenSearch index. Per-notebook
  filtering would need OpenRAG's `/knowledge-filter` API (not wired up).
- **Production-ready.** No auth, no rate limiting, no observability beyond
  console logs.
- **An OpenRAG redistribution.** We rebuild one of their images with a
  two-line patch. Their license terms apply to their pieces.

This is a learning surface. Read the file headers. Edit them. Break
things. _Basically_, have fun.
