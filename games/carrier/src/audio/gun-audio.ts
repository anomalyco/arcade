import { WEAPONS } from "../../shared/weapons"
import { airCutoff, clamp, distanceGain, smoothstep } from "./jet-math"
import type { Mixer } from "./mixer"

/** Rounds baked into one loop of the round train (each a little different). */
const ROUNDS = 24
/** Overall levels (scripts/audio-demo.ts: a burst near -15 dBFS RMS, like the recorded M61 it replaces). */
const OWN = 0.55
const REMOTE = 0.6

/**
 * The jet's M61, fully procedural and locked to the gun's real cadence (shared/weapons.ts `WEAPONS.gun.rate`, 50 rounds
 * a second). One loop holds 24 synthesized rounds, each exactly 1/rate long, each a little different: a low thump
 * (the body), a saturated mid-band rip, a high crackle, and halfway to the next round the feed's metallic tick. The loop
 * runs continuously and a gate opens and closes on round boundaries the moment the trigger state changes (so a burst
 * starts on a crisp first round and stops cleanly, and the overheat cut-off is exact), with a continuous low rumble
 * under it, the barrels' spin-up whine on the trigger and their spin-down after, and a short airy tail on release.
 *
 * Your gun plays outside (the weapons bus, the open-air reverb and the water's slapback) or, in the cockpit, muffled and
 * felt through the airframe (the own bus, the cockpit's room). The loudest other jet's gun plays the same round train
 * darker with distance (air absorption), wetter, and late by the sound's travel time.
 */
export class GunAudio {
  private ctx: BaseAudioContext
  private period: number
  private t0 = 0
  private gate: GainNode
  private rumble: GainNode
  private whine: OscillatorNode
  private whineGain: GainNode
  private ext: GainNode
  private int: GainNode
  private farGate: GainNode
  private farLp: BiquadFilterNode
  private farLevel: GainNode
  private farSend: GainNode
  private firing = false
  private far = false
  private farDist = 0

  constructor(private mixer: Mixer) {
    const ctx = (this.ctx = mixer.ctx!)
    const sr = ctx.sampleRate
    this.period = Math.round(sr / WEAPONS.gun.rate) / sr
    const buf = roundTrain(ctx, Math.round(sr / WEAPONS.gun.rate))
    const gain = (v: number, to?: AudioNode) => {
      const g = ctx.createGain()
      g.gain.value = v
      if (to) g.connect(to)
      return g
    }
    // Your gun: the round train through a gate, outside and in the cockpit.
    this.ext = gain(1, mixer.bus.weapons)
    this.ext.connect(gain(0.3, mixer.reverb))
    this.ext.connect(gain(0.2, mixer.echo))
    this.int = gain(0)
    const lp = ctx.createBiquadFilter()
    lp.type = "lowpass"
    lp.frequency.value = 950
    lp.Q.value = 0.6
    const shelf = ctx.createBiquadFilter()
    shelf.type = "lowshelf"
    shelf.frequency.value = 120
    shelf.gain.value = 5
    this.int.connect(lp).connect(shelf).connect(mixer.bus.own)
    shelf.connect(gain(0.5, mixer.room))
    const out = gain(OWN)
    out.connect(this.ext)
    out.connect(this.int)
    this.gate = gain(0, out)
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.loop = true
    src.connect(this.gate)
    this.t0 = ctx.currentTime + 0.01
    src.start(this.t0)
    // A continuous low rumble under the rounds while firing.
    this.rumble = gain(0, out)
    const rs = ctx.createBufferSource()
    rs.buffer = mixer.noise.brown
    rs.loop = true
    const rlp = ctx.createBiquadFilter()
    rlp.type = "lowpass"
    rlp.frequency.value = 140
    rs.connect(rlp).connect(this.rumble)
    rs.start(this.t0, Math.random() * 3)
    // The barrels' spin whine.
    this.whine = ctx.createOscillator()
    this.whine.type = "triangle"
    this.whine.frequency.value = 300
    const wlp = ctx.createBiquadFilter()
    wlp.type = "lowpass"
    wlp.frequency.value = 2200
    this.whineGain = gain(0, out)
    this.whine.connect(wlp).connect(this.whineGain)
    this.whine.start(this.t0)

    // Another jet's gun: the same train, darker, wetter, later.
    this.farLevel = gain(0, mixer.bus.weapons)
    this.farSend = gain(0, mixer.reverb)
    this.farLp = ctx.createBiquadFilter()
    this.farLp.type = "lowpass"
    this.farLp.frequency.value = 2000
    this.farLp.connect(this.farLevel)
    this.farLp.connect(this.farSend)
    this.farGate = gain(0, this.farLp)
    const fs = ctx.createBufferSource()
    fs.buffer = buf
    fs.loop = true
    fs.connect(this.farGate)
    // Half a round out of phase with ours, so two guns never stack.
    fs.start(this.t0 + this.period / 2)
  }

