# Design — Note Types

## Overview

The Studio panel today has one hardcoded note type: Podcast. This design unifies all
generated artefacts under a single `notes` table and adds four synchronous note types
(Summary, Mind Map, Outline, Q&A) alongside the existing async Podcast type.

---

## SQLite changes

### Replace `podcasts` table with `notes`

The `podcasts` table is dropped and replaced with a `notes` table. Podcast-specific
columns (`status`, `audio_url`, `script`, `error`) remain but are nullable — they are
only populated for `type = 'podcast'` rows.

```sql
CREATE TABLE IF NOT EXISTS notes (
  id          TEXT    PRIMARY KEY,
  notebook_id TEXT    NOT NULL,
  type        TEXT    NOT NULL,  -- 'podcast' | 'summary' | 'mindmap' | 'outline' | 'qa'
  title       TEXT    NOT NULL,
  content     TEXT,              -- AI-generated markdown (null until generation completes)
  status      TEXT,              -- podcast only: 'pending'|'scripting'|'synthesizing'|'ready'|'failed'
  audio_url   TEXT,              -- podcast only
  script      TEXT,              -- podcast only
  error       TEXT,              -- podcast only (failure message)
  created_at  INTEGER NOT NULL,
  FOREIGN KEY(notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE
);
```

### Migration strategy

In `getDb()`, after the existing migration blocks, add:

```ts
// If the old `podcasts` table exists, copy its rows into `notes` and drop it.
const tables = conn.prepare(
  `SELECT name FROM sqlite_master WHERE type='table' AND name='podcasts'`
).all();
if (tables.length > 0) {
  conn.exec(`
    INSERT OR IGNORE INTO notes
      (id, notebook_id, type, title, content, status, audio_url, script, error, created_at)
    SELECT id, notebook_id, 'podcast', title, NULL, status, audio_url, script, error, created_at
    FROM podcasts;
    DROP TABLE podcasts;
  `);
}
```

`IF NOT EXISTS` on the `notes` CREATE TABLE plus `INSERT OR IGNORE` makes this
idempotent across restarts.

### Update `db.ts` types

Remove the `Podcast` export type. Add a `Note` export type:

```ts
export type Note = {
  id: string;
  notebook_id: string;
  type: "podcast" | "summary" | "mindmap" | "outline" | "qa";
  title: string;
  content: string | null;
  status: "pending" | "scripting" | "synthesizing" | "ready" | "failed" | null;
  audio_url: string | null;
  script: string | null;
  error: string | null;
  created_at: number;
};
```

---

## `src/lib/` changes

### New function: `generateNote()` in `src/lib/openrag.ts`

```ts
export async function generateNote(args: {
  type: "summary" | "mindmap" | "outline" | "qa";
  topic?: string;
}): Promise<string>
```

Makes a single `chat()` call with a type-specific system prompt. Returns the raw
markdown string. No DB writes — the API route owns persistence.

Prompts by type:
- **summary** — "Write a concise prose summary of the key information in the sources.
  Focus on the most important facts, themes, and conclusions."
- **mindmap** — "Create a hierarchical mind map of the key concepts in the sources.
  Use nested markdown lists (- item, indent with spaces for children). Do not use
  any other formatting."
