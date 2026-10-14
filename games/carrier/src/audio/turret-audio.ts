import { type BoomKind, boomsFor } from "./jet-boom"
import { airCutoff, clamp, distanceGain, smoothstep } from "./jet-math"
import { mixer } from "./mixer"

/**
 * Ship gunnery sounds, procedural (no new assets), on the mixer's `weapons` bus:
 * - CIWS: the Phalanx "brrrt" in layers: a 75 Hz pulse train (the rate of fire) clipped and band-passed, a crack of noise
 *   chopped at the same rate, a low brown-noise body, and the drum's spin whine gliding up before and down after a
 *   burst. Other CIWS are a duller, distant version of the same voice (low-passed, level from the loudest one).
 * - SAM: an ignition thump and a rising whoosh out of the cell, then the motor's roar receding as it climbs away.
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
  private seekLfoGain!: GainNode
  private firing = false
  private spin = 0
  private duckIn = 0
  private seek: 0 | 1 | 2 = 0
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

    // SAM seeker tone (the launcher's search growl and lock tone).
    this.seekOsc = ctx.createOscillator()
    this.seekOsc.type = "triangle"
    this.seekOsc.frequency.value = 440
    const lfo = ctx.createOscillator()
    lfo.frequency.value = 8
    this.seekLfoGain = ctx.createGain()
    this.seekLfoGain.gain.value = 60
    lfo.connect(this.seekLfoGain).connect(this.seekOsc.frequency)
    this.seekGain = ctx.createGain()
    this.seekGain.gain.value = 0
    this.seekOsc.connect(this.seekGain).connect(this.out)
    this.seekOsc.start()
    lfo.start()
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

  /**
   * Per frame: our CIWS firing, the loudest other CIWS (0..1 after distance), the SAM seeker (0 off, 1 searching, 2
   * locked).
   */
  update(dt: number, ciws: boolean, farCiws: number, seek: 0 | 1 | 2): void {
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
    if (seek !== this.seek) {
      this.seek = seek
      this.seekGain.gain.setTargetAtTime(seek ? 0.06 : 0, now, 0.02)
      this.seekOsc.frequency.setTargetAtTime(seek === 2 ? 1180 : 440, now, 0.03)
      this.seekLfoGain.gain.setTargetAtTime(seek === 2 ? 0 : 60, now, 0.03)
    }
  }

  /** A SAM leaving a cell `dist` metres away. */
  samLaunch(dist: number): void {
    if (!this.ctx) return
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
