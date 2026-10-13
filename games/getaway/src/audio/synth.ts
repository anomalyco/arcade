import { character, clamp, Gearbox, tyreSlip, type Character, type Surface } from "./drivetrain"
import type { AudioEngine } from "./audio"
import type { CarView } from "../../shared/sim/world"
import type { Input } from "../../shared/sim/vehicle"

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
  burst(kind: "shift" | "pop" | "ignition" | "release", level = 1, delay = 0) {
    const ctx = this.a.ctx!, t = this.a.now + delay
    this.ends = this.ends.filter(end => end > this.a.now)
    if (this.ends.length >= 8) return
    const duration = kind === "ignition" ? 0.5 : kind === "release" ? 0.32 : 0.13
    this.ends.push(t + duration)
    const src = ctx.createBufferSource(); src.buffer = noise(ctx)
    const filter = ctx.createBiquadFilter(); filter.type = kind === "release" ? "bandpass" : "lowpass"
    filter.frequency.setValueAtTime(kind === "shift" ? 480 : kind === "pop" ? 1700 : 5000, t)
    filter.frequency.exponentialRampToValueAtTime(kind === "release" ? 900 : 180, t + duration)
    const gain = ctx.createGain(); gain.gain.setValueAtTime(0, t)
    gain.gain.linearRampToValueAtTime(level * (kind === "shift" ? 0.11 : 0.3), t + 0.006)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration - 0.01)
    gain.gain.linearRampToValueAtTime(0, t + duration)
    src.connect(filter).connect(gain).connect(this.a.sfx)
    src.start(t); src.stop(t + duration)
    src.onended = () => { src.disconnect(); filter.disconnect(); gain.disconnect() }
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
  private rush: NoiseVoice
  private lastBoost = false
  private lastThrottle = 0
  private launch = 0
  private load = 0
  private lastSpeed = 0
  onShift?: (car: CarView) => void
  constructor(private a: AudioEngine) {
    this.engine = new EngineVoice(a); this.transients = new Transients(a)
    this.squeal = new NoiseVoice(a.ctx!, a.sfx, "bandpass", 1500, 5)
    this.scrub = new NoiseVoice(a.ctx!, a.sfx, "lowpass", 800)
    this.rush = new NoiseVoice(a.ctx!, a.sfx, "bandpass", 1800, 0.6)
  }
  update(c: CarView, input: Input | undefined, dt: number, surface: Surface) {
    if (this.id !== c.id || this.kind !== c.vehicle) {
      this.gearbox = new Gearbox(character(c.vehicle)); this.id = c.id; this.kind = c.vehicle
      this.lastBoost = false; this.lastThrottle = 0; this.lastSpeed = c.speed; this.launch = 0; this.load = 0
    }
    const t = this.a.now
    const boost = !c.engineOff && c.stun <= 0 && (c.boosting ?? (!!input?.boost && c.boost > 0.005))
    const throttle = c.engineOff ? 0 : input ? Math.abs(input.throttle) : clamp((c.speed - this.lastSpeed) / Math.max(dt * 8, 0.01) + 0.25)
    if ((boost && !this.lastBoost || throttle > 0.8 && this.lastThrottle < 0.2) && c.speed < 24) this.launch = boost ? 0.45 : 0.22
    this.launch = Math.max(0, this.launch - dt)
    if (boost && !this.lastBoost) this.transients.burst("ignition")
    if (!boost && this.lastBoost) { this.transients.burst("release"); this.transients.burst("pop", 0.6, 0.12) }
    if (throttle < 0.2 && this.lastThrottle > 0.9 && c.speed > 22 && !c.engineOff) {
      this.transients.burst("pop", 0.7); this.transients.burst("pop", 0.4, 0.11)
    }
    this.load += (clamp(throttle + (boost ? 0.3 : 0)) - this.load) * (1 - Math.exp(-dt * 10))
    this.gearbox.update(c.speed, throttle, boost, dt)
    if (this.gearbox.shifted && !c.engineOff) { this.transients.burst("shift"); this.onShift?.(c) }
    this.engine.set(c.vehicle, this.gearbox.rpm, this.load, c.engineOff ? 0 : 0.21 + this.load * 0.18, 0, 1, 16000, this.gearbox.shift > 0)
    const slip = tyreSlip(c.speed, c.drift, this.launch > 0 ? this.launch / 0.45 : 0, !!input?.handbrake, c.airborne, surface)
    this.squeal.set(0.34 * slip.squeal, slip.hz, t)
    this.scrub.set(0.095 * slip.scrub, surface === "grass" ? 1600 : surface === "kerb" ? 2100 : 650 + slip.slip * 600, t)
    this.rush.set(boost ? 0.25 : 0, 1100 + clamp(c.speed / 45) * 2500, t)
    this.lastBoost = boost; this.lastThrottle = throttle; this.lastSpeed = c.speed
  }
  silence() {
    this.engine.silence()
    this.squeal.set(0, 1200, this.a.now); this.scrub.set(0, 800, this.a.now); this.rush.set(0, 1000, this.a.now)
    this.lastBoost = false; this.lastThrottle = 0; this.launch = 0
  }
}
