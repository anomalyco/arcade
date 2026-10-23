import type { CreatureEvent } from "../../shared/creature"
import { UNCANNY_SOUNDS, type DistantEvent, type DistantSound } from "../../shared/distant"
import { treesNear, type Tree, type WoodsWorld } from "../../shared/world"
import { WOODS_FILES, type WoodsSoundId } from "./files"
import type { SoundSettings } from "./settings"
import { canopyDensity, gustAt, indoorsAt, insectLevel, nearestShore, nearestStringLight, windExposure } from "./space"
import { StormSound, type StormSoundFrame } from "./storm"

/**
 * The night forest around the listener, in one Web Audio graph that runs the same in a live `AudioContext` and an
 * `OfflineAudioContext` (the proof tape):
 *
 * - wind high in the canopy from four points around you, each following the gust field where it is, so gusts sweep
 *   across the trees; louder on ridges and over the water, quieter in hollows; trunks creak and branches knock in gusts
 * - a low forest room tone, leaves and needles hissing, crickets that thin out away from camp and hush before something
 *   heavy moves in the brush
 * - by the lake: water lapping at the nearest shore, the dock creaking, the string lights' faint buzz
 * - indoors: everything outside muffled, wind on the walls
 * - distant events in 3D with their travel delay, air and foliage absorption (high frequencies roll off) and a forest
 *   reverb whose share grows with distance
 */

export type Listener = { x: number; y: number; z: number; yaw: number }
/** Layers the listening page and the Lab can solo. */
export type SoundLayer = "wind" | "creaks" | "room" | "leaves" | "insects" | "lake" | "dock" | "lights" | "walls" | "distant" | "storm"

const SPEED_OF_SOUND = 343
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))

/** Each distant sound's level against the others (× the Lab's loudness), set by ear-proxy measurement in the tape. */
const DISTANT_LEVEL: Record<DistantSound, number> = {
  "far.loon": 0.54, "far.fox": 0.6, "far.owl": 0.34, "far.snap": 0.55, "far.steps": 0.7, "far.knock": 0.76,
  "far.whistle": 0.56, "far.radio": 0.55, "far.cardoor": 0.93, "far.screendoor": 0.66,
  "far.howl": 0.6, "far.taken": 0.53, "far.mimic": 0.45, "far.echo": 0.54, "far.climb": 0.34, "far.stop": 0.8,
}

/**
 * How the crickets near you react to an uncanny sound, from when it reaches you (s): they start to go quiet at `from`
 * over `attack`, are down by `depth` and stay down `hold` past the end of the sound, then come back over `release`.
 */
const HUSH: Partial<Record<DistantSound, { from: number; attack: number; depth: number; hold: number; release: number }>> = {
  // Thinning while the howl goes on; after its dead stop they stay silent (a second hush at the end, below).
  "far.howl": { from: 2.5, attack: 4, depth: 0.6, hold: 0, release: 1 },
  "far.taken": { from: 0.4, attack: 1.4, depth: 0.95, hold: 16, release: 8 },
  "far.climb": { from: 1, attack: 2.5, depth: 0.7, hold: 4, release: 6 },
  "far.stop": { from: 0, attack: 0.12, depth: 1, hold: 12, release: 7 },
}
/** The forest reverb's share per sound (default 0.5): the howl's dead stop wants little tail. */
const REVERB: Partial<Record<DistantSound, number>> = { "far.howl": 0.32, "far.stop": 0.6 }
/** Fetched on the second pass after Begin (they can't play in the first eight minutes). */
const DEFERRED = new Set<string>(UNCANNY_SOUNDS)

/** The creature's brush crash against the distant sounds (× the Lab's loudness): a few dB under a far branch snap. */
const CREATURE_LEVEL = 0.17

/** Distance loudness, compressed for legibility: −6 dB per 3.2× distance past 20 m instead of per 2×. */
export const distanceGain = (d: number) => (20 / Math.max(20, d)) ** 0.6
/** Air and foliage absorption: the low-pass a sound d metres away is heard through (Hz). */
export const distanceCutoff = (d: number) => clamp(16000 * Math.exp(-d / 115), 280, 16000)

