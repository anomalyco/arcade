#!/usr/bin/env bun
// Story voice lines (ElevenLabs text-to-speech, eleven_v3 with audio tags), kept clean and processed as radio
// transmissions with the design kit. Adds them to the audition page under "story":
//   story-call-player-<character>  the player's report in each playable character's own voice (2 takes each),
//                              keyed through a handset; src/audio/story.ts `playerVoice` picks the one to play;
//   story-call-player-m / -f   the first male / female takes, kept as fallbacks;
//   story-call-reply           the county dispatcher (older, flat), broken up by static and dropouts;
//   …-clean                    the same takes before processing.
//
//   bun audio-lab/design/story.ts            # generate missing TTS takes (credits), process the new ones, QA
//   bun audio-lab/design/story.ts --process  # re-process every clean take (no credits)
import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { elevenKey, loadManifest, ROOT, saveManifest, type ManifestSound } from "../lib/eleven"
import { normaliseSound } from "../lib/loudness"
import { judge, QA_MODEL } from "../lib/gemini"
import { isApproved } from "../lib/approved"
import * as D from "./dsp"

const MODEL = "eleven_v3"
const PLAYER = "Ashwood Outpost to County. I've found the station staff. Four dead. Two unaccounted for. Requesting assistance."
const PLAYER_TAGGED = "[shaken, trying to stay calm] Ashwood Outpost to County. [breath] I've found the station staff. [voice wavers] Four dead. Two unaccounted for. [steadies] Requesting assistance."
const PLAYER_TAGGED_ALT = "[breathless, scared, barely holding it together] Ashwood Outpost to County. [shaky breath] I've found the station staff. [quietly] Four dead. Two unaccounted for. [urgent] Requesting assistance."
const REPLY_TAGGED = "[flat, professional, tired] Copy, Ashwood. Units dispatched. Stay where you are."
// Round 3 (Aiden: "more shaken and realistic"): breathing, pauses, hesitations and catches, worded a little differently
// per character; the facts stay: four dead, two unaccounted for, requesting assistance.
const SHAKEN: Record<string, string> = {
  remy: "[breathing heavily] Ashwood Outpost to... to County. [shaky breath] I've, uh... I've found the station staff. [pause] Four dead. [breath] Two... two unaccounted for. [swallows] Requesting assistance.",
  james: "[panting] County, this is Ashwood Outpost. [swallows] I, um... I found the staff. [shaky exhale] Four of them are dead. [pause] Two are... unaccounted for. [breath] Requesting assistance.",
  louise: "[trying to stay composed, breath shaking] Ashwood Outpost to County. [sharp inhale] I've located the station staff. [voice catches] Four... four dead. [pause] Two unaccounted for. [steadying breath] Requesting assistance.",
  megan: "[breathing fast, scared] Ashwood Outpost to County, uh... [shaky breath] I found them. The station staff. [voice breaks] Four are dead. [sniffs] Two, um... two unaccounted for. [breath] Requesting assistance.",
  kate: "[heavy breathing] Ashwood Outpost to County. [swallows] I've found the station staff. [long pause] Four dead. [shaky breath] Two unaccounted for. [exhales] Requesting... requesting assistance.",
}
// Round 4 (final scripts from the owner): close to verbatim, line 3 may vary by a word or two per character; one
// restart ("they're... they're"), one or two breaths, no fillers, no long pauses; tightens on "dead", pleads at the end.
export const FINAL_LINE3: Record<string, string> = {
  remy: "There's two more I can't find anywhere.",
  james: "There's two more I can't find.",
  louise: "There are two more I can't find anywhere.",
  megan: "Two more, I don't know where they are.",
  kate: "There's two more I can't find anywhere.",
}
const finalScript = (id: string) =>
  `[shaken, trying to hold it together] County, County, this is Ashwood Outpost, do you read? [breath] I'm up at the station and they're... they're all [voice tightens] dead. Four of them. ${FINAL_LINE3[id]} [pleading] Please, I need somebody out here.`
