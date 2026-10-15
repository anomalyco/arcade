import { angleDiff, clearLine, distToRect, raycast, type Rect } from "@arcade/kit/sim/geom"
import {
  Ledger,
  type ActorStoreTemplate,
  type ItemDef,
  type ItemId,
  type LedgerEnv,
  type LedgerEvent,
  type Rule,
  type Stack,
  type StoreSpec,
  type StoreState,
  type Tx,
} from "@arcade/kit/sim/ledger"
import { Rng } from "@arcade/kit/sim/rng"
import type { OutbreakAISubsystem } from "./ai"
import { dayCycle } from "./day-cycle"
import {
  INTERACT_RANGE,
  type InteractAction,
  type InteractActorState,
  type InteractionHandler,
  type RawInteractCandidate,
} from "./interact"
import { propShape, sightRects, type Building, type Door, type Prop, type Town } from "./map"

/**
 * Outbreak's inventory and safehouse progression, on top of `@arcade/kit/sim/ledger`.
 *
 * Each survivor has a 5-slot hotbar (hand tools, weapons, consumables), a belt of counted supplies (ammo, planks,
 * scrap, chem, batteries, keys) that reloads, barricades and crafting draw on, and a 4-slot pack (parts, spare tools).
 * Furniture containers are stores you search (quiet or smash) and then see into; ground drops are stores too. Each
 * house has a workbench and a stash sharing one store: depositing parts raises the bench tier, and researching a
 * recipe there in good light teaches it to the whole squad, who can then craft it anywhere.
 *
 * The sim calls `act` for a survivor's command, `step` once per tick, and reads `notices` for feedback. Everything
 * here is deterministic and shared by the room, the offline session and the client mirror (which only applies deltas).
 */

// ── Catalog ─────────────────────────────────────────────────────────────────────────────────────────────────────

export const HOTBAR_SIZE = 5
export const PACK_SIZE = 4

export const ITEMS: readonly ItemDef[] = [
  { id: "flashlight", label: "Flashlight", shortLabel: "LIGHT", tag: "light", slot: 0 },
  { id: "pistol", label: "9mm Pistol", shortLabel: "9MM", tag: "gun", slot: 1, charge: { max: 8, initial: 6, ammo: "ammo" } },
  { id: "crowbar", label: "Crowbar", shortLabel: "PRY", tag: "tool", slot: 2, activeOnly: true, mods: { shoveDamage: { add: 15 }, shoveStagger: { mul: 1.35 }, shoveRange: { add: 0.25 } } },
  { id: "spiked-board", label: "Spiked Board", shortLabel: "SPIKE", tag: "tool", slot: 2, activeOnly: true, mods: { shoveDamage: { add: 30 }, shoveStagger: { mul: 1.6 }, shoveRange: { add: 0.35 } } },
  { id: "medkit", label: "First Aid Kit", shortLabel: "MED", tag: "tool", slot: 3, stack: 3 },
  { id: "bandage", label: "Bandage", shortLabel: "BANDAGE", tag: "tool", slot: 3, stack: 3 },
  { id: "noisemaker", label: "Noisemaker", shortLabel: "LURE", tag: "tool", slot: 4, stack: 3 },

  { id: "ammo", label: "9mm Ammo", shortLabel: "9mm", tag: "ammo", maxCount: 24 },
  { id: "plank", label: "Wood Plank", shortLabel: "Planks", tag: "resource", maxCount: 6, discovers: ["seen:plank"] },
  { id: "scrap", label: "Scrap & Nails", shortLabel: "Scrap", tag: "resource", maxCount: 10, discovers: ["seen:scrap"] },
  { id: "chem", label: "Cloth & Alcohol", shortLabel: "Chem", tag: "resource", maxCount: 6, discovers: ["seen:chem"] },
  { id: "battery", label: "Battery", shortLabel: "Battery", tag: "resource", maxCount: 3, discovers: ["seen:battery"] },
  { id: "key", label: "Key", shortLabel: "Keys", tag: "key", maxCount: 4 },

  { id: "toolbox", label: "Hardware Toolbox", shortLabel: "Toolbox", tag: "part" },
  { id: "car-battery", label: "Car Battery", shortLabel: "Car battery", tag: "part", slots: 2 },

  { id: "seen:plank", label: "Planks", tag: "knowledge" },
  { id: "seen:scrap", label: "Scrap", tag: "knowledge" },
  { id: "seen:chem", label: "Chem", tag: "knowledge" },
  { id: "seen:battery", label: "Batteries", tag: "knowledge" },
  { id: "learned:bandage", label: "Bandage", tag: "knowledge" },
  { id: "learned:lure", label: "Noisemaker", tag: "knowledge" },
  { id: "learned:spiked-board", label: "Spiked Board", tag: "knowledge" },
  { id: "learned:reinforced", label: "Reinforced Barricade", tag: "knowledge" },
  { id: "learned:battery", label: "Flashlight Battery", tag: "knowledge" },
]

/** Belt order, as shown in the HUD. */
export const BELT_ITEMS = ["ammo", "plank", "scrap", "chem", "battery", "key"] as const
export const MATERIALS = ["plank", "scrap", "chem", "battery"] as const

export const ACTOR_STORES: readonly ActorStoreTemplate[] = [
  { suffix: "belt", mode: "counters", accepts: ["ammo", "resource", "key"], depositable: true },
  { suffix: "hotbar", mode: "slots", size: HOTBAR_SIZE, accepts: ["light", "gun", "tool"], preferSlots: true },
  { suffix: "pack", mode: "slots", size: PACK_SIZE, accepts: ["part", "tool", "gun"], depositable: true },
]

export type Recipe = {
  id: string
  label: string
  /** What crafting it makes; passive recipes change an action instead. */
  produces?: ItemId
  /** One line for the bench panel. */
  note: string
  /** Bench tier needed to research it (2 needs the toolbox installed). */
  tier: 1 | 2
  research: Readonly<Record<ItemId, number>>
  craft?: Readonly<Record<ItemId, number>>
}

export const RECIPES: readonly Recipe[] = [
  { id: "bandage", label: "Bandage", produces: "bandage", note: "Heals 25 in a second", tier: 1, research: { chem: 2 }, craft: { chem: 1 } },
  { id: "lure", label: "Noisemaker", produces: "noisemaker", note: "Throw it; the dead go to the noise", tier: 1, research: { scrap: 2, battery: 1 }, craft: { scrap: 1, battery: 1 } },
  { id: "spiked-board", label: "Spiked Board", produces: "spiked-board", note: "Wider, harder shoves", tier: 1, research: { plank: 1, scrap: 2 }, craft: { plank: 1, scrap: 2 } },
  { id: "reinforced", label: "Reinforced Barricade", note: "Each board takes a scrap and holds 80% longer", tier: 2, research: { plank: 2, scrap: 3 } },
  { id: "battery", label: "Flashlight Battery", produces: "battery", note: "A full charge for the flashlight", tier: 2, research: { scrap: 2, chem: 1 }, craft: { scrap: 1, chem: 1 } },
]

/** Recipes a material feeds, for the "new material" notice. */
export function recipesUsing(material: ItemId): Recipe[] {
  return RECIPES.filter((r) => material in r.research || (r.craft && material in r.craft))
}