/** A diffuse, dark forest impulse: trunk scatter in the first 150 ms, then a tail that loses its top end as it decays. */
export function forestImpulse(ctx: BaseAudioContext, seconds = 3): AudioBuffer {
  const sr = ctx.sampleRate, n = Math.floor(seconds * sr)
  const buf = ctx.createBuffer(2, n, sr)
  let seed = 424242
  const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5 }
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c)
    const pre = Math.floor(0.012 * sr)
    for (let i = pre; i < n; i++) {
      const t = (i - pre) / sr
      d[i] = rnd() * Math.exp(-t * 2.9) * Math.min(1, t / 0.03) * 0.55
    }
    for (let k = 0; k < 18; k++) {
      const tap = Math.floor((0.014 + 0.14 * Math.abs(rnd() * 2) ** 1.4) * sr)
      const g = 0.7 * (1 - k / 22)
      for (let i = 0; i < 90 && tap + i < n; i++) d[tap + i]! += rnd() * g * (1 - i / 90)
    }
    let lp = 0
    for (let i = 0; i < n; i++) {
      const t = i / sr
      const fc = 6500 * Math.exp(-t * 1.7) + 450
      const a = 1 - Math.exp((-2 * Math.PI * fc) / sr)
      lp += (d[i]! - lp) * a
      d[i] = lp
    }
  }
  return buf
}

function brownNoise(ctx: BaseAudioContext, seconds: number, seed: number): AudioBuffer {
  const n = Math.floor(seconds * ctx.sampleRate), buf = ctx.createBuffer(2, n, ctx.sampleRate)
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c)
    let s = seed + c * 977, b = 0
    for (let i = 0; i < n; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; b = b * 0.995 + (s / 4294967296 - 0.5) * 0.1; d[i] = b }
    // Loop seam: crossfade the last 0.5 s into the start.
    const l = Math.floor(0.5 * ctx.sampleRate)
    for (let i = 0; i < l; i++) { const k = i / l; d[i] = d[i]! * k + d[n - l + i]! * (1 - k) }
    let peak = 0
    for (let i = 0; i < n - l; i++) peak = Math.max(peak, Math.abs(d[i]!))
    for (let i = 0; i < n; i++) d[i]! /= peak || 1
  }
  return buf
}

/** The camp's string lights: a 120 Hz transformer buzz with a faint, irregular sizzle. */
function buzz(ctx: BaseAudioContext, seconds = 4): AudioBuffer {
  const sr = ctx.sampleRate, n = Math.floor(seconds * sr), buf = ctx.createBuffer(1, n, sr)
  const d = buf.getChannelData(0)
  let s = 99, env = 0
  for (let i = 0; i < n; i++) {
    const t = i / sr
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    const r = s / 4294967296
    env = env * 0.9995 + (r > 0.9993 ? 1 : 0) * 0.6
    let v = 0
    for (let h = 1; h <= 9; h++) v += Math.sin(2 * Math.PI * 120 * h * t) / (h === 1 ? 1 : h * 1.6)
    d[i] = v * 0.22 + (r - 0.5) * (0.04 + env * 0.5)
  }
  return buf
}

/**
 * Something fast going through the brush: a rustle that rises and falls with its strides (about 5.5 a second), dry
 * twigs snapping under some of them, then the leaves settling. Synthesized per seed, RMS-normalised to about −20 dBFS.
 */
