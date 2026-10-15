import type { LabControl } from "./lab-panel"

export type QualityTier = "low" | "balanced" | "high"
export type QualityMode = "auto" | QualityTier

export const QUALITY_TIERS: readonly QualityTier[] = ["low", "balanced", "high"] as const
export const QUALITY_MODES: readonly QualityMode[] = ["auto", "high", "balanced", "low"] as const

export interface QualityProfile {
  readonly tier: QualityTier
  readonly label: string
  /** Maximum devicePixelRatio before dynamic resolution scaling. */
  readonly dprCap: number
  /** Minimum dynamic resolution scale multiplier in `auto` mode. */
  readonly minScale: number
  /** Active bloom mip chain depth (1..5). */
  readonly bloomLevels: number
  /** Multiplier for weather particle count (0.25..1). */
  readonly weatherParticleScale: number
  /** Maximum dynamic non-shadowed practical lights per frame. */
  readonly maxUnshadowedLamps: number
  /** Maximum interior wall-sconce lights per frame (each a pair of fixtures: small unshadowed pools in the house the camera is inside). */
  readonly maxSconceLights: number
  /** Whether ambient ground dust/leaf motion particles update and draw. */
  readonly ambientMotion: boolean
  /** Multiplier for secondary exterior clutter density (0..1). */
  readonly clutterScale: number
}

export const QUALITY_PROFILES: Readonly<Record<QualityTier, QualityProfile>> = {
  high: {
    tier: "high",
    label: "High (Retina 2.0×)",
    dprCap: 2.0,
    minScale: 0.7,
    bloomLevels: 5,
    weatherParticleScale: 1.0,
    maxUnshadowedLamps: 16,
    maxSconceLights: 3,
    ambientMotion: true,
    clutterScale: 1.0,
  },
  balanced: {
    tier: "balanced",
    label: "Balanced (1.5×)",
    dprCap: 1.5,
    minScale: 0.6,
    bloomLevels: 5,
    weatherParticleScale: 0.75,
    maxUnshadowedLamps: 12,
    maxSconceLights: 2,
    ambientMotion: true,
    clutterScale: 1.0,
  },
  low: {
    tier: "low",
    label: "Low (1.0×)",
    dprCap: 1.0,
    minScale: 0.5,
    bloomLevels: 3,
    weatherParticleScale: 0.4,
    maxUnshadowedLamps: 6,
    maxSconceLights: 0,
    ambientMotion: false,
    clutterScale: 0.5,
  },
}

export interface QualitySettings {
  quality: QualityMode
}

export const DEFAULT_QUALITY_SETTINGS: QualitySettings = {
  quality: "auto",
}

export const qualityControls: LabControl[] = [
  {
    key: "quality",
    label: "Quality tier",
    group: "View",
    options: [
      { label: "Auto (adaptive)", value: "auto" },
      { label: "High (Retina 2.0×)", value: "high" },
      { label: "Balanced (1.5×)", value: "balanced" },
      { label: "Low (1.0×)", value: "low" },
    ],
  },
]

export function resolveQualityMode(value: unknown): QualityMode {
  if (value === "auto" || value === "high" || value === "balanced" || value === "low") {
    return value
  }
  if (typeof value === "string") {
    const norm = value.trim().toLowerCase()
    if (norm === "auto" || norm === "high" || norm === "balanced" || norm === "low") {
      return norm
    }
    if (norm === "2" || norm === "2.0" || norm === "2x") return "high"
    if (norm === "1.5" || norm === "1.5x") return "balanced"
    if (norm === "1" || norm === "1.0" || norm === "1x") return "low"
  }
  if (typeof value === "number") {
    if (value === 1) return "high"
    if (value === 2) return "balanced"
    if (value === 3) return "low"
  }
  return "auto"
}

export const QUALITY_STORAGE_KEY = "arcade.quality.v1"

export function loadSavedQualityMode(
  storage?: Pick<Storage, "getItem"> | null,
  key = QUALITY_STORAGE_KEY,
): QualityMode | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(key)
    if (!raw) return null
    if (raw === "auto" || raw === "high" || raw === "balanced" || raw === "low") return raw
  } catch {}
  return null
}

