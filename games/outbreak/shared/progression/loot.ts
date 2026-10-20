import type { Rect } from "@arcade/kit/sim/geom"
import type { ItemId, Stack, StoreSpec } from "@arcade/kit/sim/ledger"
import { Rng } from "@arcade/kit/sim/rng"
import { isMeleeWeapon } from "../combat"
import { propShape, type Building, type Prop, type Town } from "../map"
import type { ProgressionTuning } from "./tuning"

/**
 * Where loot and workbenches are: furniture containers stocked by building archetype from the town seed, and a bench
 * and stash for every house that has them. Deterministic.
 */

type Roll = { item: ItemId; chance: number; min?: number; max?: number }

/** Loot by building archetype and furniture kind. Unknown archetypes fall back to `house`. */
export const LOOT_TABLES: Readonly<Record<string, Partial<Record<Prop["kind"], readonly Roll[]>>>> = {
  house: {
    dresser: [
      { item: "ammo", chance: 0.7, min: 3, max: 7 },
      { item: "medkit", chance: 0.25 },
      { item: "key", chance: 0.22 },
      { item: "chem", chance: 0.3 },
      { item: "bat", chance: 0.14 },
    ],
    nightstand: [
      { item: "ammo", chance: 0.5, min: 2, max: 5 },
      { item: "noisemaker", chance: 0.3 },
      { item: "battery", chance: 0.3 },
      { item: "key", chance: 0.15 },
      { item: "knife", chance: 0.14 },
    ],
    shelf: [
      { item: "plank", chance: 0.5, min: 1, max: 2 },
      { item: "scrap", chance: 0.4, min: 1, max: 2 },
      { item: "crowbar", chance: 0.12 },
      { item: "hammer", chance: 0.18 },
      { item: "pipe", chance: 0.16 },
      { item: "bat", chance: 0.14 },
    ],
    counter: [
      { item: "chem", chance: 0.55, min: 1, max: 2 },
      { item: "scrap", chance: 0.35, min: 1, max: 2 },
      { item: "ammo", chance: 0.3, min: 2, max: 4 },
      { item: "knife", chance: 0.36 },
    ],
    fridge: [
      { item: "chem", chance: 0.35 },
      { item: "ammo", chance: 0.25, min: 2, max: 4 },
    ],
    desk: [
      { item: "battery", chance: 0.4 },
      { item: "key", chance: 0.2 },
      { item: "noisemaker", chance: 0.25 },
      { item: "ammo", chance: 0.3, min: 2, max: 4 },
    ],
  },
  hardware: {
    shelf: [
      { item: "plank", chance: 0.8, min: 1, max: 3 },
      { item: "scrap", chance: 0.7, min: 2, max: 4 },
      { item: "battery", chance: 0.35 },
      { item: "crowbar", chance: 0.22 },
      { item: "hammer", chance: 0.26 },
      { item: "pipe", chance: 0.22 },
      { item: "axe", chance: 0.18 },
      { item: "machete", chance: 0.15 },
      { item: "fire-axe", chance: 0.1 },
      { item: "ammo", chance: 0.35, min: 2, max: 5 },
    ],
    counter: [
      { item: "scrap", chance: 0.65, min: 1, max: 3 },
      { item: "hammer", chance: 0.3 },
      { item: "crowbar", chance: 0.2 },
      { item: "battery", chance: 0.3 },
    ],
  },
  pharmacy: {
    shelf: [
      { item: "chem", chance: 0.8, min: 1, max: 3 },
      { item: "medkit", chance: 0.45 },
      { item: "battery", chance: 0.25 },
      { item: "ammo", chance: 0.4, min: 3, max: 6 },
      { item: "knife", chance: 0.12 },
    ],
  },
  police: {
    shelf: [
      { item: "ammo", chance: 0.85, min: 5, max: 10 },
      { item: "bat", chance: 0.28 },
      { item: "crowbar", chance: 0.24 },
      { item: "machete", chance: 0.22 },
      { item: "fire-axe", chance: 0.18 },
      { item: "key", chance: 0.3 },
    ],
    dresser: [
      { item: "ammo", chance: 0.75, min: 4, max: 8 },
      { item: "bat", chance: 0.26 },
      { item: "machete", chance: 0.22 },
      { item: "medkit", chance: 0.3 },
    ],
    counter: [
      { item: "ammo", chance: 0.65, min: 3, max: 7 },
      { item: "key", chance: 0.35 },
      { item: "bat", chance: 0.22 },
      { item: "battery", chance: 0.3 },
    ],
  },
  garage: {
    shelf: [
      { item: "scrap", chance: 0.75, min: 2, max: 4 },
      { item: "pipe", chance: 0.34 },
      { item: "crowbar", chance: 0.28 },
      { item: "hammer", chance: 0.3 },
      { item: "axe", chance: 0.18 },
      { item: "fire-axe", chance: 0.12 },
    ],
    counter: [
      { item: "scrap", chance: 0.6, min: 1, max: 3 },
      { item: "pipe", chance: 0.28 },
      { item: "hammer", chance: 0.25 },
    ],
  },
  warehouse: {
    shelf: [
      { item: "plank", chance: 0.75, min: 2, max: 4 },
      { item: "scrap", chance: 0.7, min: 2, max: 4 },
      { item: "pipe", chance: 0.32 },
      { item: "crowbar", chance: 0.28 },
      { item: "hammer", chance: 0.26 },
      { item: "axe", chance: 0.2 },
      { item: "fire-axe", chance: 0.14 },
    ],
    counter: [
      { item: "scrap", chance: 0.6, min: 1, max: 3 },
      { item: "pipe", chance: 0.28 },
      { item: "crowbar", chance: 0.22 },
    ],
  },
  gas_station: {
    shelf: [
      { item: "scrap", chance: 0.65, min: 1, max: 3 },
      { item: "pipe", chance: 0.3 },
      { item: "crowbar", chance: 0.26 },
      { item: "hammer", chance: 0.24 },
      { item: "battery", chance: 0.35 },
    ],
    counter: [
      { item: "battery", chance: 0.4 },
      { item: "bat", chance: 0.22 },
      { item: "knife", chance: 0.2 },
    ],
    fridge: [{ item: "chem", chance: 0.4 }],
  },
  diner: {
    counter: [
      { item: "knife", chance: 0.48 },
      { item: "machete", chance: 0.18 },
      { item: "chem", chance: 0.5, min: 1, max: 2 },
      { item: "scrap", chance: 0.3, min: 1, max: 2 },
    ],
    shelf: [
      { item: "knife", chance: 0.35 },
      { item: "pipe", chance: 0.2 },
      { item: "chem", chance: 0.45, min: 1, max: 2 },
    ],
    fridge: [{ item: "chem", chance: 0.45, min: 1, max: 2 }],
  },
  grocery: {
    counter: [
      { item: "knife", chance: 0.42 },
      { item: "machete", chance: 0.16 },
      { item: "chem", chance: 0.55, min: 1, max: 2 },
    ],
    shelf: [
      { item: "chem", chance: 0.6, min: 1, max: 3 },
      { item: "knife", chance: 0.28 },
      { item: "bat", chance: 0.16 },
      { item: "battery", chance: 0.3 },
    ],
    fridge: [{ item: "chem", chance: 0.45, min: 1, max: 2 }],
  },
  cabin: {
    shelf: [
      { item: "plank", chance: 0.65, min: 1, max: 3 },
      { item: "axe", chance: 0.38 },
      { item: "fire-axe", chance: 0.18 },
      { item: "machete", chance: 0.24 },
      { item: "scrap", chance: 0.45, min: 1, max: 2 },
    ],
    dresser: [
      { item: "ammo", chance: 0.6, min: 3, max: 6 },
      { item: "knife", chance: 0.26 },
      { item: "axe", chance: 0.2 },
      { item: "medkit", chance: 0.25 },
    ],
    counter: [
      { item: "knife", chance: 0.38 },
      { item: "chem", chance: 0.4 },
      { item: "scrap", chance: 0.35 },
    ],
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
export const CONTAINER_SLOTS = 4
/** Chance a container holds an empty bottle or two to throw (D-19 verbs). */
const BOTTLE_CHANCE: Partial<Record<Prop["kind"], number>> = { counter: 0.45, fridge: 0.35, shelf: 0.12 }

/**
 * Road flares and canned food (AR-56), on rolls of their own after everything else, so every container keeps the
 * contents it always had: flares where cars and the police are, food in kitchens and the grocery.
 */
const EXTRA_LOOT: Readonly<Record<string, Partial<Record<Prop["kind"], readonly Roll[]>>>> = {
  house: { shelf: [{ item: "flare", chance: 0.08 }], counter: [{ item: "food", chance: 0.22 }], fridge: [{ item: "food", chance: 0.18 }] },
  garage: { shelf: [{ item: "flare", chance: 0.4, max: 2 }], counter: [{ item: "flare", chance: 0.3 }] },
  gas_station: { shelf: [{ item: "flare", chance: 0.35, max: 2 }, { item: "food", chance: 0.3 }], counter: [{ item: "food", chance: 0.25 }] },
  police: { shelf: [{ item: "flare", chance: 0.4, max: 2 }], counter: [{ item: "flare", chance: 0.25 }] },
  hardware: { shelf: [{ item: "flare", chance: 0.25 }] },
  warehouse: { shelf: [{ item: "flare", chance: 0.2 }] },
  grocery: { shelf: [{ item: "food", chance: 0.5, max: 2 }], counter: [{ item: "food", chance: 0.3 }] },
  diner: { counter: [{ item: "food", chance: 0.35 }], fridge: [{ item: "food", chance: 0.3 }] },
  cabin: { counter: [{ item: "food", chance: 0.3 }], shelf: [{ item: "flare", chance: 0.12 }] },
}

/** Adds the flare and food rolls for a container of `kind` in a `tableKey` building to `contents`, from `rng`. */
export function rollExtraLoot(contents: Stack[], tableKey: string, kind: Prop["kind"], rng: Rng, lootRate: number): void {
  for (const roll of EXTRA_LOOT[tableKey]?.[kind] ?? []) {
    const hit = rng.next() < roll.chance * lootRate
    const n = (roll.min ?? 1) + rng.int((roll.max ?? roll.min ?? 1) - (roll.min ?? 1) + 1)
    if (hit && contents.length < CONTAINER_SLOTS && !contents.some((s) => s.item === roll.item)) contents.push({ item: roll.item, count: n })
  }
}

/**
 * Fire & explosives (`shared/fire/`): rare one-offs on rolls of their own after everything else, with their own
 * random stream, so every container keeps the contents it always had. Gas cans where cars are kept and sold; dynamite
 * in warehouses, cabins and hardware back rooms; firecrackers in drawers and at the gas station till; flare guns at the
 * police station and in cabins; bear traps in cabins; pressure tanks (for a home-made flamethrower) in garages; and a
 * flamethrower itself, very rarely, on a garage or warehouse shelf (and in the hardware store's back room, below).
 * Bolt cutters, for the Way Out's chained gates (`shared/way-out/`), sit on hardware, garage and warehouse shelves.
 */
export const RARE_LOOT: Readonly<Record<string, Partial<Record<Prop["kind"], readonly Roll[]>>>> = {
  house: {
    shelf: [{ item: "fuel", chance: 0.02 }],
    dresser: [{ item: "firecrackers", chance: 0.025 }],
    nightstand: [{ item: "firecrackers", chance: 0.02 }],
  },
  hardware: { shelf: [{ item: "fuel", chance: 0.14 }, { item: "bear-trap", chance: 0.06 }, { item: "dynamite", chance: 0.03 }, { item: "bolt-cutters", chance: 0.1 }] },
  garage: {
    shelf: [{ item: "fuel", chance: 0.3 }, { item: "pressure-tank", chance: 0.06 }, { item: "firecrackers", chance: 0.04 }, { item: "flamethrower", chance: 0.012 }, { item: "bolt-cutters", chance: 0.05 }],
    counter: [{ item: "fuel", chance: 0.15 }, { item: "flare-gun", chance: 0.025 }],
  },
  gas_station: {
    shelf: [{ item: "fuel", chance: 0.35 }, { item: "pressure-tank", chance: 0.05 }],
    counter: [{ item: "firecrackers", chance: 0.12 }, { item: "fuel", chance: 0.15 }, { item: "flare-gun", chance: 0.03 }],
  },
  warehouse: { shelf: [{ item: "fuel", chance: 0.12 }, { item: "dynamite", chance: 0.05 }, { item: "pressure-tank", chance: 0.05 }, { item: "flamethrower", chance: 0.01 }, { item: "bolt-cutters", chance: 0.06 }] },
  police: { shelf: [{ item: "flare-gun", chance: 0.08 }], counter: [{ item: "flare-gun", chance: 0.04 }] },
  grocery: { counter: [{ item: "firecrackers", chance: 0.06 }] },
  cabin: {
    shelf: [{ item: "bear-trap", chance: 0.15 }, { item: "dynamite", chance: 0.06 }, { item: "fuel", chance: 0.1 }],
    dresser: [{ item: "flare-gun", chance: 0.05 }],
  },
}

/** The random stream for a streamed container's rare roll (its own, so the other rolls are untouched). */
export const rareLootRng = (seed: number, propIndex: number) => new Rng((seed ^ Math.imul(propIndex + 977, 0x7f4a7c15) ^ 0x1f3d5b79) >>> 0)

/** Adds the fire & explosives rolls for a container of `kind` in a `tableKey` building to `contents`, from `rng`. */
export function rollRareLoot(contents: Stack[], tableKey: string, kind: Prop["kind"], rng: Rng, lootRate: number): void {
  for (const roll of RARE_LOOT[tableKey]?.[kind] ?? []) {
    const hit = rng.next() < roll.chance * lootRate
    if (hit && contents.length < CONTAINER_SLOTS && !contents.some((s) => s.item === roll.item)) contents.push({ item: roll.item, count: roll.min ?? 1 })
  }
}

/**
 * Bigger bags (AR-94, the Attaché Case): a hiking pack in bedrooms, garages and cabins, a duffel at the police station
 * and on warehouse and garage shelves, on rolls of their own after everything else (their own random stream, so every
 * container keeps the contents it always had). `placeBags` makes sure every town has one of each.
 */
export const BAG_LOOT: Readonly<Record<string, Partial<Record<Prop["kind"], readonly Roll[]>>>> = {
  house: { dresser: [{ item: "hiking-pack", chance: 0.04 }] },
  garage: { shelf: [{ item: "hiking-pack", chance: 0.06 }, { item: "duffel", chance: 0.04 }] },
  hardware: { shelf: [{ item: "hiking-pack", chance: 0.05 }] },
  police: { dresser: [{ item: "duffel", chance: 0.12 }], shelf: [{ item: "duffel", chance: 0.06 }] },
  warehouse: { shelf: [{ item: "duffel", chance: 0.05 }] },
  cabin: { dresser: [{ item: "hiking-pack", chance: 0.2 }] },
}

/** The random stream for a streamed container's bag roll. */
export const bagLootRng = (seed: number, propIndex: number) => new Rng((seed ^ Math.imul(propIndex + 613, 0x2c1b3c6d) ^ 0x4ba65e11) >>> 0)

/** Adds the bag rolls for a container of `kind` in a `tableKey` building to `contents`, from `rng`. */
export function rollBagLoot(contents: Stack[], tableKey: string, kind: Prop["kind"], rng: Rng, lootRate: number): void {
  for (const roll of BAG_LOOT[tableKey]?.[kind] ?? []) {
    const hit = rng.next() < roll.chance * lootRate
    if (hit && contents.length < CONTAINER_SLOTS && !contents.some((s) => s.item === roll.item)) contents.push({ item: roll.item, count: 1 })
  }
}

/** Where a town's sure bags go: a hiking pack in a house dresser, a duffel on a police, garage or warehouse shelf. */
const SURE_BAGS: readonly { item: ItemId; tables: readonly string[]; kinds: readonly Prop["kind"][] }[] = [
  { item: "hiking-pack", tables: ["house", "cabin"], kinds: ["dresser", "nightstand"] },
  { item: "duffel", tables: ["police", "garage", "warehouse", "hardware"], kinds: ["shelf", "dresser", "counter"] },
]

/** Makes sure the town holds at least one of each bigger bag, in a container picked from the seed. */
function placeBags(town: Town, sites: readonly LootSite[], stores: readonly StoreSpec[], tableOf: readonly string[]): void {
  const rng = new Rng((town.seed ^ 0x6a5d39e1) >>> 0)
  for (const sure of SURE_BAGS) {
    if (stores.some((st) => (st.initial as Stack[]).some((s) => s.item === sure.item))) continue
    const pool = sites.map((_, i) => i).filter((i) => sure.tables.includes(tableOf[i]!) && sure.kinds.includes(sites[i]!.kind))
    if (!pool.length) continue
    const slots = stores[pool[rng.int(pool.length)]!]!.initial as Stack[]
    if (slots.length >= CONTAINER_SLOTS) slots.pop()
    slots.push({ item: sure.item, count: 1 })
  }
}

/**
 * The hardware store's keyed back room: always a pressure tank beside the toolbox and the car battery, and in most
 * towns (from the seed) a flamethrower someone left with it.
 */
export function backRoomFire(town: Pick<Town, "seed">, buildingId: string): ItemId[] {
  const rng = new Rng((town.seed ^ 0x51f1a3e7 ^ Math.imul(buildingId.length + 1, 0x2545f491)) >>> 0)
  return rng.next() < BACK_ROOM_FLAMETHROWER ? ["pressure-tank", "flamethrower"] : ["pressure-tank"]
}

/** Share of towns whose hardware back room holds a flamethrower. */
export const BACK_ROOM_FLAMETHROWER = 0.6

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
  searched?: boolean
  ammo?: number
  planks?: number
  /** Loot table to roll instead of the building's archetype (a house's garage shelves roll `garage`). */
  table?: string
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
  const meleeRng = new Rng((town.seed ^ 0x3b9a71d3) >>> 0)
  const bottleRng = new Rng((town.seed ^ 0x6b0771e5) >>> 0)
  const extraRng = new Rng((town.seed ^ 0x2f1a9c53) >>> 0)
  const rareRng = new Rng((town.seed ^ 0x7e3b1d29) >>> 0)
  const bagRng = new Rng((town.seed ^ 0x1d872b41) >>> 0)
  const sites: LootSite[] = []
  const stores: StoreSpec[] = []
  const tables: string[] = []
  const backRoomShelves = new Map<string, number[]>()
  town.props.forEach((p, i) => {
    if (!CONTAINER_KINDS.has(p.kind)) return
    const shape = propShape(p)
    if (!shape) return
    const building = buildingAt(town, p.x, p.y)
    const tableKey = building?.archetype ?? building?.kind ?? "house"
    const table = LOOT_TABLES[tableKey] ?? LOOT_TABLES[building?.kind ?? "house"] ?? LOOT_TABLES.house!
    const contents: Stack[] = []
    for (const roll of table[p.kind] ?? []) {
      const useMeleeRng = isMeleeWeapon(roll.item) && roll.item !== "crowbar"
      const r = useMeleeRng ? meleeRng : rng
      const hit = r.next() < roll.chance * tuning.lootRate
      const n = (roll.min ?? 1) + r.int((roll.max ?? roll.min ?? 1) - (roll.min ?? 1) + 1)
      if (hit && contents.length < CONTAINER_SLOTS) contents.push({ item: roll.item, count: n })
    }
    // Empty bottles on their own roll, so every other container keeps the contents it always had.
    const bottles = BOTTLE_CHANCE[p.kind] ?? 0
    if (bottleRng.next() < bottles * tuning.lootRate && contents.length < CONTAINER_SLOTS) contents.push({ item: "bottle", count: 1 + bottleRng.int(2) })
    rollExtraLoot(contents, tableKey, p.kind, extraRng, tuning.lootRate)
    rollRareLoot(contents, tableKey, p.kind, rareRng, tuning.lootRate)
    rollBagLoot(contents, tableKey, p.kind, bagRng, tuning.lootRate)
    tables.push(tableKey)
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
    // Fire & explosives: the pressure tank (and maybe a flamethrower) on the back room's last shelf.
    const fire = backRoomFire(town, b.id)
    const spec = stores[shelves[shelves.length - 1]!]!
    const slots = spec.initial as Stack[]
    for (const item of fire) {
      if (slots.some((s) => s.item === item)) continue
      if (slots.length >= CONTAINER_SLOTS) slots.pop()
      slots.unshift({ item, count: 1 })
    }
  }
  placeBags(town, sites, stores, tables)
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
