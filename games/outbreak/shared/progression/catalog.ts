import type { ActorStoreTemplate, ItemDef, ItemId } from "@arcade/kit/sim/ledger"
import { MELEE_WEAPON_IDS, MELEE_WEAPONS } from "../combat"
import { BAGS, ITEM_SHAPES, MAX_POUCHES, POUCH, SUPPLY_STACKS } from "./shapes"

/**
 * What Outbreak's ledger holds: the items, the survivor's stores and the recipes.
 *
 * Each survivor has a 5-slot hotbar (bare hands, then weapons, tools and consumables) and the case (AR-94, D-46): one
 * grid, RE4-style, holding everything else (supplies that reloads, barricades and crafting draw on, spare tools and
 * parts), each item at its shape (`shapes.ts`). The case is the bag you wear (`worn`), a row bigger for each pouch.
 */

export const HOTBAR_SIZE = 5

const BASE_ITEMS: readonly ItemDef[] = [
  // Bare hands hold slot 1: selecting them holsters whatever was in hand, and the button shoves. The flashlight is
  // not an item: it is always on the shoulder, toggled with F whatever is held.
  { id: "fists", label: "Fists", shortLabel: "FISTS", tag: "hand", slot: 0, bound: true },
  { id: "pistol", label: "9mm Pistol", shortLabel: "9MM", tag: "gun", slot: 1, unique: true, charge: { max: 8, initial: 6, ammo: "ammo" } },
  ...MELEE_WEAPON_IDS.map((id): ItemDef => {
    const w = MELEE_WEAPONS[id]
    return {
      id: w.id,
      label: w.label,
      shortLabel: w.shortLabel,
      tag: "tool",
      slot: 2,
      activeOnly: true,
      charge: { max: w.durability, initial: w.durability },
      mods: {
        meleeDamage: { add: w.damage },
        meleeReach: { add: w.reach },
        meleeArc: { add: w.arc },
        meleeSpeed: { add: w.speed },
        meleeStamina: { add: w.stamina },
        meleeKnockback: { add: w.knockback },
        meleeDurability: { add: w.durability },
        meleeNoise: { add: w.noise },
        shoveDamage: { add: 5 },
        shoveStagger: { mul: w.knockback },
        shoveRange: { add: Number((w.reach - 1.75).toFixed(2)) },
      },
    }
  }),
  { id: "medkit", label: "First Aid Kit", shortLabel: "MED", tag: "tool", slot: 3, stack: 3 },
  { id: "bandage", label: "Bandage", shortLabel: "BANDAGE", tag: "tool", slot: 3, stack: 3 },
  { id: "noisemaker", label: "Noisemaker", shortLabel: "LURE", tag: "tool", slot: 4, stack: 3 },
  { id: "bottle", label: "Bottle", shortLabel: "BOTTLE", tag: "tool", slot: 4, stack: 3, discovers: ["seen:bottle"] },
  { id: "cans", label: "Can Tripwire", shortLabel: "CANS", tag: "tool", slot: 4, stack: 2 },
  { id: "flare", label: "Road Flare", shortLabel: "FLARE", tag: "tool", slot: 4, stack: 3 },
  { id: "food", label: "Canned Food", shortLabel: "FOOD", tag: "tool", slot: 3, stack: 3 },
  // Fire & explosives (`shared/fire/`): rare one-offs and the flamethrower, whose charge is its fuel (a gas can refills it).
  { id: "flamethrower", label: "Flamethrower", shortLabel: "FLAMER", tag: "tool", slot: 3, charge: { max: 100, initial: 100 } },
  { id: "dynamite", label: "Dynamite", shortLabel: "TNT", tag: "tool", slot: 4, stack: 2 },
  { id: "firecrackers", label: "Firecrackers", shortLabel: "CRACKERS", tag: "tool", slot: 4, stack: 2 },
  { id: "molotov", label: "Molotov", shortLabel: "MOLOTOV", tag: "tool", slot: 4, stack: 2 },
  { id: "flare-gun", label: "Flare Gun", shortLabel: "FLARE GUN", tag: "tool", slot: 4, charge: { max: 3, initial: 3 } },
  { id: "bear-trap", label: "Bear Trap", shortLabel: "TRAP", tag: "tool", slot: 4, stack: 2 },
  // Throwables (`shared/throwables/`): wound up on the button, thrown on release.
  { id: "baseball", label: "Baseball", shortLabel: "BALL", tag: "tool", slot: 4, stack: 3 },
  { id: "brick", label: "Brick", shortLabel: "BRICK", tag: "tool", slot: 4, stack: 2 },
  { id: "rock", label: "Rock", shortLabel: "ROCK", tag: "tool", slot: 4, stack: 3 },
  { id: "tin-can", label: "Tin Can", shortLabel: "CAN", tag: "tool", slot: 4, stack: 3 },

  { id: "ammo", label: "9mm Ammo", shortLabel: "9mm", tag: "ammo", maxCount: 24 },
  { id: "plank", label: "Wood Plank", shortLabel: "Planks", tag: "resource", maxCount: 6, discovers: ["seen:plank"] },
  { id: "scrap", label: "Scrap & Nails", shortLabel: "Scrap", tag: "resource", maxCount: 10, discovers: ["seen:scrap"] },
  { id: "chem", label: "Cloth & Alcohol", shortLabel: "Chem", tag: "resource", maxCount: 6, discovers: ["seen:chem"] },
  { id: "battery", label: "Battery", shortLabel: "Battery", tag: "resource", maxCount: 3, discovers: ["seen:battery"] },
  { id: "key", label: "Key", shortLabel: "Keys", tag: "key", maxCount: 4 },
  { id: "fuel", label: "Gas Can", shortLabel: "Fuel", tag: "resource", maxCount: 3, discovers: ["seen:fuel"] },

  { id: "toolbox", label: "Hardware Toolbox", shortLabel: "Toolbox", tag: "part" },
  { id: "car-battery", label: "Car Battery", shortLabel: "Car battery", tag: "part", slots: 2 },
  { id: "pressure-tank", label: "Pressure Tank", shortLabel: "Tank", tag: "part" },
  // The Way Out (`shared/way-out/`): cuts the chain on a gate across the route.
  { id: "bolt-cutters", label: "Bolt Cutters", shortLabel: "Cutters", tag: "part" },

  { id: "seen:plank", label: "Planks", tag: "knowledge" },
  { id: "seen:scrap", label: "Scrap", tag: "knowledge" },
  { id: "seen:chem", label: "Chem", tag: "knowledge" },
  { id: "seen:battery", label: "Batteries", tag: "knowledge" },
  { id: "seen:bottle", label: "Bottles", tag: "knowledge" },
  { id: "seen:fuel", label: "Fuel", tag: "knowledge" },
  { id: "learned:bandage", label: "Bandage", tag: "knowledge" },
  { id: "learned:lure", label: "Noisemaker", tag: "knowledge" },
  { id: "learned:spiked-board", label: "Spiked Board", tag: "knowledge" },
  { id: "learned:reinforced", label: "Reinforced Barricade", tag: "knowledge" },
  { id: "learned:battery", label: "Flashlight Battery", tag: "knowledge" },
  { id: "learned:tripwire", label: "Can Tripwire", tag: "knowledge" },
  { id: "learned:molotov", label: "Molotov", tag: "knowledge" },
  { id: "learned:flamethrower", label: "Flamethrower", tag: "knowledge" },
  { id: "learned:pouch", label: "Pouch", tag: "knowledge" },

  // Bags you wear (`worn`): the biggest sets the case's size; each pouch adds a row.
  ...BAGS.map((b): ItemDef => ({ id: b.id, label: b.label, shortLabel: b.label, tag: "bag" })),
  { id: POUCH, label: "Pouch", shortLabel: "Pouch", tag: "bag" },
]

