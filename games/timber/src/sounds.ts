// TIMBER's recorded sounds (`public/sfx/`, CC0, credited in CREDITS.md with `public/sfx/sources.json`) and how they
// play: the saw engine as three crossfaded loops, positioned in 3D and echoing through the trees, the cracks before a
// tree goes, footsteps, and the fear (breathing, a heartbeat that speeds up, and the silence when his engine dies).
import type { SoundBank } from "@arcade/kit/audio"
import type { CueRecipe, MixCategory, SampleAssetMeta, VoiceHandle } from "@arcade/kit/audio/types"
import { active, type Jack, type World } from "../shared/sim"

type Clip = { variants: number; category: MixCategory; loop?: boolean; voices?: number }

const CLIPS: Record<string, Clip> = {
  "saw-idle": { variants: 1, category: "engine", loop: true, voices: 4 },
  "saw-rev": { variants: 1, category: "engine", loop: true, voices: 4 },
  "saw-cut": { variants: 1, category: "engine", loop: true, voices: 4 },
  "saw-start": { variants: 1, category: "engine", voices: 2 },
  "saw-pull": { variants: 2, category: "foley", voices: 3 },
  "saw-flood": { variants: 1, category: "foley", voices: 2 },
  "saw-cutout": { variants: 1, category: "engine", voices: 2 },
  "tree-groan": { variants: 1, category: "impact", voices: 3 },
  "tree-crash": { variants: 2, category: "impact", voices: 4 },
  "tree-crack": { variants: 2, category: "impact", voices: 4 },
  "tree-creak": { variants: 3, category: "impact", voices: 3 },
  "foot-run": { variants: 6, category: "foley", voices: 8 },
  breath: { variants: 1, category: "foley", loop: true, voices: 1 },
  heart: { variants: 1, category: "foley", voices: 3 },
}

const fileId = (name: string, i: number, n: number) => (n > 1 ? `${name}.${i + 1}` : name)

/** The clips as sample assets and one cue per clip (round-robin over its takes), for `SoundBank`'s options. */
export function timberSamples(base: string): { manifest: SampleAssetMeta[]; cues: CueRecipe[] } {
  const manifest: SampleAssetMeta[] = []
  const cues: CueRecipe[] = []
  for (const [name, c] of Object.entries(CLIPS)) {
    const ids = Array.from({ length: c.variants }, (_, i) => `timber.${fileId(name, i, c.variants)}`)
    ids.forEach((id, i) =>
      manifest.push({
        id,
        url: `${base}sfx/${fileId(name, i, c.variants)}.ogg`,
        category: c.category,
        source: "project",
        license: "CC0-1.0",
        provenance: "Freesound CC0 field recording; source, seconds and SHA-256 in games/timber/public/sfx/sources.json",
        ...(c.loop ? { loop: true } : {}),
      }),
    )
    cues.push({
      id: `timber.${name}`,
      label: name,
      category: c.category,
      masterGain: 1,
      wet: 0,
      maxVoices: c.voices ?? 4,
      steal: "steal-oldest",
      pitchVariation: c.loop ? 0 : 0.03,
      gainVariation: c.loop ? 0 : 0.08,
      ...(c.loop ? { loop: true } : {}),
      layers: [{ kind: "sample", samples: ids.map((id) => ({ id, gain: 1 })), selection: "round-robin", ...(c.loop ? { loop: true } : {}) }],
    })
  }
  return { manifest, cues }
}

/** Where you hear from: the listener's plan position and the camera's right vector. */
export type Ear = { x: number; y: number; rx: number; ry: number }

export type SoundLook = { hushTime: number }

/** A standing trunk between (x0,y0) and (x1,y1): muffles and darkens what you hear past it. */
type Trunk = { x: number; y: number; r: number; state: string }

type EngineVoice = { idle: VoiceHandle | null; rev: VoiceHandle | null; cut: VoiceHandle | null; w: [number, number, number]; startedAt: number }

/**
 * The game's sound: engines per lumberjack, positional one-shots, footsteps, breathing and the heartbeat. All gain,
 * pan, low-pass and reverb are computed here from where you are (no runtime panner), so a far saw is quieter, duller
 * and wetter, and every trunk in the way takes a little more off.
 */
export class TimberSound {
  private engines = new Map<number, EngineVoice>()
  private breath: VoiceHandle | null = null
  private nextBeat = 0
  private stride = new Map<number, number>()
  /** Seconds of silence left after an engine cut out near you; the world holds its breath. */
  hush = 0
  ear: Ear = { x: 0, y: 0, rx: 1, ry: 0 }
  trunks: readonly Trunk[] = []

