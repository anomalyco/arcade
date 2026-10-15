import type { ByteReader, ByteWriter } from "@arcade/kit/net/bytes"
import type { InterestConfig } from "@arcade/kit/net/interest"
import type { InteractionRegistry } from "./interact"
import type { ClientMsg, ServerMsg, SharedSnapshot } from "./net-types"
import type { Command, OutbreakSim, ResolvedSessionTuning, Survivor, SurvivorSlot } from "./sim-types"
import type { ChunkCoord } from "./world"

export interface OutbreakSimStepSurvivorContext<TState = unknown> {
  readonly sim: OutbreakSim
  readonly slot: SurvivorSlot
  readonly command: Command
  readonly dt: number
  readonly resolved: ResolvedSessionTuning
  readonly predict: boolean
  readonly clampClassic: boolean
  readonly viewTime?: number
  readonly state: TState
}

export interface OutbreakSimStepWorldContext<TState = unknown> {
  readonly sim: OutbreakSim
  readonly dt: number
  readonly timeScale: number
  readonly resolved: ResolvedSessionTuning
  readonly state: TState
}

export interface OutbreakNetSectionCollectContext<TState = unknown> {
  readonly sim: OutbreakSim
  readonly tick: number
  readonly isDelta: boolean
  readonly baseSnap?: SharedSnapshot
  readonly viewerCenter?: ChunkCoord
  readonly interest: InterestConfig
  readonly bubbleCx: number
  readonly bubbleCy: number
  readonly state: TState
}

export interface OutbreakNetSectionEncodeContext {
  readonly sim: OutbreakSim
  readonly tick: number
  readonly isDelta: boolean
  readonly baseSnap?: SharedSnapshot
}

export interface OutbreakNetSectionDecodeContext {
  readonly tick: number
  readonly time: number
  readonly isDelta: boolean
  readonly baseSnap?: SharedSnapshot
}

export interface OutbreakNetSectionCodec<TState = unknown, TSection = unknown, TWritePayload = TSection> {
  /** Bit flag in the snapshot `sections` header (e.g. 64 for vehicles, 128 for melee). */
  readonly bit: number
  /** Property key on `SharedSnapshot` where decoded section data is stored. */
  readonly key: keyof SharedSnapshot | string
  /** Collects quantized snapshot state for the bubble and decides whether the section needs to be written on the wire. */
  collect(ctx: OutbreakNetSectionCollectContext<TState>): {
    snapshotValue: TSection | undefined
    shouldWrite: boolean
    writePayload?: TWritePayload
  }
  /** Writes the binary section payload when `shouldWrite` is true. */
  encode(w: ByteWriter, payload: TWritePayload, ctx: OutbreakNetSectionEncodeContext): void
  /** Reads the binary section payload when `sections & bit` is set. */
  decode(r: ByteReader, ctx: OutbreakNetSectionDecodeContext): TSection | undefined
  /** Optional handler when `sections & bit` is 0 (e.g. delta snapshot filtering expiring events). */
  decodeOmitted?(ctx: OutbreakNetSectionDecodeContext): TSection | undefined
  /** Optional fast-skip for `inspectSnapshotBreakdown`. When omitted, `decode` advances the reader. */
  skip?(r: ByteReader, ctx: { isDelta: boolean }): void
}

export interface OutbreakSharedFeature<
  TState = unknown,
  TSection = unknown,
  TTuning extends Record<string, unknown> = Record<string, unknown>,
  TWritePayload = TSection,