const REPLY_PLAIN = "Ashwood, County dispatch, copy. Units are on the way, I need you to stay right where you are. Do not move."
const REPLY_FINAL = "Ashwood, County dispatch, copy. Units are on the way. I need you to stay right where you are. Do not move."
const REPLY_FINAL_TAGGED = "[tired, 3 a.m., professional] Ashwood, County dispatch, copy. [clipped, serious] Units are on the way. I need you to stay right where you are. [flat, firm] Do not move."
const REPLY_NEW = "Copy, Ashwood. We are dispatching units. Stay where you are. Do NOT move."
const REPLY_NEW_TAGGED = "[flat, procedural, authoritative] Copy, Ashwood. We are dispatching units. Stay where you are. [firm, emphatic] Do NOT move."

type Mode = "radio" | "broken" | "dispatch"
type Take = { voice: string; name: string; text: string; settings: Record<string, number | boolean>; variant?: string; mode?: Mode; fit?: number; model?: string; softEnd?: boolean }

// Round 4 of the radio call (Aiden: the v3 tags and the pause trimming read "AI"): eleven_multilingual_v2, low
// stability, high style, continuous text with commas and one restart, no post-hoc edits. One male and one female
// player voice from now on (playerVoice maps characters to -m / -f). Small batches: two takes at a time.
const R4_MODEL = "eleven_multilingual_v2"
const R4_PLAYER = "County, County, this is Ashwood Outpost, do you read? I'm up at the station, and they're... they're all dead, four of them, there's two more I can't find anywhere, please, I need somebody out here."
const R4_REPLY = "Ashwood, County dispatch, copy. Units are on the way. I need you to stay right where you are. Do not move."
const R4_LOOSE = { stability: 0.3, similarity_boost: 0.75, style: 0.6, use_speaker_boost: true }
type Line = { id: string; label: string; intent: string; subgroup?: string; takes: Take[] }
const LINES: Line[] = [
  {
    id: "story-call-player-m-r4",
    label: "Player radio report (male), round 4",
    subgroup: "Radio-room call",
    intent: `a regular man (not a narrator) panicking on a radio handset, natural conversational speed with words running together, no artificial pauses, one hitch on "they're... they're": "${R4_PLAYER}"`,
    takes: [
      { voice: "UgBBYS2sOqTuMpoF3BR0", name: "Mark (library, natural conversations)", text: R4_PLAYER, settings: R4_LOOSE, model: R4_MODEL },
      { voice: "iP95p4xoKVk53GoZ742B", name: "Chris (casual, down-to-earth)", text: R4_PLAYER, settings: { ...R4_LOOSE, stability: 0.28, style: 0.7 }, model: R4_MODEL },
    ],
  },
  {
    id: "story-call-reply-r4",
    label: "County dispatcher, round 4",
    subgroup: "Radio-room call",
    intent: `an older dispatcher (Bill), tired 3 a.m. professional turning clipped and serious, a faster natural pace with real fluctuation in the voice, over a heavy AM-style radio: "${R4_REPLY}"`,
    takes: [
      { voice: "pqHfZKP75CvOlQylNhV4", name: "Bill", text: R4_REPLY, settings: { stability: 0.3, similarity_boost: 0.75, style: 0.5, use_speaker_boost: true, speed: 1.12 }, model: R4_MODEL, mode: "dispatch" },
      { voice: "pqHfZKP75CvOlQylNhV4", name: "Bill", text: R4_REPLY, settings: { stability: 0.2, similarity_boost: 0.75, style: 0.7, use_speaker_boost: true, speed: 1.08 }, model: R4_MODEL, mode: "dispatch" },
    ],
  },
  {
    id: "story-call-player-m",
    label: "Player radio report (male)",
    intent: `a calm but shaken adult male voice speaking through a radio handset, every word intelligible: "${PLAYER}"`,
    takes: [
      { voice: "iP95p4xoKVk53GoZ742B", name: "Chris", text: PLAYER_TAGGED, settings: { stability: 0.5 } },
      { voice: "cjVigY5qzO86Huf0OWal", name: "Eric", text: PLAYER_TAGGED, settings: { stability: 0.5 } },
    ],
  },
  {
    id: "story-call-player-f",
    label: "Player radio report (female)",
    intent: `a calm but shaken adult female voice speaking through a radio handset, every word intelligible: "${PLAYER}"`,
    takes: [
      { voice: "XrExE9yKIg1WjnnlVkGX", name: "Matilda", text: PLAYER_TAGGED, settings: { stability: 0.5 } },
      { voice: "EXAVITQu4vr4xnSDxMaL", name: "Sarah", text: PLAYER_TAGGED, settings: { stability: 0.5 } },
    ],
  },
  ...(
    [
      // Cast from the roster renders (captures/roster-*.png): distinct ages, timbres and energy, all shaken.
      ["remy", "Remy", "a young man (early 20s, casual)", "bIHbv24MWmeRgasZH58o", "Will", "TX3LPaxmHKxFdv7VOQHJ", "Liam"],
      ["james", "James", "a young man in a hoodie and cap (rougher, lower voice)", "SOYHLrjzK2X1ezoPC6cr", "Harry"],
      ["louise", "Louise", "a professional woman in her thirties or forties (suit)", "hpp4J3VqNfWAUOO0d1Us", "Bella", "pFZP5JQG7iQjIQuC4Bku", "Lily"],
      ["megan", "Megan", "a young woman in her early twenties (casual, bright)", "cgSgspJ2msm6clMCkdW9", "Jessica", "FGY2WhTYpPnrIDTdsKH5", "Laura"],
      ["kate", "Kate", "a woman in her late twenties or thirties (mature, steady)", "EXAVITQu4vr4xnSDxMaL", "Sarah"],
    ] as const
  ).map(([id, name, who, voice, vname, alt, altName]: readonly string[]) => ({
    id: `story-call-player-${id}`,
    label: `Player radio report — ${name}`,
    // One "Radio-room call" header for everything (Aiden found per-character headers overwhelming).
    subgroup: "Radio-room call",
    intent: `${who} speaking through a radio handset, shaken but holding it together (a breath or two, one restart, tightening on "dead", pleading at the end), realistic not acted, every word intelligible: "County, County, this is Ashwood Outpost, do you read? I'm up at the station and they're... they're all dead. Four of them. ${FINAL_LINE3[id]} Please, I need somebody out here."`,
    takes: [
      { voice, name: vname, text: PLAYER_TAGGED, settings: { stability: 0.5 } },
      { voice, name: vname, text: PLAYER_TAGGED_ALT, settings: { stability: 0.35 } },
      // Second casting where the first read too close to another character (Remy vs James, Louise vs Megan; Megan's
      // Laura takes read flat, so Megan keeps Jessica).
      ...(alt ? [{ voice: alt, name: altName!, text: PLAYER_TAGGED, settings: { stability: 0.5 } }, { voice: alt, name: altName!, text: PLAYER_TAGGED_ALT, settings: { stability: 0.35 } }] : []),
      // Round 3, in the shipped cast voice: the disfluent, breathing script, two takes. (Megan's v5–v6 went to
      // Laura by mistake; her cast voice is Jessica, v7–v8.)
      ...[0.5, 0].map((stability, i) => ({
        voice: id === "megan" ? alt! : (alt ?? voice),
        name: id === "megan" ? altName! : (altName ?? vname),
        text: SHAKEN[id]!,
        settings: { stability },
        variant: `v${(id === "kate" ? 4 : alt ? 5 : 3) + i}`,
      })),
      ...(id === "megan" ? [0.5, 0].map((stability, i) => ({ voice, name: vname, text: SHAKEN[id]!, settings: { stability }, variant: `v${7 + i}` })) : []),
      // Round 4: the owner's final script, in the cast voice.
      ...[0.5, 0].map((stability, i) => ({
        voice: id === "megan" ? voice : (alt ?? voice),
        name: id === "megan" ? vname : (altName ?? vname),
        text: finalScript(id),
        settings: { stability },
        // The final takes come out 14–18 s; dialogue-edit the dead air and, if still long, speed up (≤ 1.15×) so the
        // processed clip lands at ~11–12 s.
        fit: 11.2,
        variant: `v${({ remy: 7, james: 5, louise: 7, megan: 9, kate: 6 } as Record<string, number>)[id]! + i}`,
      })),
    ],
  })),
  {
    id: "story-call-reply",
    label: "County dispatcher reply",
    intent: `an older dispatcher, flat, procedural and authoritative, over a narrow crackling AM-style radio (squelch and key click at the start, roger beep or squelch tail at the end, carrier hiss, brief dropouts), tired 3 a.m. professional turning clipped and serious, a flat firm "Do not move", intelligible: "${REPLY_FINAL}"`,
    takes: [
      { voice: "pqHfZKP75CvOlQylNhV4", name: "Bill", text: REPLY_TAGGED, settings: { stability: 1 }, mode: "broken" },
      { voice: "pqHfZKP75CvOlQylNhV4", name: "Bill", text: REPLY_TAGGED, settings: { stability: 0.5 }, mode: "broken" },
      { voice: "pqHfZKP75CvOlQylNhV4", name: "Bill", text: REPLY_NEW_TAGGED, settings: { stability: 1 }, mode: "dispatch" },
      { voice: "pqHfZKP75CvOlQylNhV4", name: "Bill", text: REPLY_NEW_TAGGED, settings: { stability: 0.5 }, mode: "dispatch" },
      // Round 4: final copy (option 1b).
      { voice: "pqHfZKP75CvOlQylNhV4", name: "Bill", text: REPLY_FINAL_TAGGED, settings: { stability: 0.5 }, mode: "dispatch", variant: "v5" },
      { voice: "pqHfZKP75CvOlQylNhV4", name: "Bill", text: REPLY_FINAL_TAGGED, settings: { stability: 1 }, mode: "dispatch", variant: "v6" },
      // Round 5 (owner: "his voice sucks"): a tired small-town sheriff's dispatcher at 3 a.m., middle-aged, slightly
      // gravelly, unhurried and human. Library voices, eleven_multilingual_v2, plain text, no tags or edits.
      { voice: "8hmpa25DrgOJjzYgU64z", name: "Jay (library: Midwest, gravel, grounded)", text: REPLY_PLAIN, settings: { stability: 0.4, similarity_boost: 0.75, style: 0.35, use_speaker_boost: true }, model: "eleven_multilingual_v2", mode: "dispatch", variant: "v7", softEnd: true },
      { voice: "0l6EZBgVj5gBcvxdAQTR", name: "Joe Scott (library: deep, gravelly, authentic)", text: REPLY_PLAIN, settings: { stability: 0.4, similarity_boost: 0.75, style: 0.35, use_speaker_boost: true }, model: "eleven_multilingual_v2", mode: "dispatch", variant: "v8" },
    ],
  },
]

