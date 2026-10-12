import type { RingKind } from "../../shared/sim/world"

type Tone = { f: number; q: number; dur: number; gain: number; type: BiquadFilterType }

const KIND_TONE: Record<RingKind, Tone> = {
  step: { f: 380, q: 1.6, dur: 0.1, gain: 0.18, type: "bandpass" },
  run: { f: 300, q: 1.2, dur: 0.14, gain: 0.3, type: "bandpass" },
  splash: { f: 1400, q: 0.8, dur: 0.22, gain: 0.3, type: "bandpass" },
  crunch: { f: 3200, q: 1.5, dur: 0.12, gain: 0.25, type: "highpass" },
  shot: { f: 900, q: 0.9, dur: 0.18, gain: 0.45, type: "bandpass" },
  shotgun: { f: 180, q: 0.6, dur: 0.7, gain: 0.8, type: "lowpass" },
  reload: { f: 2200, q: 5, dur: 0.08, gain: 0.3, type: "bandpass" },
  dry: { f: 2600, q: 6, dur: 0.04, gain: 0.2, type: "bandpass" },
  glass: { f: 4200, q: 0.8, dur: 0.7, gain: 0.5, type: "highpass" },
  lamp: { f: 3000, q: 1, dur: 0.35, gain: 0.35, type: "highpass" },
  door: { f: 160, q: 0.8, dur: 0.4, gain: 0.45, type: "lowpass" },
  breaker: { f: 120, q: 0.7, dur: 0.6, gain: 0.55, type: "lowpass" },
  flare: { f: 2400, q: 1.2, dur: 0.5, gain: 0.14, type: "highpass" },
  emp: { f: 2800, q: 2.4, dur: 0.5, gain: 0.35, type: "bandpass" },
  alarm: { f: 1600, q: 8, dur: 0.6, gain: 0.35, type: "bandpass" },
  thud: { f: 240, q: 1, dur: 0.16, gain: 0.25, type: "lowpass" },
  death: { f: 110, q: 0.7, dur: 0.5, gain: 0.4, type: "lowpass" },
  ping: { f: 1200, q: 12, dur: 0.9, gain: 0.12, type: "bandpass" },
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
  ring(dx: number, dy: number, radius: number, kind: RingKind, mine: boolean): void {
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
