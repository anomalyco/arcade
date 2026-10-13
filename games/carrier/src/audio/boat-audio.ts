import { type Mixer, mixer } from "./mixer"
import { type LoopHandle, sfx } from "./sfx-bank"

/** What one boat's engine voice needs each frame. */
export type BoatVoiceInput = {
  /** Engine output 0..1 (|power|), forward speed share of top speed 0..1, share of the hull in the water 0..1. */
  power: number
  speed: number
  wet: number
  boosting: boolean
}

type Voice = {
  out: GainNode
  pan: StereoPannerNode | null
  dieselA: OscillatorNode
  dieselB: OscillatorNode
  dieselLp: BiquadFilterNode
  dieselGain: GainNode
  whine: OscillatorNode
  whineGain: GainNode
  rush: AudioBufferSourceNode
  rushLp: BiquadFilterNode
  rushGain: GainNode
  hiss: AudioBufferSourceNode
  hissGain: GainNode
  rpm: number
  /** The recorded engine (sfx-bank "boat-engine") once it has loaded; the procedural one is its placeholder. */
  loop: LoopHandle | null
}

/** Overall trims against the jets and the gun (scripts/audio-demo.ts levels). */
const OWN = 0.55
const REMOTE = 0.5
/** Remote boats voiced at once (the nearest). */
const MAX_REMOTE = 3

/**
 * Procedural boat sound, through the shared mix (src/audio/mixer.ts):
 * - the engine: twin diesels as two detuned, clipped sawtooth pulses (28-80 Hz firing rate) through a low-pass that
 *   opens with power, the waterjet pumps' whine over them, rising with power; they race when the jets leave the water;
 * - the water: a brown-noise rush that grows with speed, a white spray hiss on top, both silent in the air;
 * - one-shots: a thump and splash when the hull slams down, and the 25 mm's punchy bursts (a low thud and a crack per
 *   round), your own loud and dry, other boats' duller with distance.
 * Your boat goes to the `own` bus, others' engines to `engines`, slams to `sfx`, guns to `weapons`.
 */
export class BoatAudio {
  private mix: Mixer = mixer()
  private ctx: BaseAudioContext | null = null
  private own: Voice | null = null
  private remotes = new Map<number, Voice>()
  private seen = new Set<number>()
  private shaper: WaveShaperNode | null = null

  constructor() {
    this.mix.onStart((ctx) => {
      this.ctx = ctx
      const sh = ctx.createWaveShaper()
      const curve = new Float32Array(1024)
      for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh(((i / 1023) * 2 - 1) * 3.5)
      sh.curve = curve
      this.shaper = sh
    })
  }

  private voice(bus: GainNode, panned: boolean): Voice | null {
    const ctx = this.ctx
    if (!ctx) return null
    const noise = this.mix.noise
    const out = ctx.createGain()
    out.gain.value = 0
    let pan: StereoPannerNode | null = null
    if (panned) {
      pan = ctx.createStereoPanner()
      out.connect(pan).connect(bus)
    } else out.connect(bus)
    const curve = this.shaper!.curve
    const diesel = (detune: number) => {
      const o = ctx.createOscillator()
      o.type = "sawtooth"
      o.frequency.value = 30
      o.detune.value = detune
      return o
    }
    const dieselA = diesel(0)
    const dieselB = diesel(38)
    const clip = ctx.createWaveShaper()
    clip.curve = curve
    const dieselLp = ctx.createBiquadFilter()
    dieselLp.type = "lowpass"
    dieselLp.frequency.value = 300
    dieselLp.Q.value = 0.9
    const dieselGain = ctx.createGain()
    dieselGain.gain.value = 0.5
    const bGain = ctx.createGain()
    bGain.gain.value = 0.7
    dieselA.connect(clip)
    dieselB.connect(bGain).connect(clip)
    clip.connect(dieselLp).connect(dieselGain).connect(out)
    const whine = ctx.createOscillator()
    whine.type = "triangle"
    whine.frequency.value = 200
    const whineGain = ctx.createGain()
    whineGain.gain.value = 0
    whine.connect(whineGain).connect(out)
    const loop = (buf: AudioBuffer) => {
      const s = ctx.createBufferSource()
      s.buffer = buf
      s.loop = true
      s.start(0, Math.random() * 1.5)
      return s
    }
    const rush = loop(noise.brown)
    const rushLp = ctx.createBiquadFilter()
    rushLp.type = "lowpass"
    rushLp.frequency.value = 300
    const rushGain = ctx.createGain()
    rushGain.gain.value = 0
    rush.connect(rushLp).connect(rushGain).connect(out)
    const hiss = loop(noise.white)
    const hp = ctx.createBiquadFilter()
    hp.type = "highpass"
    hp.frequency.value = 2600
    const hissGain = ctx.createGain()
    hissGain.gain.value = 0
    hiss.connect(hp).connect(hissGain).connect(out)
    dieselA.start()
    dieselB.start()
    whine.start()
    return { out, pan, dieselA, dieselB, dieselLp, dieselGain, whine, whineGain, rush, rushLp, rushGain, hiss, hissGain, rpm: 0.2, loop: null }
  }

