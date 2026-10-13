import { type BoomKind, boomsFor } from "./jet-boom"
import { mixer } from "./mixer"
import { type LoopHandle, sfx } from "./sfx-bank"

/**
 * Weapon sounds. The recorded cinematic slots (sfx-bank.ts) once loaded: the M61 as a seamless firing loop that cuts in
 * on the trigger with a recorded spin-down tail on release, distant bursts, the missile launch, bomb release, flares,
 * impacts and the explosions (jet-boom.ts); the procedural voices below are the placeholders until then. The cockpit
 * tones stay synthesized, smooth sines with proper envelopes, on the dry UI bus:
 * - the seeker: an AIM-9 growl (a sine warbled by a slow FM) while searching, a pure high tone when locked;
 * - warnings: a soft two-tone chime while an enemy locks us, a fast urgent one while a missile is inbound.
 * The procedural placeholders, started on the first user gesture:
 * - the own cannon: a buzz-saw at the rate of fire (a 50 Hz pulse train through a distortion and a band-pass, over a
 *   noise bed) while the trigger is held, a short spin-down when it stops; other jets' guns as a duller, distant layer;
 * - missile launch (a rushing noise sweep), bomb release (a clunk), explosions (a low boom, duller and later the
 *   further it is), flare pops, hit ticks on the target and thuds when we are hit;
 * - the seeker: an AIM-9 growl (a warbling low tone) while searching and a high steady tone when locked;
 * - warnings: slow beeps while an enemy locks us, fast high beeps while a missile is inbound.
 * Distances are metres from the listener; the speed of sound delays far explosions.
 */
export class WeaponAudio {
  volume = 0.6
  private ctx: AudioContext | null = null
  private master!: GainNode
  private white!: AudioBuffer
  private brown!: AudioBuffer
  private gunGain!: GainNode
  private farGunGain!: GainNode
  private seekGain!: GainNode
  private seekBase!: ConstantSourceNode
  private seekLfo!: OscillatorNode
  private seekLfoGain!: GainNode
  private warnGain!: GainNode
  private warnBase!: ConstantSourceNode
  private firing = false
  private seek: 0 | 1 | 2 = 0
  private warn: 0 | 1 | 2 = 0
  private warnPhase = 0
  private gunLoop: LoopHandle | null = null
  private farIn = 0

  constructor() {
    const start = () => {
      this.start()
      removeEventListener("pointerdown", start)
      removeEventListener("keydown", start)
    }
    addEventListener("pointerdown", start)
    addEventListener("keydown", start)
    document.addEventListener("visibilitychange", () => {
      if (!this.ctx) return
      if (document.hidden) void this.ctx.suspend()
      else void this.ctx.resume()
    })
  }

  private start(): void {
    if (this.ctx) return
    // The shared mix (mixer.ts): one context for every sound, this one on its own bus.
    const ctx = (this.ctx = mixer().start() as AudioContext | null)
    if (!ctx) return
    const rate = ctx.sampleRate
    const len = rate * 2
    this.white = ctx.createBuffer(1, len, rate)
    this.brown = ctx.createBuffer(1, len, rate)
    const w = this.white.getChannelData(0)
    const b = this.brown.getChannelData(0)
    let last = 0
    for (let i = 0; i < len; i++) {
      const r = Math.random() * 2 - 1
      w[i] = r
      last = (last + 0.02 * r) / 1.02
      b[i] = last * 3.5
    }
    this.master = ctx.createGain()
    this.master.gain.value = this.volume
    this.master.connect(mixer().bus.weapons)

    // Cannon: a pulse train at the rate of fire, clipped and band-passed, over a noise bed.
    const shaper = ctx.createWaveShaper()
    const curve = new Float32Array(1024)
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1
      curve[i] = Math.tanh(x * 6)
    }
    shaper.curve = curve
    const pulse = ctx.createOscillator()
    pulse.type = "sawtooth"
    pulse.frequency.value = 50
    const body = ctx.createBiquadFilter()
    body.type = "bandpass"
    body.frequency.value = 420
    body.Q.value = 0.8
    this.gunGain = ctx.createGain()
    this.gunGain.gain.value = 0
    pulse.connect(shaper).connect(body).connect(this.gunGain).connect(this.master)
    const noise = this.loop(this.white)
    const nf = ctx.createBiquadFilter()
    nf.type = "bandpass"
    nf.frequency.value = 1800
    nf.Q.value = 0.6
    const ng = ctx.createGain()
    ng.gain.value = 0.35
    noise.connect(nf).connect(ng).connect(this.gunGain)
    pulse.start()
    // Distant guns: the same buzz, muffled.
    this.farGunGain = ctx.createGain()
    this.farGunGain.gain.value = 0
    const far = ctx.createBiquadFilter()
    far.type = "lowpass"
    far.frequency.value = 500
    shaper.connect(far).connect(this.farGunGain).connect(this.master)

