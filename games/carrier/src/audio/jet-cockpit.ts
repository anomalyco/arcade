import { clamp, smoothstep } from "./jet-math"
import type { Mixer } from "./mixer"
import { type LoopHandle, sfx } from "./sfx-bank"

/** What the air around your own jet is doing this frame. */
export type CockpitInput = {
  /** 0 chase camera .. 1 in the cockpit. */
  interior: number
  /** Flying (airborne or on the landing autopilot's approach); otherwise only the deck-side sounds play. */
  flying: boolean
  /** Airspeed (m/s), load factor (g), stall 0..1, airbrake 0..1. */
  speed: number
  g: number
  stall: number
  brake: number
}

export const COCKPIT_TUNE = { wind: 1, breath: 1, bed: 1 }

/**
 * The air around your own jet: wind rush rising with dynamic pressure (loud in the cockpit, a lighter whoosh past the
 * chase camera), a canopy whistle at speed, the cockpit's air-conditioning hiss and the recorded cockpit bed (when
 * loaded), buffet rumble from stall, high g and the airbrake, the pilot breathing through the mask (faster and strained
 * under g), airframe creaks in hard pulls, and the stall warning (both views, on the UI bus).
 */
export class CockpitBed {
  private ctx: BaseAudioContext
  private wind: { filter: BiquadFilterNode; gain: GainNode; src: AudioBufferSourceNode }
  private whistle: GainNode
  private ecs: GainNode
  private buffet: GainNode
  private windLoop: LoopHandle | null = null
  private rainLoop: LoopHandle | null = null
  private stallGain: GainNode
  private stallOsc: OscillatorNode
  private stallPhase = 0
  private breathIn = 0
  private creakIn = 1
  private started = false
  private sources: AudioScheduledSourceNode[]

  constructor(private mixer: Mixer) {
    const ctx = (this.ctx = mixer.ctx!)
    const n = mixer.noise
    const own = mixer.bus.own
    const loop = (buf: AudioBuffer) => {
      const s = ctx.createBufferSource()
      s.buffer = buf
      s.loop = true
      return s
    }
    const filter = (type: BiquadFilterType, f: number, q: number) => {
      const b = ctx.createBiquadFilter()
      b.type = type
      b.frequency.value = f
      b.Q.value = q
      return b
    }
    const gain = (to: AudioNode) => {
      const g = ctx.createGain()
      g.gain.value = 0
      g.connect(to)
      return g
    }
    const ws = loop(n.pink)
    const wf = filter("bandpass", 500, 0.6)
    const wg = gain(own)
    ws.connect(wf).connect(wg)
    this.wind = { src: ws, filter: wf, gain: wg }
    this.whistle = gain(own)
    const hs = loop(n.white)
    hs.connect(filter("bandpass", 4200, 1.6)).connect(this.whistle)
    this.ecs = gain(own)
    const es = loop(n.white)
    es.connect(filter("bandpass", 5600, 0.5)).connect(this.ecs)
    this.buffet = gain(own)
    const bs = loop(n.brown)
    bs.connect(filter("lowpass", 75, 0.8)).connect(this.buffet)
    this.stallGain = gain(mixer.bus.ui)
    this.stallOsc = ctx.createOscillator()
    this.stallOsc.type = "square"
    this.stallOsc.frequency.value = 640
    this.stallOsc.connect(filter("lowpass", 1800, 0.7)).connect(this.stallGain)
    this.sources = [ws, hs, es, bs, this.stallOsc]
  }

