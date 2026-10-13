import { SpellAudioEmitter, VehicleAudioEmitter } from "./emitters"
import type { SampleBank } from "./manifest"
import { AudioRuntime, createBoxOcclusionQuery } from "./runtime"
import { clamp } from "./synth"
import { getOfflineAudioContextConstructor } from "./test-context"

export type AudioAnalysisStats = {
  durationSeconds: number
  sampleRate: number
  peak: number
  peakDb: number
  rms: number
  rmsDb: number
  approxLufs: number
  clippedSamples: number
  dcOffset: number
  maxAdjacentDelta: number
  maxControlBoundaryDelta: number
  maxIsolatedSpike: number
  quietWindowRms: number[]
  tailRms: number
  spectralCentroidHz: number
  highBandRatio: number
  waveformBins: {
    bins: number
    min: number[]
    max: number[]
    rms: number[]
  }
  spectrogram: {
    timeBins: number
    freqBins: number
    minHz: number
    maxHz: number
    /** Row-major [timeBin * freqBins + freqBin] normalized 0..1 intensity from -75 dB..0 dB. */
    intensity: number[]
  }
}

/**
 * In-place Radix-2 Cooley-Tukey FFT for power-of-two arrays.
 */
export function fftRadix2(real: Float32Array, imag: Float32Array): void {
  const n = real.length
  let j = 0
  for (let i = 0; i < n; i++) {
    if (i < j) {
      const tr = real[i]!
      real[i] = real[j]!
      real[j] = tr
      const ti = imag[i]!
      imag[i] = imag[j]!
      imag[j] = ti
    }
    let m = n >> 1
    while (m >= 1 && j >= m) {
      j -= m
      m >>= 1
    }
    j += m
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1
    const angle = (-2 * Math.PI) / len
    const wLenR = Math.cos(angle)
    const wLenI = Math.sin(angle)
    for (let i = 0; i < n; i += len) {
      let wR = 1
      let wI = 0
      for (let k = 0; k < half; k++) {
        const uR = real[i + k]!
        const uI = imag[i + k]!
        const vR = real[i + k + half]! * wR - imag[i + k + half]! * wI
        const vI = real[i + k + half]! * wI + imag[i + k + half]! * wR
        real[i + k] = uR + vR
        imag[i + k] = uI + vI
        real[i + k + half] = uR - vR
        imag[i + k + half] = uI - vI
        const nextWR = wR * wLenR - wI * wLenI
        wI = wR * wLenI + wI * wLenR
        wR = nextWR
      }
    }
  }
}

