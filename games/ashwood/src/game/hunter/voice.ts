import type { WorldContext, Lamp } from "../../world/context"
import { audio } from "../../audio/context"
import { hooks } from "../../audio/hooks"
import type { PlayOptions } from "../../audio/engine"
import type { Bus } from "../../audio/context"
import type { SfxId } from "../../audio/sfx-manifest"
import { surfaceAt, type Surface } from "../../audio/surfaces"
import { storeyOf } from "./nav"
import { storeyY } from "../../world/layout"

/**
 * The ventilation, as the hunter hears it (the building has no modelled ducts): a return-air grille in the spine's
 * ceiling at every bay centre on every storey, joined along the spine by its trunk duct and between storeys by the
 * riser in the service stack (x −45). A breath under one grille comes out of the others, duller and quieter the longer
 * the duct run.
 */
const GRILLES_X = Array.from({ length: 16 }, (_, i) => -50.5 + 5.4 * i)
const RISER_X = -45
const grilleY = (s: number) => storeyY(s) + 2.9

// Every sound the Wendigo makes, played where it actually is: positional (equal-power panner, inverse distance) and
// occluded like every other sound in the game (src/audio/engine.ts `walls`: each wall-height solid on the line takes
// 45% of the level and closes a low-pass; each storey slab counts 1.5), so it is heard through walls and from the floor
// above or below. Nothing here uses the engine's `range` cut-off (which silences anything a storey away). Sounds too
// faint to hear after distance and walls are skipped before any nodes are made. All on the horror bus.
//  - footsteps: the player's surface recordings (linoleum, the concrete stairwell, grating) pitched down ~25%, with a
//    low-shelf boost and a duller top, plus claws ticking on hard floors (procedural) when on all fours;
//  - breath: a ragged procedural inhale/exhale near the head (close range only); groans, chatter and the huge scream
//    from the approved monster takes in pools (SCREAM_POOL, DISTANT_POOL below; the starving groan, chatter and the
//    recorded panting close by);
//  - doors it opens, bashes or slams (the door recordings at the leaf); things it knocks over (metal, glass, a mop
//    bucket); light tubes stuttering as it passes (the fluorescent flicker take at the fixture).
// The building reacts too: lamps of its storey within ~7 m stutter (their real light), restored once it has gone.

type P = { x: number; y: number; z: number }

const STEP: Partial<Record<Surface, { id: SfxId; rate: number; gain: number; lowpass: number; claws: number }>> = {
  linoleum: { id: "foot-linoleum", rate: 0.74, gain: 1, lowpass: 3200, claws: 1 },
  tile: { id: "foot-linoleum", rate: 0.78, gain: 1, lowpass: 3800, claws: 1.1 },
  raised: { id: "foot-linoleum", rate: 0.76, gain: 1.1, lowpass: 3000, claws: 0.9 },
  wood: { id: "foot-linoleum", rate: 0.7, gain: 0.9, lowpass: 2600, claws: 0.7 },
  carpet: { id: "foot-linoleum", rate: 0.66, gain: 0.5, lowpass: 900, claws: 0 },
  concrete: { id: "foot-stairwell", rate: 0.76, gain: 1, lowpass: 3000, claws: 1.2 },
  metal: { id: "foot-grating", rate: 0.72, gain: 0.8, lowpass: 3500, claws: 1 },
  grating: { id: "foot-grating", rate: 0.74, gain: 0.85, lowpass: 3800, claws: 1 },
}

/** Level under which a positional sound isn't worth playing. */
const FLOOR = 0.002

export type VoiceLog = { t: number; id: string; x: number; y: number; z: number; gain: number; walls: number; heard: number }

// ------------------------------------------------------------------------------------------- the monster's pools
// The approved monster takes (audio-lab/ship-hunter.json; no voices: skin-call-far isn't shipped), in pools so the
// same one doesn't come round every time. Each pick avoids the last two of its pool (and another variant of the last)
// and prefers takes already decoded;
// every play varies pitch ±6% and level ±10%. `variant` is the index in the shipped manifest (picks order).

type Take = { id: SfxId; variant?: number; gain?: number; lowpass?: number }