export type ProgressionTuning = {
  /** Multiplies every loot roll's chance. */
  lootRate: number
  searchQuietTime: number
  searchQuietNoise: number
  searchSmashTime: number
  searchSmashNoise: number
  barricadeTime: number
  barricadeNoise: number
  reinforcedPlankHp: number
  healTime: number
  medkitHeal: number
  bandageHeal: number
  craftTime: number
  researchTime: number
  /** Light needed at the bench to research (daylight, the generator or flashlights). */
  researchLight: number
  /** Multiplies every recipe's research and craft cost (rounded, at least 1). */
  costScale: number
  pryTime: number
  pryNoise: number
  lureNoise: number
  lureSeconds: number
  generatorNoise: number
}

export const DEFAULT_PROGRESSION_TUNING: ProgressionTuning = {
  lootRate: 1,
  searchQuietTime: 1.2,
  searchQuietNoise: 3.5,
  searchSmashTime: 0.35,
  searchSmashNoise: 14,
  barricadeTime: 0.7,
  barricadeNoise: 9.5,
  reinforcedPlankHp: 180,
  healTime: 1.5,
  medkitHeal: 45,
  bandageHeal: 25,
  craftTime: 2,
  researchTime: 2.5,
  researchLight: 0.35,
  costScale: 1,
  pryTime: 1.2,
  pryNoise: 12,
  lureNoise: 30,
  lureSeconds: 8,
  generatorNoise: 18,
}

const scaleCost = (cost: Readonly<Record<ItemId, number>>, k: number) =>
  Object.fromEntries(Object.entries(cost).map(([item, n]) => [item, Math.max(1, Math.round(n * k))]))

/** The rule table for a tuning. Rebuilt when the Lab changes a tunable. */
export function progressionRules(t: ProgressionTuning): Rule[] {
  const rules: Rule[] = [
    { id: "barricade", label: "Boarding up", duration: t.barricadeTime, noise: t.barricadeNoise, consume: { plank: 1 } },
    { id: "barricade:reinforced", label: "Boarding up", duration: t.barricadeTime, noise: t.barricadeNoise, requires: { "learned:reinforced": 1 }, consume: { plank: 1, scrap: 1 } },
    { id: "heal:medkit", label: "Patching up", duration: t.healTime, consume: { medkit: 1 } },
    { id: "heal:bandage", label: "Bandaging", duration: t.healTime * 0.66, consume: { bandage: 1 } },
    { id: "throw:lure", label: "Throw", consume: { noisemaker: 1 } },
    { id: "swap:battery", label: "Fresh battery", consume: { battery: 1 } },
    { id: "unlock", label: "Unlocking", consume: { key: 1 } },
    { id: "pry", label: "Prying the door", duration: t.pryTime, noise: t.pryNoise, requires: { crowbar: 1 } },
  ]
  for (const r of RECIPES) {
    const seen = Object.fromEntries(Object.keys(r.research).map((m) => [`seen:${m}`, 1]))
    rules.push({
      id: `research:${r.id}`,
      label: `Researching ${r.label}`,
      duration: t.researchTime,
      station: "bench",
      lightMin: t.researchLight,
      ...(r.tier >= 2 ? { installed: { toolbox: 1 } } : {}),
      requires: seen,
      forbids: { [`learned:${r.id}`]: 1 },
      consume: scaleCost(r.research, t.costScale),
      produce: { [`learned:${r.id}`]: 1 },
      produceTo: "team/known",
    })
    if (r.produces && r.craft) {
      rules.push({
        id: `craft:${r.id}`,
        label: `Crafting ${r.label}`,
        duration: t.craftTime,
        requires: { [`learned:${r.id}`]: 1 },
        consume: scaleCost(r.craft, t.costScale),
        produce: { [r.produces]: 1 },
      })
    }
  }
  return rules
}

// ── World sites ─────────────────────────────────────────────────────────────────────────────────────────────────

type Roll = { item: ItemId; chance: number; min?: number; max?: number }

/** Loot by building archetype and furniture kind. Unknown archetypes fall back to `house`. */
export const LOOT_TABLES: Readonly<Record<string, Partial<Record<Prop["kind"], readonly Roll[]>>>> = {
  house: {
    dresser: [{ item: "ammo", chance: 0.7, min: 3, max: 7 }, { item: "medkit", chance: 0.25 }, { item: "key", chance: 0.22 }, { item: "chem", chance: 0.3 }],
    nightstand: [{ item: "ammo", chance: 0.5, min: 2, max: 5 }, { item: "noisemaker", chance: 0.3 }, { item: "battery", chance: 0.3 }, { item: "key", chance: 0.15 }],
    shelf: [{ item: "plank", chance: 0.5, min: 1, max: 2 }, { item: "scrap", chance: 0.4, min: 1, max: 2 }, { item: "crowbar", chance: 0.1 }],
    counter: [{ item: "chem", chance: 0.55, min: 1, max: 2 }, { item: "scrap", chance: 0.35, min: 1, max: 2 }, { item: "ammo", chance: 0.3, min: 2, max: 4 }],
    fridge: [{ item: "chem", chance: 0.35 }, { item: "ammo", chance: 0.25, min: 2, max: 4 }],
  },
  hardware: {
    shelf: [{ item: "plank", chance: 0.8, min: 1, max: 3 }, { item: "scrap", chance: 0.7, min: 2, max: 4 }, { item: "battery", chance: 0.35 }, { item: "crowbar", chance: 0.2 }, { item: "ammo", chance: 0.35, min: 2, max: 5 }],
  },
  pharmacy: {
    shelf: [{ item: "chem", chance: 0.8, min: 1, max: 3 }, { item: "medkit", chance: 0.45 }, { item: "battery", chance: 0.25 }, { item: "ammo", chance: 0.4, min: 3, max: 6 }],
  },
}

/** One big part per archetype, placed in its back room. */
const ARCHETYPE_PARTS: Readonly<Record<string, readonly ItemId[]>> = {
  hardware: ["toolbox", "car-battery"],
}

const CONTAINER_KINDS: ReadonlySet<Prop["kind"]> = new Set(["dresser", "shelf", "nightstand", "counter", "fridge"])
const CONTAINER_LABELS: Partial<Record<Prop["kind"], string>> = {
  dresser: "Dresser",
  shelf: "Shelf",
  nightstand: "Nightstand",
  counter: "Kitchen cabinet",
  fridge: "Fridge",
}
const CONTAINER_SLOTS = 4

export type LootSite = {
  /** Ledger store id, `loot:<prop index>`. */
  id: string
  propIndex: number
  kind: Prop["kind"]
  label: string
  rect: Rect
  x: number
  y: number
  buildingId: string | null
}

export type BenchSite = {
  /** Shared bench-and-stash store, `bench:<building id>`. */
  id: string
  buildingId: string
  bench: { x: number; y: number; rect: Rect }
  stash: { x: number; y: number; rect: Rect }
}

export function buildingAt(town: Town, x: number, y: number): Building | undefined {
  return town.buildings.find((b) => x >= b.rect[0] && x <= b.rect[2] && y >= b.rect[1] && y <= b.rect[3])
}