async function tts(voice: string, text: string, settings: Record<string, number | boolean>, model = MODEL) {
  const key = await elevenKey()
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, {
      method: "POST",
      headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: model, voice_settings: settings }),
    })
    if (res.ok) return { audio: await res.arrayBuffer(), cost: Number(res.headers.get("character-cost") ?? NaN) }
    const detail = (await res.text()).slice(0, 300)
    if (!(res.status === 429 || res.status >= 500) || attempt >= 4) throw new Error(`TTS ${res.status}: ${detail}`)
    await Bun.sleep(1500 * attempt)
  }
}

// ---- radio processing ----

/** Feed-forward compressor (dB domain, ~5 ms attack, ~80 ms release). */
function compress(x: D.Mono, thresholdDb: number, ratio: number, makeupDb: number): D.Mono {
  const y = new Float32Array(x.length)
  const a = Math.exp(-1 / (0.005 * D.SR))
  const r = Math.exp(-1 / (0.08 * D.SR))
  let env = 0
  for (let i = 0; i < x.length; i++) {
    const v = Math.abs(x[i]!)
    env = v > env ? a * env + (1 - a) * v : r * env + (1 - r) * v
    const db = 20 * Math.log10(env + 1e-9)
    const over = Math.max(0, db - thresholdDb)
    y[i] = x[i]! * 10 ** ((-over * (1 - 1 / ratio) + makeupDb) / 20)
  }
  return y
}

