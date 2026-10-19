import type * as THREE from "three/webgpu"
import type { Box } from "../world/context"
import { audio, type Bus, type SharedAudio } from "./context"
import { SFX, type SfxId, type SfxVariant } from "./sfx-manifest"

// Sample playback for the shipped sounds (src/audio/sfx-manifest.ts, public/sfx/**).
//  - Loading is lazy and never blocks boot or the first key press: one-shots are fetched and decoded in idle time a few
//    seconds after boot, one file per idle slice (`prepare`), with an OfflineAudioContext, so no running context (and
//    no user input) is needed; the decoded buffers play in the real context once it is unlocked. Loops are fetched and
//    decoded only when first needed. A one-shot asked for before it is decoded is skipped (and its load started).
//  - `play` fires a one-shot: no-repeat variant choice, pitch and gain jitter, optional position (an equal-power
//    panner with inverse-distance rolloff) and occlusion: each wall between the listener and the source (counted on
//    the world's colliders, plus one per storey slab) takes 45% of the level and closes a low-pass.
//  - `loop` makes a `LoopVoice`: a looping source over the take's inner loop region, started on demand, gain and
//    position driven every frame by its owner, re-occluded a few times a second, released when silent.

export type PlayOptions = {
  bus: Bus
  gain?: number
  /** Playback rate (pitch); jittered ±`jitter`. */
  rate?: number
  jitter?: number
  /** World position; omit for a non-positional sound. */
  pos?: { x: number; y: number; z: number }
  /** Distance (m) at full level, and how fast it falls off past that. */
  ref?: number
  rolloff?: number
  /** Stereo pan for non-positional sounds. */
  pan?: number
  /** Extra low-pass (Hz) on top of occlusion. */
  lowpass?: number
  highpass?: number
  /** Low-shelf boost (dB) at 180 Hz: heavier impacts. */
  lowBoost?: number
  /** Start offset into the take (s); negative values delay the start. */
  offset?: number
  /** Specific variant index. */
  variant?: number
  /** Count walls between the listener and `pos` (default true when positional). */
  occlude?: boolean
  /** Audible range (m) for a positional sound: fades out towards it, silent beyond it or more than 2.5 m above/below. */
  range?: number
}

/** Level factor for a source `range` m audible: full within 70% of it, smooth to 0 at it; 0 a storey away. */
function rangeFade(ear: { x: number; y: number; z: number }, p: { x: number; y: number; z: number }, range: number) {
  if (Math.abs(p.y - ear.y) > 2.5) return 0
  const d = Math.hypot(p.x - ear.x, p.z - ear.z)
  const u = Math.max(0, Math.min(1, (range - d) / (range * 0.3)))
  return u * u * (3 - 2 * u)
}

const OCCLUDE_GAIN = 0.55
const OCCLUDE_CUTOFF = 0.3

export class Sfx {
  private bytes = new Map<string, Promise<ArrayBuffer | null>>()
  private decoded = new Map<string, AudioBuffer>()
  private decoding = new Map<string, Promise<AudioBuffer | null>>()
  private last = new Map<string, number>()
  private listener = { x: 0, y: 0, z: 0 }
  /** Automation: one-shots played per id, and those skipped because they weren't decoded yet. */
  readonly stats = { played: {} as Record<string, number>, skipped: 0, decoded: 0, loops: 0 }

  constructor(private colliders: Box[]) {}

  private fetchBytes(url: string) {
    let p = this.bytes.get(url)
    if (!p) {
      p = fetch(new URL(url, document.baseURI).href)
        .then((r) => (r.ok ? r.arrayBuffer() : null))
        .catch(() => null)
      this.bytes.set(url, p)
    }
    return p
  }

  private offline: OfflineAudioContext | null = null
  private queued = false

  /** Decoding works without a running context: an offline one at the files' rate (buffers play in any context). */
  private decode(v: SfxVariant): Promise<AudioBuffer | null> {
    let p = this.decoding.get(v.url)
    if (!p) {
      this.offline ??= new OfflineAudioContext(1, 1, 48000)
      const off = this.offline
      p = this.fetchBytes(v.url)
        .then((b) => (b ? off.decodeAudioData(b) : null))
        .then((buf) => {
          if (buf) {
            this.decoded.set(v.url, buf)
            this.stats.decoded++
          }
          return buf
        })
        .catch(() => null)
      this.decoding.set(v.url, p)
    }
    return p
  }

