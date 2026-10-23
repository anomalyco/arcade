import { type BoomKind, boomsFor } from "./jet-boom"
import { airCutoff, clamp, distanceGain, dopplerRatio, smoothstep } from "./jet-math"
import { mixer } from "./mixer"
import { type LoopHandle, sfx } from "./sfx-bank"

/** A SAM in flight as its motor voice needs it: a unique key, where it is and how fast, and whether the motor burns. */
export type SamSound = { key: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; burning: boolean }

/** One SAM's motor: the recorded `missile-motor` loop, or a procedural roar until it loads. */
type Motor = { key: number; loop: LoopHandle | null; proc: { src: AudioBufferSourceNode; lp: BiquadFilterNode; g: GainNode; pan: StereoPannerNode } | null; level: number; seen: boolean }

/** SAM motors heard at once (the nearest). */
const MOTORS = 3

/**
 * Ship gunnery sounds, procedural (no new assets), on the mixer's `weapons` bus:
 * - CIWS: the Phalanx "brrrt" in layers: a 75 Hz pulse train (the rate of fire) clipped and band-passed, a crack of noise
 *   chopped at the same rate, a low brown-noise body, and the drum's spin whine gliding up before and down after a
 *   burst. Other CIWS are a duller, distant version of the same voice (low-passed, level from the loudest one).
 * - SAM: the seeker's tone on the dry UI bus (beeps that quicken and rise while it tracks, one solid tone on lock, a
 *   chirp as it locks); the launch is the recorded `sam-launch` take (a procedural ignition and whoosh until it loads);
 *   each SAM in flight carries its own motor roar (the `missile-motor` loop, placed in the world with Doppler, the
 *   nearest three), falling to a wind rush once it burns out; a SAM's proximity burst is the big air-kill take with a
 *   sharp fragment crack, distinct from the 5-inch's flak pop.
 * - 5-inch gun: a heavy shot (a sub drop, a brown blast, a sharp crack, a rolling tail), duller and later with distance.
 * - Shell and SAM bursts and intercepts use the recorded explosion takes (src/audio/jet-boom.ts): a shell into the sea is a
 *   small `bomb-water`, on land or a hull a small `bomb-land`, in the air a `missile`. Procedural blasts until they load.
 * Close shots duck engines, flybys and weather. Distances are metres from the listener.
 */
export class TurretAudio {
  private ctx: BaseAudioContext | null = null
  private out!: GainNode
  private ciws!: GainNode
  private ciwsFar!: GainNode
  private ciwsFarLp!: BiquadFilterNode
  private whine!: OscillatorNode
  private whineGain!: GainNode
  private seekGain!: GainNode
  private seekOsc!: OscillatorNode
  private firing = false
  private spin = 0
  private duckIn = 0
  private seek: 0 | 1 | 2 = 0
  private beep = 0
  private motors: Motor[] = []
  private near: SamSound[] = []
  volume = 0.9

  constructor() {
    mixer().onStart((ctx) => this.build(ctx))
  }