/** The kill and attack scream (the hunter spotting you, the lift and road ambushes, every death). */
export const SCREAM_POOL: readonly Take[] = [
  { id: "wen2-huge-scream" },
  { id: "ban2-scream-tear", variant: 0 },
  { id: "ban2-scream-tear", variant: 1 },
  { id: "skin2-woman-fox" },
  { id: "skin-animal-human" },
  { id: "skin-cry-growl" },
]
/** Distant calls: losing a trail, now and then roaming (the keening wail always heavily muffled and quieter). */
export const DISTANT_POOL: readonly Take[] = [
  { id: "wen-distant-moan", variant: 0 },
  { id: "wen-distant-moan", variant: 1 },
  { id: "ban-keen-wail", variant: 0, gain: 0.6, lowpass: 1100 },
  { id: "ban-keen-wail", variant: 1, gain: 0.6, lowpass: 1100 },
  { id: "ban-keen-wail", variant: 2, gain: 0.6, lowpass: 1100 },
  { id: "skin2-howl-sob" },
  { id: "ban-scream-far", variant: 0 },
  { id: "ban-scream-far", variant: 1 },
]
const recent = new Map<readonly Take[], number[]>()

/** A take from `pool`: not one of the last two (nor the last one's sound), a decoded one when there is one. */
export function pickTake(pool: readonly Take[]): Take {
  const last = recent.get(pool) ?? []
  const prevId = last.length ? pool[last[last.length - 1]!]!.id : null
  // Not one of the last two takes, nor the same sound as the last (another variant of it).
  const fresh = pool.map((_, i) => i).filter((i) => !last.includes(i) && pool[i]!.id !== prevId)
  const ready = fresh.filter((i) => hooks.sfx?.ready(pool[i]!.id))
  const from = ready.length ? ready : fresh.length ? fresh : pool.map((_, i) => i)
  const i = from[Math.floor(Math.random() * from.length)]!
  recent.set(pool, [...last, i].slice(-2))
  return pool[i]!
}

/** Pitch ±6%, level ±10%: every play of a monster take is a little different. */
const vary = () => ({ rate: 0.94 + Math.random() * 0.12, gain: 0.9 + Math.random() * 0.2 })
const MONSTER = /^(wen|ban|skin)/

export type MonsterSoundOpts = { gain?: number; bus?: Bus; ref?: number; rolloff?: number; lowpass?: number; occlude?: boolean; lowBoost?: number }

/**
 * The creature's scream from the shared pool, at `pos` (positional, occluded) or, without one, in the listener's head
 * (a kill, an ambush on top of you). Horror bus. Returns the take played (null when audio is off or nothing decoded).
 */
export function playMonsterScream(pos?: { x: number; y: number; z: number }, o: MonsterSoundOpts = {}) {
  return playTake(SCREAM_POOL, pos, o)
}

/** A distant call from the shared pool (see DISTANT_POOL). */
export function playDistantCall(pos?: { x: number; y: number; z: number }, o: MonsterSoundOpts = {}) {
  return playTake(DISTANT_POOL, pos, o)
}

function playTake(pool: readonly Take[], pos: { x: number; y: number; z: number } | undefined, o: MonsterSoundOpts) {
  const sfx = hooks.sfx
  if (!sfx) return null
  const t = pickTake(pool)
  const v = vary()
  const lowpass = Math.min(o.lowpass ?? 20000, t.lowpass ?? 20000)
  const src = sfx.play(t.id, {
    bus: o.bus ?? "horror",
    variant: t.variant,
    gain: (o.gain ?? 1) * (t.gain ?? 1) * v.gain,
    rate: v.rate,
    jitter: 0,
    pos: pos ? { x: pos.x, y: pos.y, z: pos.z } : undefined,
    ref: o.ref,
    rolloff: o.rolloff,
    occlude: o.occlude,
    lowBoost: o.lowBoost,
    lowpass: lowpass < 19000 ? lowpass : undefined,
  })
  return src ? { id: t.id, variant: t.variant ?? 0, src } : null
}

/** Starts decoding every monster take now (long ones decode last in idle time otherwise, and a skipped one is silent). */
export function preloadMonsterSounds() {
  const ids = new Set<SfxId>([...SCREAM_POOL, ...DISTANT_POOL].map((t) => t.id))
  for (const id of ["wen2-starving-groan", "wen2-chatter", "skin2-breath-pant"] as const) ids.add(id)
  for (const id of ids) void hooks.sfx?.load(id)
}

