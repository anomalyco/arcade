import { clamp } from "./synth"

type ParamEvent =
  | { kind: "set"; time: number; value: number }
  | { kind: "linear"; time: number; value: number }
  | { kind: "exp"; time: number; value: number }
  | { kind: "target"; time: number; target: number; tau: number }

export class DeterministicAudioParam {
  value: number
  private events: ParamEvent[] = []
  private currentVal: number
  private lastEvalTime = -1

  constructor(initial = 0) {
    this.value = initial
    this.currentVal = initial
  }

  setValueAtTime(value: number, startTime: number): this {
    this.value = value
    this.insert({ kind: "set", time: startTime, value })
    return this
  }

  linearRampToValueAtTime(value: number, endTime: number): this {
    this.value = value
    this.insert({ kind: "linear", time: endTime, value })
    return this
  }

  exponentialRampToValueAtTime(value: number, endTime: number): this {
    const safe = Math.max(1e-6, Math.abs(value))
    this.value = safe
    this.insert({ kind: "exp", time: endTime, value: safe })
    return this
  }

  setTargetAtTime(target: number, startTime: number, timeConstant: number): this {
    this.value = target
    this.insert({ kind: "target", time: startTime, target, tau: Math.max(1e-4, timeConstant) })
    return this
  }

  cancelScheduledValues(cancelTime: number): this {
    this.events = this.events.filter(e => e.time < cancelTime - 1e-7)
    return this
  }

  cancelAndHoldAtTime(holdTime: number): this {
    const held = this.sampleAt(holdTime)
    this.events = this.events.filter(e => e.time < holdTime - 1e-7)
    this.insert({ kind: "set", time: holdTime, value: held })
    return this
  }

  private insert(ev: ParamEvent): void {
    let i = this.events.length - 1
    while (i >= 0 && this.events[i]!.time > ev.time + 1e-7) i--
    this.events.splice(i + 1, 0, ev)
  }

  resetEval(): void {
    this.currentVal = this.events.length > 0 && this.events[0]!.time <= 0 ? (this.events[0]!.kind === "target" ? this.events[0]!.target : this.events[0]!.value) : this.value
    this.lastEvalTime = -1
  }

  sampleAt(t: number): number {
    const len = this.events.length
    if (len === 0) return this.value
    if (t < this.events[0]!.time) return this.value

    // Binary search for the last event at or before `t`
    let lo = 0
    let hi = len - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (this.events[mid]!.time <= t) lo = mid
      else hi = mid - 1
    }

    // Check if `t` falls inside a linear or exponential ramp ending at `lo + 1`
    const nextEv = lo + 1 < len ? this.events[lo + 1] : undefined
    const curEv = this.events[lo]!

    const baseValueAt = (idx: number): number => {
      const e = this.events[idx]!
      if (e.kind === "set" || e.kind === "linear" || e.kind === "exp") return e.value
      // target event: approximate starting value from preceding event
      const prev = idx > 0 ? baseValueAt(idx - 1) : this.value
      const nextT = idx + 1 < len ? this.events[idx + 1]!.time : t
      const dt = Math.max(0, Math.min(t, nextT) - e.time)
      return e.target + (prev - e.target) * Math.exp(-dt / e.tau)
    }

    if (nextEv && (nextEv.kind === "linear" || nextEv.kind === "exp") && t <= nextEv.time) {
      const v0 = baseValueAt(lo)
      const t0 = curEv.time
      const span = Math.max(1e-6, nextEv.time - t0)
      const frac = clamp((t - t0) / span, 0, 1)
      if (nextEv.kind === "linear") {
        return v0 + (nextEv.value - v0) * frac
      }
      const safe0 = Math.max(1e-6, Math.abs(v0))
      return safe0 * Math.pow(Math.max(1e-6, nextEv.value) / safe0, frac)
    }

    if (curEv.kind === "target") {
      // Walk back at most 4 target steps so smooth chains stay fast (O(1))
      const startIdx = Math.max(0, lo - 4)
      let v = startIdx > 0 ? (this.events[startIdx - 1]!.kind === "target" ? (this.events[startIdx - 1] as { target: number }).target : (this.events[startIdx - 1] as { value: number }).value) : this.value
      for (let i = startIdx; i <= lo; i++) {
        const e = this.events[i]!
        if (e.kind === "target") {
          const endT = i < lo ? this.events[i + 1]!.time : t
          v = e.target + (v - e.target) * Math.exp(-Math.max(0, endT - e.time) / e.tau)
        } else {
          v = e.value
        }
      }
      return v
    }

