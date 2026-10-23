import { SpatialPath } from "../audio/spatial-path"
import { mulberry32 } from "../sim/rng"
import { radioStatic, voiceSpatial, type VoicePoint, type VoiceSpatialSettings } from "./spatial"

/** One remote microphone: a natural voice at their head plus the receiver in your hand while they key the radio. */
export class VoiceAudio {
  readonly input: GainNode
  readonly analyser: AnalyserNode
  readonly spatial: SpatialPath
  readonly output: GainNode
  private readonly radio: GainNode
  private readonly high: BiquadFilterNode
  private readonly low: BiquadFilterNode
  private readonly saturation: WaveShaperNode
  private readonly noise: AudioBufferSourceNode
  private readonly noiseGain: GainNode
  private readonly noiseBuffer: AudioBuffer
  private readonly nodes: AudioNode[]
  private radioOn = false
  private readonly samples = new Float32Array(512)
  private readonly clicks = new Set<AudioBufferSourceNode>()

  constructor(readonly ctx: BaseAudioContext, output: AudioNode, reverb?: AudioNode) {
    this.input = ctx.createGain()
    this.analyser = ctx.createAnalyser()
    this.analyser.fftSize = this.samples.length
    this.input.connect(this.analyser)
    this.output = ctx.createGain()
    this.output.gain.value = 0
    this.output.connect(output)
    // This per-player wet gate makes mute and voice volume affect the reverb as well.
    const wet = ctx.createGain()
    wet.gain.value = 0
    if (reverb) wet.connect(reverb)
    this.spatial = new SpatialPath(ctx, this.output, reverb ? wet : undefined)
    this.input.connect(this.spatial.input)
    this.high = ctx.createBiquadFilter(); this.high.type = "highpass"; this.high.frequency.value = 300
    this.low = ctx.createBiquadFilter(); this.low.type = "lowpass"; this.low.frequency.value = 3400
    this.saturation = ctx.createWaveShaper()
    this.saturation.curve = Float32Array.from({ length: 1024 }, (_, i) => Math.tanh((i / 1023 * 2 - 1) * 1.4) / Math.tanh(1.4))
    this.radio = ctx.createGain(); this.radio.gain.value = 0
    this.input.connect(this.high).connect(this.saturation).connect(this.low).connect(this.radio).connect(this.output)
    this.noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate)
    const data = this.noiseBuffer.getChannelData(0), random = mulberry32(713)
    for (let i = 0; i < data.length; i++) data[i] = random() * 2 - 1
    this.noise = ctx.createBufferSource(); this.noise.buffer = this.noiseBuffer; this.noise.loop = true
    this.noiseGain = ctx.createGain(); this.noiseGain.gain.value = 0
    this.noise.connect(this.noiseGain).connect(this.low)
    this.noise.start()
    this.nodes = [this.input, this.analyser, this.output, wet, this.radio, this.high, this.low, this.saturation, this.noise, this.noiseGain]
    this.wetGate = wet
  }
  private readonly wetGate: GainNode

  update(source: VoicePoint, listener: VoicePoint, occlusion: number, proximity: boolean, radio: boolean, volume: number, battery: number, settings: VoiceSpatialSettings): void {
    const d = Math.hypot(source.x - listener.x, source.y - listener.y, source.z - listener.z)
    const mix = voiceSpatial(d, occlusion, settings)
    if (!proximity && !radio) { mix.gain = 0; mix.wet = 0 }
    this.spatial.update(source, mix)
    const now = this.ctx.currentTime
    this.output.gain.setTargetAtTime(volume, now, 0.015)
    this.wetGate.gain.setTargetAtTime(volume, now, 0.015)
    if (radio !== this.radioOn && volume > 0) this.squelch(radio)
    this.radioOn = radio
    this.radio.gain.setTargetAtTime(radio ? 0.7 : 0, now, 0.012)
    this.noiseGain.gain.setTargetAtTime(radio ? radioStatic(d, battery, settings) : 0, now, 0.02)
  }

  level(): number {
    this.analyser.getFloatTimeDomainData(this.samples)
    return Math.sqrt(this.samples.reduce((sum, n) => sum + n * n, 0) / this.samples.length)
  }

  private squelch(on: boolean): void {
    const src = this.ctx.createBufferSource(), gain = this.ctx.createGain(), now = this.ctx.currentTime
    src.buffer = this.noiseBuffer
    gain.gain.setValueAtTime(on ? 0.045 : 0.03, now)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.045)
    src.connect(gain).connect(this.output)
    this.clicks.add(src)
    src.onended = () => { this.clicks.delete(src); src.disconnect(); gain.disconnect() }
    src.start(now); src.stop(now + 0.05)
  }

  dispose(): void {
    this.noise.stop()
    for (const s of this.clicks) s.stop()
    this.spatial.dispose()
    for (const n of this.nodes) n.disconnect()
  }
}
