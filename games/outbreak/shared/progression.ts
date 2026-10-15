import { angleDiff, clearLine, distToRect, raycast, type Rect } from "@arcade/kit/sim/geom"
import {
  Ledger,
  type ActorStoreTemplate,
  type ItemDef,
  type ItemId,
  type LedgerEnv,
  type LedgerEvent,
  type LedgerSnapshot,
  type Rule,
  type Stack,
  type StoreSpec,
  type StoreState,
  type Tx,
} from "@arcade/kit/sim/ledger"
import { Rng } from "@arcade/kit/sim/rng"
import type { OutbreakAISubsystem } from "./ai"
import {
  isMeleeWeapon,
  MELEE_WEAPON_IDS,
  MELEE_WEAPONS,
  type MeleeDurabilityHandle,
  type MeleeWeaponId,
} from "./combat"
import { dayCycle } from "./day-cycle"
import {
  ALL_PAIRS,
  benchOfMat,
  judgeMat,
  MAT_SLOTS,
  matStoreId,
  nextPair,
  pairCost,
  pairIndex,
  pinStoreId,
  ideaToken,
  tinkerKnowledgeItems,
  TINKER_MATERIALS,
  triedToken,
  type TinkerOutcome,
} from "./discovery/tinker"
import { HELD_OUT_PLANKS, heldOutWindow, looksReinforced, pageSite, practiceFactor, PIN_FOUND, type PageSite } from "./discovery/found"
import {
  carSites,
  carStoreId,
  closetSites,
  crossing,
  ds,
  hideStoreId,
  nearestPortal,
  portalCentre,
  portals,
  trappedDoors,
  tripLine,
  tripStoreId,
  type CarSite,
  type ClosetSite,
  type Portal,
} from "./discovery/verbs"
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
 * house has a workbench and a stash sharing one store: installing parts raises the bench tier, and two materials
 * tried together on the bench mat in good light can make something, which teaches it to the whole squad, who can
 * then craft it anywhere (`shared/discovery/tinker.ts`).
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
  { id: "bottle", label: "Bottle", shortLabel: "BOTTLE", tag: "tool", slot: 4, stack: 3 },
  { id: "cans", label: "Can Tripwire", shortLabel: "CANS", tag: "tool", slot: 4, stack: 2 },

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
  { id: "learned:tripwire", label: "Can Tripwire", tag: "knowledge" },
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
  /** What it does, for docs and the Lab; players learn it by using the thing. */
  note: string
  /** Bench tier it assembles at (2 needs the toolbox installed). */
  tier: 1 | 2
  /** The two materials that make it on the bench mat; none for what can only be learned by taking one apart. */
  tinker?: readonly [ItemId, ItemId]
  /** Field-craft cost once learned. */
  craft?: Readonly<Record<ItemId, number>>
}

export const RECIPES: readonly Recipe[] = [
  { id: "bandage", label: "Bandage", produces: "bandage", note: "Heals 25 in a second", tier: 1, tinker: ["chem", "chem"], craft: { chem: 1 } },
  { id: "lure", label: "Noisemaker", produces: "noisemaker", note: "Throw it; the dead go to the noise", tier: 1, tinker: ["scrap", "battery"], craft: { scrap: 1, battery: 1 } },
  { id: "spiked-board", label: "Spiked Board", produces: "spiked-board", note: "Wider, harder shoves", tier: 1, tinker: ["plank", "scrap"], craft: { plank: 1, scrap: 2 } },
  { id: "reinforced", label: "Reinforced Barricade", note: "Each board takes a scrap and holds 80% longer", tier: 2, tinker: ["scrap", "scrap"] },
  { id: "battery", label: "Flashlight Battery", produces: "battery", note: "A full charge for the flashlight", tier: 2, tinker: ["scrap", "chem"], craft: { scrap: 1, chem: 1 } },
  { id: "tripwire", label: "Can Tripwire", produces: "cans", note: "Strung across a doorway, it rattles when something walks through. Learned by disarming one", tier: 1, craft: { scrap: 2 } },
]

/** The ledger catalog: items plus the corkboard's ideas and crossed-out tries. */
export const CATALOG: readonly ItemDef[] = [...ITEMS, ...tinkerKnowledgeItems(RECIPES)]

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
  /** How long trying two materials together on the bench mat takes (the key predates tinkering). */
  researchTime: number
  /** Light needed at the bench to tinker (daylight, the generator or flashlights). */
  researchLight: number
  /** How far a failed try clatters. */
  clatterNoise: number
  /** Board-up time once fully practised, as a share of the first boards' (practice: ten boards nailed). */
  practiceTimeFloor: number
  /** Board-up noise once fully practised, as a share of the first boards'. */
  practiceNoiseFloor: number
  /** How close, in clear sight, a teammate picks up practice by watching someone board up. */
  watchRange: number
  /** Practice a watcher gains per board they see nailed (the nailer gains 1). */
  watchShare: number
  /** Seconds of looking closely at a reinforced barricade to see how it was done. */
  studyTime: number
  /** Walking speed while crouched, as a share of walking. */
  crouchSpeed: number
  /** How far a crouched survivor's footsteps carry. */
  crouchNoise: number
  /** How much of a crouched survivor the dead can see, as a share of a standing one. */
  crouchVisibility: number
  /** Seconds to re-nail a damaged barricade with a crowbar. */
  repairTime: number
  /** How far re-nailing carries. */
  repairNoise: number
  /** How far a bottle can be thrown. */
  bottleRange: number
  /** How far a bottle breaking carries. */
  bottleNoise: number
  /** Seconds to string a can tripwire across a doorway. */
  tripSetTime: number
  /** Seconds to take a can tripwire down without it rattling. */
  tripDisarmTime: number
  /** How far a sprung tripwire's rattle carries. */
  tripNoise: number
  /** How far a car alarm carries. */
  alarmNoise: number
  /** Seconds a car alarm wails before its battery gives out. */
  alarmTime: number
  /** Multiplies every field-craft cost (rounded, at least 1). */
  costScale: number
  pryTime: number
  pryNoise: number
  lureNoise: number
  lureSeconds: number
  generatorNoise: number
}

