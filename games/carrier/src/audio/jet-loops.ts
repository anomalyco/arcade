import type { VehicleKind } from "../../shared/vehicles"
import { clamp, smoothstep } from "./jet-math"
import type { Mixer } from "./mixer"
import type { VoiceInput } from "./jet-engine"
import type { SfxBank } from "./sfx-bank"

/** The recorded engine loops (sfx-slots.ts "engine"), crossfaded by throttle. */
export const ENGINE_SLOTS = ["jet-idle", "jet-cruise", "jet-mil", "jet-ab"] as const
const COCKPIT = "cockpit-engine"

/** Per aircraft: the loops' pitch (the F-35's one big engine sits lower), low-shelf weight (dB), level. */
const KIND: Readonly<Record<VehicleKind, { rate: number; shelf: number; level: number }>> = {
  hornet: { rate: 1, shelf: 0, level: 1 },
  f35: { rate: 0.86, shelf: 4, level: 0.8 },
}

/** Overall trim before the bus (scripts/audio-demo.ts levels: your jet in chase about 18 dB under a gun burst). */
const TRIM = 0.17

/**
 * A jet engine from recorded loops: idle, cruise, military and afterburner (each a seamless take) playing together,
 * equal-power crossfaded by throttle with the afterburner on top, each gently re-pitched within its band (and all of them
 * by Doppler), the F-35 a lower, heavier variant of the same takes. The engine's direction colours it (a high shelf: the
 * intake's whine ahead, the exhaust's weight behind) before the air-absorption low-pass, the panner (HRTF for other
 * jets) and a reverb send. Your own jet in the cockpit hears the recorded cockpit-engine loop instead, pitched by rpm.
 */
export class JetLoopVoice {
  readonly kind: VehicleKind
  dying = false
  stopAt = Number.POSITIVE_INFINITY
  private ctx: BaseAudioContext
  private srcs: AudioBufferSourceNode[] = []
  private gains: GainNode[] = []
  private nodes: AudioNode[] = []
  private shelf: BiquadFilterNode
  private mix: GainNode
  private air: BiquadFilterNode
  private ext: GainNode
  private send: GainNode
  private panner: PannerNode
  private int: GainNode | null = null
  private cockpit: AudioBufferSourceNode | null = null
  private started = false

  constructor(mixer: Mixer, bank: SfxBank, kind: VehicleKind, hrtf: boolean, interior: boolean) {
    const ctx = (this.ctx = mixer.ctx!)
    this.kind = kind
    const k = KIND[kind]
    const node = <T extends AudioNode>(n: T): T => {
      this.nodes.push(n)
      return n
    }
    this.shelf = node(ctx.createBiquadFilter())
    this.shelf.type = "highshelf"
    this.shelf.frequency.value = 2400
    const low = node(ctx.createBiquadFilter())
    low.type = "lowshelf"
    low.frequency.value = 160
    low.gain.value = k.shelf
    this.mix = node(ctx.createGain())
    this.mix.gain.value = 0
    this.air = node(ctx.createBiquadFilter())
    this.air.type = "lowpass"
    this.air.Q.value = 0.5
    this.ext = node(ctx.createGain())
    this.panner = node(ctx.createPanner())
    this.panner.panningModel = hrtf ? "HRTF" : "equalpower"
    this.panner.distanceModel = "linear"
    this.panner.rolloffFactor = 0
    this.shelf.connect(low).connect(this.mix).connect(this.air).connect(this.ext).connect(this.panner).connect(mixer.bus.engines)
    this.send = node(ctx.createGain())
    this.air.connect(this.send).connect(mixer.reverb)
    for (const slot of ENGINE_SLOTS) {
      const buf = bank.get(slot)!
      const [a, b] = bank.loopRange(slot)!
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.loop = true
      src.loopStart = a
      src.loopEnd = b
      const g = node(ctx.createGain())
      g.gain.value = 0
      src.connect(g).connect(this.shelf)
      this.srcs.push(src)
      this.gains.push(g)
    }
    if (interior) {
      this.int = node(ctx.createGain())
      this.int.gain.value = 0
      this.int.connect(mixer.bus.own)
      this.int.connect(node(ctx.createGain())).connect(mixer.room)
      const buf = bank.get(COCKPIT)
      const range = bank.loopRange(COCKPIT)
      if (buf && range) {
        const src = (this.cockpit = ctx.createBufferSource())
        src.buffer = buf
        src.loop = true
        src.loopStart = range[0]
        src.loopEnd = range[1]
        src.connect(this.int)
      } else {
        // No cockpit take: the exterior loops through the airframe.
        const lp = node(ctx.createBiquadFilter())
        lp.type = "lowpass"
        lp.frequency.value = 650
        this.mix.connect(lp).connect(this.int)
      }
    }
  }

