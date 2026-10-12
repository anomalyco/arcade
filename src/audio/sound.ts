import type { Gun } from "../../shared/config"

/**
 * Synthesised sound. Gunshots are layered: a sharp noise crack, a low body thump and a short tail, panned and
 * attenuated by distance. Hitmarker ticks and the kill confirm are short tones in the middle of the mix.
 */
export class Sound {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private comp: DynamicsCompressorNode | null = null
  private noise: AudioBuffer | null = null
  muted = false

  start(): void {
    if (this.ctx) {
      void this.ctx.resume()
      return
    }
    const ctx = new AudioContext()
    this.ctx = ctx
    this.comp = ctx.createDynamicsCompressor()
    this.comp.threshold.value = -14
    this.comp.ratio.value = 6
    this.master = ctx.createGain()
    this.master.gain.value = 0.7
    this.master.connect(this.comp).connect(ctx.destination)
    const len = ctx.sampleRate
    const buf = ctx.createBuffer(1, len, ctx.sampleRate)
    const d = buf.getChannelData(0)
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
    this.noise = buf
    // Faint air-conditioning hum.
    const hum = ctx.createBufferSource()
    hum.buffer = buf
    hum.loop = true
    const lp = ctx.createBiquadFilter()
    lp.type = "lowpass"
    lp.frequency.value = 180
    const hg = ctx.createGain()
    hg.gain.value = 0.025
    hum.connect(lp).connect(hg).connect(this.master)
    hum.start()
  }

  setMuted(m: boolean): void {
    this.muted = m
    if (this.master) this.master.gain.value = m ? 0 : 0.7
  }

  private out(dx: number, dy: number, gain: number): AudioNode | null {
    const ctx = this.ctx
    if (!ctx || !this.master || this.muted) return null
    const d = Math.hypot(dx, dy)
    const g = ctx.createGain()
    g.gain.value = gain / (1 + d * d * 0.012)
    const pan = ctx.createStereoPanner()
    pan.pan.value = Math.max(-0.85, Math.min(0.85, dx / 12))
    g.connect(pan).connect(this.master)
    return g
  }

  private burst(dest: AudioNode, t: number, type: BiquadFilterType, freq: number, q: number, gain: number, attack: number, decay: number): void {
    const ctx = this.ctx!
    const src = ctx.createBufferSource()
    src.buffer = this.noise
    const f = ctx.createBiquadFilter()
    f.type = type
    f.frequency.value = freq
    f.Q.value = q
    const e = ctx.createGain()
    e.gain.setValueAtTime(0.0001, t)
    e.gain.exponentialRampToValueAtTime(gain, t + attack)
    e.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay)
    src.connect(f).connect(e).connect(dest)
    src.start(t, Math.random() * 0.5, attack + decay + 0.05)
  }

  private thump(dest: AudioNode, t: number, f0: number, f1: number, gain: number, decay: number): void {
    const ctx = this.ctx!
    const o = ctx.createOscillator()
    o.type = "sine"
    o.frequency.setValueAtTime(f0, t)
    o.frequency.exponentialRampToValueAtTime(f1, t + decay)
    const e = ctx.createGain()
    e.gain.setValueAtTime(gain, t)
    e.gain.exponentialRampToValueAtTime(0.0001, t + decay)
    o.connect(e).connect(dest)
    o.start(t)
    o.stop(t + decay + 0.02)
  }

  /** A gunshot from (dx, dy) metres away. `mine` is louder and drier. */
  shot(gun: Gun, dx: number, dy: number, mine: boolean): void {
    const dest = this.out(dx, dy, mine ? 1 : 0.8)
    if (!dest) return
    const t = this.ctx!.currentTime
    if (gun === "rifle") {
      this.burst(dest, t, "bandpass", 1800, 0.9, 0.9, 0.002, 0.06)
      this.thump(dest, t, 160, 45, 0.9, 0.12)
      this.burst(dest, t + 0.01, "lowpass", 900, 0.7, 0.35, 0.01, 0.22)
    } else if (gun === "shotgun") {
      this.burst(dest, t, "lowpass", 2400, 0.6, 1.2, 0.002, 0.1)
      this.thump(dest, t, 120, 32, 1.4, 0.25)
      this.burst(dest, t + 0.02, "lowpass", 500, 0.6, 0.6, 0.02, 0.5)
      this.burst(dest, t + 0.42, "bandpass", 2600, 4, 0.25, 0.005, 0.05)
      this.burst(dest, t + 0.55, "bandpass", 1900, 4, 0.25, 0.005, 0.06)
    } else {
      this.burst(dest, t, "highpass", 2500, 0.7, 1.1, 0.001, 0.05)
      this.thump(dest, t, 200, 38, 1.3, 0.3)
      this.burst(dest, t + 0.03, "lowpass", 700, 0.6, 0.5, 0.03, 1.1)
      this.burst(dest, t + 0.75, "bandpass", 2200, 5, 0.22, 0.005, 0.05)
    }
  }

  /** Bullet hitting a wall near you. */
  impact(dx: number, dy: number): void {
    const dest = this.out(dx, dy, 0.25)
    if (!dest) return
    this.burst(dest, this.ctx!.currentTime, "bandpass", 3200, 2, 0.6, 0.001, 0.05)
  }

  /** The hitmarker tick; `kill` adds the confirm chime. */
  hit(kill: boolean): void {
    const dest = this.out(0, 0, kill ? 0.5 : 0.35)
    if (!dest) return
    const ctx = this.ctx!
    const t = ctx.currentTime
    this.burst(dest, t, "highpass", 4000, 1, 0.8, 0.001, 0.03)
    if (!kill) return
    for (const [f, at] of [
      [880, 0.02],
      [1320, 0.09],
    ] as const) {
      const o = ctx.createOscillator()
      o.type = "triangle"
      o.frequency.value = f
      const e = ctx.createGain()
      e.gain.setValueAtTime(0.0001, t + at)
      e.gain.exponentialRampToValueAtTime(0.5, t + at + 0.01)
      e.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.25)
      o.connect(e).connect(dest)
      o.start(t + at)
      o.stop(t + at + 0.3)
    }
  }

  /** Taking a hit. */
  hurt(): void {
    const dest = this.out(0, 0, 0.7)
    if (!dest) return
    const t = this.ctx!.currentTime
    this.thump(dest, t, 90, 40, 1, 0.18)
    this.burst(dest, t, "lowpass", 600, 0.7, 0.6, 0.005, 0.12)
  }

  reload(dx: number, dy: number, gun: Gun): void {
    const dest = this.out(dx, dy, 0.4)
    if (!dest) return
    const t = this.ctx!.currentTime
    const clicks = gun === "shotgun" ? [0.2, 0.6, 1.0, 1.4, 2.0] : gun === "sniper" ? [0.3, 1.2, 2.2] : [0.25, 1.1, 1.6]
    for (const c of clicks) this.burst(dest, t + c, "bandpass", 2400 + Math.random() * 800, 5, 0.6, 0.002, 0.04)
  }

  step(dx: number, dy: number, mine: boolean): void {
    const dest = this.out(dx, dy, mine ? 0.12 : 0.18)
    if (!dest) return
    this.burst(dest, this.ctx!.currentTime, "bandpass", 300 + Math.random() * 120, 1.4, 0.7, 0.004, 0.07)
  }
}
