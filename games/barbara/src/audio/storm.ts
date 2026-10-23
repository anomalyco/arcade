import { SFX_BY_ID } from "@arcade/kit/audio/library"
import type { ThunderEvent } from "@arcade/kit/weather/storm"
import { treesNear, type Tree, type WoodsWorld } from "../../shared/world"
import type { SoundSettings } from "./settings"
import type { Listener } from "./soundscape"
import { WIND_DIR } from "./space"
import { STORM_SFX } from "../sfx"

/**
 * The storm in the woods' own sound chain (`Soundscape`): thunder from where the strike was, arriving after its real
 * travel (slant distance / 343 m/s), panned in 3D (HRTF), darker the farther it came and mostly forest reverb; a
 * synthesized roll under each sample (Lot's and Wings' model); rain hissing in the canopy (on the roof indoors); drops
 * off the branches round you; a gust rushing through the pines when one rises. Samples come from the shared library
 * (ElevenLabs sound generation, Anomaly's commercial licence; `packages/kit/audio/library.ts`) under
 * `audio-assets/sfx/`, fetched the first time the storm sounds.
 */
type StormId = (typeof STORM_SFX)[number]
type Sample = { buffer: AudioBuffer; gain: number }

const SPEED_OF_SOUND = 343
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))
const hash = (n: number) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x) }

/** What the storm is doing this frame (`ForestStorm.frame`). */
export type StormSoundFrame = { rain: number; wind: number; gust: number; clock: number; inside: number }

export class StormSound {
  readonly samples = new Map<StormId, Sample[]>()
  loaded = false
  private loading: Promise<void> | null = null
  /** Thunder played (automation and the proof): when it was scheduled, from how far, after how long. */
  readonly heard: { id: number; kind: string; sample: StormId; distance: number; delay: number; at: number }[] = []
  private scheduled = new Set<number>()
  private voices = new Set<AudioScheduledSourceNode>()
  private rainBed: { gain: GainNode; base: number } | null = null
  private roofBed: { gain: GainNode; base: number } | null = null
  private brown: AudioBuffer | null = null
  private dripAt = 0
  private lastGust = 0
  private serial = 1
  private near: Tree[] = []

  constructor(private readonly ctx: BaseAudioContext, private readonly outdoor: AudioNode, private readonly indoor: AudioNode, private readonly verb: AudioNode, private readonly settings: SoundSettings, private readonly baseUrl: string, private readonly world: () => WoodsWorld) {}

  /** Fetches and decodes the storm's samples once (a failed file is skipped; the rest play). */
  load(fetcher: (url: string) => Promise<ArrayBuffer> = (u) => fetch(u).then((r) => { if (!r.ok) throw Error(`${r.status} ${u}`); return r.arrayBuffer() })): Promise<void> {
    this.loading ??= Promise.all(STORM_SFX.map(async (id) => {
      const entry = SFX_BY_ID.get(id)
      if (!entry) return
      const list = await Promise.all(entry.files.map((f) => fetcher(this.baseUrl + f.file).then((b) => this.ctx.decodeAudioData(b)).then((buffer) => ({ buffer, gain: f.gain * entry.gain }), (e) => { console.warn("barbara storm audio:", f.file, e); return null })))
      this.samples.set(id, list.filter((s): s is Sample => !!s))
    })).then(() => { this.loaded = true })
    return this.loading
  }

  stopAll(): void {
    for (const v of this.voices) { try { v.stop() } catch {} }
    this.voices.clear()
  }

  private pick(id: StormId, k: number): Sample | null {
    const list = this.samples.get(id)
    return list?.length ? list[Math.floor(hash(k) * list.length) % list.length]! : null
  }

  private panner(x: number, y: number, z: number): PannerNode {
    const p = this.ctx.createPanner()
    p.panningModel = "HRTF"
    p.distanceModel = "inverse"
    p.refDistance = 1
    p.rolloffFactor = 0
    if (p.positionX) { p.positionX.value = x; p.positionY.value = y; p.positionZ.value = z } else p.setPosition(x, y, z)
    return p
  }