  /** Every recorded engine loop has decoded. */
  static ready(bank: SfxBank): boolean {
    return ENGINE_SLOTS.every((s) => bank.ready(s))
  }

  update(s: VoiceInput): void {
    const now = this.ctx.currentTime
    const first = !this.started
    if (first) {
      this.started = true
      for (const src of this.srcs) src.start(now, src.loopStart + Math.random() * (src.loopEnd - src.loopStart))
      if (this.cockpit) this.cockpit.start(now, this.cockpit.loopStart + Math.random() * (this.cockpit.loopEnd - this.cockpit.loopStart))
    }
    const set = (p: AudioParam, v: number, tc = 0.06) => (first ? p.setValueAtTime(v, now) : p.setTargetAtTime(v, now, tc))
    const k = KIND[this.kind]
    const p = clamp(s.throttle, 0, 1)
    const b = clamp(s.burner, 0, 1)
    // Equal-power crossfade idle → cruise → military; the afterburner rides on top of military.
    const wi = 1 - smoothstep(0.12, 0.55, p)
    const wm = smoothstep(0.72, 0.97, p)
    const wc = Math.max(0, 1 - wi - wm)
    const sum = wi + wc + wm || 1
    const gi = Math.sqrt(wi / sum)
    const gc = Math.sqrt(wc / sum)
    const gm = Math.sqrt(wm / sum) * (1 - 0.35 * b)
    const ga = Math.sqrt(b) * 1.1
    // Each loop re-pitched gently within its band, all by Doppler and the aircraft.
    const d = s.doppler * k.rate
    const rates = [0.94 + 0.16 * clamp(p / 0.5, 0, 1), 0.9 + 0.18 * clamp((p - 0.25) / 0.65, 0, 1), 0.96 + 0.06 * clamp((p - 0.75) / 0.25, 0, 1), 1]
    const gs = [gi, gc, gm, ga]
    for (let i = 0; i < 4; i++) {
      set(this.gains[i]!.gain, gs[i]!, 0.12)
      set(this.srcs[i]!.playbackRate, rates[i]! * d, 0.05)
    }
    // Cone: brighter ahead (the intake), weightier behind (the exhaust).
    set(this.shelf.gain, clamp(7 * (s.front - s.rear), -8, 6))
    if (!this.dying) set(this.mix.gain, TRIM * k.level * s.level * s.gain, 0.08)
    set(this.air.frequency, s.interior > 0.5 ? 20000 : s.cutoff, 0.08)
    set(this.send.gain, 0.12 * Math.sqrt(Math.max(0, s.gain)) * (1 - s.interior))
    set(this.panner.positionX, s.x, 0.02)
    set(this.panner.positionY, s.y, 0.02)
    set(this.panner.positionZ, s.z, 0.02)
    if (this.int) {
      set(this.int.gain, s.interior * TRIM * 0.7 * (0.55 + 0.45 * p + 0.25 * b), 0.08)
      set(this.ext.gain, 1 - s.interior, 0.08)
      if (this.cockpit) set(this.cockpit.playbackRate, (0.85 + 0.25 * p + 0.06 * b) * k.rate, 0.1)
    }
  }

  release(): void {
    if (this.dying) return
    this.dying = true
    const now = this.ctx.currentTime
    this.mix.gain.cancelScheduledValues(now)
    this.mix.gain.setTargetAtTime(0, now, 0.1)
    this.int?.gain.cancelScheduledValues(now)
    this.int?.gain.setTargetAtTime(0, now, 0.1)
    this.stopAt = now + 0.6
  }

  dispose(): void {
    for (const s of [...this.srcs, ...(this.cockpit ? [this.cockpit] : [])]) {
      try {
        s.stop()
      } catch {
        // Never started.
      }
      s.disconnect()
    }
    for (const n of this.nodes) n.disconnect()
  }
}
