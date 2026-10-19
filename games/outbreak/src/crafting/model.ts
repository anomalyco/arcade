import { recipeMaterials } from "../../shared/discovery/recipes"
import { RECIPES, type Recipe } from "../../shared/progression/catalog"
import { LOOT_TABLES } from "../../shared/progression/loot"
import type { OutbreakProgression } from "../../shared/progression"

/**
 * What the recipe panel reads (D-39): one row per recipe that makes something, with what it costs against what the
 * survivor (plus the bench they stand at) has. Costs come from the live ledger rule, so the Lab's cost multiplier shows.
 */

export type CraftCost = { item: string; need: number; have: number }
export type CraftRow = {
  recipe: Recipe
  learned: boolean
  /** The digit index that makes it (learned rows only, in `craftable()` order), or -1. */
  index: number
  cost: CraftCost[]
  /** What stops a learned row being made here, other than materials: away from a bench, or its part not installed. */
  blocked: "bench" | "part" | null
  /** Learned, makeable here, and every cost met. */
  ok: boolean
}

/** The store crafting also draws on here: the bench (or its stash) the survivor faces, as the sim does. */
export function craftStation(progression: OutbreakProgression, prompt: { kind: string; id: string } | undefined): string | null {
  return prompt && (prompt.kind === "bench" || prompt.kind === "stash") ? progression.storeFor(prompt) : null
}

/** The live cost of making `recipe`: the ledger rule's consume, falling back to the catalog. */
export function craftCost(progression: OutbreakProgression, recipe: Recipe): Readonly<Record<string, number>> {
  return progression.ledger.rules.get(`craft:${recipe.id}`)?.consume ?? recipe.craft ?? {}
}

/** Every recipe that makes something: learned ones first in digit order, then the rest in catalog order. */
export function craftRows(progression: OutbreakProgression, actorId: string, station: string | null): CraftRow[] {
  const ledger = progression.ledger
  const learned = progression.craftable()
  const rest = RECIPES.filter((r) => r.produces && r.craft && !learned.includes(r))
  return [...learned, ...rest].map((recipe) => {
    const isLearned = learned.includes(recipe)
    const cost = Object.entries(craftCost(progression, recipe)).map(([item, need]) => ({
      item,
      need,
      have: ledger.count(actorId, item) + (station ? ledger.count(station, item) : 0),
    }))
    const blocked = recipe.bench && !station ? "bench" : recipe.part && (!station || ledger.count(station, recipe.part) <= 0) ? "part" : null
    return {
      recipe,
      learned: isLearned,
      index: isLearned ? learned.indexOf(recipe) : -1,
      cost,
      blocked,
      ok: isLearned && !blocked && cost.every((c) => c.have >= c.need),
    }
  })
}

const PART_HINT: Record<string, string> = { toolbox: "Install a toolbox", "car-battery": "Wire in the generator", "pressure-tank": "Install a pressure tank" }

/** How a recipe still to find fills in, in a few words: the material not yet picked up, or the part to install. */
export function learnHint(progression: OutbreakProgression, recipe: Recipe): string {
  const from = recipeMaterials(recipe)
  if (!from.length) return recipe.id === "tripwire" ? "Disarm a can tripwire" : "Found, not made"
  const missing = from.filter((m) => !progression.seen(m))
  if (missing.length) return `Pick up ${missing.map((m) => progression.ledger.label(m, true).toLowerCase()).join(" and ")}`
  return recipe.part ? (PART_HINT[recipe.part] ?? "Install a part") : "Fills in at the bench"
}

/** What stops a learned row, in a few words. */
export function blockedHint(row: CraftRow): string {
  if (row.blocked === "bench") return "At a workbench"
  if (row.blocked === "part") return row.recipe.part === "car-battery" ? "At a bench with the generator" : row.recipe.part === "pressure-tank" ? "At a bench with a pressure tank" : "At a bench with a toolbox"
  return ""
}

const BUILDING_NAMES: Record<string, string> = {
  house: "houses",
  hardware: "hardware stores",
  pharmacy: "pharmacies",
  police: "police stations",
  garage: "garages",
  warehouse: "warehouses",
  gas_station: "gas stations",
  diner: "diners",
  grocery: "groceries",
  cabin: "cabins",
}

/** The two kinds of building where `item` turns up most, from the loot tables (e.g. "pharmacies, groceries"). */
export function whereToFind(item: string): string {
  const best = new Map<string, number>()
  for (const [building, props] of Object.entries(LOOT_TABLES)) {
    for (const rolls of Object.values(props)) {
      for (const r of rolls ?? []) {
        if (r.item !== item) continue
        const yieldOf = r.chance * (((r.min ?? 1) + (r.max ?? r.min ?? 1)) / 2)
        best.set(building, Math.max(best.get(building) ?? 0, yieldOf))
      }
    }
  }
  return [...best.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 2)
    .map(([b]) => BUILDING_NAMES[b] ?? b.replace(/_/g, " "))
    .join(", ")
}

/** What the coach knows about the squad between frames. */
export type CoachState = { learned: string[]; ready: string[]; atBench: boolean }

export type CoachTip =
  /** A recipe just filled in on the bench (or was learned from a page): what it is and where it is made. */
  | { kind: "learned"; recipe: string; bench: boolean }
  /** A pickup just made a learned recipe affordable. */
  | { kind: "ready"; recipe: string }
  /** Standing at a workbench: E opens its board. */
  | { kind: "bench" }

/** Snapshot of what the coach compares from frame to frame. */
export function coachState(progression: OutbreakProgression, actorId: string, atBench: boolean): CoachState {
  const rows = craftRows(progression, actorId, null)
  return {
    learned: RECIPES.filter((r) => progression.learned(r.id)).map((r) => r.id),
    ready: rows.filter((r) => r.ok).map((r) => r.recipe.id),
    atBench,
  }
}

/**
 * The tips a change from `before` to `now` earns, most important first. The first observation (`before` null) earns
 * none, so loading a save or joining a room mid-run says nothing.
 */
export function coachTips(before: CoachState | null, now: CoachState): CoachTip[] {
  if (!before) return []
  const tips: CoachTip[] = []
  for (const id of now.learned) {
    const recipe = RECIPES.find((r) => r.id === id)
    if (!before.learned.includes(id) && recipe?.produces) tips.push({ kind: "learned", recipe: id, bench: Boolean(recipe.bench) })
  }
  if (!tips.length) {
    for (const id of now.ready) if (!before.ready.includes(id) && before.learned.includes(id)) tips.push({ kind: "ready", recipe: id })
  }
  if (now.atBench && !before.atBench) tips.push({ kind: "bench" })
  return tips
}