  private build(ctx: BaseAudioContext): void {
    if (this.ctx) return
    this.ctx = ctx
    const m = mixer()
    this.out = ctx.createGain()
    this.out.gain.value = this.volume
    this.out.connect(m.bus.weapons)

    // CIWS: everything keyed to one 75 Hz clock.
    const clock = ctx.createOscillator()
    clock.type = "sawtooth"
    clock.frequency.value = 75
    const shaper = ctx.createWaveShaper()
    const curve = new Float32Array(1024)
    for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh(((i / (curve.length - 1)) * 2 - 1) * 7)
    shaper.curve = curve
    const body = ctx.createBiquadFilter()
    body.type = "bandpass"
    body.frequency.value = 260
    body.Q.value = 0.7
    const buzz = ctx.createGain()
    buzz.gain.value = 0.9
    clock.connect(shaper).connect(body).connect(buzz)
    // Crack: white noise gated by a 75 Hz square (each round's report).
    const gate = ctx.createOscillator()
    gate.type = "square"
    gate.frequency.value = 75
    const gateDepth = ctx.createGain()
    gateDepth.gain.value = 0.5
    const crackAmp = ctx.createGain()
    crackAmp.gain.value = 0.5
    gate.connect(gateDepth).connect(crackAmp.gain)
    const crackSrc = this.loop(m.noise.white)
    const crackHp = ctx.createBiquadFilter()
    crackHp.type = "highpass"
    crackHp.frequency.value = 1400
    crackSrc.connect(crackHp).connect(crackAmp)
    const crackLevel = ctx.createGain()
    crackLevel.gain.value = 0.35
    crackAmp.connect(crackLevel)
    // Low body.
    const rumble = this.loop(m.noise.brown)
    const rumbleLp = ctx.createBiquadFilter()
    rumbleLp.type = "lowpass"
    rumbleLp.frequency.value = 170
    const rumbleLevel = ctx.createGain()
    rumbleLevel.gain.value = 0.9
    rumble.connect(rumbleLp).connect(rumbleLevel)
    this.ciws = ctx.createGain()
    this.ciws.gain.value = 0
    buzz.connect(this.ciws)
    crackLevel.connect(this.ciws)
    rumbleLevel.connect(this.ciws)
    this.ciws.connect(this.out)
    // Distant CIWS: the buzz and body, low-passed.
    this.ciwsFarLp = ctx.createBiquadFilter()
    this.ciwsFarLp.type = "lowpass"
    this.ciwsFarLp.frequency.value = 700
    this.ciwsFar = ctx.createGain()
    this.ciwsFar.gain.value = 0
    buzz.connect(this.ciwsFarLp)
    rumbleLevel.connect(this.ciwsFarLp)
    this.ciwsFarLp.connect(this.ciwsFar).connect(this.out)
    clock.start()
    gate.start()
    // Drum spin whine.
    this.whine = ctx.createOscillator()
    this.whine.type = "triangle"
    this.whine.frequency.value = 700
    this.whineGain = ctx.createGain()
    this.whineGain.gain.value = 0
    this.whine.connect(this.whineGain).connect(this.out)
    this.whine.start()

    // SAM seeker tone on the dry UI bus, like the cockpit's: beeps while it tracks, a solid tone on lock.
    this.seekOsc = ctx.createOscillator()
    this.seekOsc.type = "triangle"
    this.seekOsc.frequency.value = 600
    this.seekGain = ctx.createGain()
    this.seekGain.gain.value = 0
    const seekLp = ctx.createBiquadFilter()
    seekLp.type = "lowpass"
    seekLp.frequency.value = 3600
    this.seekOsc.connect(this.seekGain).connect(seekLp).connect(m.bus.ui)
    this.seekOsc.start()
  }

  private loop(buf: AudioBuffer): AudioBufferSourceNode {
    const s = this.ctx!.createBufferSource()
    s.buffer = buf
    s.loop = true
    s.start(0, Math.random() * 1.5)
    return s
  }

