import type { SynthLayerSpec, SurfaceTag } from "./types"

export const clamp = (x: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x))

export const smoothParam = (p: AudioParam, value: number, t: number, tau = 0.04) => {
  p.setTargetAtTime(value, t, tau)
}

export function holdParam(p: AudioParam, t: number, fallback?: number): void {
  const anyParam = p as AudioParam & { cancelAndHoldAtTime?: (time: number) => AudioParam }
  if (typeof anyParam.cancelAndHoldAtTime === "function") {
    anyParam.cancelAndHoldAtTime(t)
  } else {
    p.cancelScheduledValues(t)
    p.setValueAtTime(fallback ?? p.value, t)
  }
}

/** Time constant tau for a 60 dB exponential decay over `decaySeconds`. */
export const fallTime = (decaySeconds: number) => Math.max(0.003, decaySeconds / ((60 / 20) * Math.LN10))

const noiseBuffers = new WeakMap<BaseAudioContext, AudioBuffer>()

/**
 * Shared 3-second deterministic noise buffer (seed 1729) with 128-sample endpoint fades
 * so looping noise voices have zero seam discontinuity.
 */
export function getNoiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  const cached = noiseBuffers.get(ctx)
  if (cached) return cached
  const b = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate)
  const d = b.getChannelData(0)
  let seed = 1729
  for (let i = 0; i < d.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0
    d[i] = (seed >>> 0) / 2147483648 - 1
  }
  for (let i = 0; i < 128; i++) {
    d[i]! *= i / 127
    d[d.length - 1 - i]! *= i / 127
  }
  noiseBuffers.set(ctx, b)
  return b
}

export type Character = {
  cylinders: number
  idle: number
  redline: number
  ratios: number[]
  final: number
  exhaust: number
  intake: number
  uneven: number
}

const muscle: Character = {
  cylinders: 8,
  idle: 780,
  redline: 6200,
  ratios: [3.2, 2.05, 1.42, 1.05, 0.82],
  final: 3.7,
  exhaust: 700,
  intake: 1500,
  uneven: 0.32,
}

const van: Character = {
  cylinders: 6,
  idle: 680,
  redline: 4600,
  ratios: [3.5, 2.15, 1.45, 1],
  final: 3.6,
  exhaust: 480,
  intake: 950,
  uneven: 0.2,
}

export const characters: Record<string, Character> = {
  muscle,
  jeep: { ...muscle, cylinders: 6, redline: 5400, final: 4.6, exhaust: 620, uneven: 0.22 },
  scooter: { cylinders: 1, idle: 1600, redline: 9000, ratios: [3.2, 2.3, 1.7, 1.25], final: 5.5, exhaust: 1700, intake: 2800, uneven: 0.12 },
  compact: { cylinders: 4, idle: 950, redline: 7200, ratios: [3.6, 2.25, 1.6, 1.2, 0.94], final: 4.3, exhaust: 1100, intake: 2100, uneven: 0.07 },
  van,
  swat: van,
  bike: { cylinders: 4, idle: 1400, redline: 11500, ratios: [3.1, 2.3, 1.85, 1.5, 1.25, 1.05], final: 6.1, exhaust: 1900, intake: 3100, uneven: 0.04 },
  cruiser: { ...muscle, redline: 5700, final: 3.35, exhaust: 570, uneven: 0.19 },
  interceptor: { ...muscle, cylinders: 6, redline: 7000, exhaust: 1000, uneven: 0.1 },
}

export const character = (id: string): Character => characters[id] ?? muscle

export class Gearbox {
  gear = 0
  rpm: number
  shift = 0
  shifted = false
  private cooldown = 0.5

  constructor(readonly spec: Character) {
    this.rpm = spec.idle
  }