/** Containers from the town's furniture, stocked by archetype from the town seed. Deterministic. */
export function lootSites(town: Town, tuning: ProgressionTuning): { sites: LootSite[]; stores: StoreSpec[] } {
  const rng = new Rng((town.seed ^ 0x5c3e19a7) >>> 0)
  const sites: LootSite[] = []
  const stores: StoreSpec[] = []
  const backRoomShelves = new Map<string, number[]>()
  town.props.forEach((p, i) => {
    if (!CONTAINER_KINDS.has(p.kind)) return
    const shape = propShape(p)
    if (!shape) return
    const building = buildingAt(town, p.x, p.y)
    const table = LOOT_TABLES[building?.kind ?? "house"] ?? LOOT_TABLES.house!
    const contents: Stack[] = []
    for (const roll of table[p.kind] ?? []) {
      const hit = rng.next() < roll.chance * tuning.lootRate
      const n = (roll.min ?? 1) + rng.int((roll.max ?? roll.min ?? 1) - (roll.min ?? 1) + 1)
      if (hit && contents.length < CONTAINER_SLOTS) contents.push({ item: roll.item, count: n })
    }
    const id = `loot:${i}`
    sites.push({ id, propIndex: i, kind: p.kind, label: CONTAINER_LABELS[p.kind] ?? p.kind, rect: shape.rect, x: p.x, y: p.y, buildingId: building?.id ?? null })
    stores.push({ id, mode: "slots", scope: "shared", size: CONTAINER_SLOTS, revealed: false, at: { x: p.x, y: p.y }, initial: contents })
    if (building && p.y < building.rect[1] + 5.5) backRoomShelves.set(building.id, [...(backRoomShelves.get(building.id) ?? []), stores.length - 1])
  })
  for (const b of town.buildings) {
    const parts = ARCHETYPE_PARTS[b.kind]
    const shelves = backRoomShelves.get(b.id)
    if (!parts || !shelves?.length) continue
    parts.forEach((part, k) => {
      const spec = stores[shelves[k % shelves.length]!]!
      const slots = spec.initial as Stack[]
      if (slots.length >= CONTAINER_SLOTS) slots.pop()
      slots.unshift({ item: part, count: 1 })
    })
  }
  return { sites, stores }
}

/** A workbench and stash for every house, from the props its archetype places in the back room. */
export function benchSites(town: Town): BenchSite[] {
  const out: BenchSite[] = []
  for (const b of town.buildings) {
    const inside = (p: Prop) => p.x >= b.rect[0] && p.x <= b.rect[2] && p.y >= b.rect[1] && p.y <= b.rect[3]
    const bench = town.props.find((p) => p.kind === "workbench" && inside(p))
    const stash = town.props.find((p) => p.kind === "stash" && inside(p))
    if (!bench || !stash) continue
    out.push({
      id: `bench:${b.id}`,
      buildingId: b.id,
      bench: { x: bench.x, y: bench.y, rect: propShape(bench)!.rect },
      stash: { x: stash.x, y: stash.y, rect: propShape(stash)!.rect },
    })
  }
  return out
}

// ── Runtime ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type NoticeKind = "result" | "info" | "warning"
export type Notice = { text: string; kind: NoticeKind; key?: string }

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
export type PickMode = "take" | "bench" | "craft" | "pack"

/** The survivor fields progression reads and writes (a projection: the ledger is the source of truth). */
export type ProgressionActor = InteractActorState & {
  health: number
  maxHealth: number
  sprinting: boolean
  flashlightOn: boolean
  flashlightOutput: number
  battery: number
  batteryDepleted: boolean
  equippedItem: "pistol" | "hands"
  magAmmo: number
  magCapacity: number
  reserveAmmo: number
  planks: number
  channel: ChannelView | null
  lootMessage: string | null
  lootMessageUntil: number
}

export type ChannelView = { kind: string; targetId: string; label: string; x: number; y: number; elapsed: number; duration: number }

export type ProgressionSlot = { id: string; index: number; survivor: ProgressionActor; notices: Notice[] }

export type WorldContext = { town: Town; ai: OutbreakAISubsystem; time: number; hour: number; slots: readonly ProgressionSlot[] }

/** Selected-item behaviour on the primary button. */
export type HeldUse = "fire" | "shove" | "heal" | "throw"

const CHANNEL_SLACK = 0.65
const DROP_RANGE = 1.6
const PING_SECONDS = 6
const BUNDLE = { ammo: 6, plank: 2 } as const
const LURE_RANGE = 11
/** Light at a bench: one flashlight plus the room lamp clears the research threshold at night; the generator alone does. */
const BENCH_LIGHT_FLASHLIGHT = 0.2
const BENCH_LIGHT_LAMP = 0.2
const GENERATOR_LIGHT = 0.8

export class OutbreakProgression {
  readonly ledger: Ledger
  readonly containers: LootSite[]
  readonly benches: BenchSite[]
  readonly pings: Ping[] = []
  readonly lures: Lure[] = []
  tuning: ProgressionTuning
  private nextId = 1
  private generatorAt = new Map<string, number>()
  private actorOf = new WeakMap<object, ProgressionSlot>()

  constructor(
    readonly town: Town,
    tuning: Partial<ProgressionTuning> = {},
  ) {
    this.tuning = { ...DEFAULT_PROGRESSION_TUNING, ...tuning }
    const loot = lootSites(town, this.tuning)
    this.containers = loot.sites
    this.benches = benchSites(town)
    this.ledger = new Ledger({
      items: ITEMS,
      actorStores: ACTOR_STORES,
      stores: [
        ...loot.stores,
        ...this.benches.map((b): StoreSpec => ({ id: b.id, mode: "counters", scope: "shared", accepts: ["resource", "part", "tool"], at: { x: b.bench.x, y: b.bench.y } })),
      ],
      rules: progressionRules(this.tuning),
      knowledgeStore: "team/known",
    })
    // Discoveries and lessons reach the whole squad however the item arrived (a take, a craft, a test's grant).
    this.ledger.on((ev) => {
      if (ev.kind !== "unlocked" || this.quiet) return
      if (ev.source === "discover") {
        const material = ev.item.replace(/^seen:/, "")
        const uses = recipesUsing(material).map((r) => r.label)
        this.notifyAll(uses.length ? `New material: ${ev.label}. Bench recipes: ${uses.join(", ")}` : `New material: ${ev.label}`, "info", `seen:${material}`)
      } else this.notifyAll(`Squad learned ${ev.label}. Hold Q to craft it anywhere`, "result", ev.item)
    })
  }

  /** Set while granting a starting kit, so spawning does not announce planks as a discovery. */
  private quiet = false

  /** Applies Lab tuning; recipe costs and times change at once, loot rates on the next town. */
  setTuning(tuning: Partial<ProgressionTuning>): void {
    const next = { ...this.tuning, ...tuning }
    if (JSON.stringify(next) === JSON.stringify(this.tuning)) return
    this.tuning = next
    this.ledger.setRules(progressionRules(next))
  }

  addActor(slot: ProgressionSlot): void {
    this.actorOf.set(slot.survivor, slot)
    if (this.ledger.store(`${slot.id}/hotbar`)) return
    this.ledger.addActor(slot.id)
    this.quiet = true
    this.ledger.apply({ kind: "grant", actor: slot.id, item: "flashlight" })
    this.ledger.apply({ kind: "grant", actor: slot.id, item: "pistol" })
    this.ledger.apply({ kind: "grant", actor: slot.id, item: "ammo", count: 6 })
    this.ledger.apply({ kind: "grant", actor: slot.id, item: "plank", count: 2 })
    this.ledger.apply({ kind: "select", actor: slot.id, slot: 1 })
    this.quiet = false
    this.project(slot)
  }