export function analyzeAudioBuffer(
  buffer: AudioBuffer,
  options: {
    fps?: number
    quietWindows?: readonly (readonly [number, number])[]
    tailWindow?: readonly [number, number]
    waveformBinCount?: number
    specTimeBins?: number
    specFreqBins?: number
  } = {},
): AudioAnalysisStats {
  const sr = buffer.sampleRate
  const length = buffer.length
  const channels = buffer.numberOfChannels
  const fps = options.fps ?? 60
  const frameStep = Math.max(1, Math.round(sr / fps))

  let peak = 0
  let sumSq = 0
  let clippedSamples = 0
  let dcOffset = 0
  let maxAdjacentDelta = 0
  let maxControlBoundaryDelta = 0
  let maxIsolatedSpike = 0

  const mono = new Float32Array(length)

  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c)
    let sum = 0
    for (let i = 0; i < length; i++) {
      const sample = data[i]!
      mono[i]! += sample / channels
      const abs = Math.abs(sample)
      if (abs > peak) peak = abs
      sumSq += sample * sample
      sum += sample
      if (abs >= 0.9999) clippedSamples++
      if (i > 0) {
        const adj = Math.abs(sample - data[i - 1]!)
        if (adj > maxAdjacentDelta) maxAdjacentDelta = adj
        if (i % frameStep === 0 && adj > maxControlBoundaryDelta) {
          maxControlBoundaryDelta = adj
        }
        if (i < length - 1) {
          const spike = Math.abs(sample - (data[i - 1]! + data[i + 1]!) * 0.5)
          if (spike > maxIsolatedSpike) maxIsolatedSpike = spike
        }
      }
    }
    dcOffset = Math.max(dcOffset, Math.abs(sum / Math.max(1, length)))
  }

  const rms = Math.sqrt(sumSq / Math.max(1, length * channels))
  const peakDb = peak > 1e-9 ? 20 * Math.log10(peak) : -120
  const rmsDb = rms > 1e-9 ? 20 * Math.log10(rms) : -120
  const approxLufs = rmsDb - 0.691

  const windowRms = (startSec: number, endSec: number) => {
    const i0 = clamp(Math.floor(startSec * sr), 0, length)
    const i1 = clamp(Math.floor(endSec * sr), i0, length)
    if (i1 <= i0) return 0
    let s = 0
    for (let i = i0; i < i1; i++) s += mono[i]! * mono[i]!
    return Math.sqrt(s / (i1 - i0))
  }

  const quietWindowRms = (options.quietWindows ?? []).map(([a, b]) => windowRms(a, b))
  const tailRms = options.tailWindow ? windowRms(options.tailWindow[0], options.tailWindow[1]) : 0

  // Waveform envelope bins
  const binCount = options.waveformBinCount ?? 180
  const minBins: number[] = []
  const maxBins: number[] = []
  const rmsBins: number[] = []
  const samplesPerBin = Math.max(1, Math.floor(length / binCount))
  for (let b = 0; b < binCount; b++) {
    const start = b * samplesPerBin
    const end = b === binCount - 1 ? length : Math.min(length, start + samplesPerBin)
    let lo = 0
    let hi = 0
    let sq = 0
    for (let i = start; i < end; i++) {
      const v = mono[i]!
      if (v < lo) lo = v
      if (v > hi) hi = v
      sq += v * v
    }
    minBins.push(Number(lo.toFixed(4)))
    maxBins.push(Number(hi.toFixed(4)))
    rmsBins.push(Number(Math.sqrt(sq / Math.max(1, end - start)).toFixed(4)))
  }

  // FFT Spectrogram & Spectral Centroid
  const fftSize = 512
  const halfFft = fftSize >> 1
  const timeBins = options.specTimeBins ?? 96
  const freqBins = options.specFreqBins ?? 48
  const minHz = 60
  const maxHz = Math.min(16000, sr * 0.48)
  const logMin = Math.log(minHz)
  const logMax = Math.log(maxHz)

  const hann = new Float32Array(fftSize)
  for (let i = 0; i < fftSize; i++) {
    hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (fftSize - 1)))
  }

  const real = new Float32Array(fftSize)
  const imag = new Float32Array(fftSize)
  const intensity = new Array<number>(timeBins * freqBins).fill(0)

  let weightedFreqSum = 0
  let totalMagSum = 0
  let highBandEnergy = 0
  let allBandEnergy = 0

  for (let tb = 0; tb < timeBins; tb++) {
    const center = Math.floor(((tb + 0.5) / timeBins) * Math.max(1, length - fftSize))
    const offset = clamp(center, 0, Math.max(0, length - fftSize))
    for (let i = 0; i < fftSize; i++) {
      real[i] = (mono[offset + i] ?? 0) * hann[i]!
      imag[i] = 0
    }
    fftRadix2(real, imag)

    const mags = new Float32Array(halfFft)
    for (let k = 1; k < halfFft; k++) {
      const mag = Math.hypot(real[k]!, imag[k]!) / halfFft
      mags[k] = mag
      const hz = (k * sr) / fftSize
      weightedFreqSum += hz * mag
      totalMagSum += mag
      const power = mag * mag
      allBandEnergy += power
      if (hz >= 2000) highBandEnergy += power
    }

    for (let fb = 0; fb < freqBins; fb++) {
      const hz0 = Math.exp(logMin + (fb / freqBins) * (logMax - logMin))
      const hz1 = Math.exp(logMin + ((fb + 1) / freqBins) * (logMax - logMin))
      const k0 = Math.max(1, Math.floor((hz0 * fftSize) / sr))
      const k1 = Math.min(halfFft - 1, Math.ceil((hz1 * fftSize) / sr))
      let peakMag = 0
      for (let k = k0; k <= k1; k++) {
        if (mags[k]! > peakMag) peakMag = mags[k]!
      }
      const db = peakMag > 1e-7 ? 20 * Math.log10(peakMag) : -80
      const norm = clamp((db + 68) / 62, 0, 1)
      intensity[tb * freqBins + fb] = Number(norm.toFixed(3))
    }
  }

  const spectralCentroidHz = totalMagSum > 1e-9 ? weightedFreqSum / totalMagSum : 0
  const highBandRatio = allBandEnergy > 1e-12 ? highBandEnergy / allBandEnergy : 0

  return {
    durationSeconds: length / sr,
    sampleRate: sr,
    peak,
    peakDb,
    rms,
    rmsDb,
    approxLufs,
    clippedSamples,
    dcOffset,
    maxAdjacentDelta,
    maxControlBoundaryDelta,
    maxIsolatedSpike,
    quietWindowRms,
    tailRms,
    spectralCentroidHz,
    highBandRatio,
    waveformBins: {
      bins: binCount,
      min: minBins,
      max: maxBins,
      rms: rmsBins,
    },
    spectrogram: {
      timeBins,
      freqBins,
      minHz,
      maxHz,
      intensity,
    },
  }
}

