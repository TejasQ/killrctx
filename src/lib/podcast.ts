// ============================================================================
// podcast.ts — turning a notebook into a two-host audio episode
// ============================================================================
//
// _Basically_, this file is the entire "Generate podcast" feature in three
// steps:
//
//   1. Ask OpenRAG to draft a script (HOST/GUEST alternating lines), grounded
//      in the documents that have already been embedded into OpenSearch.
//   2. Parse the script into discrete turns.
//   3. Send each turn to ElevenLabs, get an MP3 chunk, and stitch the chunks
//      together into one playable file.
//
// Why a two-step "draft script, then synthesize" pipeline instead of a single
// model that emits audio directly:
//   - Inspectable & editable. The script is just text; we save it on the
//     podcast row so the UI can show "Show script" and so you can debug
//     hallucinations without re-paying for TTS.
//   - Cheap. We pay for one LLM call regardless of audio length, and only
//     pay TTS per turn. Re-synth is free (no LLM round-trip).
//   - Multi-voice. ElevenLabs gives us per-call voice IDs. By alternating
//     HOST_VOICE and GUEST_VOICE per turn we get a natural conversation
//     without doing anything clever.
//
// The "naive concat" trick (see `synthesizeAndStitch`) is the surprising
// part: MP3 frames from the same encoder concatenate as one valid file.
// No re-encoding, no ffmpeg, no temp WAVs. See the comment there.
// ============================================================================

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chat } from "./openrag";
import { tts, HOST_VOICE, GUEST_VOICE } from "./elevenlabs";

export type Turn = { speaker: "HOST" | "GUEST"; text: string };

// The system-style prompt we hand to OpenRAG. Constraints (especially the
// strict "HOST: / GUEST:" line format) are how we keep the parser cheap.
// The "Ground every claim" line is what stops the agent from inventing facts
// — though OpenRAG also enforces this via its own retrieval system prompt.
//
// The "explain like the listener has never heard of this" rule is what
// makes the output sound like a real *podcast* and not like two researchers
// talking past each other. Without it, the agent will happily say "the
// Transformer does away with recurrence and convolutions" and leave the
// listener with no idea what either of those words mean.
const SCRIPT_PROMPT = `Write a long-form, beginner-friendly two-host podcast script grounded in the documents available to you.

Format STRICTLY as alternating lines, each prefixed with HOST: or GUEST:. No stage directions, no markdown, no headings, no bullet points. Plain text only.

ROLES
- HOST: a curious generalist standing in for the listener. Asks "wait, what is X?" whenever a technical term shows up. Reacts. Re-states the GUEST's points in plain language to confirm understanding.
- GUEST: the expert who read the documents end to end. Patient teacher, not a lecturer. Always defines a term the FIRST time it appears, using everyday analogies before any technical detail.

CONTENT RULES
- Open with a 30-second hook in plain English: what's interesting about this topic and why a non-expert should care.
- Cover 5-8 substantive points from the documents. For each point, follow this beat:
    1. GUEST introduces the idea in one sentence of plain English.
    2. HOST asks for the underlying mechanism or definition.
    3. GUEST explains in 2-4 sentences with a concrete analogy or example BEFORE any jargon.
    4. HOST paraphrases it back ("so basically...") to lock it in.
- Whenever you use a technical term (e.g. "recurrence", "self-attention", "embedding", "RNN"), GUEST must define it with an everyday comparison the first time it appears. Don't assume the listener knows it.
- Cite filenames inline when natural ("...as the paper attention-is-all-you-need.pdf puts it...").
- Close with a one-paragraph takeaway: what changed in the world because of this work, in language a smart 14-year-old would follow.

LENGTH
- 30 to 50 turns total. Aim for the higher end — this should feel like a 12-15 minute episode, not a quick summary.
- Each turn 1-4 sentences. GUEST turns can be longer when explaining mechanisms; HOST turns are usually shorter.

GROUNDING
- Every factual claim about the topic must come from the indexed documents. If a fact isn't in them, don't invent it — either skip the point or have GUEST say "the paper doesn't go into detail on that".`;

/**
 * Step 1 — ask OpenRAG to draft a podcast script.
 *
 * `topic` is optional context the user typed in the Studio panel; it gets
 * prepended so the agent focuses on a specific angle instead of summarising
 * the whole corpus. We pass `limit: 12` to give the retrieval tool plenty of
 * passages to work with — podcasts benefit from variety.
 */
export async function draftScript(topic?: string): Promise<string> {
  const prompt = topic
    ? `Topic focus: ${topic}\n\n${SCRIPT_PROMPT}`
    : SCRIPT_PROMPT;
  const { response } = await chat({ prompt, limit: 12 });
  const script = response.trim();
  if (!script) throw new Error("OpenRAG returned an empty script");
  return script;
}

/**
 * Step 2 — parse the script into structured turns.
 *
 * The regex tolerates extra whitespace and case variations ("Host:", "GUEST :").
 * Lines that don't match (blank lines, accidental markdown headings) are
 * silently dropped. If the LLM ignored the format entirely, we end up with
 * zero turns and the caller fails loudly.
 */
export function parseScript(script: string): Turn[] {
  const turns: Turn[] = [];
  for (const raw of script.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(HOST|GUEST)\s*:\s*(.+)$/i.exec(line);
    if (!m) continue;
    turns.push({ speaker: m[1].toUpperCase() as Turn["speaker"], text: m[2].trim() });
  }
  return turns;
}

/**
 * Step 3 — synthesize each turn and stitch into one MP3.
 *
 * **The naive-concat trick:** ElevenLabs returns MP3 frames encoded with the
 * same codec parameters (mp3_44100_128 — 44.1 kHz, 128 kbps). MP3 is a
 * frame-based format with no global header that needs updating, so
 * concatenating raw bytes from the same encoder produces a single valid file
 * that browsers play back continuously. No ffmpeg, no re-encoding. The same
 * trick wouldn't work for WAV (RIFF header has a length field) or AAC
 * (container-based formats need proper muxing).
 *
 * Calls are sequential, not parallel — this avoids slamming ElevenLabs with
 * 20 concurrent requests and makes total cost predictable. Synthesis takes
 * ~30s for a typical 18-turn episode.
 */
export async function synthesizeAndStitch(
  turns: Turn[],
  outPath: string,
): Promise<void> {
  const buffers: Buffer[] = [];
  for (const turn of turns) {
    const voiceId = turn.speaker === "HOST" ? HOST_VOICE() : GUEST_VOICE();
    const audio = await tts({ voiceId, text: turn.text });
    buffers.push(audio);
  }
  // The output dir lives under public/ so Next.js serves the resulting
  // /podcasts/<id>.mp3 statically without us writing a route handler.
  mkdirSync(join(process.cwd(), "public", "podcasts"), { recursive: true });
  writeFileSync(outPath, Buffer.concat(buffers));
}
