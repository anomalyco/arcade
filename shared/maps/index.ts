import type { MapId } from "../config"
import { warehouse } from "./warehouse"
import type { MapDef } from "./types"

export type { MapDef, Door, LampDef, NoisySurface } from "./types"

const MAP_LIST: Record<MapId, MapDef> = { warehouse }

export function getMap(id: string): MapDef {
  return (id in MAP_LIST ? MAP_LIST[id as MapId] : undefined) ?? warehouse
}

export const MAP_IDS = Object.keys(MAP_LIST) as MapId[]