export function brushCrash(ctx: BaseAudioContext, seed: number, seconds: number): AudioBuffer {
  const sr = ctx.sampleRate, n = Math.floor((seconds + 0.7) * sr)
  const buf = ctx.createBuffer(1, n, sr)
  const d = buf.getChannelData(0)
  let s = (Math.floor(seed * 1e6) ^ 0x5bd1e995) >>> 0
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 }
  const steps: number[] = []
  for (let t = 0.04 + 0.06 * rnd(); t < seconds; t += 0.17 + 0.03 * rnd()) steps.push(t)
  // Rustle: band-limited noise (two one-poles), its level a bump per stride over a swell.
  let lp = 0, hp = 0, prev = 0
  const aLp = 1 - Math.exp((-2 * Math.PI * 4200) / sr), aHp = Math.exp((-2 * Math.PI * 700) / sr)
  for (let i = 0; i < n; i++) {
    const t = i / sr
    const w = rnd() * 2 - 1
    lp += (w - lp) * aLp
    hp = aHp * (hp + lp - prev)
    prev = lp
    let env = 0
    for (const st of steps) if (t >= st && t < st + 0.25) env += Math.exp(-(t - st) * 22) * (0.6 + 0.4 * Math.sin(st * 31))
    const swell = Math.min(1, t / 0.12) * (t < seconds ? 1 : Math.exp(-(t - seconds) * 6))
    d[i] = hp * (env * 0.8 + 0.12) * swell
  }
  // Twigs: a click and a short ring at 1.6–3.6 kHz under about half the strides.
  for (const st of steps) {
    if (rnd() > 0.55) continue
    const f = 1600 + 2000 * rnd(), g = 0.6 + 0.8 * rnd(), at = Math.floor((st + 0.01 * rnd()) * sr)
    for (let k = 0; k < Math.floor(0.03 * sr) && at + k < n; k++) {
      const t = k / sr
      d[at + k]! += g * Math.exp(-t * 260) * (Math.sin(2 * Math.PI * f * t) * 0.7 + (rnd() * 2 - 1) * Math.exp(-t * 900))
    }
  }
  let sum = 0
  for (let i = 0; i < n; i++) sum += d[i]! * d[i]!
  const rms = Math.sqrt(sum / n) || 1
  for (let i = 0; i < n; i++) d[i]! *= 0.1 / rms
  return buf
}

type Voice = { src: AudioBufferSourceNode; fade: GainNode; at: number; distant: boolean; faded: boolean }

const BEDS: readonly WoodsSoundId[] = ["bed.canopy", "bed.leaves", "bed.crickets", "bed.lake", "bed.walls"]

async function fetchFile(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  return res.arrayBuffer()
}

type Bed = { src: AudioBufferSourceNode; gain: GainNode; filter?: BiquadFilterNode; panner?: PannerNode }

export class Soundscape {
  /** Decoded takes by file index; a file that failed to load is a hole until a later `load()` fills it. */
  readonly buffers = new Map<WoodsSoundId, (AudioBuffer | undefined)[]>()
  /** The beds are in, so the woods can start. */
  loaded = false
  /** Every file is in. */
  complete = false
  loading: Promise<boolean> | null = null
  /** Solo one layer (listening page, Lab); null plays everything. */
  solo: SoundLayer | null = null
  /** Distant events played, for automation. */
  readonly heard: { sound: DistantSound | "creature"; distance: number; delay: number; time: number }[] = []

  private readonly outdoor: BiquadFilterNode
  private readonly outdoorGain: GainNode
  private readonly verbIn: GainNode
  private readonly verbOut: GainNode
  private wind: Bed[] = []
  private beds = new Map<string, Bed>()
  private started = false
  private inside = 0
  private rng = 0x2f6b1d
  private nextCreak = 0
  private nextKnock = 0
  private nextDock = 0
  private hush: { from: number; to: number; attack: number; release: number; depth: number }[] = []
  private ctxCache = { at: -1, exposure: 1, density: 0.5, insects: 1, densities: [0.5, 0.5, 0.5, 0.5] }
  private near: Tree[] = []
  /** One-shots scheduled or sounding, so a lost focus stops them and a signal fades the distant ones. */
  private voices = new Set<Voice>()
  private signalSince: number | null = null
  /** The storm's sound (thunder, rain, drips, gusts) on this chain. */
  readonly storm: StormSound
  /** What the storm is doing (`WoodsAudio` sets it each frame); null is a still, dry night. */
  weather: Omit<StormSoundFrame, "inside"> | null = null

  constructor(readonly ctx: BaseAudioContext, private readonly out: AudioNode, private readonly settings: SoundSettings, private readonly baseUrl: string, private readonly world: () => WoodsWorld) {
    this.outdoor = ctx.createBiquadFilter()
    this.outdoor.type = "lowpass"
    this.outdoor.frequency.value = 20000
    this.outdoor.Q.value = 0.5
    this.outdoorGain = ctx.createGain()
    this.outdoor.connect(this.outdoorGain)
    this.outdoorGain.connect(out)
    this.verbIn = ctx.createGain()
    const conv = ctx.createConvolver()
    conv.buffer = forestImpulse(ctx)
    this.verbOut = ctx.createGain()
    this.verbIn.connect(conv)
    conv.connect(this.verbOut)
    this.verbOut.connect(this.outdoor)
    this.storm = new StormSound(ctx, this.outdoor, out, this.verbIn, settings, new URL("../audio-assets/sfx/", new URL(baseUrl, "http://localhost/")).href.replace(/^http:\/\/localhost/, ""), world)
  }

