import type { Camera } from "@arcade/kit/client/camera"
import type { LabControl } from "@arcade/kit/lab-panel"
import type { LabCommand } from "@arcade/kit/lab/commands"
import type { PersonalSnapshot, SharedSnapshot } from "../shared/net-protocol"
import type { LocalSession } from "../shared/session"
import type { OutbreakCombatFX } from "./combat-fx"
import type { OutbreakFeelTracker } from "./feel-events"
import type { OutbreakGameCommandsHost } from "./game-commands"
import type { OutbreakHarness, OutbreakHarnessHost } from "./harness"
import type { OutbreakLabControlHost } from "./lab-controls"
import type { NetSession } from "./net-session"
import type { OutbreakSettings, OutbreakSubsystemKey } from "./settings"
import type { ZombieCrowdRenderer } from "./zombies"

export interface OutbreakFeelFrameContext {
  readonly tracker: OutbreakFeelTracker
  readonly session: LocalSession | NetSession
  readonly combatFx: OutbreakCombatFX
  readonly zombieCrowd: ZombieCrowdRenderer
  readonly addSprites: Float32Array
  readonly addCount: number
  readonly playerGroundY: number
  readonly dt: number
  readonly settings: OutbreakSettings
  readonly cam: Camera
}

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
  onSyncFrame?(net: NetSession, a: SharedSnapshot, b: SharedSnapshot, t: number, span: number): void
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
}

function compareFeatures(a: { id: string; order?: number }, b: { id: string; order?: number }): number {
  const oa = a.order ?? 100
  const ob = b.order ?? 100
  if (oa !== ob) return oa - ob
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * Deterministic client-side registry for Outbreak features.
 * Allows each feature folder (`src/map/`, `src/weather/`, `src/pacing/`, `src/progression/`, `src/vehicles/`, `src/melee/`)
 * to register its Lab controls, settings handler, dev-control commands, harness stage methods, feel events, and `NetSession` hooks
 * without colliding in central files.
 */
export class OutbreakClientFeatureRegistry {
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

  syncNetFrame(net: NetSession, a: SharedSnapshot, b: SharedSnapshot, t: number, span: number): void {
    for (const feature of this.list()) {
      feature.netSession?.onSyncFrame?.(net, a, b, t, span)
    }
  }
}

export const outbreakClientFeatures = new OutbreakClientFeatureRegistry()

export function registerOutbreakClientFeature(feature: OutbreakClientFeature): OutbreakClientFeature {
  outbreakClientFeatures.register(feature)
  return feature
}
