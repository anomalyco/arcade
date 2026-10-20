import type { AudioRuntime, CueRecipe, VoiceHandle } from "@arcade/kit/audio"
import type { Town } from "../../../shared/map"
import type { AudioSettings } from "../settings"
import { SCAPE_LAYER_KEYS } from "../settings"
import type { SoundEvent } from "../types"
import { scapeSound, SCAPE_LAYER_GROUP, SCAPE_LAYERS, SCAPE_SAMPLE_RATE, type ScapeLayer, type ScapeSoundDef } from "./catalog"
import { ScapeDirector, ScapeHours, type ScapeHold, type ScapeInput, type ScapeLevels } from "./director"
import { clearAmbientCalls, drainAmbientCalls, type AmbientCall, type AmbientHoldCall } from "./hooks"

export type ScapeFrame = {
  town: Town
  time: number
  dt: number
  hour: number
  /** The sim's own elapsed hours (0 on co-op clients, which count from the hour themselves). */
  elapsedHours: number
  startHour: number
  listener: { readonly x: number; readonly y: number }
  survivors: readonly { readonly x: number; readonly y: number }[]
  rain: number
  wetness: number
  storm: number
  glass: readonly { readonly x: number; readonly y: number }[]
  indoor: number
}

/** One-shots sit below everything else in the voice budget; a busy fight steals them first. */
const SHOT_PRIORITY = 12
const HOLD_PRIORITY = 30
/** Voices always left to the game's own sounds: the soundscape never takes these. */
const GAME_HEADROOM = 12

/** Levels per layer from the Lab settings (master × group × toggle), into `out`. */
export function scapeLevels(s: AudioSettings, out: ScapeLevels): ScapeLevels {
  const on = s.audioScape > 0
  const master = (s.audioScapeLevel ?? 100) / 100
  for (const layer of SCAPE_LAYERS) {
    const g = SCAPE_LAYER_GROUP[layer]
    const group = g === "interior" ? s.audioScapeInterior : g === "exterior" ? s.audioScapeExterior : s.audioScapeDistant
    out[layer] = on && s[SCAPE_LAYER_KEYS[layer]] ? (master * group) / 100 : 0
  }
  return out
}

/** The cue the runtime plays for a soundscape sound: one baked sample on the Ambience bus. */
export function scapeCue(def: ScapeSoundDef): CueRecipe {
  return {
    id: def.id,
    label: def.label,
    category: "ambience",
    masterGain: def.gain,
    loop: def.loop ?? false,
    wet: def.wet ?? 0.15,
    maxVoices: def.loop ? 12 : (def.maxVoices ?? 2),
    priority: def.loop ? HOLD_PRIORITY : SHOT_PRIORITY,
    steal: "steal-oldest",
    layers: [{ kind: "sample", samples: [def.id], envelope: def.loop ? { attack: 0.6 } : undefined }],
  }
}

type Held = { voice: VoiceHandle; id: string; stamp: number }

/**
 * The soundscape in the game (AR-86): runs `ScapeDirector` each frame, bakes its procedural sounds on first use (in a
 * Worker, so the frame never pays for synthesis), plays its one-shots through the shared `AudioRuntime` and keeps
 * its loops alive within a small voice budget. Positional sounds go through the runtime's spatialiser, so walls and
 * closed doors muffle them like everything else (`SoundOcclusion`); far sounds arrive already panned and filtered.
 */
export class Soundscape {
  readonly director = new ScapeDirector()
  readonly hours = new ScapeHours()
  private readonly levels = {} as ScapeLevels
  private readonly ready = new Set<string>()
  private readonly baking = new Set<string>()
  private readonly held = new Map<string, Held>()
  private readonly chosen = new Uint8Array(64)
  private readonly params = { gain: 0, pan: 0, cutoffHz: 18000, rate: 1 }
  private readonly mix = { gain: 0, pan: 0, cutoffHz: 18000 }
  private readonly input: ScapeInput
  private worker: Worker | null = null
  private workerFailed = false
  private stamp = 0
  /** For proofs and the harness. */
  readonly counts = { shots: 0, holdsStarted: 0, bakes: 0, bakeMs: 0, maxBakeMs: 0, updates: 0, updateMs: 0, maxUpdateMs: 0, skippedUnbaked: 0, hooks: 0 }

  constructor(
    private readonly runtime: AudioRuntime,
    private readonly playLibrary: (event: SoundEvent) => VoiceHandle | null,
    private readonly useWorker = typeof Worker !== "undefined",
  ) {
    this.input = {
      town: null as unknown as Town,
      time: 0,
      dt: 0,
      hour: 12,
      absHour: 12,
      listener: { x: 0, y: 0 },
      survivors: [],
      rain: 0,
      wetness: 0,
      storm: 0,
      glass: [],
      indoor: 0,
    }
  }

  reset(): void {
    this.director.reset()
    this.hours.reset()
    clearAmbientCalls()
    this.stopAll(0.3)
  }

