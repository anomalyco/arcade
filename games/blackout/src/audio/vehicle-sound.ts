import type { VehicleKind } from "../../shared/sim/vehicle"
import type { Sound } from "./sound"

/** One vehicle as the mix hears it: where it is from you, how fast, the throttle, sideways slip, the horn. */
export type EngineSource = { id: number; kind: VehicleKind; dx: number; dy: number; speed: number; thr: number; slip: number; horn: boolean; mine: boolean }

/** Engine notes per kind: idle pitch (Hz), the rise through each gear, the gear length (m/s), and how loud. */
const ENGINE: Record<VehicleKind, { idle: number; rise: number; gear: number; gain: number; buzz: number }> = {
  jeep: { idle: 42, rise: 46, gear: 5, gain: 0.2, buzz: 0.35 },
  van: { idle: 32, rise: 34, gear: 4.5, gain: 0.24, buzz: 0.25 },
  scooter: { idle: 78, rise: 120, gear: 7, gain: 0.13, buzz: 0.8 },
}

type Voice = { saw: OscillatorNode; sq: OscillatorNode; sqGain: GainNode; lp: BiquadFilterNode; gain: GainNode; pan: StereoPannerNode; id: number }

const VOICES = 4

/**
 * Synthesised vehicle sounds: a few looping engine voices handed to the nearest running vehicles (pitch climbs through
 * the gears with speed, the filter opens on the throttle), a tyre squeal for the hardest slide, the horn, and one-shot
 * crashes and doors. Rides on the main Sound's context and master bus.
 */
export class VehicleSound {
  private voices: Voice[] = []
  private skid: { gain: GainNode; pan: StereoPannerNode } | null = null
  private horn: { gain: GainNode; pan: StereoPannerNode } | null = null
  private ctx: AudioContext | null = null

  constructor(private sound: Sound) {}

  private setup(): boolean {
    const bus = this.sound.bus()
    if (!bus) return !!this.ctx
    if (this.ctx === bus.ctx) return true
    const { ctx, master, noise } = bus
    this.ctx = ctx
    for (let i = 0; i < VOICES; i++) {
      const saw = ctx.createOscillator()
      saw.type = "sawtooth"
      const sq = ctx.createOscillator()
      sq.type = "square"
      const sqGain = ctx.createGain()
      const lp = ctx.createBiquadFilter()
      lp.type = "lowpass"
      lp.Q.value = 2
      const gain = ctx.createGain()
      gain.gain.value = 0
      const pan = ctx.createStereoPanner()
      saw.connect(lp)
      sq.connect(sqGain).connect(lp)
      lp.connect(gain).connect(pan).connect(master)
      saw.start()
      sq.start()
      this.voices.push({ saw, sq, sqGain, lp, gain, pan, id: -1 })
    }
    const src = ctx.createBufferSource()
    src.buffer = noise
    src.loop = true
    const bp = ctx.createBiquadFilter()
    bp.type = "bandpass"
    bp.frequency.value = 1100
    bp.Q.value = 3
    const sg = ctx.createGain()
    sg.gain.value = 0
    const sp = ctx.createStereoPanner()
    src.connect(bp).connect(sg).connect(sp).connect(master)
    src.start()
    this.skid = { gain: sg, pan: sp }
    const hg = ctx.createGain()
    hg.gain.value = 0
    const hp = ctx.createStereoPanner()
    const hlp = ctx.createBiquadFilter()
    hlp.type = "lowpass"
    hlp.frequency.value = 1600
    for (const f of [392, 494]) {
      const o = ctx.createOscillator()
      o.type = "square"
      o.frequency.value = f
      o.connect(hlp)
      o.start()
    }
    hlp.connect(hg).connect(hp).connect(master)
    this.horn = { gain: hg, pan: hp }
    return true
  }

