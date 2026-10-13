import type { VehicleKind } from "../../shared/vehicles"
import type { Mixer } from "./mixer"

/**
 * One jet's engine, fully procedural so it tracks the live jet exactly (no recorded loops: throttle, spool, afterburner,
 * Doppler and the listener's angle change every frame). After Wings' proven fighter voice
 * (games/wings/src/audio/engines.ts), richer but still smooth:
 *
 *   whine     a soft triangle turbine tone rising with core speed (through a gentle low-pass), an inharmonic ×2.76
 *             sine overtone; the Hornet's second engine a few cents off, quieter (a slow, faint beat)
 *   roar      pink noise behind a low-pass that opens with throttle; for your own Hornet two decorrelated roars, one
 *             per engine, slightly left and right (stereo width without moving the image)
 *   body      brown noise, low and warm, and a deep sub tone that grows with throttle
 *   burner    afterburner only: a brown-noise rumble under ~280 Hz that breathes (slow, soft amplitude drift), a sub,
 *             and a soft band-passed crackle
 *
 * Whine is weighted by the cone's front, roar and body by its rear (softened, so no angle is ever empty), then level ×
 * distance gain × pass duck → air-absorption low-pass → a panner (rolloff 0: distance is ours), with sends into the
 * outdoor reverb (more of it far away: a distant jet is mostly the sky's echo) and, close by, the water slapback. Your
 * own jet in the cockpit takes a muffled interior path (and the cockpit's small room) instead. Doppler scales every
 * oscillator, noise playback rate and filter together. Everything glides (setTargetAtTime); the first update lands at
 * once.
 */

export type EngineCharacter = {
  engines: number
  /** Whine at idle and at full core speed (Hz), and its level. */
  whine: readonly [number, number]
  whineGain: number
  /** Roar low-pass at idle and its opening with throttle (Hz), and level. */
  roar: readonly [number, number]
  roarGain: number
  /** Body low-pass at idle and its opening (Hz), and level. */
  body: readonly [number, number]
  bodyGain: number
  /** Afterburner rumble low-pass (Hz), sub tone (Hz), and level. */
  burnLp: number
  sub: number
  burnGain: number
}

/** Twin F414s: the brighter whine, a slow faint beat. The F135: one engine, deeper and heavier, less whine. */
export const ENGINES: Readonly<Record<VehicleKind, EngineCharacter>> = {
  hornet: { engines: 2, whine: [420, 1320], whineGain: 1, roar: [350, 1400], roarGain: 1, body: [220, 260], bodyGain: 1, burnLp: 280, sub: 42, burnGain: 1 },
  f35: { engines: 1, whine: [330, 1000], whineGain: 0.7, roar: [280, 1050], roarGain: 0.95, body: [180, 240], bodyGain: 1.35, burnLp: 240, sub: 34, burnGain: 1.2 },
}

/** Live tuning (the AUDIO debug tab). */
export const ENGINE_TUNE = { whine: 1, roar: 1, burner: 1 }

/** Overall engine trim before the bus (calibrated against the gun and weather in scripts/audio-demo.ts). */
const TRIM = 0.08

/** What the manager computes for a voice every frame. */
export type VoiceInput = {
  /** Core speed (0.64 idle .. 1 military), throttle 0..1, afterburner 0..1 (smoothed). */
  rpm: number
  throttle: number
  burner: number
  /** Doppler ratio (smoothed). */
  doppler: number
  /** Cone weights (jet-math jetCone). */
  front: number
  rear: number
  level: number
  /** Distance gain × any extra (flyby duck, fade). */
  gain: number
  /** Air-absorption cutoff (Hz). */
  cutoff: number
  /** Position in listener space (x right, y up, -z ahead), metres. */
  x: number
  y: number
  z: number
  /** 0 exterior .. 1 your own jet heard from its cockpit. */
  interior: number
  /** 0 close .. 1 far (distance share): more reverb, less direct. */
  far: number
}

export const makeVoiceInput = (): VoiceInput => ({ rpm: 0.64, throttle: 0, burner: 0, doppler: 1, front: 1, rear: 1, level: 1, gain: 1, cutoff: 20000, x: 0, y: 0, z: -30, interior: 0, far: 0 })

type Osc = { osc: OscillatorNode; gain: GainNode }
type Noise = { src: AudioBufferSourceNode; filter: BiquadFilterNode; gain: GainNode }

/** Glide time constant (s). */
const TC = 0.06

export class JetVoice {
  readonly kind: VehicleKind
  dying = false
  stopAt = Number.POSITIVE_INFINITY
  private ctx: BaseAudioContext
  private c: EngineCharacter
  private sources: AudioScheduledSourceNode[] = []
  private nodes: AudioNode[] = []
  private whines: Osc[] = []
  private whineLp: BiquadFilterNode
  private overtone: Osc
  private roars: Noise[] = []
  private body: Noise
  private deep: Osc
  private burn: Noise
  private breathe: GainNode
  private crackle: Noise
  private sub: Osc
  private front: GainNode
  private rear: GainNode
  private mix: GainNode
  private air: BiquadFilterNode
  private ext: GainNode
  private panner: PannerNode
  private reverb: GainNode
  private echo: GainNode
  private int: GainNode | null = null
  private started = false