export function saveQualityMode(
  storage: Pick<Storage, "setItem"> | null | undefined,
  mode: QualityMode,
  key = QUALITY_STORAGE_KEY,
): void {
  if (!storage) return
  try {
    storage.setItem(key, mode)
  } catch {}
}

export interface QualityState {
  mode: QualityMode
  activeTier: QualityTier
  profile: QualityProfile
  /** Dynamic resolution multiplier (0.5..1.0) applied on top of `min(devicePixelRatio, profile.dprCap)`. */
  resolutionScale: number
  /** Effective pixel ratio (`roundTo05(min(devicePixelRatio, profile.dprCap) * resolutionScale)`). */
  pixelRatio: number
  /** Rolling median frame interval (ms) from the most recent window. */
  frameMs: number
  /** Rolling median GPU completion time (ms) from the most recent window. */
  gpuMs: number
  /** Number of startup or runtime adaptation transitions that have occurred. */
  adaptations: number
  /** True once the startup auto-select probe has completed (or immediately for manual tiers). */
  startupResolved: boolean
}

export interface AdaptiveQualityOptions {
  mode?: QualityMode
  targetFps?: number
  /** Initial warmup frames skipped before startup auto-select (default: 15). */
  warmupFrames?: number
  /** Startup sample count before locking initial auto tier (default: 24). */
  startupSamples?: number
  /** Runtime evaluation window in ms (default: 1000). */
  adaptWindowMs?: number
  /** Minimum frame samples in a runtime window (default: 10). */
  minWindowSamples?: number
  /** Consecutive comfortable windows required before stepping resolution/tier up (default: 3). */
  recoverWindows?: number
}

function medianOf(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[sorted.length >> 1]!
}

function roundPixelRatio(pr: number): number {
  return Math.max(0.5, Math.round(pr * 20) / 20)
}

/**
 * Picks the initial quality tier from startup frame/GPU medians once shaders and textures have warmed up.
 * Keeps `high` (full Retina 2.0×) whenever GPU/frame time fits inside the 60 fps budget.
 */
export function selectStartupTier(frameMedianMs: number, gpuMedianMs: number, budgetMs = 1000 / 60): QualityTier {
  if (gpuMedianMs > 0) {
    if (gpuMedianMs > budgetMs * 1.35) return "low"
    if (gpuMedianMs > budgetMs * 0.92) return "balanced"
    return "high"
  }
  if (frameMedianMs > budgetMs * 1.65) return "low"
  if (frameMedianMs > budgetMs * 1.25) return "balanced"
  return "high"
}

/**
 * Adaptive quality controller (ported from Wings and generalized for `@arcade/kit`):
 * - Tiers: `low`, `balanced`, `high`, `auto` (default `auto`).
 * - Startup auto-select: skips initial shader/pipeline warm-up frames, then picks `high` / `balanced` / `low`
 *   from the median GPU / frame time so Retina laptops keep full 2.0× when it fits and step down cleanly when it doesn't.
 * - Runtime hysteresis: evaluates 1 s rolling medians, drops `resolutionScale` (and then `activeTier` in `auto` mode)
 *   quickly when GPU-bound frames exceed budget, and requires `recoverWindows` consecutive comfortable windows before
 *   stepping back up by +0.05 so resolution never oscillates.
 * - Manual override (`high` / `balanced` / `low`): locks `activeTier` and `resolutionScale = 1` for deterministic rendering.
 */
export class AdaptiveQualityController {
  private mode: QualityMode
  private activeTier: QualityTier
  private resolutionScale = 1.0
  private readonly targetFps: number
  private readonly warmupFrames: number
  private readonly startupSamples: number
  private readonly adaptWindowMs: number
  private readonly minWindowSamples: number
  private readonly recoverWindows: number

  private seenFrames = 0
  private startupResolved = false
  private okWindows = 0
  private adaptations = 0
  private lastAdaptAt = 0
  private lastFrameMs = 0
  private lastGpuMs = 0

