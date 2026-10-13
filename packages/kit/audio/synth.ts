import type { SynthLayerSpec, SurfaceTag } from "./types"
import { character, tyreSlip, type Character } from "../vehicle/audio/drivetrain"
export { character, characters, Gearbox, tyreSlip, type Character } from "../vehicle/audio/drivetrain"

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

// Reuse the approved vehicle synth's deterministic noise and context cache verbatim.
import { noise as getNoiseBuffer } from "../vehicle/audio/synth"
export { noise as getNoiseBuffer } from "../vehicle/audio/synth"

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
  onEnded?: () => void,
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

  let remaining = sources.length
  for (const source of sources) {
    source.onended = () => {
      if (--remaining !== 0) return
      for (const n of nodes) {
        try {
          n.disconnect()
        } catch {}
      }
      onEnded?.()
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