  private drive(v: Voice, x: BoatVoiceInput, level: number, dt: number, lowpass = 20000, at?: ArrayLike<number>): void {
    const ctx = this.ctx!
    const now = ctx.currentTime
    // The recorded engine takes over once loaded: re-pitched with the revs, louder with power and speed. The
    // procedural engine then keeps only a little of its water layers under it.
    if (!v.loop?.playing) v.loop = sfx().loop("boat-engine", at ? { at, ref: 30, bus: "engines" } : { bus: "own" })
    const rec = !!v.loop
    // The jets race in the air: the engines unload.
    const air = x.wet <= 0 ? 0.3 : 0
    const want = 0.18 + 0.72 * x.power + air + (x.boosting ? 0.12 : 0)
    v.rpm += (want - v.rpm) * (1 - Math.exp(-dt * (want > v.rpm ? 2.6 : 1.6)))
    const r = v.rpm
    const fire = 28 + 54 * r
    v.dieselA.frequency.setTargetAtTime(fire, now, 0.05)
    v.dieselB.frequency.setTargetAtTime(fire, now, 0.05)
    v.dieselLp.frequency.setTargetAtTime(Math.min(lowpass, 220 + 1500 * r * r), now, 0.06)
    v.dieselGain.gain.setTargetAtTime(rec ? 0 : 0.35 + 0.35 * r, now, 0.06)
    v.whine.frequency.setTargetAtTime(170 + 620 * r, now, 0.06)
    v.whineGain.gain.setTargetAtTime(rec ? 0 : Math.min(lowpass, 20000) > 2000 ? 0.012 + 0.04 * r * r : 0.005, now, 0.08)
    const wet = Math.min(1, x.wet * 1.5)
    v.rushLp.frequency.setTargetAtTime(Math.min(lowpass, 180 + 1100 * x.speed), now, 0.08)
    v.rushGain.gain.setTargetAtTime((0.05 + 0.5 * x.speed) * wet, now, 0.07)
    v.hissGain.gain.setTargetAtTime(lowpass > 4000 ? 0.06 * x.speed * x.speed * wet : 0, now, 0.07)
    v.out.gain.setTargetAtTime(rec ? level * 0.35 : level, now, 0.05)
    if (v.loop) {
      const g = (0.35 + 0.65 * Math.min(1, 0.3 * r + 0.8 * x.speed)) * (at ? 1.4 : 0.9)
      v.loop.set(at ? { gain: g, rate: 0.75 + 0.5 * r, at } : { gain: g, rate: 0.75 + 0.5 * r })
    }
  }

  /** Your boat (the listener sits behind it), or null when you have none. Call every frame. */
  ownBoat(x: BoatVoiceInput | null, dt: number): void {
    if (!this.ctx) return
    if (!x) {
      if (this.own) {
        this.own.out.gain.setTargetAtTime(0, this.ctx.currentTime, 0.2)
        this.own.loop?.stop(0.4)
        this.own.loop = null
      }
      return
    }
    this.own ??= this.voice(this.mix.bus.own, false)
    if (this.own) this.drive(this.own, x, OWN, dt)
  }

  /** Call before the frame's `remote` calls. */
  beginRemotes(): void {
    this.seen.clear()
  }

