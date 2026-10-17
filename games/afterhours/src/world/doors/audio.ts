// Procedural door sounds (Web Audio, no samples): latch clicks, a stick-slip hinge creak, the closing thud, a
// chain-link gate rattle and the locked-door rattle. The AudioContext is created lazily on the first door use, which
// always comes from a key press, so nothing plays before user input. Never constructed in `?shot` mode.

export type DoorSound = "steel" | "wood" | "glass" | "gate"

type Voice = { ctx: AudioContext; out: AudioNode; t: number }

/** Per-material voicing: resonances of the leaf, thud weight and how much the hinge creaks. */
const VOICE: Record<DoorSound, { ring: number[]; thud: number; thudGain: number; creak: number; creakPitch: number; click: number }> = {
  steel: { ring: [620, 1480], thud: 62, thudGain: 0.9, creak: 0.55, creakPitch: 1, click: 2600 },
  wood: { ring: [240, 520], thud: 85, thudGain: 0.8, creak: 0.8, creakPitch: 0.8, click: 1900 },
  glass: { ring: [1900, 3400], thud: 120, thudGain: 0.45, creak: 0.15, creakPitch: 1.3, click: 3200 },
  gate: { ring: [900, 2300], thud: 70, thudGain: 0.5, creak: 0.9, creakPitch: 0.65, click: 2200 },
}

export class DoorAudio {
  private ac: AudioContext | null = null
  private master: GainNode | null = null
  private noise: AudioBuffer | null = null
  volume = 0.6

