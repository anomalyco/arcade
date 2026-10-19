import { BUILDING } from "../world/layout"
import { LOT_Y } from "../world/compound/lot"
import { PARKED } from "../game/intro/route"
import { hooks } from "./hooks"

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
    sfx.play("hor-metal-bang", { bus: "horror", pos, ref: 30, rolloff: 0.5, gain, rate, lowBoost: 10, jitter: 0.02, ...(inside ? { occlude: false, lowpass: 2200 } : {}) })
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
