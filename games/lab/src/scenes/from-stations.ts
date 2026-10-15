import { COLLECTION_SCHEMA, type LabScene, type SceneCollection } from "@arcade/kit/lab/scenes/model"
import { scenesFromStation } from "@arcade/kit/lab/scenes/migrate"
import { orderStations, type LabStation } from "@arcade/kit/lab/stations/types"

/** The collection each station's scenes go into. Stations not listed go to "Stations". */
export const STATION_AREAS: readonly { id: string; title: string; stations: readonly string[] }[] = [
  { id: "effects", title: "Effects", stations: ["explosions", "smoke-fire", "blackout", "getaway"] },
  { id: "look-and-light", title: "Look and light", stations: ["weather", "vegetation", "looks", "lighting", "materials"] },
  { id: "characters", title: "Characters and feel", stations: ["characters", "survivor-aim", "game-feel"] },
  { id: "outbreak", title: "Outbreak", stations: ["outbreak", "outbreak-hud", "outbreak-progression"] },
  { id: "audio", title: "Audio", stations: ["audio"] },
  { id: "carrier", title: "Carrier", stations: ["carrier"] },
]
const FALLBACK = { id: "stations", title: "Stations" }

/** Every station file as repo scenes in area collections, in station order, with what the migration changed. */
export function migrateStations(stations: readonly LabStation[], now: string): { collections: SceneCollection[]; scenes: LabScene[]; notes: string[] } {
  const scenes: LabScene[] = []
  const notes: string[] = []
  const byArea = new Map<string, string[]>()
  for (const { station } of orderStations(stations)) {
    const area = STATION_AREAS.find(a => a.stations.includes(station.id)) ?? FALLBACK
    const migrated = scenesFromStation(station, { collection: area.id, now })
    scenes.push(...migrated.scenes)
    notes.push(...migrated.notes)
    byArea.set(area.id, [...(byArea.get(area.id) ?? []), ...migrated.scenes.map(s => s.id)])
  }
  const collections = [...byArea].map(([id, order]): SceneCollection => ({
    schema: COLLECTION_SCHEMA,
    id,
    title: (STATION_AREAS.find(a => a.id === id) ?? FALLBACK).title,
    kind: "area",
    status: "active",
    order,
    created: now,
    updated: now,
  }))
  return { collections, scenes, notes }
}
