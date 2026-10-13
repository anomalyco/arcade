import { VEHICLES, type VehicleKind } from "../../shared/sim/vehicle"
import type { Sound } from "./sound"

/** One vehicle as the mix hears it: where it is from you, how fast, the throttle, sideways slip, the horn. */
export type EngineSource = { id: number; kind: VehicleKind; dx: number; dy: number; speed: number; thr: number; slip: number; horn: boolean; mine: boolean }

/** Recorded loops and one-shots in public/sfx/vehicles (ElevenLabs sound effects; the crashes and skid come from getaway). */
const FILES = [
  "jeep-idle",
  "jeep-drive",
  "van-idle",
  "van-drive",
  "scooter-idle",
  "scooter-drive",
  "horn",
  "skid",
  "door",
  "start",
  "crash-thump-1",
  "crash-thump-2",
  "crash-crunch-1",
  "crash-crunch-3",
  "crash-heavy-1",
  "crash-heavy-3",
] as const
type Sfx = (typeof FILES)[number]

/**
 * Per kind: the idle and driving loops, their playback rates from rpm 0 to 1 (kept narrow so nothing turns shrill),
 * the rpm where the driving loop takes over, gear bands as fractions of top speed (none: a scooter's CVT holds the revs),
 * how loud, and the horn and door pitch.
 */
const ENGINE: Record<VehicleKind, { idle: Sfx; drive: Sfx; idleRate: [number, number]; driveRate: [number, number]; cross: number; gears: number[] | null; gain: number; horn: number; door: number }> = {
  jeep: { idle: "jeep-idle", drive: "jeep-drive", idleRate: [0.92, 1.5], driveRate: [0.74, 1.32], cross: 0.32, gears: [0.28, 0.55, 0.8, 1.2], gain: 1, horn: 1, door: 1 },
  van: { idle: "van-idle", drive: "van-drive", idleRate: [0.9, 1.45], driveRate: [0.72, 1.25], cross: 0.3, gears: [0.3, 0.6, 0.9, 1.2], gain: 1.05, horn: 0.84, door: 0.9 },
  scooter: { idle: "scooter-idle", drive: "scooter-drive", idleRate: [0.95, 1.6], driveRate: [0.8, 1.24], cross: 0.28, gears: null, gain: 0.8, horn: 1.3, door: 1.5 },
}

/** Engines heard at once (yours first, then the nearest), how far they carry, and the level of your own. */
const VOICES = 4
const HEAR = 45
const MINE = 0.34
/** Others' engines dip under yours while you drive. */
const DUCK = 0.6
/** A held horn fades out after this long; let go and press again to honk again. */
const HORN_MAX = 1.2

const roll = (d: number) => 1 / (1 + d * d * 0.012)
const panOf = (dx: number) => Math.max(-0.8, Math.min(0.8, dx / 12))
const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

/** One engine: idle and driving loops crossfaded into a low-pass, a gain and a pan. */
type Voice = {
  id: number
  kind: VehicleKind | null
  idle: AudioBufferSourceNode | null
  drive: AudioBufferSourceNode | null
  idleGain: GainNode
  driveGain: GainNode
  lp: BiquadFilterNode
  gain: GainNode
  pan: StereoPannerNode
}

/** A continuously looping sample (skid, horn) gated by its gain. */
type Loop = { src: AudioBufferSourceNode | null; gain: GainNode; pan: StereoPannerNode; lp: BiquadFilterNode }

/** Smoothed engine state per vehicle: revs and load (0..1). */
type Rev = { rpm: number; load: number; seen: number }

/**
 * Vehicle sounds from recorded loops: each audible running vehicle (yours and the nearest few) gets an engine voice that
 * crossfades an idle loop into a driving loop as the revs climb, nudges their playback rate through a simulated
 * gearbox, opens a low-pass on the throttle and rolls off with distance. A tyre squeal for the hardest real slide, a
 * horn that can't drone on, and one-shot doors, engine starts and crashes scaled by impact. Rides on the main Sound's
 * context and master bus; if the samples fail to load it stays silent.
 */
export class VehicleSound {
  private ctx: AudioContext | null = null
  private master: AudioNode | null = null
  private bufs = new Map<Sfx, AudioBuffer>()
  private voices: Voice[] = []
  private revs = new Map<number, Rev>()
  private skid: Loop | null = null
  private horn: Loop | null = null
  private sliding = false
  private honk = { id: -1, since: 0 }
  /** When each vehicle's engine was started, so its loop swells in under the starter. */
  private starts = new Map<number, number>()
  private last = 0

