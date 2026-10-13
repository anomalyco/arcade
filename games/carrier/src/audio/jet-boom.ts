import { clamp, smoothstep } from "./jet-math"
import type { Bus, Mixer } from "./mixer"
import { sfx } from "./sfx-bank"

/** Explosion scenarios, each a pooled slot of recorded takes (sfx-slots.ts "boom"). */
export type BoomKind = "air-kill" | "missile" | "bomb-water" | "bomb-land" | "crash-sea" | "crash-land"
export const BOOM_KINDS: readonly BoomKind[] = ["air-kill", "missile", "bomb-water", "bomb-land", "crash-sea", "crash-land"]

const SLOT: Readonly<Record<BoomKind, string>> = {
  "air-kill": "boom-air",
  missile: "boom-missile",
  "bomb-water": "boom-bomb-water",
  "bomb-land": "boom-bomb-land",
  "crash-sea": "boom-crash-sea",
  "crash-land": "boom-crash-land",
}
/** Close level per scenario (a missile airburst is smaller than a jet kill or a bomb). */
const LEVEL: Readonly<Record<BoomKind, number>> = { "air-kill": 1, missile: 0.75, "bomb-water": 1, "bomb-land": 1, "crash-sea": 0.95, "crash-land": 1 }

/** Distances (m): fully the close take inside NEAR, fully the distant rumble beyond FAR. */
const NEAR = 400
const FAR = 2200

/**
 * Cinematic explosions from the sound bank (sfx-bank.ts). Each event plays a random take of its scenario's pooled slot
 * (the user's 4-5★ takes, else any not rated down; never the same twice running), ±4% pitch and ±1.5 dB, through the
 * bank's spatial chain with a heavy reverb send and the water slapback: close ones punchy, then the close take fades
 * into a distant rumble (`boom-far`) between 400 m and 2.2 km, so far explosions are rolling thunder, not small bangs.
 * A bomb in the sea adds a water geyser a moment later. Everything arrives after the sound's travel time (≤ 3 s);
 * close blasts duck engines, flybys and ambience. Returns false until the slot has loaded (callers play their
 * procedural blasts).
 */
export class Booms {
  constructor(private mixer: Mixer) {}

  /** Takes decoded across the explosion slots. */
  get loaded(): number {
    const b = sfx(this.mixer)
    let n = 0
    for (const k of BOOM_KINDS) if (b.ready(SLOT[k])) n++
    return n
  }

  /**
   * An explosion of `kind` `dist` metres away (`size` scales it, 1 = nominal). `pan` (-1..1) places it left/right when
   * the caller knows; `delay` overrides the travel time.
   */
  play(kind: BoomKind, dist: number, size = 1, o: { bus?: Bus; pan?: number; delay?: number; gain?: number } = {}): boolean {
    const ctx = this.mixer.ctx
    const bank = sfx(this.mixer)
    const slot = SLOT[kind]
    if (!ctx || !bank.ready(slot)) return false
    const d = Math.max(1, dist)
    const delay = o.delay ?? Math.min(3, d / 343)
    const wFar = smoothstep(NEAR, FAR, d)
    const loud = clamp(0.75 + 0.25 * size, 0.6, 1.3) * (o.gain ?? 1) * 10 ** ((Math.random() * 2 - 1) * 0.075)
    const rate = 1 + (Math.random() * 2 - 1) * 0.04
    const pan = clamp(o.pan ?? 0, -1, 1)
    const local = { x: pan * d * 0.7, y: 0, z: -d * Math.sqrt(1 - Math.min(0.49, pan * pan * 0.49)) }
    const bus = o.bus ?? "weapons"
    const shot = { local, rate, delay, bus, ref: 90, rolloff: 0.9, reverb: 0.55, echo: 0.45 * (1 - wFar) }
    if (wFar < 0.98) bank.play(slot, { ...shot, gain: LEVEL[kind] * loud * (1 - wFar) })
    if (wFar > 0.02) bank.play("boom-far", { ...shot, ref: 300, rolloff: 0.7, reverb: 0.8, echo: 0, gain: 0.9 * loud * wFar })
    if (kind === "bomb-water" && d < 1500) bank.play("water-geyser", { ...shot, delay: delay + 0.35, gain: 0.8 * loud })
    const near = 1 - smoothstep(0, 1000, d)
    if (near > 0.2) this.mixer.duck(1 - 0.6 * near, 0.6 + 0.5 * size, delay)
    return true
  }
}

const shared = new WeakMap<Mixer, Booms>()
/** The explosion player for a mixer. */
export function boomsFor(mixer: Mixer): Booms {
  let b = shared.get(mixer)
  if (!b) shared.set(mixer, (b = new Booms(mixer)))
  return b
}