const band = (x: D.Mono) => D.filter(D.filter(D.filter(D.filter(x, "highpass", 300), "highpass", 300), "lowpass", 3000), "lowpass", 3000)

function staticBurst(s: number, r: D.Rng, crackle = 0.5): D.Mono {
  const n = D.noise(s, r)
  for (let i = 0; i < n.length; i++) if (r() < crackle * 0.004) n[i] = (r() < 0.5 ? -1 : 1) * (2 + r() * 3)
  return band(n)
}

/** Squelch tail: the carrier dropping, a short bright noise burst decaying in ~0.25 s. */
const squelch = (r: D.Rng) => D.envelope(D.filter(staticBurst(0.35, r, 1), "peak", 1800, 1, 6), [[0, 0], [0.005, 1], [0.06, 0.8], [0.35, 0]])
/** Key-up: a click and a short carrier burst. */
const keyUp = (r: D.Rng) => D.toMono(D.mix([{ x: D.tone(0.012, () => 1200, [[0, 1], [0.012, 0]]), gain: 0.5 }, { x: D.envelope(staticBurst(0.12, r), [[0, 0.8], [0.12, 0]]), gain: 0.5 }]))

/** Speech regions (RMS over 20 ms above a fraction of the peak RMS). */
function voiced(x: D.Mono) {
  const w = D.sec(0.02)
  const rms: number[] = []
  for (let i = 0; i + w <= x.length; i += w) {
    let s = 0
    for (let j = 0; j < w; j++) s += x[i + j]! ** 2
    rms.push(Math.sqrt(s / w))
  }
  const peak = Math.max(...rms)
  return rms.map((v) => v > peak * 0.08)
}

