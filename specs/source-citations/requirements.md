# Requirements — Source Citations in Chat

## User story

As a notebook user, I want assistant responses to clearly show which documents were
used to ground the answer, so that I can trust the response and trace information back
to a specific source file.

---

## Requirements

### REQ-001 — Strip LLM tool-call narration from visible text

The LLM agent sometimes emits its own internal tool-call state inline in the response
text, e.g.:

```
(Source: openrag_spec_coding.pptx)
{"search_query": "top-python-and-data-jobs.csv"}
```

These strings must be removed from the rendered message text before display.

**Acceptance criteria:**
- `(Source: <any text>)` patterns are stripped from assistant message content.
- `{"search_query": "<any text>"}` JSON blobs are stripped from assistant message content.
- The stripping must apply to both the live streaming text and stored message content
  retrieved from SQLite.
- No other text is altered.

---

### REQ-002 — Forward structured source data through the SSE stream

The OpenRAG SDK emits a `SourcesEvent` during streaming that contains an array of
`Source` objects. This data must be forwarded to the client via the existing SSE channel.

**Acceptance criteria:**
- When a `SourcesEvent` arrives from the SDK, its `sources` array is sent to the
  client as a new SSE event type `"sources"`.
- Each source object forwarded must include at minimum: `filename`, `score`, `page`
  (nullable), `mimetype` (nullable).
- The `"sources"` event is sent once per response, after the content deltas.
- Stored message content in SQLite is not affected (sources are display-only metadata).

---

### REQ-003 — Render a sources footer on each assistant message

Each assistant message bubble must display a compact, readable footer listing the
documents OpenRAG retrieved to answer the question.

**Acceptance criteria:**
- A "Sources" footer appears below the markdown content of every assistant message
  that has at least one source.
- Each unique source filename is displayed as a distinct visual element (pill/badge).
- The mimetype is represented by a small icon or prefix (e.g. 📄 for PDF, 📊 for CSV,
  📑 for PPTX, 📝 for default).
- The relevance score is visible on hover (tooltip) rounded to two decimal places.
- If the source includes a page number, it is displayed alongside the filename
  (e.g. `report.pdf · p.4`).
- Duplicate filenames (same file cited multiple times with different chunks) are
  de-duplicated — show the entry with the highest score, keep only one pill per file.
- The footer is visually subordinate to the answer text (muted/smaller).

---

### REQ-004 — Sources footer renders on both streaming and stored messages

The sources footer must appear consistently regardless of whether the message is
being streamed live or loaded from SQLite history.

**Acceptance criteria:**
- During streaming, the sources footer appears as soon as the `"sources"` SSE event
  arrives (before the `"done"` event).
- On conversation reload, stored messages do not lose their sources footer.
- Sources are kept in component state only (not persisted to SQLite) — a page refresh
  will not re-show sources for old messages; that is acceptable.

---

## Out of scope

- Persisting source citations to SQLite (sources are ephemeral display metadata only).
- Clicking a source pill to expand the retrieved passage text.
- Linking sources to the Sources panel file list.
- Changing how sources are displayed in the Studio panel or podcast flow.
- Any change to ingest, filter, or settings flows.