  /**
   * Fetches and decodes the files not loaded yet (after Begin, never on page load). A file that fails is skipped and
   * tried again on the next call; the uncanny tier waits for the second call unless `all`. Resolves whether every file is in.
   */
  load(fetcher: (url: string) => Promise<ArrayBuffer> = fetchFile, all = false): Promise<boolean> {
    if (this.loading) return this.loading
    const run = async () => {
      const jobs: Promise<void>[] = []
      let failed = 0, deferred = 0
      const first = !this.loaded && !all
      for (const [id, files] of Object.entries(WOODS_FILES) as [WoodsSoundId, readonly { file: string }[]][]) {
        if (first && DEFERRED.has(id)) { deferred++; continue }
        let list = this.buffers.get(id)
        if (!list) this.buffers.set(id, (list = []))
        const into = list
        files.forEach((f, i) => {
          if (into[i]) return
          jobs.push(fetcher(this.baseUrl + f.file).then((b) => this.ctx.decodeAudioData(b)).then((a) => { into[i] = a }, (e) => { failed++; console.warn("woods audio:", f.file, e) }))
        })
      }
      await Promise.all(jobs)
      this.loaded = BEDS.every((id) => this.buffers.get(id)?.[0])
      this.complete = failed === 0 && deferred === 0
      return this.complete
    }
    this.loading = run().finally(() => { this.loading = null })
    return this.loading
  }

  /** Stops every one-shot, scheduled or sounding (focus lost: nothing waits in a suspended context to play late). */
  stopAll(): void {
    for (const v of this.voices) { try { v.src.stop() } catch {} }
    this.voices.clear()
    this.storm.stopAll()
  }

  private random(): number {
    this.rng = (Math.imul(this.rng, 1664525) + 1013904223) >>> 0
    return this.rng / 4294967296
  }
  on(layer: SoundLayer) { return this.solo === null || this.solo === layer }

  private loop(buffer: AudioBuffer, id: WoodsSoundId | null, offset: number, rate = 1): AudioBufferSourceNode {
    const src = this.ctx.createBufferSource()
    src.buffer = buffer
    src.loop = true
    const meta = id ? (WOODS_FILES[id][0] as { loopStart?: number; loopEnd?: number }) : {}
    const a = meta.loopStart ?? 0, b = meta.loopEnd ?? buffer.duration
    src.loopStart = a
    src.loopEnd = b
    src.playbackRate.value = rate
    src.start(this.ctx.currentTime, a + (offset % (b - a)))
    return src
  }

  private panner(hrtf: boolean): PannerNode {
    const p = this.ctx.createPanner()
    p.panningModel = hrtf ? "HRTF" : "equalpower"
    p.distanceModel = "inverse"
    p.refDistance = 1
    p.rolloffFactor = 0
    return p
  }
  private static place(p: PannerNode, x: number, y: number, z: number, at: number) {
    if (p.positionX) { p.positionX.setValueAtTime(x, at); p.positionY.setValueAtTime(y, at); p.positionZ.setValueAtTime(z, at) }
    else p.setPosition(x, y, z)
  }