  constructor(private sound: Sound) {}

  private setup(): boolean {
    const bus = this.sound.bus()
    if (!bus) return false
    if (this.ctx === bus.ctx) return true
    const { ctx, master } = bus
    this.ctx = ctx
    this.master = master
    this.voices = []
    for (let i = 0; i < VOICES; i++) {
      const idleGain = ctx.createGain()
      const driveGain = ctx.createGain()
      const lp = ctx.createBiquadFilter()
      lp.type = "lowpass"
      lp.Q.value = 0.5
      const gain = ctx.createGain()
      gain.gain.value = 0
      const pan = ctx.createStereoPanner()
      idleGain.connect(lp)
      driveGain.connect(lp)
      lp.connect(gain).connect(pan).connect(master)
      this.voices.push({ id: -1, kind: null, idle: null, drive: null, idleGain, driveGain, lp, gain, pan })
    }
    this.skid = this.loop(ctx, master)
    this.horn = this.loop(ctx, master)
    for (const name of FILES)
      void fetch(`${import.meta.env.BASE_URL}sfx/vehicles/${name}.mp3`)
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
        .then((b) => ctx.decodeAudioData(b))
        .then((buf) => this.bufs.set(name, buf))
        .catch(() => {})
    return true
  }

  private loop(ctx: AudioContext, master: AudioNode): Loop {
    const lp = ctx.createBiquadFilter()
    lp.type = "lowpass"
    lp.frequency.value = 18000
    const gain = ctx.createGain()
    gain.gain.value = 0
    const pan = ctx.createStereoPanner()
    lp.connect(gain).connect(pan).connect(master)
    return { src: null, gain, pan, lp }
  }

  /** A looping source of `name` into `dest`, from a random point so two of the same don't phase. */
  private source(name: Sfx, dest: AudioNode): AudioBufferSourceNode | null {
    const buf = this.bufs.get(name)
    if (!buf || !this.ctx) return null
    const s = this.ctx.createBufferSource()
    s.buffer = buf
    s.loop = true
    s.connect(dest)
    s.start(this.ctx.currentTime, Math.random() * buf.duration)
    return s
  }

  /** Points a voice at a vehicle kind, swapping its loops when the kind changes (or once the samples arrive). */
  private bind(v: Voice, kind: VehicleKind): void {
    if (v.kind !== kind) {
      const t = this.ctx!.currentTime
      for (const s of [v.idle, v.drive]) {
        if (!s) continue
        s.stop(t + 0.05)
        s.onended = () => s.disconnect()
      }
      v.kind = kind
      v.idle = v.drive = null
    }
    v.idle ??= this.source(ENGINE[kind].idle, v.idleGain)
    v.drive ??= this.source(ENGINE[kind].drive, v.driveGain)
  }

  /** Revs from a simple gearbox (or the scooter's CVT), smoothed: they climb on the throttle and fall back slower. */
  private rev(s: EngineSource, dt: number, now: number): Rev {
    let r = this.revs.get(s.id)
    if (!r) {
      r = { rpm: 0, load: 0, seen: now }
      this.revs.set(s.id, r)
    }
    r.seen = now
    const e = ENGINE[s.kind]
    const top = VEHICLES[s.kind].maxSpeed
    const sp = Math.abs(s.speed)
    // Off the throttle (or braking against the motion) the engine is unloaded.
    const load = s.thr > 0 || s.speed < 0.5 ? Math.abs(s.thr) : 0
    r.load += (load - r.load) * (1 - Math.exp(-dt * 8))
    const x = sp / top
    let rpm: number
    if (e.gears) {
      let g = 0
      while (g < e.gears.length - 1 && x > e.gears[g]!) g++
      const lo = g === 0 ? 0 : e.gears[g - 1]!
      const frac = clamp01((x - lo) / (e.gears[g]! - lo))
      rpm = g === 0 ? frac * 0.8 : 0.36 + 0.64 * frac
    } else rpm = 0.85 * clamp01(x * 1.2) ** 0.6
    // Throttle with no speed (wheelspin, pushing a wall) revs it anyway.
    rpm = Math.min(1, Math.max(rpm, r.load * 0.5) + r.load * 0.06)
    r.rpm += (rpm - r.rpm) * (1 - Math.exp(-dt * (rpm > r.rpm ? 6 : 4)))
    return r
  }