> {
  /** Unique feature identifier (e.g. `"vehicles"`, `"melee"`, `"pacing"`, `"progression"`, `"weather"`, `"map"`). */
  readonly id: string
  /** Deterministic execution order (lower runs first; ties break lexicographically by `id`). */
  readonly order?: number
  /** Optional tuning namespace key on `NamespacedSessionTuning` and default tuning values. */
  readonly tuning?: {
    readonly namespace: string
    readonly defaults: TTuning
    readonly legacyNamespaces?: readonly string[]
  }
  /** Allocates pure per-simulation state owned by this feature (never stored at module scope). */
  createState?(sim: OutbreakSim): TState
  /** Deterministically clones per-simulation state when forking a simulation (e.g. headless bot rollouts). */
  cloneState?(state: TState, targetSim: OutbreakSim, sourceSim: OutbreakSim): TState
  /** Registers world interaction handlers (doors, windows, containers, vehicles, workbenches) on `sim.registry`. */
  registerInteractions?(sim: OutbreakSim, registry: InteractionRegistry, state: TState): void
  /** Runs when active streaming chunk windows shift (`syncWorldChunks` / `rebuildSolids` / `rebuildCollision`). */
  onChunkSync?(sim: OutbreakSim, state: TState): void
  /** Runs when door/window/barricade/chunk topology changes. */
  onTopologyChanged?(sim: OutbreakSim, state: TState): void
  /**
   * Optional movement override for `stepSurvivor` (e.g. seated/driving in a vehicle).
   * Returning `true` signals that the feature handled the survivor's movement and action step for this tick.
   */
  stepSurvivorMovement?(ctx: OutbreakSimStepSurvivorContext<TState>): boolean
  /** Pushes a walking/vaulting survivor out of feature-owned dynamic colliders (e.g. vehicles). */
  pushOutSurvivor?(sim: OutbreakSim, survivor: Survivor, radius: number, state: TState): void
  /** Runs authoritative survivor actions during `OutbreakSim.applyActions`. */
  stepSurvivorActions?(
    ctx: OutbreakSimStepSurvivorContext<TState>,
  ): { handled?: boolean; topologyChanged?: boolean } | void
  /** Advances shared world state for this feature once per simulation tick (`OutbreakSim.stepWorld`). */
  stepWorld?(ctx: OutbreakSimStepWorldContext<TState>): { topologyChanged?: boolean } | void
  /** Transforms the survivor perception proxy passed to `ai.stepSurvivors` (e.g. vehicle headlights and engine noise). */
  transformAISurvivor?(
    sim: OutbreakSim,
    slot: SurvivorSlot,
    survivorView: Survivor & { id: string },
    state: TState,
  ): Survivor & { id: string }
  /** Scales or filters incoming crowd damage on a survivor slot (e.g. vehicle seat armor). */
  modifySurvivorDamage?(sim: OutbreakSim, slot: SurvivorSlot, damage: number, state: TState): number
  /** Customizes `refreshPrompt` for a survivor slot; returning `true` skips default door/window/container prompt selection. */
  refreshPrompt?(sim: OutbreakSim, slot: SurvivorSlot, state: TState): boolean
  /** Optional binary snapshot section codec for `shared/net-protocol.ts`. */
  readonly netSection?: OutbreakNetSectionCodec<TState, TSection, TWritePayload>
  /** Optional JSON control message decoders for custom client-to-server messages. */
  readonly clientMessages?: Readonly<Record<string, (raw: Record<string, unknown>) => ClientMsg | null>>
  /** Optional JSON control message decoders for custom server-to-client messages. */
  readonly serverMessages?: Readonly<Record<string, (raw: Record<string, unknown>) => ServerMsg | null>>
}

