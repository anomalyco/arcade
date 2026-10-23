import type { VehicleKind } from "../../shared/vehicles"
import { ENGINE_BUILD, type EngineCharacter, type EngineModel, type Kit, type Noise, type Osc } from "./jet-engine-models"
import type { Mixer } from "./mixer"

/**
 * One jet's engine, fully procedural so it tracks the live jet exactly (no recorded loops: throttle, spool, afterburner,
 * Doppler and the listener's angle change every frame). The sound itself is each type's graph in jet-engine-models.ts:
 *
 *   Hornet    "Jet Wash", pure jet mixing noise and no tones: a large-scale turbulence hump (band-passed pink noise
 *             peaking at the Strouhal frequency 0.2·Vj/D, ~70 Hz idle → ~160 military → ~260 burner) behind the jet,
 *             fine-scale air (broader, up to ~2 kHz) mostly ahead, a deep burner rumble; your own Hornet's two engines
 *             decorrelated left and right
 *   F-35C     the Wings-derived voice: a soft triangle whine (front), pink roar and brown body (rear), a deep sub, and
 *             an afterburner rumble that breathes, with a sub and a soft crackle
 *
 * This class owns everything after the graph. Front sources are weighted by the cone's front, rear ones by its rear
 * (softened, so no angle is ever empty), then level × distance gain × pass duck → air-absorption low-pass → a panner (rolloff 0: distance is ours), with sends into the
 * outdoor reverb (more of it far away: a distant jet is mostly the sky's echo) and, close by, the water slapback. Your
 * own jet in the cockpit takes a muffled interior path (and the cockpit's small room) instead. Doppler scales every
 * oscillator, noise playback rate and filter together. Everything glides (setTargetAtTime); the first update lands at
 * once.
 */

export { ENGINE_TUNE, type EngineCharacter } from "./jet-engine-models"

/** Engine count and the F-35C voice's character (the Hornet's Jet Wash uses only `engines`). */
export const ENGINES: Readonly<Record<VehicleKind, EngineCharacter>> = {
  hornet: { engines: 2, whine: [300, 760], whineGain: 0.45, roar: [350, 1400], roarGain: 1, body: [220, 260], bodyGain: 1, burnLp: 280, sub: 42, burnGain: 1 },
  f35: { engines: 1, whine: [240, 600], whineGain: 0.3, roar: [280, 1050], roarGain: 0.95, body: [180, 240], bodyGain: 1.35, burnLp: 240, sub: 34, burnGain: 1.2 },
}

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

/** Glide time constant (s). */
const TC = 0.06

export class JetVoice {
  readonly kind: VehicleKind
  dying = false
  stopAt = Number.POSITIVE_INFINITY
  private ctx: BaseAudioContext
  private sources: AudioScheduledSourceNode[] = []
  private nodes: AudioNode[] = []
  private engine: EngineModel
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
    const c = ENGINES[kind]
    const n = mixer.noise
    const gain = (v: number, to?: AudioNode | AudioParam) => {
      const g = ctx.createGain()
      g.gain.value = v
      if (to instanceof AudioParam) g.connect(to)
      else if (to) g.connect(to)
      this.nodes.push(g)
      return g
    }
    const filter = (type: BiquadFilterType, f: number, q: number, to?: AudioNode) => {
      const b = ctx.createBiquadFilter()
      b.type = type
      b.frequency.value = f
      b.Q.value = q
      if (to) b.connect(to)
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

    const kit: Kit = {
      ctx,
      noise: n,
      c,
      twin: interior && c.engines > 1,
      front: this.front,
      rear: this.rear,
      mix: this.mix,
      gain,
      filter,
      osc,
      loop: noise,
      engines: (buf, type, f, q, to) => {
        // One per engine, decorrelated (random loop offsets) and spread a little left and right: half of each side bleeds
        // into the other, a little width, not two separate jets.
        const merge = ctx.createChannelMerger(2)
        this.nodes.push(merge)
        merge.connect(to)
        const out: Noise[] = []
        for (let i = 0; i < 2; i++) {
          const r = noise(buf, type, f, q, merge)
          r.gain.disconnect()
          r.gain.connect(merge, 0, i)
          r.gain.connect(gain(0.5)).connect(merge, 0, 1 - i)
          out.push(r)
        }
        return out
      },
    }
    this.engine = ENGINE_BUILD[kind](kit)
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
    // Core speed 0 (idle) .. 1 (military).
    this.engine.update(s, Math.max(0, Math.min(1, (s.rpm - 0.64) / 0.36)), set)

    // Cone: whine ahead, roar behind, never empty.
    set(this.front.gain, s.front)
    set(this.rear.gain, 0.45 + 0.55 * s.rear)

    // Level, air, position, space, cockpit.
    const ext = 1 - s.interior
    if (!this.dying) set(this.mix.gain, TRIM * this.engine.trim * s.level * s.gain * (1 - 0.3 * s.far), 0.08)
    set(this.air.frequency, s.interior > 0.5 ? 20000 : s.cutoff, 0.08)
    set(this.reverb.gain, ext * (0.12 + 0.9 * s.far), 0.2)
    set(this.echo.gain, ext * 0.12 * (1 - s.far), 0.2)
    const pn = this.panner
    set(pn.positionX, s.x, 0.02)
    set(pn.positionY, s.y, 0.02)
    set(pn.positionZ, s.z, 0.02)
    if (this.int) {
      // About the chase view's loudness, so a camera switch changes the colour, not the level.
      set(this.int.gain, s.interior * 0.55, 0.08)
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