  update(speed: number, throttle: number, boost: boolean, dt: number): number {
    dt = clamp(dt, 0, 0.1)
    const s = this.spec
    const wheel = (Math.abs(speed) * 60) / (2 * Math.PI * 0.34) * s.final
    this.shifted = false
    this.cooldown = Math.max(0, this.cooldown - dt)
    this.shift = Math.max(0, this.shift - dt)
    const coupled = wheel * s.ratios[this.gear]!
    if (!this.cooldown && speed >= 0) {
      if (coupled > s.redline * (throttle > 0.7 || boost ? 0.88 : 0.72) && this.gear < s.ratios.length - 1) {
        this.gear++
        this.shifted = true
      } else if (this.gear > 0 && wheel * s.ratios[this.gear - 1]! < s.redline * 0.57) {
        this.gear--
        this.shifted = true
      }
      if (this.shifted) {
        this.shift = 0.16
        this.cooldown = 0.65
      }
    }
    if (speed < 0) this.gear = 0
    const clutch = s.idle + clamp(throttle) * (boost ? 2400 : 1600)
    const target = clamp(Math.max(clutch, wheel * s.ratios[this.gear]!) * (this.shift > 0 ? 0.85 : 1), s.idle, s.redline)
    this.rpm += (target - this.rpm) * (1 - Math.exp(-dt * (target < this.rpm ? 18 : 9)))
    return this.rpm
  }

  reset(): void {
    this.gear = 0
    this.rpm = this.spec.idle
    this.shift = 0
    this.shifted = false
    this.cooldown = 0.5
  }
}

export function tyreSlip(
  speed: number,
  lateral: number,
  ratio: number,
  handbrake: boolean,
  airborne = false,
  surface: SurfaceTag = "road",
) {
  const v = Math.abs(speed)
  const angle = Math.atan2(Math.abs(lateral), Math.max(3, v))
  const slip = clamp(Math.max((angle - 0.055) / 0.42, Math.abs(ratio) * 0.85, handbrake ? v / 28 : 0))
  const movement = airborne ? 0 : clamp(v / 5 + Math.abs(ratio) * 0.65)
  const squeal = Math.pow(clamp((slip - 0.22) / 0.65), 1.35) * movement * (surface === "grass" ? 0.08 : 1)
  return {
    slip,
    squeal,
    scrub: movement * clamp(slip * 1.8 + (surface !== "road" ? v / 70 : 0)) * (1 - squeal * 0.55),
    hz: 900 + 1350 * slip + 200 * clamp(v / 45),
  }
}

class ContinuousNoiseNode {
  readonly source: AudioBufferSourceNode
  readonly filter: BiquadFilterNode
  readonly gain: GainNode
  private stopped = false

  constructor(ctx: BaseAudioContext, out: AudioNode, type: BiquadFilterType, hz: number, q = 0.7) {
    this.source = ctx.createBufferSource()
    this.source.buffer = getNoiseBuffer(ctx)
    this.source.loop = true
    this.filter = ctx.createBiquadFilter()
    this.filter.type = type
    this.filter.frequency.value = hz
    this.filter.Q.value = q
    this.gain = ctx.createGain()
    this.gain.gain.value = 0
    this.source.connect(this.filter).connect(this.gain).connect(out)
    this.source.start(0)
  }

  set(g: number, hz: number, t: number, tau = 0.055): void {
    smoothParam(this.gain.gain, g, t, tau)
    smoothParam(this.filter.frequency, hz, t, 0.075)
  }

  silence(t: number, fast = false): void {
    holdParam(this.gain.gain, t, 0)
    if (fast) {
      this.gain.gain.linearRampToValueAtTime(0, t + 0.02)
    } else {
      smoothParam(this.gain.gain, 0, t, 0.04)
    }
  }

  dispose(): void {
    if (this.stopped) return
    this.stopped = true
    try {
      this.source.stop()
    } catch {}
    this.source.disconnect()
    this.filter.disconnect()
    this.gain.disconnect()
  }
}

/**
 * Band-limited periodic-wave firing harmonics over a 720-degree cycle, crank triangle body,
 * load-sensitive exhaust low-pass and intake band-pass.
 */
export class EngineSynthVoice {
  private gain: GainNode
  private pan: StereoPannerNode
  private send: GainNode
  private exhaust: BiquadFilterNode
  private intake: BiquadFilterNode
  private intakeGain: GainNode
  private firing: OscillatorNode
  private body: OscillatorNode
  private bodyGain: GainNode
  private air?: ContinuousNoiseNode
  private spec?: Character
  private disposed = false

