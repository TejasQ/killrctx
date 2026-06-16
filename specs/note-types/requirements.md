# Requirements — Note Types

## User story

As a researcher using killrctx, I want to generate different types of notes from my
sources so that I can get the information out of my documents in the format that's most
useful for how I think.

---

## Core concept

A **note** is anything the Studio generates from your sources. Podcast is one note
type. Summary, Mind Map, Outline, and Q&A are others. All note types live in the same
list in the Studio panel — the user picks a type, hits Generate, and a card appears.

The podcast type is special only in that it has an async multi-step pipeline (scripting
→ synthesizing → ready). All other note types generate synchronously.

## Architectural principle

Each note type is fully self-contained — its own API route, its own generation logic,
its own card renderer. Adding a new note type (e.g. a mind map that calls Excalidraw,
flashcards that talk to an external service) means dropping in new files without
touching any existing type. No shared dispatcher, no branching on type in shared code.

---

## Requirements

### REQ-001 — Unified notes data model
All generated artefacts — podcasts and new text-based note types — share a single
`notes` table. Each note has a `type` (`"podcast"`, `"summary"`, `"mindmap"`,
`"outline"`, `"qa"`), a `title`, and a `content` body. Podcast rows additionally carry
`status`, `audio_url`, `script`, and `error` columns (nullable on non-podcast rows).

**Acceptance criteria:**
- A `notes` table replaces the separate `podcasts` table.
- Existing podcast rows are migrated into `notes` with `type = 'podcast'`.
- Deleting a notebook cascades to all its notes.

### REQ-002 — Note type: Summary
The user can generate a **Summary** note — concise prose summarising the sources.

**Acceptance criteria:**
- "Summary" appears in the note type selector in the Studio panel.
- Generating it produces a note card with the AI-written content.

### REQ-003 — Note type: Mind Map
The user can generate a **Mind Map** note — a hierarchical breakdown of the key
concepts in the sources, represented as a nested list.

**Acceptance criteria:**
- "Mind Map" appears in the note type selector.
- The rendered card shows an indented tree structure (not raw text).

### REQ-004 — Note type: Outline
The user can generate an **Outline** note — a structured, numbered outline of the main
topics covered in the sources.

**Acceptance criteria:**
- "Outline" appears in the note type selector.
- The rendered card shows heading hierarchy and numbered items.

### REQ-005 — Note type: Q&A
The user can generate a **Q&A** note — question-and-answer pairs covering the key
facts in the sources.

**Acceptance criteria:**
- "Q&A" appears in the note type selector.
- The rendered card displays questions and answers in a readable format.

### REQ-006 — Note type: Podcast (existing, unchanged behaviour)
Podcast remains a note type in the same selector. Its generation pipeline and card
rendering (status pill, audio player, script toggle) are unchanged.

**Acceptance criteria:**
- Podcast appears in the note type selector alongside the new types.
- Existing podcast generation, polling, and card UI behave identically to today.

### REQ-007 — Unified note list in the Studio panel
All notes — regardless of type — are displayed together in the Studio panel, ordered
by creation date (newest first).

**Acceptance criteria:**
- One list shows all note types with a type label on each card.
- Clicking a text-based note card expands its content inline (rendered markdown).
- Individual notes can be deleted.
- The list updates after generation without a page reload.

### REQ-008 — Optional topic / focus
When generating any note type, the user can optionally provide a topic or focus string
to guide the AI (same UX as today's podcast topic input).

**Acceptance criteria:**
- A single "Optional topic / focus" input appears above the Generate button.
- Leaving it blank generates a note covering the sources broadly.

---

## Out of scope

- Editing note content after generation (read-only).
- Exporting notes to files.
- Note generation progress beyond a loading spinner (for synchronous types).
- More than the five listed note types (podcast + four new) in this PR.