function compareFeatures(a: { id: string; order?: number }, b: { id: string; order?: number }): number {
  const oa = a.order ?? 100
  const ob = b.order ?? 100
  if (oa !== ob) return oa - ob
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * Deterministic registry for shared Outbreak simulation and wire-protocol features.
 * Keeps all mutable simulation state per simulation so simulations remain pure and forkable.
 */
export class OutbreakSharedFeatureRegistry {
  private readonly byId = new Map<string, OutbreakSharedFeature<any, any, any, any>>()
  private sortedCache: readonly OutbreakSharedFeature<any, any, any, any>[] | null = null

  register<
    TState = unknown,
    TSection = unknown,
    TTuning extends Record<string, unknown> = Record<string, unknown>,
    TWritePayload = TSection,
  >(feature: OutbreakSharedFeature<TState, TSection, TTuning, TWritePayload>): this {
    this.byId.set(feature.id, feature)
    this.sortedCache = null
    return this
  }

  unregister(id: string): boolean {
    const deleted = this.byId.delete(id)
    if (deleted) this.sortedCache = null
    return deleted
  }

  get<TState = unknown>(id: string): OutbreakSharedFeature<TState, any, any, any> | undefined {
    return this.byId.get(id)
  }

  list(): readonly OutbreakSharedFeature<any, any, any, any>[] {
    if (!this.sortedCache) {
      this.sortedCache = [...this.byId.values()].sort(compareFeatures)
    }
    return this.sortedCache
  }

  /** Allocates a fresh per-simulation state map for every registered feature with `createState`. */
  createSimStates(sim: OutbreakSim): Map<string, unknown> {
    const states = new Map<string, unknown>()
    for (const feature of this.list()) {
      if (feature.createState) {
        states.set(feature.id, feature.createState(sim))
      }
    }
    return states
  }

  /** Deterministically clones per-simulation feature states into `targetSim` when forking a simulation. */
  cloneSimStates(sourceStates: ReadonlyMap<string, unknown>, targetSim: OutbreakSim, sourceSim: OutbreakSim): Map<string, unknown> {
    const next = new Map<string, unknown>()
    for (const feature of this.list()) {
      if (!sourceStates.has(feature.id)) continue
      const src = sourceStates.get(feature.id)
      if (feature.cloneState) {
        next.set(feature.id, feature.cloneState(src, targetSim, sourceSim))
      } else if (src && typeof src === "object") {
        next.set(feature.id, structuredClone(src))
      } else {
        next.set(feature.id, src)
      }
    }
    return next
  }

  /** Resolves all registered feature tuning namespaces against their defaults. */
  resolveTuningNamespaces(tuning?: Record<string, unknown>): Record<string, Record<string, unknown>> {
    const resolved: Record<string, Record<string, unknown>> = {}
    const isNamespaced =
      tuning !== undefined &&
      this.list().some(
        (f) =>
          f.tuning &&
          (f.tuning.namespace in tuning || (f.tuning.legacyNamespaces?.some((ns) => ns in tuning) ?? false)),
      )
    for (const feature of this.list()) {
      if (!feature.tuning) continue
      const { namespace, defaults, legacyNamespaces } = feature.tuning
      const out: Record<string, unknown> = { ...defaults }
      if (tuning) {
        const sources = isNamespaced
          ? [
              ...(legacyNamespaces?.map((ns) => tuning[ns] as Record<string, unknown> | undefined) ?? []),
              tuning[namespace] as Record<string, unknown> | undefined,
            ]
          : [tuning]
        for (const src of sources) {
          if (!src || typeof src !== "object") continue
          for (const k of Object.keys(defaults)) {
            const val = src[k]
            if (typeof val === "number" && Number.isFinite(val)) {
              out[k] = val
            } else if (typeof val === "boolean" || typeof val === "string") {
              out[k] = val
            }
          }
        }
      }
      resolved[namespace] = out
    }
    return resolved
  }

  /** Lists all registered binary snapshot section codecs in deterministic bit/order sequence. */
  netSections(): readonly {
    feature: OutbreakSharedFeature<any, any, any, any>
    codec: OutbreakNetSectionCodec<any, any, any>
  }[] {
    const out: {
      feature: OutbreakSharedFeature<any, any, any, any>
      codec: OutbreakNetSectionCodec<any, any, any>
    }[] = []
    for (const feature of this.list()) {
      if (feature.netSection) {
        out.push({ feature, codec: feature.netSection })
      }
    }
    return out
  }

  decodeClientMessage(raw: Record<string, unknown>): ClientMsg | null {
    const t = typeof raw.t === "string" ? raw.t : ""
    if (!t) return null
    for (const feature of this.list()) {
      const decoder = feature.clientMessages?.[t]
      if (decoder) return decoder(raw)
    }
    return null
  }

  decodeServerMessage(raw: Record<string, unknown>): ServerMsg | null {
    const t = typeof raw.t === "string" ? raw.t : ""
    if (!t) return null
    for (const feature of this.list()) {
      const decoder = feature.serverMessages?.[t]
      if (decoder) return decoder(raw)
    }
    return null
  }
}

export const outbreakSharedFeatures = new OutbreakSharedFeatureRegistry()

export function registerOutbreakSharedFeature<
  TState = unknown,
  TSection = unknown,
  TTuning extends Record<string, unknown> = Record<string, unknown>,
  TWritePayload = TSection,
>(
  feature: OutbreakSharedFeature<TState, TSection, TTuning, TWritePayload>,
): OutbreakSharedFeature<TState, TSection, TTuning, TWritePayload> {
  outbreakSharedFeatures.register(feature)
  return feature
}
