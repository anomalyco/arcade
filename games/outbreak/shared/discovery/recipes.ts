import type { ItemId } from "@arcade/kit/sim/ledger"

/**
 * The recipe board (D-39, Recipe Board): every recipe has a place on the workbench from the start. Picking up a
 * material fills in the recipes it feeds; a recipe that needs a bench part (the toolbox, the generator) fills in once
 * one is installed. Pages, studying and taking things apart still teach recipes early. What the squad knows is
 * ledger state in `team/known`, so it is deterministic, saved, and the same for every player.
 */

/** What a recipe's sketch shows (its two materials), the part it needs, and whether it only gets made at a bench. */
export type BoardRecipe = { id: string; sketch?: readonly [ItemId, ItemId]; part?: ItemId; produces?: ItemId }

/** The materials that fill a recipe in: its sketch's, once each. None for what can only be learned another way. */
export function recipeMaterials(recipe: BoardRecipe): ItemId[] {
  return recipe.sketch ? [...new Set(recipe.sketch)] : []
}

/** Whether the board fills `recipe` in: every material it takes has been picked up and its part (if any) installed. */
export function recipeFillsIn(recipe: BoardRecipe, seen: (material: ItemId) => boolean, installed: (part: ItemId) => boolean): boolean {
  const from = recipeMaterials(recipe)
  return from.length > 0 && from.every(seen) && (!recipe.part || installed(recipe.part))
}

/** Its materials are all picked up but the part it needs is not installed yet: a faint sketch on the corkboard. */
export function recipeWaitsOnPart(recipe: BoardRecipe, seen: (material: ItemId) => boolean, installed: (part: ItemId) => boolean): boolean {
  const from = recipeMaterials(recipe)
  return Boolean(recipe.part) && from.length > 0 && from.every(seen) && !installed(recipe.part!)
}

export const pinStoreId = (recipe: string) => `pin:${recipe}`

/** What pinned a recipe up: a sketch (filled in, or studied), or a page found in a building. */
export const PIN_SOURCES = ["sketch", "flyer", "chart", "photo"] as const
export type PinSource = (typeof PIN_SOURCES)[number]

/**
 * Who first learned a recipe: the pin store's owner and their seat (stored +1 so seat 0 is a count), and whether
 * the pin is a sketch or a page they found (`counts.found`, an index into `PIN_SOURCES`). A recipe the board filled
 * in by itself has no seat (a brass pin).
 */
export type Pin = { recipe: string; actor: string | null; seat: number | null; at: { x: number; y: number } | null; source: PinSource }

export function readPin(store: { owner?: string; counts: Record<string, number>; at?: { x: number; y: number } } | undefined, recipe: string): Pin | null {
  if (!store) return null
  const seat = store.counts.seat
  const source = PIN_SOURCES[store.counts.found ?? 0] ?? "sketch"
  return { recipe, actor: store.owner ?? null, seat: seat ? seat - 1 : null, at: store.at ? { ...store.at } : null, source }
}
