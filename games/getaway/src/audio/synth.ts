import { character, clamp, Gearbox, tyreSlip, type Character, type Surface } from "./drivetrain"
import type { AudioEngine } from "./audio"
import type { CarView } from "../../shared/sim/world"
import type { Input } from "../../shared/sim/vehicle"
import type { NitroGate } from "./nitro"

const smooth = (p: AudioParam, value: number, t: number, tau = 0.04) => p.setTargetAtTime(value, t, tau)
const noiseBuffers = new WeakMap<BaseAudioContext, AudioBuffer>()
function noise(ctx: BaseAudioContext) {
  const cached = noiseBuffers.get(ctx)
  if (cached) return cached
  const b = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate)
  const d = b.getChannelData(0)
  let seed = 1729
  for (let i = 0; i < d.length; i++) { seed = Math.imul(seed, 1664525) + 1013904223 | 0; d[i] = (seed >>> 0) / 2147483648 - 1 }
  // Both endpoints are zero: no discontinuity at the loop seam.
  for (let i = 0; i < 128; i++) { d[i] *= i / 127; d[d.length - 1 - i] *= i / 127 }
  noiseBuffers.set(ctx, b)
  return b
}

class NoiseVoice {
  filter: BiquadFilterNode
  gain: GainNode
  constructor(ctx: BaseAudioContext, out: AudioNode, type: BiquadFilterType, hz: number, q = 0.7) {
    const source = ctx.createBufferSource()
    source.buffer = noise(ctx); source.loop = true
    this.filter = ctx.createBiquadFilter(); this.filter.type = type; this.filter.frequency.value = hz; this.filter.Q.value = q
    this.gain = ctx.createGain(); this.gain.gain.value = 0
    source.connect(this.filter).connect(this.gain).connect(out); source.start()
  }
  set(g: number, hz: number, t: number) { smooth(this.gain.gain, g, t, 0.055); smooth(this.filter.frequency, hz, t, 0.075) }
}

/** Native oscillator/filter DSP: no JS callback on the render thread or per-frame node creation. */
export class EngineVoice {
  carId = -1
  private gain: GainNode
  private pan: StereoPannerNode
  private exhaust: BiquadFilterNode
  private intake: BiquadFilterNode
  private intakeGain: GainNode
  private firing: OscillatorNode
  private body: OscillatorNode
  private bodyGain: GainNode
  private air?: NoiseVoice
  private spec?: Character
  constructor(private a: AudioEngine, private cheap = false) {
    const ctx = a.ctx!
    this.gain = ctx.createGain(); this.gain.gain.value = 0
    this.pan = ctx.createStereoPanner()
    this.exhaust = ctx.createBiquadFilter(); this.exhaust.type = "lowpass"; this.exhaust.Q.value = 0.8
    this.intake = ctx.createBiquadFilter(); this.intake.type = "bandpass"; this.intake.Q.value = 0.65
    this.intakeGain = ctx.createGain(); this.intakeGain.gain.value = 0
    this.bodyGain = ctx.createGain(); this.bodyGain.gain.value = 0.22
    this.firing = ctx.createOscillator(); this.body = ctx.createOscillator(); this.body.type = "triangle"
    this.firing.connect(this.exhaust).connect(this.gain)
    this.firing.connect(this.intake).connect(this.intakeGain).connect(this.gain)
    this.body.connect(this.bodyGain).connect(this.exhaust)
    this.gain.connect(this.pan).connect(a.sfx)
    const send = ctx.createGain(); send.gain.value = 0.08
    this.pan.connect(send).connect(a.verb)
    if (!cheap) this.air = new NoiseVoice(ctx, this.intakeGain, "bandpass", 900)
    this.firing.start(); this.body.start()
  }
  set(id: string, rpm: number, load: number, level: number, pan = 0, doppler = 1, cutoff = 16000, shift = false) {
    const s = character(id), t = this.a.now
    if (s !== this.spec) {
      this.spec = s
      const real = new Float32Array(33), imag = new Float32Array(33)
      // One cycle = 720 degrees. Cylinder-order harmonics plus bank imbalance.
      for (let n = 1; n < real.length; n++) imag[n] = (n % s.cylinders === 0 ? 1 : s.uneven * (n % 2 ? 0.5 : 1)) / Math.pow(n / s.cylinders + 0.6, 1.35)
      this.firing.setPeriodicWave(this.a.ctx!.createPeriodicWave(real, imag))
    }
    smooth(this.firing.frequency, rpm / 120 * doppler, t, 0.025)
    smooth(this.body.frequency, rpm / 60 * doppler, t, 0.03)
    smooth(this.bodyGain.gain, 0.17 + (1 - load) * s.uneven * 0.45, t)
    smooth(this.exhaust.frequency, Math.min(cutoff, s.exhaust + 1700 * load + rpm * 0.13), t)
    smooth(this.intake.frequency, s.intake + rpm * 0.19, t)
    smooth(this.intakeGain.gain, (this.cheap ? 0.12 : 0.28) * load, t)
    this.air?.set(0.08 * load, s.intake, t)
    smooth(this.gain.gain, level * (shift ? 0.48 : 1), t, 0.045)
    smooth(this.pan.pan, pan, t)
  }
  silence() { smooth(this.gain.gain, 0, this.a.now, 0.08); this.carId = -1 }
}