/** Lab controls for every progression tunable (bound to the shared LabPanel by `src/progression-lab.ts`). */
export const progressionControls = [
  { key: "lootRate", label: "Loot rate", group: "Progression", min: 0, max: 2.5, step: 0.05, unit: "×" },
  { key: "searchQuietTime", label: "Quiet search time", group: "Progression", min: 0.2, max: 4, step: 0.05, unit: "s" },
  { key: "searchQuietNoise", label: "Quiet search noise", group: "Progression", min: 0, max: 20, step: 0.5, unit: "m" },
  { key: "searchSmashTime", label: "Smash time", group: "Progression", min: 0.1, max: 2, step: 0.05, unit: "s" },
  { key: "searchSmashNoise", label: "Smash noise", group: "Progression", min: 2, max: 40, step: 1, unit: "m" },
  { key: "barricadeTime", label: "Board-up time", group: "Progression", min: 0.2, max: 3, step: 0.05, unit: "s" },
  { key: "barricadeNoise", label: "Board-up noise", group: "Progression", min: 0, max: 30, step: 0.5, unit: "m" },
  { key: "reinforcedPlankHp", label: "Reinforced plank HP", group: "Progression", min: 100, max: 400, step: 10, unit: "HP" },
  { key: "healTime", label: "Medkit time", group: "Progression", min: 0.3, max: 5, step: 0.1, unit: "s" },
  { key: "medkitHeal", label: "Medkit heal", group: "Progression", min: 5, max: 100, step: 5, unit: "HP" },
  { key: "bandageHeal", label: "Bandage heal", group: "Progression", min: 5, max: 100, step: 5, unit: "HP" },
  { key: "craftTime", label: "Field craft time", group: "Progression", min: 0.2, max: 6, step: 0.1, unit: "s" },
  { key: "researchTime", label: "Tinker time", group: "Progression", min: 0.2, max: 10, step: 0.1, unit: "s" },
  { key: "researchLight", label: "Light needed to tinker", group: "Progression", min: 0, max: 1.2, step: 0.05, unit: "" },
  { key: "clatterNoise", label: "Failed tinker clatter", group: "Progression", min: 0, max: 20, step: 0.5, unit: "m" },
  { key: "practiceTimeFloor", label: "Practised board-up time", group: "Progression", min: 0.2, max: 1, step: 0.05, unit: "×" },
  { key: "practiceNoiseFloor", label: "Practised board-up noise", group: "Progression", min: 0.2, max: 1, step: 0.05, unit: "×" },
  { key: "watchRange", label: "Learn by watching within", group: "Progression", min: 0, max: 20, step: 0.5, unit: "m" },
  { key: "watchShare", label: "Practice from watching", group: "Progression", min: 0, max: 1, step: 0.05, unit: "×" },
  { key: "studyTime", label: "Study a reinforced barricade", group: "Progression", min: 0.2, max: 6, step: 0.1, unit: "s" },
  { key: "crouchSpeed", label: "Crouched speed", group: "Verbs", min: 0.2, max: 1, step: 0.05, unit: "×" },
  { key: "crouchNoise", label: "Crouched footsteps", group: "Verbs", min: 0, max: 6, step: 0.1, unit: "m" },
  { key: "crouchVisibility", label: "Crouched visibility", group: "Verbs", min: 0.1, max: 1, step: 0.05, unit: "×" },
  { key: "repairTime", label: "Re-nail time", group: "Verbs", min: 0.2, max: 5, step: 0.1, unit: "s" },
  { key: "repairNoise", label: "Re-nail noise", group: "Verbs", min: 0, max: 20, step: 0.5, unit: "m" },
  { key: "bottleRange", label: "Bottle throw", group: "Verbs", min: 2, max: 20, step: 0.5, unit: "m" },
  { key: "bottleNoise", label: "Bottle breaking", group: "Verbs", min: 0, max: 30, step: 0.5, unit: "m" },
  { key: "tripSetTime", label: "String a tripwire", group: "Verbs", min: 0.2, max: 5, step: 0.1, unit: "s" },
  { key: "tripDisarmTime", label: "Disarm a tripwire", group: "Verbs", min: 0.2, max: 5, step: 0.1, unit: "s" },
  { key: "tripNoise", label: "Tripwire rattle", group: "Verbs", min: 0, max: 30, step: 0.5, unit: "m" },
  { key: "alarmNoise", label: "Car alarm", group: "Verbs", min: 0, max: 50, step: 1, unit: "m" },
  { key: "alarmTime", label: "Car alarm length", group: "Verbs", min: 2, max: 60, step: 1, unit: "s" },
  { key: "costScale", label: "Field-craft cost", group: "Progression", min: 0.25, max: 3, step: 0.25, unit: "×" },
  { key: "pryTime", label: "Pry time", group: "Progression", min: 0.2, max: 4, step: 0.1, unit: "s" },
  { key: "pryNoise", label: "Pry noise", group: "Progression", min: 0, max: 30, step: 0.5, unit: "m" },
  { key: "lureNoise", label: "Noisemaker radius", group: "Progression", min: 5, max: 60, step: 1, unit: "m" },
  { key: "lureSeconds", label: "Noisemaker duration", group: "Progression", min: 1, max: 30, step: 0.5, unit: "s" },
  { key: "generatorNoise", label: "Generator hum", group: "Progression", min: 0, max: 40, step: 1, unit: "m" },
] as const satisfies readonly { key: keyof ProgressionTuning; label: string; group: string; min: number; max: number; step: number; unit: string }[]

export const DEFAULT_PROGRESSION_TUNING: ProgressionTuning = {
  // D-22 Balanced Curve (was 1 before D-22).
  lootRate: 1.05,
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
  clatterNoise: 6,
  practiceTimeFloor: 0.6,
  practiceNoiseFloor: 0.63,
  watchRange: 8,
  watchShare: 0.5,
  studyTime: 1.5,
  crouchSpeed: 0.5,
  crouchNoise: 1.2,
  crouchVisibility: 0.55,
  repairTime: 1.6,
  repairNoise: 6,
  bottleRange: 12,
  bottleNoise: 15,
  tripSetTime: 1.2,
  tripDisarmTime: 1.8,
  tripNoise: 13,
  alarmNoise: 30,
  alarmTime: 20,
  costScale: 1,
  pryTime: 1.2,
  pryNoise: 12,
  lureNoise: 30,
  lureSeconds: 8,
  generatorNoise: 18,
}