  private readonly startupFrameBuf: number[] = []
  private readonly startupGpuBuf: number[] = []
  private readonly windowFrames: number[] = []
  private readonly windowGpus: number[] = []

  constructor(options: AdaptiveQualityOptions = {}) {
    this.mode = options.mode ?? "auto"
    this.activeTier = this.mode === "auto" ? "high" : this.mode
    this.startupResolved = this.mode !== "auto"
    this.targetFps = options.targetFps ?? 60
    this.warmupFrames = options.warmupFrames ?? 15
    this.startupSamples = options.startupSamples ?? 24
    this.adaptWindowMs = options.adaptWindowMs ?? 1000
    this.minWindowSamples = options.minWindowSamples ?? 10
    this.recoverWindows = options.recoverWindows ?? 3
  }

  getMode(): QualityMode {
    return this.mode
  }

  getActiveTier(): QualityTier {
    return this.activeTier
  }

  getProfile(): QualityProfile {
    return QUALITY_PROFILES[this.activeTier]
  }

  getResolutionScale(): number {
    return this.resolutionScale
  }

  setMode(nextMode: QualityMode): boolean {
    const resolved = resolveQualityMode(nextMode)
    const prevTier = this.activeTier
    const prevScale = this.resolutionScale
    this.mode = resolved
    this.okWindows = 0
    this.windowFrames.length = 0
    this.windowGpus.length = 0
    if (resolved === "auto") {
      this.activeTier = "high"
      this.resolutionScale = 1.0
      this.seenFrames = 0
      this.startupResolved = false
      this.startupFrameBuf.length = 0
      this.startupGpuBuf.length = 0
    } else {
      this.activeTier = resolved
      this.resolutionScale = 1.0
      this.startupResolved = true
    }
    return this.activeTier !== prevTier || Math.abs(this.resolutionScale - prevScale) > 1e-4
  }

  reset(): void {
    this.setMode(this.mode)
    this.adaptations = 0
    this.lastAdaptAt = 0
    this.lastFrameMs = 0
    this.lastGpuMs = 0
  }

  effectivePixelRatio(devicePixelRatio = 1): number {
    const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1
    const base = Math.min(dpr, QUALITY_PROFILES[this.activeTier].dprCap)
    if (this.mode !== "auto") return base
    return roundPixelRatio(base * this.resolutionScale)
  }

  canvasDimensions(
    cssWidth: number,
    cssHeight: number,
    devicePixelRatio = 1,
  ): { width: number; height: number; pixelRatio: number } {
    const pixelRatio = this.effectivePixelRatio(devicePixelRatio)
    return {
      width: Math.max(1, Math.round(cssWidth * pixelRatio)),
      height: Math.max(1, Math.round(cssHeight * pixelRatio)),
      pixelRatio,
    }
  }

