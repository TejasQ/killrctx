# Design — Source Citations in Chat

## Overview

Three changes, in dependency order:

1. **`fixMarkdown()` in `page.tsx`** — strip LLM tool-call noise from response text (REQ-001)
2. **`chat/route.ts`** — forward `SourcesEvent` data to the client as a new SSE event type (REQ-002)
3. **`page.tsx` (ChatPanel + new `SourceCitation` component)** — receive sources in state and render the footer (REQ-003, REQ-004)

No SQLite changes. No new API routes. No new lib functions.

---

## SQLite changes

None. Sources are ephemeral display metadata — they live in React state only.

---

## API route changes

### `src/app/api/notebooks/[id]/chat/route.ts`

Add handling for the `"sources"` stream event type, which the SDK emits once
during a response (it currently falls through the `if/else if` chain silently).

When a `SourcesEvent` arrives, send it to the client as:

```json
{ "type": "sources", "sources": [{ "filename": "...", "score": 0.87, "page": 4, "mimetype": "application/pdf" }] }
```

The existing SSE `send()` helper is already in scope — one `else if` branch is all
that's needed. No other route changes.

---

## `src/lib/` changes

None. The SDK `Source` type is already exported from `openrag-sdk` and used in
`openrag.ts`. No new functions needed.

---

## UI changes

### `src/app/notebooks/[id]/page.tsx`

#### 1. `fixMarkdown()` — strip LLM narration (REQ-001)

Extend the existing `fixMarkdown(raw: string): string` function with two additional
replacements before the existing table-gap fix:

```
(Source: <anything except newline>) → ""
{"search_query": "<anything except newline>"} → ""
```

Regex patterns:
- `/\(Source:[^\)]*\)/g` — matches `(Source: anything)` including filenames with spaces
- `/\{"search_query":\s*"[^"]*"\}/g` — matches the JSON blob exactly

Applied to the same `raw` string already passed through this function, so it
automatically covers both stored messages and the live streaming text (both render
paths call `fixMarkdown`).

#### 2. `ChatPanel` — sources state (REQ-002, REQ-004)

Add a `Map<string, Source[]>` state keyed by message ID:

```ts
// messageId → de-duplicated Source[] for that response
const [messageSources, setMessageSources] = useState<Map<string, Source[]>>(new Map());
```

Why a Map keyed by message ID?
- Stored messages use their SQLite `id`.
- The in-flight streaming message has no ID yet — use a sentinel key `"streaming"`.
- After `onSent()` triggers a refresh, the streaming placeholder is replaced by a
  real message row. The `"streaming"` entry is cleared on the next send, so stale
  sources from a previous turn don't leak.

In the SSE reader loop in `send()`, add a branch for `payload.type === "sources"`:

```ts
} else if (payload.type === "sources" && Array.isArray(payload.sources)) {
  setMessageSources((prev) => new Map(prev).set("streaming", deduplicateSources(payload.sources)));
}
```

On `done`, move the `"streaming"` entry to the real message ID (available after
`onSent()` refreshes the message list). The simplest approach: keep `"streaming"` in
the map and, when rendering, check `messageSources.get(m.id) ?? messageSources.get("streaming")`.
Then clear `"streaming"` at the start of each new `send()` call.

Wait — the message ID isn't known during streaming. Better approach: keep a local
`ref` for the pending sources and commit to state once the real message ID arrives
from the next `refresh()`. Actually, simplest of all: just map by position. But that
breaks on conversation switches.

**Simplest correct approach:** The `"streaming"` key approach works fine if we also
clear it when a new send starts (`setMessageSources((prev) => { const m = new Map(prev); m.delete("streaming"); return m; })`).
On render, after the stream ends and the real message row appears, sources aren't
shown for old loaded messages — that's explicitly accepted by REQ-004.

#### 3. `SourceCitation` component — new file `src/components/SourceCitation.tsx` (REQ-003)

A small pure component. Props:

```ts
type Props = { sources: Source[] }
```

The `Source` type is imported directly from `"openrag-sdk"`.

Renders:
- A `"Sources"` label in muted text
- One pill per source (already de-duplicated before passing in)
- Each pill: mimetype icon + filename (+ ` · p.N` if `page` is not null)
- Title attribute on each pill: `score: 0.87` (shown on hover as browser tooltip)

**Mimetype icon map** (emoji, no extra dependencies):

| mimetype contains | emoji |
|---|---|
| `pdf` | 📄 |
| `csv` or `spreadsheet` or `excel` | 📊 |
| `presentation` or `pptx` or `powerpoint` | 📑 |
| `word` or `docx` | 📝 |
| anything else / null | 📎 |

**Pill styling** (consistent with the project's dark theme):
```
inline-flex items-center gap-1 rounded border border-edge bg-ink px-2 py-0.5 text-[11px] text-muted
```

#### 4. Message render — wire `SourceCitation` in (REQ-003, REQ-004)

In the `visibleMessages.map()` block, after the `<ReactMarkdown>` block for assistant
messages, add:

```tsx
{messageSources.get(m.id) && (
  <SourceCitation sources={messageSources.get(m.id)!} />
)}
```

In the streaming `{sending && ...}` block, after the `<ReactMarkdown>` (or spinner), add:

```tsx
{messageSources.get("streaming") && (
  <SourceCitation sources={messageSources.get("streaming")!} />
)}
```

---

## Helper: `deduplicateSources`

A small pure function, defined at the top of `page.tsx` near `fixMarkdown`:

```ts
// Keep one entry per filename — the one with the highest score.
function deduplicateSources(sources: Source[]): Source[] {
  const best = new Map<string, Source>();
  for (const s of sources) {
    const existing = best.get(s.filename);
    if (!existing || s.score > existing.score) best.set(s.filename, s);
  }
  return Array.from(best.values());
}
```

---

## REQ coverage table

| REQ-ID | Design item that covers it |
|--------|---------------------------|
| REQ-001 | `fixMarkdown()` regex extensions in `page.tsx` |
| REQ-002 | `"sources"` SSE event branch in `chat/route.ts` |
| REQ-003 | `SourceCitation` component + `messageSources` state in `ChatPanel` |
| REQ-004 | `"streaming"` sentinel key in `messageSources`; cleared on new send |
