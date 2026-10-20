import type { Building } from "../../shared/map"

/** Default share of houses with a lamp left on behind their windows (`litWindows` in `look/world.ts`). */
export const DEFAULT_LIT_WINDOWS = 0.2

/** A stable 0..1 roll per building id (FNV-1a), so every client and every frame agree which houses are lit. */
function roll(id: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619) >>> 0
  h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0
  h = Math.imul(h ^ (h >>> 13), 3266489917) >>> 0
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

let powerLeft = 1

/**
 * Share of the lit houses whose lamp still burns (Details · Life › "Town runs down night by night" lowers it each
 * night); the houses with the lowest rolls stay lit longest, so the lights go out house by house. 1 keeps them all.
 */
export function setWindowPowerLeft(share: number): void {
  powerLeft = Math.max(0, Math.min(1, share))
}

/**
 * Whether a building still has a lamp on behind its windows at night. The town is abandoned, so most houses are
 * dark; `share` of them (by a stable roll on the id) had a lamp left on when their people fled. Presentation only.
 */
export function windowsLit(building: Pick<Building, "id">, share: number): boolean {
  if (!building.id) return false
  if (share >= 1) return true
  if (share <= 0) return false
  return roll(building.id) < share * powerLeft
}

/** The building a front-window lamp sits outside of (window lamps hang just past the front wall), if any. */
export function windowLampBuilding<B extends Pick<Building, "rect">>(lamp: { x: number; y: number }, buildings: readonly B[]): B | undefined {
  for (const b of buildings) {
    const [x0, z0, x1, z1] = b.rect
    if (lamp.x >= x0 && lamp.x <= x1 && lamp.y >= z0 - 0.6 && lamp.y <= z1 + 0.6) return b
  }
  return undefined
}
