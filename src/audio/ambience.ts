// STORMFRONT ambience: a barely-audible deep storm rumble, gentle lowpassed wind, rolling thunder.
// No hiss anywhere: every layer is brown noise behind cascaded lowpasses (24 dB/oct), so the bed's
// energy sits below ~300 Hz. Built once; per-frame work is a few AudioParam targets at ≤ 20 Hz.
import { clamp, type Core, rand, SPEED_OF_SOUND } from "./core"

export interface StormSettings {
  /** Storm intensity 0..1 (default 0.75): scales the rumble bed and background thunder. */
  rain?: number
  /** Listener is inside a cockpit: the outside world is muffled. */
  cockpit?: boolean
  /** Master switch for the whole ambience bed (default true). */
  enabled?: boolean
}

interface Layer { a: BiquadFilterNode; b: BiquadFilterNode; gain: GainNode }

export class Storm {
  private readonly sources: AudioBufferSourceNode[] = []
  private readonly nodes: AudioNode[] = []
  private readonly rumble: Layer
  private readonly wind: Layer
  private rain = 0.75
  private enabled = true
  private cockpit = false
  private gust = 0.5
  private gustTarget = 0.5
  private nextGustAt = 0
  private swell = 0.7
  private swellTarget = 0.7
  private nextSwellAt = 0
  private nextThunderAt: number
  private lastUpdate = 0

  constructor(private core: Core) {
    this.rumble = this.layer(0.9, 0.86, 140)
    this.wind = this.layer(1, 0.95, 200)
    this.nextThunderAt = core.now + rand(8, 20)
  }

  /** Two decorrelated reads of the brown-noise buffer (wide stereo) → two cascaded lowpasses → gain. */
  private layer(rateL: number, rateR: number, freq: number): Layer {
    const ctx = this.core.ctx
    const buffer = this.core.bank.brown
    const merger = ctx.createChannelMerger(2)
    for (const [ch, rate] of [[0, rateL], [1, rateR]] as const) {
      const src = ctx.createBufferSource()
      src.buffer = buffer
      src.loop = true
      src.playbackRate.value = rate
      src.connect(merger, 0, ch)
      src.start(0, Math.random() * buffer.duration)
      this.sources.push(src)
    }
    const lp = (): BiquadFilterNode => {
      const f = ctx.createBiquadFilter()
      f.type = "lowpass"
      f.frequency.value = freq
      f.Q.value = 0.5
      return f
    }
    const a = lp(), b = lp()
    const gain = ctx.createGain()
    gain.gain.value = 0
    merger.connect(a)
    a.connect(b)
    b.connect(gain)
    gain.connect(this.core.ambienceBus)
    this.nodes.push(merger, a, b, gain)
    return { a, b, gain }
  }

  configure(s: StormSettings): void {
    if (s.rain !== undefined && Number.isFinite(s.rain)) this.rain = clamp(s.rain, 0, 1)
    if (s.enabled !== undefined) this.enabled = s.enabled
    if (s.cockpit !== undefined && s.cockpit !== this.cockpit) {
      this.cockpit = s.cockpit
      // Canopy muffle: everything outside loses its top end; UI is unaffected.
      this.core.world.frequency.setTargetAtTime(s.cockpit ? 2600 : 20000, this.core.now, 0.08)
    }
  }

  /** `speed` = own airspeed (0 when not flying). */
  update(speed: number, silent: boolean): void {
    const core = this.core
    const now = core.now
    if (now - this.lastUpdate < 0.05) return
    const dt = Math.min(0.5, now - this.lastUpdate)
    this.lastUpdate = now
    const on = this.enabled && !silent ? 1 : 0
    const s = clamp((speed - 30) / 230, 0, 1)

    // Two slow random walks: the storm swell (8–16 s) and wind gusts (3–8 s).
    if (now >= this.nextSwellAt) { this.swellTarget = rand(0.45, 1); this.nextSwellAt = now + rand(8, 16) }
    if (now >= this.nextGustAt) { this.gustTarget = rand(0.3, 1); this.nextGustAt = now + rand(3, 8) }
    this.swell += (this.swellTarget - this.swell) * Math.min(1, dt * 0.25)
    this.gust += (this.gustTarget - this.gust) * Math.min(1, dt * 0.4)
    const set = (p: AudioParam, v: number) => p.setTargetAtTime(v, now, 0.3)

    set(this.rumble.gain.gain, on * 0.09 * this.rain * this.swell)
    const wf = 180 + 1.3 * speed + 40 * this.gust
    set(this.wind.a.frequency, wf)
    set(this.wind.b.frequency, wf)
    set(this.wind.gain.gain, on * (0.02 * this.rain * this.gust + 0.16 * Math.pow(s, 1.6) * (0.85 + 0.15 * this.gust)))

    if (on && this.rain > 0.2 && now >= this.nextThunderAt) {
      this.nextThunderAt = now + rand(25, 60)
      // Unseen far-off storm cells: a soft low roll.
      thunder(core, rand(15, 30), rand(0.25, 0.45) * this.rain)
    }
  }

