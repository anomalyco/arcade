import type { NoiseEvent } from "../../shared/ai"
import { HabitSiteIndex, type HabitKind } from "../../shared/characters/sites"
import type { Town } from "../../shared/map"
import type { OutbreakCharacterSettings } from "./settings"
import { holdCharacterSounds, playCharacterBeat } from "./sounds"

/** A torch the dead may flinch from: a survivor's position, aim and whether the light is on. */
export type CharacterBeam = { x: number; y: number; aim: number; on: boolean }

/** A beat of a habit someone could hear (a run of knocks on a door from inside, a pan, bedsprings, a fence), once a cycle. */
export type CharacterBeat = { id: number; kind: HabitKind; x: number; y: number }

/**
 * What the crowd renderer needs each frame to draw characters (AR-88): which ideas are on, the town's habit sites,
 * recent noises (heads turn to them) and the survivors' torches (a flinch). Built by `characterFrame`, read by
 * `ZombieCrowdRenderer.draw`; `null` is Today.
 */
export type ZombieCharacterFrame = {
  callings: boolean
  wear: boolean
  habits: HabitSiteIndex | null
  leash: boolean
  noiseTurn: boolean
  flinch: boolean
  noises: readonly NoiseEvent[]
  beams: readonly CharacterBeam[]
  /** Called on each audible habit beat, presentation only. */
  onBeat: (beat: CharacterBeat) => void
  /** Joggers drawn this frame whose earbuds still leak tinny music (filled by the renderer). */
  earbuds: { id: number; x: number; y: number }[]
  /** The bride and groom dancing within earshot this frame (filled by the renderer; the waltz plays at them). */
  dancing: { id: number; x: number; y: number }[]
}

const index = new HabitSiteIndex()
const beams: CharacterBeam[] = []
const frame: ZombieCharacterFrame = {
  callings: true,
  wear: true,
  habits: null,
  leash: true,
  noiseTurn: true,
  flinch: true,
  noises: [],
  beams,
  onBeat: playCharacterBeat,
  earbuds: [],
  dancing: [],
}

/** The habit sites the client sees in `town` (for Lab staging and tests). */
export function clientHabitSites(town: Town): HabitSiteIndex {
  index.sync(town)
  return index
}

/** This frame's character context, or `null` for Today. */
export function characterFrame(
  settings: OutbreakCharacterSettings | undefined,
  town: Town,
  noises: readonly NoiseEvent[],
  survivors: readonly { x: number; y: number; aim: number; flashlightOn?: boolean }[],
): ZombieCharacterFrame | null {
  holdCharacterSounds(frame)
  frame.earbuds.length = 0
  frame.dancing.length = 0
  if (!settings || settings.chStyle < 1) return null
  frame.callings = settings.chCallings
  frame.wear = settings.chWear
  frame.leash = settings.chLeash
  frame.noiseTurn = settings.chNoiseTurn
  frame.flinch = settings.chTorchFlinch
  if (settings.chHabits >= 1) {
    index.sync(town)
    frame.habits = index
  } else frame.habits = null
  frame.noises = noises
  beams.length = 0
  for (const s of survivors) beams.push({ x: s.x, y: s.y, aim: s.aim, on: Boolean(s.flashlightOn) })
  return frame
}
