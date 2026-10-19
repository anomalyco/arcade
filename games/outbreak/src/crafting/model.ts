import { RECIPES, type Recipe } from "../../shared/progression/catalog"
import { LOOT_TABLES } from "../../shared/progression/loot"
import type { OutbreakProgression } from "../../shared/progression"

/**
 * What the crafting HUD reads: one row per recipe that makes something, with what it costs against what the survivor
 * (plus the bench they stand at) has. Costs come from the live ledger rule, so the Lab's cost multiplier shows too.
 */

export type CraftCost = { item: string; need: number; have: number }
export type CraftRow = {
  recipe: Recipe
  learned: boolean
  /** The digit index that crafts it (learned rows only, in `craftable()` order), or -1. */
  index: number
  cost: CraftCost[]
  /** Learned and every cost met. */
  ok: boolean
}

/**
 * The store field craft also draws on here: the bench (or its stash) the survivor faces, as the sim does
 * (`OutbreakProgression.pick`).
 */
export function craftStation(progression: OutbreakProgression, prompt: { kind: string; id: string } | undefined): string | null {
  return prompt && (prompt.kind === "bench" || prompt.kind === "stash") ? progression.storeFor(prompt) : null
}

/** The live cost of crafting `recipe`: the ledger rule's consume, falling back to the catalog. */
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
    return { recipe, learned: isLearned, index: isLearned ? learned.indexOf(recipe) : -1, cost, ok: isLearned && cost.every((c) => c.have >= c.need) }
  })
}

/** How a recipe is learned, in a few words. */
export function learnHint(recipe: Recipe): string {
  if (!recipe.tinker) return recipe.id === "tripwire" ? "Disarm a can tripwire" : "Found, not made"
  return recipe.tier > 1 ? "Workbench with a toolbox" : "Try pairs at a workbench"
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
export type CoachState = { seen: number; learned: string[]; ready: string[]; atBench: boolean }

export type CoachTip =
  /** A new kind of material found and nothing learned yet: point at the workbench. */
  | { kind: "materials" }
  /** At a workbench with materials and nothing learned: how the mat works. */
  | { kind: "bench" }
  /** A recipe was just learned: it can now be made anywhere. */
  | { kind: "learned"; recipe: string }
  /** A pickup just made a learned recipe affordable. */
  | { kind: "ready"; recipe: string }

/** Snapshot of what the coach compares from frame to frame. */
export function coachState(progression: OutbreakProgression, actorId: string, atBench: boolean): CoachState {
  const seen = (["plank", "scrap", "chem", "battery"] as const).filter((m) => progression.seen(m)).length
  const rows = craftRows(progression, actorId, null)
  return {
    seen,
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
    if (!before.learned.includes(id) && recipe?.produces) tips.push({ kind: "learned", recipe: id })
  }
  if (!tips.length) {
    for (const id of now.ready) if (!before.ready.includes(id) && before.learned.includes(id)) tips.push({ kind: "ready", recipe: id })
  }
  if (now.learned.length === 0) {
    if (now.atBench && !before.atBench && now.seen > 0) tips.push({ kind: "bench" })
    if (now.seen > before.seen) tips.push({ kind: "materials" })
  }
  return tips
}
