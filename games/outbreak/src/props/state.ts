import { SIZE, type Building, type Prop, type Town } from "../../shared/map"

/** Whether the library furnishes the houses; the level builder reads it (like `interiorSettings`). */
export const propDressingState = { on: false }

/** Gameplay prop kinds the library draws instead of their box furniture. Workbench, stash and closet keep their own. */
export const REPLACED_KINDS: ReadonlySet<Prop["kind"]> = new Set(["bed", "sofa", "table", "shelf", "coffee", "counter", "fridge", "dresser", "chair", "nightstand", "stove"])

/** The start block's houses (the origin build), the ones furnished first. */
export const furnishedHouse = (b: Building): boolean => b.kind === "house" && b.rect[2] <= SIZE && b.rect[3] <= SIZE

/** True when the library draws this gameplay prop, so the level builder skips its box furniture. */
export function replacedByLibrary(p: Prop, town: Town): boolean {
  if (!propDressingState.on || !REPLACED_KINDS.has(p.kind)) return false
  return town.buildings.some(b => furnishedHouse(b) && p.x > b.rect[0] && p.x < b.rect[2] && p.y > b.rect[1] && p.y < b.rect[3])
}
