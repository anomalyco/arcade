import { type BoomKind, boomsFor } from "./jet-boom"
import { mixer } from "./mixer"
import type { Bullets } from "../../shared/combat"
import { GunAudio } from "./gun-audio"
import { clamp } from "./jet-math"
import { sfx } from "./sfx-bank"

/**
 * Weapon sounds. Anything tied to live, trigger-driven state is procedural: the M61 (gun-audio.ts, locked to the gun's
 * real cadence, yours and the loudest other jet's) and rounds cracking past the camera (`zips`, from each round's live
 * path). Discrete events use the recorded cinematic slots (sfx-bank.ts) once loaded: the missile launch, bomb release,
 * flares, impacts and the explosions (jet-boom.ts), with the procedural voices below as placeholders until then. The
 * cockpit tones are synthesized, smooth sines with proper envelopes, on the dry UI bus:
 * - the seeker: an AIM-9 growl (a sine warbled by a slow FM) while searching, a pure high tone when locked;
 * - warnings: a soft two-tone chime while an enemy locks us, a fast urgent one while a missile is inbound.
 * The procedural placeholders, started on the first user gesture:
 * - missile launch (a rushing noise sweep), bomb release (a clunk), explosions (a low boom, duller and later the
 *   further it is), flare pops and thuds when we are hit (hit confirmations: hit-audio.ts);
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
  private gun!: GunAudio
  private zipAt = 0
  private seekGain!: GainNode
  private seekBase!: ConstantSourceNode
  private seekLfo!: OscillatorNode
  private seekLfoGain!: GainNode
  private warnGain!: GainNode
  private warnBase!: ConstantSourceNode
  private seek: 0 | 1 | 2 = 0
  private warn: 0 | 1 | 2 = 0
  private warnPhase = 0

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

    // The M61 (gun-audio.ts): procedural, locked to the gun's cadence.
    this.gun = new GunAudio(mixer())

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
    // The M61: your gun (trigger, selected, not overheated) and the loudest other one.
    this.gun.update(gun, farGun)
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

  /**
   * Rounds cracking past the camera: every live round in `b` (other jets' cosmetic rounds) whose straight path comes
   * within 14 m of the listener during the next `dt` seconds gets a supersonic crack and a short whiz at exactly that
   * moment, panned to its side. At most three a frame, 25 ms apart.
   */
  zips(b: Bullets, dt: number): void {
    const ctx = this.ctx
    if (!ctx || !b.live) return
    const L = mixer().listener
    const now = ctx.currentTime
    let n = 0
    for (let i = 0; i < b.cap && n < 3; i++) {
      if (!b.state[i]) continue
      const rx = b.x[i]! - L.eye[0]
      const ry = b.y[i]! - L.eye[1]
      const rz = b.z[i]! - L.eye[2]
      const vx = b.vx[i]! - L.vel[0]
      const vy = b.vy[i]! - L.vel[1]
      const vz = b.vz[i]! - L.vel[2]
      const v2 = vx * vx + vy * vy + vz * vz
      if (v2 < 1) continue
      const t = -(rx * vx + ry * vy + rz * vz) / v2
      if (t < 0 || t >= dt) continue
      const mx = rx + vx * t
      const my = ry + vy * t
      const mz = rz + vz * t
      const miss = Math.hypot(mx, my, mz)
      if (miss > 14) continue
      const at = Math.max(now + t, this.zipAt + 0.025)
      if (at > now + dt + 0.05) continue
      this.zipAt = at
      const side = clamp((mx * L.right[0] + my * L.right[1] + mz * L.right[2]) / Math.max(1, miss), -1, 1)
      this.zip(at, 1 - miss / 14, side)
      n++
    }
  }

  /** One round going past: a crack (the shock wave) and a whiz falling in pitch. */
  private zip(at: number, near: number, side: number): void {
    const ctx = this.ctx!
    const pan = ctx.createStereoPanner()
    pan.pan.value = side * 0.8
    pan.connect(this.master)
    const crack = ctx.createBufferSource()
    crack.buffer = this.white
    const hp = ctx.createBiquadFilter()
    hp.type = "highpass"
    hp.frequency.value = 2500
    const cg = ctx.createGain()
    cg.gain.setValueAtTime(0.0001, at)
    cg.gain.linearRampToValueAtTime(0.5 * near, at + 0.0008)
    cg.gain.exponentialRampToValueAtTime(0.0001, at + 0.012)
    crack.connect(hp).connect(cg).connect(pan)
    crack.start(at, Math.random())
    crack.stop(at + 0.02)
    const whiz = ctx.createBufferSource()
    whiz.buffer = this.white
    const bp = ctx.createBiquadFilter()
    bp.type = "bandpass"
    bp.Q.value = 5
    bp.frequency.setValueAtTime(4200, at)
    bp.frequency.exponentialRampToValueAtTime(1500, at + 0.08)
    const wg = ctx.createGain()
    wg.gain.setValueAtTime(0.0001, at - 0.02)
    wg.gain.linearRampToValueAtTime(0.3 * near, at)
    wg.gain.exponentialRampToValueAtTime(0.0001, at + 0.09)
    whiz.connect(bp).connect(wg).connect(pan)
    whiz.start(Math.max(ctx.currentTime, at - 0.02), Math.random())
    whiz.stop(at + 0.1)
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

  /** We were hit. */
  hurt(heavy = false): void {
    if (this.ctx && sfx(mixer()).play("impact-metal", { bus: "weapons", gain: heavy ? 1 : 0.6, reverb: 0.05 })) return
    this.burst(this.brown, "lowpass", heavy ? 500 : 900, 120, heavy ? 0.9 : 0.4, 0.002, heavy ? 0.6 : 0.18)
  }
}
