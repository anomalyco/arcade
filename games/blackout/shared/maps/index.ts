import { generateOffice } from "./office"
import type { MapDef } from "./types"

export type * from "./types"
export { floorOf } from "./office"

const cache = new Map<number, MapDef>()

/** The office floor for a seed, generated once and kept for the few most recent seeds. */
export function getMap(seed: number): MapDef {
  let m = cache.get(seed)
  if (!m) {
    m = generateOffice(seed)
    cache.set(seed, m)
    if (cache.size > 4) cache.delete(cache.keys().next().value!)
  }
  return m
}
