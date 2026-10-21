import type { Camera } from "@arcade/kit/client/camera"
import type { Batch, FrameInput, Renderer } from "@arcade/kit/gpu/renderer"
import type { LabControl } from "@arcade/kit/lab-panel"
import type { LabCommand } from "@arcade/kit/lab/commands"
import type { CoopSim, SurvivorSlot } from "../shared/coop-sim"
import type { PersonalSnapshot, SharedSnapshot } from "../shared/net-protocol"
import type { LocalSession } from "../shared/session"
import type { Vision } from "../shared/vision"
import type { CoopView } from "./coop-view"
import type { OutbreakFeelFeatures, OutbreakFeelFrameContext, OutbreakFeelTracker } from "./feel-events"
import type { OutbreakCommandFeatures, OutbreakGameCommandsHost } from "./game-commands"
import type { OutbreakHarness, OutbreakHarnessFeatures, OutbreakHarnessHost } from "./harness"
import type { OutbreakLabControlHost, OutbreakLabFeatures } from "./lab-controls"
import type { NetSession, NetSessionFeatures } from "./net-session"
import type { OutbreakSettings, OutbreakSubsystemKey } from "./settings"

export interface OutbreakClientFeatureFeelHooks {
  /** Resets any presentation-only edge/dedup state owned by this feature when the player or session resets. */
  reset?(tracker: OutbreakFeelTracker, player: { health: number; shoveAnim: number; vault: unknown }): void
  /**
   * Processes one rendered frame of presentation feel events (camera trauma/kick, hit-stop, motion burst, blood FX)
   * and returns the updated `addCount` of temporary sprites written into `ctx.addSprites`.
   */
  processFrame?(ctx: OutbreakFeelFrameContext): number
}

export interface OutbreakClientFeatureNetHooks {
  /** Applies discrete world state from a newly received co-op snapshot; returns `true` if nav/solid topology changed. */
  onApplyWorld?(net: NetSession, shared: SharedSnapshot): boolean | void
  /** Reconciles local predicted survivor state against `personal` and `shared` before input replay. */
  onReconcileLocal?(net: NetSession, personal: PersonalSnapshot, shared: SharedSnapshot): void
  /** Interpolates remote feature entities between snapshots `a` and `b` at render factor `t` (60 Hz frame sync). */
  onSyncFrame?(net: NetSession, a: SharedSnapshot, b: SharedSnapshot, t: number, span: number, over?: number, dt?: number): void
}

/** One rendered frame, as the frame renderer hands it to features (`frame` hooks). */
export interface OutbreakClientFrameContext {
  readonly session: LocalSession | NetSession
  readonly coop: CoopView
  readonly cam: Camera
  readonly renderer: Renderer
  readonly settings: OutbreakSettings
  readonly vision: Vision
  /** Seconds since the last frame (hit-stop applied for `batches`). */
  readonly dt: number
  /** CSS pixel size of the view. */
  readonly w: number
  readonly h: number
}

/** Where the camera, sight shroud and listener sit instead of the local survivor (e.g. watching a teammate). */
export type OutbreakClientViewpoint = {
  x: number
  y: number
  aim: number
  health: number
  maxHealth: number
  /** Sight looks every way from here (a watched scene) instead of along `aim`. */
  allAround?: boolean
}

export interface OutbreakClientFeatureFrameHooks {
  /** The viewpoint for this frame, or null to look from the local survivor as usual. */
  viewpoint?(session: LocalSession | NetSession, coop: CoopView): OutbreakClientViewpoint | null
  /** Whether a survivor's standing body is left undrawn this frame (the feature draws them itself). */
  hidesSurvivor?(sim: CoopSim, slot: SurvivorSlot): boolean
  /** Extra instanced batches for the scene. */
  batches?(ctx: OutbreakClientFrameContext): readonly Batch[]
  /** Extra point lights packed after the night, fire and detail lights (`LIGHT_FLOATS` each); returns the new count. */
  lights?(ctx: OutbreakClientFrameContext, lights: Float32Array, count: number, max: number): number
  /** Last word on the renderer's input just before the frame is drawn (e.g. bounced light's grid). */
  render?(ctx: OutbreakClientFrameContext, input: FrameInput): void
  /** Screen overlay, after the frame is drawn and the camera has settled. */
  overlay?(ctx: OutbreakClientFrameContext): void
}

/**
 * What a feature gets when the game makes the next session (`main.ts` `makeSession`). A feature may return a local
 * session even in a co-op room (the lobby's practice space); otherwise the room's session or the normal offline one.
 */