  /** One sample through a low-pass, a level, a 3D panner and a reverb send, at `at` (ctx time). */
  private shot(s: Sample, at: number, level: number, pos: readonly [number, number, number], opts: { lowpass?: number; reverb?: number; rate?: number; out?: AudioNode } = {}) {
    const ctx = this.ctx
    const src = ctx.createBufferSource()
    src.buffer = s.buffer
    src.playbackRate.value = opts.rate ?? 1
    const lp = ctx.createBiquadFilter()
    lp.type = "lowpass"
    lp.frequency.value = opts.lowpass ?? 16000
    lp.Q.value = 0.5
    const dry = ctx.createGain(), wet = ctx.createGain()
    dry.gain.value = level * s.gain
    wet.gain.value = level * s.gain * (opts.reverb ?? 0.2)
    const pan = this.panner(...pos)
    src.connect(lp); lp.connect(dry); dry.connect(pan); pan.connect(opts.out ?? this.outdoor); lp.connect(wet); wet.connect(this.verb)
    this.voices.add(src)
    src.onended = () => { this.voices.delete(src); for (const n of [src, lp, dry, wet, pan]) n.disconnect() }
    src.start(Math.max(ctx.currentTime, at))
    return src
  }

  /**
   * Thunder from `e`, scheduled once: it reaches the listener `e.arrives − clock` seconds from now (thunder already past
   * by more than half a second is dropped). The crack comes from the channel's nearest stretch (placed 100 m out along
   * its true bearing and height, the panner only needs the direction); air takes the top end off with distance.
   */
  thunder(e: ThunderEvent, l: Listener, clock: number): boolean {
    if (this.scheduled.has(e.id)) return true
    const delay = e.arrives - clock
    if (delay < -0.5) return true
    // Thunder asked for before the samples are in waits for them (it has its travel time to arrive in).
    if (!this.loaded) { void this.load(); return false }
    this.scheduled.add(e.id)
    const near = e.kind === "ground" && e.distance < 600, mid = e.kind === "ground" && !near && e.distance < 2200
    const id: StormId = e.kind === "cloud" ? "weather.thunder.sky" : near ? "weather.thunder.close" : mid ? "weather.thunder.mid" : "weather.thunder.far"
    const s = this.pick(id, e.id * 977)
    if (!s) return true
    const lowpass = near ? 16000 : mid ? clamp(9000 - e.distance * 3.5, 2200, 9000) : e.kind === "cloud" ? 3200 : clamp(2400 - e.distance * 0.15, 500, 2400)
    const level = this.settings.soundThunder * 0.42 * e.power * (near ? 1 : mid ? 0.85 : e.kind === "cloud" ? 0.8 : 0.6)
    const dx = e.position[0] - l.x, dy = e.position[1] - l.y, dz = e.position[2] - l.z, d = Math.hypot(dx, dy, dz) || 1
    const pos = [l.x + (dx / d) * 100, l.y + (dy / d) * 100, l.z + (dz / d) * 100] as const
    const at = this.ctx.currentTime + Math.max(0, delay)
    this.shot(s, at, level, pos, { lowpass, reverb: near ? 0.35 : 0.6, rate: 0.96 + 0.08 * hash(e.id) })
    this.roll(e, at, level, pos)
    this.heard.push({ id: e.id, kind: e.kind, sample: id, distance: Math.round(e.distance), delay: Math.round(Math.max(0, delay) * 1000) / 1000, at })
    return true
  }

