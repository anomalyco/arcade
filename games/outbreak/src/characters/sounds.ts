import { holdAmbientSound, playAmbientSound, registerAmbientSound } from "../audio/soundscape/hooks"
import type { HabitKind } from "../../shared/characters/sites"

type At = { id: number; x: number; y: number }

/**
 * What the dead's habits sound like, through the soundscape's door for other features (AR-86 baked the habit cues):
 * a habit's beat plays its cue at the site, the bride and groom have the gramophone waltz while they dance, and a
 * jogger's earbuds still leak music a few metres out. Presentation only; levels live under Sound › Ambience.
 */
const BEAT_SOUND: Record<HabitKind, string | null> = {
  knock: "scape.habit.knock",
  stove: "scape.habit.pans",
  bed: "scape.habit.bedsprings",
  fence: "scape.habit.fence",
  bride: null,
  groom: null,
}

const EARBUDS = "characters.earbuds"
const MAX_EARBUDS = 3

registerAmbientSound({ id: EARBUDS, label: "Music leaking from a jogger's earbuds", bake: earbudLeak, loop: true, gain: 0.07, range: { ref: 0.4, max: 5 }, wet: 0.04 })

export function playCharacterBeat(beat: At & { kind: HabitKind }): void {
  const id = BEAT_SOUND[beat.kind]
  if (!id) return
  // The knock stays at its own pace (the hand is timed to it); the rest vary a little from house to house.
  const rate = beat.kind === "knock" ? 1 : 0.94 + ((beat.id * 37) % 13) / 100
  playAmbientSound(id, beat.x, beat.y, { rate })
}

/** Called once a frame with last frame's dancers and joggers, before the renderer refills them. */
export function holdCharacterSounds(frame: { dancing: readonly At[]; earbuds: readonly At[] }): void {
  if (frame.dancing.length) {
    let x = 0
    let y = 0
    for (const d of frame.dancing) {
      x += d.x
      y += d.y
    }
    holdAmbientSound("characters.waltz", "scape.habit.dance", x / frame.dancing.length, y / frame.dancing.length)
  }
  for (let i = 0; i < frame.earbuds.length && i < MAX_EARBUDS; i++) {
    const e = frame.earbuds[i]!
    holdAmbientSound(`characters.earbuds:${e.id}`, EARBUDS, e.x, e.y, 1, 0.97 + (e.id % 7) / 100)
  }
}

/**
 * A pop song heard from someone else's earbuds: a 7.5 s loop at 128 bpm, hats, a clicky kick and a square-wave hook,
 * with everything under ~900 Hz gone and the top rolled off, the way a tiny driver sounds from a step away.
 */
export function earbudLeak(sr: number): Float32Array {
  const beat = 60 / 128
  const out = new Float32Array(Math.round(sr * beat * 16))
  let noise = 0x9e3779b9
  const rnd = () => {
    noise ^= noise << 13
    noise ^= noise >>> 17
    noise ^= noise << 5
    return ((noise >>> 0) / 4294967296) * 2 - 1
  }
  const add = (t: number, len: number, f: (k: number, u: number) => number) => {
    const s = Math.round(t * sr)
    const n = Math.round(len * sr)
    for (let k = 0; k < n && s + k < out.length; k++) out[s + k]! += f(k, k / n)
  }
  // E minor pentatonic hook over two bars, eighth notes; 0 rests.
  const hook = [659, 0, 784, 659, 587, 0, 494, 587, 659, 0, 784, 880, 784, 0, 659, 0]
  for (let b = 0; b < 16; b++) {
    const t = b * beat
    add(t, 0.03, (_k, u) => Math.sin(u * 60) * (1 - u) * 0.5)
    for (const h of [0, 0.5]) add(t + h * beat, 0.025, (_k, u) => rnd() * (1 - u) ** 2 * 0.22)
    for (const h of [0, 0.5]) {
      const f = hook[(b * 2 + h * 2) % hook.length]!
      if (!f) continue
      add(t + h * beat, beat * 0.45, (k, u) => (Math.sin((2 * Math.PI * f * k) / sr) > 0 ? 0.3 : -0.3) * Math.min(1, u * 40) * (1 - u) ** 1.5)
    }
  }
  // Two one-pole high-passes at ~900 Hz, one low-pass at ~5 kHz.
  const hp = Math.exp((-2 * Math.PI * 900) / sr)
  const lp = 1 - Math.exp((-2 * Math.PI * 5000) / sr)
  let x1 = 0
  let y1 = 0
  let x2 = 0
  let y2 = 0
  let l = 0
  let peak = 0
  for (let i = 0; i < out.length; i++) {
    const x = out[i]!
    y1 = hp * (y1 + x - x1)
    x1 = x
    y2 = hp * (y2 + y1 - x2)
    x2 = y1
    l += lp * (y2 - l)
    out[i] = l
    peak = Math.max(peak, Math.abs(l))
  }
  if (peak > 0) for (let i = 0; i < out.length; i++) out[i]! *= 0.5 / peak
  return out
}