/** Rotating choices: never the same as the last one. */
function rotate<T>(items: readonly T[], last: { i: number }) {
  let i = Math.floor(Math.random() * items.length)
  if (items.length > 1 && i === last.i) i = (i + 1 + Math.floor(Math.random() * (items.length - 1))) % items.length
  last.i = i
  return items[i]!
}

export class Voice {
  private lastVocal = { i: -1 }
  private lastGroanOffset = { i: -1 }
  /** Automation: sounds played (and skipped as inaudible), with where they came from and the level at the ear. */
  readonly log: VoiceLog[] = []
  private noise: AudioBuffer | null = null
  private flick = new Map<Lamp, { base: number; until: number; off: boolean; next: number; sound: number; buzz: number }>()
  private lamps: Lamp[][] = []
  /** No lamp sound (flicker take, buzz) from any lamp before this: one at a time, every few seconds at most. */
  private lampSoundAt = 0

  constructor(private ctx: WorldContext) {
    for (const l of ctx.lamps) {
      const m = /^interior:(\d)/.exec(l.zone ?? "")
      if (!m) continue
      const s = Number(m[1])
      ;(this.lamps[s] ??= []).push(l)
    }
  }

  private get ear() {
    return hooks.sfx?.ear ?? { x: 0, y: 0, z: 0 }
  }

  /**
   * Storey slabs the engine's wall count misses: it takes one slab per 3.2 m of height difference, so a sound at the
   * ceiling below (a lamp, its breath) heard from just above that slab counts none. The real count is the storey floors
   * strictly between the two heights; the shortfall (×1.5, as the engine weighs a slab) is extra occlusion.
   */
  private missedSlabs(p: P) {
    const e = this.ear
    const lo = Math.min(p.y, e.y)
    const hi = Math.max(p.y, e.y)
    let real = 0
    for (let k = 1; k <= 5; k++) if (storeyY(k) > lo + 0.05 && storeyY(k) < hi - 0.05) real++
    const engine = Math.min(3, Math.floor((hi - lo) / 3.2))
    return Math.max(0, real - engine) * 1.5
  }

  /** Level a sound would reach the ear with (distance rolloff × walls), and the walls counted (slabs corrected). */
  private level(p: P, gain: number, ref: number, rolloff: number) {
    const sfx = hooks.sfx
    if (!sfx) return { g: 0, w: 0, extra: 0 }
    const e = sfx.ear
    const d = Math.hypot(p.x - e.x, p.y - e.y, p.z - e.z)
    const dist = ref / (ref + rolloff * Math.max(0, d - ref))
    const extra = this.missedSlabs(p)
    const w = Math.min(5.5, sfx.walls(p) + extra)
    return { g: gain * dist * 0.55 ** w, w, extra }
  }

  /** A shipped one-shot at `p` (horror bus), unless it would be inaudible. */
  play(id: SfxId, p: P, o: Omit<PlayOptions, "bus" | "pos"> = {}) {
    const sfx = hooks.sfx
    const ref = o.ref ?? 2
    const roll = o.rolloff ?? 1
    const { g, w, extra } = this.level(p, o.gain ?? 1, ref, roll)
    this.record(id, p, o.gain ?? 1, w, g)
    if (!sfx || g < FLOOR) return null
    // Monster takes vary on every play (pitch ±6%, level ±10%).
    if (MONSTER.test(id)) {
      const v = vary()
      o = { ...o, rate: (o.rate ?? 1) * v.rate, gain: (o.gain ?? 1) * v.gain, jitter: 0 }
    }
    // The engine occludes by its own wall count; the slabs it missed are applied here (level and low-pass).
    const gain = (o.gain ?? 1) * 0.55 ** extra
    const lowpass = extra > 0 ? Math.min(o.lowpass ?? 20000, 18000 * 0.3 ** (w)) : o.lowpass
    return sfx.play(id, { ...o, gain, lowpass, bus: "horror", pos: { x: p.x, y: p.y, z: p.z }, ref, rolloff: roll })
  }

