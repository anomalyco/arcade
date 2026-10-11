// Shared Web Audio plumbing: buses, limiter, reverb, spatial chains, one-shot and held voices.
import type { Vec3 } from "../sim/types"
import { createSoundBank, type SoundBank } from "./buffers"

export const SPEED_OF_SOUND = 343
/** HRTF panners are convolution-heavy; everything beyond this budget uses equal-power panning. */
export const MAX_HRTF = 6
const MAX_SHOTS = 40

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
export const rand = (a: number, b: number) => a + Math.random() * (b - a)

/** Air absorption: distant sounds lose their top end (1 km ≈ 3.6 kHz, 3 km ≈ 1.4 kHz). */
export function airCutoff(distance: number): number {
  return clamp(20000 / (1 + distance / 220), 300, 20000)
}

export function distanceGain(distance: number, ref: number, rolloff: number): number {
  return ref / (ref + rolloff * Math.max(0, distance - ref))
}

export class Core {
  readonly bank: SoundBank
  readonly limiter: DynamicsCompressorNode
  readonly master: GainNode
  readonly analyser: AnalyserNode
  readonly engineBus: GainNode
  readonly sfxBus: GainNode
  readonly uiBus: GainNode
  readonly reverbIn: GainNode
  private readonly reverb: ConvolverNode
  private readonly reverbOut: GainNode
  readonly listener: Vec3 = [0, 0, 0]
  readonly listenerVelocity: Vec3 = [0, 0, 0]
  hrtfInUse = 0
  readonly shots: Shot[] = []
  readonly helds = new Map<string, Held>()
  private readonly lastPlayed = new Map<string, number>()
  private readonly categoryCount = new Map<string, number>()
  readonly engineLevel = 0.55

  constructor(readonly ctx: AudioContext) {
    this.bank = createSoundBank(ctx)
    this.limiter = ctx.createDynamicsCompressor()
    // Fast, high-ratio compressor acting as a brick-wall-ish limiter; adds glue and punch to booms.
    this.limiter.threshold.value = -8
    this.limiter.knee.value = 4
    this.limiter.ratio.value = 14
    this.limiter.attack.value = 0.002
    this.limiter.release.value = 0.22
    this.master = ctx.createGain()
    this.master.gain.value = 0.8
    this.analyser = ctx.createAnalyser()
    this.analyser.fftSize = 2048
    this.limiter.connect(this.master)
    this.master.connect(ctx.destination)
    this.master.connect(this.analyser)

    this.engineBus = this.bus(this.engineLevel)
    this.sfxBus = this.bus(0.9)
    this.uiBus = this.bus(0.5)

    this.reverb = ctx.createConvolver()
    this.reverb.buffer = this.bank.impulse
    this.reverbIn = ctx.createGain()
    this.reverbOut = ctx.createGain()
    this.reverbOut.gain.value = 0.4
    this.reverbIn.connect(this.reverb)
    this.reverb.connect(this.reverbOut)
    this.reverbOut.connect(this.limiter)
  }

  private bus(level: number): GainNode {
    const g = this.ctx.createGain()
    g.gain.value = level
    g.connect(this.limiter)
    return g
  }

  get now(): number {
    return this.ctx.currentTime
  }

  distanceTo(at: Vec3): number {
    const dx = at[0] - this.listener[0], dy = at[1] - this.listener[1], dz = at[2] - this.listener[2]
    return Math.sqrt(dx * dx + dy * dy + dz * dz)
  }

  /** Approximate Doppler ratio for a source moving at `velocity` (null = static). */
  doppler(at: Vec3, velocity: Vec3 | null): number {
    const dx = at[0] - this.listener[0], dy = at[1] - this.listener[1], dz = at[2] - this.listener[2]
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (d < 1) return 1
    const lv = this.listenerVelocity
    const vx = (velocity ? velocity[0] : 0) - lv[0]
    const vy = (velocity ? velocity[1] : 0) - lv[1]
    const vz = (velocity ? velocity[2] : 0) - lv[2]
    const receding = (vx * dx + vy * dy + vz * dz) / d
    // Real Doppler at 260 m/s would be ×4; compress so turbine tones stay musical but the
    // fly-by "neeeyowm" is still obvious (≈ ×1.5 approaching, ×0.75 receding).
    return Math.pow(clamp(SPEED_OF_SOUND / Math.max(60, SPEED_OF_SOUND + receding), 0.5, 2), 0.6)
  }