  constructor(
    private ctx: BaseAudioContext,
    dryOut: AudioNode,
    verbOut: AudioNode,
    private cheap = false,
  ) {
    this.gain = ctx.createGain()
    this.gain.gain.value = 0
    this.pan = ctx.createStereoPanner()
    this.send = ctx.createGain()
    this.send.gain.value = 0.08
    this.exhaust = ctx.createBiquadFilter()
    this.exhaust.type = "lowpass"
    this.exhaust.Q.value = 0.8
    this.intake = ctx.createBiquadFilter()
    this.intake.type = "bandpass"
    this.intake.Q.value = 0.65
    this.intakeGain = ctx.createGain()
    this.intakeGain.gain.value = 0
    this.bodyGain = ctx.createGain()
    this.bodyGain.gain.value = 0.22
    this.firing = ctx.createOscillator()
    this.body = ctx.createOscillator()
    this.body.type = "triangle"

    this.firing.connect(this.exhaust).connect(this.gain)
    this.firing.connect(this.intake).connect(this.intakeGain).connect(this.gain)
    this.body.connect(this.bodyGain).connect(this.exhaust)
    this.gain.connect(this.pan).connect(dryOut)
    this.pan.connect(this.send).connect(verbOut)

    if (!cheap) {
      this.air = new ContinuousNoiseNode(ctx, this.intakeGain, "bandpass", 900)
    }
    this.firing.start(0)
    this.body.start(0)
  }

  set(
    vehicleId: string,
    rpm: number,
    load: number,
    level: number,
    t: number,
    pan = 0,
    doppler = 1,
    cutoff = 16000,
    wet = 0.08,
    shift = false,
  ): void {
    if (this.disposed) return
    const s = character(vehicleId)
    if (s !== this.spec) {
      this.spec = s
      const real = new Float32Array(33)
      const imag = new Float32Array(33)
      for (let n = 1; n < real.length; n++) {
        imag[n] = (n % s.cylinders === 0 ? 1 : s.uneven * (n % 2 ? 0.5 : 1)) / Math.pow(n / s.cylinders + 0.6, 1.35)
      }
      this.firing.setPeriodicWave(this.ctx.createPeriodicWave(real, imag))
    }
    smoothParam(this.firing.frequency, (rpm / 120) * doppler, t, 0.025)
    smoothParam(this.body.frequency, (rpm / 60) * doppler, t, 0.03)
    smoothParam(this.bodyGain.gain, 0.17 + (1 - load) * s.uneven * 0.45, t)
    smoothParam(this.exhaust.frequency, Math.min(cutoff, s.exhaust + 1700 * load + rpm * 0.13), t)
    smoothParam(this.intake.frequency, s.intake + rpm * 0.19, t)
    smoothParam(this.intakeGain.gain, (this.cheap ? 0.12 : 0.28) * load, t)
    this.air?.set(0.08 * load, s.intake, t)
    smoothParam(this.gain.gain, level * (shift ? 0.48 : 1), t, 0.045)
    smoothParam(this.pan.pan, clamp(pan, -1, 1), t)
    smoothParam(this.send.gain, wet, t, 0.08)
  }

  silence(t: number, fast = false): void {
    if (this.disposed) return
    holdParam(this.gain.gain, t, 0)
    holdParam(this.send.gain, t, 0)
    if (fast) {
      this.gain.gain.linearRampToValueAtTime(0, t + 0.02)
      this.send.gain.linearRampToValueAtTime(0, t + 0.02)
    } else {
      smoothParam(this.gain.gain, 0, t, 0.06)
      smoothParam(this.send.gain, 0, t, 0.06)
    }
    this.air?.silence(t, fast)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    try {
      this.firing.stop()
      this.body.stop()
    } catch {}
    this.air?.dispose()
    this.firing.disconnect()
    this.body.disconnect()
    this.gain.disconnect()
    this.pan.disconnect()
    this.send.disconnect()
  }
}

/**
 * Continuous tyre scrub and resonant squeal synth voice.
 */
export class TyreSynthVoice {
  private squeal: ContinuousNoiseNode
  private scrub: ContinuousNoiseNode
  private outGain: GainNode
  private pan: StereoPannerNode
  private send: GainNode
  private cutoff: BiquadFilterNode
  private disposed = false