  private record(id: string, p: P, gain: number, walls: number, heard: number) {
    this.log.push({ t: +(performance.now() / 1000).toFixed(2), id, x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2), gain: +gain.toFixed(3), walls, heard: +heard.toFixed(4) })
    if (this.log.length > 400) this.log.splice(0, 100)
  }

  // ----------------------------------------------------------------------------------------- procedural sources

  private noiseBuffer(ac: AudioContext) {
    if (this.noise) return this.noise
    const n = ac.sampleRate * 2
    const b = ac.createBuffer(1, n, ac.sampleRate)
    const d = b.getChannelData(0)
    let brown = 0
    for (let i = 0; i < n; i++) {
      const w = Math.random() * 2 - 1
      brown = (brown + 0.02 * w) / 1.02
      d[i] = w * 0.6 + brown * 3
    }
    return (this.noise = b)
  }

  /** A procedural source at `p` through occlusion (low-pass and level), a panner and the horror bus. */
  private proc(id: string, p: P, gain: number, ref: number, rolloff: number, build: (ac: AudioContext, out: AudioNode, t: number) => number) {
    const a = audio()
    const sfx = hooks.sfx
    if (!a || !sfx) return
    const { g, w } = this.level(p, gain, ref, rolloff)
    this.record(id, p, gain, w, g)
    if (g < FLOOR) return
    const ac = a.ctx
    const lp = ac.createBiquadFilter()
    lp.type = "lowpass"
    lp.frequency.value = Math.max(220, 18000 * 0.3 ** w)
    const gn = ac.createGain()
    gn.gain.value = gain * 0.55 ** w
    const pn = ac.createPanner()
    pn.panningModel = "equalpower"
    pn.distanceModel = "inverse"
    pn.refDistance = ref
    pn.rolloffFactor = rolloff
    pn.maxDistance = 200
    pn.positionX.value = p.x
    pn.positionY.value = p.y
    pn.positionZ.value = p.z
    lp.connect(gn).connect(pn).connect(a.buses.horror)
    const end = build(ac, lp, ac.currentTime + 0.005)
    setTimeout(() => pn.disconnect(), (end - ac.currentTime + 0.5) * 1000)
  }

  /** Claw tips on a hard floor: two or three bright ticks. */
  private claws(p: P, k: number) {
    this.proc("claws", p, 0.22 * k, 1.5, 1.3, (ac, out, t) => {
      const n = 2 + (Math.random() < 0.5 ? 1 : 0)
      for (let i = 0; i < n; i++) {
        const at = t + i * (0.018 + Math.random() * 0.02)
        const src = ac.createBufferSource()
        src.buffer = this.noiseBuffer(ac)
        const bp = ac.createBiquadFilter()
        bp.type = "bandpass"
        bp.frequency.value = 2600 + Math.random() * 2200
        bp.Q.value = 6
        const g = ac.createGain()
        g.gain.setValueAtTime(0, at)
        g.gain.linearRampToValueAtTime(0.9 - i * 0.25, at + 0.002)
        g.gain.exponentialRampToValueAtTime(0.001, at + 0.03)
        src.connect(bp).connect(g).connect(out)
        src.start(at, Math.random() * 1.5, 0.05)
      }
      return t + 0.12
    })
  }

  /** One footfall at `p`: `weight` 0..1 (a slow upright step … a galloping forefoot), `claws` on all fours. */
  step(p: P, weight: number, onAllFours: boolean) {
    const surface = surfaceAt("floor", p.x, p.y, p.z)
    const v = STEP[surface] ?? STEP.concrete!
    this.play(v.id, p, {
      gain: (0.45 + 0.75 * weight) * v.gain,
      rate: v.rate * (1 - 0.06 * weight),
      jitter: 0.05,
      lowBoost: 7 + 5 * weight,
      lowpass: v.lowpass,
      ref: 2.2,
      rolloff: 1.1,
    })
    if (onAllFours && v.claws > 0) this.claws(p, v.claws * (0.6 + 0.6 * weight))
    // The weight of it: a low thump under each heavier footfall, the part that carries through a slab.
    if (weight > 0.35) this.thud(p, weight)
  }

  /** A body-weight thump on the floor (50–75 Hz): what is heard of its footfalls from the storey above or below. */
  private thud(p: P, weight: number) {
    this.proc("thud", p, 0.5 * weight, 2.5, 0.9, (ac, out, t) => {
      const o = ac.createOscillator()
      const f = 52 + Math.random() * 22
      o.frequency.setValueAtTime(f * 1.5, t)
      o.frequency.exponentialRampToValueAtTime(f, t + 0.08)
      const g = ac.createGain()
      g.gain.setValueAtTime(0, t)
      g.gain.linearRampToValueAtTime(1, t + 0.006)
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.22)
      o.connect(g).connect(out)
      o.start(t)
      o.stop(t + 0.25)
      return t + 0.3
    })
  }

  /** Ragged breath near the head: an inhale then a long wet exhale (`fast` while hunting). */
  breath(p: P, fast: boolean) {
    // Now and then the recorded panting instead of the procedural breath (close range only, like the breath).
    if (Math.random() < 0.3) {
      this.play("skin2-breath-pant", p, { gain: fast ? 0.55 : 0.4, ref: 1.2, rolloff: 1.5, offset: Math.random() * 1.5 })
      return
    }
    const dur = fast ? 0.9 : 2.2
    this.proc("breath", p, fast ? 0.32 : 0.2, 1.2, 1.6, (ac, out, t) => {
      for (const [at, len, f, peak] of [
        [t, dur * 0.4, fast ? 900 : 650, 0.6],
        [t + dur * 0.45, dur * 0.55, fast ? 520 : 380, 1],
      ] as const) {
        const src = ac.createBufferSource()
        src.buffer = this.noiseBuffer(ac)
        const bp = ac.createBiquadFilter()
        bp.type = "bandpass"
        bp.frequency.setValueAtTime(f, at)
        bp.frequency.linearRampToValueAtTime(f * 0.7, at + len)
        bp.Q.value = 1.4
        // A rattle in the throat: amplitude wobble.
        const trem = ac.createGain()
        const lfo = ac.createOscillator()
        lfo.frequency.value = 18 + Math.random() * 14
        const depth = ac.createGain()
        depth.gain.value = 0.45
        lfo.connect(depth).connect(trem.gain)
        trem.gain.value = 0.55
        const g = ac.createGain()
        g.gain.setValueAtTime(0, at)
        g.gain.linearRampToValueAtTime(peak, at + len * 0.3)
        g.gain.linearRampToValueAtTime(peak * 0.7, at + len * 0.8)
        g.gain.linearRampToValueAtTime(0, at + len)
        src.connect(bp).connect(trem).connect(g).connect(out)
        src.start(at, Math.random() * 1.2, len + 0.05)
        lfo.start(at)
        lfo.stop(at + len + 0.05)
      }
      return t + dur
    })
  }

  /** A vocalisation: "groan" (starving groan / distant moan), "chatter", "scream" (huge scream). */
  vocal(p: P, kind: "groan" | "moan" | "chatter" | "scream", gain = 1) {
    // Pitch wanders (0.86–1.08) so no two sound alike; the long groan starts at one of several points in the take.
    const rate = 0.86 + Math.random() * 0.22
    if (kind === "scream") {
      const t = pickTake(SCREAM_POOL)
      return this.play(t.id, p, { variant: t.variant, gain: 1.3 * gain * (t.gain ?? 1), ref: 6, rolloff: 0.8, lowBoost: 4 })
    }
    if (kind === "chatter") return this.play("wen2-chatter", p, { gain: 0.9 * gain, ref: 2.5, rolloff: 1.0, rate, jitter: 0.02 })
    if (kind === "moan") {
      // Distant calls carry: a long reference distance, light rolloff.
      const t = pickTake(DISTANT_POOL)
      return this.play(t.id, p, { variant: t.variant, gain: 0.9 * gain * (t.gain ?? 1), lowpass: t.lowpass, ref: 5, rolloff: 0.8 })
    }
    return this.play("wen2-starving-groan", p, { gain: 0.8 * gain, ref: 3, rolloff: 0.95, rate, jitter: 0.02, offset: rotate([0, 2.5, 5, 7.2], this.lastGroanOffset) })
  }

  /** A short wet snort / huff through the nose (procedural), close-range. */
  snort(p: P) {
    this.proc("snort", p, 0.45, 1.6, 1.3, (ac, out, t) => {
      const n = 1 + Math.floor(Math.random() * 3)
      for (let i = 0; i < n; i++) {
        const at = t + i * (0.16 + Math.random() * 0.1)
        const src = ac.createBufferSource()
        src.buffer = this.noiseBuffer(ac)
        const bp = ac.createBiquadFilter()
        bp.type = "bandpass"
        bp.frequency.value = 700 + Math.random() * 600
        bp.Q.value = 2
        const g = ac.createGain()
        g.gain.setValueAtTime(0, at)
        g.gain.linearRampToValueAtTime(1, at + 0.015)
        g.gain.exponentialRampToValueAtTime(0.001, at + 0.12 + Math.random() * 0.08)
        src.connect(bp).connect(g).connect(out)
        src.start(at, Math.random() * 1.5, 0.25)
      }
      return t + 0.8
    })
  }

  /** Claws or antler tips dragged along the wall it's passing (0.6–1.6 s, rougher the faster). */
  scrape(p: P, speed: number) {
    const len = 0.6 + Math.random() * 1.0
    this.proc("scrape", p, 0.4, 2, 1.0, (ac, out, t) => {
      const src = ac.createBufferSource()
      src.buffer = this.noiseBuffer(ac)
      const bp = ac.createBiquadFilter()
      bp.type = "bandpass"
      bp.frequency.setValueAtTime(1800 + Math.random() * 1500, t)
      bp.frequency.linearRampToValueAtTime(1200 + Math.random() * 900, t + len)
      bp.Q.value = 4
      // Stick-slip: a fast irregular grain on the level.
      const grain = ac.createGain()
      grain.gain.value = 0.5
      const lfo = ac.createOscillator()
      lfo.type = "square"
      lfo.frequency.value = 22 + speed * 9 + Math.random() * 10
      const depth = ac.createGain()
      depth.gain.value = 0.5
      lfo.connect(depth).connect(grain.gain)
      const g = ac.createGain()
      g.gain.setValueAtTime(0, t)
      g.gain.linearRampToValueAtTime(1, t + 0.05)
      g.gain.setValueAtTime(0.9, t + len * 0.7)
      g.gain.linearRampToValueAtTime(0, t + len)
      src.connect(bp).connect(grain).connect(g).connect(out)
      src.start(t, Math.random() * 1, len + 0.05)
      lfo.start(t)
      lfo.stop(t + len + 0.05)
      return t + len
    })
  }

  /** A door's hinges creaking as it is brushed (a slow stick-slip squeal). */
  creak(p: P) {
    const len = 0.9 + Math.random() * 1.1
    this.proc("creak", p, 0.35, 2, 1.0, (ac, out, t) => {
      const o = ac.createOscillator()
      o.type = "sawtooth"
      const f = 9 + Math.random() * 7
      o.frequency.setValueAtTime(f, t)
      o.frequency.linearRampToValueAtTime(f * (1.6 + Math.random()), t + len)
      const bp = ac.createBiquadFilter()
      bp.type = "bandpass"
      bp.frequency.value = 900 + Math.random() * 700
      bp.Q.value = 8
      const g = ac.createGain()
      g.gain.setValueAtTime(0, t)
      g.gain.linearRampToValueAtTime(1, t + 0.1)
      g.gain.linearRampToValueAtTime(0.6, t + len * 0.8)
      g.gain.linearRampToValueAtTime(0, t + len)
      o.connect(bp).connect(g).connect(out)
      o.start(t)
      o.stop(t + len + 0.05)
      return t + len
    })
  }

  /**
   * Breath into the ventilation: under a spine return grille (within 3 m) its breath also comes out of the grille
   * nearest the listener, carried along the trunk duct and the riser (hollow, band-limited, fading with the run;
   * silent past 40 m of duct or when the listener is not within 9 m of a grille). Away from a grille, just its breath.
   */
  duct(head: P, quiet: boolean) {
    this.breath(head, false)
    const s = storeyOf(head.y - 2)
    const gx = GRILLES_X.reduce((a, x) => (Math.abs(x - head.x) < Math.abs(a - head.x) ? x : a))
    if (Math.hypot(gx - head.x, head.z) > 3) return
    const ear = this.ear
    const es = storeyOf(ear.y - 1.6)
    const ex = GRILLES_X.reduce((a, x) => (Math.abs(x - ear.x) < Math.abs(a - ear.x) ? x : a))
    if (Math.hypot(ex - ear.x, ear.z) > 9) return
    const run = s === es ? Math.abs(gx - ex) : Math.abs(gx - RISER_X) + Math.abs(ex - RISER_X) + 3.8 * Math.abs(s - es)
    if (run > 40 || (s === es && Math.abs(gx - ex) < 1)) return
    const k = (1 - run / 40) * (quiet ? 0.5 : 1)
    const at = { x: ex, y: grilleY(es), z: 0 }
    this.proc("duct-breath", at, 0.5 * k, 1.5, 1.2, (ac, out, t) => {
      const dur = 2.4
      const src = ac.createBufferSource()
      src.buffer = this.noiseBuffer(ac)
      const bp = ac.createBiquadFilter()
      bp.type = "bandpass"
      bp.frequency.value = 380 + Math.random() * 120
      bp.Q.value = 3
      // The duct's tube resonance: a short feedback delay.
      const dl = ac.createDelay(0.05)
      dl.delayTime.value = 0.011 + Math.random() * 0.006
      const fb = ac.createGain()
      fb.gain.value = 0.55
      const g = ac.createGain()
      g.gain.setValueAtTime(0, t)
      g.gain.linearRampToValueAtTime(0.7, t + dur * 0.35)
      g.gain.linearRampToValueAtTime(1, t + dur * 0.55)
      g.gain.linearRampToValueAtTime(0, t + dur)
      src.connect(bp).connect(g)
      g.connect(out)
      g.connect(dl).connect(fb).connect(dl)
      fb.connect(out)
      src.start(t, Math.random() * 1, dur + 0.05)
      return t + dur + 0.3
    })
  }

  /** A door it moves: "open" (eased, the latch and leaf), "bash" (shouldered open), "slam" (shut hard), "close". */
  door(p: P, sound: string, kind: "open" | "bash" | "slam" | "close") {
    if (kind === "bash" || kind === "slam") {
      this.play("door-fire-steel", p, { gain: kind === "bash" ? 1.4 : 1.2, rate: sound === "wood" ? 0.95 : 0.82, lowBoost: 9, ref: 3, rolloff: 0.9 })
      this.play("hor-metal-bang", p, { gain: sound === "glass" ? 0.25 : 0.45, rate: 1.4, lowpass: 2500, ref: 3, rolloff: 1 })
      if (sound === "glass") this.play("int-lab-glass", p, { gain: 0.7, rate: 0.8, ref: 3 })
      return
    }
    if (kind === "close") return this.play("door-fire-steel", p, { gain: 0.6, rate: 0.95, ref: 2, rolloff: 1.1 })
    if (sound === "wood") this.play("door-office-wood", p, { gain: 0.85, rate: 0.92, ref: 2, rolloff: 1.1 })
    else if (sound === "glass") this.play("door-panic-bar", p, { gain: 0.6, rate: 0.95, ref: 2, rolloff: 1.1 })
    else this.play("door-panic-bar", p, { gain: 0.5, rate: 0.8, ref: 2, rolloff: 1.1, lowpass: 5000 })
  }

  /** Something it knocks over: metal (chairs, bins), glass (labs), or a mop bucket. */
  knock(p: P) {
    const s = storeyOf(p.y)
    const r = Math.random()
    if (s === 2 && r < 0.5) this.play("int-lab-glass", p, { gain: 1, rate: 0.9 + Math.random() * 0.2, ref: 2.5 })
    else if (r < 0.3) this.play("int-mop-bucket", p, { gain: 0.9, rate: 0.85, ref: 2.5, lowBoost: 4 })
    else this.play("hor-metal-bang", p, { gain: 0.55, rate: 1.5 + Math.random() * 0.4, lowpass: 4000, ref: 2.5, rolloff: 1 })
  }

  /**
   * Per frame: lamps of the creature's storey within ~7 m stutter (dropping out for 40–250 ms, more often the nearer
   * it is), with the tube's flicker at the fixture now and then; lamps it has left are restored.
   */
  lights(p: P, dt: number, amount: number, now: number) {
    const s = storeyOf(p.y)
    const near = this.lamps[s] ?? []
    for (const [l, st] of this.flick) {
      const d = Math.hypot(l.position[0] - p.x, l.position[2] - p.z)
      if (d > 9 || amount <= 0 || storeyOf(l.position[1] - 2) !== s) {
        l.intensity = st.base
        this.flick.delete(l)
      }
    }
    if (amount <= 0) return
    for (const l of near) {
      if (l.kind === "exit" || l.kind === "warning") continue
      const d = Math.hypot(l.position[0] - p.x, l.position[2] - p.z)
      if (d > 7) continue
      let st = this.flick.get(l)
      if (!st) this.flick.set(l, (st = { base: l.intensity, until: 0, off: false, next: now + Math.random() * 0.6, sound: 0, buzz: 0 }))
      const k = Math.min(1, amount * (1 - d / 7) * 1.6)
      if (now >= st.next) {
        st.off = !st.off
        if (st.off) {
          st.until = now + 0.04 + Math.random() * 0.2 * k
          st.next = st.until
          if (now > st.sound && now > this.lampSoundAt && Math.random() < 0.35 * k) {
            st.sound = now + 6
            this.lampSoundAt = now + 2.5 + Math.random() * 2
            this.play("light-fluoro-flicker", { x: l.position[0], y: l.position[1], z: l.position[2] }, { gain: 0.35, ref: 1.5, rolloff: 1.2, jitter: 0.06 })
          }
        } else {
          st.next = now + (0.15 + Math.random() * 1.6) / (0.3 + k)
          // The tube restriking: a short electrical buzz at the fixture.
          if (now > st.buzz && now > this.lampSoundAt && Math.random() < 0.4 * k) {
            st.buzz = now + 4
            this.lampSoundAt = now + 2.5 + Math.random() * 2
            this.buzz({ x: l.position[0], y: l.position[1], z: l.position[2] })
          }
        }
      }
      l.intensity = st.base * (st.off ? 0.05 + 0.25 * (1 - k) : 1 - 0.15 * k * Math.random())
    }
    void dt
  }

  /** A fluorescent tube's ballast buzzing as it restrikes (120 Hz and its harmonics, 0.15–0.4 s). */
  private buzz(p: P) {
    const len = 0.15 + Math.random() * 0.25
    this.proc("tube-buzz", p, 0.12, 1.2, 1.3, (ac, out, t) => {
      const o = ac.createOscillator()
      o.type = "sawtooth"
      o.frequency.value = 120
      const hp = ac.createBiquadFilter()
      hp.type = "highpass"
      hp.frequency.value = 400
      const g = ac.createGain()
      g.gain.setValueAtTime(0, t)
      g.gain.linearRampToValueAtTime(1, t + 0.01)
      g.gain.setValueAtTime(1, t + len - 0.03)
      g.gain.linearRampToValueAtTime(0, t + len)
      o.connect(hp).connect(g).connect(out)
      o.start(t)
      o.stop(t + len + 0.02)
      return t + len
    })
  }

  /** Restores every lamp it touched. */
  restoreLights() {
    for (const [l, st] of this.flick) l.intensity = st.base
    this.flick.clear()
  }

  // ----------------------------------------------------------------------------------------- the entry

  /**
   * The far scream outside, by the car: heard through the building exactly as the car's crunches and alarm are
   * (audio/story.ts: not occluded per wall, one 1500 Hz low-pass, the same reference distance), so the scream and the
   * wreck read as one place outside, not one far off and one close by.
   */
  farScream(p: P) {
    const t = playMonsterScream(p, { ref: 30, rolloff: 0.5, gain: 1.0, lowpass: 1500, occlude: false, lowBoost: 3 })
    this.record(`${t?.id ?? "scream"}:far`, p, 1, 0, 1)
  }

  /** The lobby's glass breaking: a heavy impact, the shatter and glass raining down. */
  glass(p: P) {
    this.play("hor-metal-bang", p, { gain: 0.9, rate: 1.25, lowBoost: 6, lowpass: 3000, ref: 4, rolloff: 0.8 })
    this.play("int-lab-glass", p, { gain: 1.6, rate: 0.62, ref: 4, rolloff: 0.8, jitter: 0 })
    this.proc("shatter", p, 0.9, 4, 0.8, (ac, out, t) => {
      for (let i = 0; i < 26; i++) {
        const at = t + 0.02 + Math.pow(Math.random(), 1.6) * 1.6
        const src = ac.createBufferSource()
        src.buffer = this.noiseBuffer(ac)
        const hp = ac.createBiquadFilter()
        hp.type = "bandpass"
        hp.frequency.value = 3000 + Math.random() * 5000
        hp.Q.value = 3 + Math.random() * 6
        const g = ac.createGain()
        const peak = (i < 4 ? 1 : 0.25 + Math.random() * 0.5) * 0.8
        g.gain.setValueAtTime(0, at)
        g.gain.linearRampToValueAtTime(peak, at + 0.003)
        g.gain.exponentialRampToValueAtTime(0.001, at + 0.05 + Math.random() * 0.25)
        src.connect(hp).connect(g).connect(out)
        src.start(at, Math.random() * 1.5, 0.4)
      }
      return t + 2
    })
    void this.ctx
  }
}