  /** Simple per-key rate limit. Returns false if `key` played less than `interval` seconds ago. */
  allow(key: string, interval: number): boolean {
    const now = this.ctx.currentTime
    const last = this.lastPlayed.get(key)
    if (last !== undefined && now - last < interval) return false
    this.lastPlayed.set(key, now)
    if (this.lastPlayed.size > 512) this.lastPlayed.clear()
    return true
  }

  /** Create a one-shot. Returns null when culled (too far, rate-limited or over budget). */
  shot(category: string, at: Vec3 | null, opts: ShotOptions): Shot | null {
    if (this.shots.length >= MAX_SHOTS) return null
    const count = this.categoryCount.get(category) ?? 0
    if (count >= (opts.limit ?? 8)) return null
    const ref = opts.ref ?? 30
    const rolloff = opts.rolloff ?? 1
    let delay = 0
    if (at) {
      const d = this.distanceTo(at)
      if (distanceGain(d, ref, rolloff) * (opts.loudness ?? 1) < 0.002) return null
      if (opts.maxDelay) delay = Math.min(d / SPEED_OF_SOUND, opts.maxDelay)
    }
    const s = new Shot(this, category, at, opts.bus ?? this.sfxBus, ref, rolloff, opts.hrtf ?? true, this.ctx.currentTime + 0.005 + delay)
    this.categoryCount.set(category, count + 1)
    this.shots.push(s)
    return s
  }

  housekeep(): void {
    const now = this.ctx.currentTime
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const s = this.shots[i]
      if (now > s.end + 0.1) {
        s.dispose()
        this.categoryCount.set(s.category, (this.categoryCount.get(s.category) ?? 1) - 1)
        this.shots[i] = this.shots[this.shots.length - 1]
        this.shots.pop()
      }
    }
    for (const [key, h] of this.helds) {
      h.tick(now)
      if (h.dead) this.helds.delete(key)
    }
  }

  /** Briefly dip engine loops so impacts punch through. */
  duck(amount: number, seconds: number): void {
    const g = this.engineBus.gain, now = this.ctx.currentTime
    g.cancelScheduledValues(now)
    g.setTargetAtTime(this.engineLevel * amount, now, 0.01)
    g.setTargetAtTime(this.engineLevel, now + seconds, 0.25)
  }

  dispose(): void {
    for (const s of this.shots) s.dispose()
    this.shots.length = 0
    for (const h of this.helds.values()) h.dispose()
    this.helds.clear()
  }
}

export interface ShotOptions {
  ref?: number
  rolloff?: number
  hrtf?: boolean
  limit?: number
  /** Expected peak loudness, used for distance culling. */
  loudness?: number
  /** Seconds of maximum speed-of-sound delay (0 = none). */
  maxDelay?: number
  bus?: AudioNode
}

/** Distance gain → air-absorption lowpass → panner chain. `at === null` = centered / non-spatial. */
export class Spatial {
  readonly input: GainNode
  private air: BiquadFilterNode | null = null
  private panner: PannerNode | null = null
  private hrtf = false
  private direct: boolean
  distance = 0
  gain = 1

  constructor(private core: Core, private dest: AudioNode, at: Vec3 | null, readonly ref: number, readonly rolloff: number, wantHrtf: boolean, alwaysAir: boolean) {
    const ctx = core.ctx
    this.input = ctx.createGain()
    this.direct = !at
    if (!at) {
      this.input.connect(dest)
      return
    }
    const d = core.distanceTo(at)
    if (alwaysAir || d > 120) {
      this.air = ctx.createBiquadFilter()
      this.air.type = "lowpass"
      this.air.Q.value = 0.5
    }
    this.panner = ctx.createPanner()
    this.panner.distanceModel = "inverse"
    this.panner.refDistance = 1
    this.panner.rolloffFactor = 0
    this.setHrtf(wantHrtf && d < 600)
    const head = this.air ?? this.input
    if (this.air) this.input.connect(this.air)
    head.connect(this.panner)
    this.panner.connect(dest)
    this.update(at, true)
  }

  setHrtf(want: boolean): void {
    if (!this.panner) return
    const use = want && (this.hrtf || this.core.hrtfInUse < MAX_HRTF)
    if (use === this.hrtf) {
      if (this.panner.panningModel !== (use ? "HRTF" : "equalpower")) this.panner.panningModel = use ? "HRTF" : "equalpower"
      return
    }
    this.core.hrtfInUse += use ? 1 : -1
    this.hrtf = use
    this.panner.panningModel = use ? "HRTF" : "equalpower"
  }