  /** A filtered noise burst with an envelope (`f0` → `f1` over its length). */
  private burst(buf: AudioBuffer, type: BiquadFilterType, f0: number, f1: number, gain: number, attack: number, length: number, delay = 0): void {
    const ctx = this.ctx
    if (!ctx || gain < 0.002) return
    const at = ctx.currentTime + delay
    const src = ctx.createBufferSource()
    src.buffer = buf
    const f = ctx.createBiquadFilter()
    f.type = type
    f.frequency.setValueAtTime(f0, at)
    f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), at + length)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, at)
    g.gain.linearRampToValueAtTime(gain, at + attack)
    g.gain.exponentialRampToValueAtTime(0.0001, at + length)
    src.connect(f).connect(g).connect(this.out)
    src.start(at, Math.random())
    src.stop(at + length + 0.05)
  }

  /** A sine sweep (a thump). */
  private thump(f0: number, f1: number, gain: number, length: number, delay = 0): void {
    const ctx = this.ctx
    if (!ctx || gain < 0.002) return
    const at = ctx.currentTime + delay
    const o = ctx.createOscillator()
    o.frequency.setValueAtTime(f0, at)
    o.frequency.exponentialRampToValueAtTime(f1, at + length)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, at)
    g.gain.linearRampToValueAtTime(gain, at + 0.006)
    g.gain.exponentialRampToValueAtTime(0.0001, at + length)
    o.connect(g).connect(this.out)
    o.start(at)
    o.stop(at + length + 0.05)
  }

  /** A plain sine note on the UI bus (the lock chirp). */
  private note(f: number, gain: number, length: number, delay = 0): void {
    const ctx = this.ctx
    if (!ctx) return
    const at = ctx.currentTime + delay
    const o = ctx.createOscillator()
    o.frequency.value = f
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, at)
    g.gain.linearRampToValueAtTime(gain, at + 0.004)
    g.gain.exponentialRampToValueAtTime(0.0001, at + length)
    o.connect(g).connect(mixer().bus.ui)
    o.start(at)
    o.stop(at + length + 0.05)
  }

  /**
   * Per frame: our CIWS firing, the loudest other CIWS (0..1 after distance), the SAM seeker (0 off, 1 tracking, 2
   * locked) and how far its lock has built (0..1).
   */
  update(dt: number, ciws: boolean, farCiws: number, seek: 0 | 1 | 2, progress = 0): void {
    const ctx = this.ctx
    if (!ctx) return
    const now = ctx.currentTime
    this.out.gain.setTargetAtTime(this.volume, now, 0.1)
    if (ciws !== this.firing) {
      this.firing = ciws
      this.ciws.gain.setTargetAtTime(ciws ? 0.55 : 0, now, ciws ? 0.004 : 0.03)
    }
    // The drum spins up while firing and winds down after.
    this.spin = clamp(this.spin + (ciws ? dt / 0.25 : -dt / 1.4), 0, 1)
    this.whine.frequency.setTargetAtTime(500 + 1100 * this.spin, now, 0.05)
    this.whineGain.gain.setTargetAtTime(this.spin > 0.01 ? 0.035 * Math.min(1, this.spin * 3) : 0, now, 0.08)
    this.ciwsFar.gain.setTargetAtTime(farCiws * 0.35, now, 0.03)
    this.ciwsFarLp.frequency.setTargetAtTime(400 + 900 * farCiws, now, 0.05)
    if (ciws) {
      this.duckIn -= dt
      if (this.duckIn <= 0) {
        this.duckIn = 0.3
        mixer().duck(0.7, 0.4)
      }
    }
    // Tracking: beeps that quicken (5 → 14 Hz) and rise (600 → 1,100 Hz) as the lock builds; locked: one solid tone,
    // announced by a quick rising chirp.
    if (seek === 2 && this.seek !== 2) {
      this.note(1320, 0.05, 0.07)
      this.note(1760, 0.05, 0.12, 0.06)
    }
    if (seek === 1) {
      const p = clamp(progress, 0, 1)
      this.beep += dt * (5 + 9 * p)
      const on = this.beep % 1 < 0.5
      this.seekOsc.frequency.setTargetAtTime(600 + 500 * p, now, 0.01)
      this.seekGain.gain.setTargetAtTime(on ? 0.05 : 0, now, 0.006)
    } else if (seek === 2) {
      this.seekOsc.frequency.setTargetAtTime(1250, now, 0.01)
      this.seekGain.gain.setTargetAtTime(0.06, now, 0.02)
    } else {
      this.beep = 0
      this.seekGain.gain.setTargetAtTime(0, now, 0.02)
    }
    this.seek = seek
  }

  /**
   * Per frame: every live SAM. The nearest few carry a motor voice placed where they are, pitched by Doppler, a roar
   * while the motor burns that falls to a thin rush as it coasts; the rest fall silent.
   */
  samMotors(list: readonly SamSound[]): void {
    const ctx = this.ctx
    if (!ctx) return
    const L = mixer().listener
    const near = this.near
    near.length = 0
    for (const s of list) near.push(s)
    const d2 = (s: SamSound) => (s.x - L.eye[0]) ** 2 + (s.y - L.eye[1]) ** 2 + (s.z - L.eye[2]) ** 2
    if (near.length > MOTORS) {
      near.sort((a, b) => d2(a) - d2(b))
      near.length = MOTORS
    }
    for (const m of this.motors) m.seen = false
    for (const s of near) {
      let m = this.motors.find((x) => x.key === s.key)
      if (!m) {
        m = { key: s.key, loop: sfx(mixer()).loop("missile-motor", { at: [s.x, s.y, s.z], ref: 70, rolloff: 0.9 }), proc: null, level: 0, seen: true }
        if (!m.loop) m.proc = this.procMotor()
        this.motors.push(m)
      }
      m.seen = true
      const rx = s.x - L.eye[0]
      const ry = s.y - L.eye[1]
      const rz = s.z - L.eye[2]
      const d = Math.hypot(rx, ry, rz)
      const dop = dopplerRatio(rx, ry, rz, s.vx - L.vel[0], s.vy - L.vel[1], s.vz - L.vel[2], 0.5)
      const level = s.burning ? 1 : 0.22
      const rate = clamp(dop * (s.burning ? 1 : 0.8), 0.5, 1.8)
      if (m.loop) m.loop.set({ at: [s.x, s.y, s.z], gain: level * 1.1, rate, tc: s.burning ? 0.04 : 0.4 })
      else if (m.proc) {
        const p = m.proc
        const now = ctx.currentTime
        p.g.gain.setTargetAtTime(level * 0.55 * distanceGain(d, 70, 0.9), now, s.burning ? 0.04 : 0.4)
        p.lp.frequency.setTargetAtTime(Math.min(airCutoff(d), 600 + 2400 * level), now, 0.05)
        p.src.playbackRate.setTargetAtTime(rate, now, 0.05)
        p.pan.pan.setTargetAtTime(clamp((rx * L.right[0] + ry * L.right[1] + rz * L.right[2]) / Math.max(1, d), -1, 1) * 0.8, now, 0.05)
      }
    }
    for (let i = this.motors.length - 1; i >= 0; i--) {
      const m = this.motors[i]!
      if (m.seen) continue
      m.loop?.stop(0.25)
      if (m.proc) {
        const t = ctx.currentTime
        m.proc.g.gain.setTargetAtTime(0, t, 0.08)
        m.proc.src.stop(t + 0.4)
      }
      this.motors.splice(i, 1)
    }
  }

  /** The motor's roar until the recorded loop loads: pink noise, low-passed, panned. */
  private procMotor(): Motor["proc"] {
    const ctx = this.ctx!
    const src = ctx.createBufferSource()
    src.buffer = mixer().noise.pink
    src.loop = true
    const lp = ctx.createBiquadFilter()
    lp.type = "lowpass"
    lp.frequency.value = 2400
    const g = ctx.createGain()
    g.gain.value = 0
    const pan = ctx.createStereoPanner()
    src.connect(lp).connect(g).connect(pan).connect(this.out)
    src.start(0, Math.random())
    return { src, lp, g, pan }
  }

  /** A SAM leaving a cell `dist` metres away: the recorded take, or the procedural one until it loads. */
  samLaunch(dist: number): void {
    if (!this.ctx) return
    if (sfx(mixer()).play("sam-launch", { dist, ref: 40, echo: 0.25, travel: true })) {
      if (dist < 200) mixer().duck(0.55, 0.8, Math.min(3, dist / 343))
      return
    }
    const a = distanceGain(dist, 40, 0.8)
    const delay = Math.min(3, dist / 343)
    const lp = airCutoff(dist)
    this.burst(mixer().noise.brown, "lowpass", Math.min(lp, 500), 90, 1.0 * a, 0.005, 0.5, delay)
    this.burst(mixer().noise.white, "bandpass", 350, Math.min(lp, 3200), 0.6 * a, 0.05, 0.7, delay)
    // The motor: a roar that recedes as it climbs away.
    this.burst(mixer().noise.pink, "lowpass", Math.min(lp, 2400), 500, 0.5 * a, 0.12, 3.2, delay + 0.15)
    if (dist < 200) mixer().duck(0.6, 0.6, delay)
  }

  /** A 5-inch round fired `dist` metres away. */
  gunShot(dist: number): void {
    if (!this.ctx) return
    const a = distanceGain(dist, 30, 0.8)
    const delay = Math.min(3, dist / 343)
    const near = 1 - smoothstep(0, 1500, dist)
    const lp = airCutoff(dist)
    this.thump(70, 32, 1.1 * a, 0.55, delay)
    this.burst(mixer().noise.brown, "lowpass", Math.min(lp, 900), 140, 1.1 * a, 0.004, 1.3, delay)
    if (near > 0.2) this.burst(mixer().noise.white, "highpass", 2400, 900, 0.5 * a * near, 0.001, 0.09, delay)
    this.burst(mixer().noise.brown, "lowpass", 200, 60, 0.5 * a, 0.08, 2.6, delay + 0.05)
    if (near > 0.5) mixer().duck(0.45, 0.7, delay)
  }

  /** A shell or SAM burst `dist` metres away: in the air, on the sea, on land or on a ship. */
  burstAt(dist: number, kind: "sam" | "shell", surface: "air" | "sea" | "land" | "ship"): void {
    if (!this.ctx) return
    if (kind === "sam" && surface === "air") {
      // The proximity fuse: a sharp fragment crack ahead of the blast, then the big air burst (the flak is smaller).
      const delay = Math.min(3, dist / 343)
      const a = distanceGain(dist, 60, 0.8)
      if (dist < 2500) this.burst(mixer().noise.white, "highpass", 3200, 1400, 0.5 * a, 0.001, 0.12, delay)
      if (boomsFor(mixer()).play("air-kill", dist, 1.1)) return
      this.burst(mixer().noise.brown, "lowpass", Math.min(airCutoff(dist), 1200), 60, 1.1 * a, 0.006, 2, delay)
      return
    }
    const boom: BoomKind = surface === "sea" ? "bomb-water" : surface === "air" ? "missile" : "bomb-land"
    const size = kind === "sam" ? 1 : surface === "air" ? 0.8 : 0.6
    if (boomsFor(mixer()).play(boom, dist, size, { gain: kind === "shell" && surface !== "air" ? 0.75 : 1 })) return
    const a = distanceGain(dist, 60, 0.8)
    const delay = Math.min(3, dist / 343)
    this.burst(mixer().noise.brown, "lowpass", Math.min(airCutoff(dist), 1000), 60, 1.0 * a, 0.008, 1.8, delay)
  }

  /** Our CIWS shot something down. */
  intercept(dist: number): void {
    if (!this.ctx) return
    if (boomsFor(mixer()).play("missile", dist, 0.6)) return
    this.burst(mixer().noise.brown, "lowpass", 900, 80, 0.8 * distanceGain(dist, 60, 0.8), 0.005, 1, Math.min(3, dist / 343))
  }
}