  /** Called every frame with the vehicles near you. */
  update(sources: readonly EngineSource[]): void {
    if (!this.setup() || !this.ctx) return
    const t = this.ctx.currentTime
    const dt = Math.min(0.1, Math.max(0.001, t - this.last))
    this.last = t
    const dist = (s: EngineSource) => Math.hypot(s.dx, s.dy)
    const near = sources
      .filter((s) => s.mine || dist(s) < HEAR)
      .sort((a, b) => (a.mine ? -1 : b.mine ? 1 : dist(a) - dist(b)))
      .slice(0, VOICES)
    const driving = near.some((s) => s.mine)
    for (const v of this.voices) if (v.id >= 0 && !near.some((s) => s.id === v.id)) this.release(v, t)
    for (const s of near) {
      let v = this.voices.find((x) => x.id === s.id)
      if (!v) {
        v = this.voices.find((x) => x.id < 0)
        if (!v) continue
        v.id = s.id
      }
      this.bind(v, s.kind)
      const e = ENGINE[s.kind]
      const r = this.rev(s, dt, t)
      const d = s.mine ? 0 : dist(s)
      // Equal-power crossfade from the idle loop into the driving loop around `cross`.
      const k = clamp01((r.rpm - e.cross + 0.18) / 0.36)
      const kk = k * k * (3 - 2 * k)
      v.idleGain.gain.setTargetAtTime(Math.cos((kk * Math.PI) / 2), t, 0.06)
      v.driveGain.gain.setTargetAtTime(Math.sin((kk * Math.PI) / 2), t, 0.06)
      v.idle?.playbackRate.setTargetAtTime(e.idleRate[0] + (e.idleRate[1] - e.idleRate[0]) * Math.min(1, r.rpm / (e.cross + 0.2)), t, 0.06)
      v.drive?.playbackRate.setTargetAtTime(e.driveRate[0] + (e.driveRate[1] - e.driveRate[0]) * r.rpm, t, 0.06)
      // The throttle opens the tone up; distance closes it.
      const cut = (900 + 7000 * (0.3 + 0.7 * r.load) * (0.5 + 0.5 * r.rpm)) / (1 + d * 0.08)
      v.lp.frequency.setTargetAtTime(Math.max(250, cut), t, 0.06)
      const level = MINE * e.gain * (0.62 + 0.28 * r.load + 0.1 * r.rpm)
      const began = this.starts.get(s.id)
      const warm = began === undefined ? 1 : clamp01((t - began - 0.5) / 0.6)
      const g = warm * (s.mine ? level : level * 0.9 * roll(d) * (driving ? DUCK : 1))
      v.gain.gain.setTargetAtTime(g, t, 0.08)
      v.pan.pan.setTargetAtTime(s.mine ? 0 : panOf(s.dx), t, 0.05)
    }
    for (const [id, r] of this.revs) if (t - r.seen > 2) this.revs.delete(id)
    for (const [id, at] of this.starts) if (t - at > 2) this.starts.delete(id)
    this.tyres(near, t)
    this.honks(near, t)
  }

  private release(v: Voice, t: number): void {
    v.id = -1
    v.gain.gain.setTargetAtTime(0, t, 0.15)
  }

  /** The squeal follows the hardest real slide, with hysteresis so it doesn't flicker at the threshold. */
  private tyres(near: readonly EngineSource[], t: number): void {
    const skid = this.skid
    if (!skid) return
    if (!skid.src) skid.src = this.source("skid", skid.lp)
    const slide = near.reduce<EngineSource | null>((b, s) => (s.slip > (b?.slip ?? 0) ? s : b), null)
    const slip = slide?.slip ?? 0
    this.sliding = this.sliding ? slip > 2.6 : slip > 3.6
    if (!this.sliding || !slide) {
      skid.gain.gain.setTargetAtTime(0, t, 0.07)
      return
    }
    const k = clamp01((slip - 2.6) / 6)
    const d = slide.mine ? 0 : Math.hypot(slide.dx, slide.dy)
    skid.gain.gain.setTargetAtTime(0.2 * (0.35 + 0.65 * k) * roll(d), t, 0.05)
    skid.src?.playbackRate.setTargetAtTime(0.94 + 0.1 * k, t, 0.06)
    skid.lp.frequency.setTargetAtTime(Math.max(1500, (3000 + 7000 * k) / (1 + d * 0.08)), t, 0.06)
    skid.pan.pan.setTargetAtTime(slide.mine ? 0 : panOf(slide.dx), t, 0.05)
  }