export interface OutbreakClientSessionContext {
  readonly seed: number
  readonly settings: OutbreakSettings
  /** The lobby and the co-op room, if any (`coop.net` is null while the lobby is over the practice space). */
  readonly coop: CoopView
  /** Builds the normal offline session for `seed`, with the solo starting kit. */
  make(seed: number): LocalSession
  /** Ends the current session and makes the next one (`main.ts` `reset`). */
  restart(): void
}

export interface OutbreakClientFeature {
  /** Unique feature identifier (e.g. `"map"`, `"weather"`, `"pacing"`, `"progression"`, `"vehicles"`, `"melee"`). */
  readonly id: string
  /** Deterministic execution order (lower runs first; ties break lexicographically by `id`). */
  readonly order?: number
  /** Optional settings group metadata for `OutbreakSettings` and preset migration. */
  readonly settingsGroup?: {
    readonly subsystem: OutbreakSubsystemKey
    readonly defaults: Readonly<Record<string, unknown>>
    readonly legacyKeyAliases?: Readonly<Record<string, string>>
  }
  /** Builds the feature's `LabControl[]` slice for the shared `LabPanel` (Backquote). */
  labControls?(host: OutbreakLabControlHost): readonly LabControl[]
  /** Handles live Lab control edits for this feature's subsystem or keys; returns `true` if handled. */
  onSettingChanged?(
    host: OutbreakLabControlHost,
    rawKey: string,
    routed: { subsystem: OutbreakSubsystemKey; field: string } | null,
    value?: number | boolean | string,
  ): boolean | void
  /** Builds the feature's dev-control `LabCommand[]` (`arcade cmd ...`). */
  gameCommands?(host: OutbreakGameCommandsHost): readonly LabCommand[]
  /** Contributes stage/action methods or sub-inspectors onto the `window.__arcadeHarness` object. */
  harnessMethods?(
    host: OutbreakHarnessHost,
    harness: OutbreakHarness,
  ): Readonly<Record<string, unknown>>
  /** Contributes a read-only telemetry slice into `harness.state()`. */
  harnessState?(host: OutbreakHarnessHost): Readonly<Record<string, unknown>>
  /** Presentation feel event hooks (`OutbreakFeelTracker`). */
  readonly feel?: OutbreakClientFeatureFeelHooks
  /** Co-op client snapshot reconciliation and interpolation hooks (`NetSession`). */
  readonly netSession?: OutbreakClientFeatureNetHooks
  /** Per-frame presentation hooks (`scene/frame-renderer.ts`): viewpoint, hidden bodies, batches and overlay. */
  readonly frame?: OutbreakClientFeatureFrameHooks
  /** Makes the next session instead of the normal one (the lobby's practice space, the training room), or null. */
  session?(ctx: OutbreakClientSessionContext): LocalSession | null
}