  /** Toggle centered playback (own vehicle) without rebuilding the chain. */
  setDirect(direct: boolean): void {
    if (direct === this.direct || !this.panner) return
    this.direct = direct
    const tail = this.air ?? this.input
    tail.disconnect()
    if (direct) {
      tail.connect(this.dest)
      this.setHrtf(false)
      this.input.gain.setTargetAtTime(1, this.core.now, 0.05)
      this.air?.frequency.setTargetAtTime(20000, this.core.now, 0.05)
    } else {
      tail.connect(this.panner)
    }
  }

  update(at: Vec3, immediate = false): void {
    if (this.direct || !this.panner) return
    const d = this.core.distanceTo(at)
    this.distance = d
    this.gain = distanceGain(d, this.ref, this.rolloff)
    const now = this.core.now
    if (immediate) {
      this.input.gain.value = this.gain
      if (this.air) this.air.frequency.value = airCutoff(d)
    } else {
      this.input.gain.setTargetAtTime(this.gain, now, 0.03)
      this.air?.frequency.setTargetAtTime(airCutoff(d), now, 0.05)
    }
    const p = this.panner
    if (p.positionX) {
      p.positionX.value = at[0]
      p.positionY.value = at[1]
      p.positionZ.value = at[2]
    } else {
      p.setPosition(at[0], at[1], at[2])
    }
  }

  dispose(): void {
    this.input.disconnect()
    this.air?.disconnect()
    this.panner?.disconnect()
    if (this.hrtf) this.core.hrtfInUse--
    this.hrtf = false
  }
}

/** A fire-and-forget voice graph. Nodes are disconnected by `Core.housekeep` after `end`. */
export class Shot {
  readonly out: GainNode
  readonly spatial: Spatial
  end: number
  private readonly nodes: AudioNode[] = []

  constructor(private core: Core, readonly category: string, at: Vec3 | null, dest: AudioNode, ref: number, rolloff: number, hrtf: boolean, readonly t: number) {
    this.spatial = new Spatial(core, dest, at, ref, rolloff, hrtf, false)
    this.out = core.ctx.createGain()
    this.out.connect(this.spatial.input)
    this.end = t
  }

  get distance(): number {
    return this.spatial.distance
  }

  private track<T extends AudioNode>(node: T, stopAt?: number): T {
    this.nodes.push(node)
    if (stopAt !== undefined && stopAt > this.end) this.end = stopAt
    return node
  }

  osc(type: OscillatorType, freq: number, start: number, stop: number): OscillatorNode {
    const o = this.core.ctx.createOscillator()
    o.type = type
    o.frequency.value = freq
    o.start(start)
    o.stop(stop)
    return this.track(o, stop)
  }

  /** Looping noise from a random offset (so repeated shots never sound identical). */
  noise(buffer: AudioBuffer, start: number, stop: number, rate = 1): AudioBufferSourceNode {
    const s = this.core.ctx.createBufferSource()
    s.buffer = buffer
    s.loop = true
    s.playbackRate.value = rate
    s.start(start, Math.random() * buffer.duration)
    s.stop(stop)
    return this.track(s, stop)
  }

  filter(type: BiquadFilterType, freq: number, q = 0.7): BiquadFilterNode {
    const f = this.core.ctx.createBiquadFilter()
    f.type = type
    f.frequency.value = freq
    f.Q.value = q
    return this.track(f)
  }

  gain(value = 1): GainNode {
    const g = this.core.ctx.createGain()
    g.gain.value = value
    return this.track(g)
  }

  /** Exponential attack/decay envelope gain connected to `out` (unless `connect` is false). */
  env(start: number, attack: number, peak: number, decay: number, connect = true): GainNode {
    const g = this.gain(0)
    const p = g.gain
    p.setValueAtTime(0.0001, start)
    p.exponentialRampToValueAtTime(Math.max(0.0002, peak), start + attack)
    p.exponentialRampToValueAtTime(0.0001, start + attack + decay)
    p.setValueAtTime(0, start + attack + decay + 0.01)
    if (start + attack + decay > this.end) this.end = start + attack + decay
    if (connect) g.connect(this.out)
    return g
  }