export function encodeWavPcm16(buffer: AudioBuffer): Uint8Array {
  const length = buffer.length
  const sampleRate = buffer.sampleRate
  const bytes = new ArrayBuffer(44 + length * 4)
  const v = new DataView(bytes)
  const writeText = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(offset + i, s.charCodeAt(i))
  }
  writeText(0, "RIFF")
  v.setUint32(4, bytes.byteLength - 8, true)
  writeText(8, "WAVEfmt ")
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 2, true)
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * 4, true)
  v.setUint16(32, 4, true)
  v.setUint16(34, 16, true)
  writeText(36, "data")
  v.setUint32(40, bytes.byteLength - 44, true)

  const l = buffer.getChannelData(0)
  const r = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : l
  for (let i = 0; i < length; i++) {
    const sL = Math.round(clamp(l[i]!, -1, 1) * 32767)
    const sR = Math.round(clamp(r[i]!, -1, 1) * 32767)
    v.setInt16(44 + i * 4, sL, true)
    v.setInt16(44 + i * 4 + 2, sR, true)
  }
  return new Uint8Array(bytes)
}

export type AbComparisonResult = {
  dryOpen: { wav: Uint8Array; stats: AudioAnalysisStats }
  reverbOccluded: { wav: Uint8Array; stats: AudioAnalysisStats }
  delta: {
    centroidDropHz: number
    highBandRatioDrop: number
    reverbTailGainRatio: number
  }
}

/**
 * Renders an offline A/B comparison of the exact same seeded cue/emitter schedule:
 * - Variant A (`dryOpen`): no wall occlusion, zero reverb wet output.
 * - Variant B (`reverbOccluded`): occluded behind a building slab with street-canyon reverb active.
 */