  /** Bakes the sounds nearly every session hears, so the first clock is ready when you first walk in. */
  prewarm(): void {
    for (const id of ["scape.clock.tick", "scape.tap.drip", "scape.fridge.hum", "scape.house.creak.0", "scape.house.settle", "scape.siren", "scape.gunshot.pistol", "scape.insects"]) this.ensure(id)
  }

  update(frame: ScapeFrame, settings: AudioSettings, live: boolean): void {
    const t0 = performance.now()
    scapeLevels(settings, this.levels)
    const inp = this.input
    inp.town = frame.town
    inp.time = frame.time
    inp.dt = frame.dt
    inp.hour = frame.hour
    inp.absHour = this.hours.update(frame.hour, frame.elapsedHours, frame.startHour)
    inp.listener = frame.listener
    inp.survivors = frame.survivors
    inp.rain = frame.rain
    inp.wetness = frame.wetness
    inp.storm = frame.storm
    inp.glass = frame.glass
    inp.indoor = frame.indoor
    // The director runs muted too, so its memory (secrets sprung, the last frame's time) stays true.
    this.director.step(inp, this.levels)
    const stamp = ++this.stamp
    if (!live || settings.audioScape <= 0) {
      drainAmbientCalls(() => {}, () => {})
      this.stopAll(0.4)
      return
    }
    const rolloff = settings.audioFalloff ?? 1.55
    const d = this.director
    for (let i = 0; i < d.shotCount; i++) this.shot(d.shots[i]!.id, d.shots[i]!, rolloff)
    const hookLevel = this.levels.hooks
    if (hookLevel > 0) {
      drainAmbientCalls(
        (c) => this.hookShot(c, hookLevel, rolloff),
        (h) => this.hookHold(h, hookLevel),
      )
    } else drainAmbientCalls(() => {}, () => {})
    this.holds(Math.max(0, Math.min(Math.round(settings.audioScapeVoices), this.runtime.maxVoices - GAME_HEADROOM - this.runtime.activeVoiceCount + this.held.size)), rolloff, stamp)
    const ms = performance.now() - t0
    this.counts.updates++
    this.counts.updateMs += ms
    this.counts.maxUpdateMs = Math.max(this.counts.maxUpdateMs, ms)
  }

  private hookShot(c: AmbientCall, level: number, rolloff: number): void {
    this.counts.hooks++
    if (!scapeSound(c.id)) {
      this.playLibrary({ id: c.id, x: c.x, y: c.y, gain: c.gain * level, rate: c.rate, delay: c.delay, source: "scape" })
      return
    }
    this.shot(c.id, { x: c.x, y: c.y, gain: c.gain * level, rate: c.rate, delay: c.delay, far: false, pan: 0, cutoffHz: 18000 }, rolloff)
  }

  private hookHold(h: AmbientHoldCall, level: number): void {
    const d = this.director
    if (d.holdCount >= d.holds.length || !scapeSound(h.id)) return
    const slot = d.holds[d.holdCount++]!
    slot.key = `hook:${h.key}`
    slot.id = h.id
    slot.x = h.x
    slot.y = h.y
    slot.gain = h.gain * level
    slot.rate = h.rate
    slot.far = false
    slot.pan = 0
    slot.cutoffHz = 18000
    slot.score = slot.gain / (1 + Math.hypot(h.x - this.input.listener.x, h.y - this.input.listener.y) ** 2 / 4)
  }

  private shot(id: string, s: { x: number; y: number; gain: number; rate: number; delay: number; far: boolean; pan: number; cutoffHz: number }, rolloff: number): void {
    const def = scapeSound(id)
    if (!def || !this.ensure(id)) {
      this.counts.skippedUnbaked++
      return
    }
    const voice = this.runtime.playCue(id, {
      time: this.runtime.now + s.delay,
      gain: s.gain,
      rate: s.rate,
      priority: SHOT_PRIORITY,
      ...(s.far
        ? { pan: s.pan, cutoffHz: s.cutoffHz }
        : { position: { x: s.x, z: s.y, refDistance: def.range.ref, maxDistance: def.range.max, rolloff } }),
    })
    if (voice) this.counts.shots++
  }

  /** Keeps the `budget` best-scored loops playing (re-placed every frame) and fades out the rest. */
  private holds(budget: number, rolloff: number, stamp: number): void {
    const d = this.director
    const n = Math.min(d.holdCount, this.chosen.length)
    this.chosen.fill(0, 0, n)
    for (let pick = 0; pick < budget; pick++) {
      let best = -1
      for (let i = 0; i < n; i++) if (!this.chosen[i] && (best < 0 || d.holds[i]!.score > d.holds[best]!.score)) best = i
      if (best < 0) break
      this.chosen[best] = 1
    }
    for (let i = 0; i < n; i++) {
      if (!this.chosen[i]) continue
      const h = d.holds[i]!
      const def = scapeSound(h.id)
      if (!def || !this.ensure(h.id)) continue
      this.mixFor(h, def, rolloff)
      const have = this.held.get(h.key)
      if (have?.voice.active && have.id === h.id) {
        have.stamp = stamp
        const p = this.params
        p.gain = def.gain * this.mix.gain
        p.pan = this.mix.pan
        p.cutoffHz = this.mix.cutoffHz
        p.rate = h.rate
        have.voice.setParams(p, 0.25)
        continue
      }
      have?.voice.stop(0.3)
      if (this.mix.gain < 0.002) continue
      const voice = this.runtime.playCue(h.id, { gain: this.mix.gain, pan: this.mix.pan, cutoffHz: this.mix.cutoffHz, rate: h.rate, ownerKey: h.key, priority: HOLD_PRIORITY })
      if (voice) {
        this.held.set(h.key, { voice, id: h.id, stamp })
        this.counts.holdsStarted++
      } else this.held.delete(h.key)
    }
    for (const [key, have] of this.held) {
      if (have.stamp === stamp && have.voice.active) continue
      have.voice.stop(0.6)
      this.held.delete(key)
    }
  }