/** Heavier dispatcher treatment: narrow band, hard compression and saturation, AM crackle and flutter, carrier hiss,
 *  two brief dropouts, squelch burst and key click in, roger beep and squelch tail out. */
/** A quiet, crackle-free squelch tail: soft attack, short decay (no click or thump at the end of the clip). */
const softTail = (r: D.Rng) => D.envelope(D.filter(narrowNoise(0.32, r), "lowpass", 2400), [[0, 0], [0.03, 1], [0.1, 0.6], [0.32, 0]])
const narrowNoise = (s: number, r: D.Rng) => D.filter(D.filter(D.noise(s, r), "highpass", 400), "lowpass", 2800)

function dispatch(clean: D.Mono, r: D.Rng, k: number, softEnd = false): D.Mono {
  const narrow = (x: D.Mono) => D.filter(D.filter(D.filter(D.filter(x, "highpass", 400), "highpass", 400), "lowpass", 2800), "lowpass", 2800)
  let v = narrow(D.trim(clean, 50))
  v = compress(D.drive(D.peakNorm(v, 0.9), 4), -30, 8, 14)
  v = D.drive(v, 2)
  v = D.bitcrush(v, 9, 3, 0.35)
  // AM: slow flutter plus crackle ticks riding on the voice.
  const y = new Float32Array(v.length)
  for (let i = 0; i < v.length; i++) {
    const t = i / D.SR
    const flutter = 1 - 0.12 * (0.5 + 0.5 * Math.sin(2 * Math.PI * (3.1 + k) * t)) * (0.5 + 0.5 * Math.sin(2 * Math.PI * 0.7 * t))
    y[i] = v[i]! * flutter
    if (r() < 0.0009) y[i]! += (r() < 0.5 ? -1 : 1) * (0.3 + r() * 0.5)
  }
  // Two brief dropouts down to the carrier.
  for (let g = 0; g < 2; g++) {
    const i0 = Math.floor((0.2 + g * 0.4 + r() * 0.2) * y.length)
    const len = D.sec(0.05 + r() * 0.05)
    for (let i = 0; i < len && i0 + i < y.length; i++) y[i0 + i]! *= 0.05
  }
  v = narrow(y)
  const L = D.dur(v)
  const pre = 0.32
  const bedLen = L + pre + 0.6
  // With a soft end the beds fade out under the tail (crackle stops with the voice) so nothing pops at the very end.
  const fadeOut = (x: D.Mono, until: number) => (softEnd ? D.envelope(x, [[0, 1], [until - 0.35, 1], [until, 0]]) : x)
  const hiss = fadeOut(D.gain(narrow(D.noise(bedLen, r)), 0.06), bedLen - 0.05)
  const crackle = fadeOut(D.gain(staticBurst(bedLen, r, 1.5), 0.03), softEnd ? L + 0.05 : bedLen)
  const beep = D.toMono(D.mix([{ x: D.tone(0.09, () => 1200, [[0, 0], [0.005, 1], [0.085, 1], [0.09, 0]]) }, { x: D.tone(0.09, () => 1600, [[0, 0], [0.005, 1], [0.085, 1], [0.09, 0]]), at: 0.09 }]))
  return D.toMono(
    D.mix([
      { x: keyUp(r), at: 0, gain: 1.2 },
      { x: D.envelope(narrow(staticBurst(0.22, r, 2)), [[0, 1], [0.22, 0]]), at: 0.02, gain: 0.7 },
      { x: hiss, at: 0.05 },
      { x: crackle, at: 0.05 },
      { x: v, at: pre },
      ...(k === 0 && !softEnd ? [{ x: beep, at: pre + L + 0.08, gain: 0.25 }] : []),
      softEnd ? { x: softTail(r), at: pre + L + 0.05, gain: 0.12 } : { x: squelch(r), at: pre + L + (k === 0 ? 0.28 : 0.06), gain: 0.8 },
    ]),
  )
}