/** Every item, with its shape in the case and (for supplies) how many share a stack there. */
export const ITEMS: readonly ItemDef[] = BASE_ITEMS.map((d) => {
  const grid = ITEM_SHAPES[d.id]
  const stack = SUPPLY_STACKS[d.id]
  return { ...d, ...(grid ? { grid } : {}), ...(stack ? { stack } : {}) }
})

/** Belt order, as shown in the HUD. */
export const BELT_ITEMS = ["ammo", "plank", "scrap", "chem", "battery", "fuel", "key"] as const
export const MATERIALS = ["plank", "scrap", "chem", "battery"] as const

/** The case a survivor starts with: a school backpack (`shapes.ts` BAGS). */
export const START_CASE = { cols: BAGS[0]!.cols, rows: BAGS[0]!.rows }

export const ACTOR_STORES: readonly ActorStoreTemplate[] = [
  { suffix: "hotbar", mode: "slots", size: HOTBAR_SIZE, accepts: ["hand", "gun", "tool"], preferSlots: true },
  { suffix: "pack", mode: "slots", grid: START_CASE, accepts: ["part", "tool", "gun", "ammo", "resource", "key"], depositable: true },
  { suffix: "worn", mode: "counters", accepts: ["bag"], caps: { ...Object.fromEntries(BAGS.map((b) => [b.id, 1])), [POUCH]: MAX_POUCHES } },
]

