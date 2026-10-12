// STORMFRONT ambience: rain, gusting wind, rolling thunder. Everything here is a handful of looping
// buffer sources and filters built once; per-frame work is ~10 AudioParam targets at ≤ 20 Hz.
import { airCutoff, clamp, type Core, rand, SPEED_OF_SOUND } from "./core"

export interface StormSettings {
  /** Rain intensity 0..1 (default 0.75). 0 silences rain and background thunder. */
  rain?: number
  /** Listener is inside a cockpit: rain becomes canopy patter and the world is muffled. */
  cockpit?: boolean
  /** Master switch for the whole ambience bed (default true). */
  enabled?: boolean
}

interface Layer { filter: BiquadFilterNode; gain: GainNode }

export class Storm {
  private readonly sources: AudioBufferSourceNode[] = []
  private readonly nodes: AudioNode[] = []
  private readonly hiss: Layer
  private readonly body: Layer
  private readonly sea: Layer
  private readonly patter: Layer
  private readonly wind: Layer
  private readonly howl: Layer
  private rain = 0.75
  private cockpit = false
  private enabled = true
  private gust = 0.4
  private gustTarget = 0.4
  private nextGustAt = 0
  private nextThunderAt: number
  private lastUpdate = 0

  constructor(private core: Core) {
    const bank = core.bank
    // Each layer is two decorrelated reads of the same buffer → wide stereo without stereo buffers.
    this.hiss = this.layer(bank.white, 1, 0.93, "highpass", 2800, 0.5)
    this.body = this.layer(bank.pink, 1, 0.96, "bandpass", 1000, 0.4)
    this.sea = this.layer(bank.brown, 1, 0.9, "lowpass", 350, 0.6)
    this.patter = this.layer(bank.crackle, 1.5, 1.7, "bandpass", 3200, 0.7)
    this.wind = this.layer(bank.pink, 0.8, 0.83, "bandpass", 400, 0.8)
    this.howl = this.layer(bank.pink, 0.7, 0.72, "bandpass", 500, 6)
    this.nextThunderAt = core.now + rand(6, 15)
  }

