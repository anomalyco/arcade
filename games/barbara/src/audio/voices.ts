import type { LabControl } from "@arcade/kit/lab-panel"
import type { VoiceEvent } from "../../shared/voices"
import { treesNear, type Tree, type WoodsWorld } from "../../shared/world"
import type { Listener } from "./soundscape"
import { distanceCutoff, forestImpulse } from "./soundscape"
import { indoorsAt } from "./space"
import { NIGHT_VOICE_FILES } from "./night-voice-files"
import { VOICE_FILES, type VoiceFile } from "./voice-files"

const SPEED_OF_SOUND = 343
/** A line's file and its folder under `audio/`: the searchers' lines, or the night's (`NIGHT.md`). */
const fileOf = (id: string): { file: VoiceFile; dir: string } | undefined => {
  const v = VOICE_FILES[id]
  if (v) return { file: v, dir: "voice" }
  const n = NIGHT_VOICE_FILES[id]
  return n ? { file: n, dir: "night" } : undefined
}
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))

/** The searchers' voices, bound to the LabPanel (Backquote) › Voices. */
export const VOICE = {
  /** All voices against the woods (×): lines are levelled as said, and the game's mix sits near −40 LUFS. */
  voiceLevel: 0.32,
  /** Show what a searcher says when it reaches you (owned by `StoryHud.subtitles`, saved as `woods.subtitles`). */
  subtitles: true,
  /** How quickly a voice falls away with distance (× the default −6 dB per 3.2×). */
  voiceFalloff: 1,
  /** Muffling per trunk between a speaker and you (×). */
  voiceTrees: 1,
  /** Forest reverb and the echo off the hills on far shouts (×). */
  voiceReverb: 1,
}
export type VoiceSettings = typeof VOICE

export const VOICE_CONTROLS: LabControl[] = [
  { key: "voiceLevel", label: "Loudness against the woods", group: "Voices", min: 0, max: 1, step: 0.01, unit: "×" },
  { key: "voiceFalloff", label: "Falloff with distance", group: "Voices", min: 0.3, max: 2, step: 0.05, unit: "×" },
  { key: "voiceTrees", label: "Muffling by trunks in the way", group: "Voices", min: 0, max: 3, step: 0.05, unit: "×" },
  { key: "voiceReverb", label: "Reverb and hill echo", group: "Voices", min: 0, max: 2.5, step: 0.05, unit: "×" },
]

/** Voices fall away from 5 m (files are levelled as said up close, a shout ~12 dB over talk). */
export const voiceGain = (d: number, falloff = 1) => (5 / Math.max(5, d)) ** (0.6 * falloff)

/** Trunks standing between two points (within their radius + 0.4 m of the line), sampled every 4 m. */
export function trunksBetween(world: WoodsWorld, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz)
  if (len < 2) return 0
  const ux = dx / len, uz = dz / len, seen = new Set<number>(), near: Tree[] = []
  for (let s = 2; s < len - 1; s += 4) {
    for (const t of treesNear(world, ax + ux * s, az + uz * s, 2.6, near)) {
      if (seen.has(t.id)) continue
      const along = (t.x - ax) * ux + (t.z - az) * uz
      if (along < 1 || along > len - 1) continue
      if (Math.abs((t.x - ax) * -uz + (t.z - az) * ux) < t.radius + 0.4) seen.add(t.id)
    }
  }
  return seen.size
}

/** What reaches you of a line: distance, trunks in the way, the level (dB under the file) and low-pass it arrives with. */
export function voiceHeard(world: WoodsWorld, e: Pick<VoiceEvent, "x" | "y" | "z" | "line">, l: Listener, settings: VoiceSettings = VOICE) {
  const d = Math.hypot(e.x - l.x, e.y - l.y, e.z - l.z)
  const trees = trunksBetween(world, e.x, e.z, l.x, l.z)
  const tree = settings.voiceTrees
  // Each trunk scatters the highs and takes a little level; a thick stand leaves only the low body of a shout.
  const treeGain = Math.max(0.35, 0.965 ** (trees * tree))
  const cutoff = clamp(Math.min(distanceCutoff(d), 12000 / (1 + 0.12 * trees * tree)), 300, 16000)
  const gain = voiceGain(d, settings.voiceFalloff) * treeGain * settings.voiceLevel
  // Momentary-max loudness at your ears, roughly (the file's class level, distance and trunks, not the low-pass).
  const lufs = (fileOf(e.line)?.file.loudness ?? -24) + 20 * Math.log10(gain + 1e-6)
  return { distance: d, trees, gain, cutoff, lufs, delay: d / SPEED_OF_SOUND }
}

type Playing = { line: string; sources: AudioScheduledSourceNode[]; nodes: AudioNode[] }
type Fetcher = (url: string) => Promise<ArrayBuffer>

/** Decoded lines kept at most (about 0.5 MB each); the least recently used unpinned one goes first. */
const MAX_BUFFERS = 40
/** Someone moving through brush, under some distant searchers' lines. */
export const BRUSH_IDS = ["brush.1", "brush.2", "brush.3"] as const