  /** Fetches and decodes every one-shot in idle time, one file per idle slice (call once, any time after boot). */
  prepare() {
    if (this.queued) return
    this.queued = true
    const queue = Object.values(SFX).flatMap((e) => (e.loop ? [] : [...e.variants]))
    const idle = globalThis.requestIdleCallback ?? ((f: () => void) => setTimeout(f, 16))
    const next = () => {
      const v = queue.shift()
      if (!v) return
      void this.decode(v).then(() => idle(next, { timeout: 1000 }))
    }
    idle(next, { timeout: 1000 })
  }

  /** Starts loading an id's variants (loops: on demand). */
  load(id: SfxId) {
    return Promise.all(SFX[id].variants.map((v) => this.decode(v))).then(() => {})
  }

  ready(id: SfxId) {
    return SFX[id].variants.some((v) => this.decoded.has(v.url))
  }

  /** Per frame: the listener follows the camera. */
  setListener(camera: THREE.PerspectiveCamera) {
    const a = audio()
    if (!a) return
    const e = camera.matrixWorld.elements
    this.listener.x = e[12]!
    this.listener.y = e[13]!
    this.listener.z = e[14]!
    const l = a.ctx.listener
    const t = a.ctx.currentTime
    if (l.positionX) {
      l.positionX.setValueAtTime(e[12]!, t)
      l.positionY.setValueAtTime(e[13]!, t)
      l.positionZ.setValueAtTime(e[14]!, t)
      l.forwardX.setValueAtTime(-e[8]!, t)
      l.forwardY.setValueAtTime(-e[9]!, t)
      l.forwardZ.setValueAtTime(-e[10]!, t)
      l.upX.setValueAtTime(e[4]!, t)
      l.upY.setValueAtTime(e[5]!, t)
      l.upZ.setValueAtTime(e[6]!, t)
    } else {
      l.setPosition(e[12]!, e[13]!, e[14]!)
      l.setOrientation(-e[8]!, -e[9]!, -e[10]!, e[4]!, e[5]!, e[6]!)
    }
  }

  get ear() {
    return this.listener
  }

  /** Walls (and storey slabs) between the listener and `p`, capped at 4. Only wall-height solids (≥ 1.9 m tall)
   *  count: a desk or a crate between you and a sound doesn't muffle it like a wall. */
  walls(p: { x: number; y: number; z: number }) {
    const o = this.listener
    const dx = p.x - o.x
    const dy = p.y - o.y
    const dz = p.z - o.z
    let n = Math.min(3, Math.floor(Math.abs(dy) / 3.2)) * 1.5
    const x0 = Math.min(o.x, p.x)
    const x1 = Math.max(o.x, p.x)
    const z0 = Math.min(o.z, p.z)
    const z1 = Math.max(o.z, p.z)
    const y0 = Math.min(o.y, p.y)
    const y1 = Math.max(o.y, p.y)
    for (const b of this.colliders) {
      if (b.max[0] < x0 || b.min[0] > x1 || b.max[2] < z0 || b.min[2] > z1 || b.max[1] < y0 || b.min[1] > y1) continue
      if (b.max[1] - b.min[1] < 1.9) continue
      // Segment vs box (slab test); boxes containing either end (the source's own housing) don't count.
      let t0 = 0
      let t1 = 1
      const oo = [o.x, o.y, o.z]
      const dd = [dx, dy, dz]
      let hit = true
      for (let i = 0; i < 3 && hit; i++) {
        const di = dd[i]!
        const lo = b.min[i]!
        const hi = b.max[i]!
        if (Math.abs(di) < 1e-9) {
          if (oo[i]! < lo || oo[i]! > hi) hit = false
          continue
        }
        let a = (lo - oo[i]!) / di
        let c = (hi - oo[i]!) / di
        if (a > c) [a, c] = [c, a]
        t0 = Math.max(t0, a)
        t1 = Math.min(t1, c)
        if (t0 > t1) hit = false
      }
      if (hit && t0 > 0.02 && t1 < 0.98) {
        n++
        if (n >= 4) return 4
      }
    }
    return Math.min(4, n)
  }

  private variantOf(id: SfxId, want?: number) {
    const vs = SFX[id].variants
    if (!vs.length) return -1
    if (want !== undefined) return Math.min(vs.length - 1, Math.max(0, want))
    let i = Math.floor(Math.random() * vs.length)
    if (vs.length > 1 && i === this.last.get(id)) i = (i + 1 + Math.floor(Math.random() * (vs.length - 1))) % vs.length
    this.last.set(id, i)
    return i
  }