  /** Send to the shared reverb; far sounds are relatively wetter (dry ∝ d⁻¹, wet ∝ d^-½). */
  send(amount: number, from: AudioNode = this.out): void {
    const g = this.gain(amount * Math.sqrt(this.spatial.gain))
    from.connect(g)
    // The convolver keeps ringing after the send is disconnected, so no lifetime extension needed.
    g.connect(this.core.reverbIn)
  }

  dispose(): void {
    for (const n of this.nodes) n.disconnect()
    this.nodes.length = 0
    this.out.disconnect()
    this.spatial.dispose()
  }
}

export interface HeldOptions {
  at: Vec3 | null
  dest: AudioNode
  ref?: number
  attack: number
  release: number
  level: number
  vehicleId?: string | null
  hrtf?: boolean
}

/**
 * A sustain loop kept alive by repeated `hold()` calls (rapid-fire guns, lock/warning tones).
 * Gain automation is scheduled ahead on the audio clock so the loop stops exactly on time even
 * if frames hitch; `Core.housekeep` only disconnects the graph afterwards.
 */
export class Held {
  readonly env: GainNode
  readonly spatial: Spatial | null
  readonly sources: AudioScheduledSourceNode[] = []
  readonly nodes: AudioNode[] = []
  readonly vehicleId: string | null
  /** Latest world position (spatial helds), refreshed each frame from the vehicle list. */
  at: Vec3 | null
  /** Free-form identity (e.g. which cockpit tone this is). */
  tag = ""
  until = 0
  dead = false
  released = false
  onRelease: ((at: number) => void) | null = null
  private attackEnd: number
  private stopAt = Infinity
  private readonly attack: number
  private readonly release: number
  private readonly level: number

  constructor(private core: Core, opts: HeldOptions) {
    const ctx = core.ctx
    this.attack = opts.attack
    this.release = opts.release
    this.level = opts.level
    this.vehicleId = opts.vehicleId ?? null
    this.at = opts.at
    this.env = ctx.createGain()
    this.env.gain.value = 0
    if (opts.at) {
      this.spatial = new Spatial(core, opts.dest, opts.at, opts.ref ?? 40, 1, opts.hrtf ?? true, true)
      this.env.connect(this.spatial.input)
    } else {
      this.spatial = null
      this.env.connect(opts.dest)
    }
    const now = ctx.currentTime
    this.attackEnd = now + this.attack
    this.env.gain.setValueAtTime(0, now)
    this.env.gain.linearRampToValueAtTime(this.level, this.attackEnd)
  }

  start(): void {
    const now = this.core.now
    for (const s of this.sources) s.start(now)
  }

  hold(duration: number): void {
    const now = this.core.now
    const until = now + duration
    if (until <= this.until + 0.015) return
    const g = this.env.gain
    if (this.until > 0 && now >= this.until) {
      // Re-triggered during/after the release: quick re-attack from wherever the fade got to.
      g.cancelScheduledValues(now)
      g.setValueAtTime(Math.min(this.level, g.value), now)
      g.linearRampToValueAtTime(this.level, now + this.attack)
      this.attackEnd = now + this.attack
    }
    const from = Math.max(now, this.attackEnd + 0.0001)
    g.cancelScheduledValues(from)
    g.setValueAtTime(this.level, Math.max(until, from))
    g.linearRampToValueAtTime(0, Math.max(until, from) + this.release)
    this.until = until
    this.released = false
    this.stopAt = Infinity
  }

  /** Cut quickly (e.g. switching lock-tone → locked). */
  stopNow(): void {
    const now = this.core.now
    const g = this.env.gain
    g.cancelScheduledValues(now)
    g.setTargetAtTime(0, now, 0.01)
    this.until = now
    this.released = true
    this.stopAt = now + 0.08
  }

  moveTo(at: Vec3): void {
    this.at = at
    this.spatial?.update(at)
  }

  tick(now: number): void {
    if (this.dead) return
    if (!this.released && now >= this.until) {
      this.released = true
      this.onRelease?.(this.until)
      this.stopAt = this.until + this.release + 0.05
    }
    if (now >= this.stopAt) this.dispose()
  }

  dispose(): void {
    if (this.dead) return
    this.dead = true
    for (const s of this.sources) {
      try { s.stop() } catch { /* not started */ }
      s.disconnect()
    }
    for (const n of this.nodes) n.disconnect()
    this.env.disconnect()
    this.spatial?.dispose()
  }
}