  /** The next round boundary of the train at or after time t. */
  private boundary(t: number, offset = 0): number {
    const k = Math.ceil((t - this.t0 - offset) / this.period - 1e-6)
    return this.t0 + offset + Math.max(0, k) * this.period
  }

  /**
   * Per frame: whether your gun is firing (trigger held, gun selected, not overheated), and the loudest other gun as
   * 0..1 (`1 / (1 + d / 300)`, weapons.ts), 0 when none.
   */
  update(firing: boolean, farGun: number): void {
    const ctx = this.ctx
    const now = ctx.currentTime + 0.005
    const k = clamp(this.mixer.cockpit, 0, 1)
    this.ext.gain.setTargetAtTime(1 - k, now, 0.05)
    this.int.gain.setTargetAtTime(k * 0.55, now, 0.05)
    if (firing !== this.firing) {
      this.firing = firing
      const at = this.boundary(now)
      const g = this.gate.gain
      g.cancelScheduledValues(at)
      if (firing) g.setValueAtTime(1, at)
      else g.setTargetAtTime(0, at, 0.004)
      this.rumble.gain.setTargetAtTime(firing ? 0.35 : 0, at, firing ? 0.01 : 0.06)
      // Spin up fast on the trigger; spin down slowly after.
      const w = this.whine.frequency
      w.cancelScheduledValues(now)
      w.setValueAtTime(w.value, now)
      if (firing) {
        w.setTargetAtTime(1150, now, 0.07)
        this.whineGain.gain.setTargetAtTime(0.05, now, 0.03)
      } else {
        w.setTargetAtTime(220, at, 0.45)
        this.whineGain.gain.setTargetAtTime(0.045, at, 0.02)
        this.whineGain.gain.setTargetAtTime(0, at + 0.2, 0.35)
        this.tail(at)
      }
    }
    // The other gun.
    const on = farGun > 0.02
    const d = on ? 300 * (1 / farGun - 1) : this.farDist
    if (on) this.farDist = d
    const delay = Math.min(3, d / 343)
    if (on !== this.far) {
      this.far = on
      // Edges keep their order (the travel time barely changes between them), so a burst shorter than the delay still
      // plays, late, whole.
      const at = this.boundary(now + delay, this.period / 2)
      const g = this.farGate.gain
      g.cancelScheduledValues(at)
      if (on) g.setValueAtTime(1, at)
      else g.setTargetAtTime(0, at, 0.006)
    }
    const near = distanceGain(d, 30, 0.8)
    this.farLevel.gain.setTargetAtTime(REMOTE * near * (1 - 0.4 * smoothstep(100, 1500, d)), now, 0.05)
    this.farSend.gain.setTargetAtTime(REMOTE * Math.sqrt(near) * 0.45, now, 0.05)
    this.farLp.frequency.setTargetAtTime(Math.min(airCutoff(d) * 0.7, 6000), now, 0.05)
  }

  /** The burst's last breath: a short airy rush dying into the reverb. */
  private tail(at: number): void {
    const ctx = this.ctx
    const src = ctx.createBufferSource()
    src.buffer = this.mixer.noise.pink
    const lp = ctx.createBiquadFilter()
    lp.type = "lowpass"
    lp.frequency.setValueAtTime(3800, at)
    lp.frequency.exponentialRampToValueAtTime(600, at + 0.5)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, at)
    g.gain.linearRampToValueAtTime(0.22, at + 0.01)
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.55)
    src.connect(lp).connect(g).connect(this.ext)
    g.connect(this.int)
    src.start(at, Math.random() * 3)
    src.stop(at + 0.6)
  }
}