  constructor(
    mixer: Mixer,
    kind: VehicleKind,
    /** HRTF panning (other jets) or equal-power (your own, which sits ahead of the chase camera). */
    hrtf: boolean,
    /** Your own jet: the cockpit path, and (a Hornet) the two engines' decorrelated roars. */
    interior: boolean,
  ) {
    const ctx = (this.ctx = mixer.ctx!)
    this.kind = kind
    const c = (this.c = ENGINES[kind])
    const n = mixer.noise
    const gain = (v: number, to?: AudioNode | AudioParam) => {
      const g = ctx.createGain()
      g.gain.value = v
      if (to instanceof AudioParam) g.connect(to)
      else if (to) g.connect(to)
      this.nodes.push(g)
      return g
    }
    const filter = (type: BiquadFilterType, f: number, q: number) => {
      const b = ctx.createBiquadFilter()
      b.type = type
      b.frequency.value = f
      b.Q.value = q
      this.nodes.push(b)
      return b
    }
    const osc = (type: OscillatorType, f: number, to: AudioNode): Osc => {
      const o = ctx.createOscillator()
      o.type = type
      o.frequency.value = f
      const g = gain(0, to)
      o.connect(g)
      this.sources.push(o)
      return { osc: o, gain: g }
    }
    const noise = (buf: AudioBuffer, type: BiquadFilterType, f: number, q: number, to: AudioNode | AudioParam, g0 = 0): Noise => {
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.loop = true
      const fl = filter(type, f, q)
      const g = gain(g0, to)
      src.connect(fl).connect(g)
      this.sources.push(src)
      return { src, filter: fl, gain: g }
    }

    // Output: mix → air → panner (exterior), sends to the reverb and the water's slapback; your own jet's cockpit path.
    this.mix = gain(0)
    this.air = filter("lowpass", 20000, 0.5)
    this.mix.connect(this.air)
    this.ext = gain(1)
    this.panner = ctx.createPanner()
    this.panner.panningModel = hrtf ? "HRTF" : "equalpower"
    this.panner.distanceModel = "linear"
    this.panner.rolloffFactor = 0
    this.panner.refDistance = 1
    this.panner.maxDistance = 1e6
    this.nodes.push(this.panner)
    this.air.connect(this.ext).connect(this.panner).connect(mixer.bus.engines)
    this.reverb = gain(0)
    this.echo = gain(0)
    this.ext.connect(this.reverb).connect(mixer.reverb)
    this.ext.connect(this.echo).connect(mixer.echo)
    this.front = gain(1, this.mix)
    this.rear = gain(1, this.mix)
    if (interior) {
      // The cockpit: a canopy-and-airframe low-pass with a little low-mid warmth, in the cockpit's small room.
      const int = (this.int = gain(0, mixer.bus.own))
      const lp = filter("lowpass", 700, 0.6)
      const warm = filter("peaking", 140, 0.9)
      warm.gain.value = 2
      this.mix.connect(lp).connect(warm).connect(int)
      int.connect(gain(0.5, mixer.room))
    }

    // Whine (front): soft triangles through a gentle low-pass, an inharmonic overtone.
    this.whineLp = filter("lowpass", 2400, 0.5)
    this.whineLp.connect(this.front)
    for (let i = 0; i < c.engines; i++) {
      const w = osc("triangle", c.whine[0], this.whineLp)
      w.osc.detune.value = i ? 4 : (Math.random() - 0.5) * 10
      if (i) {
        const lfo = ctx.createOscillator()
        lfo.frequency.value = 0.07 + Math.random() * 0.05
        lfo.connect(gain(3, w.osc.detune))
        this.sources.push(lfo)
      }
      this.whines.push(w)
    }
    this.overtone = osc("sine", c.whine[0] * 2.76, this.front)

    // Roar (rear): one, or for your own Hornet one per engine, decorrelated and spread a little left and right.
    if (interior && c.engines > 1) {
      const merge = ctx.createChannelMerger(2)
      this.nodes.push(merge)
      merge.connect(this.rear)
      for (let i = 0; i < 2; i++) {
        const r = noise(n.pink, "lowpass", c.roar[0], 0.5, merge)
        r.gain.disconnect()
        r.gain.connect(merge, 0, i)
        // A quarter of each side bleeds into the other: width, not two separate jets.
        r.gain.connect(gain(0.25)).connect(merge, 0, 1 - i)
        this.roars.push(r)
      }
    } else this.roars.push(noise(n.pink, "lowpass", c.roar[0], 0.5, this.rear))
    this.body = noise(n.brown, "lowpass", c.body[0], 0.5, this.rear)
    this.deep = osc("sine", c.sub * 1.25, this.mix)
    // Afterburner: a rumble that breathes (its level drifts with slow, low-passed brown noise), and a soft crackle.
    this.breathe = gain(1, this.rear)
    this.burn = noise(n.brown, "lowpass", c.burnLp, 0.6, this.breathe)
    noise(n.brown, "lowpass", 3, 0.5, this.breathe.gain, 3)
    const crackleBp = filter("bandpass", 1800, 0.6)
    crackleBp.connect(this.rear)
    this.crackle = noise(n.crackle, "highpass", 600, 0.5, crackleBp)
    this.sub = osc("sine", c.sub, this.mix)
  }