  constructor(readonly bank: SoundBank) {}

  private get rt() {
    return this.bank.runtime
  }

  /** Gain, pan, low-pass and reverb send for a source at (x, y), metres in plan. */
  place(x: number, y: number, h = 1): { gain: number; pan: number; cutoffHz: number; wet: number } {
    const dx = x - this.ear.x
    const dy = y - this.ear.y
    const d = Math.hypot(dx, dy, h - 1.6)
    let between = 0
    if (d > 3) {
      for (const t of this.trunks) {
        if (t.state !== "standing") continue
        const s = ((t.x - this.ear.x) * dx + (t.y - this.ear.y) * dy) / (d * d)
        if (s <= 0.05 || s >= 0.95) continue
        const ox = this.ear.x + dx * s - t.x
        const oy = this.ear.y + dy * s - t.y
        if (ox * ox + oy * oy < (t.r * 1.2 + 0.15) ** 2) between++
      }
    }
    const pan = d < 0.5 ? 0 : Math.max(-0.85, Math.min(0.85, ((dx * this.ear.rx + dy * this.ear.ry) / Math.max(d, 1e-3)) * Math.min(1, d / 2.5)))
    const gain = (1 / (1 + d / 5)) * Math.pow(0.88, Math.min(6, between))
    const cutoffHz = Math.max(500, 16000 * Math.exp(-d / 28) * Math.pow(0.78, Math.min(6, between)))
    // Echo through the trees: the farther, the more of it is the forest answering.
    const wet = Math.min(0.85, 0.08 + d / 40 + between * 0.04)
    return { gain, pan, cutoffHz, wet }
  }

  /** A positioned one-shot. */
  at(name: string, x: number, y: number, o: { gain?: number; rate?: number; h?: number; delay?: number } = {}): VoiceHandle | null {
    if (!this.rt.ctx) return null
    const p = this.place(x, y, o.h ?? 1)
    return this.rt.playCue(`timber.${name}`, { ...p, gain: p.gain * (o.gain ?? 1), rate: o.rate ?? 1, ...(o.delay ? { time: this.rt.now + o.delay } : {}) })
  }

  /** A sound in your own head (breath, heart): unpositioned. */
  near(name: string, gain = 1, rate = 1): VoiceHandle | null {
    if (!this.rt.ctx) return null
    return this.rt.playCue(`timber.${name}`, { gain, rate, pan: 0, cutoffHz: 18000, wet: 0.05 })
  }

  /** The engine started: the recorded catch and run-up; the loops fade in under its tail. */
  started(j: Jack): void {
    this.at("saw-start", j.x, j.y, { gain: 1.1 })
    const e = this.engines.get(j.id)
    if (e) e.startedAt = performance.now() / 1000
    else this.engines.set(j.id, { idle: null, rev: null, cut: null, w: [0, 0, 0], startedAt: performance.now() / 1000 })
  }

  /**
   * The engine cut out (out of fuel, pinned, or he killed it to sneak): the engine dies on the recording and the loops
   * stop dead under it. If it's near you and you're hunted, the world goes silent for `hushTime`.
   */
  cutOut(j: Jack, hunted: boolean, look: SoundLook): void {
    const e = this.engines.get(j.id)
    for (const v of [e?.idle, e?.rev, e?.cut]) v?.stop(0.06)
    if (e) Object.assign(e, { idle: null, rev: null, cut: null, w: [0, 0, 0] })
    this.at("saw-cutout", j.x, j.y, { gain: 1.2 })
    if (hunted && Math.hypot(j.x - this.ear.x, j.y - this.ear.y) < 30) this.hush = look.hushTime
  }