/**
 * The round train: `ROUNDS` rounds, each exactly `p` samples, synthesized once (mono). Per round: a low thump (a falling
 * 95 → 48 Hz sine and low noise), a mid rip (band-passed noise through a soft saturator), a high crackle (a click of
 * differentiated noise), and at mid-period the feed's metallic tick (a ringing 3.3 kHz band). Small per-round
 * variations in level, timing and colour keep it from sounding like a loop.
 */
export function roundTrain(ctx: BaseAudioContext, p: number): AudioBuffer {
  const sr = ctx.sampleRate
  const len = p * ROUNDS
  const buf = ctx.createBuffer(1, len, sr)
  const d = buf.getChannelData(0)
  let seed = 0x2545f491
  const rnd = () => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return (seed >>> 0) / 4294967296
  }
  /** A two-pole resonator (band-pass) state per layer. */
  const band = (f: number, q: number) => {
    const w = (2 * Math.PI * f) / sr
    const a = Math.sin(w) / (2 * q)
    const a0 = 1 + a
    return { b0: a / a0, b2: -a / a0, a1: (-2 * Math.cos(w)) / a0, a2: (1 - a) / a0, x1: 0, x2: 0, y1: 0, y2: 0 }
  }
  type B = ReturnType<typeof band>
  const run = (s: B, x: number) => {
    const y = s.b0 * x + s.b2 * s.x2 - s.a1 * s.y1 - s.a2 * s.y2
    s.x2 = s.x1
    s.x1 = x
    s.y2 = s.y1
    s.y1 = y
    return y
  }
  // Render past the end, then fold the last rounds' decay back over the start so the loop wraps seamlessly.
  const pre = p
  const tmp = new Float32Array(len + pre + 2 * p)
  const rip = band(950, 1.1)
  const tick = band(3300, 9)
  let lowNoise = 0
  let prevN = 0
  for (let r = 0; r < ROUNDS; r++) {
    const start = pre + r * p + Math.round((rnd() - 0.5) * 0.0008 * sr)
    const amp = 0.85 + 0.15 * rnd()
    const ripF = 820 + 260 * rnd()
    const rr = band(ripF, 1 + 0.4 * rnd())
    rip.b0 = rr.b0
    rip.b2 = rr.b2
    rip.a1 = rr.a1
    rip.a2 = rr.a2
    let phase = 0
    for (let i = 0; i < p * 1.6 && start + i < tmp.length; i++) {
      if (start + i < 0) continue
      const t = i / sr
      // Body: a falling sine thump plus low noise.
      const f = 48 + 47 * Math.exp(-t / 0.012)
      phase += (2 * Math.PI * f) / sr
      const n = rnd() * 2 - 1
      lowNoise += 0.08 * (n - lowNoise)
      const body = (Math.sin(phase) * 0.9 + lowNoise * 1.6) * Math.exp(-t / 0.009)
      // Rip: band-passed noise, saturated.
      const ripv = Math.tanh(run(rip, n) * 3.2) * 0.55 * Math.exp(-t / 0.0045) * (1 - Math.exp(-t / 0.0003))
      // Crackle: a click of differentiated noise.
      const crack = (n - prevN) * 0.35 * Math.exp(-t / 0.0007)
      prevN = n
      tmp[start + i] = tmp[start + i]! + amp * (body * 0.6 + ripv + crack)
    }
    // The feed's tick at mid-period.
    const ts = start + Math.round(p * (0.5 + (rnd() - 0.5) * 0.06))
    for (let i = 0; i < p * 0.4 && ts + i < tmp.length; i++) {
      const t = i / sr
      tmp[ts + i] = tmp[ts + i]! + run(tick, (rnd() * 2 - 1) * Math.exp(-t / 0.0006)) * 0.5 * amp
    }
  }
  let peak = 0
  for (let i = 0; i < len; i++) d[i] = tmp[pre + i]!
  // Timing jitter can start the first round a hair early (into the pre-roll): that goes to the end of the loop.
  for (let i = 0; i < pre; i++) d[len - pre + i] = d[len - pre + i]! + tmp[i]!
  for (let i = 0; i < 2 * p; i++) d[i % len] = d[i % len]! + tmp[pre + len + i]!
  for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(d[i]!))
  const k = 0.9 / (peak || 1)
  for (let i = 0; i < len; i++) d[i] = d[i]! * k
  return buf
}
