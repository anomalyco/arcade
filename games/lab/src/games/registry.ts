import type { MaterialAdapter, SectionFactory } from "@arcade/kit/lab/types"
import type { CharacterSpawnable, SpawnFactory } from "@arcade/kit/lab/spawn-types"
import type { LabContext } from "@arcade/kit/lab/types"
import type { LabAudioAdapter } from "@arcade/kit/lab/audio-adapter"

/** What one game contributes to the Lab. Each module is a separate chunk, fetched only when its game is chosen. */
export type LabGameModule = {
  sections: readonly SectionFactory[]
  materials: readonly MaterialAdapter[]
  /** Characters this game adds to the shared Playground. */
  characters?: (context: LabContext) => readonly CharacterSpawnable[]
  /** The game's own sound, driven by the Lab. */
  audio?: () => LabAudioAdapter
}

export type LabGameEntry = {
  id: string
  label: string
  /** Section ids the module registers, so a deep link can pull in its owner without importing every game. */
  sections: readonly string[]
  defaultSection?: string
  load: () => Promise<{ default: LabGameModule }>
}

export const LAB_GAMES: readonly LabGameEntry[] = [
  { id: "getaway", label: "Getaway", sections: ["getaway-effects"], load: () => import("./getaway") },
  { id: "blackout", label: "Blackout", sections: ["blackout-effects", "fire-water", "splatter"], load: () => import("./blackout") },
  { id: "outbreak", label: "Outbreak", sections: ["outbreak-vignette"], defaultSection: "outbreak-vignette", load: () => import("./outbreak") },
]

/** Carrier has its own sound and mixer pages but no Lab adapters yet, so it is not offered. */
export const ALL_GAMES = "all"

/**
 * Shared Playground (Proving Yard, street chunks, props, Getaway's cars) used whenever a game with characters is
 * loaded, with Getaway's car audio.
 */
export const loadPlayground = (): Promise<{ getawaySpawn: SpawnFactory; getawayLabAudio: () => LabAudioAdapter }> => import("./playground")

/**
 * Games to load for a URL: `?game=<id>` (or all), plus the owner of a deep-linked `?section=`/`#section`, so old
 * per-game Lab links keep landing on their section.
 */
export function resolveGames(search: string, hash: string): { choice: string; games: LabGameEntry[] } {
  const params = new URLSearchParams(search)
  const requested = params.get("game")?.trim().toLowerCase() ?? ""
  const entry = LAB_GAMES.find(game => game.id === requested)
  const choice = entry ? entry.id : ALL_GAMES
  const games = entry ? [entry] : [...LAB_GAMES]
  const raw = hash.replace(/^#/, "").trim().toLowerCase()
  const fromHash = (raw.startsWith("section=") ? raw.slice("section=".length) : raw).split("/")[0] ?? ""
  const section = fromHash || params.get("section")?.trim().toLowerCase() || ""
  const owner = LAB_GAMES.find(game => game.sections.includes(section))
  if (owner && !games.includes(owner)) games.push(owner)
  return { choice, games }
}