/** Short synthetic bursts share a strict budget; all have attack/release envelopes. */
export class Transients {
  private ends: number[] = []
  constructor(private a: AudioEngine) {}
  burst(kind: "shift" | "pop", level = 1, delay = 0) {
    const ctx = this.a.ctx!, t = this.a.now + delay
    this.ends = this.ends.filter(end => end > this.a.now)
    if (this.ends.length >= 8) return
    const duration = 0.13
    this.ends.push(t + duration)
    const src = ctx.createBufferSource(); src.buffer = noise(ctx)
    const filter = ctx.createBiquadFilter(); filter.type = "lowpass"
    filter.frequency.setValueAtTime(kind === "shift" ? 480 : 1700, t)
    filter.frequency.exponentialRampToValueAtTime(180, t + duration)
    const gain = ctx.createGain(); gain.gain.setValueAtTime(0, t)
    gain.gain.linearRampToValueAtTime(level * (kind === "shift" ? 0.11 : 0.3), t + 0.006)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration - 0.01)
    gain.gain.linearRampToValueAtTime(0, t + duration)
    src.connect(filter).connect(gain).connect(this.a.sfx)
    src.start(t); src.stop(t + duration)
    src.onended = () => { src.disconnect(); filter.disconnect(); gain.disconnect() }
  }
}

type PressureVoice = { air: AudioBufferSourceNode; turbine: OscillatorNode; gain: GainNode; tone: GainNode; low: BiquadFilterNode; started: number; end: number }

/** A bounded pressure envelope, with a quiet speed-linked turbine below the engine. */
export class NitroVoice {
  private voice: PressureVoice | null = null
  private tails: PressureVoice[] = []
  ignitions = 0
  constructor(private a: AudioEngine) {}
  get active() { return this.voice !== null }
  get voices() { return Number(this.active) + this.tails.filter(v => v.end > this.a.now).length }

  update(gate: NitroGate, speed: number) {
    if (gate.ignited) this.start(speed)
    if (!gate.active) { if (this.voice) this.stop(false); return }
    if (!this.voice) return
    const t = this.a.now, k = clamp(speed / 50)
    smooth(this.voice.turbine.frequency, 420 + 620 * k, t, 0.18)
    smooth(this.voice.tone.gain, 0.008 + 0.012 * k, t, 0.12)
    // Leave the ignition's filter sweep intact before settling into pressure roar.
    if (t > this.voice.started + 0.3) smooth(this.voice.low.frequency, 1500 + 900 * k, t, 0.15)
  }

  private start(speed: number) {
    this.stop(true)
    const ctx = this.a.ctx!, t = this.a.now
    this.tails = this.tails.filter(v => v.end > t)
    // Rapid tapping retains at most two release tails.
    while (this.tails.length > 1) this.finish(this.tails.shift()!, t, 0.015)
    const air = ctx.createBufferSource(); air.buffer = noise(ctx); air.loop = true
    const high = ctx.createBiquadFilter(); high.type = "highpass"; high.frequency.value = 180
    const low = ctx.createBiquadFilter(); low.type = "lowpass"; low.Q.value = 0.55
    low.frequency.setValueAtTime(650, t)
    low.frequency.exponentialRampToValueAtTime(2400, t + 0.1)
    low.frequency.exponentialRampToValueAtTime(1600 + clamp(speed / 50) * 800, t + 0.3)
    const gain = ctx.createGain(); gain.gain.setValueAtTime(0, t)
    gain.gain.linearRampToValueAtTime(0.2, t + 0.028)
    gain.gain.exponentialRampToValueAtTime(0.085, t + 0.18)
    gain.gain.linearRampToValueAtTime(0.13, t + 0.5)
    const turbine = ctx.createOscillator(); turbine.type = "sine"; turbine.frequency.value = 380 + clamp(speed / 50) * 620
    const tone = ctx.createGain(); tone.gain.value = 0
    const out = ctx.createGain(); out.gain.value = 1
    air.connect(high).connect(low).connect(gain).connect(out).connect(this.a.sfx)
    turbine.connect(tone).connect(out)
    air.start(t); turbine.start(t)
    air.onended = () => { for (const n of [air, high, low, gain, turbine, tone, out]) n.disconnect() }
    this.voice = { air, turbine, gain, tone, low, started: t, end: Infinity }
    this.ignitions++
  }

