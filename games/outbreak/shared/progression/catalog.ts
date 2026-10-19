import type { ActorStoreTemplate, ItemDef, ItemId } from "@arcade/kit/sim/ledger"
import { MELEE_WEAPON_IDS, MELEE_WEAPONS } from "../combat"

/**
 * What Outbreak's ledger holds: the items, the survivor's stores and the recipes.
 *
 * Each survivor has a 5-slot hotbar (hand tools, weapons, consumables), a belt of counted supplies (ammo, planks,
 * scrap, chem, batteries, keys) that reloads, barricades and crafting draw on, and a 4-slot pack (parts, spare tools).
 */

export const HOTBAR_SIZE = 5
export const PACK_SIZE = 4

export const ITEMS: readonly ItemDef[] = [
  { id: "flashlight", label: "Flashlight", shortLabel: "LIGHT", tag: "light", slot: 0 },
  { id: "pistol", label: "9mm Pistol", shortLabel: "9MM", tag: "gun", slot: 1, charge: { max: 8, initial: 6, ammo: "ammo" } },
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
]

/** Belt order, as shown in the HUD. */
export const BELT_ITEMS = ["ammo", "plank", "scrap", "chem", "battery", "fuel", "key"] as const
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
