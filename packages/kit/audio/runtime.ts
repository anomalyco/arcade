import { mulberry32 } from "../sim/rng"
import { CUE_BY_ID, DEFAULT_CUES } from "./cues"
export { mulberry32 } from "../sim/rng"
import { DEFAULT_SAMPLE_MANIFEST, defaultSfxBaseUrl, SampleBank } from "./manifest"
import { clamp, fallTime, holdParam, scheduleSynthLayer, smoothParam, type ScheduledLayerNodes } from "./synth"
import type {
  AudioTelemetry,
  CueLayerSpec,
  CueRecipe,
  ListenerState,
  MixCategory,
  OccluderBox,
  PlayCueOptions,
  SampleAssetMeta,
  SampleLayerSpec,
  SampleSelectionMode,
  SourcePose,
  SpatialMix,
  VisibilityQuery,
  VoiceHandle,
  VoiceUpdateParams,
  WeightedSampleRef,
} from "./types"

export const MIX_CATEGORIES: readonly MixCategory[] = ["engine", "tyre", "impact", "ambience", "spell", "ui", "weapon", "foley", "voice"]
const SOUND_SPEED = 260

/**
 * 2D segment/AABB slab test at street/room height.
 */
export function blocked(x: number, z: number, tx: number, tz: number, b: OccluderBox): boolean {
  let lo = 0.01
  let hi = 0.99
  for (const [a, d, min, max] of [
    [x, tx - x, b.x0, b.x1],
    [z, tz - z, b.z0, b.z1],
  ] as const) {
    if (Math.abs(d) < 1e-6) {
      if (a < min || a > max) return false
      continue
    }
    const p = (min - a) / d
    const q = (max - a) / d
    lo = Math.max(lo, Math.min(p, q))
    hi = Math.min(hi, Math.max(p, q))
    if (lo > hi) return false
  }
  return true
}

export function createBoxOcclusionQuery(boxes: readonly OccluderBox[]): VisibilityQuery {
  return (lx, lz, sx, sz) => {
    let hits = 0
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i]!
      if (b.h !== undefined && b.h <= 1.5) continue
      if (blocked(lx, lz, sx, sz, b)) {
        hits++
        if (hits >= 2) return 1
      }
    }
    return hits === 1 ? 0.75 : 0
  }
}

/** A small furnished room: dense early reflections, fast bright-to-dark decay. */
function buildRoomImpulse(ctx: BaseAudioContext, seconds = 0.5): AudioBuffer {
  const n = Math.max(256, Math.floor(ctx.sampleRate * seconds))
  const buf = ctx.createBuffer(2, n, ctx.sampleRate)
  let seed = 7654321
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff - 0.5
  }
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c)
    for (let i = 0; i < n; i++) {
      const t = i / ctx.sampleRate
      d[i] = rnd() * Math.exp(-t * (6.9 / seconds)) * (t < 0.003 ? t / 0.003 : 1)
    }
    for (const [tap, g] of [[0.007 + c * 0.002, 0.7], [0.013 - c * 0.001, 0.5], [0.021 + c * 0.003, 0.35], [0.029, 0.25]] as const) {
      const k = Math.floor(tap * ctx.sampleRate)
      for (let i = 0; i < 48 && k + i < n; i++) d[k + i]! += rnd() * g * (1 - i / 48)
    }
    let lp = 0
    for (let i = 0; i < n; i++) {
      lp += (d[i]! - lp) * (0.85 - 0.6 * (i / n))
      d[i] = lp
    }
  }
  return buf
}

function buildStreetImpulse(ctx: BaseAudioContext, seconds = 1.65): AudioBuffer {
  const n = Math.max(256, Math.floor(ctx.sampleRate * seconds))
  const buf = ctx.createBuffer(2, n, ctx.sampleRate)
  let seed = 1234567
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff - 0.5
  }
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c)
    for (let i = 0; i < n; i++) {
      const t = i / ctx.sampleRate
      d[i] = rnd() * Math.exp(-t * 3.6) * (t < 0.012 ? t / 0.012 : 1)
    }
    for (const [tap, g] of [
      [0.043 + c * 0.007, 0.5],
      [0.091 - c * 0.005, 0.32],
      [0.137 + c * 0.011, 0.2],
    ] as const) {
      const k = Math.floor(tap * ctx.sampleRate)
      for (let i = 0; i < 160 && k + i < n; i++) {
        d[k + i]! += rnd() * g * (1 - i / 160)
      }
    }
    let lp = 0
    for (let i = 0; i < n; i++) {
      const a = 0.5 * Math.exp((-i / n) * 2.5)
      lp += (d[i]! - lp) * a
      d[i] = lp
    }
  }
  return buf
}

type InternalVoice = {
  id: number
  cueId: string
  ownerKey: string
  category: MixCategory
  startTime: number
  endTime: number
  active: boolean
  samplesPicked: string[]
  gainNode: GainNode
  panNode: StereoPannerNode
  filterNode: BiquadFilterNode
  sendNode: GainNode
  sampleSources: { src: AudioBufferSourceNode; baseRate: number }[]
  synthLayers: ScheduledLayerNodes[]
  stop(fadeSeconds?: number): void
  setParams(params: VoiceUpdateParams, tau?: number): void
}