  private layer(buffer: AudioBuffer, rateL: number, rateR: number, type: BiquadFilterType, freq: number, q: number): Layer {
    const ctx = this.core.ctx
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
    const filter = ctx.createBiquadFilter()
    filter.type = type
    filter.frequency.value = freq
    filter.Q.value = q
    const gain = ctx.createGain()
    gain.gain.value = 0
    merger.connect(filter)
    filter.connect(gain)
    gain.connect(this.core.ambienceBus)
    this.nodes.push(merger, filter, gain)
    return { filter, gain }
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

  /** `speed` = own airspeed (0 when not flying). Altitude comes from the listener. */
  update(speed: number, silent: boolean): void {
    const core = this.core
    const now = core.now
    if (now - this.lastUpdate < 0.05) return
    const dt = Math.min(0.5, now - this.lastUpdate)
    this.lastUpdate = now
    const on = this.enabled && !silent ? 1 : 0
    const rain = this.rain * on
    const alt = Math.max(0, core.listener[1])
    // Rain hitting the sea dominates near the surface; up high only the rain around you remains.
    const sea = 1 / (1 + Math.max(0, alt - 5) / 120)
    const s = clamp((speed - 20) / 220, 0, 1)

    if (now >= this.nextGustAt) {
      this.gustTarget = Math.pow(rand(0.1, 1), 1.4)
      this.nextGustAt = now + rand(1.5, 5)
    }
    this.gust += (this.gustTarget - this.gust) * Math.min(1, dt * 0.9)
    const g = this.gust
    const cp = this.cockpit
    const set = (p: AudioParam, v: number, tc = 0.15) => p.setTargetAtTime(v, now, tc)

    set(this.hiss.gain.gain, 0.05 * rain * (cp ? 0.4 : 1) * (0.85 + 0.3 * g))
    set(this.body.gain.gain, 0.055 * rain * (0.6 + 0.4 * sea) * (cp ? 0.6 : 1))
    set(this.sea.gain.gain, 0.11 * rain * sea)
    // Patter: faint droplets outside, loud on the canopy (and harder with speed).
    set(this.patter.gain.gain, rain * (cp ? 0.12 * (0.7 + 0.5 * s) : 0.02))
    set(this.patter.filter.frequency, cp ? 2400 : 3600)
    // Storm wind: always some gusting, airspeed adds a rushing layer that also gusts.
    set(this.wind.gain.gain, on * (0.035 * (0.35 + 0.65 * g) + 0.22 * Math.pow(s, 1.5) * (0.75 + 0.25 * g)))
    set(this.wind.filter.frequency, 330 + speed * 8 + g * 160)
    set(this.howl.gain.gain, on * 0.02 * g * g * (0.6 + s))
    set(this.howl.filter.frequency, 420 + 320 * g + speed * 2, 0.4)

    if (rain > 0.2 && now >= this.nextThunderAt) {
      this.nextThunderAt = now + rand(22, 55)
      // Unseen far-off storm cells: rumble only, no crack.
      thunder(core, rand(15, 35), rand(0.25, 0.45) * this.rain)
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
 * Thunder. `delay` = seconds until the sound arrives (lightning distance / 343); it also sets the
 * timbre: close strikes get a ripping crack before the boom, distant ones are a low rolling rumble.
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
  const len = 2.5 + 3 * Math.min(1, d / 4000) + rand(0, 1.5)
  const pan = s.panner(rand(-0.6, 0.6))

  // Rolling envelope: an attack (slow when far) then several random rolls decaying away.
  const n = 96
  const curve = new Float32Array(n)
  const attack = 0.02 + 0.3 * Math.min(1, d / 5000)
  const rolls: [number, number, number][] = []
  const count = 3 + Math.floor(rand(0, 4))
  for (let i = 0; i < count; i++) rolls.push([rand(0.1, 0.8) * len, rand(0.15, 0.5), rand(0.4, 1)])
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * len
    let v = Math.min(1, x / attack) * Math.exp(-x / (len * 0.35))
    for (const [at, w, a] of rolls) v += a * 0.7 * Math.exp(-((x - at) ** 2) / (2 * w * w)) * Math.exp(-x / len)
    curve[i] = v * level
  }
  curve[n - 1] = 0

  const rumble = s.noise(core.bank.brown, t, t + len + 0.1, rand(0.8, 1))
  const lp = s.filter("lowpass", clamp(airCutoff(d) * 0.25, 90, 1500), 0.7)
  const env = s.gain(0)
  env.gain.setValueCurveAtTime(curve, t, len)
  rumble.connect(lp).connect(env).connect(pan)

  const sub = s.osc("sine", 38, t, t + len)
  sub.frequency.setValueAtTime(40, t)
  sub.frequency.exponentialRampToValueAtTime(25, t + len)
  const subEnv = s.gain(0)
  subEnv.gain.setValueCurveAtTime(curve.map((v) => v * 0.5), t, len)
  sub.connect(subEnv).connect(s.out)

  if (near > 0) {
    // Close strike: a sharp crack and a tearing crackle across the sky.
    const c = s.noise(core.bank.white, t, t + 0.3)
    const hp = s.filter("highpass", 1500)
    c.connect(hp).connect(s.env(t, 0.003, 0.7 * near * k, 0.25, false)).connect(pan)
    const tear = s.noise(core.bank.crackle, t + 0.02, t + 1, rand(0.8, 1.2))
    const bp = s.filter("bandpass", 1800, 0.7)
    tear.connect(bp).connect(s.env(t + 0.02, 0.05, 0.45 * near * k, 0.8, false)).connect(pan)
  }
  s.send(0.35, pan)
}