  /** Fires a one-shot; null when the context isn't running or the take isn't decoded yet (its load is started). */
  play(id: SfxId, o: PlayOptions): AudioBufferSourceNode | null {
    const a = audio()
    if (!a) return null
    const i = this.variantOf(id, o.variant)
    if (i < 0) return null
    const v = SFX[id].variants[i]!
    const buf = this.decoded.get(v.url)
    if (!buf) {
      void this.decode(v)
      this.stats.skipped++
      return null
    }
    const ctx = a.ctx
    const src = ctx.createBufferSource()
    src.buffer = buf
    const jit = o.jitter ?? 0.03
    src.playbackRate.value = (o.rate ?? 1) * (1 - jit + Math.random() * 2 * jit)
    let gain = o.gain ?? 1
    if (o.pos && o.range) {
      const f = rangeFade(this.listener, o.pos, o.range)
      if (f <= 0) return null
      gain *= f
    }
    let cutoff = o.lowpass ?? 20000
    if (o.pos && o.occlude !== false) {
      const w = this.walls(o.pos)
      gain *= OCCLUDE_GAIN ** w
      cutoff = Math.min(cutoff, 18000 * OCCLUDE_CUTOFF ** w)
    }
    let node: AudioNode = src
    if (o.lowBoost) {
      const sh = ctx.createBiquadFilter()
      sh.type = "lowshelf"
      sh.frequency.value = 180
      sh.gain.value = o.lowBoost
      node = node.connect(sh)
    }
    if (o.highpass) {
      const hp = ctx.createBiquadFilter()
      hp.type = "highpass"
      hp.frequency.value = o.highpass
      node = node.connect(hp)
    }
    if (cutoff < 19000) {
      const lp = ctx.createBiquadFilter()
      lp.type = "lowpass"
      lp.frequency.value = Math.max(200, cutoff)
      node = node.connect(lp)
    }
    const g = ctx.createGain()
    g.gain.value = gain
    node = node.connect(g)
    if (o.pos) node = node.connect(this.panner(ctx, o.pos, o.ref ?? 1.5, o.rolloff ?? 1))
    else if (o.pan) {
      const p = ctx.createStereoPanner()
      p.pan.value = Math.max(-1, Math.min(1, o.pan))
      node = node.connect(p)
    }
    node.connect(a.buses[o.bus])
    const off = o.offset ?? 0
    if (off >= 0) src.start(ctx.currentTime, Math.min(off, buf.duration - 0.01))
    else src.start(ctx.currentTime - off)
    this.stats.played[id] = (this.stats.played[id] ?? 0) + 1
    return src
  }

  private panner(ctx: AudioContext, p: { x: number; y: number; z: number }, ref: number, rolloff: number) {
    const pn = ctx.createPanner()
    pn.panningModel = "equalpower"
    pn.distanceModel = "inverse"
    pn.refDistance = ref
    pn.rolloffFactor = rolloff
    pn.maxDistance = 200
    if (pn.positionX) {
      pn.positionX.value = p.x
      pn.positionY.value = p.y
      pn.positionZ.value = p.z
    } else pn.setPosition(p.x, p.y, p.z)
    return pn
  }

  /** A loop voice for `id` (variant `variant`, or the first). */
  loop(id: SfxId, o: LoopOptions) {
    return new LoopVoice(this, id, o)
  }

  /** @internal */
  decoder(v: SfxVariant) {
    return this.decode(v)
  }
}

/** A looping sound whose level, position and filter its owner drives each frame. Silent voices release their source. */
export type LoopOptions = {
  bus: Bus
  ref?: number
  rolloff?: number
  variant?: number
  positional?: boolean
  /**
   * How much walls muffle it, 0..1 (default 1). Below 1 each wall takes less level and less top end: for a sound
   * meant to be followed through a building (the listening room's radio), whose real path runs along corridors and
   * through doorways rather than through the walls the straight line crosses.
   */
  occlusion?: number
  /** Audible range (m): fades out towards it, silent (and released) beyond it or a storey away. */
  range?: number
}

export class LoopVoice {
  private src: AudioBufferSourceNode | null = null
  private gain: GainNode | null = null
  private lp: BiquadFilterNode | null = null
  private pn: PannerNode | null = null
  private loading = false
  private silentFor = 0
  private occl = 0
  private occlAt = 0
  private target = 0
  private cutoff = 20000
  readonly pos = { x: 0, y: 0, z: 0 }

  constructor(
    private sfx: Sfx,
    readonly id: SfxId,
    private o: LoopOptions,
  ) {}

  private stopped = false