  private start() {
    const ctx = this.ctx
    const bed = (name: string, src: AudioBufferSourceNode, opts: { filter?: BiquadFilterNode; panner?: PannerNode; dest?: AudioNode; send?: number } = {}): Bed => {
      const gain = ctx.createGain()
      gain.gain.value = 0
      let head: AudioNode = src
      if (opts.filter) { src.connect(opts.filter); head = opts.filter }
      head.connect(gain)
      if (opts.panner) { gain.connect(opts.panner); opts.panner.connect(opts.dest ?? this.outdoor) } else gain.connect(opts.dest ?? this.outdoor)
      if (opts.send) { const s = ctx.createGain(); s.gain.value = opts.send; gain.connect(s); s.connect(this.verbIn) }
      const b = { src, gain, filter: opts.filter, panner: opts.panner }
      this.beds.set(name, b)
      return b
    }
    const canopy = this.buffers.get("bed.canopy")![0]!
    const offsets = [0, 5.3, 11.1, 16.7], rates = [0.97, 1, 1.035, 0.99]
    for (let i = 0; i < 4; i++) {
      const f = ctx.createBiquadFilter()
      f.type = "lowpass"
      f.frequency.value = 6000
      f.Q.value = 0.4
      this.wind.push(bed(`wind${i}`, this.loop(canopy, "bed.canopy", offsets[i]!, rates[i]), { filter: f, panner: this.panner(false) }))
    }
    bed("leaves", this.loop(this.buffers.get("bed.leaves")![0]!, "bed.leaves", 3.7))
    bed("insects", this.loop(this.buffers.get("bed.crickets")![0]!, "bed.crickets", 0))
    bed("lake", this.loop(this.buffers.get("bed.lake")![0]!, "bed.lake", 0), { panner: this.panner(true), send: 0.25 })
    bed("walls", this.loop(this.buffers.get("bed.walls")![0]!, "bed.walls", 0), { dest: this.out })
    const roomFilter = ctx.createBiquadFilter()
    roomFilter.type = "lowpass"
    roomFilter.frequency.value = 240
    bed("room", this.loop(brownNoise(ctx, 9, 7), null, 0), { filter: roomFilter })
    bed("lights", this.loop(buzz(ctx), null, 0), { panner: this.panner(true) })
    this.started = true
  }

  /** Sets the listener's ears (x east, y up, z south; yaw 0 faces north, −z). */
  private listen(l: Listener, at: number) {
    const L = this.ctx.listener
    const fx = -Math.sin(l.yaw), fz = -Math.cos(l.yaw)
    if (L.positionX) {
      L.positionX.setValueAtTime(l.x, at); L.positionY.setValueAtTime(l.y, at); L.positionZ.setValueAtTime(l.z, at)
      L.forwardX.setValueAtTime(fx, at); L.forwardY.setValueAtTime(0, at); L.forwardZ.setValueAtTime(fz, at)
      L.upX.setValueAtTime(0, at); L.upY.setValueAtTime(1, at); L.upZ.setValueAtTime(0, at)
    } else {
      L.setPosition(l.x, l.y, l.z)
      L.setOrientation(fx, 0, fz, 0, 1, 0)
    }
  }