  /** The nearest horn: quick on and off, pitched per vehicle, and it fades if held past HORN_MAX. */
  private honks(near: readonly EngineSource[], t: number): void {
    const horn = this.horn
    if (!horn) return
    const s = near.find((x) => x.horn)
    if (!s) {
      this.honk.id = -1
      horn.gain.gain.setTargetAtTime(0, t, 0.04)
      return
    }
    if (this.honk.id !== s.id) this.honk = { id: s.id, since: t }
    if (!horn.src) horn.src = this.source("horn", horn.lp)
    const d = s.mine ? 0 : Math.hypot(s.dx, s.dy)
    const held = t - this.honk.since
    const fade = held < HORN_MAX ? 1 : Math.max(0, 1 - (held - HORN_MAX) / 0.4)
    horn.src?.playbackRate.setTargetAtTime(ENGINE[s.kind].horn, t, 0.01)
    horn.lp.frequency.setTargetAtTime(Math.max(800, 6000 / (1 + d * 0.05)), t, 0.03)
    horn.gain.gain.setTargetAtTime(0.16 * fade / (1 + d * d * 0.006), t, 0.015)
    horn.pan.pan.setTargetAtTime(s.mine ? 0 : panOf(s.dx), t, 0.03)
  }

  /** Silences the loops (no vehicles, or the match is over). */
  quiet(): void {
    this.update([])
  }

  /** A one-shot of `name` from (dx, dy): distance gain, pan, top end rolled off with distance. */
  private play(name: Sfx, dx: number, dy: number, gain: number, rate = 1, delay = 0): void {
    const buf = this.bufs.get(name)
    if (!this.setup() || !buf || !this.ctx || !this.master) return
    const ctx = this.ctx
    const d = Math.hypot(dx, dy)
    const s = ctx.createBufferSource()
    s.buffer = buf
    s.playbackRate.value = rate
    const lp = ctx.createBiquadFilter()
    lp.type = "lowpass"
    lp.frequency.value = Math.min(18000, 20000 / (1 + d * 0.12))
    const g = ctx.createGain()
    g.gain.value = gain / (1 + d * d * 0.01)
    const pan = ctx.createStereoPanner()
    pan.pan.value = Math.max(-0.85, Math.min(0.85, dx / 12))
    s.connect(lp).connect(g).connect(pan).connect(this.master)
    s.start(ctx.currentTime + delay)
  }

  /** A hit at `v` m/s: a dull thump for a nudge, a crunch on top for a real hit, a heavy smash for a big one. */
  crash(dx: number, dy: number, v: number): void {
    const k = clamp01(v / 14)
    const pick = <T>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)]!
    const rate = () => 0.92 + Math.random() * 0.16
    this.play(pick(["crash-thump-1", "crash-thump-2"] as const), dx, dy, 0.3 + 0.5 * k, rate())
    if (v > 5) this.play(pick(["crash-crunch-1", "crash-crunch-3"] as const), dx, dy, 0.2 + 0.5 * k, rate(), 0.01)
    if (v > 10) this.play(pick(["crash-heavy-1", "crash-heavy-3"] as const), dx, dy, 0.35 + 0.4 * k, rate(), 0.015)
  }

  /** A door shutting (a lighter clunk for a scooter). */
  door(dx: number, dy: number, kind: VehicleKind): void {
    this.play("door", dx, dy, kind === "scooter" ? 0.3 : 0.5, ENGINE[kind].door * (0.95 + Math.random() * 0.1))
  }

  /** The engine cranking into life when someone takes the wheel. */
  start(id: number, dx: number, dy: number, kind: VehicleKind): void {
    if (!this.bufs.has("start") || !this.ctx) return
    this.starts.set(id, this.ctx.currentTime)
    this.play("start", dx, dy, 0.32 * ENGINE[kind].gain, kind === "scooter" ? 1.3 : kind === "van" ? 0.88 : 1, 0.1)
  }
}
