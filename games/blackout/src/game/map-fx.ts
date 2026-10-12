import type { MapDef } from "../../shared/maps"
import type { ViewRect } from "../render/lighting"
import type { FxFn, SpriteFn } from "./vehicles"

const acc = new Map<number, number>()

/**
 * Fires on the map (downtown's burning wreck: lights of kind "fire"): flame sprites licking up off the shell and a
 * column of black smoke, for the ones near the view. The wreck's light itself flickers in the light culler.
 */
export function mapFires(map: MapDef, view: ViewRect, t: number, dt: number, sprite: SpriteFn, fx: FxFn): void {
  if (map.kind !== "downtown") return
  for (const l of map.lights) {
    if (l.kind !== "fire") continue
    if (l.x < view[0] - 6 || l.x > view[2] + 6 || l.y < view[1] - 6 || l.y > view[3] + 10) continue
    for (let i = 0; i < 3; i++) {
      const f = 0.7 + 0.3 * Math.sin(t * (11 + i * 3) + i * 2 + l.id)
      const x = l.x + (i - 1) * 0.9
      const y = l.y + ((i * 0.37) % 1 - 0.5) * 0.6
      sprite(true, x, 1.0, y, 0.6 * f, 1.7, 0.55, 0.1, 0.75 * f, 0)
      sprite(true, x, 1.25, y, 0.32 * f, 1.9, 1.0, 0.4, 0.8 * f, 0)
    }
    let a = (acc.get(l.id) ?? 0) + dt * 8
    while (a > 1) {
      a--
      const x = l.x + (Math.random() - 0.5) * 2.4
      const y = l.y + (Math.random() - 0.5) * 1
      if (Math.random() < 0.4) fx(x, y, 0.9 + Math.random() * 0.3, (Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.4, 0.8 + Math.random() * 1.2, 0.35 + Math.random() * 0.3, 0.2 + Math.random() * 0.15, "fire")
      else fx(x, y, 1.3, (Math.random() - 0.5) * 0.3 + 0.25, (Math.random() - 0.5) * 0.3 - 0.15, 0.9 + Math.random() * 0.6, 2.2 + Math.random() * 1.2, 0.3 + Math.random() * 0.2, "char")
    }
    acc.set(l.id, a)
  }
}