export type AudioRuntimeOptions = {
  context?: AudioContext | OfflineAudioContext
  seed?: number
  maxVoices?: number
  reverbSeconds?: number
  /** Adds a short room reverb beside the street one; `setSpace` crossfades between them (indoors vs outdoors). */
  roomReverbSeconds?: number
  reverbWet?: number
  storageKey?: string
  visibilityQuery?: VisibilityQuery
  /** Binds window pointer/key unlock and KeyM mute listeners. Defaults to false (explicit unlock). */
  autoBindDom?: boolean
  manifest?: readonly SampleAssetMeta[]
  baseUrl?: string
  cues?: readonly CueRecipe[]
}

export class AudioRuntime {
  ctx: AudioContext | OfflineAudioContext | null = null
  /** Explicit clock for deterministic offline scheduling; live mode uses `ctx.currentTime`. */
  scheduleTime: number | null = null

  master!: GainNode
  verb!: GainNode
  verbOut!: GainNode
  /** Room reverb return, when `roomReverbSeconds` is set. */
  roomOut: GainNode | null = null
  duckNode!: GainNode
  dazeNode!: BiquadFilterNode
  analyser: AnalyserNode | null = null
  buses!: Record<MixCategory, GainNode>

  readonly sampleBank: SampleBank
  readonly cues = new Map<string, CueRecipe>()

  muted = false
  /** Master level applied while unmuted (0..1). */
  volume = 1
  maxVoices: number
  visibilityQuery?: VisibilityQuery
  /** Optional real-time audio quantum callback (~5.33 ms at 48 kHz) for high-precision frame pacing. */
  onTick: (() => void) | null = null

  private seed: number
  private rng: () => number
  private roundRobinState = new Map<string, number>()
  private lastPickedSample = new Map<string, string>()
  private lastCueTrigger = new Map<string, number>()
  private voices = new Map<number, InternalVoice>()
  private nextVoiceId = 1
  private droppedVoices = 0
  /** Cues skipped because a sample they need was still loading. */
  private pendingSkips = 0
  private stolenVoices = 0
  private reverbSeconds: number
  private roomReverbSeconds: number | undefined
  private space = 0
  private reverbWetValue: number
  private duckCurrent = 1
  private dazeCurrentHz = 20000
  private storageKey?: string
  private muteListeners: ((muted: boolean) => void)[] = []
  private domEvents = new AbortController()
  private disposed = false
  private interruptListeners = new Set<(dispose: boolean) => void>()
  private pacerNode: ScriptProcessorNode | null = null
  private loadPromise: Promise<number> | null = null

  listener: ListenerState = {
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vz: 0,
    rightX: 1,
    rightZ: 0,
    earHeight: 16,
  }

  constructor(options: AudioRuntimeOptions = {}) {
    this.seed = options.seed ?? 7
    this.rng = mulberry32(this.seed)
    this.maxVoices = options.maxVoices ?? 24
    this.reverbSeconds = options.reverbSeconds ?? 1.65
    this.roomReverbSeconds = options.roomReverbSeconds
    this.reverbWetValue = options.reverbWet ?? 0.5
    this.storageKey = options.storageKey
    this.visibilityQuery = options.visibilityQuery

    this.sampleBank = new SampleBank(options.manifest ?? DEFAULT_SAMPLE_MANIFEST, options.baseUrl ?? defaultSfxBaseUrl())
    this.sampleBank.seedFallbacks()
    this.registerCues(options.cues ?? DEFAULT_CUES)

    if (this.storageKey && typeof localStorage !== "undefined") {
      try {
        this.muted = localStorage.getItem(this.storageKey) === "1"
      } catch {}
    }

    if (options.context) {
      this.attachContext(options.context)
    }

    if (options.autoBindDom && typeof window !== "undefined") {
      this.bindDomLifecycle()
    }
  }

  get now(): number {
    return this.scheduleTime ?? this.ctx?.currentTime ?? 0
  }

  get isOffline(): boolean {
    return typeof OfflineAudioContext !== "undefined" && this.ctx instanceof OfflineAudioContext
  }

  setSeed(seed: number): void {
    this.seed = seed | 0
    this.rng = mulberry32(this.seed)
    this.roundRobinState.clear()
    this.lastPickedSample.clear()
  }

  getSeed(): number {
    return this.seed
  }

  nextRandom(): number {
    return this.rng()
  }

  registerManifest(entries: readonly SampleAssetMeta[], baseUrl?: string): void {
    this.sampleBank.registerManifest(entries, baseUrl)
    this.sampleBank.seedFallbacks(this.ctx?.sampleRate ?? 48000)
  }

  registerCues(recipes: readonly CueRecipe[]): void {
    for (const recipe of recipes) {
      this.cues.set(recipe.id, recipe)
    }
  }

  attachContext(ctx: AudioContext | OfflineAudioContext): void {
    if (this.disposed) throw new Error("AudioRuntime has been disposed")
    this.ctx = ctx
    this.buildGraph(ctx)
    this.sampleBank.seedFallbacks(ctx.sampleRate)
  }

  async attachOffline(ctx: OfflineAudioContext, loadNetworkSamples = false): Promise<void> {
    this.attachContext(ctx)
    if (loadNetworkSamples) {
      await this.sampleBank.loadAll(ctx)
    }
  }