  /**
   * Once per frame: `t` is sim time (it drives the gust field, the same on every machine). While `signalling`, distant
   * sounds that start (reach you) during the signal fade out; ones already sounding play on.
   */
  update(l: Listener, t: number, signalling = false): void {
    if (!this.loaded) return
    if (!this.started) this.start()
    const world = this.world(), s = this.settings, now = this.ctx.currentTime
    if (signalling) {
      this.signalSince ??= now
      for (const v of this.voices) {
        if (!v.distant || v.faded || v.at < this.signalSince) continue
        v.faded = true
        const from = Math.max(now, v.at)
        v.fade.gain.setTargetAtTime(0, from, 0.12)
        v.src.stop(from + 0.8)
      }
    } else this.signalSince = null
    this.listen(l, now)
    const tau = 0.25
    const set = (b: Bed | undefined, v: number, k = tau) => b && b.gain.gain.setTargetAtTime(Math.max(0, v), now, k)

    // Place: refreshed four times a second (terrain and tree queries).
    const W = [[0, -1], [1, 0], [0, 1], [-1, 0]] as const, R = 26
    const c = this.ctxCache
    if (Math.abs(t - c.at) > 0.25) {
      c.at = t
      c.exposure = windExposure(world, l.x, l.z)
      c.density = canopyDensity(world, l.x, l.z)
      c.insects = insectLevel(world, l.x, l.z)
      c.densities = W.map(([dx, dz]) => canopyDensity(world, l.x + dx * R, l.z + dz * R, 16))
    }
    const room = indoorsAt(world, l.x, l.z)
    this.inside += ((room ? 1 : 0) - this.inside) * 0.15
    const inside = this.inside
    this.outdoor.frequency.setTargetAtTime(20000 * Math.pow(480 / 20000, inside), now, 0.1)
    this.outdoorGain.gain.setTargetAtTime(1 - 0.6 * inside, now, 0.1)
    this.verbOut.gain.setTargetAtTime(0.5 * s.soundReverb, now, 0.1)

    // Wind high in the canopy: four voices around you, each with the gust where it is; a storm's wind and its gusts
    // (the same ones the trees and the rain follow) on top.
    const storm = this.weather, windK = storm ? storm.wind : 1
    const gustHere = Math.min(1.6, gustAt(l.x, l.z, t) * Math.sqrt(windK))
    for (let i = 0; i < 4; i++) {
      const [dx, dz] = W[i]!, px = l.x + dx * R, pz = l.z + dz * R
      const g = Math.min(1.6, gustAt(px, pz, t) * Math.sqrt(windK))
      const b = this.wind[i]!
      Soundscape.place(b.panner!, px, l.y + 14, pz, now)
      b.filter!.frequency.setTargetAtTime(1800 + 9000 * g * g, now, 0.4)
      set(b, this.on("wind") ? s.soundWind * 0.115 * g * Math.sqrt(windK) * (0.35 + 0.65 * Math.min(1, c.densities[i]!)) * c.exposure : 0, 0.4)
    }
    if (storm && (storm.rain > 0 || storm.wind > 1 || storm.gust > 0)) {
      if (!this.storm.loaded) void this.storm.load()
      if (this.on("storm")) this.storm.update(l, { ...storm, inside }, now)
    }
    set(this.beds.get("leaves"), this.on("leaves") ? s.soundLeaves * 0.085 * (0.3 + 0.7 * gustHere) * (0.35 + 0.65 * Math.min(1, c.density)) * Math.sqrt(c.exposure) : 0, 0.4)
    set(this.beds.get("room"), this.on("room") ? s.soundRoom * 0.0054 : 0)
    // Crickets go quiet while something heavy moves nearby.
    let hush = 1
    for (const h of this.hush) {
      if (now < h.from || now > h.to + h.release) continue
      const k = now < h.from + h.attack ? (now - h.from) / h.attack : now > h.to ? 1 - (now - h.to) / h.release : 1
      hush = Math.min(hush, 1 - h.depth * clamp(k, 0, 1))
    }
    this.hush = this.hush.filter((h) => now < h.to + h.release + 1)
    set(this.beds.get("insects"), this.on("insects") ? s.soundInsects * 0.06 * c.insects * hush : 0, 0.6)
    set(this.beds.get("walls"), this.on("walls") ? s.soundWind * 0.13 * inside * (0.35 + 0.65 * gustHere) : 0, 0.3)

    // The lake at its nearest shore; the string lights at the nearest bulb.
    const shore = nearestShore(world, l.x, l.z)
    const lake = this.beds.get("lake")!
    Soundscape.place(lake.panner!, shore.x, world.lake.level + 0.3, shore.z, now)
    set(lake, this.on("lake") ? s.soundLake * 0.14 * (8 / Math.max(8, shore.d)) ** 1.1 : 0)
    const bulb = nearestStringLight(world, l.x, l.z)
    const lights = this.beds.get("lights")!
    if (bulb) Soundscape.place(lights.panner!, bulb.x, bulb.y, bulb.z, now)
    set(lights, this.on("lights") && bulb ? s.soundCamp * 0.007 * (2 / Math.max(2, Math.hypot(bulb.d, bulb.y - l.y))) ** 1.6 : 0)

    // Trunks creak and branches knock, more in gusts and where the trees are thick.
    const wind = s.soundWind * c.density * c.exposure
    if (now >= this.nextCreak) {
      if (this.nextCreak > 0 && this.on("creaks") && wind > 0.05 && this.random() < 0.2 + gustHere * gustHere * 1.2) this.treeSound("tree.creak", l, 0.045 * wind)
      this.nextCreak = now + 2.5 + 5 * this.random()
    }
    if (now >= this.nextKnock) {
      if (this.nextKnock > 0 && this.on("creaks") && wind > 0.05 && this.random() < 0.15 + gustHere) this.treeSound("tree.knock", l, 0.035 * wind)
      this.nextKnock = now + 3.5 + 7 * this.random()
    }
    const dock = world.buildings.find((b) => b.kind === "dock")
    if (dock && now >= this.nextDock) {
      const x = (dock.rect[0] + dock.rect[2]) / 2, z = dock.rect[1] + (dock.rect[3] - dock.rect[1]) * (0.3 + 0.6 * this.random())
      const d = Math.hypot(x - l.x, z - l.z)
      if (this.nextDock > 0 && d < 45 && this.on("dock")) this.oneShot("dock.creak", Math.floor(this.random() * 3), x, dock.y + 0.1, z, l, s.soundLake * 0.02, { reverb: 0.15 })
      this.nextDock = now + 5 + 10 * this.random() / (0.6 + gustHere)
    }
  }

