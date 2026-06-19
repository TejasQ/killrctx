# Requirements — Outline Visual Theme

## User story

As a researcher using killrctx, I want the Outline note type to have a strong visual
theme so that I can scan, navigate, and read hierarchical content more easily than with
plain numbered text.

---

## Core concept

An outline is a **depth-first hierarchy** — the structure itself is the message.
Visual design should reinforce depth, not just label it. The reader's eye should
immediately know "I am at level 2 of 3" without counting indents or reading numbers.

---

## Requirements

### REQ-001 — Depth-coded heading colors
Each heading level renders in a distinct color that signals hierarchy:
- H2 (top-level section) — amber / gold
- H3 (subsection) — orange
- H4 (sub-subsection) — rose / coral

**Acceptance criteria:**
- The three heading colors are visually distinct and readable on the dark panel background.
- Colors are only applied inside outline notes — no other note type or chat message changes.

### REQ-002 — Left-border depth rails
Each heading level carries a left border in its theme color so the vertical scan line
is visible even when the heading text is out of view.

**Acceptance criteria:**
- H2 has a thicker left border than H3; H3 thicker than H4.
- The border color matches the heading text color for that level.

### REQ-003 — Numbered-item pill badges
Ordered-list items replace the bare numeral with a small colored pill badge (a tight
circle/rounded chip) so section numbers feel like structural landmarks rather than
plain prose punctuation.

**Acceptance criteria:**
- Each `ol > li` renders with its 1-based index as a pill, not as a CSS `list-decimal`.
- The pill color is amber (matching H2) for first-level lists, dimming for nested lists.

### REQ-004 — Sharpened outline prompt
The LLM prompt for outline generation is updated to produce a consistent, deep
hierarchical structure that the visual theme can leverage:
- Roman numerals (I, II, III) at the top level as H2 headings.
- Capital letters (A, B, C) at the second level as H3 headings.
- Arabic numerals (1, 2, 3) as ordered list items under each letter.

**Acceptance criteria:**
- Generated outlines reliably use the three-level structure above.
- The prompt instructs the model to stay in outline form (no prose paragraphs).

### REQ-005 — Theme scoped to outline only
All visual changes are isolated to outline note rendering. The generic
`markdownComponents` used by chat, summary, mindmap, and Q&A are unchanged.

**Acceptance criteria:**
- Reopening a Summary or Q&A note looks identical to before.
- The outline theme applies in both the collapsed inline preview in NoteCard and
  the full expanded reading view.

---

## Out of scope

- Section folding / accordion collapse (interactive hierarchy navigation).
- Sticky breadcrumb showing current depth position while scrolling.
- Exporting or copying the outline.
- Any change to the Podcast, Summary, Mind Map, or Q&A note types.
- Changes to the in-flight streaming preview (it uses the generic components).
