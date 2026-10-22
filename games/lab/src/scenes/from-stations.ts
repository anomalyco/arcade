import { COLLECTION_SCHEMA, type LabScene, type SceneCollection } from "@arcade/kit/lab/scenes/model"
import { scenesFromStation } from "@arcade/kit/lab/scenes/migrate"
import { orderStations, type LabStation } from "@arcade/kit/lab/stations/types"
import { kindOf } from "./kinds"

/** The collection each station's scenes go into. Stations not listed go to "Stations". */
export const STATION_AREAS: readonly { id: string; title: string; stations: readonly string[]; archived?: boolean }[] = [
  // Look, light, weather, materials, vegetation and effects share the base debug world and differ by knobs and presets.
  { id: "world", title: "Look and world", stations: ["look-and-world", "sky", "effects"] },
  { id: "characters", title: "Characters and feel", stations: ["characters", "survivor-aim", "game-feel"] },
  { id: "outbreak", title: "Outbreak", stations: ["outbreak-look", "outbreak", "outbreak-vehicles", "first-night", "outbreak-hud", "outbreak-onboarding", "outbreak-progression", "outbreak-map", "outbreak-melee", "outbreak-impact", "outbreak-zombie-behaviour", "outbreak-interactions", "outbreak-breach", "outbreak-discovery", "outbreak-hordes", "outbreak-fire", "outbreak-weather", "outbreak-way-out", "outbreak-blood-lights", "outbreak-details", "outbreak-characters", "outbreak-vegetation", "outbreak-houses", "outbreak-secrets", "survivor-bots", "rugs-interiors", "styles"] },
  { id: "games", title: "Other games", stations: ["blackout", "getaway", "carrier", "water", "brawl", "archers"] },
  { id: "assets", title: "Textures, props and sound", stations: ["rugs", "props", "audio"] },
  // Superseded by the Look and world and Effects labs; archived in every browser until Kit decides to delete them.
  { id: "archive", title: "Archive", archived: true, stations: ["looks", "lighting", "weather", "materials", "vegetation", "explosions", "smoke-fire"] },
]
const FALLBACK = { id: "stations", title: "Stations" }

/** Every station file as repo labs in area collections, in station order, with what the migration changed. */
export function migrateStations(stations: readonly LabStation[], now: string): { collections: SceneCollection[]; scenes: LabScene[]; notes: string[] } {
  const scenes: LabScene[] = []
  const notes: string[] = []
  const byArea = new Map<string, string[]>()
  for (const { station } of orderStations(stations)) {
    const area = STATION_AREAS.find(a => a.stations.includes(station.id)) ?? FALLBACK
    const migrated = scenesFromStation(station, { collection: area.id, now, kindOf })
    if ("archived" in area && area.archived) for (const s of migrated.scenes) s.status = "archived"
    scenes.push(...migrated.scenes)
    notes.push(...migrated.notes)
    byArea.set(area.id, [...(byArea.get(area.id) ?? []), ...migrated.scenes.map(s => s.id)])
  }
  const rank = (id: string) => { const i = STATION_AREAS.findIndex(a => a.id === id); return i < 0 ? STATION_AREAS.length : i }
  const collections = [...byArea].sort(([a], [b]) => rank(a) - rank(b)).map(([id, order]): SceneCollection => ({
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