export async function renderOcclusionReverbAb(
  seed = 7,
  OfflineCtx: typeof OfflineAudioContext = getOfflineAudioContextConstructor(),
  sourceBank?: SampleBank,
): Promise<AbComparisonResult> {
  const duration = 3.2
  const sr = 48000

  const renderVariant = async (occluded: boolean) => {
    const ctx = new OfflineCtx(2, Math.ceil(duration * sr), sr)
    const runtime = new AudioRuntime({
      context: ctx,
      seed,
      reverbWet: occluded ? 0.72 : 0,
      visibilityQuery: occluded
        ? createBoxOcclusionQuery([{ x0: 4, x1: 12, z0: -25, z1: 25, h: 10 }])
        : () => 0,
    })
    sourceBank?.cloneDecodedTo(runtime.sampleBank)
    runtime.setListener({ x: 0, z: 0, rightX: 1, rightZ: 0, earHeight: 16 })

    const srcPos = { x: 18, z: 3, vx: -6, vz: 0 }
    // Schedule a layered crash, metal clink, and arcane spell burst at fixed timestamps
    runtime.scheduleTime = 0.1
    runtime.playCue("impact_crash_layered", {
      intensity: 0.85,
      force: 0.9,
      position: srcPos,
      wet: occluded ? 0.55 : 0,
    })

    runtime.scheduleTime = 0.75
    runtime.playCue("impact_metal_clink", {
      intensity: 0.8,
      force: 0.85,
      position: srcPos,
      wet: occluded ? 0.5 : 0,
    })

    runtime.scheduleTime = 1.25
    runtime.playCue("spell_arcane_cast", {
      intensity: 0.9,
      force: 0.95,
      position: srcPos,
      wet: occluded ? 0.65 : 0,
    })

    const rendered = await ctx.startRendering()
    const stats = analyzeAudioBuffer(rendered, {
      fps: 60,
      tailWindow: [1.95, 2.75],
      quietWindows: [[2.95, 3.18]],
    })
    return { wav: encodeWavPcm16(rendered), stats }
  }

  const dryOpen = await renderVariant(false)
  const reverbOccluded = await renderVariant(true)

  return {
    dryOpen,
    reverbOccluded,
    delta: {
      centroidDropHz: dryOpen.stats.spectralCentroidHz - reverbOccluded.stats.spectralCentroidHz,
      highBandRatioDrop: dryOpen.stats.highBandRatio - reverbOccluded.stats.highBandRatio,
      reverbTailGainRatio: reverbOccluded.stats.tailRms / Math.max(1e-6, dryOpen.stats.tailRms),
    },
  }
}

export type ReplayScenarioResult = {
  mode: "chase" | "slalom" | "spell_cycle"
  seed: number
  wav: Uint8Array
  stats: AudioAnalysisStats
  events: {
    shifts: number[]
    impacts: number[]
    nitroIgnitions: number
    spellActivations: number
    spellCasts: number
  }
}

/**
 * Renders a deterministic 6-second 60 Hz world-signal replay driving continuous emitters,
 * transient impacts, fuel exhaustion while held, and clean stop/silence verification.
 */
