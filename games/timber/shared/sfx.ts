// Shared-library placeholders. The library has no chainsaw yet: `generator.loop` pitched up stands in for the engine
// (idle and rev), and `door.pry.loop` (strained wood and scraping) for the bar biting into a trunk.
export const SAW_ENGINE = "generator.loop"
export const SAW_BITE = "door.pry.loop"
export const TRUCK_ENGINE = "vehicle.boat.engine"

export const TIMBER_SFX = [
  SAW_ENGINE,
  SAW_BITE,
  TRUCK_ENGINE,
  "door.wood.open", // creak at the warning point
  "barricade.break", // the hinge cracking as it goes
  "impact.bullet.wood", // the snap after the crack
  "ship.hull.creak", // the long groan as it tips
  "melee.break", // a domino strike
  "melee.hit.wood", // branches snapping
  "weather.wind.gust", // crown whoosh
  "weather.thunder.close", // landing thud
  "door.bash", // landing body
  "zombie.hit", // saw in flesh
  "melee.hit.blade", // saw contact
  "melee.hit.metal", // bar on bar, an engine cough
  "body.hurt",
  "body.heartbeat",
  "melee.swing.heavy", // release fling
  "melee.swing.light", // lunge, an axe stroke
  "melee.shove", // shoving a cut tree over
  "window.slide", // the pull cord
  "flashlight.click",
  "flare.ignite",
  "pickup.item",
  "item.drop",
  "foot.grass.run",
  "ui.ping",
  "ui.click",
] as const