/**
 * The voice bus: every line positional (travel delay, distance, trunks in the way, HRTF), a forest reverb of its own
 * and, on far shouts, one echo back off the hills. Its output is the player's Voices volume (`out`); indoors, outside
 * voices go through the walls' low-pass. Each line's file is fetched and decoded the first time it's needed (`preload`
 * pins the opening's lines and the brush ahead of time); a line whose file arrives late still plays from where it
 * would be now, and is only dropped once it's over.
 */
export class VoiceBus {
  readonly out: GainNode
  readonly buffers = new Map<string, AudioBuffer>()
  /** Lines played, for automation and the proof. */
  readonly heard: { line: string; cast: string; distance: number; delay: number; trees: number; lufs: number; time: number }[] = []
  private readonly walls: BiquadFilterNode
  private readonly verbIn: GainNode
  private readonly playing = new Set<Playing>()
  private readonly pending = new Map<string, Promise<AudioBuffer | null>>()
  private readonly pinned = new Set<string>()
  private readonly used = new Map<string, number>()
  private tick = 0
  /** Bumped by `stopAll`, so a line still decoding when you stop playing never starts. */
  private generation = 0

  constructor(readonly ctx: BaseAudioContext, dest: AudioNode, readonly settings: VoiceSettings, private readonly baseUrl: string, private readonly world: () => WoodsWorld, private readonly fetcher: Fetcher = defaultFetch) {
    this.out = ctx.createGain()
    this.out.gain.value = 0
    this.out.connect(dest)
    this.walls = ctx.createBiquadFilter()
    this.walls.type = "lowpass"
    this.walls.frequency.value = 20000
    this.walls.Q.value = 0.5
    this.walls.connect(this.out)
    this.verbIn = ctx.createGain()
    const verb = ctx.createConvolver()
    verb.buffer = forestImpulse(ctx, 3)
    this.verbIn.connect(verb)
    verb.connect(this.walls)
  }

  /** One line's buffer, fetched and decoded once; null if the file failed (asked for again next time). */
  buffer(id: string): Promise<AudioBuffer | null> {
    const have = this.buffers.get(id)
    if (have) { this.used.set(id, ++this.tick); return Promise.resolve(have) }
    const found = fileOf(id)
    if (!found) return Promise.resolve(null)
    let p = this.pending.get(id)
    if (!p) {
      p = this.fetcher(`${this.baseUrl}${found.dir}/${found.file.file}`)
        .then((bytes) => this.ctx.decodeAudioData(bytes))
        .then((buf) => { this.buffers.set(id, buf); this.used.set(id, ++this.tick); this.evict(); return buf as AudioBuffer | null })
        .catch((e) => { console.warn("woods voice:", id, e); return null })
        .finally(() => this.pending.delete(id))
      this.pending.set(id, p)
    }
    return p
  }

  /** Fetch and decode these lines now and keep them (the opening's, the brush). */
  preload(ids: Iterable<string>): Promise<unknown> {
    const all: Promise<unknown>[] = []
    for (const id of ids) { this.pinned.add(id); all.push(this.buffer(id)) }
    return Promise.all(all)
  }

  private evict() {
    if (this.buffers.size <= MAX_BUFFERS) return
    const busy = new Set([...this.playing].map((p) => p.line))
    const order = [...this.buffers.keys()].filter((id) => !this.pinned.has(id) && !busy.has(id)).sort((a, b) => (this.used.get(a) ?? 0) - (this.used.get(b) ?? 0))
    for (const id of order) {
      if (this.buffers.size <= MAX_BUFFERS) break
      this.buffers.delete(id)
      this.used.delete(id)
    }
  }

  /** The walls' low-pass while you're inside a cabin or the hall. */
  update(l: Listener): void {
    const inside = !!indoorsAt(this.world(), l.x, l.z)
    this.walls.frequency.setTargetAtTime(inside ? 520 : 20000, this.ctx.currentTime, 0.15)
  }

  /**
   * A line said at `e`; `simNow - e.at` of its travel has passed already. `level` is × (0 for a line you only read).
   * If its file isn't decoded yet it plays once it is, from where it would be by then.
   */
  say(e: VoiceEvent, l: Listener, simNow: number, level = 1): void {
    const elapsed = Math.max(0, simNow - e.at)
    const ready = this.buffers.get(e.line)
    if (ready) { this.used.set(e.line, ++this.tick); this.start(e, l, elapsed, ready, level); return }
    const asked = this.ctx.currentTime, generation = this.generation
    void this.buffer(e.line).then((buf) => {
      if (buf && generation === this.generation) this.start(e, l, elapsed + (this.ctx.currentTime - asked), buf, level)
    })
  }

