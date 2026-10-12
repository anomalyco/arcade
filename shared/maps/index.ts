import type { MapId } from "../config"
import { office } from "./office"
import type { MapDef } from "./types"

export type * from "./types"

const MAPS: Partial<Record<MapId, MapDef>> = { office }

export function getMap(id: string): MapDef {
  return MAPS[id as MapId] ?? office
}

export const AVAILABLE_MAPS: MapDef[] = Object.values(MAPS)