  constructor(ctx: BaseAudioContext, dryOut: AudioNode, verbOut: AudioNode) {
    this.cutoff = ctx.createBiquadFilter()
    this.cutoff.type = "lowpass"
    this.cutoff.frequency.value = 16000
    this.outGain = ctx.createGain()
    this.outGain.gain.value = 1
    this.pan = ctx.createStereoPanner()
    this.send = ctx.createGain()
    this.send.gain.value = 0.05
    this.squeal = new ContinuousNoiseNode(ctx, this.cutoff, "bandpass", 1500, 5)
    this.scrub = new ContinuousNoiseNode(ctx, this.cutoff, "lowpass", 800, 0.7)
    this.cutoff.connect(this.outGain).connect(this.pan).connect(dryOut)
    this.pan.connect(this.send).connect(verbOut)
  }

  set(
    slipInfo: ReturnType<typeof tyreSlip>,
    surface: SurfaceTag,
    level: number,
    t: number,
    pan = 0,
    cutoffHz = 16000,
    wet = 0.05,
  ): void {
    if (this.disposed) return
    this.squeal.set(0.34 * slipInfo.squeal * level, slipInfo.hz, t)
    const scrubHz = surface === "grass" ? 1600 : surface === "kerb" ? 2100 : 650 + slipInfo.slip * 600
    this.scrub.set(0.095 * slipInfo.scrub * level, scrubHz, t)
    smoothParam(this.cutoff.frequency, cutoffHz, t, 0.05)
    smoothParam(this.pan.pan, clamp(pan, -1, 1), t, 0.05)
    smoothParam(this.send.gain, wet * clamp(slipInfo.squeal + slipInfo.scrub), t, 0.08)
  }

  silence(t: number, fast = false): void {
    if (this.disposed) return
    this.squeal.silence(t, fast)
    this.scrub.silence(t, fast)
    holdParam(this.send.gain, t, 0)
    if (fast) this.send.gain.linearRampToValueAtTime(0, t + 0.02)
    else smoothParam(this.send.gain, 0, t, 0.05)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.squeal.dispose()
    this.scrub.dispose()
    this.cutoff.disconnect()
    this.outGain.disconnect()
    this.pan.disconnect()
    this.send.disconnect()
  }
}

/**
 * Continuous procedural spell/arcane charge voice: harmonic shimmer + resonant bandpass air swirl.
 */
export class SpellSynthVoice {
  private rootOsc: OscillatorNode
  private shimmerOsc: OscillatorNode
  private rootGain: GainNode
  private shimmerGain: GainNode
  private air: ContinuousNoiseNode
  private filter: BiquadFilterNode
  private master: GainNode
  private pan: StereoPannerNode
  private send: GainNode
  private disposed = false

  constructor(ctx: BaseAudioContext, dryOut: AudioNode, verbOut: AudioNode) {
    this.filter = ctx.createBiquadFilter()
    this.filter.type = "lowpass"
    this.filter.frequency.value = 2400
    this.filter.Q.value = 1.4
    this.master = ctx.createGain()
    this.master.gain.value = 0
    this.pan = ctx.createStereoPanner()
    this.send = ctx.createGain()
    this.send.gain.value = 0

    this.rootOsc = ctx.createOscillator()
    this.rootOsc.type = "triangle"
    this.rootOsc.frequency.value = 220
    this.rootGain = ctx.createGain()
    this.rootGain.gain.value = 0.22

    this.shimmerOsc = ctx.createOscillator()
    this.shimmerOsc.type = "sine"
    this.shimmerOsc.frequency.value = 330
    this.shimmerOsc.detune.value = 9
    this.shimmerGain = ctx.createGain()
    this.shimmerGain.gain.value = 0.14

    this.air = new ContinuousNoiseNode(ctx, this.filter, "bandpass", 680, 2.6)

    this.rootOsc.connect(this.rootGain).connect(this.filter)
    this.shimmerOsc.connect(this.shimmerGain).connect(this.filter)
    this.filter.connect(this.master).connect(this.pan).connect(dryOut)
    this.pan.connect(this.send).connect(verbOut)

    this.rootOsc.start(0)
    this.shimmerOsc.start(0)
  }