  private start(e: VoiceEvent, l: Listener, elapsed: number, buffer: AudioBuffer, level: number): void {
    const ctx = this.ctx, s = this.settings
    const h = voiceHeard(this.world(), e, l, s)
    const rate = 1 + (((e.seq * 0.61) % 1) - 0.5) * 0.02
    // Over by the time it could start: the only line that's skipped.
    if (elapsed > h.delay + buffer.duration / rate - 0.15) return
    const delay = Math.max(0, h.delay - elapsed)
    const at = ctx.currentTime + delay + 0.01
    const offset = Math.max(0, elapsed - h.delay)
    const src = ctx.createBufferSource()
    src.buffer = buffer
    // A hair of pitch spread per line so a repeat isn't the identical take.
    src.playbackRate.value = rate
    const lp = ctx.createBiquadFilter()
    lp.type = "lowpass"
    lp.frequency.value = h.cutoff
    lp.Q.value = 0.5
    const dry = ctx.createGain()
    dry.gain.value = level * h.gain
    // A line joined late comes in on a short fade rather than mid-consonant.
    if (offset > 0) { dry.gain.setValueAtTime(0, at); dry.gain.linearRampToValueAtTime(level * h.gain, at + 0.06) }
    const pan = ctx.createPanner()
    pan.panningModel = "HRTF"
    pan.distanceModel = "inverse"
    pan.refDistance = 1
    pan.rolloffFactor = 0
    if (pan.positionX) { pan.positionX.value = e.x; pan.positionY.value = e.y; pan.positionZ.value = e.z } else pan.setPosition(e.x, e.y, e.z)
    // The reverberant field stays while the direct sound falls away: near lines are dry, far ones mostly forest.
    const wet = ctx.createGain()
    wet.gain.value = level * s.voiceReverb * 0.32 * (0.25 + 0.75 * Math.min(1, h.distance / 180)) * Math.max(h.gain, 0.06)
    src.connect(lp)
    lp.connect(dry)
    dry.connect(pan)
    pan.connect(this.walls)
    lp.connect(wet)
    wet.connect(this.verbIn)
    const nodes: AudioNode[] = [src, lp, dry, pan, wet]
    const sources: AudioScheduledSourceNode[] = [src]
    // Someone out there moving through the brush as they call: under about half the lines from searchers past your
    // friends' footstep range, through the same distance and trunks, starting just before the words.
    const brush = this.buffers.get(BRUSH_IDS[(e.seq & 0x7fffffff) % 3]!)
    if (brush && e.cast !== "barbara" && offset === 0 && h.distance > 14 && h.distance < 140 && ((e.seq * 0.37) % 1 + 1) % 1 < 0.55) {
      const bs = ctx.createBufferSource()
      bs.buffer = brush
      const bg = ctx.createGain()
      bg.gain.value = 0.85
      bs.connect(bg)
      bg.connect(lp)
      bs.start(Math.max(ctx.currentTime, at - 0.6))
      sources.push(bs)
      nodes.push(bs, bg)
    }
    const loud = fileOf(e.line)?.file.loudness ?? -24
    if (loud >= -18 && h.distance > 50 && s.voiceReverb > 0) {
      // The far side of the valley answers a shout, late and dull.
      const echo = ctx.createDelay(2)
      echo.delayTime.value = 0.28 + h.distance / 700
      const eg = ctx.createGain()
      eg.gain.value = level * s.voiceReverb * 0.35 * Math.max(h.gain, 0.05)
      const elp = ctx.createBiquadFilter()
      elp.type = "lowpass"
      elp.frequency.value = Math.min(1800, h.cutoff)
      lp.connect(echo)
      echo.connect(elp)
      elp.connect(eg)
      eg.connect(this.verbIn)
      eg.connect(this.walls)
      nodes.push(echo, elp, eg)
      // A silent source that ends when the echo has: the graph stays up for the line, the delay and its fade.
      const tail = ctx.createConstantSource()
      tail.offset.value = 0
      tail.connect(eg)
      tail.start(at)
      tail.stop(at + (buffer.duration - offset) / rate + echo.delayTime.value + 0.3)
      sources.push(tail)
      nodes.push(tail)
    }
    const p: Playing = { line: e.line, sources, nodes }
    this.playing.add(p)
    // Torn down once the line, any brush under it and the echo's tail are done.
    let sounding = sources.length
    const end = () => { if (--sounding > 0) return; this.release(p) }
    for (const n of sources) n.onended = end
    src.start(at, offset)
    this.heard.push({ line: e.line, cast: e.cast, distance: Math.round(h.distance), delay: Math.round(delay * 100) / 100, trees: h.trees, lufs: Math.round(h.lufs * 10) / 10, time: at })
  }

  private release(p: Playing) {
    if (!this.playing.delete(p)) return
    for (const n of p.nodes) n.disconnect()
  }

  stopAll(): void {
    this.generation++
    for (const p of [...this.playing]) {
      for (const n of p.sources) { n.onended = null; try { n.stop() } catch { /* not started */ } }
      this.release(p)
    }
  }
}

async function defaultFetch(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  return res.arrayBuffer()
}