function compareFeatures(a: { id: string; order?: number }, b: { id: string; order?: number }): number {
  const oa = a.order ?? 100
  const ob = b.order ?? 100
  if (oa !== ob) return oa - ob
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * Deterministic client-side registry for Outbreak features.
 * Each feature folder (`src/<feature>/index.ts`, listed in `src/features.ts`) registers its Lab controls, settings
 * handler, dev-control commands, harness stage methods, feel events and `NetSession` hooks here. The central modules
 * never import the registry: `main.ts` hands it to them through the small hook interfaces it implements.
 */
export class OutbreakClientFeatureRegistry
  implements
    OutbreakLabFeatures,
    OutbreakCommandFeatures,
    OutbreakHarnessFeatures,
    OutbreakFeelFeatures,
    NetSessionFeatures
{
  private readonly byId = new Map<string, OutbreakClientFeature>()
  private sortedCache: readonly OutbreakClientFeature[] | null = null

  register(feature: OutbreakClientFeature): this {
    this.byId.set(feature.id, feature)
    this.sortedCache = null
    return this
  }

  unregister(id: string): boolean {
    const deleted = this.byId.delete(id)
    if (deleted) this.sortedCache = null
    return deleted
  }

  get(id: string): OutbreakClientFeature | undefined {
    return this.byId.get(id)
  }

  list(): readonly OutbreakClientFeature[] {
    if (!this.sortedCache) {
      this.sortedCache = [...this.byId.values()].sort(compareFeatures)
    }
    return this.sortedCache
  }

  collectLabControls(host: OutbreakLabControlHost): LabControl[] {
    const out: LabControl[] = []
    for (const feature of this.list()) {
      if (feature.labControls) {
        out.push(...feature.labControls(host))
      }
    }
    return out
  }

  notifySettingChanged(
    host: OutbreakLabControlHost,
    rawKey: string,
    routed: { subsystem: OutbreakSubsystemKey; field: string } | null,
    value?: number | boolean | string,
  ): boolean {
    let handled = false
    for (const feature of this.list()) {
      if (feature.onSettingChanged?.(host, rawKey, routed, value)) {
        handled = true
      }
    }
    return handled
  }

  collectGameCommands(host: OutbreakGameCommandsHost): LabCommand[] {
    const out: LabCommand[] = []
    for (const feature of this.list()) {
      if (feature.gameCommands) {
        out.push(...feature.gameCommands(host))
      }
    }
    return out
  }

  collectHarnessMethods(host: OutbreakHarnessHost, harness: OutbreakHarness): Record<string, any> {
    const out: Record<string, any> = {}
    for (const feature of this.list()) {
      if (feature.harnessMethods) {
        Object.assign(out, feature.harnessMethods(host, harness))
      }
    }
    return out
  }

  collectHarnessState(host: OutbreakHarnessHost): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const feature of this.list()) {
      if (feature.harnessState) {
        Object.assign(out, feature.harnessState(host))
      }
    }
    return out
  }

  resetFeel(tracker: OutbreakFeelTracker, player: { health: number; shoveAnim: number; vault: unknown }): void {
    for (const feature of this.list()) {
      feature.feel?.reset?.(tracker, player)
    }
  }

  processFeelFrame(ctx: OutbreakFeelFrameContext): number {
    let addCount = ctx.addCount
    for (const feature of this.list()) {
      if (feature.feel?.processFrame) {
        addCount = feature.feel.processFrame({ ...ctx, addCount })
      }
    }
    return addCount
  }

  /** The first feature viewpoint for this frame, or null. */
  viewpoint(session: LocalSession | NetSession, coop: CoopView): OutbreakClientViewpoint | null {
    for (const feature of this.list()) {
      const v = feature.frame?.viewpoint?.(session, coop)
      if (v) return v
    }
    return null
  }

  /** The first feature's offline session for `ctx`, or null for the normal one. */
  startSession(ctx: OutbreakClientSessionContext): LocalSession | null {
    for (const feature of this.list()) {
      const s = feature.session?.(ctx)
      if (s) return s
    }
    return null
  }

  hidesSurvivor(sim: CoopSim, slot: SurvivorSlot): boolean {
    for (const feature of this.list()) if (feature.frame?.hidesSurvivor?.(sim, slot)) return true
    return false
  }

  frameBatches(ctx: OutbreakClientFrameContext, out: Batch[]): void {
    for (const feature of this.list()) {
      const batches = feature.frame?.batches?.(ctx)
      if (batches) for (let i = 0; i < batches.length; i++) out.push(batches[i]!)
    }
  }

  frameLights(ctx: OutbreakClientFrameContext, lights: Float32Array, count: number, max: number): number {
    for (const feature of this.list()) if (feature.frame?.lights) count = feature.frame.lights(ctx, lights, count, max)
    return count
  }

  frameRender(ctx: OutbreakClientFrameContext, input: FrameInput): void {
    for (const feature of this.list()) feature.frame?.render?.(ctx, input)
  }

  frameOverlay(ctx: OutbreakClientFrameContext): void {
    for (const feature of this.list()) feature.frame?.overlay?.(ctx)
  }

  applyNetWorld(net: NetSession, shared: SharedSnapshot): boolean {
    let topologyChanged = false
    for (const feature of this.list()) {
      if (feature.netSession?.onApplyWorld?.(net, shared)) {
        topologyChanged = true
      }
    }
    return topologyChanged
  }

  reconcileNetLocal(net: NetSession, personal: PersonalSnapshot, shared: SharedSnapshot): void {
    for (const feature of this.list()) {
      feature.netSession?.onReconcileLocal?.(net, personal, shared)
    }
  }

  syncNetFrame(net: NetSession, a: SharedSnapshot, b: SharedSnapshot, t: number, span: number, over = 0, dt = 0): void {
    for (const feature of this.list()) {
      feature.netSession?.onSyncFrame?.(net, a, b, t, span, over, dt)
    }
  }
}

export const outbreakClientFeatures = new OutbreakClientFeatureRegistry()

export function registerOutbreakClientFeature(feature: OutbreakClientFeature): OutbreakClientFeature {
  outbreakClientFeatures.register(feature)
  return feature
}