  /** Forgets a survivor; with `dropAt`, what they carried stays there for the squad. */
  removeActor(id: string, dropAt?: { x: number; y: number }): void {
    this.ledger.removeActor(id, dropAt)
  }

  // ── Queries for presentation ──────────────────────────────────────────────────────────────────────────────

  hotbar(id: string): StoreState | undefined {
    return this.ledger.store(`${id}/hotbar`)
  }

  selected(id: string): Stack | null {
    return this.ledger.activeItem(id)
  }

  /** What the primary button does with the selected item. */
  heldUse(id: string): HeldUse {
    const item = this.selected(id)?.item
    if (item === "crowbar" || item === "spiked-board") return "shove"
    if (item === "medkit" || item === "bandage") return "heal"
    if (item === "noisemaker") return "throw"
    return this.ledger.count(`${id}/hotbar`, "pistol") > 0 ? "fire" : "shove"
  }

  /** Contents of the store behind an interaction target, in pick order (digit 1 = index 0). */
  contents(storeId: string): Stack[] {
    const st = this.ledger.store(storeId)
    if (!st) return []
    if (st.mode === "slots") return st.slots.filter((s): s is Stack => s !== null)
    return ITEMS.filter((d) => (st.counts[d.id] ?? 0) > 0).map((d) => ({ item: d.id, count: st.counts[d.id]! }))
  }