  /**
   * Another boat `id` at world point `at`, `dist` metres away, `pan` −1 (left) .. 1 (right). Only the nearest few are
   * voiced: call with all of them, nearest first, then `endRemotes`.
   */
  remote(id: number, x: BoatVoiceInput, at: ArrayLike<number>, dist: number, pan: number, dt: number): void {
    if (!this.ctx || this.seen.size >= MAX_REMOTE || dist > 1500) return
    this.seen.add(id)
    let v = this.remotes.get(id)
    if (!v) {
      const made = this.voice(this.mix.bus.engines, true)
      if (!made) return
      this.remotes.set(id, (v = made))
    }
    v.pan!.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan)), this.ctx.currentTime, 0.05)
    const g = REMOTE / (1 + (dist / 45) ** 1.6)
    this.drive(v, x, g, dt, 600 + 12000 / (1 + dist / 80), at)
  }

  /** Silences and drops remote voices not heard this frame. */
  endRemotes(): void {
    const ctx = this.ctx
    if (!ctx) return
    for (const [id, v] of this.remotes) {
      if (this.seen.has(id)) continue
      v.out.gain.setTargetAtTime(0, ctx.currentTime, 0.1)
      v.loop?.stop(0.4)
      const stop = ctx.currentTime + 0.6
      for (const s of [v.dieselA, v.dieselB, v.whine, v.rush, v.hiss]) s.stop(stop)
      this.remotes.delete(id)
    }
  }

  private burst(bus: GainNode, buf: AudioBuffer, type: BiquadFilterType, f0: number, f1: number, gain: number, attack: number, length: number, delay = 0): void {
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
    src.connect(f).connect(g).connect(bus)
    src.start(at, Math.random())
    src.stop(at + length + 0.05)
  }

  private thud(bus: GainNode, f0: number, f1: number, gain: number, length: number, delay = 0): void {
    const ctx = this.ctx
    if (!ctx || gain < 0.002) return
    const at = ctx.currentTime + delay
    const o = ctx.createOscillator()
    o.type = "sine"
    o.frequency.setValueAtTime(f0, at)
    o.frequency.exponentialRampToValueAtTime(f1, at + length)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, at)
    g.gain.linearRampToValueAtTime(gain, at + 0.004)
    g.gain.exponentialRampToValueAtTime(0.0001, at + length)
    o.connect(g).connect(bus)
    o.start(at)
    o.stop(at + length + 0.05)
  }

  /** The hull slamming into the water (0..1), `dist` m away (0: yours). */
  slam(k: number, dist = 0): void {
    if (!this.ctx) return
    const a = (0.3 + 0.7 * k) / (1 + dist / 60)
    const bus = this.mix.bus.sfx
    this.thud(bus, 90, 38, 0.5 * a, 0.35)
    this.burst(bus, this.mix.noise.brown, "lowpass", 420, 70, 0.7 * a, 0.004, 0.45)
    this.burst(bus, this.mix.noise.white, "bandpass", 1600, 500, 0.22 * a, 0.02, 0.7, 0.03)
  }

  /** One 25 mm round fired, `dist` m away (0: your own gun). */
  round(dist = 0): void {
    if (!this.ctx) return
    const near = 1 / (1 + dist / 120)
    const delay = Math.min(3, dist / 343)
    const bus = this.mix.bus.weapons
    this.thud(bus, 150, 48, 0.55 * near, 0.16, delay)
    if (dist < 900) this.burst(bus, this.mix.noise.white, "bandpass", 2200, 900, 0.32 * near * (dist < 200 ? 1 : 0.4), 0.001, 0.07, delay)
    this.burst(bus, this.mix.noise.brown, "lowpass", 900, 120, 0.4 * near, 0.002, 0.22, delay)
  }

  /** The crane letting go: a splash. */
  splash(dist = 0): void {
    if (!this.ctx) return
    const a = 1 / (1 + dist / 80)
    this.burst(this.mix.bus.sfx, this.mix.noise.white, "bandpass", 1200, 400, 0.3 * a, 0.02, 0.9)
    this.burst(this.mix.bus.sfx, this.mix.noise.brown, "lowpass", 300, 60, 0.5 * a, 0.01, 0.6)
  }
}
