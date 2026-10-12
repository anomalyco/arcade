import { blockOf, generateDowntown } from "./downtown"
import { floorOf, generateOffice } from "./office"
import { MAP_KINDS, type MapDef, type MapKind } from "./types"

export type * from "./types"
export { MAP_KINDS } from "./types"
export { floorOf } from "./office"
export { blockOf } from "./downtown"

/** What the room plays on: one kind of map every match, or a random kind each match. */
export type MapChoice = MapKind | "random"
export const MAP_CHOICES: readonly MapChoice[] = ["office", "downtown", "random"]
export const mapChoiceOf = (v: unknown): MapChoice | null => (MAP_CHOICES as readonly unknown[]).includes(v) ? (v as MapChoice) : null
export const mapKindOf = (v: unknown): MapKind | null => (MAP_KINDS as readonly unknown[]).includes(v) ? (v as MapKind) : null

const cache = new Map<string, MapDef>()

/** The map of a kind for a seed, generated once and kept for the few most recent. Same kind and seed, same map everywhere. */
export function getMap(kind: MapKind, seed: number): MapDef {
  const key = `${kind}:${seed}`
  let m = cache.get(key)
  if (!m) {
    m = kind === "downtown" ? generateDowntown(seed) : generateOffice(seed)
    cache.set(key, m)
    if (cache.size > 4) cache.delete(cache.keys().next().value!)
  }
  return m
}

/** "OFFICE TOWER · FL 12" or "DOWNTOWN · BLK 07", for the HUD and scoreboard. */
export const mapLabel = (kind: MapKind | undefined, seed: number): string => (kind === "downtown" ? `DOWNTOWN · BLK ${String(blockOf(seed)).padStart(2, "0")}` : `OFFICE TOWER · FL ${floorOf(seed)}`)