  /** The store an interaction target reads from, for strips (containers, drops, the stash and the bench). */
  storeFor(target: { kind: string; id: string } | undefined): string | null {
    if (!target) return null
    if (target.kind === "container" || target.kind === "drop") return target.id
    if (target.kind === "bench" || target.kind === "stash") return target.id.replace(/#.*$/, "")
    return null
  }

  learned(recipe: string): boolean {
    return this.ledger.count("team/known", `learned:${recipe}`) > 0
  }

  seen(material: ItemId): boolean {
    return this.ledger.count("team/known", `seen:${material}`) > 0
  }

  tier(benchId: string): number {
    return 1 + (this.ledger.count(benchId, "toolbox") > 0 ? 1 : 0) + (this.ledger.count(benchId, "car-battery") > 0 ? 1 : 0)
  }

  /** Recipes the squad can craft in the field, in strip order. */
  craftable(): Recipe[] {
    return RECIPES.filter((r) => r.produces && this.learned(r.id))
  }

  /** Bench rows in panel order: every recipe whose materials the squad has seen. */
  benchRows(): Recipe[] {
    return RECIPES.filter((r) => Object.keys(r.research).every((m) => this.seen(m)))
  }

  /** Light at a bench: daylight indoors, the room lamp at night, the generator, and flashlights of survivors at it. */
  benchLight(benchId: string, hour: number, survivors: readonly { x: number; y: number; flashlightOn: boolean; flashlightOutput: number }[]): number {
    const site = this.benches.find((b) => b.id === benchId)
    if (!site) return 0
    const day = dayCycle(hour)
    let light = day.sun * 0.9 + day.lamps * BENCH_LIGHT_LAMP
    if (this.ledger.count(benchId, "car-battery") > 0) light += GENERATOR_LIGHT
    for (const s of survivors) {
      if (s.flashlightOn && s.flashlightOutput > 0.2 && Math.hypot(s.x - site.bench.x, s.y - site.bench.y) < 3.2) light += BENCH_LIGHT_FLASHLIGHT
    }
    return light
  }

  // ── Interaction handlers ──────────────────────────────────────────────────────────────────────────────────

  /** Containers, ground drops, workbenches and stashes as interaction targets. */
  handlers(): InteractionHandler[] {
    return [this.containerHandler(), this.dropHandler(), this.benchHandler(), this.stashHandler()]
  }

  private containerHandler(): InteractionHandler {
    return {
      kind: "container",
      candidates: (town, actor) => {
        if (actor.peekingWindowId) return []
        const out: RawInteractCandidate[] = []
        const walls = town.barriers.filter((b) => b.kind === "wall").map((b) => b.rect)
        const here = buildingAt(town, actor.x, actor.y)?.id ?? null
        for (const c of this.containers) {
          if (distToRect(actor.x, actor.y, c.rect) > 1.45 || c.buildingId !== here) continue
          const nx = Math.max(c.rect[0], Math.min(c.rect[2], actor.x))
          const ny = Math.max(c.rect[1], Math.min(c.rect[3], actor.y))
          if (!clearLine(actor.x, actor.y, nx, ny, walls)) continue
          const st = this.ledger.store(c.id)
          if (!st) continue
          let primary: InteractAction
          let alt: InteractAction | undefined
          if (!st.revealed) {
            primary = { id: "search", label: "Search" }
            alt = { id: "smash", label: "Smash", modifier: "shift" }
          } else if (this.contents(c.id).length) primary = { id: "take", label: "Take all" }
          else continue
          out.push({ kind: "container", id: c.id, label: c.label, rect: c.rect, worldX: c.x, worldY: c.y, primary, alt, actions: alt ? [primary, alt] : [primary] })
        }
        return out
      },
      execute: (_town, actor, targetId, action) => {
        const slot = this.actorOf.get(actor)
        const c = this.containers.find((x) => x.id === targetId)
        if (!slot || !c || distToRect(actor.x, actor.y, c.rect) > INTERACT_RANGE) return { handled: false }
        if (action === "search" || action === "smash") {
          const smash = action === "smash"
          const t = this.tuning
          const res = this.ledger.start(
            {
              kind: "reveal",
              actor: slot.id,
              store: c.id,
              duration: smash ? t.searchSmashTime : t.searchQuietTime,
              noise: smash ? t.searchSmashNoise : t.searchQuietNoise,
              label: `${smash ? "Smashing" : "Searching"} ${c.label.toLowerCase()}`,
            },
            {},
            { x: c.x, y: c.y },
          )
          this.feedback(slot, res.events)
          return { handled: res.ok, kind: "container", targetId: c.id, action, noise: res.noise, noiseKind: smash ? "glass" : "search" }
        }
        if (action === "take") return { handled: this.take(slot, c.id), kind: "container", targetId: c.id, action }
        return { handled: false }
      },
    }
  }

  private dropHandler(): InteractionHandler {
    return {
      kind: "drop",
      candidates: (_town, actor) => {
        const out: RawInteractCandidate[] = []
        for (const st of this.ledger.stores.values()) {
          if (!st.id.startsWith("drop:") || !st.at) continue
          if (Math.hypot(actor.x - st.at.x, actor.y - st.at.y) > DROP_RANGE) continue
          const stacks = this.contents(st.id)
          if (!stacks.length) continue
          const label = stacks.length === 1 ? this.stackLabel(stacks[0]!) : "Supplies"
          const primary: InteractAction = { id: "take", label: stacks.length === 1 ? `Pick up ${label}` : "Pick up all" }
          const r = 0.3
          out.push({ kind: "drop", id: st.id, label, rect: [st.at.x - r, st.at.y - r, st.at.x + r, st.at.y + r], worldX: st.at.x, worldY: st.at.y, primary, actions: [primary] })
        }
        return out
      },
      execute: (_town, actor, targetId, action) => {
        const slot = this.actorOf.get(actor)
        if (!slot || action !== "take") return { handled: false }
        return { handled: this.take(slot, targetId), kind: "drop", targetId, action }
      },
    }
  }

  private benchHandler(): InteractionHandler {
    return {
      kind: "bench",
      candidates: (town, actor) => {
        if (actor.peekingWindowId) return []
        const here = buildingAt(town, actor.x, actor.y)?.id ?? null
        const out: RawInteractCandidate[] = []
        for (const b of this.benches) {
          if (b.buildingId !== here || distToRect(actor.x, actor.y, b.bench.rect) > 1.45) continue
          const primary: InteractAction = { id: "deposit", label: "Deposit supplies" }
          out.push({ kind: "bench", id: b.id, label: `Workbench · tier ${this.tier(b.id)}`, rect: b.bench.rect, worldX: b.bench.x, worldY: b.bench.y, primary, actions: [primary] })
        }
        return out
      },
      execute: (_town, actor, targetId, action) => {
        const slot = this.actorOf.get(actor)
        if (!slot || action !== "deposit" || !this.ledger.store(targetId)) return { handled: false }
        return { handled: this.deposit(slot, targetId), kind: "bench", targetId, action }
      },
    }
  }

  private stashHandler(): InteractionHandler {
    return {
      kind: "stash",
      candidates: (town, actor) => {
        if (actor.peekingWindowId) return []
        const here = buildingAt(town, actor.x, actor.y)?.id ?? null
        const out: RawInteractCandidate[] = []
        for (const b of this.benches) {
          if (b.buildingId !== here || distToRect(actor.x, actor.y, b.stash.rect) > 1.45) continue
          const primary: InteractAction = { id: "store", label: "Store held item" }
          const secondary: InteractAction = { id: "deposit", label: "Deposit supplies", hold: true }
          out.push({ kind: "stash", id: `${b.id}#stash`, label: "House stash · shared with the bench", rect: b.stash.rect, worldX: b.stash.x, worldY: b.stash.y, primary, secondary, actions: [primary, secondary] })
        }
        return out
      },
      execute: (_town, actor, targetId, action) => {
        const slot = this.actorOf.get(actor)
        const benchId = targetId.replace(/#.*$/, "")
        if (!slot || !this.ledger.store(benchId)) return { handled: false }
        if (action === "deposit") return { handled: this.deposit(slot, benchId), kind: "stash", targetId, action }
        if (action !== "store") return { handled: false }
        const hotbar = this.hotbar(slot.id)!
        const held = hotbar.slots[hotbar.selected]
        if (!held) {
          this.notify(slot, "Nothing in hand", "info")
          return { handled: false }
        }
        if (held.item === "flashlight" || held.item === "pistol") {
          this.notify(slot, `Keep the ${this.ledger.label(held.item).toLowerCase()}`, "info")
          return { handled: false }
        }
        const res = this.ledger.apply({ kind: "deposit", actor: slot.id, to: benchId, from: { store: hotbar.id, slot: hotbar.selected } })
        if (res.ok) this.notify(slot, `Stored ${this.ledger.label(held.item)}`, "result")
        this.feedback(slot, res.events)
        return { handled: res.ok, kind: "stash", targetId, action }
      },
    }
  }

  // ── Doors with keys and crowbars ──────────────────────────────────────────────────────────────────────────

  /** How this actor can get through a keyed door: with a key, by prying, or not at all. */
  doorAccess(actor: InteractActorState): { key: boolean; pry: boolean } {
    const slot = this.actorOf.get(actor)
    if (!slot) return { key: false, pry: false }
    return { key: this.ledger.count(slot.id, "key") > 0, pry: this.ledger.count(slot.id, "crowbar") > 0 }
  }

  /** Opens a keyed door with a key (instant) or starts prying it. Returns the noise made. */
  openKeyed(actor: InteractActorState, door: Door, how: "unlock" | "pry"): { handled: boolean; noise?: number } {
    const slot = this.actorOf.get(actor)
    if (!slot) return { handled: false }
    if (how === "unlock") {
      const res = this.ledger.apply({ kind: "run", actor: slot.id, rule: "unlock", ref: door.id })
      if (!res.ok) {
        this.notify(slot, "No key", "warning")
        return { handled: false }
      }
      door.locked = false
      door.keyed = false
      this.notify(slot, "Unlocked", "result", "portal")
      return { handled: true, noise: 1.5 }
    }
    const cx = (door.rect[0] + door.rect[2]) / 2
    const cy = (door.rect[1] + door.rect[3]) / 2
    const res = this.ledger.start({ kind: "run", actor: slot.id, rule: "pry", ref: door.id }, {}, { x: cx, y: cy })
    this.feedback(slot, res.events)
    return { handled: res.ok, noise: res.noise }
  }

  // ── Actions ───────────────────────────────────────────────────────────────────────────────────────────────

  select(slot: ProgressionSlot, index?: number, delta?: number): void {
    this.ledger.apply({ kind: "select", actor: slot.id, slot: index, delta })
  }

  /** The survivor's progression verbs for one command. Returns noise the caller should emit, if any. */
  act(slot: ProgressionSlot, cmd: ProgressionCommand, world: WorldContext, target: { kind: string; id: string } | undefined): { noise: number; noiseKind: string } {
    const p = slot.survivor
    let noise = 0
    let noiseKind = "door"
    const loud = (n: number, kind: string) => {
      if (n > noise) {
        noise = n
        noiseKind = kind
      }
    }
    if (cmd.pick) this.pick(slot, cmd.pick, world, target)
    if (cmd.reload && this.selected(slot.id)?.item === "flashlight") this.swapBattery(slot)
    if (cmd.barricade) loud(this.startBarricade(slot, world), "barricade")
    if (cmd.fire) {
      const use = this.heldUse(slot.id)
      if (use === "heal") this.startHeal(slot)
      else if (use === "throw") this.throwLure(slot, world)
    }
    if (cmd.drop) this.dropHeld(slot)
    if (cmd.bundle) this.dropBundle(slot)
    if (cmd.ping) this.ping(slot, world, target)
    if (p.flashlightOn === false && p.batteryDepleted && cmd.reload) this.swapBattery(slot)
    return { noise, noiseKind }
  }

  /** A pistol view for combat: loaded rounds, capacity, belt reserve, spending and reloading. */
  pistol(id: string): PistolAmmo {
    const l = this.ledger
    const stack = () => l.store(`${id}/hotbar`)?.slots.find((s) => s?.item === "pistol") ?? null
    return {
      get loaded() {
        return stack()?.charge ?? 0
      },
      get capacity() {
        return stack() ? 8 : 0
      },
      get reserve() {
        return l.count(id, "ammo")
      },
      spend: () => l.apply({ kind: "useCharge", actor: id, item: "pistol" }).ok,
      reload: () => l.apply({ kind: "reload", actor: id, item: "pistol" }).ok,
      fill: () => void l.apply({ kind: "setCharge", actor: id, item: "pistol", charge: 8 }),
    }
  }

  /** Melee modifiers from the held tool. */
  shoveMods(id: string): { damage: number; stagger: number; range: number } {
    return {
      damage: this.ledger.stat(id, "shoveDamage", 15),
      stagger: this.ledger.stat(id, "shoveStagger", 1),
      range: this.ledger.stat(id, "shoveRange", 0),
    }
  }

  private take(slot: ProgressionSlot, storeId: string, index?: number): boolean {
    let tx: Tx = { kind: "take", actor: slot.id, from: storeId }
    if (index !== undefined) {
      const st = this.ledger.store(storeId)
      const stack = this.contents(storeId)[index]
      if (!st || !stack) return false
      if (st.mode === "slots") tx = { ...tx, slot: st.slots.indexOf(stack) }
      else tx = { ...tx, item: stack.item }
    }
    const before = this.carried(slot.id)
    const res = this.ledger.apply(tx, this.envFor(slot, undefined))
    if (res.ok) {
      const gained = this.diffCarried(before, this.carried(slot.id))
      if (gained) this.notify(slot, gained, "result", `take:${storeId}`)
    }
    this.feedback(slot, res.events)
    return res.ok
  }

  private deposit(slot: ProgressionSlot, benchId: string): boolean {
    const tierBefore = this.tier(benchId)
    const before = this.carried(slot.id)
    const res = this.ledger.apply({ kind: "deposit", actor: slot.id, to: benchId })
    if (!res.ok) {
      this.notify(slot, res.reason === "full" ? "The stash is full" : "Nothing to deposit", "info", "deposit")
      return false
    }
    const moved = this.diffCarried(this.carried(slot.id), before)
    this.notify(slot, moved ? `Deposited ${moved}` : "Deposited", "result", "deposit")
    const tier = this.tier(benchId)
    if (tier > tierBefore) this.notifyAll(tier === 2 ? "Workbench tier 2: the toolbox is installed" : `Workbench tier ${tier}: the generator is wired up`, "result")
    return true
  }

  private pick(slot: ProgressionSlot, pick: NonNullable<ProgressionCommand["pick"]>, world: WorldContext, target: { kind: string; id: string } | undefined): void {
    if (pick.mode === "take") {
      const store = this.storeFor(target)
      if (!store || target?.kind === "bench") return
      const stack = this.contents(store)[pick.index]
      if (target?.kind === "stash" && stack && this.ledger.items.get(stack.item)?.tag === "part") {
        this.notify(slot, "That part is installed in the bench", "info")
        return
      }
      this.take(slot, store, pick.index)
      return
    }
    if (pick.mode === "pack") {
      const hotbar = this.hotbar(slot.id)!
      const res = this.ledger.apply({ kind: "swap", actor: slot.id, a: { store: `${slot.id}/pack`, slot: pick.index }, b: { store: hotbar.id, slot: hotbar.selected } })
      if (!res.ok) this.notify(slot, res.reason === "full" ? "That goes in the pack, not your hands" : "Empty pack slot", "info", "pack")
      return
    }
    if (pick.mode === "craft") {
      const recipe = this.craftable()[pick.index]
      if (!recipe) return
      const station = target?.kind === "bench" || target?.kind === "stash" ? this.storeFor(target)! : undefined
      const res = this.ledger.start({ kind: "run", actor: slot.id, rule: `craft:${recipe.id}`, station }, this.envFor(slot, world), { x: slot.survivor.x, y: slot.survivor.y })
      this.feedback(slot, res.events)
      return
    }
    // Bench row: research a recipe, or craft one already learned using the bench's stock.
    if (target?.kind !== "bench") return
    const benchId = target.id
    const recipe = this.benchRows()[pick.index]
    if (!recipe) return
    const rule = this.learned(recipe.id) ? `craft:${recipe.id}` : `research:${recipe.id}`
    if (rule.startsWith("craft:") && !recipe.produces) {
      this.notify(slot, `${recipe.label} is already learned`, "info")
      return
    }
    const site = this.benches.find((b) => b.id === benchId)!
    const res = this.ledger.start({ kind: "run", actor: slot.id, rule, station: benchId }, this.envFor(slot, world), { x: site.bench.x, y: site.bench.y })
    this.feedback(slot, res.events)
  }

  private startBarricade(slot: ProgressionSlot, world: WorldContext): number {
    const p = slot.survivor
    const best = this.barricadeTarget(p, world)
    if (!best) return 0
    if (world.ai.getBarricadePlanks(best.id) >= 3) {
      this.notify(slot, "Fully boarded", "info", "barricade")
      return 0
    }
    const reinforced = this.ledger.canApply({ kind: "run", actor: slot.id, rule: "barricade:reinforced" }).ok
    const rule = reinforced ? "barricade:reinforced" : "barricade"
    const label = `Boarding up ${world.town.doors.some((d) => d.id === best.id) ? "door" : "window"}`
    const res = this.ledger.start({ kind: "run", actor: slot.id, rule, ref: best.id, label }, this.envFor(slot, world), { x: best.x, y: best.y })
    if (!res.ok && res.reason === "missing_item") this.notify(slot, "No planks", "warning", "barricade")
    else this.feedback(slot, res.events)
    return res.ok ? res.noise : 0
  }

  private barricadeTarget(p: ProgressionActor, world: WorldContext): { id: string; x: number; y: number } | null {
    let best: { id: string; x: number; y: number } | null = null
    let bestDist = INTERACT_RANGE
    for (const o of [...world.town.doors, ...world.town.windows]) {
      const d = distToRect(p.x, p.y, o.rect)
      if (d <= bestDist && world.ai.getBarricadePlanks(o.id) < 3) {
        bestDist = d
        best = { id: o.id, x: (o.rect[0] + o.rect[2]) / 2, y: (o.rect[1] + o.rect[3]) / 2 }
      }
    }
    if (best) return best
    for (const o of [...world.town.doors, ...world.town.windows]) {
      if (distToRect(p.x, p.y, o.rect) <= INTERACT_RANGE) return { id: o.id, x: (o.rect[0] + o.rect[2]) / 2, y: (o.rect[1] + o.rect[3]) / 2 }
    }
    return null
  }

  private startHeal(slot: ProgressionSlot): void {
    const item = this.selected(slot.id)!.item
    const p = slot.survivor
    if (p.health >= p.maxHealth) {
      this.notify(slot, "Not hurt", "info", "heal")
      return
    }
    const res = this.ledger.start({ kind: "run", actor: slot.id, rule: `heal:${item}` })
    this.feedback(slot, res.events)
  }

  private throwLure(slot: ProgressionSlot, world: WorldContext): void {
    const p = slot.survivor
    const res = this.ledger.apply({ kind: "run", actor: slot.id, rule: "throw:lure" })
    if (!res.ok) return
    const dx = Math.cos(p.aim)
    const dy = Math.sin(p.aim)
    const reach = Math.max(0.6, raycast(p.x, p.y, dx, dy, sightRects(world.town), LURE_RANGE) - 0.35)
    this.lures.push({ id: this.nextId++, x: p.x + dx * reach, y: p.y + dy * reach, until: world.time + 1 + this.tuning.lureSeconds, next: world.time + 1 })
    this.notify(slot, "Noisemaker thrown", "result", "lure")
  }

  private swapBattery(slot: ProgressionSlot): void {
    const p = slot.survivor
    if (p.battery > 0.95 && !p.batteryDepleted) {
      this.notify(slot, "Battery is full", "info", "flashlight")
      return
    }
    const res = this.ledger.apply({ kind: "run", actor: slot.id, rule: "swap:battery" })
    if (!res.ok) {
      this.notify(slot, "No spare battery", "warning", "flashlight")
      return
    }
    p.battery = 1
    p.batteryDepleted = false
    this.notify(slot, "Fresh battery", "result", "flashlight")
  }

  private dropHeld(slot: ProgressionSlot): void {
    const p = slot.survivor
    const held = this.selected(slot.id)
    if (!held) {
      this.notify(slot, "Nothing in hand", "info", "drop")
      return
    }
    const res = this.ledger.apply({ kind: "drop", actor: slot.id, at: this.dropPoint(p) })
    if (res.ok) this.notify(slot, `Dropped ${this.ledger.label(held.item)}`, "info", "drop")
  }

  private dropBundle(slot: ProgressionSlot): void {
    const items: Record<ItemId, number> = {}
    for (const [item, n] of Object.entries(BUNDLE)) {
      const have = this.ledger.count(`${slot.id}/belt`, item)
      if (have > 0) items[item] = Math.min(n, have)
    }
    if (!Object.keys(items).length) {
      this.notify(slot, "No ammo or planks to share", "info", "drop")
      return
    }
    const res = this.ledger.apply({ kind: "drop", actor: slot.id, items, at: this.dropPoint(slot.survivor) })
    if (res.ok) this.notify(slot, `Left ${this.describe(Object.entries(items).map(([item, count]) => ({ item, count })))}`, "result", "drop")
  }

  private dropPoint(p: ProgressionActor): { x: number; y: number } {
    const d = Math.max(0.25, Math.min(0.8, raycast(p.x, p.y, Math.cos(p.aim), Math.sin(p.aim), sightRects(this.town), 0.8) - 0.25))
    return { x: Number((p.x + Math.cos(p.aim) * d).toFixed(3)), y: Number((p.y + Math.sin(p.aim) * d).toFixed(3)) }
  }

  private ping(slot: ProgressionSlot, world: WorldContext, target: { kind: string; id: string } | undefined): void {
    const p = slot.survivor
    let at: { x: number; y: number; label: string } | null = null
    const store = this.storeFor(target)
    if (target && store) {
      const st = this.ledger.store(store)
      const stacks = this.contents(store)
      const site = this.containers.find((c) => c.id === store)
      const name = target.kind === "drop" ? "Supplies" : target.kind === "bench" ? "Workbench" : target.kind === "stash" ? "Stash" : (site?.label ?? "Here")
      const what = st && !st.revealed ? "unsearched" : stacks.length ? this.describe(stacks.slice(0, 2)) : "empty"
      const pos = st?.at ?? { x: p.x, y: p.y }
      at = { x: pos.x, y: pos.y, label: `${name}: ${what}` }
    } else if (target && (target.kind === "door" || target.kind === "window")) {
      const o = [...world.town.doors, ...world.town.windows].find((x) => x.id === target.id)
      if (o) at = { x: (o.rect[0] + o.rect[2]) / 2, y: (o.rect[1] + o.rect[3]) / 2, label: `${target.kind === "door" ? "Door" : "Window"} ${world.ai.getBarricadePlanks(o.id)}/3` }
    }
    if (!at) {
      let best: { x: number; y: number; d: number } | null = null
      for (const z of world.ai.agents) {
        if (z.state === "dead") continue
        const d = Math.hypot(z.x - p.x, z.y - p.y)
        if (d > 18 || Math.abs(angleDiff(Math.atan2(z.y - p.y, z.x - p.x), p.aim)) > 0.35) continue
        if (!best || d < best.d) best = { x: z.x, y: z.y, d }
      }
      at = best ? { x: best.x, y: best.y, label: "Zombie" } : { x: p.x + Math.cos(p.aim) * 5, y: p.y + Math.sin(p.aim) * 5, label: "Over here" }
    }
    const mine = this.pings.findIndex((x) => x.by === slot.index)
    if (mine >= 0) this.pings.splice(mine, 1)
    this.pings.push({ id: this.nextId++, by: slot.index, x: Number(at.x.toFixed(2)), y: Number(at.y.toFixed(2)), label: at.label, until: world.time + PING_SECONDS })
  }

  // ── Step ──────────────────────────────────────────────────────────────────────────────────────────────────

  /** Once per tick: channels (cancelled by walking off or sprinting), lures, the generator hum, and projections. */
  step(dt: number, world: WorldContext): { topologyChanged: boolean } {
    let topologyChanged = false
    for (const slot of world.slots) {
      const ch = this.ledger.channel(slot.id)
      const p = slot.survivor
      if (!ch) continue
      const away = ch.at && Math.hypot(p.x - ch.at.x, p.y - ch.at.y) > INTERACT_RANGE + CHANNEL_SLACK
      if (away || (p.sprinting && ch.tx.kind === "run" && !ch.tx.rule.startsWith("craft:"))) this.ledger.cancel(slot.id)
      else if (p.sprinting) this.ledger.cancel(slot.id)
    }
    const bySlot = new Map(world.slots.map((s) => [s.id, s]))
    const events = this.ledger.step(dt, (actor) => {
      const slot = bySlot.get(actor)
      return slot ? this.envFor(slot, world) : {}
    })
    for (const ev of events) {
      const slot = "actor" in ev && ev.actor ? bySlot.get(ev.actor) : undefined
      if (!slot) continue
      if (ev.kind === "ran") topologyChanged = this.applyEffect(slot, ev, world) || topologyChanged
      this.feedback(slot, [ev])
    }
    for (let i = this.lures.length - 1; i >= 0; i--) {
      const lure = this.lures[i]!
      if (world.time >= lure.until) {
        this.lures.splice(i, 1)
        continue
      }
      if (world.time >= lure.next) {
        world.ai.emitNoise(lure.x, lure.y, this.tuning.lureNoise, "lure", world.time, "lure", 1.4)
        lure.next = world.time + 1.5
      }
    }
    for (let i = this.pings.length - 1; i >= 0; i--) if (world.time >= this.pings[i]!.until) this.pings.splice(i, 1)
    const night = dayCycle(world.hour).lamps > 0.5
    for (const b of this.benches) {
      if (!night || this.ledger.count(b.id, "car-battery") <= 0) continue
      const next = this.generatorAt.get(b.id) ?? 0
      if (world.time >= next) {
        world.ai.emitNoise(b.bench.x, b.bench.y, this.tuning.generatorNoise, "generator", world.time, "generator", 1.2)
        this.generatorAt.set(b.id, world.time + 3)
      }
    }
    for (const slot of world.slots) this.project(slot)
    return { topologyChanged }
  }

  /** Writes the ledger's view onto the survivor's legacy fields (HUD, wire, combat animation). */
  project(slot: ProgressionSlot): void {
    const p = slot.survivor
    const pistol = this.pistol(slot.id)
    p.magAmmo = pistol.loaded
    p.magCapacity = pistol.capacity || 8
    p.reserveAmmo = pistol.reserve
    p.planks = this.ledger.count(`${slot.id}/belt`, "plank")
    p.equippedItem = this.heldUse(slot.id) === "fire" && this.selected(slot.id)?.item !== "flashlight" ? "pistol" : this.selected(slot.id)?.item === "flashlight" && pistol.capacity ? "pistol" : "hands"
    const ch = this.ledger.channel(slot.id)
    if (!ch) p.channel = null
    else {
      const ref = ch.tx.kind === "run" ? (ch.tx.ref ?? ch.tx.station ?? "") : ch.tx.kind === "reveal" ? ch.tx.store : ""
      const kind = ch.tx.kind === "reveal" ? "search" : ch.tx.kind === "run" ? ch.tx.rule.split(":")[0]! : ch.tx.kind
      p.channel = { kind, targetId: ref, label: ch.label, x: ch.at?.x ?? p.x, y: ch.at?.y ?? p.y, elapsed: ch.elapsed, duration: ch.duration }
    }
  }

  // ── Effects and feedback ──────────────────────────────────────────────────────────────────────────────────

  private envFor(slot: ProgressionSlot, world: WorldContext | undefined): LedgerEnv {
    return {
      light: world ? this.lightFor(slot, world) : 1,
      check: (tx) => {
        if (!world || tx.kind !== "run") return null
        if (tx.rule.startsWith("barricade") && tx.ref && world.ai.getBarricadePlanks(tx.ref) >= 3) return "fully boarded"
        if (tx.rule.startsWith("heal:") && slot.survivor.health >= slot.survivor.maxHealth) return "not hurt"
        if (tx.rule === "pry") {
          const door = world.town.doors.find((d) => d.id === tx.ref)
          if (!door?.locked) return "already open"
        }
        return null
      },
    }
  }

  private lightFor(slot: ProgressionSlot, world: WorldContext): number {
    const ch = this.ledger.channel(slot.id)
    const station = ch?.tx.kind === "run" ? ch.tx.station : undefined
    const bench = station ?? this.benches.find((b) => Math.hypot(slot.survivor.x - b.bench.x, slot.survivor.y - b.bench.y) < 3)?.id
    return bench ? this.benchLight(bench, world.hour, world.slots.map((s) => s.survivor)) : dayCycle(world.hour).sun
  }

  private applyEffect(slot: ProgressionSlot, ev: Extract<LedgerEvent, { kind: "ran" }>, world: WorldContext): boolean {
    const p = slot.survivor
    if (ev.rule.startsWith("barricade") && ev.ref) {
      const hp = ev.rule === "barricade:reinforced" ? this.tuning.reinforcedPlankHp : 100
      if (!world.ai.addBarricadePlank(ev.ref, hp)) return false
      const door = world.town.doors.find((d) => d.id === ev.ref)
      if (door) door.open = false
      const win = world.town.windows.find((w) => w.id === ev.ref)
      if (win) win.open = false
      world.ai.rebuildTopology(world.town)
      this.notify(slot, `Boarded ${world.ai.getBarricadePlanks(ev.ref)}/3`, "result", "barricade")
      return true
    }
    if (ev.rule.startsWith("heal:")) {
      const amount = ev.rule === "heal:medkit" ? this.tuning.medkitHeal : this.tuning.bandageHeal
      const before = p.health
      p.health = Math.min(p.maxHealth, p.health + amount)
      this.notify(slot, `+${Math.round(p.health - before)} HP`, "result", "heal")
      return false
    }
    if (ev.rule === "pry" && ev.ref) {
      const door = world.town.doors.find((d) => d.id === ev.ref)
      if (!door) return false
      door.locked = false
      door.keyed = false
      door.open = true
      world.ai.rebuildTopology(world.town)
      this.notify(slot, "Pried open", "result", "portal")
      return true
    }
    if (ev.rule.startsWith("craft:")) {
      const recipe = RECIPES.find((r) => `craft:${r.id}` === ev.rule)
      if (recipe) this.notify(slot, `Crafted ${recipe.label}`, "result", "craft")
    }
    return false
  }

  /** Turns ledger events into notices: discoveries, lessons, rejections and search results. */
  private feedback(slot: ProgressionSlot, events: readonly LedgerEvent[]): void {
    for (const ev of events) {
      if (ev.kind === "revealed") {
        this.notify(slot, ev.items.length ? `Found ${this.describe(ev.items)}` : "Nothing here", ev.items.length ? "result" : "info", "search")
      } else if (ev.kind === "rejected") {
        const text = this.rejectionText(ev)
        if (text) this.notify(slot, text, "warning", `rejected:${ev.rule ?? ev.reason}`)
      }
    }
  }

  private rejectionText(ev: Extract<LedgerEvent, { kind: "rejected" }>): string | null {
    switch (ev.reason) {
      case "full":
        return ev.store?.startsWith("bench:") ? "The stash is full" : "Inventory full"
      case "low_light":
        return "Too dark to work. Shine a flashlight or run the generator"
      case "missing_item":
        return ev.item ? `Need ${this.ledger.label(ev.item).toLowerCase()}` : "Missing materials"
      case "missing_requirement":
        if (ev.item === "toolbox") return "Needs the toolbox installed (tier 2)"
        if (ev.item?.startsWith("seen:")) return "Find the materials first"
        if (ev.item === "crowbar") return "Needs a crowbar"
        return "Not learned yet"
      case "already_known":
        return "Already learned"
      case "blocked":
        return ev.detail === "not hurt" ? "Not hurt" : ev.detail === "fully boarded" ? "Fully boarded" : null
      default:
        return null
    }
  }

  notify(slot: ProgressionSlot, text: string, kind: NoticeKind, key?: string): void {
    slot.notices.push({ text, kind, key })
    if (slot.notices.length > 24) slot.notices.splice(0, slot.notices.length - 24)
    slot.survivor.lootMessage = text
    slot.survivor.lootMessageUntil = Infinity
  }

  private allSlots: () => readonly ProgressionSlot[] = () => []
  /** The squad, for notices everyone hears (recipes learned, bench tiers). */
  bindSquad(slots: () => readonly ProgressionSlot[]): void {
    this.allSlots = slots
  }

  private notifyAll(text: string, kind: NoticeKind, key?: string): void {
    for (const s of this.allSlots()) this.notify(s, text, kind, key)
  }

  /** "9mm ×6" for belt supplies, "First Aid Kit ×2" for things you hold. */
  stackLabel(s: Stack): string {
    const label = this.ledger.label(s.item, Boolean(this.ledger.items.get(s.item)?.maxCount))
    return s.count > 1 ? `${label} ×${s.count}` : label
  }

  describe(stacks: readonly Stack[]): string {
    return stacks.map((s) => (s.count > 1 ? `${s.count} ${this.ledger.label(s.item, true)}` : this.ledger.label(s.item))).join(", ")
  }

  private carried(id: string): Map<ItemId, number> {
    const out = new Map<ItemId, number>()
    for (const t of ACTOR_STORES) {
      const st = this.ledger.store(`${id}/${t.suffix}`)
      if (!st) continue
      for (const s of this.contents(st.id)) out.set(s.item, (out.get(s.item) ?? 0) + s.count)
    }
    return out
  }

  /** "+6 9mm, Medkit" for what `after` has over `before`. */
  private diffCarried(before: Map<ItemId, number>, after: Map<ItemId, number>): string {
    const parts: Stack[] = []
    for (const [item, n] of after) {
      const d = n - (before.get(item) ?? 0)
      if (d > 0) parts.push({ item, count: d })
    }
    return parts.map((s) => (this.ledger.items.get(s.item)?.maxCount ? `+${s.count} ${this.ledger.label(s.item, true)}` : this.ledger.label(s.item))).join(", ")
  }
}

export type PistolAmmo = {
  readonly loaded: number
  readonly capacity: number
  readonly reserve: number
  spend(): boolean
  reload(): boolean
  fill(): void
}

export { Ledger, type LedgerEvent, type Stack, type StoreState }