    // Cockpit tones on the dry UI bus: a sine with a quiet second harmonic for presence, both driven by one frequency
    // source (a ConstantSourceNode: `.offset` is the pitch), soft envelopes.
    const ui = mixer().bus.ui
    const tone = (f: number, to: AudioNode): ConstantSourceNode => {
      const base = ctx.createConstantSource()
      base.offset.value = f
      const o = ctx.createOscillator()
      o.frequency.value = 0
      const h = ctx.createOscillator()
      h.frequency.value = 0
      const twice = ctx.createGain()
      twice.gain.value = 2
      base.connect(o.frequency)
      base.connect(twice).connect(h.frequency)
      const hg = ctx.createGain()
      hg.gain.value = 0.12
      o.connect(to)
      h.connect(hg).connect(to)
      base.start()
      o.start()
      h.start()
      return base
    }
    // Seeker: an AIM-9 growl (a sine warbled by a slow FM) that becomes a pure high tone on lock.
    this.seekGain = ctx.createGain()
    this.seekGain.gain.value = 0
    const seekLp = ctx.createBiquadFilter()
    seekLp.type = "lowpass"
    seekLp.frequency.value = 3200
    this.seekGain.connect(seekLp).connect(ui)
    this.seekBase = tone(520, this.seekGain)
    this.seekLfo = ctx.createOscillator()
    this.seekLfo.frequency.value = 7.5
    this.seekLfoGain = ctx.createGain()
    this.seekLfoGain.gain.value = 45
    this.seekLfo.connect(this.seekLfoGain).connect(this.seekBase.offset)
    this.seekLfo.start()