  set(
    charge: number,
    level: number,
    t: number,
    pan = 0,
    cutoffHz = 14000,
    wet = 0.22,
  ): void {
    if (this.disposed) return
    const k = clamp(charge, 0, 1)
    const baseHz = 220 + 330 * k
    smoothParam(this.rootOsc.frequency, baseHz, t, 0.04)
    smoothParam(this.shimmerOsc.frequency, baseHz * 1.5, t, 0.04)
    smoothParam(this.shimmerGain.gain, 0.08 + 0.18 * k, t, 0.05)
    this.air.set(0.14 * (0.3 + 0.7 * k), 520 + 2600 * k, t, 0.05)
    smoothParam(this.filter.frequency, Math.min(cutoffHz, 900 + 5200 * k), t, 0.05)
    smoothParam(this.master.gain, level * (0.18 + 0.32 * k), t, 0.04)
    smoothParam(this.pan.pan, clamp(pan, -1, 1), t, 0.05)
    smoothParam(this.send.gain, wet * (0.4 + 0.6 * k), t, 0.08)
  }

  silence(t: number, fast = false): void {
    if (this.disposed) return
    holdParam(this.master.gain, t, 0)
    holdParam(this.send.gain, t, 0)
    if (fast) {
      this.master.gain.linearRampToValueAtTime(0, t + 0.02)
      this.send.gain.linearRampToValueAtTime(0, t + 0.02)
    } else {
      smoothParam(this.master.gain, 0, t, 0.045)
      smoothParam(this.send.gain, 0, t, 0.045)
    }
    this.air.silence(t, fast)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    try {
      this.rootOsc.stop()
      this.shimmerOsc.stop()
    } catch {}
    this.air.dispose()
    this.rootOsc.disconnect()
    this.shimmerOsc.disconnect()
    this.filter.disconnect()
    this.master.disconnect()
    this.pan.disconnect()
    this.send.disconnect()
  }
}

const MODAL_BAR: readonly (readonly [ratio: number, level: number])[] = [
  [1, 1],
  [2.76, 0.34],
  [5.4, 0.14],
]

const MODAL_MALLET: readonly (readonly [ratio: number, level: number])[] = [
  [1, 1],
  [3.99, 0.24],
]

const HARMONIC_SWARM: readonly (readonly [ratio: number, level: number])[] = [
  [1, 1],
  [1.5, 0.55],
  [2.0, 0.38],
  [3.0, 0.18],
]

export type ScheduledLayerNodes = {
  endTime: number
  stop(t: number, fadeSeconds: number): void
}

/**
 * Schedules a procedural synth layer (`Tone`, `Noise`, `modal-bar`, `modal-mallet`, `harmonic-swarm`)
 * with sample-accurate linear attack, optional hold, and -60 dB exponential decay finishing cleanly at zero.
 */
