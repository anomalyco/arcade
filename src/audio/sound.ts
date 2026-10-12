import type { RippleKind } from "../../shared/sim/world"

const KIND_TONE: Record<RippleKind, { f: number; q: number; dur: number; gain: number; type: BiquadFilterType }> = {
  step: { f: 420, q: 1.4, dur: 0.12, gain: 0.22, type: "bandpass" },
  shot: { f: 220, q: 0.7, dur: 0.5, gain: 0.5, type: "lowpass" },
  reload: { f: 1800, q: 4, dur: 0.1, gain: 0.3, type: "bandpass" },
  glass: { f: 3800, q: 0.9, dur: 0.6, gain: 0.45, type: "highpass" },
  slam: { f: 160, q: 0.8, dur: 0.45, gain: 0.5, type: "lowpass" },
  creak: { f: 620, q: 3, dur: 0.6, gain: 0.12, type: "bandpass" },
  flare: { f: 2400, q: 1.2, dur: 0.22, gain: 0.12, type: "highpass" },
  decoy: { f: 900, q: 2, dur: 0.35, gain: 0.32, type: "bandpass" },
  emp: { f: 2800, q: 2.4, dur: 0.4, gain: 0.35, type: "bandpass" },
  mine: { f: 120, q: 0.6, dur: 0.7, gain: 0.7, type: "lowpass" },
  thud: { f: 260, q: 1, dur: 0.18, gain: 0.25, type: "lowpass" },
}

/**
 * Spatial audio, all synthesised: a very quiet room tone, rings as panned and distance-attenuated noise bursts, a
 * heartbeat that rises when an enemy ring lands close, and a short thump for kills.
 */
export class Sound {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private noise: AudioBuffer | null = null
  private nextBeat = 0
  muted = false

  start(): void {
    if (this.ctx) {
      void this.ctx.resume()
      return
    }
    const ctx = new AudioContext()
    this.ctx = ctx
    this.master = ctx.createGain()
    this.master.gain.value = 0.8
    this.master.connect(ctx.destination)
    const len = ctx.sampleRate * 2
    const buf = ctx.createBuffer(1, len, ctx.sampleRate)
    const d = buf.getChannelData(0)
    let last = 0
    for (let i = 0; i < len; i++) {
      last = (last + (Math.random() * 2 - 1) * 0.04) / 1.04
      d[i] = last * 3.5
    }
    this.noise = buf
    const room = ctx.createBufferSource()
    room.buffer = buf
    room.loop = true
    const lp = ctx.createBiquadFilter()
    lp.type = "lowpass"
    lp.frequency.value = 140
    const g = ctx.createGain()
    g.gain.value = 0.05
    room.connect(lp).connect(g).connect(this.master)
    room.start()
    for (const f of [41, 61.5]) {
      const o = ctx.createOscillator()
      o.frequency.value = f
      const og = ctx.createGain()
      og.gain.value = 0.012
      o.connect(og).connect(this.master)
      o.start()
    }
  }

  setMuted(m: boolean): void {
    this.muted = m
    if (this.master) this.master.gain.value = m ? 0 : 0.8
  }

  /** A ring at (dx, dy) metres from the listener, reaching `radius`. */
  ring(dx: number, dy: number, radius: number, kind: RippleKind, mine: boolean): void {
    const ctx = this.ctx
    if (!ctx || !this.master || !this.noise || this.muted) return
    const dist = Math.hypot(dx, dy)
    const att = Math.max(0.04, 1 - dist / (radius + 14))
    const tone = KIND_TONE[kind]
    const src = ctx.createBufferSource()
    src.buffer = this.noise
    const filt = ctx.createBiquadFilter()
    filt.type = tone.type
    filt.frequency.value = tone.f * (dist < radius ? 1 : 0.6)
    filt.Q.value = tone.q
    const env = ctx.createGain()
    const t = ctx.currentTime
    const g = tone.gain * att * (mine ? 0.5 : 1)
    env.gain.setValueAtTime(g, t)
    env.gain.exponentialRampToValueAtTime(0.0002, t + tone.dur * (0.6 + att * 0.6))
    const pan = ctx.createStereoPanner()
    pan.pan.value = Math.max(-0.9, Math.min(0.9, dx / 16))
    src.connect(filt).connect(env).connect(pan).connect(this.master)
    src.start(t, Math.random() * 0.5, tone.dur * 3)
  }

  shot(suppressed: boolean): void {
    this.ring(0, 0, suppressed ? 1 : 3, "shot", true)
  }

  /** Crisp kill cue: a low thump with a short high sweep. */
  kill(): void {
    const ctx = this.ctx
    if (!ctx || !this.master || this.muted) return
    const t = ctx.currentTime
    const o = ctx.createOscillator()
    o.frequency.setValueAtTime(90, t)
    o.frequency.exponentialRampToValueAtTime(40, t + 0.25)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.35, t)
    g.gain.exponentialRampToValueAtTime(0.0002, t + 0.3)
    o.connect(g).connect(this.master)
    o.start(t)
    o.stop(t + 0.32)
  }

  /** Heartbeat. `rate` is beats per minute, 0 to stop. */
  heart(rate: number): void {
    const ctx = this.ctx
    if (!ctx || !this.master || this.muted || rate <= 0) return
    const t = ctx.currentTime
    if (t < this.nextBeat) return
    this.nextBeat = t + 60 / rate
    for (const [at, amp] of [
      [0, 0.5],
      [0.16, 0.32],
    ] as const) {
      const o = ctx.createOscillator()
      o.frequency.value = 52
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.0001, t + at)
      g.gain.exponentialRampToValueAtTime(amp * 0.35, t + at + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.14)
      o.connect(g).connect(this.master)
      o.start(t + at)
      o.stop(t + at + 0.16)
    }
  }
}