    return curEv.value
  }
}

export class DeterministicAudioBuffer {
  readonly numberOfChannels: number
  readonly length: number
  readonly sampleRate: number
  readonly duration: number
  private channels: Float32Array[]

  constructor(numberOfChannels: number, length: number, sampleRate: number) {
    this.numberOfChannels = numberOfChannels
    this.length = length
    this.sampleRate = sampleRate
    this.duration = length / sampleRate
    this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length))
  }

  getChannelData(channel: number): Float32Array {
    return this.channels[channel] ?? this.channels[0]!
  }

  copyToChannel(source: Float32Array, channelNumber: number, bufferOffset = 0): void {
    const dest = this.channels[channelNumber]
    if (!dest) return
    dest.set(source.subarray(0, Math.max(0, dest.length - bufferOffset)), bufferOffset)
  }
}

abstract class BaseNode {
  readonly outputs = new Set<BaseNode>()
  readonly inputs = new Set<BaseNode>()
  private cachedStart = -1
  private cachedL = new Float32Array(0)
  private cachedR = new Float32Array(0)

  connect(destination: BaseNode): BaseNode {
    this.outputs.add(destination)
    destination.inputs.add(this)
    return destination
  }

  disconnect(): void {
    for (const out of this.outputs) out.inputs.delete(this)
    this.outputs.clear()
  }

  renderBlock(startSample: number, count: number, sr: number, outL: Float32Array, outR: Float32Array): void {
    if (this.cachedStart === startSample && this.cachedL.length === count) {
      outL.set(this.cachedL)
      outR.set(this.cachedR)
      return
    }
    if (this.cachedL.length !== count) {
      this.cachedL = new Float32Array(count)
      this.cachedR = new Float32Array(count)
    }
    this.cachedL.fill(0)
    this.cachedR.fill(0)
    this.computeBlock(startSample, count, sr, this.cachedL, this.cachedR)
    this.cachedStart = startSample
    outL.set(this.cachedL)
    outR.set(this.cachedR)
  }

  abstract computeBlock(startSample: number, count: number, sr: number, outL: Float32Array, outR: Float32Array): void

  protected sumInputs(startSample: number, count: number, sr: number): [Float32Array, Float32Array] {
    const l = new Float32Array(count)
    const r = new Float32Array(count)
    if (this.inputs.size === 0) return [l, r]
    const tmpL = new Float32Array(count)
    const tmpR = new Float32Array(count)
    for (const inp of this.inputs) {
      tmpL.fill(0)
      tmpR.fill(0)
      inp.renderBlock(startSample, count, sr, tmpL, tmpR)
      for (let i = 0; i < count; i++) {
        l[i]! += tmpL[i]!
        r[i]! += tmpR[i]!
      }
    }
    return [l, r]
  }
}

class GainNodeImpl extends BaseNode {
  readonly gain = new DeterministicAudioParam(1)

  computeBlock(startSample: number, count: number, sr: number, outL: Float32Array, outR: Float32Array): void {
    const [inL, inR] = this.sumInputs(startSample, count, sr)
    for (let i = 0; i < count; i++) {
      const g = this.gain.sampleAt((startSample + i) / sr)
      outL[i] = inL[i]! * g
      outR[i] = inR[i]! * g
    }
  }
}

class StereoPannerNodeImpl extends BaseNode {
  readonly pan = new DeterministicAudioParam(0)

  computeBlock(startSample: number, count: number, sr: number, outL: Float32Array, outR: Float32Array): void {
    const [inL, inR] = this.sumInputs(startSample, count, sr)
    for (let i = 0; i < count; i++) {
      const p = clamp(this.pan.sampleAt((startSample + i) / sr), -1, 1)
      const angle = ((p + 1) * Math.PI) / 4
      const gl = Math.cos(angle)
      const gr = Math.sin(angle)
      const mono = (inL[i]! + inR[i]!) * 0.5
      outL[i] = mono * gl
      outR[i] = mono * gr
    }
  }
}

class BiquadFilterNodeImpl extends BaseNode {
  type: BiquadFilterType = "lowpass"
  readonly frequency = new DeterministicAudioParam(350)
  readonly Q = new DeterministicAudioParam(1)
  readonly gain = new DeterministicAudioParam(0)
  private lpL = 0
  private lpR = 0
  private hpL = 0
  private hpR = 0

