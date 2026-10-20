import type { WorldContext, Lamp } from "../../world/context"
import { audio } from "../../audio/context"
import { hooks } from "../../audio/hooks"
import type { PlayOptions } from "../../audio/engine"
import type { SfxId } from "../../audio/sfx-manifest"
import { surfaceAt, type Surface } from "../../audio/surfaces"
import { storeyOf } from "./nav"

// Every sound the Wendigo makes, played where it actually is: positional (equal-power panner, inverse distance) and
// occluded like every other sound in the game (src/audio/engine.ts `walls`: each wall-height solid on the line takes
// 45% of the level and closes a low-pass; each storey slab counts 1.5), so it is heard through walls and from the floor
// above or below. Nothing here uses the engine's `range` cut-off (which silences anything a storey away). Sounds too
// faint to hear after distance and walls are skipped before any nodes are made. All on the horror bus.
//  - footsteps: the player's surface recordings (linoleum, the concrete stairwell, grating) pitched down ~25%, with a
//    low-shelf boost and a duller top, plus claws ticking on hard floors (procedural) when on all fours;
//  - breath: a ragged procedural inhale/exhale near the head (close range only); groans, chatter and the huge scream
//    from the approved monster takes (wen-distant-moan, wen2-starving-groan, wen2-chatter, wen2-huge-scream);
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

export class Voice {
  /** Automation: sounds played (and skipped as inaudible), with where they came from and the level at the ear. */
  readonly log: VoiceLog[] = []
  private noise: AudioBuffer | null = null
  private flick = new Map<Lamp, { base: number; until: number; off: boolean; next: number; sound: number }>()
  private lamps: Lamp[][] = []

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

  /** Level a sound would reach the ear with (distance rolloff × walls), and the walls counted. */
  private level(p: P, gain: number, ref: number, rolloff: number) {
    const sfx = hooks.sfx
    if (!sfx) return { g: 0, w: 0 }
    const e = sfx.ear
    const d = Math.hypot(p.x - e.x, p.y - e.y, p.z - e.z)
    const dist = ref / (ref + rolloff * Math.max(0, d - ref))
    const w = sfx.walls(p)
    return { g: gain * dist * 0.55 ** w, w }
  }

  /** A shipped one-shot at `p` (horror bus), unless it would be inaudible. */
  play(id: SfxId, p: P, o: Omit<PlayOptions, "bus" | "pos"> = {}) {
    const sfx = hooks.sfx
    const ref = o.ref ?? 2
    const roll = o.rolloff ?? 1
    const { g, w } = this.level(p, o.gain ?? 1, ref, roll)
    this.record(id, p, o.gain ?? 1, w, g)
    if (!sfx || g < FLOOR) return null
    return sfx.play(id, { ...o, bus: "horror", pos: { x: p.x, y: p.y, z: p.z }, ref, rolloff: roll })
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
  }

  /** Ragged breath near the head: an inhale then a long wet exhale (`fast` while hunting). */
  breath(p: P, fast: boolean) {
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
    if (kind === "scream") return this.play("wen2-huge-scream", p, { gain: 1.3 * gain, ref: 6, rolloff: 0.8, jitter: 0.03, lowBoost: 4 })
    if (kind === "chatter") return this.play("wen2-chatter", p, { gain: 0.9 * gain, ref: 2.5, rolloff: 1.1, jitter: 0.06 })
    if (kind === "moan") return this.play("wen-distant-moan", p, { gain: 0.9 * gain, ref: 4, rolloff: 0.9, jitter: 0.05 })
    return this.play("wen2-starving-groan", p, { gain: 0.8 * gain, ref: 3, rolloff: 1, jitter: 0.05, offset: Math.random() < 0.5 ? 0 : 2.5 })
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
      if (!st) this.flick.set(l, (st = { base: l.intensity, until: 0, off: false, next: now + Math.random() * 0.6, sound: 0 }))
      const k = Math.min(1, amount * (1 - d / 7) * 1.6)
      if (now >= st.next) {
        st.off = !st.off
        if (st.off) {
          st.until = now + 0.04 + Math.random() * 0.2 * k
          st.next = st.until
          if (now > st.sound && Math.random() < 0.35 * k) {
            st.sound = now + 5
            this.play("light-fluoro-flicker", { x: l.position[0], y: l.position[1], z: l.position[2] }, { gain: 0.35, ref: 1.5, rolloff: 1.2, jitter: 0.06 })
          }
        } else st.next = now + (0.15 + Math.random() * 1.6) / (0.3 + k)
      }
      l.intensity = st.base * (st.off ? 0.05 + 0.25 * (1 - k) : 1 - 0.15 * k * Math.random())
    }
    void dt
  }

  /** Restores every lamp it touched. */
  restoreLights() {
    for (const [l, st] of this.flick) l.intensity = st.base
    this.flick.clear()
  }

  // ----------------------------------------------------------------------------------------- the entry

  /** The far scream outside: distant, through the building's shell and floors (muffled, not occluded per wall). */
  farScream(p: P) {
    const sfx = hooks.sfx
    this.record("wen2-huge-scream:far", p, 1, 0, 1)
    sfx?.play("wen2-huge-scream", { bus: "horror", pos: p, ref: 25, rolloff: 0.7, gain: 0.9, lowpass: 1100, occlude: false, rate: 0.92, jitter: 0, lowBoost: 3 })
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
