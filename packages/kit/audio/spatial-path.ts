/** Shared continuous-source equivalent of the forest's world-sound chain. Callers supply the world query and send. */
export class SpatialPath {
  readonly input: BiquadFilterNode
  readonly gain: GainNode
  readonly delay: DelayNode
  readonly pan: PannerNode
  readonly wet: GainNode

  constructor(readonly ctx: BaseAudioContext, output: AudioNode, reverb?: AudioNode) {
    this.input = ctx.createBiquadFilter()
    this.input.type = "lowpass"
    this.input.Q.value = 0.5
    this.gain = ctx.createGain()
    this.gain.gain.value = 0
    this.delay = ctx.createDelay(0.25)
    this.pan = ctx.createPanner()
    this.pan.panningModel = "HRTF"
    this.pan.rolloffFactor = 0
    this.wet = ctx.createGain()
    this.wet.gain.value = 0
    this.input.connect(this.delay)
    this.delay.connect(this.gain).connect(this.pan).connect(output)
    if (reverb) this.delay.connect(this.wet).connect(reverb)
  }

  update(p: { x: number; y: number; z: number }, mix: { gain: number; cutoff: number; delay: number; wet: number }, now = this.ctx.currentTime, tau = 0.035): void {
    for (const [param, value] of [[this.gain.gain, mix.gain], [this.input.frequency, mix.cutoff], [this.delay.delayTime, mix.delay], [this.wet.gain, mix.wet], [this.pan.positionX, p.x], [this.pan.positionY, p.y], [this.pan.positionZ, p.z]] as const) {
      if (tau === 0) param.setValueAtTime(value, now)
      else param.setTargetAtTime(value, now, tau)
    }
  }

  dispose(): void { for (const n of [this.input, this.gain, this.delay, this.pan, this.wet]) n.disconnect() }
}