  /**
   * Records one rendered frame's wall interval and (optional) GPU completion latency.
   * Returns `true` when the active quality tier or dynamic resolution scale changed.
   */
  recordFrame(frameMs: number, gpuMs = 0, nowMs = performance.now()): boolean {
    if (!Number.isFinite(frameMs) || frameMs <= 0 || frameMs >= 200) {
      return false
    }
    const validGpu = Number.isFinite(gpuMs) && gpuMs > 0 && gpuMs < 200 ? gpuMs : 0
    this.lastFrameMs = this.lastFrameMs > 0 ? this.lastFrameMs + (frameMs - this.lastFrameMs) * 0.15 : frameMs
    if (validGpu > 0) {
      this.lastGpuMs = this.lastGpuMs > 0 ? this.lastGpuMs + (validGpu - this.lastGpuMs) * 0.2 : validGpu
    }

    if (this.mode !== "auto") {
      return false
    }

    this.seenFrames++
    if (this.seenFrames <= this.warmupFrames) {
      this.lastAdaptAt = nowMs
      return false
    }

    const budget = 1000 / this.targetFps

    if (!this.startupResolved) {
      this.startupFrameBuf.push(frameMs)
      if (validGpu > 0) this.startupGpuBuf.push(validGpu)
      if (this.startupFrameBuf.length < this.startupSamples) {
        return false
      }
      this.startupResolved = true
      this.lastAdaptAt = nowMs
      const medFrame = medianOf(this.startupFrameBuf)
      const medGpu = this.startupGpuBuf.length >= 4 ? medianOf(this.startupGpuBuf) : 0
      this.lastFrameMs = medFrame
      if (medGpu > 0) this.lastGpuMs = medGpu
      this.startupFrameBuf.length = 0
      this.startupGpuBuf.length = 0
      const chosen = selectStartupTier(medFrame, medGpu, budget)
      if (chosen !== this.activeTier) {
        this.activeTier = chosen
        this.resolutionScale = 1.0
        this.adaptations++
        return true
      }
      return false
    }

    this.windowFrames.push(frameMs)
    if (validGpu > 0) this.windowGpus.push(validGpu)
    if (this.lastAdaptAt === 0) {
      this.lastAdaptAt = nowMs
      return false
    }
    if (nowMs - this.lastAdaptAt < this.adaptWindowMs) {
      return false
    }
    this.lastAdaptAt = nowMs
    if (this.windowFrames.length < this.minWindowSamples) {
      this.windowFrames.length = 0
      this.windowGpus.length = 0
      return false
    }

    const medFrame = medianOf(this.windowFrames)
    const medGpu = this.windowGpus.length >= 4 ? medianOf(this.windowGpus) : 0
    this.windowFrames.length = 0
    this.windowGpus.length = 0
    this.lastFrameMs = medFrame
    if (medGpu > 0) this.lastGpuMs = medGpu

    const profile = QUALITY_PROFILES[this.activeTier]
    const minScale = profile.minScale
    // Only shed pixels when GPU is plausibly the bottleneck (or when GPU telemetry is unavailable).
    const gpuBound = medGpu === 0 || medGpu > budget * 0.85
    const overloaded = (medFrame > budget * 1.25 && gpuBound) || medGpu > budget * 1.15
    const severelyOverloaded = (medFrame > budget * 1.65 && gpuBound) || medGpu > budget * 1.45

    if (overloaded) {
      this.okWindows = 0
      if (this.resolutionScale > minScale + 1e-3) {
        const drop = severelyOverloaded ? 0.2 : 0.1
        this.resolutionScale = Math.max(minScale, Math.round((this.resolutionScale - drop) * 20) / 20)
        this.adaptations++
        return true
      }
      if (this.activeTier !== "low") {
        this.activeTier = this.activeTier === "high" ? "balanced" : "low"
        this.resolutionScale = 1.0
        this.adaptations++
        return true
      }
      return false
    }

    const comfortable = medFrame < budget * 1.06 && (medGpu === 0 || medGpu < budget * 0.55)
    if (comfortable && (this.resolutionScale < 1 - 1e-3 || this.activeTier !== "high")) {
      if (++this.okWindows >= this.recoverWindows) {
        this.okWindows = 0
        if (this.resolutionScale < 1 - 1e-3) {
          this.resolutionScale = Math.min(1.0, Math.round((this.resolutionScale + 0.05) * 20) / 20)
          this.adaptations++
          return true
        }
        if (this.activeTier !== "high" && (medGpu === 0 || medGpu < budget * 0.38)) {
          this.activeTier = this.activeTier === "low" ? "balanced" : "high"
          this.resolutionScale = 0.85
          this.adaptations++
          return true
        }
      }
    } else {
      this.okWindows = 0
    }

    return false
  }

  state(devicePixelRatio = 1): QualityState {
    const profile = QUALITY_PROFILES[this.activeTier]
    return {
      mode: this.mode,
      activeTier: this.activeTier,
      profile,
      resolutionScale: this.resolutionScale,
      pixelRatio: this.effectivePixelRatio(devicePixelRatio),
      frameMs: Math.round(this.lastFrameMs * 100) / 100,
      gpuMs: Math.round(this.lastGpuMs * 100) / 100,
      adaptations: this.adaptations,
      startupResolved: this.startupResolved,
    }
  }
}