  private treeSound(id: "tree.creak" | "tree.knock", l: Listener, level: number) {
    const world = this.world()
    const near = treesNear(world, l.x, l.z, 30, this.near).filter((t) => { const d = Math.hypot(t.x - l.x, t.z - l.z); return d > 6 && t.height > 10 })
    if (!near.length) return
    const tree = near[Math.floor(this.random() * near.length)]!
    const y = tree.y + (id === "tree.creak" ? 3 + 4 * this.random() : tree.height * (0.6 + 0.25 * this.random()))
    this.oneShot(id, Math.floor(this.random() * 4), tree.x, y, tree.z, l, level, { reverb: 0.2, rate: 0.9 + 0.2 * this.random() })
  }

  /** A positional one-shot: travel delay, distance level and low-pass, HRTF panning and a distance-weighted reverb send. */
  oneShot(id: WoodsSoundId, take: number, x: number, y: number, z: number, l: Listener, level: number, opts: { reverb?: number; rate?: number; elapsed?: number; distant?: boolean } = {}): { distance: number; delay: number; seconds: number } | null {
    // The chosen take, or the next one that loaded.
    const list = this.buffers.get(id), n = WOODS_FILES[id].length
    let buffer: AudioBuffer | undefined
    for (let k = 0; k < n && !buffer; k++) buffer = list?.[(take + k) % n]
    if (!buffer) return null
    const ctx = this.ctx
    const d = Math.hypot(x - l.x, y - l.y, z - l.z)
    const delay = Math.max(0, d / SPEED_OF_SOUND - (opts.elapsed ?? 0))
    const at = ctx.currentTime + delay + 0.01
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.playbackRate.value = opts.rate ?? 1
    const lp = ctx.createBiquadFilter()
    lp.type = "lowpass"
    lp.frequency.value = distanceCutoff(d)
    lp.Q.value = 0.5
    const lp2 = ctx.createBiquadFilter()
    lp2.type = "lowpass"
    lp2.frequency.value = Math.min(20000, distanceCutoff(d) * 1.6)
    lp2.Q.value = 0.4
    const dry = ctx.createGain()
    dry.gain.value = level * distanceGain(d)
    const wet = ctx.createGain()
    // The reverberant field stays put while the direct sound falls away, so far sounds are mostly forest.
    wet.gain.value = level * (opts.reverb ?? 0.3) * (0.3 + 0.7 * Math.min(1, d / 220))
    const pan = this.panner(true)
    Soundscape.place(pan, x, y, z, ctx.currentTime)
    const fade = ctx.createGain()
    src.connect(lp)
    lp.connect(lp2)
    lp2.connect(fade)
    fade.connect(dry)
    dry.connect(pan)
    pan.connect(this.outdoor)
    fade.connect(wet)
    wet.connect(this.verbIn)
    const voice: Voice = { src, fade, at, distant: !!opts.distant, faded: false }
    this.voices.add(voice)
    src.onended = () => { this.voices.delete(voice); for (const n of [src, lp, lp2, fade, dry, wet, pan]) n.disconnect() }
    src.start(at)
    return { distance: d, delay, seconds: buffer.duration / (opts.rate ?? 1) }
  }

  private crashes = new Map<number, AudioBuffer>()