  /** Called every frame with the vehicles near you. */
  update(sources: readonly EngineSource[]): void {
    if (!this.setup() || !this.ctx) return
    const t = this.ctx.currentTime
    const dist = (s: EngineSource) => Math.hypot(s.dx, s.dy)
    const near = [...sources].filter((s) => dist(s) < 45).sort((a, b) => (a.mine ? -1 : b.mine ? 1 : dist(a) - dist(b))).slice(0, VOICES)
    const free = this.voices.filter((v) => !near.some((s) => s.id === v.id))
    for (const s of near) {
      let v = this.voices.find((x) => x.id === s.id)
      if (!v) {
        v = free.shift()!
        v.id = s.id
      }
      const e = ENGINE[s.kind]
      const sp = Math.abs(s.speed)
      const gear = Math.min(4, Math.floor(sp / e.gear))
      const within = (sp - gear * e.gear) / e.gear
      const f = e.idle + gear * 6 + within * e.rise * (1 - gear * 0.12) + Math.abs(s.thr) * 6
      const d = dist(s)
      const roll = 1 / (1 + d * d * 0.012)
      v.saw.frequency.setTargetAtTime(f, t, 0.05)
      v.sq.frequency.setTargetAtTime(f * 0.5, t, 0.05)
      v.sqGain.gain.setTargetAtTime(e.buzz, t, 0.1)
      v.lp.frequency.setTargetAtTime(Math.min(4000, (260 + Math.abs(s.thr) * 900 + sp * 35) / (1 + d * 0.04)), t, 0.06)
      v.gain.gain.setTargetAtTime(e.gain * (0.55 + Math.abs(s.thr) * 0.45) * roll * (s.mine ? 1 : 0.8), t, 0.08)
      v.pan.pan.setTargetAtTime(Math.max(-0.8, Math.min(0.8, s.dx / 12)), t, 0.05)
    }
    for (const v of free) {
      v.id = -1
      v.gain.gain.setTargetAtTime(0, t, 0.15)
    }
    const slide = near.reduce<EngineSource | null>((b, s) => (s.slip > (b?.slip ?? 3.2) ? s : b), null)
    if (this.skid) {
      const k = slide ? Math.min(1, (slide.slip - 3.2) / 5) / (1 + dist(slide) ** 2 * 0.012) : 0
      this.skid.gain.gain.setTargetAtTime(0.22 * k, t, 0.06)
      if (slide) this.skid.pan.pan.setTargetAtTime(Math.max(-0.8, Math.min(0.8, slide.dx / 12)), t, 0.05)
    }
    const honk = near.find((s) => s.horn)
    if (this.horn) {
      this.horn.gain.gain.setTargetAtTime(honk ? 0.09 / (1 + dist(honk) ** 2 * 0.006) : 0, t, 0.015)
      if (honk) this.horn.pan.pan.setTargetAtTime(Math.max(-0.8, Math.min(0.8, honk.dx / 12)), t, 0.03)
    }
  }

  /** Silences the loops (no vehicles, or the match is over). */
  quiet(): void {
    this.update([])
  }

  /** A hit at `v` m/s: a metal crunch and a thump, louder and lower the harder. */
  crash(dx: number, dy: number, v: number): void {
    const bus = this.sound.bus()
    if (!bus) return
    const { ctx, master, noise } = bus
    const t = ctx.currentTime
    const k = Math.min(1, v / 14)
    const g = ctx.createGain()
    g.gain.value = (0.3 + k * 0.9) / (1 + (dx * dx + dy * dy) * 0.01)
    const pan = ctx.createStereoPanner()
    pan.pan.value = Math.max(-0.8, Math.min(0.8, dx / 12))
    g.connect(pan).connect(master)
    const src = ctx.createBufferSource()
    src.buffer = noise
    const f = ctx.createBiquadFilter()
    f.type = "bandpass"
    f.frequency.value = 900 + Math.random() * 600
    f.Q.value = 1.2
    const e = ctx.createGain()
    e.gain.setValueAtTime(0.0001, t)
    e.gain.exponentialRampToValueAtTime(1, t + 0.004)
    e.gain.exponentialRampToValueAtTime(0.0001, t + 0.18 + k * 0.3)
    src.connect(f).connect(e).connect(g)
    src.start(t, Math.random() * 0.5, 0.6)
    const o = ctx.createOscillator()
    o.frequency.setValueAtTime(110 - k * 40, t)
    o.frequency.exponentialRampToValueAtTime(35, t + 0.25)
    const oe = ctx.createGain()
    oe.gain.setValueAtTime(0.0001, t)
    oe.gain.exponentialRampToValueAtTime(1.2, t + 0.004)
    oe.gain.exponentialRampToValueAtTime(0.0001, t + 0.3)
    o.connect(oe).connect(g)
    o.start(t)
    o.stop(t + 0.35)
  }

  /** A door shutting (or a kickstand going up on a scooter). */
  door(dx: number, dy: number, light: boolean): void {
    const bus = this.sound.bus()
    if (!bus) return
    const { ctx, master, noise } = bus
    const t = ctx.currentTime
    const g = ctx.createGain()
    g.gain.value = 0.5 / (1 + (dx * dx + dy * dy) * 0.02)
    g.connect(master)
    const src = ctx.createBufferSource()
    src.buffer = noise
    const f = ctx.createBiquadFilter()
    f.type = "lowpass"
    f.frequency.value = light ? 2400 : 700
    const e = ctx.createGain()
    e.gain.setValueAtTime(0.0001, t)
    e.gain.exponentialRampToValueAtTime(1, t + 0.003)
    e.gain.exponentialRampToValueAtTime(0.0001, t + (light ? 0.05 : 0.12))
    src.connect(f).connect(e).connect(g)
    src.start(t, Math.random() * 0.5, 0.2)
    const o = ctx.createOscillator()
    o.frequency.setValueAtTime(light ? 300 : 90, t)
    o.frequency.exponentialRampToValueAtTime(light ? 200 : 50, t + 0.1)
    const oe = ctx.createGain()
    oe.gain.setValueAtTime(0.0001, t)
    oe.gain.exponentialRampToValueAtTime(0.8, t + 0.003)
    oe.gain.exponentialRampToValueAtTime(0.0001, t + 0.12)
    o.connect(oe).connect(g)
    o.start(t)
    o.stop(t + 0.15)
  }
}