  update(dt: number, s: CockpitInput | null): void {
    const ctx = this.ctx
    const now = ctx.currentTime
    if (!this.started) {
      this.started = true
      for (const src of this.sources) {
        if (src instanceof AudioBufferSourceNode) src.start(now, Math.random() * 3)
        else src.start(now)
      }
    }
    const set = (p: AudioParam, v: number, tc = 0.08) => p.setTargetAtTime(v, now, tc)
    const k = s ? s.interior : 0
    const flying = !!s && s.flying
    const q = s ? clamp((s.speed / 230) ** 2, 0, 1.4) : 0
    const tw = COCKPIT_TUNE.wind

    // Wind: dynamic pressure. The recorded canopy wind (sfx-bank "cockpit-wind") once loaded, the procedural band until
    // then; loud in the cockpit, a lighter whoosh past the chase camera.
    const bank = sfx(this.mixer)
    if (!this.windLoop && bank.ready("cockpit-wind")) this.windLoop = bank.loop("cockpit-wind", { bus: "own", reverb: 0 })
    if (this.windLoop && !this.windLoop.playing) this.windLoop = null
    const windLevel = s ? q * (0.06 + 0.26 * k) * tw : 0
    this.windLoop?.set({ gain: windLevel * 0.9, rate: 0.85 + 0.25 * Math.min(1, q) })
    set(this.wind.filter.frequency, 380 + 3.2 * (s?.speed ?? 0))
    set(this.wind.src.playbackRate, 0.9 + 0.2 * Math.min(1, q))
    set(this.wind.gain.gain, this.windLoop ? 0 : windLevel)
    set(this.whistle.gain, s ? smoothstep(0.5, 1.2, q) * 0.035 * k * tw : 0)
    set(this.ecs.gain, 0.022 * k)
    const buffet = s ? (s.stall * 0.55 + Math.max(0, s.g - 5) * 0.07 + s.brake * q * 0.45) * (0.35 + 0.65 * k) : 0
    set(this.buffet.gain, flying ? buffet : 0, 0.05)

    // Rain drumming on the canopy (sfx-bank "rain-canopy"), in the cockpit while it rains.
    const rain = k * this.mixer.rain
    if (!this.rainLoop && rain > 0.01 && bank.ready("rain-canopy")) this.rainLoop = bank.loop("rain-canopy", { bus: "own", reverb: 0 })
    this.rainLoop?.set({ gain: rain * 0.8 * COCKPIT_TUNE.bed })

    // Stall warning: a 640/780 Hz warble, gated at 5 Hz.
    const stall = !!s && flying && s.stall > 0.18
    if (stall) {
      this.stallPhase += dt * 5
      const on = this.stallPhase % 1 < 0.6
      set(this.stallOsc.frequency, this.stallPhase % 2 < 1 ? 640 : 780, 0.004)
      set(this.stallGain.gain, on ? 0.05 : 0, 0.004)
    } else {
      this.stallPhase = 0
      set(this.stallGain.gain, 0, 0.01)
    }

    if (!s || !flying || k < 0.5) return
    // Breathing through the mask: every ~4 s at 1 g, down to ~1.5 s and strained under heavy g.
    const strain = smoothstep(3.5, 8, s.g)
    this.breathIn -= dt
    if (this.breathIn <= 0) {
      this.breathIn = 4.2 - 2.6 * strain + Math.random() * 0.6
      this.breath(strain)
    }
    // Airframe creaks in hard pulls.
    if (s.g > 5.5) {
      this.creakIn -= dt * (s.g - 5)
      if (this.creakIn <= 0) {
        this.creakIn = 1.2 + Math.random() * 2
        this.creak()
      }
    }
  }

  private breath(strain: number): void {
    const n = this.mixer.noise
    const ctx = this.ctx
    const lvl = 0.03 * (1 + 1.4 * strain) * COCKPIT_TUNE.breath
    if (lvl < 0.002) return
    const now = ctx.currentTime + 0.01
    const dest = this.mixer.bus.own
    // Inhale: a breathy formant pair through the mask; exhale: lower and shorter (a sharp "hick" when straining).
    const voice = (f1: number, f2: number, at: number, len: number, g: number) => {
      const src = ctx.createBufferSource()
      src.buffer = n.pink
      const a = ctx.createBiquadFilter()
      a.type = "bandpass"
      a.frequency.value = f1
      a.Q.value = 2.5
      const b = ctx.createBiquadFilter()
      b.type = "bandpass"
      b.frequency.value = f2
      b.Q.value = 3.5
      const gg = ctx.createGain()
      gg.gain.setValueAtTime(0.0001, at)
      gg.gain.linearRampToValueAtTime(g, at + len * 0.4)
      gg.gain.linearRampToValueAtTime(0.0001, at + len)
      src.connect(a).connect(gg)
      src.connect(b).connect(gg)
      gg.connect(dest)
      src.start(at, Math.random() * 3)
      src.stop(at + len + 0.05)
    }
    const inLen = 0.95 - 0.45 * strain
    voice(1100, 2500, now, inLen, lvl)
    voice(650, 1500, now + inLen + 0.25, strain > 0.5 ? 0.22 : 0.7, lvl * (0.8 + 0.6 * strain))
  }

  private creak(): void {
    const ctx = this.ctx
    const n = this.mixer.noise
    const now = ctx.currentTime + 0.01
    const src = ctx.createBufferSource()
    src.buffer = n.crackle
    const f = ctx.createBiquadFilter()
    f.type = "bandpass"
    f.Q.value = 9
    const f0 = 260 + Math.random() * 380
    f.frequency.setValueAtTime(f0, now)
    f.frequency.linearRampToValueAtTime(f0 * 0.8, now + 0.35)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, now)
    g.gain.linearRampToValueAtTime(0.5, now + 0.05)
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.4)
    src.connect(f).connect(g).connect(this.mixer.bus.own)
    src.start(now, Math.random() * 3)
    src.stop(now + 0.45)
  }
}