function radio(clean: D.Mono, r: D.Rng, broken: boolean): D.Mono {
  let v = band(D.trim(clean, 50))
  v = D.drive(D.peakNorm(v, 0.9), 2.2)
  // Stronger compression brings the breaths up through the band-pass.
  v = compress(v, broken ? -22 : -28, broken ? 4 : 5, broken ? 8 : 11)
  v = D.bitcrush(v, 11, 2, 0.4)
  if (broken) {
    // Dropouts: 3–4 short gaps inside words, filled with static; static bursts in the pauses between words.
    const on = voiced(v)
    const w = D.sec(0.02)
    const y = v.slice()
    const gaps = 3 + Math.floor(r() * 2)
    for (let g = 0; g < gaps; g++) {
      const i0 = Math.floor((0.1 + r() * 0.85) * y.length)
      const len = D.sec(0.06 + r() * 0.12)
      const burst = staticBurst(len / D.SR, r, 1)
      for (let i = 0; i < len && i0 + i < y.length; i++) y[i0 + i] = burst[i]! * 0.35
    }
    for (let k = 0; k < on.length; k++) {
      if (on[k]) continue
      // inside a pause: crackle at a level that comes and goes
      const burst = staticBurst(0.02, r, 2)
      const lvl = 0.06 + (r() < 0.25 ? 0.25 * r() : 0)
      for (let i = 0; i < w && k * w + i < y.length; i++) y[k * w + i]! += burst[i]! * lvl
    }
    v = y
  }
  const bed = D.gain(staticBurst(D.dur(v) + 0.4, r, broken ? 1 : 0.2), broken ? 0.05 : 0.02)
  const pre = broken ? 0.35 : 0.12
  const parts: D.Part[] = [
    { x: keyUp(r), at: 0 },
    { x: bed, at: 0.02 },
    { x: v, at: pre },
    { x: squelch(r), at: pre + D.dur(v) + 0.05, gain: 0.6 },
  ]
  if (broken) parts.push({ x: D.tone(D.dur(v) + 0.4, (t) => 1250 + 40 * Math.sin(t * 2.1), [[0, 0], [0.3, 1], [D.dur(v), 1], [D.dur(v) + 0.4, 0]]), gain: 0.012 })
  return D.toMono(D.mix(parts))
}