  computeBlock(startSample: number, count: number, sr: number, outL: Float32Array, outR: Float32Array): void {
    const [inL, inR] = this.sumInputs(startSample, count, sr)
    for (let i = 0; i < count; i++) {
      const fc = clamp(this.frequency.sampleAt((startSample + i) / sr), 20, sr * 0.48)
      const dt = 1 / sr
      const rc = 1 / (2 * Math.PI * fc)
      const alpha = clamp(dt / (rc + dt), 0.001, 0.999)
      this.lpL += alpha * (inL[i]! - this.lpL)
      this.lpR += alpha * (inR[i]! - this.lpR)

      if (this.type === "lowpass" || this.type === "highshelf" || this.type === "peaking") {
        outL[i] = this.lpL
        outR[i] = this.lpR
      } else if (this.type === "highpass") {
        outL[i] = inL[i]! - this.lpL
        outR[i] = inR[i]! - this.lpR
      } else {
        // bandpass
        const hpRc = 1 / (2 * Math.PI * Math.max(20, fc * 0.7))
        const hpAlpha = clamp(hpRc / (hpRc + dt), 0.001, 0.999)
        this.hpL = hpAlpha * (this.hpL + this.lpL) * 0.5
        this.hpR = hpAlpha * (this.hpR + this.lpR) * 0.5
        outL[i] = (this.lpL - inL[i]! * 0.25) * 0.85
        outR[i] = (this.lpR - inR[i]! * 0.25) * 0.85
      }
    }
  }
}

class ConvolverNodeImpl extends BaseNode {
  buffer: DeterministicAudioBuffer | null = null
  private ringL = new Float32Array(48000 * 2)
  private ringR = new Float32Array(48000 * 2)
  private writePtr = 0
  private tailL = 0
  private tailR = 0

  computeBlock(startSample: number, count: number, sr: number, outL: Float32Array, outR: Float32Array): void {
    const [inL, inR] = this.sumInputs(startSample, count, sr)
    if (!this.buffer) {
      outL.set(inL)
      outR.set(inR)
      return
    }
    const ringLen = this.ringL.length
    const tap1 = Math.floor(0.043 * sr)
    const tap2 = Math.floor(0.091 * sr)
    const tap3 = Math.floor(0.145 * sr)
    const tap4 = Math.floor(0.24 * sr)
    const decay = Math.exp(-1 / (sr * 0.38))

    for (let i = 0; i < count; i++) {
      const w = this.writePtr
      this.ringL[w] = inL[i]!
      this.ringR[w] = inR[i]!

      const eL =
        this.ringL[(w - tap1 + ringLen) % ringLen]! * 0.42 +
        this.ringL[(w - tap2 + ringLen) % ringLen]! * 0.3 +
        this.ringL[(w - tap3 + ringLen) % ringLen]! * 0.22 +
        this.ringL[(w - tap4 + ringLen) % ringLen]! * 0.15
      const eR =
        this.ringR[(w - tap1 + ringLen) % ringLen]! * 0.4 +
        this.ringR[(w - tap2 + ringLen) % ringLen]! * 0.32 +
        this.ringR[(w - tap3 + ringLen) % ringLen]! * 0.2 +
        this.ringR[(w - tap4 + ringLen) % ringLen]! * 0.16

      this.tailL = this.tailL * decay + (inL[i]! * 0.015 + eL * 0.045)
      this.tailR = this.tailR * decay + (inR[i]! * 0.015 + eR * 0.045)

      outL[i] = eL * 0.45 + this.tailL
      outR[i] = eR * 0.45 + this.tailR
      this.writePtr = (w + 1) % ringLen
    }
  }
}

class DynamicsCompressorNodeImpl extends BaseNode {
  readonly threshold = new DeterministicAudioParam(-24)
  readonly knee = new DeterministicAudioParam(30)
  readonly ratio = new DeterministicAudioParam(12)
  readonly attack = new DeterministicAudioParam(0.003)
  readonly release = new DeterministicAudioParam(0.25)
  private env = 0