  private finish(v: PressureVoice, t: number, duration: number) {
    if (v.end <= t + duration + 0.01) return
    for (const p of [v.gain.gain, v.tone.gain]) {
      p.cancelAndHoldAtTime(t)
      p.linearRampToValueAtTime(0, t + duration)
    }
    v.air.stop(t + duration + 0.01); v.turbine.stop(t + duration + 0.01)
    v.end = t + duration + 0.01
  }

  stop(interrupted = true) {
    const t = this.a.now
    if (interrupted) for (const v of this.tails) this.finish(v, t, 0.025)
    const v = this.voice
    if (!v) return
    if (!interrupted) {
      // The same air source vents pressure; no new ignition or unrelated pop.
      v.low.frequency.cancelAndHoldAtTime(t)
      v.low.frequency.exponentialRampToValueAtTime(2800, t + 0.04)
    }
    this.finish(v, t, interrupted ? 0.025 : 0.2)
    this.tails.push(v); this.voice = null
  }
}

export class DriverVoice {
  readonly engine: EngineVoice
  readonly transients: Transients
  gearbox = new Gearbox(character("muscle"))
  private id = -1
  private kind = ""
  private squeal: NoiseVoice
  private scrub: NoiseVoice
  readonly nitro: NitroVoice
  private lastThrottle = 0
  private launch = 0
  private load = 0
  private lastSpeed = 0
  onShift?: (car: CarView) => void
  constructor(private a: AudioEngine) {
    this.engine = new EngineVoice(a); this.transients = new Transients(a)
    this.squeal = new NoiseVoice(a.ctx!, a.sfx, "bandpass", 1500, 5)
    this.scrub = new NoiseVoice(a.ctx!, a.sfx, "lowpass", 800)
    this.nitro = new NitroVoice(a)
  }
  update(c: CarView, input: Input | undefined, dt: number, surface: Surface, gate: NitroGate) {
    if (this.id !== c.id || this.kind !== c.vehicle) {
      this.gearbox = new Gearbox(character(c.vehicle)); this.id = c.id; this.kind = c.vehicle
      this.nitro.stop(); this.lastThrottle = 0; this.lastSpeed = c.speed; this.launch = 0; this.load = 0
    }
    const t = this.a.now
    const boost = gate.active
    const throttle = c.engineOff ? 0 : input ? Math.abs(input.throttle) : clamp((c.speed - this.lastSpeed) / Math.max(dt * 8, 0.01) + 0.25)
    if ((gate.ignited || throttle > 0.8 && this.lastThrottle < 0.2) && c.speed < 24) this.launch = boost ? 0.45 : 0.22
    this.launch = Math.max(0, this.launch - dt)
    this.nitro.update(gate, c.speed)
    this.load += (clamp(throttle + (boost ? 0.3 : 0)) - this.load) * (1 - Math.exp(-dt * 10))
    this.gearbox.update(c.speed, throttle, boost, dt)
    if (this.gearbox.shifted && !c.engineOff) { this.transients.burst("shift"); this.onShift?.(c) }
    this.engine.set(c.vehicle, this.gearbox.rpm, this.load, c.engineOff ? 0 : 0.21 + this.load * 0.18, 0, 1, 16000, this.gearbox.shift > 0)
    const slip = tyreSlip(c.speed, c.drift, this.launch > 0 ? this.launch / 0.45 : 0, !!input?.handbrake, c.airborne, surface)
    this.squeal.set(0.34 * slip.squeal, slip.hz, t)
    this.scrub.set(0.095 * slip.scrub, surface === "grass" ? 1600 : surface === "kerb" ? 2100 : 650 + slip.slip * 600, t)
    this.lastThrottle = throttle; this.lastSpeed = c.speed
  }
  silence() {
    this.engine.silence()
    this.squeal.set(0, 1200, this.a.now); this.scrub.set(0, 800, this.a.now); this.nitro.stop()
    this.lastThrottle = 0; this.launch = 0
  }
}