  /**
   * Explicitly initializes and resumes a live `AudioContext` from a user gesture (e.g. clicking Audition).
   * Never autoplays without an explicit call or bound gesture.
   */
  async unlock(): Promise<boolean> {
    if (this.disposed) return false
    if (!this.ctx) {
      if (typeof AudioContext === "undefined") return false
      try {
        const ctx = new AudioContext({ latencyHint: "interactive" })
        this.attachContext(ctx)
        this.loadPromise = this.sampleBank.loadAll(ctx)
      } catch {
        return false
      }
    }
    const ctx = this.ctx
    if (!ctx) return false
    if ("resume" in ctx && ctx.state === "suspended") {
      try {
        await ctx.resume()
      } catch {
        return false
      }
    }
    if (this.loadPromise) {
      try {
        await this.loadPromise
      } catch {}
    }
    return ctx.state === "running"
  }

  bindDomLifecycle(): void {
    if (typeof window === "undefined") return
    const signal = this.domEvents.signal
    const unlockGesture = () => {
      void this.unlock()
    }
    window.addEventListener("pointerdown", unlockGesture, { capture: true, signal })
    window.addEventListener("keydown", unlockGesture, { capture: true, signal })
    window.addEventListener("touchend", unlockGesture, { capture: true, signal })

    window.addEventListener(
      "keydown",
      e => {
        if ((e.code !== "KeyM" && e.key.toLowerCase() !== "m") || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return
        const t = e.target as HTMLElement | null
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return
        this.setMuted(!this.muted)
      },
      { signal },
    )

    if (typeof document !== "undefined") {
      document.addEventListener(
        "visibilitychange",
        () => {
          if (document.hidden) this.suspend()
          else void this.resume()
        },
        { signal },
      )
    }
    window.addEventListener("blur", () => this.stopAllVoices(0.025), { signal })
    window.addEventListener("pagehide", () => this.suspend(), { signal })
  }

  private buildGraph(ctx: BaseAudioContext): void {
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -14
    comp.knee.value = 12
    comp.ratio.value = 3
    comp.attack.value = 0.006
    comp.release.value = 0.25

    const limiter = ctx.createDynamicsCompressor()
    limiter.threshold.value = -3
    limiter.knee.value = 0
    limiter.ratio.value = 20
    limiter.attack.value = 0.001
    limiter.release.value = 0.09

    // Fixed output headroom protects overlapping transient peaks (-16 LUFS target).
    const output = ctx.createGain()
    output.gain.value = 0.66

    const subCut = ctx.createBiquadFilter()
    subCut.type = "highpass"
    subCut.frequency.value = 32
    subCut.Q.value = 0.707

    this.master = ctx.createGain()
    this.master.gain.value = this.muted ? 0 : this.volume

    this.dazeNode = ctx.createBiquadFilter()
    this.dazeNode.type = "lowpass"
    this.dazeNode.frequency.value = 20000
    this.dazeNode.Q.value = 0.707

    this.duckNode = ctx.createGain()
    this.duckNode.gain.value = 1

    this.duckNode.connect(this.dazeNode)
    this.dazeNode.connect(subCut)
    subCut.connect(this.master)
    this.master.connect(comp)
    comp.connect(limiter)
    limiter.connect(output)

    if (typeof ctx.createAnalyser === "function") {
      try {
        this.analyser = ctx.createAnalyser()
        this.analyser.fftSize = 1024
        this.analyser.smoothingTimeConstant = 0.75
        output.connect(this.analyser)
        this.analyser.connect(ctx.destination)
      } catch {
        this.analyser = null
        output.connect(ctx.destination)
      }
    } else {
      output.connect(ctx.destination)
    }

    const buses = {} as Record<MixCategory, GainNode>
    for (const category of MIX_CATEGORIES) {
      const g = ctx.createGain()
      g.gain.value = 1
      // UI bypasses duck and daze so interface feedback and player hit stingers stay crisp.
      if (category === "ui") g.connect(subCut)
      else g.connect(this.duckNode)
      buses[category] = g
    }
    this.buses = buses

    const conv = ctx.createConvolver()
    conv.buffer = buildStreetImpulse(ctx, this.reverbSeconds)
    this.verbOut = ctx.createGain()
    this.verbOut.gain.value = this.reverbWetValue
    this.verb = ctx.createGain()
    this.verb.gain.value = 1
    this.verb.connect(conv)
    conv.connect(this.verbOut)
    this.verbOut.connect(this.duckNode)
    if (this.roomReverbSeconds) {
      const room = ctx.createConvolver()
      room.buffer = buildRoomImpulse(ctx, this.roomReverbSeconds)
      this.roomOut = ctx.createGain()
      this.roomOut.gain.value = 0
      this.verb.connect(room)
      room.connect(this.roomOut)
      this.roomOut.connect(this.duckNode)
      this.applySpace(0)
    }
    if (this.pacerNode) {
      try {
        this.pacerNode.disconnect()
      } catch {}
      this.pacerNode.onaudioprocess = null
      this.pacerNode = null
    }
    if (
      typeof AudioContext !== "undefined" &&
      ctx instanceof AudioContext &&
      typeof ctx.createScriptProcessor === "function"
    ) {
      try {
        const pacer = ctx.createScriptProcessor(256, 0, 1)
        pacer.onaudioprocess = () => {
          this.onTick?.()
        }
        pacer.connect(ctx.destination)
        this.pacerNode = pacer
      } catch {}
    }
  }

  onMute(fn: (muted: boolean) => void): () => void {
    this.muteListeners.push(fn)
    fn(this.muted)
    return () => {
      const idx = this.muteListeners.indexOf(fn)
      if (idx >= 0) this.muteListeners.splice(idx, 1)
    }
  }

  /** Continuous emitter ownership follows the same stop/reset/dispose lifecycle as cue voices. */
  onInterrupt(fn: (dispose: boolean) => void): () => void {
    this.interruptListeners.add(fn)
    return () => { this.interruptListeners.delete(fn) }
  }

  setMuted(muted: boolean): void {
    if (this.muted === muted) return
    this.muted = muted
    if (this.storageKey && typeof localStorage !== "undefined") {
      try {
        localStorage.setItem(this.storageKey, muted ? "1" : "0")
      } catch {}
    }
    if (this.ctx && this.master) {
      const t = this.now
      holdParam(this.master.gain, t, muted ? this.volume : 0)
      this.master.gain.linearRampToValueAtTime(muted ? 0 : this.volume, t + 0.025)
    }
    if (muted) {
      this.stopAllVoices(0.02)
    }
    for (const fn of this.muteListeners) fn(muted)
  }

  /** Master volume while unmuted; muting still ramps to silence and back to this level. */
  setVolume(level: number, tau = 0.03): void {
    this.volume = clamp(level, 0, 1)
    if (this.ctx && this.master && !this.muted) smoothParam(this.master.gain, this.volume, this.now, tau)
  }

  setReverbWet(wet: number, tau = 0.06): void {
    this.reverbWetValue = clamp(wet, 0, 1.2)
    if (this.roomOut) this.applySpace(tau)
    else if (this.ctx && this.verbOut) {
      smoothParam(this.verbOut.gain, this.reverbWetValue, this.now, tau)
    }
  }

  /** 0 = outdoors (street reverb), 1 = indoors (room reverb). Needs `roomReverbSeconds`. */
  setSpace(indoor: number, tau = 0.25): void {
    this.space = clamp(indoor, 0, 1)
    this.applySpace(tau)
  }

  private applySpace(tau: number): void {
    if (!this.ctx || !this.verbOut || !this.roomOut) return
    // Equal-power crossfade so the total reverb energy holds through a doorway.
    smoothParam(this.verbOut.gain, this.reverbWetValue * Math.cos((this.space * Math.PI) / 2), this.now, tau)
    smoothParam(this.roomOut.gain, this.reverbWetValue * Math.sin((this.space * Math.PI) / 2), this.now, tau)
  }

  setBusGain(category: MixCategory, level: number, tau = 0.05): void {
    if (!this.ctx || !this.buses) return
    smoothParam(this.buses[category].gain, Math.max(0, level), this.now, tau)
  }

  duck(seconds: number, depth = 0.45): void {
    this.duckCurrent = clamp(depth, 0.05, 1)
    if (!this.ctx || !this.duckNode) return
    const g = this.duckNode.gain
    const t = this.now
    g.cancelScheduledValues(t)
    g.setTargetAtTime(this.duckCurrent, t, 0.025)
    g.setTargetAtTime(1, t + Math.max(0.02, seconds), 0.4)
  }

  daze(seconds: number, cutoffHz = 750): void {
    this.dazeCurrentHz = clamp(cutoffHz, 200, 20000)
    if (!this.ctx || !this.dazeNode) return
    const f = this.dazeNode.frequency
    const t = this.now
    f.cancelScheduledValues(t)
    f.setValueAtTime(Math.max(200, f.value || 20000), t)
    f.exponentialRampToValueAtTime(this.dazeCurrentHz, t + 0.04)
    f.setTargetAtTime(20000, t + seconds * 0.45, Math.max(0.08, seconds * 0.3))
  }

  setListener(state: ListenerState): void {
    this.listener = {
      ...this.listener,
      ...state,
    }
  }

  /**
   * Computes distance attenuation, stereo pan, air-absorption low-pass, distance reverb send,
   * bounded Doppler pitch shift, and visibility-query occlusion filtering.
   */
  spatialize(pose?: SourcePose): SpatialMix {
    if (!pose) {
      return {
        gain: 1,
        pan: 0,
        cutoffHz: 18500,
        wet: 0.08,
        distance: 0,
        doppler: 1,
        occlusion: 0,
      }
    }
    const lx = this.listener.x
    const lz = this.listener.z
    const earH = this.listener.earHeight ?? 16
    const dx = pose.x - lx
    const dz = pose.z - lz
    const flatDist = Math.hypot(dx, dz)
    const d3 = Math.hypot(flatDist, earH + (pose.y ?? 0))
    const ref = earH + (pose.refDistance ?? 6)
    const maxDist = pose.maxDistance ?? 150
    const rolloff = pose.rolloff ?? 1.25

    let gain = d3 <= ref ? 1 : Math.pow(ref / d3, rolloff)
    const fadeFrom = maxDist * 0.75
    if (flatDist > fadeFrom) {
      gain *= Math.max(0, 1 - (flatDist - fadeFrom) / Math.max(1, maxDist - fadeFrom))
    }

    const rx = this.listener.rightX ?? 1
    const rz = this.listener.rightZ ?? 0
    const pan = clamp(((dx * rx + dz * rz) / (this.listener.panScale ?? 38)) * 0.85, -0.9, 0.9)

    let cutoffHz = Math.max(700, 16500 * Math.exp(-flatDist / 70))
    let wet = Math.min(0.55, 0.08 + flatDist / 200)

    let doppler = 1
    if (pose.vx !== undefined || pose.vz !== undefined) {
      const rvx = (pose.vx ?? 0) - (this.listener.vx ?? 0)
      const rvz = (pose.vz ?? 0) - (this.listener.vz ?? 0)
      const away = (rvx * dx + rvz * dz) / Math.max(1, d3)
      const rawDoppler = SOUND_SPEED / (SOUND_SPEED + away * (pose.dopplerScale ?? 1))
      doppler = clamp(rawDoppler, 0.8, 1.25)
    }

    let occlusion = 0
    if (this.visibilityQuery) {
      const q = this.visibilityQuery(lx, lz, pose.x, pose.z)
      occlusion = typeof q === "boolean" ? (q ? 1 : 0) : clamp(q, 0, 1)
    }
    if (occlusion > 0) {
      gain *= 1 - 0.36 * occlusion
      cutoffHz = Math.min(cutoffHz, 16500 * Math.pow(950 / 16500, occlusion))
      wet = Math.min(0.68, wet + 0.16 * occlusion)
    }

    return {
      gain,
      pan,
      cutoffHz,
      wet,
      distance: flatDist,
      doppler,
      occlusion,
    }
  }

  /**
   * Deterministic sample picker supporting `"round-robin"` (no immediate repeat),
   * `"weighted"`, and `"random"` modes using the runtime's seeded PRNG.
   */
  pickSample(
    samples: readonly WeightedSampleRef[],
    mode: SampleSelectionMode = "round-robin",
    poolKey = "default",
  ): { id: string; rate: number; gain: number } {
    if (samples.length === 0) throw new Error(`Empty sample pool for ${poolKey}`)
    const normalize = (entry: WeightedSampleRef) =>
      typeof entry === "string"
        ? { id: entry, weight: 1, rate: 1, gain: 1 }
        : { id: entry.id, weight: Math.max(0.001, entry.weight ?? 1), rate: entry.rate ?? 1, gain: entry.gain ?? 1 }

    if (samples.length === 1) {
      const single = normalize(samples[0]!)
      this.lastPickedSample.set(poolKey, single.id)
      return single
    }

    const lastId = this.lastPickedSample.get(poolKey)

    if (mode === "round-robin") {
      const currentIdx = this.roundRobinState.get(poolKey)
      let nextIdx: number
      if (currentIdx === undefined) {
        nextIdx = Math.floor(this.rng() * samples.length)
      } else {
        // Step forward deterministically without repeating the previous index
        const step = 1 + Math.floor(this.rng() * Math.max(1, samples.length - 1))
        nextIdx = (currentIdx + step) % samples.length
      }
      this.roundRobinState.set(poolKey, nextIdx)
      const chosen = normalize(samples[nextIdx]!)
      this.lastPickedSample.set(poolKey, chosen.id)
      return chosen
    }

    if (mode === "weighted") {
      const normalized = samples.map(normalize)
      const candidates = normalized.length > 1 && lastId ? normalized.filter(item => item.id !== lastId) : normalized
      const total = candidates.reduce((acc, item) => acc + item.weight, 0)
      let draw = this.rng() * total
      for (const item of candidates) {
        draw -= item.weight
        if (draw <= 0) {
          this.lastPickedSample.set(poolKey, item.id)
          return item
        }
      }
      const fallback = candidates[candidates.length - 1]!
      this.lastPickedSample.set(poolKey, fallback.id)
      return fallback
    }

    // "random" mode (still avoids immediate repeat when pool > 1)
    let idx = Math.floor(this.rng() * samples.length)
    if (normalize(samples[idx]!).id === lastId) {
      idx = (idx + 1 + Math.floor(this.rng() * (samples.length - 1))) % samples.length
    }
    const picked = normalize(samples[idx]!)
    this.lastPickedSample.set(poolKey, picked.id)
    return picked
  }

  private pruneVoices(now = this.now): void {
    for (const [id, voice] of this.voices) {
      if (!voice.active || now >= voice.endTime) {
        voice.active = false
        this.voices.delete(id)
      }
    }
  }

  /**
   * Triggers a registered `CueRecipe` (or inline recipe) with seeded variation,
   * layer intensity gating, voice budget enforcement, and spatialization.
   */
  playCue(cueOrId: string | CueRecipe, options: PlayCueOptions = {}): VoiceHandle | null {
    if (this.disposed || this.muted || !this.ctx) return null
    const cue = typeof cueOrId === "string" ? (this.cues.get(cueOrId) ?? CUE_BY_ID.get(cueOrId)) : cueOrId
    if (!cue) return null
    // Silence beats a synthesized stand-in while the real files load: callers retry (beds and holds every frame).
    if (this.waitingForSamples(cue)) {
      this.pendingSkips++
      return null
    }

    const t = options.time ?? this.now
    this.pruneVoices(t)

    // Cooldown check
    if (cue.cooldownSeconds && cue.cooldownSeconds > 0) {
      const last = this.lastCueTrigger.get(cue.id)
      if (last !== undefined && t - last < cue.cooldownSeconds - 1e-6) {
        this.droppedVoices++
        return null
      }
    }

    const spatial = this.spatialize(options.position)
    const combinedGain = (cue.masterGain ?? 1) * (options.gain ?? 1) * spatial.gain
    if (combinedGain < 0.005) {
      return null
    }

    const ownerKey = options.ownerKey ?? cue.id
    const stealPolicy = cue.steal ?? "steal-oldest"

    // 1. If policy is "replace", fade out any active voice with the same ownerKey
    if (stealPolicy === "replace") {
      for (const existing of this.voices.values()) {
        if (existing.active && existing.ownerKey === ownerKey) {
          existing.stop(0.03)
          this.voices.delete(existing.id)
          this.stolenVoices++
        }
      }
    }

    // 2. Enforce per-cue maxVoices
    const cueMax = cue.maxVoices ?? this.maxVoices
    const activeForCue = [...this.voices.values()].filter(v => v.active && v.cueId === cue.id)
    if (activeForCue.length >= cueMax) {
      if (stealPolicy === "drop") {
        this.droppedVoices++
        return null
      }
      activeForCue.sort((a, b) => a.startTime - b.startTime)
      const victim = activeForCue[0]!
      victim.stop(0.02)
      this.voices.delete(victim.id)
      this.stolenVoices++
    }

    // 3. Enforce global maxVoices budget
    if (this.voices.size >= this.maxVoices) {
      if (stealPolicy === "drop") {
        this.droppedVoices++
        return null
      }
      // Beds and other loops are never the victim of an unrelated one-shot: steal the oldest finite voice.
      const finite = [...this.voices.values()].filter(v => Number.isFinite(v.endTime)).sort((a, b) => a.startTime - b.startTime)
      const victim = finite[0]
      if (!victim && !cue.loop) {
        this.droppedVoices++
        return null
      }
      if (victim) {
        victim.stop(0.02)
        this.voices.delete(victim.id)
        this.stolenVoices++
      }
    }

    this.lastCueTrigger.set(cue.id, t)

    // Coupled Strike variation (inspired by Cuelume: harder strikes are louder and brighter together)
    const pitchVar = options.pitchVariation ?? cue.pitchVariation ?? 0
    const gainVar = options.gainVariation ?? cue.gainVariation ?? 0
    const strikePitch = 1 + (this.rng() * 2 - 1) * pitchVar
    const strikeForce = clamp((options.force ?? 1) * (1 + (this.rng() * 2 - 1) * gainVar), 0.2, 2.0)
    const intensity = clamp(options.intensity ?? options.force ?? 0.75, 0, 1)

    const ctx = this.ctx
    const voiceFilter = ctx.createBiquadFilter()
    voiceFilter.type = "lowpass"
    const initialCutoff = Math.min(options.cutoffHz ?? 18500, spatial.cutoffHz)
    voiceFilter.frequency.setValueAtTime( clamp(initialCutoff, 80, 20000), t)

    const voiceGain = ctx.createGain()
    voiceGain.gain.setValueAtTime(combinedGain, t)

    const voicePan = ctx.createStereoPanner()
    voicePan.pan.setValueAtTime(clamp(options.pan ?? spatial.pan, -1, 1), t)

    const voiceSend = ctx.createGain()
    const wetAmount = clamp((options.wet ?? cue.wet ?? 0.1) + spatial.wet * 0.65, 0, 0.85)
    voiceSend.gain.setValueAtTime(wetAmount, t)

    const busNode = this.buses[cue.category] ?? this.buses.impact
    voiceFilter.connect(voiceGain)
    voiceGain.connect(voicePan)
    voicePan.connect(busNode)
    voicePan.connect(voiceSend)
    voiceSend.connect(this.verb)

    const samplesPicked: string[] = []
    const sampleSources: { src: AudioBufferSourceNode; baseRate: number }[] = []
    const synthLayers: ScheduledLayerNodes[] = []
    let remainingLayers = 0
    const layerEnded = () => {
      if (--remainingLayers !== 0) return
      for (const node of [voiceFilter, voiceGain, voicePan, voiceSend]) node.disconnect()
      voice.active = false
      this.voices.delete(id)
    }
    let maxEndTime = t + 0.05

    for (let idx = 0; idx < cue.layers.length; idx++) {
      const layer = cue.layers[idx]!
      const minI = layer.minIntensity ?? 0
      const maxI = layer.maxIntensity ?? 1
      if (intensity < minI || intensity > maxI) continue

      const weight = this.layerIntensityWeight(layer, intensity)
      if (weight <= 0.01) continue

      const layerTimingJitter = layer.timingVariation ? this.rng() * layer.timingVariation : 0
      const layerOffset = (layer.kind === "sample" ? layer.envelope?.offset ?? 0 : layer.envelope.offset ?? 0) + layerTimingJitter
      const layerStart = t + layerOffset
      const layerPitchJitter = layer.pitchVariation ? 1 + (this.rng() * 2 - 1) * layer.pitchVariation : 1
      const layerGainJitter = layer.gainVariation ? 1 + (this.rng() * 2 - 1) * layer.gainVariation : 1
      const totalPitch = (options.rate ?? 1) * spatial.doppler * strikePitch * layerPitchJitter
      const totalLayerGain = weight * strikeForce * layerGainJitter

      if (layer.kind === "sample") {
        const scheduled = this.scheduleSampleLayer(
          ctx,
          voiceFilter,
          layer,
          `${cue.id}:layer-${idx}`,
          layerStart,
          totalPitch,
          totalLayerGain,
          cue.loop ?? false,
          options.attackSeconds,
          options.decaySeconds,
        )
        if (scheduled) {
          remainingLayers++
          const cleanup = scheduled.source.onended
          scheduled.source.onended = event => { cleanup?.call(scheduled.source, event); layerEnded() }
          samplesPicked.push(scheduled.sampleId)
          sampleSources.push({ src: scheduled.source, baseRate: scheduled.baseRate })
          maxEndTime = Math.max(maxEndTime, scheduled.endTime)
        }
      } else {
        const effectiveSynthLayer =
          options.attackSeconds !== undefined || options.decaySeconds !== undefined
            ? {
                ...layer,
                envelope: {
                  ...layer.envelope,
                  attack: options.attackSeconds ?? layer.envelope.attack,
                  decay: options.decaySeconds ?? layer.envelope.decay,
                },
              }
            : layer
        remainingLayers++
        const scheduled = scheduleSynthLayer(
          ctx,
          voiceFilter,
          effectiveSynthLayer,
          layerStart,
          totalPitch,
          totalLayerGain,
          strikeForce,
          initialCutoff,
          this.rng() * 2.5,
          layerEnded,
        )
        synthLayers.push(scheduled)
        maxEndTime = Math.max(maxEndTime, scheduled.endTime)
      }
    }

    if (cue.duck && intensity >= 0.65) {
      this.duck(cue.duck.seconds, cue.duck.depth)
    }
    if (cue.daze && intensity >= 0.75) {
      this.daze(cue.daze.seconds, cue.daze.cutoffHz)
    }

    const id = this.nextVoiceId++
    const voice: InternalVoice = {
      id,
      cueId: cue.id,
      ownerKey,
      category: cue.category,
      startTime: t,
      endTime: cue.loop ? Infinity : maxEndTime,
      active: true,
      samplesPicked,
      gainNode: voiceGain,
      panNode: voicePan,
      filterNode: voiceFilter,
      sendNode: voiceSend,
      sampleSources,
      synthLayers,
      stop: (fadeSeconds = 0.025) => {
        if (!voice.active) return
        voice.active = false
        const stopAt = this.now
        const fade = Math.max(0.008, fadeSeconds)
        holdParam(voiceGain.gain, stopAt, 0)
        voiceGain.gain.linearRampToValueAtTime(0, stopAt + fade)
        holdParam(voiceSend.gain, stopAt, 0)
        voiceSend.gain.linearRampToValueAtTime(0, stopAt + fade)
        for (const s of sampleSources) {
          try {
            s.src.stop(stopAt + fade + 0.005)
          } catch {}
        }
        for (const sl of synthLayers) {
          sl.stop(stopAt, fade)
        }
        voice.endTime = stopAt + fade + 0.005
        this.voices.delete(id)
      },
      setParams: (params: VoiceUpdateParams, tau = 0.04) => {
        if (!voice.active) return
        const now = this.now
        if (params.gain !== undefined) smoothParam(voiceGain.gain, Math.max(0, params.gain), now, tau)
        if (params.pan !== undefined) smoothParam(voicePan.pan, clamp(params.pan, -1, 1), now, tau)
        if (params.cutoffHz !== undefined) smoothParam(voiceFilter.frequency, clamp(params.cutoffHz, 80, 20000), now, tau)
        if (params.wet !== undefined) smoothParam(voiceSend.gain, clamp(params.wet, 0, 0.9), now, tau)
        if (params.rate !== undefined) {
          for (const s of sampleSources) {
            smoothParam(s.src.playbackRate, Math.max(0.25, params.rate * s.baseRate), now, tau)
          }
        }
      },
    }

    if (remainingLayers === 0) { remainingLayers = 1; layerEnded(); return null }
    this.voices.set(id, voice)
    return voice
  }

  private layerIntensityWeight(layer: CueLayerSpec, intensity: number): number {
    const lo = layer.minIntensity ?? 0
    const hi = layer.maxIntensity ?? 1
    if (intensity < lo || intensity > hi) return 0
    const span = Math.max(1e-4, hi - lo)
    const norm = clamp((intensity - lo) / span, 0, 1)
    if (layer.intensityCurve === "fade-in") return 0.35 + 0.65 * norm
    if (layer.intensityCurve === "fade-out") return 1 - 0.7 * norm
    if (layer.intensityCurve === "bell") return Math.sin(norm * Math.PI)
    return 1
  }

  private waitingForSamples(cue: CueRecipe): boolean {
    for (const layer of cue.layers) {
      if (layer.kind !== "sample") continue
      for (const s of layer.samples) if (this.sampleBank.isPending(typeof s === "string" ? s : s.id)) return true
    }
    return false
  }

  private scheduleSampleLayer(
    ctx: BaseAudioContext,
    destination: AudioNode,
    layer: SampleLayerSpec,
    poolKey: string,
    startTime: number,
    pitchScale: number,
    gainScale: number,
    cueLoop: boolean,
    attackOverride?: number,
    decayOverride?: number,
  ): { sampleId: string; source: AudioBufferSourceNode; baseRate: number; endTime: number } | null {
    const picked = this.pickSample(layer.samples, layer.selection ?? "round-robin", poolKey)
    const buf = this.sampleBank.getBuffer(ctx, picked.id)
    if (!buf) return null

    const src = ctx.createBufferSource()
    src.buffer = buf
    const isLoop = layer.loop ?? cueLoop
    src.loop = isLoop
    const loopEnd = isLoop ? this.sampleBank.manifest.get(picked.id)?.loopEnd : undefined
    if (loopEnd) {
      src.loopStart = this.sampleBank.manifest.get(picked.id)?.loopStart ?? 0
      src.loopEnd = loopEnd
    }
    const baseRate = (layer.rate ?? 1) * picked.rate
    const playbackRate = clamp(baseRate * pitchScale, 0.25, 4.0)
    src.playbackRate.setValueAtTime(playbackRate, startTime)

    const envGain = ctx.createGain()
    const peak = Math.max(0, (layer.gain ?? 1) * picked.gain * (layer.envelope?.peak ?? 1) * gainScale)
    const attack = Math.max(0.001, attackOverride ?? layer.envelope?.attack ?? 0.002)
    const naturalDuration = buf.duration / playbackRate
    const decay = Math.max(0.02, decayOverride ?? layer.envelope?.decay ?? naturalDuration)

    envGain.gain.setValueAtTime(0, startTime)
    envGain.gain.linearRampToValueAtTime(peak, startTime + attack)

    let endTime = Infinity
    if (!isLoop) {
      const effectiveDur = Math.min(naturalDuration, attack + decay + 0.04)
      endTime = startTime + effectiveDur
      envGain.gain.setTargetAtTime(0, startTime + attack, fallTime(decay))
      envGain.gain.linearRampToValueAtTime(0, endTime)
    }

    let head: AudioNode = src
    const nodes: AudioNode[] = [src, envGain]
    if (layer.filterType || layer.cutoffHz !== undefined) {
      const f = ctx.createBiquadFilter()
      f.type = layer.filterType ?? "lowpass"
      f.frequency.setValueAtTime(clamp(layer.cutoffHz ?? 16000, 80, 20000), startTime)
      if (layer.filterGlideToHz !== undefined) {
        f.frequency.exponentialRampToValueAtTime(clamp(layer.filterGlideToHz, 60, 20000), startTime + decay)
      }
      if (layer.q !== undefined) f.Q.value = layer.q
      head.connect(f)
      head = f
      nodes.push(f)
    }

    head.connect(envGain)
    envGain.connect(destination)

    src.onended = () => {
      for (const n of nodes) {
        try {
          n.disconnect()
        } catch {}
      }
    }

    src.start(startTime)
    if (!isLoop && Number.isFinite(endTime)) {
      src.stop(endTime + 0.005)
    }

    return {
      sampleId: picked.id,
      source: src,
      baseRate,
      endTime,
    }
  }

  stopAllVoices(fadeSeconds = 0.02): void {
    for (const fn of [...this.interruptListeners]) fn(false)
    for (const voice of [...this.voices.values()]) {
      voice.stop(fadeSeconds)
    }
    this.voices.clear()
  }

  suspend(): void {
    this.stopAllVoices(0.02)
    if (typeof AudioContext !== "undefined" && this.ctx instanceof AudioContext) {
      void this.ctx.suspend()
    }
  }

  async resume(): Promise<void> {
    if (this.disposed || !this.ctx) return
    if ("resume" in this.ctx && this.ctx.state === "suspended" && !this.muted) {
      try {
        await this.ctx.resume()
      } catch {}
    }
  }

  reset(): void {
    this.stopAllVoices(0.015)
    this.lastCueTrigger.clear()
    this.duckCurrent = 1
    this.dazeCurrentHz = 20000
    if (this.ctx) {
      const t = this.now
      if (this.duckNode) {
        this.duckNode.gain.cancelScheduledValues(t)
        this.duckNode.gain.setValueAtTime(1, t)
      }
      if (this.dazeNode) {
        this.dazeNode.frequency.cancelScheduledValues(t)
        this.dazeNode.frequency.setValueAtTime(20000, t)
      }
    }
  }

  /** Voices playing or scheduled, without the allocation of `telemetry()`. */
  get activeVoiceCount(): number {
    this.pruneVoices()
    return this.voices.size
  }

  telemetry(): AudioTelemetry {
    this.pruneVoices()
    const categoryVoices: Record<MixCategory, number> = {
      engine: 0,
      tyre: 0,
      impact: 0,
      ambience: 0,
      spell: 0,
      ui: 0,
      weapon: 0,
      foley: 0,
      voice: 0,
    }
    for (const v of this.voices.values()) {
      if (v.active) categoryVoices[v.category]++
    }
    const state: AudioTelemetry["state"] = !this.ctx
      ? "uninitialized"
      : this.isOffline
        ? "offline"
        : (this.ctx.state as "suspended" | "running" | "closed")
    return {
      state,
      muted: this.muted,
      now: this.now,
      activeVoices: this.voices.size,
      maxVoices: this.maxVoices,
      categoryVoices,
      droppedVoices: this.droppedVoices,
      pendingSkips: this.pendingSkips,
      stolenVoices: this.stolenVoices,
      reverbWet: this.reverbWetValue,
      duckGain: this.duckCurrent,
      dazeCutoffHz: this.dazeCurrentHz,
      loadedSamples: this.sampleBank.loadedCount,
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const fn of [...this.interruptListeners]) fn(true)
    this.interruptListeners.clear()
    this.stopAllVoices(0.01)
    if (this.pacerNode) {
      try {
        this.pacerNode.disconnect()
      } catch {}
      this.pacerNode.onaudioprocess = null
      this.pacerNode = null
    }
    this.domEvents.abort()
    this.muteListeners.length = 0
    if (this.ctx && "close" in this.ctx && !this.isOffline) {
      void this.ctx.close().catch(() => {})
    }
    this.ctx = null
  }
}