  computeBlock(startSample: number, count: number, sr: number, outL: Float32Array, outR: Float32Array): void {
    const [inL, inR] = this.sumInputs(startSample, count, sr)
    const threshDb = this.threshold.value
    const ratio = Math.max(1, this.ratio.value)
    const att = Math.exp(-1 / (Math.max(0.0005, this.attack.value) * sr))
    const rel = Math.exp(-1 / (Math.max(0.005, this.release.value) * sr))

    for (let i = 0; i < count; i++) {
      const peak = Math.max(Math.abs(inL[i]!), Math.abs(inR[i]!))
      this.env = peak > this.env ? att * this.env + (1 - att) * peak : rel * this.env + (1 - rel) * peak
      let gain = 1
      if (this.env > 1e-6) {
        const db = 20 * Math.log10(this.env)
        if (db > threshDb) {
          const compressedDb = threshDb + (db - threshDb) / ratio
          gain = Math.pow(10, (compressedDb - db) / 20)
        }
      }
      outL[i] = Math.tanh(inL[i]! * gain)
      outR[i] = Math.tanh(inR[i]! * gain)
    }
  }
}

class PeriodicWaveImpl {
  constructor(
    readonly real: Float32Array,
    readonly imag: Float32Array,
  ) {}
}

class OscillatorNodeImpl extends BaseNode {
  type: OscillatorType = "sine"
  readonly frequency = new DeterministicAudioParam(440)
  readonly detune = new DeterministicAudioParam(0)
  onended: (() => void) | null = null
  private periodicWave: PeriodicWaveImpl | null = null
  private startTime = Infinity
  private stopTime = Infinity
  private phase = 0
  private endedFired = false

  setPeriodicWave(wave: PeriodicWaveImpl): void {
    this.periodicWave = wave
  }

  start(when = 0): void {
    this.startTime = Math.max(0, when)
  }

  stop(when = 0): void {
    this.stopTime = Math.max(this.startTime, when)
  }

  computeBlock(startSample: number, count: number, sr: number, outL: Float32Array, outR: Float32Array): void {
    for (let i = 0; i < count; i++) {
      const t = (startSample + i) / sr
      if (t < this.startTime || t >= this.stopTime) {
        if (t >= this.stopTime && !this.endedFired) {
          this.endedFired = true
          this.onended?.()
        }
        continue
      }
      const freq = this.frequency.sampleAt(t) * Math.pow(2, this.detune.value / 1200)
      this.phase = (this.phase + (2 * Math.PI * freq) / sr) % (2 * Math.PI)
      let s = 0
      if (this.periodicWave) {
        const imag = this.periodicWave.imag
        const maxH = Math.min(12, imag.length - 1)
        for (let n = 1; n <= maxH; n++) {
          if (freq * n >= sr * 0.45) break
          s += imag[n]! * Math.sin(this.phase * n)
        }
        s *= 0.45
      } else if (this.type === "sine") {
        s = Math.sin(this.phase)
      } else if (this.type === "triangle") {
        s = (2 / Math.PI) * Math.asin(Math.sin(this.phase))
      } else if (this.type === "square") {
        s = Math.sin(this.phase) >= 0 ? 0.8 : -0.8
      } else {
        s = 1 - this.phase / Math.PI
      }
      outL[i] = s
      outR[i] = s
    }
  }
}

class AudioBufferSourceNodeImpl extends BaseNode {
  buffer: DeterministicAudioBuffer | null = null
  loop = false
  readonly playbackRate = new DeterministicAudioParam(1)
  onended: (() => void) | null = null
  private startTime = Infinity
  private stopTime = Infinity
  private pos = 0
  private started = false
  private endedFired = false

  start(when = 0, offset = 0, duration?: number): void {
    this.startTime = Math.max(0, when)
    this.pos = Math.max(0, offset)
    if (duration !== undefined) {
      this.stopTime = this.startTime + Math.max(0, duration)
    }
  }

  stop(when = 0): void {
    this.stopTime = Math.max(this.startTime, when)
  }