  /** Per frame. */
  update(s: VoiceInput): void {
    const now = this.ctx.currentTime
    const first = !this.started
    if (first) {
      this.started = true
      for (const src of this.sources) {
        if (src instanceof AudioBufferSourceNode) src.start(now, Math.random() * 3)
        else src.start(now)
      }
      this.mix.gain.setValueAtTime(0, now)
    }
    const set = (p: AudioParam, v: number, tc = TC) => (first ? p.setValueAtTime(v, now) : p.setTargetAtTime(v, now, tc))
    const c = this.c
    const d = s.doppler
    const p = s.throttle
    const b = s.burner * ENGINE_TUNE.burner
    // Core speed 0 (idle) .. 1 (military).
    const n = Math.max(0, Math.min(1, (s.rpm - 0.64) / 0.36))

    // Whine.
    const wf = (c.whine[0] + (c.whine[1] - c.whine[0]) * n) * d
    const wg = (0.012 + 0.016 * n) * c.whineGain * ENGINE_TUNE.whine
    for (let i = 0; i < this.whines.length; i++) {
      const w = this.whines[i]!
      set(w.osc.frequency, wf)
      set(w.gain.gain, wg * (i ? 0.35 : 1))
    }
    set(this.whineLp.frequency, 2400 * d)
    set(this.overtone.osc.frequency, wf * 2.76)
    set(this.overtone.gain.gain, wg * 0.2)

    // Roar, body, the deep sub.
    const tr = ENGINE_TUNE.roar
    const split = this.roars.length > 1 ? 0.75 : 1
    for (const r of this.roars) {
      set(r.src.playbackRate, (0.85 + 0.25 * p) * d)
      set(r.filter.frequency, (c.roar[0] + c.roar[1] * p ** 1.2 + 500 * b) * d)
      set(r.gain.gain, (0.2 + 0.3 * p + 0.15 * b) * c.roarGain * tr * split)
    }
    set(this.body.src.playbackRate, (0.85 + 0.2 * p) * d)
    set(this.body.filter.frequency, (c.body[0] + c.body[1] * p) * d)
    set(this.body.gain.gain, (0.25 + 0.25 * p) * c.bodyGain * tr)
    set(this.deep.osc.frequency, c.sub * (1.1 + 0.3 * n) * d)
    set(this.deep.gain.gain, (0.02 + 0.05 * p) * c.bodyGain)

    // Afterburner.
    set(this.burn.src.playbackRate, d)
    set(this.burn.filter.frequency, c.burnLp * d)
    set(this.burn.gain.gain, 0.5 * b * c.burnGain, 0.15)
    set(this.crackle.src.playbackRate, d)
    set(this.crackle.gain.gain, 0.09 * b * c.burnGain, 0.15)
    set(this.sub.osc.frequency, c.sub * d)
    set(this.sub.gain.gain, 0.22 * b * c.burnGain, 0.15)

    // Cone: whine ahead, roar behind, never empty.
    set(this.front.gain, s.front)
    set(this.rear.gain, 0.45 + 0.55 * s.rear)

    // Level, air, position, space, cockpit.
    const ext = 1 - s.interior
    if (!this.dying) set(this.mix.gain, TRIM * s.level * s.gain * (1 - 0.3 * s.far), 0.08)
    set(this.air.frequency, s.interior > 0.5 ? 20000 : s.cutoff, 0.08)
    set(this.reverb.gain, ext * (0.12 + 0.9 * s.far), 0.2)
    set(this.echo.gain, ext * 0.12 * (1 - s.far), 0.2)
    const pn = this.panner
    set(pn.positionX, s.x, 0.02)
    set(pn.positionY, s.y, 0.02)
    set(pn.positionZ, s.z, 0.02)
    if (this.int) {
      set(this.int.gain, s.interior, 0.08)
      set(this.ext.gain, ext, 0.08)
    }
  }

  /** Fades out; the manager disposes it after `stopAt`. */
  release(): void {
    if (this.dying) return
    this.dying = true
    const now = this.ctx.currentTime
    this.mix.gain.cancelScheduledValues(now)
    this.mix.gain.setTargetAtTime(0, now, 0.1)
    this.stopAt = now + 0.6
  }

  dispose(): void {
    for (const s of this.sources) {
      try {
        s.stop()
      } catch {
        // Never started.
      }
      s.disconnect()
    }
    for (const n of this.nodes) n.disconnect()
    this.mix.disconnect()
  }
}