  /** Target level (0 silences and, after a while, releases it) and an optional extra low-pass. Ignored once stopped. */
  set(level: number, cutoff = 20000) {
    this.target = this.stopped ? 0 : level
    this.cutoff = cutoff
  }

  /** Stops it for good (a switch turned off): a short fade, then the source is released; `set` no longer starts it. */
  stop() {
    this.stopped = true
    this.target = 0
    const a = audio()
    if (a && this.gain) this.gain.gain.setTargetAtTime(0, a.ctx.currentTime, 0.06)
    this.silentFor = 2.7
  }

  /** Undoes `stop`. */
  resume() {
    this.stopped = false
  }

  get isStopped() {
    return this.stopped
  }

  at(x: number, y: number, z: number) {
    this.pos.x = x
    this.pos.y = y
    this.pos.z = z
  }

  update(dt: number, now: number) {
    const a = audio()
    if (!a) return
    const fade = this.o.positional && this.o.range ? rangeFade(this.sfx.ear, this.pos, this.o.range) : 1
    if (this.target * fade <= 0.0005) {
      this.silentFor += dt
      if (this.src) this.gain!.gain.setTargetAtTime(0, a.ctx.currentTime, 0.25)
      if (this.src && this.silentFor > 3) this.release()
      return
    }
    this.silentFor = 0
    if (!this.src) {
      this.start(a)
      return
    }
    let level = this.target * fade
    let cutoff = this.cutoff
    if (this.o.positional) {
      if (now - this.occlAt > 0.3) {
        this.occlAt = now
        this.occl = this.sfx.walls(this.pos)
      }
      const k = this.o.occlusion ?? 1
      level *= (1 - k * (1 - OCCLUDE_GAIN)) ** this.occl
      cutoff = Math.min(cutoff, 18000 * (1 - k * (1 - OCCLUDE_CUTOFF)) ** this.occl)
      const t = a.ctx.currentTime
      if (this.pn!.positionX) {
        this.pn!.positionX.setTargetAtTime(this.pos.x, t, 0.05)
        this.pn!.positionY.setTargetAtTime(this.pos.y, t, 0.05)
        this.pn!.positionZ.setTargetAtTime(this.pos.z, t, 0.05)
      } else this.pn!.setPosition(this.pos.x, this.pos.y, this.pos.z)
    }
    const t = a.ctx.currentTime
    this.gain!.gain.setTargetAtTime(level, t, 0.3)
    this.lp!.frequency.setTargetAtTime(Math.max(200, Math.min(20000, cutoff)), t, 0.2)
  }

  private start(a: SharedAudio) {
    if (this.loading) return
    const vs = SFX[this.id].variants
    const v = vs[Math.min(vs.length - 1, this.o.variant ?? 0)]
    if (!v) return
    this.loading = true
    void this.sfx.decoder(v).then((buf) => {
      this.loading = false
      if (!buf || this.src || this.target <= 0.0005) return
      const ctx = a.ctx
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.loop = true
      src.loopStart = v.loopStart ?? 0
      src.loopEnd = v.loopEnd ?? buf.duration
      this.lp = ctx.createBiquadFilter()
      this.lp.type = "lowpass"
      this.lp.frequency.value = 20000
      this.gain = ctx.createGain()
      this.gain.gain.value = 0
      let node: AudioNode = src.connect(this.lp).connect(this.gain)
      if (this.o.positional) {
        const pn = ctx.createPanner()
        pn.panningModel = "equalpower"
        pn.distanceModel = "inverse"
        pn.refDistance = this.o.ref ?? 1.5
        pn.rolloffFactor = this.o.rolloff ?? 1
        pn.maxDistance = 200
        if (pn.positionX) {
          pn.positionX.value = this.pos.x
          pn.positionY.value = this.pos.y
          pn.positionZ.value = this.pos.z
        } else pn.setPosition(this.pos.x, this.pos.y, this.pos.z)
        this.pn = pn
        node = node.connect(pn)
      }
      node.connect(a.buses[this.o.bus])
      // Start somewhere inside the loop so two voices of one take never phase.
      const ls = src.loopStart
      const le = src.loopEnd
      src.start(ctx.currentTime, ls + Math.random() * Math.max(0.01, le - ls))
      this.src = src
      this.sfx.stats.loops++
    })
  }

  private release() {
    try {
      this.src?.stop()
    } catch {
      // already stopped
    }
    this.src?.disconnect()
    this.gain?.disconnect()
    this.pn?.disconnect()
    this.src = null
    this.pn = null
    this.sfx.stats.loops--
  }

  get playing() {
    return !!this.src
  }
}