  /** Call from a user-input handler; creates/resumes the context. */
  unlock() {
    if (!this.ac) {
      const Ctor = globalThis.AudioContext ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctor) return
      this.ac = new Ctor()
      this.master = this.ac.createGain()
      this.master.connect(this.ac.destination)
      const n = this.ac.sampleRate
      this.noise = this.ac.createBuffer(1, n, n)
      const d = this.noise.getChannelData(0)
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1
    }
    if (this.ac.state === "suspended") void this.ac.resume()
  }

  private voice(pan: number, delay = 0): Voice | null {
    const ac = this.ac
    if (!ac || !this.master || ac.state !== "running" || this.volume <= 0) return null
    this.master.gain.value = this.volume
    const p = ac.createStereoPanner()
    p.pan.value = Math.max(-0.8, Math.min(0.8, pan))
    p.connect(this.master)
    return { ctx: ac, out: p, t: ac.currentTime + 0.005 + delay }
  }

  /** Short filtered noise burst through the leaf's resonances. */
  private burst(v: Voice, at: number, len: number, gain: number, hp: number, ring: number[]) {
    const src = v.ctx.createBufferSource()
    src.buffer = this.noise
    const f = v.ctx.createBiquadFilter()
    f.type = "highpass"
    f.frequency.value = hp
    const g = v.ctx.createGain()
    g.gain.setValueAtTime(0, at)
    g.gain.linearRampToValueAtTime(gain, at + 0.002)
    g.gain.exponentialRampToValueAtTime(0.0001, at + len)
    src.connect(f).connect(g)
    g.connect(v.out)
    for (const r of ring) {
      const b = v.ctx.createBiquadFilter()
      b.type = "bandpass"
      b.frequency.value = r
      b.Q.value = 18
      const bg = v.ctx.createGain()
      bg.gain.value = 0.9
      g.connect(b).connect(bg).connect(v.out)
    }
    src.start(at, Math.random() * 0.5, len + 0.05)
  }

  private thud(v: Voice, at: number, hz: number, gain: number) {
    const o = v.ctx.createOscillator()
    o.frequency.setValueAtTime(hz * 1.6, at)
    o.frequency.exponentialRampToValueAtTime(hz, at + 0.06)
    const g = v.ctx.createGain()
    g.gain.setValueAtTime(0, at)
    g.gain.linearRampToValueAtTime(gain, at + 0.004)
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.22)
    o.connect(g).connect(v.out)
    o.start(at)
    o.stop(at + 0.25)
    const src = v.ctx.createBufferSource()
    src.buffer = this.noise
    const lp = v.ctx.createBiquadFilter()
    lp.type = "lowpass"
    lp.frequency.value = 420
    const ng = v.ctx.createGain()
    ng.gain.setValueAtTime(gain * 0.7, at)
    ng.gain.exponentialRampToValueAtTime(0.0001, at + 0.12)
    src.connect(lp).connect(ng).connect(v.out)
    src.start(at, Math.random() * 0.5, 0.15)
  }

  /** Stick-slip hinge creak: an irregular impulse train through two narrow resonances, swelling and fading. */
  private creak(v: Voice, at: number, len: number, gain: number, pitch: number) {
    const ac = v.ctx
    const rate = ac.sampleRate
    const n = Math.floor(len * rate)
    const buf = ac.createBuffer(1, n, rate)
    const d = buf.getChannelData(0)
    let next = 0
    let period = 0.009 / pitch
    for (let i = 0; i < n; i++) {
      if (i >= next) {
        const u = i / n
        d[i] = (0.6 + Math.random() * 0.4) * Math.sin(Math.PI * u) ** 0.7
        // The period drifts (the hinge speeds up and slows down) with per-slip jitter.
        period = Math.max(0.0035, Math.min(0.016, period * (0.97 + Math.random() * 0.06) + Math.sin(u * 9) * 0.00008))
        next = i + Math.floor(period * rate * (0.85 + Math.random() * 0.3))
      }
    }
    const src = ac.createBufferSource()
    src.buffer = buf
    const g = ac.createGain()
    g.gain.value = gain
    for (const [hz, q] of [[720 * pitch, 14], [1650 * pitch, 10]] as const) {
      const b = ac.createBiquadFilter()
      b.type = "bandpass"
      b.frequency.value = hz
      b.Q.value = q
      src.connect(b).connect(g)
    }
    g.connect(v.out)
    src.start(at)
  }

  /** Latch released and the leaf starting to move. */
  open(kind: DoorSound, pan: number) {
    const v = this.voice(pan)
    if (!v) return
    const s = VOICE[kind]
    this.burst(v, v.t, 0.03, 0.35, s.click, s.ring)
    this.burst(v, v.t + 0.05, 0.02, 0.18, s.click * 0.8, s.ring)
    if (kind === "gate") for (let i = 0; i < 5; i++) this.burst(v, v.t + 0.05 + Math.random() * 0.4, 0.04, 0.12, 2500, s.ring)
    this.creak(v, v.t + 0.06, 0.55, s.creak * 1.6, s.creakPitch * (0.9 + Math.random() * 0.2))
  }

  /** The leaf starting to close (a fainter creak; the thud comes from `latch`). */
  closing(kind: DoorSound, pan: number) {
    const v = this.voice(pan)
    if (!v) return
    const s = VOICE[kind]
    this.creak(v, v.t, 0.45, s.creak, s.creakPitch * (1.05 + Math.random() * 0.15))
  }

  /** Leaf meets the frame and the latch catches. */
  latch(kind: DoorSound, pan: number, speed: number) {
    const v = this.voice(pan)
    if (!v) return
    const s = VOICE[kind]
    const k = Math.min(1, 0.4 + speed * 0.4)
    this.thud(v, v.t, s.thud, s.thudGain * k)
    this.burst(v, v.t + 0.004, 0.06, 0.3 * k, s.click * 0.6, s.ring)
    this.burst(v, v.t + 0.07, 0.015, 0.3, s.click, s.ring)
    if (kind === "gate") for (let i = 0; i < 4; i++) this.burst(v, v.t + 0.03 + i * 0.05 + Math.random() * 0.03, 0.05, 0.14, 2500, s.ring)
  }

  /** Locked: the handle tried a few times, the leaf knocking in its frame. */
  rattle(kind: DoorSound, pan: number) {
    const v = this.voice(pan)
    if (!v) return
    const s = VOICE[kind]
    for (let i = 0; i < 3; i++) {
      const at = v.t + i * 0.085 + Math.random() * 0.015
      this.burst(v, at, 0.025, 0.3, s.click, s.ring)
      this.thud(v, at + 0.01, s.thud * 1.4, s.thudGain * 0.35)
    }
  }
}
