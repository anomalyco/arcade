import type { LabControl, LabSettings } from "../lab-panel"
import {
  AdaptiveQualityController,
  describeQualityState,
  loadSavedQualityMode,
  resolveQualityMode,
  saveQualityMode,
  type QualityMode,
  type QualityScaling,
  type QualityState,
  type QualityTiers,
} from "../quality"

type QualityStorage = Pick<Storage, "getItem" | "setItem">

export type GameQualityOptions<P extends QualityScaling> = {
  /** The game's id; the player's choice is saved per game. */
  game: string
  tiers: QualityTiers<P>
  /** `?quality=auto|high|balanced|low` pins a mode for automation (not saved). */
  params?: URLSearchParams
  storage?: QualityStorage | null
  /** Latest GPU frame time in ms (hardware timestamps, or queue wait); 0 or null when unknown. */
  gpuMs?: () => number | null | undefined
  /** Called whenever the tier or resolution scale changes, with the tier now in force. */
  onChange?: (profile: P) => void
}

export const qualityStorageKey = (game: string) => `arcade.quality.${game}.v1`

/**
 * One game's adaptive quality: Auto starts at High (full Retina) and steps resolution, then tier, down with
 * hysteresis when GPU-bound; High / Balanced / Low pin a tier. The mode is a saved setting with a Lab control.
 *
 * Per frame: `frame(now)` once, then `fit(canvas, innerWidth, innerHeight)` before rendering. Read `profile` for
 * the tier's contents (shadows, bloom, expensive passes) or react in `onChange`.
 */
export class GameQuality<P extends QualityScaling> {
  readonly controller: AdaptiveQualityController<P>
  /** The Lab's view of the mode (`settings.quality`), kept in step with `setMode`. */
  readonly settings: { quality: QualityMode }
  private readonly storage: QualityStorage | null
  private readonly key: string
  private readonly gpuMs: () => number | null | undefined
  private readonly onChange?: (profile: P) => void
  private lastFrame = 0
  private readonly pinned: boolean

  constructor(options: GameQualityOptions<P>) {
    this.storage = options.storage === undefined ? safeLocalStorage() : options.storage
    this.key = qualityStorageKey(options.game)
    this.gpuMs = options.gpuMs ?? (() => 0)
    this.onChange = options.onChange
    const pinned = options.params?.get("quality")
    this.pinned = Boolean(pinned)
    const automated = typeof navigator !== "undefined" && navigator.webdriver
    const mode = pinned ? resolveQualityMode(pinned) : (!automated && loadSavedQualityMode(this.storage, this.key)) || "auto"
    this.controller = new AdaptiveQualityController({ mode, profiles: options.tiers })
    this.settings = { quality: mode }
  }

  get mode(): QualityMode {
    return this.controller.getMode()
  }

  get profile(): P {
    return this.controller.getProfile()
  }

  /** Picks a mode (Auto restarts its startup probe) and, unless `persist` is false, saves it as the player's choice. */
  setMode(mode: QualityMode | string, persist = true): void {
    const next = resolveQualityMode(mode)
    const changed = this.controller.setMode(next)
    this.settings.quality = next
    if (persist) saveQualityMode(this.storage, next, this.key)
    this.lastFrame = 0
    if (changed) this.onChange?.(this.profile)
  }

  /** Records the frame interval ending at `now` (rAF time). Call once per rendered frame. */
  frame(now: number): void {
    const last = this.lastFrame
    this.lastFrame = now
    if (last <= 0) return
    if (this.controller.recordFrame(now - last, this.gpuMs() ?? 0, now)) this.onChange?.(this.profile)
  }

  /** Forget the last frame time, so a pause (menu, hidden tab, frozen clock) isn't read as one slow frame. */
  pause(): void {
    this.lastFrame = 0
  }

  /** Device pixels per CSS pixel the current tier and resolution scale draw at. */
  pixelRatio(devicePixelRatio = globalThis.devicePixelRatio ?? 1): number {
    return this.controller.effectivePixelRatio(devicePixelRatio)
  }

  /** Sizes `canvas` for the current tier (`floor(css × ratio)`); true when it changed. */
  fit(canvas: { width: number; height: number }, cssWidth: number, cssHeight: number, devicePixelRatio = globalThis.devicePixelRatio ?? 1): boolean {
    const ratio = this.pixelRatio(devicePixelRatio)
    const width = Math.max(1, Math.floor(cssWidth * ratio))
    const height = Math.max(1, Math.floor(cssHeight * ratio))
    if (canvas.width === width && canvas.height === height) return false
    canvas.width = width
    canvas.height = height
    return true
  }

  state(devicePixelRatio = globalThis.devicePixelRatio ?? 1): QualityState<P> {
    return this.controller.state(devicePixelRatio)
  }

  /** A one-line readout for Lab telemetry: `Quality Auto → High · 2.00× · GPU 6.1 ms`. */
  describe(devicePixelRatio = globalThis.devicePixelRatio ?? 1): string {
    return describeQualityState(this.state(devicePixelRatio))
  }

  /** The Lab row (key `quality`); bind it to `settings` (or use `addTo`). */
  labControl(group = "View"): LabControl {
    const t = this.controller.profiles
    return {
      key: "quality",
      label: "Quality",
      group,
      options: [
        { value: "auto", label: "Auto (adaptive)" },
        { value: "high", label: t.high.label },
        { value: "balanced", label: t.balanced.label },
        { value: "low", label: t.low.label },
      ],
      change: (value) => this.setMode(String(value)),
    }
  }

  /** Adds the Quality row to a Lab panel; Reset returns to Auto. */
  addTo(panel: { addControls(settings: LabSettings, controls: readonly LabControl[], defaults?: Readonly<LabSettings>): void }, group = "View"): this {
    panel.addControls(this.settings, [this.labControl(group)], { quality: "auto" })
    return this
  }

  /** `globalThis.__quality` for automation: `state()`, the latest raw `gpuMs()` and `setMode(mode)` (not saved). */
  expose(): this {
    Object.assign(globalThis, {
      __quality: {
        state: () => this.state(),
        gpuMs: () => this.gpuMs() ?? 0,
        setMode: (mode: QualityMode) => this.setMode(mode, false),
      },
    })
    return this
  }

  /** Whether GPU timing should run: Auto needs it, and a `?quality=` pin is automation that reports it. */
  get wantsGpuTiming(): boolean {
    return this.mode === "auto" || this.pinned
  }
}

function safeLocalStorage(): QualityStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage
  } catch {
    return null
  }
}
