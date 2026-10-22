import type { ItemId } from "@arcade/kit/sim/ledger"

/**
 * The Attaché Case (AR-94, D-46: Kit's pick). Everything you carry outside your hands lies in one case on grid paper,
 * RE4-style: each item takes its shape (cells across × down, long side across), turns a quarter to fit, and supplies
 * stack within their cells. What you can carry is what fits.
 */
export type Shape = { w: number; h: number }

export const ITEM_SHAPES: Readonly<Record<ItemId, Shape>> = {
  fists: { w: 1, h: 1 },
  pistol: { w: 2, h: 2 },
  knife: { w: 3, h: 1 },
  hammer: { w: 2, h: 1 },
  pipe: { w: 3, h: 1 },
  crowbar: { w: 4, h: 1 },
  machete: { w: 4, h: 1 },
  bat: { w: 4, h: 1 },
  "spiked-board": { w: 4, h: 1 },
  axe: { w: 3, h: 1 },
  "fire-axe": { w: 4, h: 2 },
  medkit: { w: 2, h: 2 },
  bandage: { w: 1, h: 1 },
  noisemaker: { w: 1, h: 1 },
  bottle: { w: 1, h: 2 },
  cans: { w: 2, h: 1 },
  flare: { w: 2, h: 1 },
  food: { w: 1, h: 1 },
  flamethrower: { w: 4, h: 2 },
  dynamite: { w: 1, h: 2 },
  firecrackers: { w: 1, h: 1 },
  molotov: { w: 1, h: 2 },
  "flare-gun": { w: 2, h: 2 },
  "bear-trap": { w: 2, h: 2 },
  baseball: { w: 1, h: 1 },
  brick: { w: 2, h: 1 },
  rock: { w: 1, h: 1 },
  "tin-can": { w: 1, h: 1 },
  ammo: { w: 1, h: 1 },
  plank: { w: 4, h: 1 },
  scrap: { w: 1, h: 1 },
  chem: { w: 1, h: 2 },
  battery: { w: 1, h: 1 },
  key: { w: 1, h: 1 },
  fuel: { w: 2, h: 3 },
  toolbox: { w: 3, h: 2 },
  "car-battery": { w: 2, h: 2 },
  "pressure-tank": { w: 2, h: 3 },
  "bolt-cutters": { w: 3, h: 1 },
  "school-bag": { w: 2, h: 2 },
  attache: { w: 3, h: 2 },
  "hiking-pack": { w: 2, h: 3 },
  duffel: { w: 4, h: 2 },
  pouch: { w: 1, h: 1 },
}

/** How many of a supply share one stack in the case (a box of rounds, a bundle of planks). */
export const SUPPLY_STACKS: Readonly<Record<ItemId, number>> = {
  ammo: 15,
  plank: 3,
  scrap: 5,
  chem: 2,
  battery: 2,
  key: 4,
  fuel: 1,
}

/**
 * Bags you wear: the case is the biggest one you have, plus a row per pouch. You start with a school backpack (the
 * Breacher with their attaché case); a hiking pack and a duffel are out in town; pouches are made at the workbench.
 */
export type BagDef = { id: ItemId; label: string; cols: number; rows: number }

export const BAGS: readonly BagDef[] = [
  { id: "school-bag", label: "School Backpack", cols: 6, rows: 3 },
  { id: "attache", label: "Attaché Case", cols: 7, rows: 3 },
  { id: "hiking-pack", label: "Hiking Pack", cols: 7, rows: 4 },
  { id: "duffel", label: "Duffel Bag", cols: 9, rows: 4 },
]

export const STARTING_BAG: ItemId = "school-bag"
export const POUCH: ItemId = "pouch"
/** Pouches that fit on one bag, each a row. */
export const MAX_POUCHES = 2

/** The case's size for what a survivor wears: the biggest bag (by cells), a row per pouch. */
export function caseSize(count: (item: ItemId) => number): { cols: number; rows: number; bag: BagDef } {
  let best = BAGS[0]!
  for (const b of BAGS) if (count(b.id) > 0 && b.cols * b.rows > best.cols * best.rows) best = b
  const pouches = Math.min(MAX_POUCHES, count(POUCH))
  return { cols: best.cols, rows: best.rows + pouches, bag: best }
}

export const BAG_IDS: ReadonlySet<ItemId> = new Set(BAGS.map((b) => b.id))
