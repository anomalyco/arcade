import type { LabControl } from "@arcade/kit/lab-panel"
import type { VoiceEvent } from "../../shared/voices"
import { treesNear, type Tree, type WoodsWorld } from "../../shared/world"
import type { Listener } from "./soundscape"
import { distanceCutoff, forestImpulse } from "./soundscape"
import { indoorsAt } from "./space"
import { VOICE_FILES } from "./voice-files"

const SPEED_OF_SOUND = 343
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))

/** The searchers' voices, bound to the LabPanel (Backquote) › Voices. */
export const VOICE = {
  /** All voices against the woods (×): lines are levelled as said, and the game's mix sits near −40 LUFS. */
  voiceLevel: 0.32,
  /** Show what a searcher says when it reaches you. */
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
  { key: "subtitles", label: "Subtitles", group: "Voices", type: "toggle" },
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
  const file = VOICE_FILES[e.line]
  // Momentary-max loudness at your ears, roughly (the file's class level, distance and trunks, not the low-pass).
  const lufs = (file?.loudness ?? -24) + 20 * Math.log10(gain + 1e-6)
  return { distance: d, trees, gain, cutoff, lufs, delay: d / SPEED_OF_SOUND }
}

type Playing = { src: AudioBufferSourceNode; nodes: AudioNode[] }

/**
 * The voice bus: every line positional (travel delay, distance, trunks in the way, HRTF), a forest reverb of its own
 * and, on far shouts, one echo back off the hills. Its output is the player's Voices volume (`out`); indoors, outside
 * voices go through the walls' low-pass. Files load after Begin like the soundscape's.
 */
export class VoiceBus {
  readonly out: GainNode
  readonly buffers = new Map<string, AudioBuffer>()
  loaded = false
  loading: Promise<boolean> | null = null
  /** Lines played, for automation and the proof. */
  readonly heard: { line: string; cast: string; distance: number; delay: number; trees: number; lufs: number; time: number }[] = []
  private readonly walls: BiquadFilterNode
  private readonly verbIn: GainNode
  private readonly playing = new Set<Playing>()

  constructor(readonly ctx: BaseAudioContext, dest: AudioNode, readonly settings: VoiceSettings, private readonly baseUrl: string, private readonly world: () => WoodsWorld) {
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

  /** Every line's file (about 2 MB); a failed one is a hole until the next `load()`. */
  load(fetcher: (url: string) => Promise<ArrayBuffer> = defaultFetch): Promise<boolean> {
    if (this.loading) return this.loading
    const ids = Object.keys(VOICE_FILES).filter((id) => !this.buffers.has(id))
    this.loading = (async () => {
      let ok = true
      for (let i = 0; i < ids.length; i += 8) {
        await Promise.all(ids.slice(i, i + 8).map(async (id) => {
          try {
            const bytes = await fetcher(`${this.baseUrl}voice/${VOICE_FILES[id]!.file}`)
            this.buffers.set(id, await this.ctx.decodeAudioData(bytes))
          } catch (e) {
            ok = false
            console.warn("woods voice:", id, e)
          }
        }))
      }
      this.loaded = this.buffers.size > 0
      return ok
    })().finally(() => { this.loading = null })
    return this.loading
  }

  get complete() {
    return this.buffers.size === Object.keys(VOICE_FILES).length
  }

  /** The walls' low-pass while you're inside a cabin or the hall. */
  update(l: Listener): void {
    const inside = !!indoorsAt(this.world(), l.x, l.z)
    this.walls.frequency.setTargetAtTime(inside ? 520 : 20000, this.ctx.currentTime, 0.15)
  }

  /** A line said at `e`; `simNow - e.at` of its travel has passed already. `level` is × (0 for a line you only read). */
  say(e: VoiceEvent, l: Listener, simNow: number, level = 1): ReturnType<typeof voiceHeard> | null {
    const buffer = this.buffers.get(e.line)
    if (!buffer) return null
    const ctx = this.ctx, s = this.settings
    const h = voiceHeard(this.world(), e, l, s)
    const elapsed = Math.max(0, simNow - e.at)
    if (elapsed > h.delay + buffer.duration) return null
    const delay = Math.max(0, h.delay - elapsed)
    const at = ctx.currentTime + delay + 0.01
    const offset = Math.max(0, elapsed - h.delay)
    const src = ctx.createBufferSource()
    src.buffer = buffer
    // A hair of pitch spread per line so a repeat isn't the identical take.
    src.playbackRate.value = 1 + (((e.seq * 0.61) % 1) - 0.5) * 0.02
    const lp = ctx.createBiquadFilter()
    lp.type = "lowpass"
    lp.frequency.value = h.cutoff
    lp.Q.value = 0.5
    const dry = ctx.createGain()
    dry.gain.value = level * h.gain
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
    let sounding = 1
    // Someone out there moving through the brush as they call: under about half the lines from searchers past your
    // friends' footstep range, through the same distance and trunks, starting just before the words.
    const brush = this.buffers.get(`brush.${1 + (e.seq & 0x7fffffff) % 3}`)
    if (brush && offset === 0 && h.distance > 14 && h.distance < 140 && ((e.seq * 0.37) % 1 + 1) % 1 < 0.55) {
      const bs = ctx.createBufferSource()
      bs.buffer = brush
      const bg = ctx.createGain()
      bg.gain.value = 0.85
      bs.connect(bg)
      bg.connect(lp)
      bs.start(Math.max(ctx.currentTime, at - 0.6))
      bs.onended = () => end()
      sounding++
      nodes.push(bs, bg)
    }
    const loud = VOICE_FILES[e.line]?.loudness ?? -24
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
    }
    const p: Playing = { src, nodes }
    this.playing.add(p)
    // Torn down once the line, its echo's tail and any brush under it are done.
    const end = () => { if (--sounding > 0) return; this.playing.delete(p); for (const n of nodes) n.disconnect() }
    src.onended = () => end()
    src.start(at, offset)
    this.heard.push({ line: e.line, cast: e.cast, distance: Math.round(h.distance), delay: Math.round(delay * 100) / 100, trees: h.trees, lufs: Math.round(h.lufs * 10) / 10, time: at })
    return h
  }

  stopAll(): void {
    for (const p of this.playing) for (const n of p.nodes) if (n instanceof AudioBufferSourceNode) { try { n.stop() } catch { /* not started */ } }
    this.playing.clear()
  }
}

async function defaultFetch(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  return res.arrayBuffer()
}