  /**
   * The creature going through the brush along its path, as quiet as a far branch knock: positional (the panner moves
   * with it), with travel delay, distance low-pass and the forest reverb; the crickets near you hush for a moment.
   */
  creature(e: CreatureEvent, l: Listener, simNow: number, ground: (x: number, z: number) => number): { distance: number; delay: number } | null {
    if (!this.on("distant")) return null
    const take = Math.round(e.seed * 1000) % 3, dur = Math.round(e.dur * 10) / 10, key = take * 100 + dur * 10
    let buffer = this.crashes.get(key)
    if (!buffer) this.crashes.set(key, (buffer = brushCrash(this.ctx, take / 3 + 0.17, dur)))
    const ctx = this.ctx
    const mx = (e.x0 + e.x1) / 2, mz = (e.z0 + e.z1) / 2, y = ground(mx, mz) + 0.4
    const d = Math.hypot(mx - l.x, y - l.y, mz - l.z)
    const delay = Math.max(0, d / SPEED_OF_SOUND - Math.max(0, simNow - e.at))
    const at = ctx.currentTime + delay + 0.01
    const src = ctx.createBufferSource()
    src.buffer = buffer
    const lp = ctx.createBiquadFilter()
    lp.type = "lowpass"
    lp.frequency.value = distanceCutoff(d)
    lp.Q.value = 0.5
    const level = this.settings.distantLevel * CREATURE_LEVEL
    const dry = ctx.createGain()
    dry.gain.value = level * distanceGain(d)
    const wet = ctx.createGain()
    wet.gain.value = level * 0.45 * (0.3 + 0.7 * Math.min(1, d / 220))
    const pan = this.panner(true)
    const y0 = ground(e.x0, e.z0) + 0.4, y1 = ground(e.x1, e.z1) + 0.4
    Soundscape.place(pan, e.x0, y0, e.z0, at)
    if (pan.positionX) { pan.positionX.linearRampToValueAtTime(e.x1, at + e.dur); pan.positionY.linearRampToValueAtTime(y1, at + e.dur); pan.positionZ.linearRampToValueAtTime(e.z1, at + e.dur) }
    const fade = ctx.createGain()
    src.connect(lp)
    lp.connect(fade)
    fade.connect(dry)
    dry.connect(pan)
    pan.connect(this.outdoor)
    fade.connect(wet)
    wet.connect(this.verbIn)
    const voice: Voice = { src, fade, at, distant: false, faded: false }
    this.voices.add(voice)
    src.onended = () => { this.voices.delete(voice); for (const n of [src, lp, fade, dry, wet, pan]) n.disconnect() }
    src.start(at)
    this.hush.push({ from: at, to: at + 2.5, attack: 1.2, release: 5, depth: 0.8 })
    this.heard.push({ sound: "creature", distance: Math.round(d), delay: Math.round(delay * 100) / 100, time: ctx.currentTime })
    return { distance: d, delay }
  }

  /** A distant event: everyone hears the same one at the same place; `simNow - e.at` of its travel has passed. */
  distant(e: DistantEvent, l: Listener, simNow: number): void {
    if (!this.on("distant")) return
    const level = this.settings.distantLevel * DISTANT_LEVEL[e.sound] * 0.55
    const elapsed = Math.max(0, simNow - e.at)
    const r = this.oneShot(e.sound, e.take, e.x, e.y, e.z, l, level, { reverb: REVERB[e.sound] ?? 0.5, elapsed, distant: true, rate: 1 + ((e.seq * 0.37) % 1 - 0.5) * 0.04 })
    if (!r) return
    this.heard.push({ sound: e.sound, distance: Math.round(r.distance), delay: Math.round(r.delay * 100) / 100, time: this.ctx.currentTime })
    const t0 = this.ctx.currentTime + r.delay
    if (e.sound === "far.steps") this.hush.push({ from: t0, to: t0 + 7, attack: 1.2, release: 5, depth: 0.8 })
    const h = HUSH[e.sound]
    if (h) this.hush.push({ from: t0 + h.from, to: t0 + r.seconds + h.hold, attack: h.attack, release: h.release, depth: h.depth })
    // The howl stops dead and so does everything else for a while.
    if (e.sound === "far.howl") this.hush.push({ from: t0 + r.seconds - 0.05, to: t0 + r.seconds + 16, attack: 0.15, release: 9, depth: 1 })
  }
}