export async function renderWorldSignalReplayOffline(
  mode: "chase" | "slalom" | "spell_cycle" = "chase",
  seed = 7,
  OfflineCtx: typeof OfflineAudioContext = getOfflineAudioContextConstructor(),
  sourceBank?: SampleBank,
): Promise<ReplayScenarioResult> {
  const duration = 6.0
  const fps = 60
  const sr = 48000
  const ctx = new OfflineCtx(2, Math.ceil(duration * sr), sr)
  const runtime = new AudioRuntime({
    context: ctx,
    seed,
    reverbWet: 0.45,
    visibilityQuery: createBoxOcclusionQuery([{ x0: 28, x1: 42, z0: -15, z1: 15, h: 9 }]),
  })
  sourceBank?.cloneDecodedTo(runtime.sampleBank)
  runtime.setListener({ x: 0, z: 0, rightX: 1, rightZ: 0, earHeight: 16 })

  const vehicle = new VehicleAudioEmitter(runtime, { id: "replay-car", vehicleClass: "muscle" })
  const spell = new SpellAudioEmitter(runtime, { id: "replay-mage" })

  const shifts: number[] = []
  const impacts: number[] = []
  vehicle.onShift = () => shifts.push(Number(runtime.now.toFixed(3)))

  const totalFrames = Math.floor(duration * fps)
  for (let i = 0; i < totalFrames; i++) {
    const t = i / fps
    runtime.scheduleTime = t
    const dt = 1 / fps

    // Final 1.0s is a guaranteed-silence window after explicit stop() at 4.5s
    if (t >= 4.5) {
      if (i === Math.floor(4.5 * fps)) {
        vehicle.stop(true)
        spell.stop(true)
        runtime.stopAllVoices(0.015)
        runtime.setReverbWet(0, 0.015)
      }
      continue
    }

    if (mode === "chase") {
      const speed = t < 3.6 ? Math.min(44, 4 + t * 12) : Math.max(8, 44 - (t - 3.6) * 22)
      const throttle = t < 3.6 ? 1 : 0.15
      // Hold boost from 0.4s..2.2s while fuel depletes at 1.4s and refills at 1.8s (must ignite only once!)
      // Then fresh boost press at 2.6s..3.2s (second ignition).
      const boostHeld = (t >= 0.4 && t < 2.2) || (t >= 2.6 && t < 3.2)
      const fuel = t >= 1.4 && t < 1.8 ? 0 : 0.8
      const lateralSlip = t >= 1.8 && t < 2.9 ? 9.5 * Math.sin((t - 1.8) * 2.8) : 0
      const pos = { x: 8 + Math.sin(t * 1.4) * 14, z: Math.cos(t * 1.1) * 10, vx: speed * 0.5, vz: lateralSlip }

      vehicle.update(
        {
          speed,
          throttle,
          boost: boostHeld,
          fuel,
          lateralSlip,
          handbrake: t >= 3.6 && t < 4.1,
          surface: t >= 2.9 && t < 3.4 ? "kerb" : "road",
          position: pos,
        },
        dt,
      )

      const impactForce = Math.abs(t - 1.65) < 0.02 ? 0.62 : Math.abs(t - 3.55) < 0.02 ? 0.92 : 0
      if (vehicle.stepImpact(impactForce, dt, "metal", pos)) {
        impacts.push(Number(t.toFixed(3)))
      }
    } else if (mode === "slalom") {
      const speed = 22 + 8 * Math.sin(t * 1.7)
      const lateralSlip = 11 * Math.sin(t * 3.4)
      const surface = t > 2.2 && t < 3.2 ? "grass" : t > 3.2 && t < 4.0 ? "kerb" : "road"
      vehicle.update(
        {
          speed,
          throttle: 0.75,
          lateralSlip,
          handbrake: Math.abs(Math.sin(t * 3.4)) > 0.85,
          surface,
          position: { x: Math.sin(t * 2.2) * 18, z: 6 },
        },
        dt,
      )
    } else {
      // "spell_cycle": charge 0.2..1.5s -> release cast; charge 2.0..4.2s with mana depleting at 3.1s (no cast on depletion!)
      const active = (t >= 0.2 && t < 1.5) || (t >= 2.0 && t < 4.2)
      const mana = t >= 3.1 && t < 3.6 ? 0 : 1
      spell.update(
        {
          active,
          mana,
          position: { x: Math.sin(t * 1.8) * 12, z: 8 },
          autoCastOnRelease: true,
        },
        dt,
      )
    }
  }

  const rendered = await ctx.startRendering()
  const stats = analyzeAudioBuffer(rendered, {
    fps,
    quietWindows: [[5.25, 5.92]],
    tailWindow: [4.2, 4.9],
  })

  return {
    mode,
    seed,
    wav: encodeWavPcm16(rendered),
    stats,
    events: {
      shifts,
      impacts,
      nitroIgnitions: vehicle.nitroState.ignitions,
      spellActivations: spell.gate.activations,
      spellCasts: spell.casts,
    },
  }
}
