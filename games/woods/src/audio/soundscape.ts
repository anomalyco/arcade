import type { DistantEvent, DistantSound } from "../../shared/distant"
import { treesNear, type Tree, type WoodsWorld } from "../../shared/world"
import { WOODS_FILES, type WoodsSoundId } from "./files"
import type { SoundSettings } from "./settings"
import { canopyDensity, gustAt, indoorsAt, insectLevel, nearestShore, nearestStringLight, windExposure } from "./space"

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
export type SoundLayer = "wind" | "creaks" | "room" | "leaves" | "insects" | "lake" | "dock" | "lights" | "walls" | "distant"

const SPEED_OF_SOUND = 343
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))

/** Each distant sound's level against the others (× the Lab's loudness), set by ear-proxy measurement in the tape. */
const DISTANT_LEVEL: Record<DistantSound, number> = {
  "far.loon": 0.54, "far.fox": 0.6, "far.owl": 0.34, "far.snap": 0.55, "far.steps": 0.7, "far.knock": 0.76,
  "far.whistle": 0.56, "far.radio": 0.55, "far.cardoor": 0.93, "far.screendoor": 0.66,
}

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

type Bed = { src: AudioBufferSourceNode; gain: GainNode; filter?: BiquadFilterNode; panner?: PannerNode }

export class Soundscape {
  readonly buffers = new Map<WoodsSoundId, AudioBuffer[]>()
  loaded = false
  /** Solo one layer (listening page, Lab); null plays everything. */
  solo: SoundLayer | null = null
  /** Distant events played, for automation. */
  readonly heard: { sound: DistantSound; distance: number; delay: number; time: number }[] = []

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
  private hush: { from: number; to: number }[] = []
  private ctxCache = { at: -1, exposure: 1, density: 0.5, insects: 1, densities: [0.5, 0.5, 0.5, 0.5] }
  private near: Tree[] = []

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
  }

  /** Fetches and decodes every file (after Begin, never on load). */
  async load(fetcher: (url: string) => Promise<ArrayBuffer> = async (url) => (await fetch(url)).arrayBuffer()): Promise<void> {
    const jobs: Promise<void>[] = []
    for (const [id, files] of Object.entries(WOODS_FILES) as [WoodsSoundId, readonly { file: string }[]][]) {
      const list: AudioBuffer[] = []
      this.buffers.set(id, list)
      files.forEach((f, i) => jobs.push(fetcher(this.baseUrl + f.file).then((b) => this.ctx.decodeAudioData(b)).then((a) => { list[i] = a })))
    }
    await Promise.all(jobs)
    this.loaded = true
  }

  private random(): number {
    this.rng = (Math.imul(this.rng, 1664525) + 1013904223) >>> 0
    return this.rng / 4294967296
  }
  private on(layer: SoundLayer) { return this.solo === null || this.solo === layer }

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

  /** Once per frame: `t` is sim time (it drives the gust field, the same on every machine). */
  update(l: Listener, t: number): void {
    if (!this.loaded) return
    if (!this.started) this.start()
    const world = this.world(), s = this.settings, now = this.ctx.currentTime
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

    // Wind high in the canopy: four voices around you, each with the gust where it is.
    const gustHere = gustAt(l.x, l.z, t)
    for (let i = 0; i < 4; i++) {
      const [dx, dz] = W[i]!, px = l.x + dx * R, pz = l.z + dz * R
      const g = gustAt(px, pz, t)
      const b = this.wind[i]!
      Soundscape.place(b.panner!, px, l.y + 14, pz, now)
      b.filter!.frequency.setTargetAtTime(1800 + 9000 * g * g, now, 0.4)
      set(b, this.on("wind") ? s.soundWind * 0.115 * g * (0.35 + 0.65 * Math.min(1, c.densities[i]!)) * c.exposure : 0, 0.4)
    }
    set(this.beds.get("leaves"), this.on("leaves") ? s.soundLeaves * 0.085 * (0.3 + 0.7 * gustHere) * (0.35 + 0.65 * Math.min(1, c.density)) * Math.sqrt(c.exposure) : 0, 0.4)
    set(this.beds.get("room"), this.on("room") ? s.soundRoom * 0.0054 : 0)
    // Crickets go quiet while something heavy moves nearby.
    let hush = 1
    for (const h of this.hush) {
      if (now < h.from || now > h.to + 5) continue
      const k = now < h.from + 1.2 ? (now - h.from) / 1.2 : now > h.to ? 1 - (now - h.to) / 5 : 1
      hush = Math.min(hush, 1 - 0.8 * clamp(k, 0, 1))
    }
    this.hush = this.hush.filter((h) => now < h.to + 6)
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
  oneShot(id: WoodsSoundId, take: number, x: number, y: number, z: number, l: Listener, level: number, opts: { reverb?: number; rate?: number; elapsed?: number } = {}): { distance: number; delay: number } | null {
    const list = this.buffers.get(id)
    if (!list?.length) return null
    const buffer = list[take % list.length]!
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
    src.connect(lp)
    lp.connect(lp2)
    lp2.connect(dry)
    dry.connect(pan)
    pan.connect(this.outdoor)
    lp2.connect(wet)
    wet.connect(this.verbIn)
    src.onended = () => { for (const n of [src, lp, lp2, dry, wet, pan]) n.disconnect() }
    src.start(at)
    return { distance: d, delay }
  }

  /** A distant event: everyone hears the same one at the same place; `simNow - e.at` of its travel has passed. */
  distant(e: DistantEvent, l: Listener, simNow: number): void {
    if (!this.on("distant")) return
    const level = this.settings.distantLevel * DISTANT_LEVEL[e.sound] * 0.55
    const elapsed = Math.max(0, simNow - e.at)
    const r = this.oneShot(e.sound, e.take, e.x, e.y, e.z, l, level, { reverb: 0.5, elapsed, rate: 1 + ((e.seq * 0.37) % 1 - 0.5) * 0.04 })
    if (!r) return
    this.heard.push({ sound: e.sound, distance: Math.round(r.distance), delay: Math.round(r.delay * 100) / 100, time: this.ctx.currentTime })
    if (e.sound === "far.steps") { const t0 = this.ctx.currentTime + r.delay; this.hush.push({ from: t0, to: t0 + 7 }) }
  }
}