    // Warning: a two-tone chime gated by `update`.
    this.warnGain = ctx.createGain()
    this.warnGain.gain.value = 0
    const warnLp = ctx.createBiquadFilter()
    warnLp.type = "lowpass"
    warnLp.frequency.value = 4000
    this.warnGain.connect(warnLp).connect(ui)
    this.warnBase = tone(988, this.warnGain)
  }

  private loop(buf: AudioBuffer): AudioBufferSourceNode {
    const s = this.ctx!.createBufferSource()
    s.buffer = buf
    s.loop = true
    s.start(0, Math.random() * 1.5)
    return s
  }

  private att(dist: number): number {
    return 1 / (1 + Math.max(0, dist) / 350)
  }

  /** A one-shot noise burst through a filter with an envelope. */
  private burst(buf: AudioBuffer, type: BiquadFilterType, f0: number, f1: number, gain: number, attack: number, length: number, delay = 0): void {
    const ctx = this.ctx
    if (!ctx || gain < 0.002) return
    const at = ctx.currentTime + delay
    const src = ctx.createBufferSource()
    src.buffer = buf
    const f = ctx.createBiquadFilter()
    f.type = type
    f.frequency.setValueAtTime(f0, at)
    f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), at + length)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, at)
    g.gain.linearRampToValueAtTime(gain, at + attack)
    g.gain.exponentialRampToValueAtTime(0.0001, at + length)
    src.connect(f).connect(g).connect(this.master)
    src.start(at, Math.random())
    src.stop(at + length + 0.05)
  }

  /**
   * Per frame: own gun firing, the loudest other gun (0..1 after distance), seeker state (0 off, 1 growl, 2 locked)
   * and warning state (0 none, 1 locked on, 2 missile inbound).
   */
  update(dt: number, gun: boolean, farGun: number, seek: 0 | 1 | 2, warn: 0 | 1 | 2): void {
    const ctx = this.ctx
    if (!ctx) return
    const now = ctx.currentTime
    this.master.gain.setTargetAtTime(this.volume, now, 0.1)
    // The M61: the recorded firing loop (kept running silent, so the trigger cuts it in instantly) and its spin-down tail.
    const bank = sfx(mixer())
    if (!this.gunLoop && bank.ready("gun-loop")) this.gunLoop = bank.loop("gun-loop", { bus: "weapons", reverb: 0.25 })
    if (gun !== this.firing) {
      this.firing = gun
      if (this.gunLoop) {
        this.gunLoop.set({ gain: gun ? 1.1 : 0, tc: gun ? 0.004 : 0.03 })
        if (!gun) bank.play("gun-tail", { bus: "weapons", gain: 0.9 })
      }
      this.gunGain.gain.setTargetAtTime(gun && !this.gunLoop ? 0.5 : 0, now, gun ? 0.005 : 0.04)
    }
    // Other jets' guns: recorded distant bursts while they fire, the procedural buzz until loaded.
    this.farIn -= dt
    if (farGun > 0.04 && this.farIn <= 0 && bank.play("gun-distant", { dist: 300 / Math.max(0.05, farGun) - 300, ref: 80, gain: 0.8 })) this.farIn = 1.1
    this.farGunGain.gain.setTargetAtTime(bank.ready("gun-distant") ? 0 : farGun * 0.25, now, 0.03)
    if (seek !== this.seek) {
      this.seek = seek
      this.seekGain.gain.setTargetAtTime(seek ? 0.05 : 0, now, 0.03)
      this.seekBase.offset.setTargetAtTime(seek === 2 ? 1240 : 520, now, 0.04)
      this.seekLfoGain.gain.setTargetAtTime(seek === 2 ? 0 : 45, now, 0.04)
    }
    if (warn !== this.warn) {
      this.warn = warn
      this.warnPhase = 0
    }
    // Chimes: locked on, a soft 988/784 Hz pair at 2 Hz; missile inbound, an urgent 1319/988 Hz pair at 6 Hz.
    if (warn) {
      const rate = warn === 2 ? 6 : 2
      this.warnPhase += dt * rate
      const ph = this.warnPhase % 1
      const on = ph < 0.42
      const hi = Math.floor(this.warnPhase) % 2 === 0
      this.warnBase.offset.setTargetAtTime(warn === 2 ? (hi ? 1319 : 988) : hi ? 988 : 784, now, 0.002)
      this.warnGain.gain.setTargetAtTime(on ? (warn === 2 ? 0.07 : 0.045) : 0, now, on ? 0.008 : 0.025)
    } else this.warnGain.gain.setTargetAtTime(0, now, 0.02)
  }

  /** A missile leaving a rail `dist` metres away. */
  missile(dist: number): void {
    if (this.ctx && sfx(mixer()).play("missile-launch", { dist, ref: 40, gain: 1, echo: 0.2, travel: true })) return
    const a = this.att(dist)
    this.burst(this.white, "bandpass", 300, 2500, 0.55 * a, 0.03, 1.1)
    this.burst(this.brown, "lowpass", 600, 150, 0.6 * a, 0.01, 0.6)
  }

  /** A bomb leaving the bay. */
  bomb(dist: number): void {
    if (this.ctx && sfx(mixer()).play("bomb-release", { dist, ref: 20 })) {
      if (dist < 50) sfx(mixer()).play("bomb-whistle", { dist: dist + 30, ref: 40, gain: 0.35, delay: 0.4 })
      return
    }
    this.burst(this.brown, "lowpass", 400, 120, 0.5 * this.att(dist), 0.005, 0.25)
  }

  /**
   * An explosion `dist` metres away (size 1 = a missile), heard after the sound's travel time: a recorded take for its
   * scenario (src/audio/jet-boom.ts) once loaded, else the procedural blast below.
   */
  explosion(dist: number, size = 1, kind: BoomKind = "missile"): void {
    if (this.ctx && boomsFor(mixer()).play(kind, dist, size)) return
    const a = this.att(dist) * Math.min(1.6, size)
    const delay = Math.min(3, dist / 343)
    const near = Math.max(0, 1 - dist / 2500)
    this.burst(this.brown, "lowpass", 300 + 900 * near, 60, 1.1 * a, 0.01, 1.8 + size * 0.8, delay)
    if (near > 0.3) this.burst(this.white, "highpass", 1200, 400, 0.35 * a * near, 0.002, 0.35, delay)
    // Close blasts punch through: engines, flybys and weather dip under them.
    if (near > 0.6) mixer().duck(1 - 0.5 * near, 0.6 + 0.4 * size, delay)
  }

  /** A flare burst `dist` metres away. */
  flare(dist: number): void {
    if (this.ctx && sfx(mixer()).play("flares", { dist, ref: 30, gain: 0.9, travel: true })) return
    const a = this.att(dist)
    for (let i = 0; i < 3; i++) this.burst(this.white, "bandpass", 2200, 900, 0.22 * a, 0.002, 0.18, i * 0.12)
  }

  /** Our rounds hit an enemy (a crisp tick), or a kill (a heavier one). */
  hit(kill = false): void {
    if (kill && this.ctx) sfx(mixer()).play("ui-kill", { bus: "ui", reverb: 0 })
    this.burst(this.white, "highpass", kill ? 2500 : 4000, kill ? 1500 : 3000, kill ? 0.3 : 0.16, 0.001, kill ? 0.12 : 0.05)
  }

  /** We were hit. */
  hurt(heavy = false): void {
    if (this.ctx && sfx(mixer()).play("impact-metal", { bus: "weapons", gain: heavy ? 1 : 0.6, reverb: 0.05 })) return
    this.burst(this.brown, "lowpass", heavy ? 500 : 900, 120, heavy ? 0.9 : 0.4, 0.002, heavy ? 0.6 : 0.18)
  }
}