const mono2 = (x: D.Mono): D.Stereo => [x, x.slice()]

const processOnly = process.argv.includes("--process")
/** `--only story-call-reply/v7`: restrict the run (with --process: re-render just that take). */
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null
const m = await loadManifest()
const story = LINES.flatMap((l) => [
  { id: l.id, group: "story", subgroup: l.subgroup ?? "Radio-room call", label: `${l.label} — radio`, intent: l.intent, loop: false, designed: true as const },
  { id: `${l.id}-clean`, group: "story", subgroup: l.subgroup ?? "Radio-room call", label: `${l.label} — clean`, intent: l.intent.replace(/ through a radio handset| over a bad radio link, broken up by static and dropouts| over a narrow crackling AM-style radio \([^)]*\),/, ""), loop: false, designed: true as const },
])
// Shared lines (fallbacks, the dispatcher) first, then one sub-header per character.
const rank = (s?: string) => (s === "Radio-room call (round 4)" ? 0 : s === "Radio-room call" ? 1 : 2)
story.sort((a, b) => rank(a.subgroup) - rank(b.subgroup))
m.designedCategories = [...(m.designedCategories ?? []).filter((c) => c.group !== "story"), ...story]
let spent = 0
for (const line of LINES) {
  for (let k = 0; k < line.takes.length; k++) {
    const t = line.takes[k]!
    const variant = t.variant ?? `v${k + 1}`
    const cleanFile = `sfx/${line.id}-clean/${variant}.mp3`
    const radioFile = `sfx/${line.id}/${variant}.mp3`
    mkdirSync(join(ROOT, "sfx", `${line.id}-clean`), { recursive: true })
    const cleanCat = story.find((c) => c.id === `${line.id}-clean`)!
    // Archived takes (taken off the page) are never regenerated or re-processed.
    const gone = (f: string) => (m.archived ?? []).some((a) => a.archivedFrom === f)
    if (only && `${line.id}/${variant}` !== only) continue
    if (gone(radioFile) && (gone(cleanFile) || !m.sounds.some((s) => s.file === cleanFile))) continue
    if (!existsSync(join(ROOT, cleanFile)) && !gone(cleanFile)) {
      if (processOnly) continue
      const { audio, cost } = await tts(t.voice, t.text, t.settings, t.model)
      spent += Number.isFinite(cost) ? cost : 0
      m.totalCost += Number.isFinite(cost) ? cost : 0
      await Bun.write(join(ROOT, cleanFile), audio)
      const entry: ManifestSound = {
        category: `${line.id}-clean`, group: "story", variant, prompt: `TTS ${t.model ?? MODEL}, voice ${t.name}, settings ${JSON.stringify(t.settings)}: ${t.text}`,
        duration: null, influence: 0, loop: false, file: cleanFile, bytes: audio.byteLength, cost, generatedAt: new Date().toISOString(),
        designed: true, sources: [`elevenlabs-tts:${t.name}`],
      }
      await normaliseSound(ROOT, entry)
      const j = await judge(await Bun.file(join(ROOT, cleanFile)).arrayBuffer(), cleanCat.intent)
      entry.qa = { ...j, intent: cleanCat.intent, model: QA_MODEL, at: new Date().toISOString() }
      m.sounds = m.sounds.filter((s) => s.file !== cleanFile)
      m.sounds.push(entry)
      console.log(`${cleanFile} (${t.name}) ${cost} credits  QA ${j.score}/5  ${j.description.slice(0, 110)}`)
    }
    if (isApproved(line.id, variant)) continue
    if (!processOnly && existsSync(join(ROOT, radioFile)) && m.sounds.some((s) => s.file === radioFile)) continue
    // Process from the untouched TTS take.
    const raw = join(ROOT, cleanFile.replace(/^sfx\//, "sfx-raw/"))
    // The clean take may be archived off the page (sfx/_previous/<cat>/raw/…); render from the untouched TTS file.
    const archivedClean = (m.archived ?? []).find((a) => a.archivedFrom === cleanFile)
    const archivedRaw = archivedClean ? join(ROOT, archivedClean.file.replace(/\/([^/]+)$/, "/raw/$1")) : ""
    let clean = await D.load(existsSync(raw) ? raw : existsSync(join(ROOT, cleanFile)) ? join(ROOT, cleanFile) : existsSync(archivedRaw) ? archivedRaw : join(ROOT, archivedClean!.file))
    let edit = ""
    if (t.fit) {
      const before = D.dur(D.trim(clean, 50))
      clean = D.tightenPauses(D.trim(clean, 50), 0.28)
      const speed = Math.min(1.15, Math.max(1, D.dur(clean) / t.fit))
      clean = await D.tempo(clean, speed)
      edit = ` Dialogue edit: pauses over 0.28 s shortened, ${speed > 1.001 ? `sped up ${speed.toFixed(2)}×, ` : ""}${before.toFixed(1)} → ${D.dur(clean).toFixed(1)} s of speech.`
    }
    const mode: Mode = t.mode ?? (line.id === "story-call-reply" ? "broken" : "radio")
    const rr = D.rng(7 + k * 31 + line.id.length)
    const out = mode === "dispatch" ? dispatch(clean, rr, k % 2, t.softEnd) : radio(clean, rr, mode === "broken")
    await D.save(join(ROOT, radioFile), mono2(D.peakNorm(out, 0.89)))
    const entry: ManifestSound = {
      category: line.id, group: "story", variant,
      prompt:
        mode === "dispatch"
          ? `Dispatcher radio: ${cleanFile.replace("sfx/", "")} band-passed 400 Hz–2.8 kHz, saturated, compressed 8:1, crushed, AM flutter and crackle, carrier hiss, two dropouts, squelch burst and key click in, ${t.softEnd ? "a soft, quiet squelch tail out (no beep, no click)." : `${k % 2 === 0 ? "roger beep and " : ""}squelch tail out.`} Voice ${t.name}.`
          : `${mode === "broken" ? "Radio, broken up" : "Radio handset"}: ${cleanFile.replace("sfx/", "")} band-passed 300 Hz–3 kHz (24 dB/oct), driven, compressed${mode === "broken" ? " 4:1" : " 5:1 (breaths brought up)"}, light crush, key-up click, static bed and squelch tail${mode === "broken" ? ", dropouts and static bursts between words" : ""}. Voice ${t.name}.${edit} Script: ${t.text}`,
      duration: +(out.length / D.SR).toFixed(2), influence: 0, loop: false, file: radioFile, bytes: 0, cost: 0, generatedAt: new Date().toISOString(),
      designed: true, sources: [cleanFile.replace("sfx/", "")],
    }
    await normaliseSound(ROOT, entry)
    const j = await judge(await Bun.file(join(ROOT, radioFile)).arrayBuffer(), line.intent)
    entry.qa = { ...j, intent: line.intent, model: QA_MODEL, at: new Date().toISOString() }
    m.sounds = m.sounds.filter((s) => s.file !== radioFile)
    m.sounds.push(entry)
    console.log(`${radioFile}  QA ${j.score}/5  ${j.description.slice(0, 120)}`)
    await saveManifest(m)
  }
}
await saveManifest(m)
console.log(`TTS credits this run: ${spent}`)