  dispose(): void {
    for (const s of this.sources) {
      try { s.stop() } catch { /* ignore */ }
      s.disconnect()
    }
    for (const n of this.nodes) n.disconnect()
    this.core.world.frequency.value = 20000
  }
}

/**
 * Thunder. `delay` = seconds until the sound arrives (lightning distance / 343). Deep and rolling:
 * close strikes open with a lowpassed boom, every strike is a long low rumble with random rolls.
 * Nothing above a few hundred Hz.
 */
export function thunder(core: Core, delay: number, intensity: number): void {
  if (!(intensity > 0) || !(delay >= 0)) return
  const d = delay * SPEED_OF_SOUND
  if (d > 30000) return
  const s = core.shot("thunder", null, { limit: 3, bus: core.ambienceBus })
  if (!s) return
  const t = s.t + delay
  const k = clamp(intensity, 0, 1.5)
  const level = (0.75 * k) / (1 + d / 2500)
  const near = clamp(1 - d / 3000, 0, 1)
  const len = 3 + 3 * Math.min(1, d / 4000) + rand(0, 2)
  const pan = s.panner(rand(-0.5, 0.5))

  // Rolling envelope: a soft attack (slower when far), then several random rolls decaying away.
  const n = 128
  const curve = new Float32Array(n)
  const attack = 0.08 + 0.4 * Math.min(1, d / 5000)
  const rolls: [number, number, number][] = []
  const count = 3 + Math.floor(rand(0, 4))
  for (let i = 0; i < count; i++) rolls.push([rand(0.1, 0.75) * len, rand(0.3, 0.8), rand(0.4, 1)])
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * len
    const rise = Math.min(1, x / attack)
    let v = rise * rise * Math.exp(-x / (len * 0.35))
    for (const [at, w, a] of rolls) v += a * 0.7 * Math.exp(-((x - at) ** 2) / (2 * w * w)) * Math.exp(-x / len)
    // Fade the last 15% so the tail never cuts off.
    curve[i] = v * level * Math.min(1, (1 - i / (n - 1)) / 0.15)
  }

  const cutoff = clamp(300 - d / 40, 90, 300)
  const rumble = s.noise(core.bank.brown, t, t + len + 0.1, rand(0.75, 0.95))
  const lpA = s.filter("lowpass", cutoff, 0.5)
  const lpB = s.filter("lowpass", cutoff, 0.5)
  const env = s.gain(0)
  env.gain.setValueCurveAtTime(curve, t, len)
  rumble.connect(lpA).connect(lpB).connect(env).connect(pan)

  const sub = s.osc("sine", 40, t, t + len)
  sub.frequency.setValueAtTime(40, t)
  sub.frequency.exponentialRampToValueAtTime(25, t + len)
  const subEnv = s.gain(0)
  subEnv.gain.setValueCurveAtTime(curve.map((v) => v * 0.45), t, len)
  sub.connect(subEnv).connect(s.out)

  if (near > 0) {
    // Close strike: a deep, lowpassed boom instead of a bright crack.
    const c = s.noise(core.bank.brown, t, t + 1)
    const lp = s.filter("lowpass", 550, 0.6)
    c.connect(lp).connect(s.env(t, 0.012, 0.9 * near * level, 0.7, false)).connect(pan)
  }
  s.send(0.3, pan)
}