/** The progression tunables in `src` (a Lab settings object may hold many other keys), over `base`. */
export function pickProgressionTuning(src: object, base: ProgressionTuning = DEFAULT_PROGRESSION_TUNING): ProgressionTuning {
  const out = { ...base }
  const from = src as Record<string, unknown>
  for (const key of Object.keys(out) as (keyof ProgressionTuning)[]) if (typeof from[key] === "number") out[key] = from[key] as number
  return out
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
    { id: "throw:bottle", label: "Throw", consume: { bottle: 1 } },
    { id: "set:tripwire", label: "Stringing cans", duration: t.tripSetTime, consume: { cans: 1 } },
    { id: "disarm:tripwire", label: "Disarming", duration: t.tripDisarmTime },
    { id: "arm:tripwire", label: "Stringing cans", duration: t.tripSetTime },
    { id: "repair", label: "Re-nailing", duration: t.repairTime, noise: t.repairNoise, requires: { crowbar: 1 } },
    { id: "swap:battery", label: "Fresh battery", consume: { battery: 1 } },
    { id: "unlock", label: "Unlocking", consume: { key: 1 } },
    { id: "pry", label: "Prying the door", duration: t.pryTime, noise: t.pryNoise, requires: { crowbar: 1 } },
  ]
  // Tinkering at the bench mat. The game picks the rule from what is on the mat (`judgeMat`), so a rule's cost is
  // always exactly the mat's two materials; the label never gives the outcome away.
  const tinker = { label: "Tinkering", duration: t.researchTime, station: "mat", lightMin: t.researchLight } as const
  rules.push({ id: "tinker:clatter", ...tinker })
  for (const r of RECIPES) {
    if (r.tinker) {
      rules.push({ id: `tinker:${r.id}`, ...tinker, consume: pairCost(r.tinker), produce: { [`learned:${r.id}`]: 1 }, produceTo: "team/known" })
      rules.push({ id: `tinker:idea:${r.id}`, ...tinker, produce: { [ideaToken(r.id)]: 1 }, produceTo: "team/known" })
    }
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

const tinkerRule = (o: TinkerOutcome) =>
  o.kind === "assemble" ? `tinker:${o.recipe}` : o.kind === "almost" ? `tinker:idea:${o.recipe}` : "tinker:clatter"

// ── World sites ─────────────────────────────────────────────────────────────────────────────────────────────────

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
const CONTAINER_SLOTS = 4
/** Chance a container holds an empty bottle or two to throw (D-19 verbs). */
const BOTTLE_CHANCE: Partial<Record<Prop["kind"], number>> = { counter: 0.45, fridge: 0.35, shelf: 0.12 }

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
  const sites: LootSite[] = []
  const stores: StoreSpec[] = []
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

export type ChannelView = { kind: string; targetId: string; label: string; x: number; y: number; elapsed: number; duration: number }

export type ProgressionSlot = { id: string; index: number; survivor: ProgressionActor; notices: Notice[] }

export type WorldContext = { town: Town; ai: OutbreakAISubsystem; time: number; hour: number; slots: readonly ProgressionSlot[] }

/** A survivor looking closely at a reinforced barricade: which, for how long, and where they stood last tick. */
export type Study = { portal: string; t: number; x: number; y: number }

/** Selected-item behaviour on the primary button. */
export type HeldUse = "fire" | "melee" | "shove" | "heal" | "throw" | "set"

const CHANNEL_SLACK = 0.65
const DROP_RANGE = 1.6
const PAGE_RANGE = 1.4
/** How far smashing a car window carries. */
const CAR_GLASS_NOISE = 9
/** How near a car a bottle must break to jolt it (and its alarm). */
const CAR_JOLT_RANGE = 2.5
/** How near a car a gunshot must be to set its alarm off. */
const CAR_SHOT_RANGE = 4
/** Seconds between a car alarm's wails. */
const ALARM_BEAT = 1.2
/** How near a tripwire's line, either side, a footfall must land to catch it. */
const TRIP_STRIDE = 0.25
/** Seconds broken glass lies before it is swept from the world. */
const GLASS_SECONDS = 90
/** How square on, in radians, a survivor must face a reinforced barricade to study it. */
const STUDY_CONE = 0.6
/** Movement, in metres per second, under which a survivor counts as standing still to study. */
const STUDY_STILL = 0.4
/** How close, in metres, a survivor must stand to a reinforced barricade to study it. */
const STUDY_RANGE = 2.2
/** How far off their aim, in radians, a teammate can be and still be watching someone work. */
const WATCH_CONE = 1.3
const PING_SECONDS = 6
const BUNDLE = { ammo: 6, plank: 2 } as const
const LURE_RANGE = 11
/** Light at a bench: one flashlight plus the room lamp clears the research threshold at night; the generator alone does. */
const BENCH_LIGHT_FLASHLIGHT = 0.2
const BENCH_LIGHT_LAMP = 0.2
const GENERATOR_LIGHT = 0.8

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

export class OutbreakProgression {
  readonly ledger: Ledger
  readonly containers: LootSite[]
  readonly benches: BenchSite[]
  readonly pings: Ping[] = []
  readonly lures: Lure[] = []
  tuning: ProgressionTuning
  private nextId = 1
  private generatorAt = new Map<string, number>()
  /** The world as of the last command or tick, for interactions that need light (tinkering). */
  private world: WorldContext | undefined
  /** Practice per survivor and skill: boarding up gets faster and quieter, with no bar to show it. */
  mastery: Record<string, Record<string, number>> = {}
  /** Survivors looking closely at a reinforced barricade they could learn from. */
  study: Record<string, Study> = {}
  /** Held-out buildings already boarded up (see `heldOutWindow`). */
  heldOut: string[] = []
  /** Pages left in buildings (flyers, charts, photos), one per building type that has one. */
  readonly pages: PageSite[] = []
  private actorOf = new WeakMap<object, ProgressionSlot>()

  snapshot(): OutbreakProgressionSnapshot {
    return {
      tuning: { ...this.tuning },
      nextId: this.nextId,
      generatorAt: [...this.generatorAt.entries()],
      pings: this.pings.map((p) => ({ ...p })),
      lures: this.lures.map((l) => ({ ...l })),
      searchedContainers: this.containers.map((c) => [c.id, Boolean(c.searched)]),
      ledger: this.ledger.snapshot(),
      mastery: JSON.parse(JSON.stringify(this.mastery)),
      study: JSON.parse(JSON.stringify(this.study)),
      heldOut: [...this.heldOut],
    }
  }

  restore(snap: OutbreakProgressionSnapshot, slots: readonly ProgressionSlot[] = []): void {
    this.tuning = { ...snap.tuning }
    this.ledger.setRules(progressionRules(this.tuning))
    this.nextId = snap.nextId
    this.generatorAt.clear()
    for (const [k, v] of snap.generatorAt) this.generatorAt.set(k, v)
    this.pings.length = 0
    for (const p of snap.pings) this.pings.push({ ...p })
    this.lures.length = 0
    for (const l of snap.lures) this.lures.push({ ...l })
    this.ledger.restore(snap.ledger)
    const searchedMap = new Map(snap.searchedContainers)
    for (const c of this.containers) {
      if (searchedMap.has(c.id)) c.searched = searchedMap.get(c.id)
      const st = this.ledger.store(c.id)
      if (st?.revealed) c.searched = true
    }
    this.mastery = JSON.parse(JSON.stringify(snap.mastery ?? {}))
    this.study = JSON.parse(JSON.stringify(snap.study ?? {}))
    this.heldOut = [...(snap.heldOut ?? [])]
    this.ensureContainerStores()
    this.ensureMatStores()
    for (const slot of slots) {
      this.actorOf.set(slot.survivor, slot)
      this.project(slot)
    }
  }

  constructor(
    readonly town: Town,
    tuning: object = {},
  ) {
    this.tuning = pickProgressionTuning(tuning)
    const loot = lootSites(town, this.tuning)
    this.containers = loot.sites
    this.benches = benchSites(town)
    this.ledger = new Ledger({
      items: CATALOG,
      actorStores: ACTOR_STORES,
      stores: [
        ...loot.stores,
        ...this.benches.map((b): StoreSpec => ({ id: b.id, mode: "counters", scope: "shared", accepts: ["resource", "part", "tool"], at: { x: b.bench.x, y: b.bench.y } })),
      ],
      rules: progressionRules(this.tuning),
      knowledgeStore: "team/known",
    })
    // Nothing is announced: a new material, a lesson or a better bench shows on the bench and its corkboard (D-19).
    this.ensureMatStores()
    this.ensurePageStores()
    this.ensureVerbStores()
  }

  /** The mat on each bench: two slots for materials, and what they make. Created for snapshots that predate it. */
  private ensureMatStores(): void {
    for (const b of this.benches) {
      const id = matStoreId(b.id)
      if (this.ledger.store(id)) continue
      this.ledger.createStore({ id, mode: "slots", scope: "shared", size: MAT_SLOTS, accepts: ["resource", "tool"], at: { x: b.bench.x, y: b.bench.y } })
    }
  }

  /** Applies Lab tuning: recipe costs and times change at once; a new loot rate restocks unsearched containers. */
  setTuning(tuning: object): void {
    const next = pickProgressionTuning(tuning, this.tuning)
    if (JSON.stringify(next) === JSON.stringify(this.tuning)) return
    const restock = next.lootRate !== this.tuning.lootRate
    this.tuning = next
    this.ledger.setRules(progressionRules(next))
    if (restock) this.restock()
  }

  /** Re-rolls every container nobody has searched yet with the current loot rate. */
  restock(): void {
    for (const spec of lootSites(this.town, this.tuning).stores) {
      const st = this.ledger.store(spec.id)
      if (!st || st.revealed) continue
      st.slots = Array.from({ length: st.size }, (_, i) => (spec.initial as readonly (Stack | null)[])[i] ?? null).map((x) => (x ? { ...x } : null))
      st.rev = ++this.ledger.rev
    }
  }

  /**
   * The pages in the buildings now in the world, and a store for each the first time its building appears (a read
   * page is an empty store, so it stays read when its chunk streams out and back).
   */
  ensurePageStores(): void {
    this.pages.length = 0
    for (const b of this.town.buildings) {
      const site = pageSite(this.town, b)
      if (!site) continue
      this.pages.push(site)
      if (!this.ledger.store(site.id)) this.ledger.createStore({ id: site.id, mode: "counters", scope: "shared", at: { x: site.x, y: site.y }, initial: { page: 1 } })
    }
  }

  /** Ensures ledger stores exist for any newly streamed chunk containers and syncs their `searched` flag. */
  ensureContainerStores(): void {
    this.ensurePageStores()
    this.ensureVerbStores()
    for (const c of this.containers) {
      let st = this.ledger.store(c.id)
      if (!st) {
        const initial: Stack[] = []
        if ((c.ammo ?? 0) > 0) initial.push({ item: "ammo", count: c.ammo! })
        if ((c.planks ?? 0) > 0) initial.push({ item: "plank", count: c.planks! })
        const bld = c.buildingId ? this.town.buildings.find((b) => b.id === c.buildingId) : buildingAt(this.town, c.x, c.y)
        const tableKey = bld?.archetype ?? bld?.kind ?? "house"
        const table = LOOT_TABLES[tableKey] ?? LOOT_TABLES[bld?.kind ?? "house"] ?? LOOT_TABLES.house!
        const cRng = new Rng((this.town.seed ^ Math.imul(c.propIndex + 31, 0x9e3779b9)) >>> 0)
        for (const roll of table[c.kind] ?? []) {
          if (initial.length >= CONTAINER_SLOTS) break
          if (initial.some((s) => s.item === roll.item)) continue
          if (cRng.next() < roll.chance * this.tuning.lootRate) {
            const n = (roll.min ?? 1) + cRng.int((roll.max ?? roll.min ?? 1) - (roll.min ?? 1) + 1)
            initial.push({ item: roll.item, count: n })
          }
        }
        st = this.ledger.createStore({
          id: c.id,
          mode: "slots",
          scope: "shared",
          size: CONTAINER_SLOTS,
          revealed: Boolean(c.searched),
          at: { x: c.x, y: c.y },
          initial,
        })
      } else if (c.searched && !st.revealed) {
        st.revealed = true
      } else if (st.revealed) {
        c.searched = true
      }
    }
  }

  addActor(slot: ProgressionSlot): void {
    this.actorOf.set(slot.survivor, slot)
    if (this.ledger.store(`${slot.id}/hotbar`)) return
    this.ledger.addActor(slot.id)
    this.ledger.apply({ kind: "grant", actor: slot.id, item: "flashlight" })
    this.ledger.apply({ kind: "grant", actor: slot.id, item: "pistol" })
    this.ledger.apply({ kind: "grant", actor: slot.id, item: "ammo", count: 6 })
    this.ledger.apply({ kind: "grant", actor: slot.id, item: "plank", count: 2 })
    this.ledger.apply({ kind: "select", actor: slot.id, slot: 1 })
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
    if (isMeleeWeapon(item)) return "melee"
    if (item === "medkit" || item === "bandage") return "heal"
    if (item === "noisemaker" || item === "bottle") return "throw"
    if (item === "cans") return "set"
    return this.ledger.count(`${id}/hotbar`, "pistol") > 0 ? "fire" : "shove"
  }

  /** Returns the currently selected melee weapon id, or null when holding pistol/flashlight/consumable/hands. */
  heldMeleeWeapon(id: string): MeleeWeaponId | null {
    const item = this.selected(id)?.item
    return isMeleeWeapon(item) ? item : null
  }

  /** Handle to inspect and spend durability on the currently held melee weapon in the ledger. */
  melee(id: string): MeleeDurabilityHandle | null {
    const l = this.ledger
    const sel = this.selected(id)
    if (!sel || !isMeleeWeapon(sel.item)) return null
    const weaponId = sel.item
    const def = MELEE_WEAPONS[weaponId]
    return {
      weapon: weaponId,
      get durability() {
        const cur = l.activeItem(id)
        return cur?.item === weaponId ? (cur.charge ?? def.durability) : 0
      },
      maxDurability: def.durability,
      spend: (amount: number) => {
        const stack = l.activeItem(id)
        if (!stack || stack.item !== weaponId) return { remaining: 0, broke: false, low: false }
        const before = stack.charge ?? def.durability
        const lowThresh = Math.max(4, Math.ceil(def.durability * 0.35))
        const next = Math.max(0, before - amount)
        if (next <= 0) {
          const hb = l.store(`${id}/hotbar`)
          if (hb) {
            hb.slots[hb.selected] = null
            hb.rev = ++l.rev
          }
          return { remaining: 0, broke: true, low: false }
        }
        l.apply({ kind: "setCharge", actor: id, item: weaponId, charge: next })
        return { remaining: next, broke: false, low: next <= lowThresh }
      },
    }
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

  /** What lies on a bench's mat, slot by slot (materials, or what they made). */
  mat(benchId: string): Stack[] {
    return this.contents(matStoreId(benchId))
  }

  /** What holding E at this bench would do with what is on its mat now (null until it holds two materials). */
  judge(benchId: string): TinkerOutcome | null {
    return judgeMat(RECIPES, this.mat(benchId).map((s) => s.item), this.tier(benchId), (r) => this.learned(r))
  }

  /** The corkboard: every recipe the squad has, ideas waiting on a better bench, and pairs that came to nothing. */
  corkboard(): { learned: string[]; ideas: string[]; tried: string[] } {
    const known = this.ledger.store("team/known")
    const has = (token: string) => (known?.counts[token] ?? 0) > 0
    return {
      learned: RECIPES.filter((r) => this.learned(r.id)).map((r) => r.id),
      ideas: RECIPES.filter((r) => !this.learned(r.id) && has(ideaToken(r.id))).map((r) => r.id),
      tried: ALL_PAIRS.map(([a, b]) => `${a}+${b}`).filter((p) => has(triedToken(p))),
    }
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
    return [
      this.containerHandler(),
      this.dropHandler(),
      this.benchHandler(),
      this.stashHandler(),
      this.pageHandler(),
      this.closetHandler(),
      this.tripwireHandler(),
      this.carHandler(),
    ]
  }

  private containerHandler(): InteractionHandler {
    return {
      kind: "container",
      candidates: (town, actor) => {
        if (actor.peekingWindowId) return []
        const out: RawInteractCandidate[] = []
        const here = buildingAt(town, actor.x, actor.y)?.id ?? null
        let walls: Rect[] | null = null
        for (const c of this.containers) {
          if (c.buildingId !== here || distToRect(actor.x, actor.y, c.rect) > 1.45) continue
          const nx = Math.max(c.rect[0], Math.min(c.rect[2], actor.x))
          const ny = Math.max(c.rect[1], Math.min(c.rect[3], actor.y))
          walls ??= town.barriers.filter((b) => b.kind === "wall").map((b) => b.rect)
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

  /**
   * The workbench: carrying a part, E installs it. Otherwise E lays two materials on the mat, a pair at a time (each
   * tap swaps in the next pair you can make up), and holding E tries them together. Whatever they make waits on the
   * mat for a tap to take it.
   */
  private benchHandler(): InteractionHandler {
    return {
      kind: "bench",
      candidates: (town, actor) => {
        if (actor.peekingWindowId) return []
        const here = buildingAt(town, actor.x, actor.y)?.id ?? null
        const slot = this.actorOf.get(actor)
        const out: RawInteractCandidate[] = []
        for (const b of this.benches) {
          if (b.buildingId !== here || distToRect(actor.x, actor.y, b.bench.rect) > 1.45) continue
          const mat = this.mat(b.id)
          let primary: InteractAction | null = null
          let secondary: InteractAction | undefined
          if (slot && this.partsOn(slot.id).length) primary = { id: "install", label: "Install" }
          else if (mat.some((s) => !this.isMaterial(s.item))) primary = { id: "take", label: "Take" }
          else if (slot && this.cyclePair(slot.id, b.id) !== this.matPair(b.id)) primary = { id: "place", label: mat.length ? "Swap" : "Lay out" }
          else if (mat.length) primary = { id: "take", label: "Take back" }
          if (this.judge(b.id)) secondary = { id: "tinker", label: "Tinker", hold: true }
          if (!primary && secondary) primary = { id: "take", label: "Take back" }
          if (!primary) continue
          out.push({
            kind: "bench",
            id: b.id,
            label: "Workbench",
            rect: b.bench.rect,
            worldX: b.bench.x,
            worldY: b.bench.y,
            primary,
            secondary,
            actions: secondary ? [primary, secondary] : [primary],
            // A held E tinkers; the tap waits for the release so a hold never swaps the pair first.
            deferPrimary: Boolean(secondary),
          })
        }
        return out
      },
      execute: (_town, actor, targetId, action) => {
        const slot = this.actorOf.get(actor)
        if (!slot || !this.ledger.store(targetId)) return { handled: false }
        if (action === "install") return { handled: this.install(slot, targetId), kind: "bench", targetId, action }
        if (action === "take") return { handled: this.take(slot, matStoreId(targetId)), kind: "bench", targetId, action }
        if (action === "place") return { handled: this.setMat(slot, targetId, this.cyclePair(slot.id, targetId)), kind: "bench", targetId, action }
        if (action === "tinker") return { handled: this.startTinker(slot, targetId), kind: "bench", targetId, action }
        return { handled: false }
      },
    }
  }

  /** A page left in a building: E reads it. A page the squad already knows is still read, and just as gone. */
  private pageHandler(): InteractionHandler {
    return {
      kind: "page",
      candidates: (town, actor) => {
        if (actor.peekingWindowId) return []
        const here = buildingAt(town, actor.x, actor.y)?.id ?? null
        const out: RawInteractCandidate[] = []
        for (const site of this.pages) {
          if (site.buildingId !== here || Math.hypot(actor.x - site.x, actor.y - site.y) > PAGE_RANGE) continue
          if (this.ledger.count(site.id, "page") <= 0) continue
          const primary: InteractAction = { id: "read", label: "Read" }
          const r = 0.2
          out.push({ kind: "page", id: site.id, label: "Page", rect: [site.x - r, site.y - r, site.x + r, site.y + r], worldX: site.x, worldY: site.y, primary, actions: [primary], priority: 3 })
        }
        return out
      },
      execute: (_town, actor, targetId, action) => {
        const slot = this.actorOf.get(actor)
        const site = this.pages.find((p) => p.id === targetId)
        if (!slot || !site || action !== "read" || Math.hypot(actor.x - site.x, actor.y - site.y) > PAGE_RANGE + CHANNEL_SLACK) return { handled: false }
        return { handled: this.readPage(slot, site), kind: "page", targetId, action }
      },
    }
  }

  private readPage(slot: ProgressionSlot, site: PageSite): boolean {
    const res = this.ledger.apply({ kind: "drain", store: site.id, item: "page", actor: slot.id })
    if (!res.ok) return false
    this.learnRecipe(slot, site.recipe, { x: site.x, y: site.y }, PIN_FOUND[site.style])
    return true
  }

  private isMaterial(item: ItemId): boolean {
    return (TINKER_MATERIALS as readonly string[]).includes(item)
  }

  /** Bench parts (toolbox, car battery) the survivor carries. */
  private partsOn(actor: string): ItemId[] {
    return this.contents(`${actor}/pack`)
      .filter((s) => this.ledger.items.get(s.item)?.tag === "part")
      .map((s) => s.item)
  }

  /** The pair on a bench's mat as an index into `ALL_PAIRS`, or -1 when it holds anything else. */
  private matPair(benchId: string): number {
    const mat = this.mat(benchId)
    return mat.length === 0 ? -1 : pairIndex(mat.map((s) => s.item))
  }

  /** The pair a tap of E would lay out next: the following one the survivor can make up with what is on the mat. */
  private cyclePair(actor: string, benchId: string): number {
    const mat = matStoreId(benchId)
    return nextPair(this.matPair(benchId), (item) => this.ledger.count(`${actor}/belt`, item) + this.ledger.count(mat, item))
  }

  /** Puts what is on the mat back on the survivor, then lays out pair `index` (or leaves the mat empty for -1). */
  private setMat(slot: ProgressionSlot, benchId: string, index: number): boolean {
    const mat = matStoreId(benchId)
    if (this.contents(mat).length) {
      const back = this.ledger.apply({ kind: "take", actor: slot.id, from: mat })
      if (!back.ok || this.contents(mat).length) {
        this.feedback(slot, back.events)
        return false
      }
    }
    const pair = ALL_PAIRS[index]
    if (!pair) return true
    const res = this.ledger.apply({ kind: "deposit", actor: slot.id, to: mat, items: pairCost(pair) })
    return res.ok
  }

  private startTinker(slot: ProgressionSlot, benchId: string): boolean {
    const outcome = this.judge(benchId)
    if (!outcome) return false
    const site = this.benches.find((b) => b.id === benchId)!
    const res = this.ledger.start({ kind: "run", actor: slot.id, rule: tinkerRule(outcome), station: matStoreId(benchId), ref: outcome.pair }, this.envFor(slot), { x: site.bench.x, y: site.bench.y })
    this.feedback(slot, res.events)
    return res.ok
  }

  // ── Verbs: closets, tripwires, cars (D-19 slice 4) ────────────────────────────────────────────────────────

  /** Closets in the world (refreshed with the stores as buildings stream in). */
  readonly closets: ClosetSite[] = []
  /** Abandoned cars along the streets, about half with a working alarm. */
  readonly cars: CarSite[] = []

  /** The closet a survivor is hiding in, if any. */
  hiddenIn(actor: string): ClosetSite | null {
    for (const c of this.closets) {
      const st = this.ledger.store(hideStoreId(c.id))
      if (st && st.owner === actor && (st.counts.in ?? 0) > 0) return c
    }
    return null
  }

  /** E at a closet: squeeze in, the doors pulled to; E again to step back out. The flashlight goes off inside. */
  private closetHandler(): InteractionHandler {
    return {
      kind: "closet",
      candidates: (town, actor) => {
        if (actor.peekingWindowId) return []
        const slot = this.actorOf.get(actor)
        const inside = slot ? this.hiddenIn(slot.id) : null
        const here = buildingAt(town, actor.x, actor.y)?.id ?? null
        const out: RawInteractCandidate[] = []
        for (const c of this.closets) {
          if (inside ? inside.id !== c.id : distToRect(actor.x, actor.y, c.rect) > 1.2 || buildingAt(town, c.x, c.y)?.id !== here) continue
          if (!inside && this.ledger.store(hideStoreId(c.id))) continue
          const primary: InteractAction = { id: "hide", label: inside ? "Leave" : "Hide" }
          out.push({ kind: "closet", id: c.id, label: "Closet", rect: c.rect, worldX: c.x, worldY: c.y, primary, actions: [primary], priority: inside ? 10 : 0 })
        }
        return out
      },
      execute: (_town, actor, targetId, action) => {
        const slot = this.actorOf.get(actor)
        const c = this.closets.find((x) => x.id === targetId)
        if (!slot || !c || action !== "hide") return { handled: false }
        return { handled: this.toggleHide(slot, c), kind: "closet", targetId, action }
      },
    }
  }

  /** Steps a hidden survivor back out of their closet. */
  leaveHiding(slot: ProgressionSlot): boolean {
    const c = this.hiddenIn(slot.id)
    return c ? this.toggleHide(slot, c) : false
  }

  private toggleHide(slot: ProgressionSlot, c: ClosetSite): boolean {
    const p = slot.survivor
    const id = hideStoreId(c.id)
    const st = this.ledger.store(id)
    if (st) {
      if (st.owner !== slot.id) return false
      this.ledger.deleteStore(id)
      p.x = c.out.x
      p.y = c.out.y
      return true
    }
    if (distToRect(p.x, p.y, c.rect) > INTERACT_RANGE) return false
    this.ledger.cancel(slot.id)
    this.ledger.createStore({ id, mode: "counters", scope: "shared", owner: slot.id, at: { x: c.x, y: c.y }, initial: { in: 1 } })
    p.x = c.x
    p.y = c.y
    p.flashlightOn = false
    return true
  }

  /**
   * Cans strung across a doorway, a stride from it (see `tripLine`). Armed: E takes them down without a rattle (and anyone who
   * does learns how they work). Sprung: E picks the cans up, holding E strings them back.
   */
  private tripwireHandler(): InteractionHandler {
    return {
      kind: "tripwire",
      candidates: (town, actor) => {
        if (actor.peekingWindowId) return []
        const out: RawInteractCandidate[] = []
        for (const p of portals(town)) {
          const st = this.ledger.store(tripStoreId(p.id))
          if (!st || st.counts.down) continue
          const line = tripLine(town, p)
          if (distToRect(actor.x, actor.y, line.rect) > 1.1) continue
          const armed = (st.counts.armed ?? 0) > 0
          const primary: InteractAction = { id: "disarm", label: armed ? "Disarm" : "Take" }
          const secondary: InteractAction | undefined = armed ? undefined : { id: "arm", label: "Re-string", hold: true }
          // The prompt floats a little further from the opening, so it never sits on top of the wire it is about.
          const c = portalCentre(p)
          const off = Math.hypot(line.x - c.x, line.y - c.y) || 1
          out.push({
            kind: "tripwire",
            id: p.id,
            label: "Cans",
            rect: line.rect,
            worldX: line.x + ((line.x - c.x) / off) * 0.8,
            worldY: line.y + ((line.y - c.y) / off) * 0.8,
            primary,
            secondary,
            actions: secondary ? [primary, secondary] : [primary],
            deferPrimary: Boolean(secondary),
          })
        }
        return out
      },
      execute: (town, actor, targetId, action) => {
        const slot = this.actorOf.get(actor)
        const p = portals(town).find((x) => x.id === targetId)
        const st = this.ledger.store(tripStoreId(targetId))
        if (!slot || !p || !st || st.counts.down) return { handled: false }
        const line = tripLine(town, p)
        if (action !== "disarm" && action !== "arm") return { handled: false }
        const armed = (st.counts.armed ?? 0) > 0
        // Taking sprung cans is instant; working an armed line loose, or stringing it again, takes a moment.
        if (action === "disarm" && !armed) {
          this.takeDownTripwire(slot, p, { x: line.x, y: line.y })
          return { handled: true, kind: "tripwire", targetId, action }
        }
        if (action === "arm" && armed) return { handled: false }
        const rule = action === "arm" ? "arm:tripwire" : "disarm:tripwire"
        const res = this.ledger.start({ kind: "run", actor: slot.id, rule, ref: p.id }, this.envFor(slot), { x: line.x, y: line.y })
        this.feedback(slot, res.events)
        return { handled: res.ok, kind: "tripwire", targetId, action }
      },
    }
  }

  private takeDownTripwire(slot: ProgressionSlot, p: Portal, at: { x: number; y: number }): void {
    const st = this.ledger.store(tripStoreId(p.id))
    if (!st) return
    st.counts.armed = 0
    st.counts.down = 1
    st.rev = ++this.ledger.rev
    this.ledger.apply({ kind: "grant", actor: slot.id, item: "cans", count: 1 })
    this.learnRecipe(slot, "tripwire", at, 0)
    this.project(slot)
  }

  /** Strings cans across `p` (a new line, or one that was sprung or taken down). */
  private armTripwire(p: Portal, owner: string | undefined): void {
    const id = tripStoreId(p.id)
    const st = this.ledger.store(id)
    if (st) {
      st.counts.armed = 1
      st.counts.down = 0
      st.rev = ++this.ledger.rev
      return
    }
    const c = { x: (p.rect[0] + p.rect[2]) / 2, y: (p.rect[1] + p.rect[3]) / 2 }
    this.ledger.createStore({ id, mode: "counters", scope: "shared", owner, at: c, initial: { armed: 1, down: 0 } })
  }

  /** Holding the cans, the primary button strings them across the nearest doorway or window. */
  private setTripwire(slot: ProgressionSlot, world: WorldContext): void {
    const p = slot.survivor
    const portal = nearestPortal(world.town, p.x, p.y, INTERACT_RANGE)
    if (!portal) return
    const st = this.ledger.store(tripStoreId(portal.id))
    if (st && !st.counts.down) return
    const line = tripLine(world.town, portal)
    const res = this.ledger.start({ kind: "run", actor: slot.id, rule: "set:tripwire", ref: portal.id }, this.envFor(slot, world), { x: line.x, y: line.y })
    this.feedback(slot, res.events)
  }

  /** E at an abandoned car: put a window in. Some still have an alarm, and it wails until its battery dies. */
  private carHandler(): InteractionHandler {
    return {
      kind: "car",
      candidates: (_town, actor) => {
        if (actor.peekingWindowId) return []
        const out: RawInteractCandidate[] = []
        for (const car of this.cars) {
          if (distToRect(actor.x, actor.y, car.rect) > 1.1) continue
          if (this.ledger.store(carStoreId(car.key))?.counts.smashed) continue
          const primary: InteractAction = { id: "smash", label: "Smash" }
          out.push({ kind: "car", id: car.key, label: "Car", rect: car.rect, worldX: car.x, worldY: car.y, primary, actions: [primary] })
        }
        return out
      },
      execute: (_town, actor, targetId, action) => {
        const car = this.cars.find((c) => c.key === targetId)
        if (!car || action !== "smash" || distToRect(actor.x, actor.y, car.rect) > INTERACT_RANGE) return { handled: false }
        if (this.ledger.store(carStoreId(car.key))?.counts.smashed) return { handled: false }
        this.smashCar(car, this.world?.time ?? 0, true)
        return { handled: true, kind: "car", targetId, action, noise: CAR_GLASS_NOISE, noiseKind: "glass" }
      },
    }
  }

  /** Breaks a car's window (`smash`) or just jolts it; an alarm car starts wailing if it never has. */
  private smashCar(car: CarSite, time: number, smash: boolean): void {
    const id = carStoreId(car.key)
    let st = this.ledger.store(id)
    if (!st) st = this.ledger.createStore({ id, mode: "counters", scope: "shared", at: { x: car.x, y: car.y }, initial: { smashed: 0, alarm: 0 } })
    if (smash) st.counts.smashed = 1
    if (car.alarm && !st.counts.alarm) {
      st.counts.alarm = 1
      st.counts.start = ds(time)
      st.counts.until = ds(time + this.tuning.alarmTime)
    }
    st.rev = ++this.ledger.rev
  }

  /** Whether a car's alarm is wailing at `time`. */
  alarmRinging(car: CarSite, time: number): boolean {
    const st = this.ledger.store(carStoreId(car.key))
    return Boolean(st?.counts.alarm) && ds(time) < (st!.counts.until ?? 0)
  }

  /** Throws the bottle in hand: it breaks where it lands, loud, and can set off a car alarm next to it. */
  private throwBottle(slot: ProgressionSlot, world: WorldContext): void {
    const p = slot.survivor
    const res = this.ledger.apply({ kind: "run", actor: slot.id, rule: "throw:bottle" })
    if (!res.ok) return
    const dx = Math.cos(p.aim)
    const dy = Math.sin(p.aim)
    const range = this.tuning.bottleRange
    const reach = Math.max(0.6, Math.min(range, raycast(p.x, p.y, dx, dy, sightRects(world.town), range)) - 0.3)
    const x = Number((p.x + dx * reach).toFixed(2))
    const y = Number((p.y + dy * reach).toFixed(2))
    world.ai.emitNoise(x, y, this.tuning.bottleNoise, "glass", world.time, slot.id, 1.6)
    this.ledger.createStore({ id: `glass:${this.nextId++}`, mode: "counters", scope: "shared", at: { x, y }, initial: { t: ds(world.time) } })
    for (const car of this.cars) if (distToRect(x, y, car.rect) < CAR_JOLT_RANGE) this.smashCar(car, world.time, false)
    this.project(slot)
  }

  /** The tripwire stores and closet and car lists for whatever is in the world now. */
  ensureVerbStores(): void {
    this.closets.length = 0
    this.closets.push(...closetSites(this.town))
    this.cars.length = 0
    this.cars.push(...carSites(this.town))
    for (const id of trappedDoors(this.town)) {
      const door = this.town.doors.find((d) => d.id === id)!
      if (!this.ledger.store(tripStoreId(id))) this.armTripwire(door, undefined)
    }
  }

  /**
   * Once per tick: tripwires rattle when the dead or an upright survivor walks through (crouch to step over), car
   * alarms wail on a beat until their battery dies (and a gunshot beside one sets it off), and broken glass is swept.
   */
  private stepVerbs(dt: number, world: WorldContext): void {
    for (const p of portals(world.town)) {
      const st = this.ledger.store(tripStoreId(p.id))
      if (!st || !st.counts.armed) continue
      const line = tripLine(world.town, p)
      let sprung = false
      for (const z of world.ai.agents) {
        if (z.state !== "dead" && crossing(line, z.x, z.y, TRIP_STRIDE)) sprung = true
      }
      for (const s of world.slots) {
        const q = s.survivor
        const walking = Math.hypot(q.vx ?? 0, q.vy ?? 0) > 0.3
        if (q.health > 0 && walking && !q.crouching && !this.hiddenIn(s.id) && crossing(line, q.x, q.y, TRIP_STRIDE)) sprung = true
      }
      if (!sprung) continue
      st.counts.armed = 0
      st.rev = ++this.ledger.rev
      world.ai.emitNoise(line.x, line.y, this.tuning.tripNoise, "cans", world.time, "tripwire", 1.3)
    }
    for (const car of this.cars) {
      if (!car.alarm) continue
      const st = this.ledger.store(carStoreId(car.key))
      if (!st?.counts.alarm) {
        const shot = world.ai.noiseBus.events.some((e) => e.kind === "gunshot" && e.time > world.time - 0.5 && distToRect(e.x, e.y, car.rect) < CAR_SHOT_RANGE)
        if (shot) this.smashCar(car, world.time, false)
        continue
      }
      const start = (st.counts.start ?? 0) / 10
      if (ds(world.time) >= (st.counts.until ?? 0)) continue
      const beat = Math.floor((world.time - start) / ALARM_BEAT)
      const prev = Math.floor((world.time - dt - start) / ALARM_BEAT)
      if (world.time - dt < start || beat !== prev) world.ai.emitNoise(car.x, car.y, this.tuning.alarmNoise, "alarm", world.time, "alarm", 2)
    }
    for (const st of [...this.ledger.stores.values()]) {
      if (st.id.startsWith("glass:") && ds(world.time) - (st.counts.t ?? 0) > GLASS_SECONDS * 10) this.ledger.deleteStore(st.id)
    }
  }

  /** Holding a crowbar, B re-nails a damaged barricade within reach; practice makes it faster and quieter. */
  private startRepair(slot: ProgressionSlot, world: WorldContext): number | null {
    const p = slot.survivor
    let best: { id: string; x: number; y: number } | null = null
    let bestD = INTERACT_RANGE
    for (const o of portals(world.town)) {
      const st = world.ai.portalStates.get(o.id)
      if (!st || st.barricadePlanks <= 0 || st.barricadeHp >= st.barricadePlanks * 100 - 1) continue
      const d = distToRect(p.x, p.y, o.rect)
      if (d <= bestD) {
        bestD = d
        best = { id: o.id, x: (o.rect[0] + o.rect[2]) / 2, y: (o.rect[1] + o.rect[3]) / 2 }
      }
    }
    if (!best) return null
    const res = this.ledger.start({ kind: "run", actor: slot.id, rule: "repair", ref: best.id }, this.envFor(slot, world), best)
    this.feedback(slot, res.events)
    if (!res.ok) return 0
    const practice = this.practice(slot.id, "repair")
    const noise = res.noise * practiceFactor(practice, this.tuning.practiceNoiseFloor)
    const ch = this.ledger.channel(slot.id)
    if (ch) {
      ch.duration *= practiceFactor(practice, this.tuning.practiceTimeFloor)
      ch.noise = noise
    }
    return noise
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
    this.world = world
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
      else if (use === "throw") {
        if (this.selected(slot.id)?.item === "bottle") this.throwBottle(slot, world)
        else this.throwLure(slot, world)
      } else if (use === "set") this.setTripwire(slot, world)
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
      this.project(slot)
    }
    this.feedback(slot, res.events)
    return res.ok
  }

  private deposit(slot: ProgressionSlot, benchId: string): boolean {
    const before = this.carried(slot.id)
    const res = this.ledger.apply({ kind: "deposit", actor: slot.id, to: benchId })
    if (!res.ok) {
      this.notify(slot, res.reason === "full" ? "The stash is full" : "Nothing to deposit", "info", "deposit")
      return false
    }
    const moved = this.diffCarried(this.carried(slot.id), before)
    this.notify(slot, moved ? `Deposited ${moved}` : "Deposited", "result", "deposit")
    return true
  }

  /** Sets the parts the survivor carries on the bench. The toolbox on the bench top and the wired generator say the rest. */
  private install(slot: ProgressionSlot, benchId: string): boolean {
    const parts = this.partsOn(slot.id)
    if (!parts.length) return false
    const res = this.ledger.apply({ kind: "deposit", actor: slot.id, to: benchId, items: Object.fromEntries(parts.map((p) => [p, 1])) })
    this.feedback(slot, res.events)
    return res.ok
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
      else this.project(slot)
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
    // At a bench, lay out one particular pair (`ALL_PAIRS` index; -1 clears the mat). Bots use this; players tap E.
    if (target?.kind !== "bench" || pick.index >= ALL_PAIRS.length) return
    this.setMat(slot, target.id, pick.index)
  }

  private startBarricade(slot: ProgressionSlot, world: WorldContext): number {
    const p = slot.survivor
    if (this.selected(slot.id)?.item === "crowbar") {
      const repaired = this.startRepair(slot, world)
      if (repaired !== null) return repaired
    }
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
    if (!res.ok) return 0
    // Practice: hands that have nailed a few boards do it faster and quieter. Nothing on screen says so.
    const practice = this.practice(slot.id, "barricade")
    const ch = this.ledger.channel(slot.id)
    const noise = res.noise * practiceFactor(practice, this.tuning.practiceNoiseFloor)
    if (ch) {
      ch.duration *= practiceFactor(practice, this.tuning.practiceTimeFloor)
      ch.noise = noise
    }
    return noise
  }

  /** Teammates close enough, facing the right way and in clear sight, to pick something up from watching `slot`. */
  private watchers(slot: ProgressionSlot, world: WorldContext): ProgressionSlot[] {
    const p = slot.survivor
    const walls = sightRects(world.town)
    return world.slots.filter((o) => {
      if (o === slot || o.survivor.health <= 0) return false
      const q = o.survivor
      const d = Math.hypot(p.x - q.x, p.y - q.y)
      if (d > this.tuning.watchRange) return false
      if (d > 1 && Math.abs(angleDiff(Math.atan2(p.y - q.y, p.x - q.x), q.aim)) > WATCH_CONE) return false
      return clearLine(q.x, q.y, p.x, p.y, walls)
    })
  }

  /** How practised a survivor is at a skill (boards nailed, plus a share of those watched). */
  practice(actor: string, skill: string): number {
    return this.mastery[actor]?.[skill] ?? 0
  }

  private practise(actor: string, skill: string, amount: number): void {
    const skills = (this.mastery[actor] ??= {})
    skills[skill] = Number(((skills[skill] ?? 0) + amount).toFixed(3))
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
    const reach = Math.max(0.6, Math.min(LURE_RANGE, raycast(p.x, p.y, dx, dy, sightRects(world.town), LURE_RANGE)) - 0.35)
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
    this.world = world
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
    if (this.boardHeldOut(world.town, world.ai)) {
      world.ai.rebuildTopology(world.town)
      topologyChanged = true
    }
    this.stepStudy(dt, world)
    this.stepVerbs(dt, world)
    for (const slot of world.slots) this.project(slot)
    return { topologyChanged }
  }

  /**
   * Boards up each held-out building's window the first time it is in the world: reinforced, two planks. The sim
   * calls this once it is built and the room's step calls it for buildings streamed in later. Returns whether any
   * window was boarded (the caller rebuilds topology).
   */
  boardHeldOut(town: Town, ai: OutbreakAISubsystem): boolean {
    let changed = false
    for (const b of town.buildings) {
      if (this.heldOut.includes(b.id)) continue
      const id = heldOutWindow(town, b)
      if (!id || !ai.portalStates.has(id)) continue
      this.heldOut.push(b.id)
      for (let i = 0; i < HELD_OUT_PLANKS; i++) ai.addBarricadePlank(id, this.tuning.reinforcedPlankHp)
      const win = town.windows.find((w) => w.id === id)
      if (win) win.open = false
      changed = true
    }
    return changed
  }

  /**
   * Learning by looking: a survivor who stands still close to a reinforced barricade, facing it, for `studyTime`
   * works out how it was done. The squad learns it and their sketch goes up on the board.
   */
  private stepStudy(dt: number, world: WorldContext): void {
    if (this.learned("reinforced")) {
      for (const k of Object.keys(this.study)) delete this.study[k]
      return
    }
    for (const slot of world.slots) {
      const p = slot.survivor
      const prev = this.study[slot.id]
      const target = p.health > 0 && !p.channel ? this.studyTarget(p, world) : null
      if (!target) {
        delete this.study[slot.id]
        continue
      }
      const still = prev && prev.portal === target.id && Math.hypot(p.x - prev.x, p.y - prev.y) <= STUDY_STILL * dt + 1e-6
      const t = still ? prev.t + dt : 0
      if (t + 1e-6 >= this.tuning.studyTime) {
        this.learnRecipe(slot, "reinforced", { x: target.x, y: target.y }, 0)
        for (const k of Object.keys(this.study)) delete this.study[k]
        return
      }
      this.study[slot.id] = { portal: target.id, t: Number(t.toFixed(4)), x: p.x, y: p.y }
    }
  }

  /** The reinforced barricade a survivor is close to and squarely facing, if any. */
  private studyTarget(p: ProgressionActor, world: WorldContext): { id: string; x: number; y: number } | null {
    for (const o of [...world.town.doors, ...world.town.windows]) {
      const st = world.ai.portalStates.get(o.id)
      if (!st || !looksReinforced(st.barricadePlanks, st.barricadeHp)) continue
      const x = (o.rect[0] + o.rect[2]) / 2
      const y = (o.rect[1] + o.rect[3]) / 2
      if (distToRect(p.x, p.y, o.rect) > STUDY_RANGE) continue
      if (Math.abs(angleDiff(Math.atan2(y - p.y, x - p.x), p.aim)) > STUDY_CONE) continue
      return { id: o.id, x, y }
    }
    return null
  }

  /** Writes the ledger's view onto the survivor's legacy fields (HUD, wire, combat animation). */
  project(slot: ProgressionSlot): void {
    const p = slot.survivor
    const pistol = this.pistol(slot.id)
    p.magAmmo = pistol.loaded
    p.magCapacity = pistol.capacity || 8
    p.reserveAmmo = pistol.reserve
    p.planks = this.ledger.count(`${slot.id}/belt`, "plank")
    const sel = this.selected(slot.id)
    const wpn = sel && isMeleeWeapon(sel.item) ? sel.item : null
    p.meleeWeapon = wpn
    p.meleeDurability = wpn ? (sel!.charge ?? MELEE_WEAPONS[wpn].durability) : 0
    p.meleeMaxDurability = wpn ? MELEE_WEAPONS[wpn].durability : 0
    p.equippedItem = wpn
      ? wpn
      : this.heldUse(slot.id) === "fire" && sel?.item !== "flashlight"
        ? "pistol"
        : sel?.item === "flashlight" && pistol.capacity
          ? "pistol"
          : "hands"
    const ch = this.ledger.channel(slot.id)
    if (!ch) p.channel = null
    else {
      const ref = ch.tx.kind === "run" ? (ch.tx.ref ?? ch.tx.station ?? "") : ch.tx.kind === "reveal" ? ch.tx.store : ""
      const kind = ch.tx.kind === "reveal" ? "search" : ch.tx.kind === "run" ? ch.tx.rule.split(":")[0]! : ch.tx.kind
      p.channel = { kind, targetId: ref, label: ch.label, x: ch.at?.x ?? p.x, y: ch.at?.y ?? p.y, elapsed: ch.elapsed, duration: ch.duration }
    }
  }

  // ── Effects and feedback ──────────────────────────────────────────────────────────────────────────────────

  private envFor(slot: ProgressionSlot, world: WorldContext | undefined = this.world): LedgerEnv {
    return {
      light: world ? this.lightFor(slot, world) : 1,
      check: (tx) => {
        if (tx.kind !== "run") return null
        // The mat is shared: if someone changed it mid-try, the try comes to nothing.
        if (tx.rule.startsWith("tinker:") && tx.station) {
          const outcome = this.judge(benchOfMat(tx.station))
          if (!outcome || tinkerRule(outcome) !== tx.rule) return "mat changed"
        }
        if (!world) return null
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
     const station = ch?.tx.kind === "run" && ch.tx.station ? (ch.tx.station.startsWith("mat:") ? benchOfMat(ch.tx.station) : ch.tx.station) : undefined
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
      this.practise(slot.id, "barricade", 1)
      for (const other of this.watchers(slot, world)) this.practise(other.id, "barricade", this.tuning.watchShare)
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
    if (ev.rule.startsWith("tinker:") && ev.station) this.tinkered(slot, ev.rule, ev.station, ev.ref ?? "", world)
    if (ev.rule === "repair" && ev.ref) {
      const st = world.ai.portalStates.get(ev.ref)
      if (st && st.barricadePlanks > 0) st.barricadeHp = Math.max(st.barricadeHp, st.barricadePlanks * 100)
      this.practise(slot.id, "repair", 1)
      for (const other of this.watchers(slot, world)) this.practise(other.id, "repair", this.tuning.watchShare)
    }
    if ((ev.rule === "set:tripwire" || ev.rule === "arm:tripwire") && ev.ref) {
      const portal = portals(world.town).find((x) => x.id === ev.ref)
      if (portal) this.armTripwire(portal, slot.id)
    }
    if (ev.rule === "disarm:tripwire" && ev.ref) {
      const portal = portals(world.town).find((x) => x.id === ev.ref)
      if (portal) {
        const line = tripLine(world.town, portal)
        this.takeDownTripwire(slot, portal, { x: line.x, y: line.y })
      }
    }
    return false
  }

  /**
   * A finished try at the mat. Assembling puts the thing on the mat and, the first time, pins the sketch with the
   * maker's seat; a pair that needs the toolbox pins a faint idea (the rule did that); anything else clatters, and the
   * first time a pair fails a crossed-out scrap goes up so nobody tries it twice. No words either way.
   */
  private tinkered(slot: ProgressionSlot, rule: string, mat: string, pair: string, world: WorldContext): void {
    const site = this.benches.find((b) => b.id === benchOfMat(mat))
    const at = site ? { x: site.bench.x, y: site.bench.y } : { x: slot.survivor.x, y: slot.survivor.y }
    if (rule === "tinker:clatter") {
      world.ai.emitNoise(at.x, at.y, this.tuning.clatterNoise, "clatter", world.time, slot.id)
      const token = triedToken(pair)
      if (this.ledger.items.has(token) && this.ledger.count("team/known", token) === 0) {
        this.ledger.apply({ kind: "grant", actor: slot.id, item: token, store: "team/known" })
      }
      return
    }
    if (rule.startsWith("tinker:idea:")) return
    const recipe = RECIPES.find((r) => rule === `tinker:${r.id}`)
    if (!recipe) return
    if (recipe.produces) this.ledger.apply({ kind: "grant", actor: slot.id, item: recipe.produces, store: mat })
    this.pinRecipe(slot, recipe.id, at, 0)
  }

  /**
   * Teaches the squad a recipe they picked up away from the bench (a page, a barricade studied) and pins it: a sketch
   * in the learner's hand, or the page itself (`found`, see `PIN_FOUND`). Returns whether it was new to them.
   */
  private learnRecipe(slot: ProgressionSlot, recipe: string, at: { x: number; y: number }, found: number): boolean {
    if (this.learned(recipe)) return false
    this.ledger.apply({ kind: "grant", actor: slot.id, item: `learned:${recipe}`, store: "team/known" })
    this.pinRecipe(slot, recipe, at, found)
    return true
  }

  private pinRecipe(slot: ProgressionSlot, recipe: string, at: { x: number; y: number }, found: number): void {
    if (this.ledger.store(pinStoreId(recipe))) return
    const initial: Record<string, number> = found ? { seat: slot.index + 1, found } : { seat: slot.index + 1 }
    this.ledger.createStore({ id: pinStoreId(recipe), mode: "counters", scope: "shared", owner: slot.id, at, initial })
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
        return "Too dark"
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