export function scheduleSynthLayer(
  ctx: BaseAudioContext,
  destination: AudioNode,
  layer: SynthLayerSpec,
  startTime: number,
  pitchScale: number,
  gainScale: number,
  forceFactor: number,
  cutoffLimitHz: number,
  noiseOffsetSeconds = 0,
): ScheduledLayerNodes {
  const attack = Math.max(0.001, layer.envelope.attack)
  const hold = Math.max(0, layer.envelope.hold ?? 0)
  const decay = Math.max(0.015, layer.envelope.decay)
  const peak = Math.max(0, layer.envelope.peak * gainScale)
  const stopTime = startTime + attack + hold + decay + 0.03

  const layerGain = ctx.createGain()
  layerGain.gain.setValueAtTime(0, startTime)
  layerGain.gain.linearRampToValueAtTime(peak, startTime + attack)
  if (hold > 0) {
    layerGain.gain.setValueAtTime(peak, startTime + attack + hold)
  }
  layerGain.gain.setTargetAtTime(0, startTime + attack + hold, fallTime(decay))
  layerGain.gain.linearRampToValueAtTime(0, stopTime)

  let targetNode: AudioNode = layerGain
  const nodes: AudioNode[] = [layerGain]
  const sources: AudioScheduledSourceNode[] = []

  const brightScale = 1 + (forceFactor - 1) * (layer.forceBrightness ?? 0.35)
  const baseCutoff = (layer.cutoffHz ?? 16000) * brightScale
  const effectiveCutoff = Math.max(80, Math.min(20000, Math.min(cutoffLimitHz, baseCutoff)))

  if (layer.filterType || effectiveCutoff < 18500) {
    const filter = ctx.createBiquadFilter()
    filter.type = layer.filterType ?? "lowpass"
    filter.frequency.setValueAtTime(effectiveCutoff, startTime)
    if (layer.filterGlideToHz !== undefined) {
      const targetHz = Math.max(40, Math.min(cutoffLimitHz, layer.filterGlideToHz * brightScale))
      filter.frequency.exponentialRampToValueAtTime(targetHz, startTime + (layer.glideSeconds ?? attack + decay))
    }
    if (layer.q !== undefined) filter.Q.value = layer.q
    filter.connect(layerGain)
    targetNode = filter
    nodes.push(filter)
  }

  layerGain.connect(destination)

  if (layer.waveform === "noise") {
    const src = ctx.createBufferSource()
    src.buffer = getNoiseBuffer(ctx)
    src.loop = true
    src.connect(targetNode)
    const offset = ((noiseOffsetSeconds % 2.8) + 2.8) % 2.8
    src.start(startTime, offset)
    src.stop(stopTime)
    sources.push(src)
    nodes.push(src)
  } else if (layer.waveform === "modal-bar" || layer.waveform === "modal-mallet" || layer.waveform === "harmonic-swarm") {
    const modes =
      layer.waveform === "modal-bar" ? MODAL_BAR : layer.waveform === "modal-mallet" ? MODAL_MALLET : HARMONIC_SWARM
    for (let m = 0; m < modes.length; m++) {
      const [ratio, modeLevel] = modes[m]!
      const freq = layer.frequency * pitchScale * ratio
      if (freq > 8000) continue
      const osc = ctx.createOscillator()
      osc.type = m === 0 && layer.waveform === "harmonic-swarm" ? "triangle" : "sine"
      osc.frequency.setValueAtTime(freq, startTime)
      if (layer.glideToHz !== undefined) {
        osc.frequency.exponentialRampToValueAtTime(
          Math.max(16, layer.glideToHz * pitchScale * ratio),
          startTime + (layer.glideSeconds ?? attack + decay),
        )
      }
      if (layer.detuneCents) osc.detune.value = layer.detuneCents * (m % 2 === 0 ? 1 : -1)
      const modeGain = ctx.createGain()
      const modeDecay = Math.max(0.02, decay / Math.pow(ratio, 0.72))
      const modeStop = startTime + attack + hold + modeDecay + 0.025
      const mPeak = modeLevel * (m > 0 ? clamp(brightScale, 0.5, 1.5) : 1)
      modeGain.gain.setValueAtTime(mPeak, startTime)
      modeGain.gain.setTargetAtTime(0, startTime + attack + hold, fallTime(modeDecay))
      modeGain.gain.linearRampToValueAtTime(0, modeStop)
      osc.connect(modeGain).connect(targetNode)
      osc.start(startTime)
      osc.stop(modeStop)
      sources.push(osc)
      nodes.push(osc, modeGain)
    }
  } else {
    const osc = ctx.createOscillator()
    osc.type = layer.waveform
    const startFreq = Math.max(16, layer.frequency * pitchScale)
    osc.frequency.setValueAtTime(startFreq, startTime)
    if (layer.glideToHz !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(
        Math.max(16, layer.glideToHz * pitchScale),
        startTime + (layer.glideSeconds ?? attack + decay),
      )
    }
    if (layer.detuneCents) osc.detune.value = layer.detuneCents
    osc.connect(targetNode)
    osc.start(startTime)
    osc.stop(stopTime)
    sources.push(osc)
    nodes.push(osc)
  }

  const lastSource = sources[0]
  if (lastSource) {
    lastSource.onended = () => {
      for (const n of nodes) {
        try {
          n.disconnect()
        } catch {}
      }
    }
  }

  return {
    endTime: stopTime,
    stop(t: number, fadeSeconds: number) {
      const fadeEnd = t + Math.max(0.01, fadeSeconds)
      holdParam(layerGain.gain, t, 0)
      layerGain.gain.linearRampToValueAtTime(0, fadeEnd)
      for (const s of sources) {
        try {
          s.stop(fadeEnd + 0.005)
        } catch {}
      }
    },
  }
}
