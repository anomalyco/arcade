import { BUILDING } from "../world/layout"
import { LOT_Y } from "../world/compound/lot"
import { PARKED } from "../game/intro/route"
import { savedCharacter } from "../playerb/body"
import { hooks } from "./hooks"
import { SFX, type SfxId } from "./sfx-manifest"
import type { PlayOptions } from "./engine"

// One-off story sounds that more than one system may want to trigger (the 3-08 transmitter beat, the hunter's
// entrance). Each plays at most once per page, so whoever calls first owns it and a second call is a no-op.

let carDestroyed = false

/**
 * The player's car (the intro car, parked in its stall in the lot) is wrecked: a heavy metal crunch, its 1980s alarm
 * whooping (the provisional `story-car-alarm` take) for ~2.5 s, then cut dead mid-whoop by a second crunch. From inside
 * the building it is muffled (dull and distant); outside it is placed and occluded like any other sound. On the
 * "horror & story" bus, so it plays in play mode (the horror layer setting only gates the random scares).
 * Returns false (and plays nothing) when it has already played.
 */
export function playCarDestroyed(): boolean {
  if (carDestroyed) return false
  carDestroyed = true
  const sfx = hooks.sfx
  if (!sfx) return true
  const pos = { x: PARKED.x, y: LOT_Y + 1, z: PARKED.z }
  const ear = sfx.ear
  const M = BUILDING.main
  const inside = ear.x > M.min[0] && ear.x < M.max[0] && ear.z > M.min[1] && ear.z < M.max[1] && ear.y > BUILDING.floorY
  // Through the building: straight-line wall counting would bury it, so it's dulled by hand instead.
  const through = inside ? { occlude: false, lowpass: 1500 } : {}
  const crunch = (rate: number, gain: number) =>
    sfx.play("hor-metal-bang", { bus: "horror", pos, ref: 30, rolloff: 0.5, gain, rate, lowBoost: 10, jitter: 0.02, ...through })
  crunch(0.62, 1.3)
  setTimeout(() => {
    const alarm = sfx.play("story-car-alarm", { bus: "horror", pos, ref: 25, rolloff: 0.6, gain: 1.1, jitter: 0, ...through })
    setTimeout(() => {
      // Cut dead mid-whoop, and the second hit.
      try {
        alarm?.stop()
      } catch {
        // already ended
      }
      crunch(0.5, 1.45)
    }, 2500)
  }, 350)
  return true
}

/** Automation: whether the car has been destroyed (its sounds played or claimed). */
export const storySounds = {
  get carDestroyed() {
    return carDestroyed
  },
}

/** Voice fallback per playable character (roster.json has no gender field; cast from the roster renders). */
const VOICE_FALLBACK: Record<string, "m" | "f"> = { remy: "m", james: "m", louise: "f", megan: "f", kate: "f" }

const shipped = (id: string): id is SfxId => id in SFX && SFX[id as SfxId].variants.length > 0

/**
 * The sfx id of a spoken line in the selected character's own voice. Lines are named `story-<line>-<character>`
 * (e.g. `story-call-player-kate`); the character is the one the picker stored (`savedCharacter()`, localStorage
 * "ashwood.character"). Falls back to `story-<line>-m` / `-f` for that character, then `story-<line>`; null when
 * nothing is shipped for the line.
 *
 *   const id = playerVoice("call-player")
 *   if (id) hooks.sfx?.play(id, { bus: "horror", pos, ref: 1.2 })
 */
export function playerVoice(line: string, character = savedCharacter()): SfxId | null {
  const base = line.startsWith("story-") ? line : `story-${line}`
  const tries = [`${base}-${character}`, `${base}-${VOICE_FALLBACK[character] ?? "m"}`, base]
  return tries.find(shipped) ?? null
}

/** Starts decoding spoken lines ahead of time (long clips decode after the short one-shots otherwise). */
export function preloadLines(ids: (SfxId | null)[]) {
  for (const id of ids) if (id) void hooks.sfx?.load(id)
}

/**
 * Plays a spoken line now. `Sfx.play` skips a clip that isn't decoded yet; a 10–12 s voice line can still be decoding
 * when a scene starts soon after boot (e.g. the `?play&start=tx-on` chapter jump), which silently dropped the player's
 * radio report. Here a late clip is loaded and then started at the offset it would have reached, so it stays in sync
 * with its subtitles. Gives up (silently) if the clip takes longer than `maxLate` s.
 */
export function playLine(id: SfxId, o: PlayOptions, maxLate = 4) {
  const sfx = hooks.sfx
  if (!sfx) return
  if (sfx.ready(id)) {
    sfx.play(id, o)
    return
  }
  const asked = performance.now()
  void sfx.load(id).then(() => {
    const late = (performance.now() - asked) / 1000
    if (late <= maxLate && sfx.ready(id)) sfx.play(id, { ...o, offset: (o.offset ?? 0) + late })
  })
}
