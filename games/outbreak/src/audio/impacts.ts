import type { ImpactSurface } from "@arcade/kit/audio"
import { distToRect, rayRect, type Rect } from "@arcade/kit/sim/geom"
import { PISTOL_RANGE, type CombatShotEvent } from "../../shared/combat"
import { EXTERIOR_VEHICLE_COLLIDERS, inBuildingFootprint, type Building, type Town } from "../../shared/map"

/** One place a bullet struck: what it stopped on, or a pane, board, fence or car body it passed through. */
export type ShotImpact = { surface: ImpactSurface; x: number; y: number; t: number; through: boolean }

/** Pistol round speed for the impact's delay after the report (m/s). */
const BULLET_SPEED = 360
const WOODEN = new Set(["house", "ranch", "cottage", "cabin"])

/** What a wall is made of on the face the round struck (`x, y` just in front of it): plaster inside, else cladding. */
function wallSurface(building: Building | undefined, x: number, y: number): ImpactSurface {
  if (!building) return "concrete"
  if (inBuildingFootprint(building, x, y)) return "plaster"
  const kind = building.archetype ?? building.kind
  if (WOODEN.has(kind)) return "wood"
  return kind === "warehouse" ? "metal" : "concrete"
}

const pad = (r: Rect, m: number): Rect => [r[0] - m, r[1] - m, r[2] + m, r[3] + m]

/**
 * Where a shot that hit no zombie struck, from the same ray the simulation cast (`CombatShotEvent` from/to): the wall
 * or closed door it stopped on (plaster on a face inside a building, else the building's cladding), and the first window, barricade, fence or car it passed through on the way (sight
 * blockers stop bullets; those do not, so they ring as the round goes through). Shots that ran out of range are silent.
 */
export function shotImpacts(town: Town, shot: CombatShotEvent, barricaded: (id: string) => number = () => 0): ShotImpact[] {
  if (shot.hitZombieId !== null) return []
  const dx = shot.toX - shot.fromX
  const dy = shot.toY - shot.fromY
  const len = Math.hypot(dx, dy)
  if (len < 1e-3) return []
  const ux = dx / len
  const uy = dy / len
  const out: ShotImpact[] = []

  // The first thing the round passed through on its way.
  let through: ShotImpact | null = null
  const cross = (rect: Rect, surface: ImpactSurface) => {
    const t = rayRect(shot.fromX, shot.fromY, ux, uy, rect, len - 0.05)
    if (t > 0.05 && t < len - 0.05 && (!through || t < through.t)) through = { surface, x: shot.fromX + ux * t, y: shot.fromY + uy * t, t, through: true }
  }
  for (const w of town.windows) if (!w.open || barricaded(w.id) > 0) cross(w.rect, barricaded(w.id) > 0 ? "wood" : "glass")
  for (const b of town.barriers) if (b.kind === "fence") cross(b.rect, "wood")
  for (const v of town.vehicles ?? EXTERIOR_VEHICLE_COLLIDERS) cross(v, "metal")
  if (through) out.push(through)

  if (len < PISTOL_RANGE - 0.1) {
    let surface: ImpactSurface = "concrete"
    let best = 0.12
    for (const d of town.doors) {
      const dist = d.open ? Infinity : distToRect(shot.toX, shot.toY, d.rect)
      if (dist < best) { best = dist; surface = "wood" }
    }
    for (const b of town.barriers) {
      if (b.kind !== "wall") continue
      const dist = distToRect(shot.toX, shot.toY, b.rect)
      if (dist < best) {
        best = dist
        surface = wallSurface(town.buildings.find((bd) => distToRect(shot.toX, shot.toY, pad(bd.rect, 0.3)) === 0), shot.toX - ux * 0.3, shot.toY - uy * 0.3)
      }
    }
    out.push({ surface, x: shot.toX - ux * 0.05, y: shot.toY - uy * 0.05, t: len, through: false })
  }
  return out
}

/** Seconds from the report to the round arriving `t` metres downrange. */
export const impactDelay = (t: number) => t / BULLET_SPEED