- **outline** — "Write a structured outline of the topics covered in the sources.
  Use markdown headings (##, ###) and numbered lists."
- **qa** — "Generate a list of question-and-answer pairs covering the key facts in
  the sources. Format each pair as:\n**Q: ...?**\nA: ..."

If `topic` is provided, append: `"Focus on: {topic}."` to the prompt.

All four use `limit: 12` (same as podcast script drafting) for broader retrieval
coverage.

---

## API routes

Each note type has its own dedicated route file. There is no shared dispatcher — this
is intentional. Future types (e.g. a `mindmap` type that calls Excalidraw, a `flashcard`
type that talks to a different service) can be added by dropping in a new route file
without touching any existing type. The pattern is: one type, one file, one pipeline.

### Keep: `POST /api/notebooks/[id]/podcast/route.ts`

Unchanged except for the DB table name: all `INSERT INTO podcasts` / `SELECT FROM
podcasts` statements change to `INSERT INTO notes` / `SELECT FROM notes`, and the
insert gains `type = 'podcast'`.

### New: `POST /api/notebooks/[id]/notes/summary/route.ts`

Calls `generateNote({ type: "summary", topic })`, inserts the result, returns the row.
Export `runtime = "nodejs"`.

### New: `POST /api/notebooks/[id]/notes/mindmap/route.ts`

Calls `generateNote({ type: "mindmap", topic })`, inserts the result, returns the row.
Export `runtime = "nodejs"`.

### New: `POST /api/notebooks/[id]/notes/outline/route.ts`

Calls `generateNote({ type: "outline", topic })`, inserts the result, returns the row.
Export `runtime = "nodejs"`.

### New: `POST /api/notebooks/[id]/notes/qa/route.ts`

Calls `generateNote({ type: "qa", topic })`, inserts the result, returns the row.
Export `runtime = "nodejs"`.

All four text-type routes share the same ~20-line structure. Each route file is
intentionally small and self-contained — the shared logic lives in `generateNote()`
in `src/lib/openrag.ts`, not in the route layer.

### New: `DELETE /api/notebooks/[id]/notes/[noteId]/route.ts`

File: `src/app/api/notebooks/[id]/notes/[noteId]/route.ts`

Deletes any note row (podcast or text type) by ID. Returns `{ ok: true }`.

This replaces `src/app/api/notebooks/[id]/podcasts/[podcastId]/route.ts`, which is
deleted.

### Update: `GET /api/notebooks/[id]`

File: `src/app/api/notebooks/[id]/route.ts`

Replace the `podcasts` query with a `notes` query:

```ts
const notes = db
  .prepare("SELECT * FROM notes WHERE notebook_id = ? ORDER BY created_at DESC")
  .all(id) as Note[];
return NextResponse.json({ notebook, documents, conversations, messages, notes });
```

Remove the `Podcast` import; add the `Note` import.

---

## UI changes

### `src/app/notebooks/[id]/page.tsx`

**Types** — remove the local `Podcast` type, add:
```ts
type Note = {
  id: string;
  type: "podcast" | "summary" | "mindmap" | "outline" | "qa";
  title: string;
  content: string | null;
  status: "pending" | "scripting" | "synthesizing" | "ready" | "failed" | null;
  audio_url: string | null;
  script: string | null;
  error: string | null;
  created_at: number;
};
```

**State** — rename `podcasts` / `setPodcasts` → `notes` / `setNotes`. Update `refresh()`
to read `data.notes` and fan it into `setNotes`.

**Polling** — the existing `useEffect` that polls while any podcast is non-terminal
changes to poll while any note has `type === 'podcast'` and a non-terminal status.

**`StudioPanel` props** — replace `podcasts: Podcast[]` with `notes: Note[]`.

**`StudioPanel` component** — two sections stacked vertically:

1. **Type selector grid** — a 3-column grid of clickable type cards. Each card shows
   a small icon, a label, and a `›` chevron. Clicking a card opens an inline "generate"
   panel below the grid (topic input + Generate button) for that type. Only one type
   can be open at a time; clicking the same card again collapses it.

   Types and icons (using Unicode or a simple inline SVG — no icon library needed):
   | type      | label     | icon |
   |-----------|-----------|------|
   | `podcast` | Podcast   | 🎙 or a mic SVG |
   | `summary` | Summary   | ☰ or lines SVG |
   | `mindmap` | Mind Map  | ✦ or branch SVG |
   | `outline` | Outline   | ≡ or list SVG |
   | `qa`      | Q&A       | ? or bubble SVG |

   The selected card gets a highlighted border (accent colour). The generate panel
   shows below the grid only while a card is selected.

2. **Notes list** — all generated notes ordered newest-first. Each row shows the
   type icon, title, and creation date. Clicking a row expands its content inline.
   A delete button appears on hover.

On Generate, POST to `/api/notebooks/[id]/podcast` for podcast, or
`/api/notebooks/[id]/notes/<type>` for all other types. After the response, collapse
the generate panel and call `onCreated()`.

**`PodcastCard`** — unchanged; only rendered when `note.type === 'podcast'`.

**New `NoteCard` component** — renders a text-based note card. Type icon and title
always visible. Click anywhere on the card to expand/collapse the markdown body
(rendered with the existing `markdownComponents` config). Delete button visible on
hover.

---

## REQ coverage

| REQ-ID  | Design item that covers it |
|---------|---------------------------|
| REQ-001 | `notes` table + `Note` type + migration from `podcasts` |
| REQ-002 | `generateNote({ type: "summary" })` + `POST /notes` + `NoteCard` |
| REQ-003 | `generateNote({ type: "mindmap" })` + `NoteCard` (indented list via ReactMarkdown) |
| REQ-004 | `generateNote({ type: "outline" })` + `NoteCard` (headings via ReactMarkdown) |
| REQ-005 | `generateNote({ type: "qa" })` + `NoteCard` |
| REQ-006 | Podcast type routes through `POST /notes` with `type = 'podcast'`; `PodcastCard` unchanged |
| REQ-007 | Unified notes list in `StudioPanel`; `notes` in bundle endpoint replaces `podcasts` |
| REQ-008 | `topic` input in `StudioPanel`; passed to `generateNote()` and podcast pipeline |
