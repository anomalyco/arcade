import { airCutoff, clamp, distanceGain } from "./jet-math"
import type { Mixer } from "./mixer"

/** A place in listener space, or null: head-locked (your own cockpit). */
type At = { x: number; y: number; z: number } | null

/** Level against the engine (scripts/audio-demo.ts "launch": the shove under the engine's surge, the rush under it). */
const LEVEL = 0.4

/**
 * The catapult as one continuous, live sound that follows the stroke (shared/launch.ts): `launchStart` gives one strong
 * shove (a falling sub thump and a short dark burst: the shuttle and the steam taking the jet), then the steam and the
 * shuttle rush down the track, its low-pass opening and its level rising with `progress` (0..1 along the stroke), over a
 * low rumble of the shuttle on its track; `release` (launchEnd, off the bow) lets the rush go: it fades and darkens over
 * about a second. Placed at the jet (distance, air absorption, panning, a little reverb and water echo), or head-locked
 * and muffled in your own cockpit. Procedural throughout, so it can never drift from the stroke.
 */
export class CatapultVoice {
  done = false
  private ctx: BaseAudioContext
  private out: GainNode
  private air: BiquadFilterNode
  private panner: PannerNode | null = null
  private rush: { lp: BiquadFilterNode; gain: GainNode }
  private hiss: GainNode
  private rumble: GainNode
  private srcs: AudioScheduledSourceNode[] = []
  private released = 0

  constructor(
    private mixer: Mixer,
    at: At,
    /** Distance from the listener (m), 0 head-locked. */
    dist: number,
  ) {
    const ctx = (this.ctx = mixer.ctx!)
    const now = ctx.currentTime + 0.005
    const n = mixer.noise
    this.out = ctx.createGain()
    this.out.gain.value = LEVEL * (at ? distanceGain(dist, 50) : 1)
    this.air = ctx.createBiquadFilter()
    this.air.type = "lowpass"
    this.air.Q.value = 0.5
    this.air.frequency.value = at ? airCutoff(dist) : 1500
    this.out.connect(this.air)
    if (at) {
      const p = (this.panner = ctx.createPanner())
      p.panningModel = "HRTF"
      p.distanceModel = "linear"
      p.rolloffFactor = 0
      p.positionX.value = at.x
      p.positionY.value = at.y
      p.positionZ.value = at.z
      this.air.connect(p).connect(mixer.bus.sfx)
      const rv = ctx.createGain()
      rv.gain.value = 0.25
      this.air.connect(rv).connect(mixer.reverb)
      const ec = ctx.createGain()
      ec.gain.value = 0.15
      this.air.connect(ec).connect(mixer.echo)
    } else {
      this.air.connect(mixer.bus.sfx)
      const rm = ctx.createGain()
      rm.gain.value = 0.4
      this.air.connect(rm).connect(mixer.room)
    }
    const loop = (buf: AudioBuffer) => {
      const s = ctx.createBufferSource()
      s.buffer = buf
      s.loop = true
      s.start(now, Math.random() * 3)
      this.srcs.push(s)
      return s
    }
    const filter = (type: BiquadFilterType, f: number, q = 0.6) => {
      const b = ctx.createBiquadFilter()
      b.type = type
      b.frequency.value = f
      b.Q.value = q
      return b
    }
    const env = (g: number, attack: number) => {
      const e = ctx.createGain()
      e.gain.setValueAtTime(0.0001, now)
      e.gain.linearRampToValueAtTime(g, now + attack)
      return e
    }
    // The shove: a falling sub thump and a short dark burst.
    const sub = ctx.createOscillator()
    sub.frequency.setValueAtTime(62, now)
    sub.frequency.exponentialRampToValueAtTime(28, now + 0.9)
    const sg = ctx.createGain()
    sg.gain.setValueAtTime(0.0001, now)
    sg.gain.linearRampToValueAtTime(0.9, now + 0.008)
    sg.gain.exponentialRampToValueAtTime(0.0001, now + 1)
    sub.connect(sg).connect(this.out)
    sub.start(now)
    sub.stop(now + 1.05)
    const burst = ctx.createBufferSource()
    burst.buffer = n.brown
    const blp = filter("lowpass", 900)
    blp.frequency.setValueAtTime(900, now)
    blp.frequency.exponentialRampToValueAtTime(140, now + 0.7)
    const bg = ctx.createGain()
    bg.gain.setValueAtTime(0.0001, now)
    bg.gain.linearRampToValueAtTime(0.8, now + 0.006)
    bg.gain.exponentialRampToValueAtTime(0.0001, now + 0.75)
    burst.connect(blp).connect(bg).connect(this.out)
    burst.start(now, Math.random() * 3)
    burst.stop(now + 0.8)
    // The steam and shuttle rush, following the stroke.
    const rlp = filter("lowpass", 450, 0.5)
    const rhp = filter("highpass", 140, 0.5)
    const rg = env(0.12, 0.08)
    loop(n.pink).connect(rhp).connect(rlp).connect(rg).connect(this.out)
    this.rush = { lp: rlp, gain: rg }
    this.hiss = env(0.03, 0.15)
    loop(n.white).connect(filter("highpass", 2800, 0.5)).connect(this.hiss).connect(this.out)
    this.rumble = env(0.3, 0.1)
    loop(n.brown).connect(filter("lowpass", 110, 0.7)).connect(this.rumble).connect(this.out)
  }

  /** Per frame through the stroke: progress 0..1, and where the jet is now (listener space) and how far. */
  update(progress: number, at: At, dist: number): void {
    if (this.released) return
    const now = this.ctx.currentTime
    const p = clamp(progress, 0, 1)
    this.rush.lp.frequency.setTargetAtTime(450 + 3600 * p ** 0.8, now, 0.05)
    this.rush.gain.gain.setTargetAtTime(0.12 + 0.5 * p, now, 0.05)
    this.hiss.gain.setTargetAtTime(0.03 + 0.09 * p, now, 0.05)
    this.rumble.gain.setTargetAtTime(0.3 + 0.15 * p, now, 0.05)
    if (at && this.panner) {
      this.panner.positionX.setTargetAtTime(at.x, now, 0.02)
      this.panner.positionY.setTargetAtTime(at.y, now, 0.02)
      this.panner.positionZ.setTargetAtTime(at.z, now, 0.02)
      this.out.gain.setTargetAtTime(LEVEL * distanceGain(dist, 50), now, 0.05)
      this.air.frequency.setTargetAtTime(airCutoff(dist), now, 0.05)
    }
  }

  /** launchEnd: off the bow, the rush lets go (fades and darkens over about a second). */
  release(): void {
    if (this.released) return
    const now = this.ctx.currentTime
    this.released = now
    this.rush.lp.frequency.setTargetAtTime(500, now, 0.35)
    for (const g of [this.rush.gain, this.hiss, this.rumble]) g.gain.setTargetAtTime(0, now, g === this.rumble ? 0.12 : 0.3)
    for (const s of this.srcs) s.stop(now + 1.8)
  }

  /** Done once released and faded (the manager drops it). */
  tick(): void {
    if (this.released && this.ctx.currentTime > this.released + 1.8) this.done = true
  }
}