  /** Lowpassed brown noise with a few random rolls, longer and darker the farther the strike. */
  private roll(e: ThunderEvent, at: number, level: number, pos: readonly [number, number, number]) {
    const ctx = this.ctx
    if (!this.brown) {
      const n = Math.floor(ctx.sampleRate * 6), b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0)
      let s = 0x51ed, v = 0, peak = 0
      for (let i = 0; i < n; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; v = v * 0.996 + (s / 4294967296 - 0.5) * 0.1; d[i] = v; peak = Math.max(peak, Math.abs(v)) }
      for (let i = 0; i < n; i++) d[i]! /= peak || 1
      this.brown = b
    }
    const dist = e.distance, len = 3 + 3 * Math.min(1, dist / 4000) + 2 * hash(e.id * 5)
    const curve = new Float32Array(96), attack = 0.08 + 0.4 * Math.min(1, dist / 5000)
    const rolls = Array.from({ length: 3 + Math.floor(hash(e.id * 9) * 4) }, (_, i) => [hash(e.id * 31 + i) * 0.7 * len + 0.1 * len, 0.3 + 0.5 * hash(e.id * 37 + i), 0.4 + 0.6 * hash(e.id * 41 + i)] as const)
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * len
      let v = Math.min(1, x / attack) ** 2 * Math.exp(-x / (len * 0.35))
      for (const [c, w, a] of rolls) v += a * 0.7 * Math.exp(-((x - c) ** 2) / (2 * w * w)) * Math.exp(-x / len)
      curve[i] = v * Math.min(1, (1 - i / (curve.length - 1)) / 0.15) * level * 0.22
    }
    const src = ctx.createBufferSource(), a = ctx.createBiquadFilter(), b = ctx.createBiquadFilter(), g = ctx.createGain(), pan = this.panner(...pos)
    src.buffer = this.brown; src.loop = true
    a.type = b.type = "lowpass"; a.frequency.value = b.frequency.value = clamp(300 - dist / 40, 90, 300)
    const start = Math.max(ctx.currentTime, at)
    g.gain.value = 0; g.gain.setValueCurveAtTime(curve, start, len)
    src.connect(a); a.connect(b); b.connect(g); g.connect(pan); pan.connect(this.outdoor)
    this.voices.add(src)
    src.onended = () => { this.voices.delete(src); for (const n of [src, a, b, g, pan]) n.disconnect() }
    src.start(start, hash(e.id) * 4); src.stop(start + len + 0.1)
  }

  private bed(id: StormId, out: AudioNode, lowpass: number) {
    const s = this.pick(id, 0)
    if (!s) return null
    const src = this.ctx.createBufferSource(), lp = this.ctx.createBiquadFilter(), gain = this.ctx.createGain()
    src.buffer = s.buffer; src.loop = true
    lp.type = "lowpass"; lp.frequency.value = lowpass
    gain.gain.value = 0
    src.connect(lp); lp.connect(gain); gain.connect(out)
    src.start(this.ctx.currentTime, hash(this.serial++) * s.buffer.duration)
    return { gain, base: s.gain }
  }

  /** Once a frame: the rain beds, drips off the branches round you and a gust's rush when one rises. */
  update(l: Listener, f: StormSoundFrame, now: number): void {
    if (!this.loaded) return
    const s = this.settings, rain = clamp(f.rain, 0, 1)
    if (rain > 0.005) {
      // Rain in the canopy: the field recording of rain on open ground, darkened by the needles over you.
      this.rainBed ??= this.bed("weather.rain.asphalt", this.outdoor, 5200)
      this.roofBed ??= this.bed("ambience.rain.roof", this.indoor, 9000)
    }
    const set = (b: { gain: GainNode; base: number } | null, v: number) => b?.gain.gain.setTargetAtTime(Math.max(0, v * b.base), now, 0.6)
    set(this.rainBed, s.soundRain * 0.5 * rain * (1 - 0.7 * f.inside))
    set(this.roofBed, s.soundRain * 0.45 * rain * f.inside)
    // Drips: big drops off the branches 1.5–6 m round you, more just after the rain eases.
    if (rain > 0.02 && now >= this.dripAt && f.inside < 0.5) {
      const world = this.world(), trees = treesNear(world, l.x, l.z, 6, this.near)
      const t = trees[Math.floor(hash(this.serial * 7) * trees.length)]
      const k = this.serial++
      const smp = this.pick("weather.drip", k)
      if (t && smp) {
        const a = hash(k * 3) * Math.PI * 2, r = 0.6 + 1.6 * hash(k * 5)
        this.shot(smp, now + 0.01, s.soundRain * 0.22 * (0.4 + 0.6 * hash(k * 11)), [t.x + Math.cos(a) * r, l.y - 1.6, t.z + Math.sin(a) * r], { lowpass: 7000, reverb: 0.1, rate: 0.75 + 0.5 * hash(k * 13) })
      }
      this.dripAt = now + (0.12 + 0.45 * hash(k * 17)) / Math.max(0.3, rain * s.soundRain)
    }
    // A gust rising through 0.3 rushes through the pines from upwind.
    if (f.gust > 0.3 && this.lastGust <= 0.3) {
      const smp = this.pick("weather.wind.gust", this.serial++)
      if (smp) this.shot(smp, now, s.soundWind * 0.55 * clamp(f.wind, 0.3, 3), [l.x - WIND_DIR[0] * 30, l.y + 12, l.z - WIND_DIR[1] * 30], { lowpass: 9000, reverb: 0.15, out: this.outdoor })
    }
    this.lastGust = f.gust
  }

  /** The thunder scheduled at distance d reaches you this long after its stroke (s). */
  static travel(d: number): number { return d / SPEED_OF_SOUND }
}
