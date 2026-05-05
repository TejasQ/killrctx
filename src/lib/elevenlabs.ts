// ============================================================================
// elevenlabs.ts — text-to-speech client for the podcast feature
// ============================================================================
//
// _Basically_, this file turns one line of script ("HOST: hello world") into
// a chunk of MP3 audio by hitting the ElevenLabs REST API. The podcast
// generator (lib/podcast.ts) calls `tts()` once per turn and stitches the
// resulting buffers together into a single playable file.
//
// Why this is so small:
//   We do not need streaming, voice cloning, or fine-grained controls — just
//   "give me an MP3 of this sentence in this voice". One POST, one response.
//
// Two real-world gotchas that drove the shape of this file:
//
//   1. **Voice IDs are tiered.** ElevenLabs' UI shows hundreds of voices,
//      but most of them are *library/community* voices and require a paid
//      plan to use via the API. Only the ~10 *default* voices (Aria, Brian,
//      Roger, Sarah, ...) are accessible to free-tier accounts. If you pick
//      a library voice and call /v1/text-to-speech with a free key, you get
//      a 402 paid_plan_required and zero audio. The `KNOWN_DEFAULT_VOICES`
//      table below is a curated allowlist of free-tier-safe IDs. See:
//      https://help.elevenlabs.io/hc/en-us/articles/25844757988753
//
//   2. **Env vars are read per call, not at module load.** Next.js dev mode
//      hot-reloads modules but does NOT re-read .env between requests, so a
//      module-level `const HOST_VOICE = process.env.X` snapshots the value
//      that was set when the server started. Reading inside `tts()` means
//      you can edit .env, retry, and it'll pick up the change.
// ============================================================================

// The two voice IDs known to work on *brand-new free-tier* API keys without
// any extra account setup. ElevenLabs has been steadily reclassifying its
// "default" voices into the paid Voice Library, so what worked yesterday may
// 402 today. This pair was verified working as of mid-2026 — see
// https://github.com/danielmiessler/Personal_AI_Infrastructure/issues/925
// for an empirical sweep across all common preset IDs.
//
// If both of these eventually 402 too: the only durable fix is for the user
// to log into the ElevenLabs UI, browse Voice Library, click "Add to my
// voices" on a voice they like (some are free-to-add; many require a paid
// plan), and paste *their* personal voice ID into .env.
export const KNOWN_FREE_VOICES = {
  Will: "bIHbv24MWmeRgasZH58o",
  Hope: "bVMeCyTHy58xNoL34h3p",
} as const;

// Public re-exports — the podcast generator imports these to know which voice
// to use for each speaker. They're getters (not consts) so .env edits are
// picked up on the next request without restarting `next dev`.
export const HOST_VOICE = () =>
  process.env.ELEVENLABS_HOST_VOICE_ID ?? KNOWN_FREE_VOICES.Will;
export const GUEST_VOICE = () =>
  process.env.ELEVENLABS_GUEST_VOICE_ID ?? KNOWN_FREE_VOICES.Hope;

/**
 * Synthesize one chunk of audio.
 *
 * @param voiceId  ElevenLabs voice ID. Must be one of *your* voices or one
 *                 of the default presets (see `KNOWN_DEFAULT_VOICES`). Library
 *                 voices fail with 402 on free plans.
 * @param text     The line to speak. Plain text only — no SSML, no markdown.
 *                 Keep it short-ish (a sentence or two) for natural pacing.
 *
 * @returns        Raw MP3 bytes (mp3_44100_128 — 44.1 kHz, 128 kbps stereo).
 *                 Concatenating frames from the same encoder plays back as
 *                 one continuous file in browsers; that's why podcast.ts
 *                 just `Buffer.concat`s them.
 */
export async function tts(args: {
  voiceId: string;
  text: string;
}): Promise<Buffer> {
  const apiKey = process.env.ELEVENLABS_API_KEY ?? "";
  const modelId = process.env.ELEVENLABS_MODEL_ID ?? "eleven_multilingual_v2";

  if (!apiKey) {
    throw new Error(
      "ELEVENLABS_API_KEY not set. Get one at https://elevenlabs.io/app/settings/api-keys",
    );
  }

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${args.voiceId}?output_format=mp3_44100_128`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text: args.text,
      model_id: modelId,
      // These are ElevenLabs' recommended defaults for narration. `style: 0.3`
      // adds a touch of expressiveness without making the voice unstable.
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0.3,
        use_speaker_boost: true,
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");

    // 402 paid_plan_required is the single most common failure for new
    // users — surface a self-explaining message instead of a raw API dump.
    if (res.status === 402 && body.includes("paid_plan_required")) {
      const known = Object.entries(KNOWN_FREE_VOICES)
        .map(([name, id]) => `  ${name.padEnd(10)} ${id}`)
        .join("\n");
      throw new Error(
        `ElevenLabs rejected voice "${args.voiceId}" with paid_plan_required.\n\n` +
          `Most "default" preset voices have been reclassified as library voices and now require a paid plan via the API. Voices verified working on free-tier keys:\n\n${known}\n\n` +
          `Set ELEVENLABS_HOST_VOICE_ID + ELEVENLABS_GUEST_VOICE_ID in .env to one of those, then retry. (Env vars are read per-request, no dev-server restart needed.)\n\n` +
          `Or upgrade at https://elevenlabs.io/pricing.`,
      );
    }

    throw new Error(
      `ElevenLabs TTS failed (${res.status}): ${body.slice(0, 500)}`,
    );
  }

  const arr = await res.arrayBuffer();
  return Buffer.from(arr);
}