  /**
   * The level, pan and low-pass a loop gets this frame: the runtime's spatial model (distance, air, walls) for
   * positional loops, the director's own placement for far ones. Written into `this.mix` (no allocation).
   */
  private mixFor(h: ScapeHold, def: ScapeSoundDef, rolloff: number): void {
    const m = this.mix
    if (h.far) {
      m.gain = h.gain
      m.pan = h.pan
      m.cutoffHz = h.cutoffHz
      return
    }
    const rt = this.runtime
    const L = rt.listener
    const earH = L.earHeight ?? 16
    const dx = h.x - L.x
    const dz = h.y - L.z
    const flat = Math.hypot(dx, dz)
    const d3 = Math.hypot(flat, earH)
    const ref = earH + def.range.ref
    let gain = d3 <= ref ? 1 : Math.pow(ref / d3, rolloff)
    const fadeFrom = def.range.max * 0.75
    if (flat > fadeFrom) gain *= Math.max(0, 1 - (flat - fadeFrom) / Math.max(1, def.range.max - fadeFrom))
    let cutoff = Math.max(700, 16500 * Math.exp(-flat / 70))
    const q = rt.visibilityQuery?.(L.x, L.z, h.x, h.y) ?? 0
    const occ = typeof q === "boolean" ? (q ? 1 : 0) : Math.max(0, Math.min(1, q))
    if (occ > 0) {
      gain *= 1 - 0.52 * occ
      cutoff = Math.min(cutoff, 16500 * Math.pow(580 / 16500, occ))
    }
    m.gain = gain * h.gain
    m.pan = Math.max(-0.9, Math.min(0.9, ((dx * (L.rightX ?? 1) + dz * (L.rightZ ?? 0)) / (L.panScale ?? 38)) * 0.85))
    m.cutoffHz = Math.min(cutoff, h.cutoffHz)
  }

  /** Whether `id` is baked and registered; starts baking it if not. */
  private ensure(id: string): boolean {
    if (this.ready.has(id)) return true
    if (this.baking.has(id)) return false
    const def = scapeSound(id)
    if (!def) return false
    this.baking.add(id)
    const worker = this.useWorker && !this.workerFailed && !def.layer.startsWith("hooks") ? this.bakeWorker() : null
    if (worker) {
      worker.postMessage({ id })
      return false
    }
    const t0 = performance.now()
    this.register(def, def.bake(SCAPE_SAMPLE_RATE), performance.now() - t0)
    return true
  }

  private bakeWorker(): Worker | null {
    if (this.worker) return this.worker
    try {
      const w = new Worker(new URL("./bake-worker.ts", import.meta.url), { type: "module" })
      w.onmessage = (e: MessageEvent<{ id: string; pcm: Float32Array; ms: number }>) => {
        const def = scapeSound(e.data.id)
        if (def) this.register(def, e.data.pcm, e.data.ms)
      }
      w.onerror = () => {
        this.workerFailed = true
        this.baking.clear()
      }
      this.worker = w
      return w
    } catch {
      this.workerFailed = true
      return null
    }
  }

  private register(def: ScapeSoundDef, pcm: Float32Array, ms: number): void {
    this.runtime.sampleBank.setDecoded(def.id, { sampleRate: SCAPE_SAMPLE_RATE, channels: [pcm] }, true)
    this.runtime.registerCues([scapeCue(def)])
    this.baking.delete(def.id)
    this.ready.add(def.id)
    this.counts.bakes++
    this.counts.bakeMs += ms
    this.counts.maxBakeMs = Math.max(this.counts.maxBakeMs, ms)
  }

  stopAll(fade = 0.05): void {
    for (const have of this.held.values()) have.voice.stop(fade)
    this.held.clear()
  }

  telemetry() {
    const c = this.counts
    return {
      ...c,
      meanUpdateMs: c.updates ? c.updateMs / c.updates : 0,
      ready: this.ready.size,
      loops: [...this.held.keys()],
      events: { ...this.director.counts },
      absHour: Math.round(this.input.absHour * 100) / 100,
    }
  }

  dispose(): void {
    this.worker?.terminate()
    this.worker = null
  }
}

export type { ScapeLayer }
