import type { SceneLight } from "../gpu/scene-frame"
import type { CampLight } from "./build"
import type { ForestLookSettings } from "./settings"

/** Torches are already present. Gameplay sources precede bounce and optional camp
 * dressing so the SceneLights cap cannot evict a flare or lantern for a bulb. */
export function appendForestLights(
  lights: SceneLight[],
  game: readonly SceneLight[],
  bounce: SceneLight | undefined,
  camp: readonly CampLight[],
  settings: Pick<ForestLookSettings, "stringLights" | "windows">,
): void {
  lights.push(...game)
  if (bounce) lights.push(bounce)
  for (const [i, l] of [...camp.entries()].sort(([, a], [, b]) => Number(!!a.surfaceOnly) - Number(!!b.surfaceOnly))) {
    const k = l.kind === "bulb" ? settings.stringLights : settings.windows
    if (k <= 0) continue
    lights.push({ id: 3000 + i, x: l.x, y: l.z, h: l.y, r: l.range, color: l.color, power: l.power * k, size: l.kind === "window" ? 0.5 : 0.05, unshadowed: true,
      ...(l.cosOuter > 0 ? { spot: { axis: l.axis, cosOuter: l.cosOuter, cosInner: Math.min(0.999, l.cosOuter + 0.35) } } : {}) })
  }
}
