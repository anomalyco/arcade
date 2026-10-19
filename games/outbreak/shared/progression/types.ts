import type { ItemId, Ledger, LedgerEnv, LedgerEvent, LedgerSnapshot, Stack } from "@arcade/kit/sim/ledger"
import type { OutbreakAISubsystem } from "../ai"
import type { MeleeWeaponId } from "../combat"
import type { InteractActorState } from "../interact"
import type { Town } from "../map"
import type { ChannelView, Notice, NoticeKind, PickMode } from "../types"
import type { BenchSite } from "./loot"
import type { ProgressionTuning } from "./tuning"

export type { ChannelView, Notice, NoticeKind, PickMode, PistolAmmo } from "../types"

export type Ping = { id: number; by: number; x: number; y: number; label: string; until: number }
export type Lure = { id: number; x: number; y: number; until: number; next: number }

/** What a survivor's command may ask of progression, beyond movement and interaction. */
export type ProgressionCommand = {
  fire?: boolean
  reload?: boolean
  barricade?: boolean
  drop?: boolean
  bundle?: boolean
  ping?: boolean
  /** A digit while a strip is open: take from the target, run a bench row, craft, or swap a pack slot in. */
  pick?: { mode: PickMode; index: number }
}

/** The survivor fields progression reads and writes (a projection: the ledger is the source of truth). */
export type ProgressionActor = InteractActorState & {
  health: number
  maxHealth: number
  sprinting: boolean
  crouching?: boolean
  vx?: number
  vy?: number
  flashlightOn: boolean
  flashlightOutput: number
  battery: number
  batteryDepleted: boolean
  equippedItem: "pistol" | "hands" | MeleeWeaponId
  meleeWeapon?: MeleeWeaponId | null
  meleeDurability?: number
  meleeMaxDurability?: number
  magAmmo: number
  magCapacity: number
  reserveAmmo: number
  planks: number
  channel: ChannelView | null
  lootMessage: string | null
  lootMessageUntil: number
}

export type ProgressionSlot = { id: string; index: number; survivor: ProgressionActor; notices: Notice[] }

export type WorldContext = { town: Town; ai: OutbreakAISubsystem; time: number; hour: number; slots: readonly ProgressionSlot[] }

/** A survivor looking closely at a reinforced barricade: which, for how long, and where they stood last tick. */
export type Study = { portal: string; t: number; x: number; y: number }

/** Selected-item behaviour on the primary button; `use` is an item a feature runs itself (fire & explosives). */
export type HeldUse = "fire" | "melee" | "shove" | "heal" | "throw" | "set" | "use"

export type OutbreakProgressionSnapshot = {
  tuning: ProgressionTuning
  nextId: number
  generatorAt: [string, number][]
  pings: Ping[]
  lures: Lure[]
  searchedContainers: [string, boolean][]
  ledger: LedgerSnapshot
  /** Practice per survivor and skill (D-19 slice 3). Absent in older snapshots. */
  mastery?: Record<string, Record<string, number>>
  /** Who is looking closely at which reinforced barricade, and for how long. */
  study?: Record<string, Study>
  /** Buildings whose held-out window has been boarded (once, so a broken one stays broken). */
  heldOut?: string[]
}

/**
 * What progression offers the discovery parts it is built from (`shared/discovery/`): the ledger and the world, the
 * survivor behind an interaction actor, feedback, and a few inventory moves. Parts never hold their own copy of these.
 */
export interface ProgressionHost {
  readonly ledger: Ledger
  readonly town: Town
  readonly tuning: ProgressionTuning
  readonly benches: readonly BenchSite[]
  /** The world as of the last command or tick (time for car alarms, light for bench crafting). */
  readonly lastWorld: WorldContext | undefined
  /** The survivor slot behind an interaction actor. */
  slotOf(actor: object): ProgressionSlot | undefined
  /** The next id from the counter pings, lures and glass share. */
  takeId(): number
  learned(recipe: string): boolean
  /** Bench tier: 1, plus the toolbox and the car battery installed. */
  tier(benchId: string): number
  /** Bench parts (toolbox, car battery) the survivor carries. */
  partsOn(actor: string): ItemId[]
  contents(storeId: string): Stack[]
  envFor(slot: ProgressionSlot, world?: WorldContext): LedgerEnv
  feedback(slot: ProgressionSlot, events: readonly LedgerEvent[]): void
  notify(slot: ProgressionSlot, text: string, kind: NoticeKind, key?: string): void
  project(slot: ProgressionSlot): void
  take(slot: ProgressionSlot, storeId: string, index?: number): boolean
  install(slot: ProgressionSlot, benchId: string): boolean
}
