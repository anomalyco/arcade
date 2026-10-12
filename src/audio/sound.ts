import type { Gun } from "../../shared/config"
import { EV } from "../game/anim"

/**
 * Synthesised sound. Gunshots are layered: a transient click, a noise crack, a pitched body thump, a sub-bass drop
 * and a filtered tail, with a send into a short room reverb. Distant sources lose their top end. Gun mechanics,
 * footsteps and casings are driven by the animation so they land on the motion.
 */
export class Sound {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private comp: DynamicsCompressorNode | null = null
  private verb: ConvolverNode | null = null
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
    this.comp.threshold.value = -16
    this.comp.knee.value = 8
    this.comp.ratio.value = 5
    this.comp.attack.value = 0.002
    this.comp.release.value = 0.12
    this.master = ctx.createGain()
    this.master.gain.value = 0.75
    this.master.connect(this.comp).connect(ctx.destination)
    const len = ctx.sampleRate
    const buf = ctx.createBuffer(1, len, ctx.sampleRate)
    const d = buf.getChannelData(0)
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
    this.noise = buf
    // Office room: a short, dense, darkening reverb.
    const irLen = Math.floor(ctx.sampleRate * 1.3)
    const ir = ctx.createBuffer(2, irLen, ctx.sampleRate)
    for (let c = 0; c < 2; c++) {
      const ch = ir.getChannelData(c)
      let lp = 0
      for (let i = 0; i < irLen; i++) {
        const t = i / ctx.sampleRate
        lp += (Math.random() * 2 - 1 - lp) * Math.max(0.04, 0.6 - t * 0.6)
        ch[i] = lp * Math.exp(-t * 4.2) * (i < 200 ? i / 200 : 1)
      }
    }
    this.verb = ctx.createConvolver()
    this.verb.buffer = ir
    const vg = ctx.createGain()
    vg.gain.value = 0.55
    this.verb.connect(vg).connect(this.master)
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
    if (this.master) this.master.gain.value = m ? 0 : 0.75
  }

  /** A source (dx, dy) metres away: distance gain, pan, top end rolled off with distance, and a reverb send. */
  private out(dx: number, dy: number, gain: number, wet = 0.15): AudioNode | null {
    const ctx = this.ctx
    if (!ctx || !this.master || this.muted || ctx.state !== "running") return null
    const d = Math.hypot(dx, dy)
    const g = ctx.createGain()
    g.gain.value = gain / (1 + d * d * 0.01)
    const lp = ctx.createBiquadFilter()
    lp.type = "lowpass"
    lp.frequency.value = Math.min(20000, 22000 / (1 + d * 0.18))
    const pan = ctx.createStereoPanner()
    pan.pan.value = Math.max(-0.85, Math.min(0.85, dx / 12))
    g.connect(lp).connect(pan).connect(this.master)
    if (wet > 0 && this.verb) {
      const s = ctx.createGain()
      s.gain.value = wet * Math.min(2.5, 1 + d * 0.06)
      pan.connect(s).connect(this.verb)
    }
    return g
  }

  private burst(dest: AudioNode, t: number, type: BiquadFilterType, freq: number, q: number, gain: number, attack: number, decay: number, sweep = 1): void {
    const ctx = this.ctx!
    const src = ctx.createBufferSource()
    src.buffer = this.noise
    const f = ctx.createBiquadFilter()
    f.type = type
    f.frequency.setValueAtTime(freq, t)
    if (sweep !== 1) f.frequency.exponentialRampToValueAtTime(freq * sweep, t + attack + decay)
    f.Q.value = q
    const e = ctx.createGain()
    e.gain.setValueAtTime(0.0001, t)
    e.gain.exponentialRampToValueAtTime(gain, t + attack)
    e.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay)
    src.connect(f).connect(e).connect(dest)
    src.start(t, Math.random() * 0.5, attack + decay + 0.05)
  }

  private tone(dest: AudioNode, t: number, f0: number, f1: number, gain: number, decay: number, type: OscillatorType = "sine", attack = 0.001): void {
    const ctx = this.ctx!
    const o = ctx.createOscillator()
    o.type = type
    o.frequency.setValueAtTime(f0, t)
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + decay)
    const e = ctx.createGain()
    e.gain.setValueAtTime(0.0001, t)
    e.gain.exponentialRampToValueAtTime(gain, t + attack)
    e.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay)
    o.connect(e).connect(dest)
    o.start(t)
    o.stop(t + attack + decay + 0.02)
  }

  /** A gunshot from (dx, dy) metres away. `mine` is louder, with more low end. */
  shot(gun: Gun, dx: number, dy: number, mine: boolean): void {
    const dest = this.out(dx, dy, mine ? 1 : 0.85, gun === "rifle" ? 0.22 : 0.35)
    if (!dest) return
    const t = this.ctx!.currentTime
    const v = 0.94 + Math.random() * 0.12
    const sub = mine ? 1 : 0.6
    this.burst(dest, t, "highpass", 5000 * v, 0.7, 0.7, 0.0008, 0.012)
    if (gun === "rifle") {
      this.burst(dest, t, "bandpass", 2100 * v, 0.8, 1.1, 0.001, 0.055, 0.6)
      this.tone(dest, t, 170 * v, 55, 1.0, 0.09)
      this.tone(dest, t, 62, 34, 0.9 * sub, 0.16)
      this.burst(dest, t + 0.006, "lowpass", 1400, 0.7, 0.45, 0.006, 0.2, 0.4)
      this.burst(dest, t + 0.004, "bandpass", 3800, 5, 0.18, 0.001, 0.02)
    } else if (gun === "shotgun") {
      this.burst(dest, t, "lowpass", 3200 * v, 0.6, 1.5, 0.001, 0.12, 0.3)
      this.tone(dest, t, 130 * v, 34, 1.5, 0.26)
      this.tone(dest, t, 55, 26, 1.3 * sub, 0.42)
      this.burst(dest, t + 0.012, "lowpass", 700, 0.6, 0.8, 0.02, 0.6, 0.5)
    } else {
      this.burst(dest, t, "highpass", 2600 * v, 0.7, 1.4, 0.0008, 0.06)
      this.burst(dest, t, "bandpass", 1500 * v, 0.9, 1.0, 0.001, 0.09, 0.5)
      this.tone(dest, t, 210 * v, 36, 1.4, 0.32)
      this.tone(dest, t, 48, 24, 1.4 * sub, 0.55)
      this.burst(dest, t + 0.03, "lowpass", 900, 0.6, 0.6, 0.03, 1.3, 0.3)
    }
  }

  /** A round cracking past your head. */
  whiz(dx: number, dy: number, gun: Gun): void {
    const dest = this.out(dx, dy, gun === "sniper" ? 0.6 : 0.35, 0)
    if (!dest) return
    const t = this.ctx!.currentTime
    this.burst(dest, t, "bandpass", 5200, 3, 0.8, 0.002, 0.03)
    this.burst(dest, t + 0.01, "bandpass", 2600, 2, 0.4, 0.01, 0.12, 0.35)
  }

  /** Bullet hitting a wall. */
  impact(dx: number, dy: number): void {
    const dest = this.out(dx, dy, 0.35, 0.1)
    if (!dest) return
    const t = this.ctx!.currentTime
    this.burst(dest, t, "bandpass", 2800 + Math.random() * 1500, 1.5, 0.7, 0.001, 0.04)
    this.tone(dest, t, 260, 90, 0.35, 0.06)
    this.burst(dest, t + 0.03, "bandpass", 5000, 2, 0.12, 0.004, 0.12)
  }

  /** The hitmarker tick; `kill` adds a heavy thunk and the confirm chime. */
  hit(kill: boolean): void {
    const dest = this.out(0, 0, kill ? 0.55 : 0.4, 0)
    if (!dest) return
    const t = this.ctx!.currentTime
    this.burst(dest, t, "highpass", 4500, 1, 0.9, 0.0008, 0.025)
    this.tone(dest, t, 2600, 2200, 0.25, 0.035, "triangle")
    if (!kill) return
    this.tone(dest, t, 220, 70, 0.9, 0.14)
    this.burst(dest, t, "lowpass", 900, 0.7, 0.5, 0.002, 0.08)
    for (const [f, at] of [
      [988, 0.03],
      [1480, 0.1],
    ] as const) this.tone(dest, t + at, f, f, 0.42, 0.28, "triangle", 0.006)
  }

  /** Taking a hit. */
  hurt(): void {
    const dest = this.out(0, 0, 0.75, 0)
    if (!dest) return
    const t = this.ctx!.currentTime
    this.tone(dest, t, 110, 40, 1.1, 0.2)
    this.burst(dest, t, "lowpass", 700, 0.7, 0.7, 0.003, 0.12)
    this.burst(dest, t, "bandpass", 1800, 1.5, 0.3, 0.002, 0.05)
  }

  /** Mechanical sounds cued by the animation: magazines, charging handles, pumps, bolts, shells, raising the gun. */
  cue(ev: number, gun: Gun, dx: number, dy: number, mine: boolean): void {
    const dest = this.out(dx, dy, mine ? 0.5 : 0.55, 0.12)
    if (!dest) return
    const t = this.ctx!.currentTime
    const click = (at: number, f: number, g: number) => this.burst(dest, t + at, "bandpass", f * (0.95 + Math.random() * 0.1), 6, g, 0.0008, 0.025)
    const slide = (at: number, f: number, g: number, d: number, sweep = 1) => this.burst(dest, t + at, "bandpass", f, 2.5, g, 0.008, d, sweep)
    if (ev & EV.magOut) {
      click(0, 2300, 0.6)
      slide(0.01, 1500, 0.35, 0.07, 0.7)
    }
    if (ev & EV.magIn) {
      slide(0, 1300, 0.3, 0.04, 1.4)
      click(0.035, 2700, 0.9)
      this.tone(dest, t + 0.035, 320, 150, 0.35, 0.05)
    }
    if (ev & EV.charge) {
      slide(0, 1800, 0.4, 0.06, 0.7)
      click(0.06, 3200, 0.7)
      click(0.12, 2600, 0.9)
      slide(0.12, 1400, 0.3, 0.05)
    }
    if (ev & EV.pumpBack) {
      slide(0, 900, 0.7, 0.07, 1.6)
      click(0.06, 2200, 0.8)
      this.tone(dest, t + 0.06, 260, 140, 0.25, 0.05)
    }
    if (ev & EV.pumpFwd) {
      slide(0, 1200, 0.6, 0.06, 1.3)
      click(0.05, 2600, 0.9)
      this.tone(dest, t + 0.05, 300, 160, 0.3, 0.05)
    }
    if (ev & EV.boltOpen) {
      click(0, 3000, 0.6)
      slide(0.03, 2200, 0.4, 0.1, 0.6)
    }
    if (ev & EV.boltClose) {
      slide(0, 1600, 0.4, 0.08, 1.4)
      click(0.08, 3400, 0.9)
      click(0.13, 2400, 0.6)
    }
    if (ev & EV.shellIn) {
      slide(0, 1100, 0.4, 0.05, 1.5)
      click(0.045, 2000, 0.7)
    }
    if (ev & EV.raise) {
      slide(0, 700, 0.18, 0.18)
      click(0.14, 2600, 0.4)
    }
    if (ev & EV.grab) slide(0, 600, 0.15, 0.12)
  }

  /** A casing or magazine hitting the floor. */
  clink(dx: number, dy: number, mag: boolean): void {
    const dest = this.out(dx, dy, mag ? 0.5 : 0.18, 0.08)
    if (!dest) return
    const t = this.ctx!.currentTime
    if (mag) {
      this.tone(dest, t, 180, 90, 0.6, 0.07)
      this.burst(dest, t, "bandpass", 1600, 3, 0.5, 0.001, 0.05)
      return
    }
    const f = 4200 + Math.random() * 2400
    this.tone(dest, t, f, f * 0.98, 0.25, 0.09, "triangle")
    this.tone(dest, t, f * 1.47, f * 1.45, 0.12, 0.06, "sine")
  }

  /** A footfall: heel thump and a scuff, louder at a run. */
  step(dx: number, dy: number, mine: boolean, loud: number): void {
    const dest = this.out(dx, dy, (mine ? 0.12 : 0.2) * (0.35 + loud * 0.65), 0.05)
    if (!dest) return
    const t = this.ctx!.currentTime
    const v = 0.85 + Math.random() * 0.3
    this.tone(dest, t, 120 * v, 55, 0.7, 0.05)
    this.burst(dest, t, "lowpass", 380 * v, 1, 0.8, 0.003, 0.05)
    this.burst(dest, t + 0.015, "bandpass", 1300 * v, 1.2, 0.3 * loud + 0.05, 0.006, 0.06)
  }
}