  computeBlock(startSample: number, count: number, sr: number, outL: Float32Array, outR: Float32Array): void {
    const buf = this.buffer
    if (!buf || buf.length === 0) return
    const ch0 = buf.getChannelData(0)
    const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : ch0
    const bufSr = buf.sampleRate

    for (let i = 0; i < count; i++) {
      const t = (startSample + i) / sr
      if (t < this.startTime) continue
      if (t >= this.stopTime) {
        if (!this.endedFired) {
          this.endedFired = true
          this.onended?.()
        }
        break
      }
      if (!this.started) {
        this.started = true
        this.pos = this.pos * bufSr
      }
      let idx = Math.floor(this.pos)
      if (idx >= buf.length) {
        if (this.loop) {
          this.pos = this.pos % buf.length
          idx = Math.floor(this.pos)
        } else {
          if (!this.endedFired) {
            this.endedFired = true
            this.onended?.()
          }
          break
        }
      }
      outL[i] = ch0[idx] ?? 0
      outR[i] = ch1[idx] ?? 0
      const rate = Math.max(0.05, this.playbackRate.sampleAt(t))
      this.pos += (rate * bufSr) / sr
    }
  }
}

class DestinationNodeImpl extends BaseNode {
  computeBlock(startSample: number, count: number, sr: number, outL: Float32Array, outR: Float32Array): void {
    const [inL, inR] = this.sumInputs(startSample, count, sr)
    outL.set(inL)
    outR.set(inR)
  }
}

/**
 * Pure TypeScript `OfflineAudioContext` implementation for deterministic Bun unit tests
 * when running outside a browser.
 */
export class DeterministicOfflineAudioContext {
  readonly sampleRate: number
  readonly length: number
  readonly numberOfChannels: number
  readonly destination = new DestinationNodeImpl() as unknown as AudioDestinationNode
  currentTime = 0
  state: AudioContextState = "suspended"

  constructor(numberOfChannels = 2, length = 48000, sampleRate = 48000) {
    this.numberOfChannels = numberOfChannels
    this.length = length
    this.sampleRate = sampleRate
  }

  createGain(): GainNode {
    return new GainNodeImpl() as unknown as GainNode
  }

  createStereoPanner(): StereoPannerNode {
    return new StereoPannerNodeImpl() as unknown as StereoPannerNode
  }

  createBiquadFilter(): BiquadFilterNode {
    return new BiquadFilterNodeImpl() as unknown as BiquadFilterNode
  }

  createConvolver(): ConvolverNode {
    return new ConvolverNodeImpl() as unknown as ConvolverNode
  }

  createDynamicsCompressor(): DynamicsCompressorNode {
    return new DynamicsCompressorNodeImpl() as unknown as DynamicsCompressorNode
  }

  createOscillator(): OscillatorNode {
    return new OscillatorNodeImpl() as unknown as OscillatorNode
  }

  createBufferSource(): AudioBufferSourceNode {
    return new AudioBufferSourceNodeImpl() as unknown as AudioBufferSourceNode
  }

  createPeriodicWave(real: Float32Array, imag: Float32Array): PeriodicWave {
    return new PeriodicWaveImpl(new Float32Array(real), new Float32Array(imag)) as unknown as PeriodicWave
  }

  createBuffer(numberOfChannels: number, length: number, sampleRate: number): AudioBuffer {
    return new DeterministicAudioBuffer(numberOfChannels, length, sampleRate) as unknown as AudioBuffer
  }

  async decodeAudioData(_bytes: ArrayBuffer): Promise<AudioBuffer> {
    return this.createBuffer(2, Math.floor(this.sampleRate * 0.4), this.sampleRate)
  }

  async startRendering(): Promise<AudioBuffer> {
    const out = new DeterministicAudioBuffer(this.numberOfChannels, this.length, this.sampleRate)
    const chL = out.getChannelData(0)
    const chR = out.getChannelData(Math.min(1, this.numberOfChannels - 1))
    const dest = this.destination as unknown as DestinationNodeImpl
    const block = 512
    const tmpL = new Float32Array(block)
    const tmpR = new Float32Array(block)

    for (let offset = 0; offset < this.length; offset += block) {
      const count = Math.min(block, this.length - offset)
      tmpL.fill(0)
      tmpR.fill(0)
      this.currentTime = offset / this.sampleRate
      dest.renderBlock(offset, count, this.sampleRate, tmpL, tmpR)
      chL.set(tmpL.subarray(0, count), offset)
      chR.set(tmpR.subarray(0, count), offset)
    }
    this.currentTime = this.length / this.sampleRate
    this.state = "closed"
    return out as unknown as AudioBuffer
  }
}

export function getOfflineAudioContextConstructor(): typeof OfflineAudioContext {
  if (typeof OfflineAudioContext !== "undefined") return OfflineAudioContext
  return DeterministicOfflineAudioContext as unknown as typeof OfflineAudioContext
}
