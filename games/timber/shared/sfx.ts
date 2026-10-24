// Library cues TIMBER still uses beside its own recordings (`src/sounds.ts`): the truck, hits, gore and pickups.
export const TRUCK_ENGINE = "vehicle.boat.engine"

export const TIMBER_SFX = [
  TRUCK_ENGINE,
  "impact.bullet.wood", // a raked branch's snap
  "melee.break", // a domino strike
  "melee.hit.wood", // branches snapping, an axe stroke
  "weather.wind.gust", // crown whoosh
  "weather.thunder.close", // the landing's low thump under the crash
  "zombie.hit", // saw in flesh
  "melee.hit.blade", // saw contact
  "melee.hit.metal", // bar on bar
  "body.hurt",
  "melee.swing.heavy", // release fling
  "melee.swing.light", // lunge, an axe stroke
  "melee.shove", // shoving a cut tree over
  "flashlight.click",
  "flare.ignite",
  "pickup.item",
  "item.drop",
  "ui.ping",
  "ui.click",
] as const