export type Recipe = {
  id: string
  label: string
  /** What crafting it makes; passive recipes change an action instead. */
  produces?: ItemId
  /** What it does, for docs and the Lab; players learn it by using the thing. */
  note: string
  /**
   * The two materials its sketch shows. Picking each up fills the recipe in on the bench board (D-39); none for what
   * can only be learned another way (taking a tripwire apart).
   */
  sketch?: readonly [ItemId, ItemId]
  /** A bench part it waits on: it fills in once one is installed, and is made at a bench that has it. */
  part?: ItemId
  /** Made only at a workbench (from your belt and the bench's stock). */
  bench?: boolean
  /** Crafting cost once learned. */
  craft?: Readonly<Record<ItemId, number>>
}

export const RECIPES: readonly Recipe[] = [
  { id: "bandage", label: "Bandage", produces: "bandage", note: "Heals 25 in a second", sketch: ["chem", "chem"], craft: { chem: 1 } },
  { id: "lure", label: "Noisemaker", produces: "noisemaker", note: "Throw it; the dead go to the noise", sketch: ["scrap", "battery"], craft: { scrap: 1, battery: 1 } },
  { id: "spiked-board", label: "Spiked Board", produces: "spiked-board", note: "Wider, harder shoves", sketch: ["plank", "scrap"], bench: true, craft: { plank: 1, scrap: 2 } },
  { id: "reinforced", label: "Reinforced Barricade", note: "Each board takes a scrap and holds 80% longer", sketch: ["scrap", "scrap"], part: "toolbox" },
  { id: "battery", label: "Flashlight Battery", produces: "battery", note: "A full charge for the flashlight, charged off the generator", sketch: ["scrap", "chem"], part: "car-battery", bench: true, craft: { scrap: 1, chem: 1 } },
  { id: "tripwire", label: "Can Tripwire", produces: "cans", note: "Strung across a doorway, it rattles when something walks through. Learned by disarming one", craft: { scrap: 2 } },
  { id: "molotov", label: "Molotov", produces: "molotov", note: "A bottle with a burning rag: it bursts into a pool of fire where it lands", sketch: ["bottle", "chem"], craft: { bottle: 1, chem: 1 } },
  {
    id: "pouch",
    label: "Pouch",
    produces: POUCH,
    note: "Sewn onto your bag at a workbench: one more row in the case (two at most)",
    sketch: ["chem", "scrap"],
    bench: true,
    craft: { chem: 2, scrap: 2 },
  },
  {
    id: "flamethrower",
    label: "Flamethrower",
    produces: "flamethrower",
    note: "A pressure tank, a gas can and scrap pipe make a flamethrower, made at a bench with the tank installed",
    sketch: ["fuel", "scrap"],
    part: "pressure-tank",
    bench: true,
    craft: { "pressure-tank": 1, fuel: 1, scrap: 3 },
  },
]

/** The ledger catalog. */
export const CATALOG: readonly ItemDef[] = ITEMS