  /**
   * Per frame: each running engine's three loops crossfaded by what it's doing (idle, revved, in wood), placed where
   * he is; footsteps from everyone who's moving; and your breath and heart from `fear` (0..1) and `winded` (0..1).
   */
  frame(w: World, dt: number, inPlay: boolean, focus: Jack, fear: number, winded: number): void {
    if (!this.rt.ctx) return
    this.hush = Math.max(0, this.hush - dt)
    const hushK = this.hush > 0 ? Math.max(0, 1 - this.hush / 0.6) ** 2 : 1
    const now = performance.now() / 1000
    for (const j of w.jacks) {
      let e = this.engines.get(j.id)
      const running = inPlay && active(j) && w.phase !== "over" && j.role === "lumberjack" && j.engine === "on"
      if (!running) {
        if (e && (e.idle || e.rev || e.cut)) {
          for (const v of [e.idle, e.rev, e.cut]) v?.stop(0.2)
          Object.assign(e, { idle: null, rev: null, cut: null, w: [0, 0, 0] })
        }
        continue
      }
      if (!e) this.engines.set(j.id, (e = { idle: null, rev: null, cut: null, w: [0, 0, 0], startedAt: -10 }))
      const inWood = j.trigger && j.target !== null
      const want: [number, number, number] = inWood ? [0, 0.15, 1] : j.trigger ? [0, 1, 0] : [1, 0, 0]
      // The throttle opens fast and falls back slower, as a real engine winds down.
      for (let i = 0; i < 3; i++) {
        const tau = want[i]! > e.w[i]! ? 0.07 : 0.22
        e.w[i] = e.w[i]! + (want[i]! - e.w[i]!) * (1 - Math.exp(-dt / tau))
      }
      // Fade in under the start recording's tail.
      const warm = Math.min(1, Math.max(0, (now - e.startedAt - 2.2) / 1.6))
      const p = this.place(j.x, j.y, 0.9)
      const levels = [0.4, 1, 1.05]
      const rates = [1, 1 + Math.sin(now * 3.1 + j.id) * 0.012, 1 + Math.sin(now * 23 + j.id) * 0.03]
      const names = ["saw-idle", "saw-rev", "saw-cut"] as const
      const keys = ["idle", "rev", "cut"] as const
      for (let i = 0; i < 3; i++) {
        const g = p.gain * levels[i]! * e.w[i]! * warm * 1.4
        const k = keys[i]!
        if (!e[k] && g > 0.002) e[k] = this.rt.playCue(`timber.${names[i]}`, { ...p, gain: g, rate: rates[i]!, ownerKey: `${names[i]}-${j.id}` })
        e[k]?.setParams({ gain: g, pan: p.pan, cutoffHz: p.cutoffHz, wet: p.wet, rate: rates[i]! }, 0.04)
      }
    }
    // Footsteps: a step each stride from anyone moving within earshot.
    for (const j of w.jacks) {
      if (!inPlay || !active(j) || j.downed) continue
      const sp = Math.hypot(j.vx, j.vy)
      if (sp < 0.4) continue
      const strideLen = sp > 4 ? 1.55 : 1.15
      const s = (this.stride.get(j.id) ?? 0) + sp * dt
      if (s >= strideLen) {
        const d = Math.hypot(j.x - this.ear.x, j.y - this.ear.y)
        if (d < 30) this.at("foot-run", j.x, j.y, { gain: (j.role === "lumberjack" ? 1.25 : 0.9) * Math.min(1, sp / 5) * (0.55 + 0.45 * hushK) * (j.id === focus.id ? 0.7 : 1), rate: j.role === "lumberjack" ? 0.82 : 1, h: 0.05 })
        this.stride.set(j.id, s - strideLen)
      } else this.stride.set(j.id, s)
    }
    // Breathing: heavier with fear and when winded; held through the silence.
    const hunted = inPlay && focus.role === "survivor" && active(focus)
    const bg = hunted ? Math.min(1, fear * 0.75 + winded * 0.6) * (this.hush > 0 ? 0.08 : 1) : 0
    if (bg > 0.02) {
      this.breath ??= this.rt.playCue("timber.breath", { gain: bg * 0.7, rate: 1, pan: 0, cutoffHz: 18000, wet: 0.02, ownerKey: "breath" })
      this.breath?.setParams({ gain: bg * 0.7, rate: 0.95 + fear * 0.15 + winded * 0.1 }, this.hush > 0 ? 0.05 : 0.4)
    } else if (this.breath) {
      this.breath.stop(0.6)
      this.breath = null
    }
    // The heartbeat: lub-dub at 60 → 150 bpm with fear, loudest in the silence.
    if (hunted && fear > 0.06) {
      if (now >= this.nextBeat) {
        const bpm = 62 + fear * 92
        const g = (0.25 + fear * 0.75) * (this.hush > 0 ? 1.35 : 1)
        this.near("heart", g, 1)
        const dub = 60 / bpm
        this.rt.playCue("timber.heart", { gain: g * 0.55, rate: 1.12, pan: 0, cutoffHz: 9000, wet: 0.03, time: this.rt.now + dub * 0.3 })
        this.nextBeat = now + dub
      }
    } else this.nextBeat = now
  }

  /** Stops every loop (a new round, the menu). */
  stopAll(): void {
    for (const e of this.engines.values()) for (const v of [e.idle, e.rev, e.cut]) v?.stop(0.1)
    this.engines.clear()
    this.breath?.stop(0.2)
    this.breath = null
    this.hush = 0
    this.stride.clear()
  }
}
