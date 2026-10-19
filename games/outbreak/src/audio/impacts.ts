import type { ImpactSurface } from "@arcade/kit/audio"
import { distToRect, rayRect, type Rect } from "@arcade/kit/sim/geom"
import { PISTOL_RANGE, type CombatMeleeEvent, type CombatShotEvent } from "../../shared/combat"
import { EXTERIOR_VEHICLE_COLLIDERS, inBuildingFootprint, propShape, type Building, type Town } from "../../shared/map"
import { surfaceAt } from "./space"

/** Detailed material classification for bullet and melee impacts. */
export type ImpactMaterial = "flesh" | "wood" | "metal" | "concrete" | "plaster" | "glass" | "dirt" | "car"

/** One place a bullet struck: what it stopped on, or a pane, board, fence or car body it passed through. */
export type ShotImpact = {
  surface: ImpactSurface
  material: ImpactMaterial
  x: number
  y: number
  t: number
  through: boolean
  rate?: number
  cutoffHz?: number
}

/** One place a melee swing struck when it connected with a world surface instead of a zombie. */
export type MeleeSurfaceImpact = {
  id: string
  surface: ImpactSurface
  material: ImpactMaterial
  x: number
  y: number
  gain: number
  rate?: number
  cutoffHz?: number
}

/** Pistol round speed for the impact's delay after the report (m/s). */
const BULLET_SPEED = 360
const WOODEN = new Set(["house", "ranch", "cottage", "cabin", "church"])
const METAL_PROPS = new Set(["fridge", "stove", "workbench"])

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
  const cross = (rect: Rect, surface: ImpactSurface, material: ImpactMaterial = surface, rate?: number) => {
    const t = rayRect(shot.fromX, shot.fromY, ux, uy, rect, len - 0.05)
    if (t > 0.05 && t < len - 0.05 && (!through || t < through.t)) {
      through = {
        surface,
        material,
        x: shot.fromX + ux * t,
        y: shot.fromY + uy * t,
        t,
        through: true,
        ...(rate !== undefined ? { rate } : {}),
      }
    }
  }
  for (const w of town.windows) if (!w.open || barricaded(w.id) > 0) cross(w.rect, barricaded(w.id) > 0 ? "wood" : "glass")
  for (const b of town.barriers) if (b.kind === "fence") cross(b.rect, "wood")
  for (const v of town.vehicles ?? EXTERIOR_VEHICLE_COLLIDERS) cross(v, "metal", "car", 0.86)
  if (through) out.push(through)

  if (len < PISTOL_RANGE - 0.1) {
    let surface: ImpactSurface = "concrete"
    let material: ImpactMaterial = "concrete"
    let rate: number | undefined
    let cutoffHz: number | undefined
    let best = 0.12
    for (const d of town.doors) {
      const dist = d.open ? Infinity : distToRect(shot.toX, shot.toY, d.rect)
      if (dist < best) {
        best = dist
        surface = "wood"
        material = "wood"
        rate = undefined
        cutoffHz = undefined
      }
    }
    for (const b of town.barriers) {
      if (b.kind !== "wall") continue
      const dist = distToRect(shot.toX, shot.toY, b.rect)
      if (dist < best) {
        best = dist
        surface = wallSurface(town.buildings.find((bd) => distToRect(shot.toX, shot.toY, pad(bd.rect, 0.3)) === 0), shot.toX - ux * 0.3, shot.toY - uy * 0.3)
        material = surface
        rate = undefined
        cutoffHz = undefined
      }
    }
    for (const v of town.vehicles ?? EXTERIOR_VEHICLE_COLLIDERS) {
      const dist = distToRect(shot.toX, shot.toY, v)
      if (dist < best) {
        best = dist
        surface = "metal"
        material = "car"
        rate = 0.86
        cutoffHz = undefined
      }
    }
    if (best === 0.12) {
      for (const p of town.props) {
        if (p.kind === "tree" && Math.hypot(shot.toX - p.x, shot.toY - p.y) < 0.48) {
          best = 0
          surface = "wood"
          material = "wood"
          break
        }
      }
    }
    if (best === 0.12) {
      const ground = surfaceAt(town, shot.toX, shot.toY)
      if (ground === "grass" || ground === "dirt" || ground === "gravel") {
        surface = "concrete"
        material = "dirt"
        rate = 0.72
        cutoffHz = 1800
      } else if (ground === "wood") {
        surface = "wood"
        material = "wood"
      } else if (ground === "metal") {
        surface = "metal"
        material = "metal"
      } else if (ground === "glass") {
        surface = "glass"
        material = "glass"
      }
    }
    out.push({
      surface,
      material,
      x: shot.toX - ux * 0.05,
      y: shot.toY - uy * 0.05,
      t: len,
      through: false,
      ...(rate !== undefined ? { rate } : {}),
      ...(cutoffHz !== undefined ? { cutoffHz } : {}),
    })
  }
  return out
}

/**
 * Resolves what world surface a melee swing struck when it missed zombies (`hits.length === 0` and not a door bash).
 * Distinguishes wood (fences, trees, furniture, wood walls), metal (appliances, warehouse walls), car bodies,
 * concrete/brick/plaster walls, glass window panes, and dirt/grass ground sweeps.
 */
export function meleeImpact(
  town: Town,
  swing: Pick<CombatMeleeEvent, "x" | "y" | "aim" | "reach"> & { hitDoorId?: string | null; hits?: readonly unknown[]; groundStrike?: boolean },
  barricaded: (id: string) => number = () => 0,
): MeleeSurfaceImpact | null {
  if ((swing.hits?.length ?? 0) > 0 || swing.hitDoorId) return null
  const ux = Math.cos(swing.aim)
  const uy = Math.sin(swing.aim)
  const maxT = Math.max(0.4, swing.reach)
  let bestT = maxT
  let surface: ImpactSurface | null = null
  let material: ImpactMaterial | null = null

  const testRect = (rect: Rect, surf: ImpactSurface, mat: ImpactMaterial = surf) => {
    const t = rayRect(swing.x, swing.y, ux, uy, rect, bestT)
    if (t < bestT) {
      bestT = t
      surface = surf
      material = mat
    }
  }

  for (const w of town.windows) {
    if (!w.open || barricaded(w.id) > 0) {
      const hasPlanks = barricaded(w.id) > 0
      testRect(w.rect, hasPlanks ? "wood" : "glass", hasPlanks ? "wood" : "glass")
    }
  }
  for (const d of town.doors) {
    if (!d.open) testRect(d.rect, "wood", "wood")
  }
  for (const b of town.barriers) {
    if (b.kind === "fence") {
      testRect(b.rect, "wood", "wood")
    } else if (b.kind === "wall") {
      const t = rayRect(swing.x, swing.y, ux, uy, b.rect, bestT)
      if (t < bestT) {
        bestT = t
        const hx = swing.x + ux * t
        const hy = swing.y + uy * t
        const ws = wallSurface(town.buildings.find((bd) => distToRect(hx, hy, pad(bd.rect, 0.3)) === 0), hx - ux * 0.25, hy - uy * 0.25)
        surface = ws
        material = ws
      }
    }
  }
  for (const v of town.vehicles ?? EXTERIOR_VEHICLE_COLLIDERS) {
    testRect(v, "metal", "car")
  }
  for (const p of town.props) {
    if (p.kind === "tree") {
      const r: Rect = [p.x - 0.35, p.y - 0.35, p.x + 0.35, p.y + 0.35]
      testRect(r, "wood", "wood")
      continue
    }
    const shape = propShape(p)
    if (!shape) continue
    const isMetal = METAL_PROPS.has(p.kind)
    testRect(shape.rect, isMetal ? "metal" : "wood", isMetal ? "metal" : "wood")
  }

  if (!surface || !material) {
    if (!swing.groundStrike) return null
    const gx = swing.x + ux * Math.min(0.9, maxT * 0.6)
    const gy = swing.y + uy * Math.min(0.9, maxT * 0.6)
    const ground = surfaceAt(town, gx, gy)
    if (ground === "grass" || ground === "dirt" || ground === "gravel") {
      return {
        id: "foot.grass.run",
        surface: "concrete",
        material: "dirt",
        x: gx,
        y: gy,
        gain: 0.72,
        rate: 0.78,
        cutoffHz: 1900,
      }
    }
    return null
  }

  const hx = swing.x + ux * Math.max(0, bestT - 0.04)
  const hy = swing.y + uy * Math.max(0, bestT - 0.04)
  if (material === "car") {
    return { id: "melee.hit.metal", surface: "metal", material: "car", x: hx, y: hy, gain: 0.82, rate: 0.78, cutoffHz: 3400 }
  }
  if (material === "metal") {
    return { id: "melee.hit.metal", surface: "metal", material: "metal", x: hx, y: hy, gain: 0.85, rate: 1.06 }
  }
  if (material === "wood") {
    return { id: "melee.hit.wood", surface: "wood", material: "wood", x: hx, y: hy, gain: 0.82 }
  }
  if (material === "glass") {
    return { id: "impact.bullet.glass", surface: "glass", material: "glass", x: hx, y: hy, gain: 0.88, rate: 0.92 }
  }
  return {
    id: `impact.bullet.${surface}`,
    surface,
    material,
    x: hx,
    y: hy,
    gain: 0.78,
    rate: 0.84,
    cutoffHz: 3200,
  }
}

/** Seconds from the report to the round arriving `t` metres downrange. */
export const impactDelay = (t: number) => t / BULLET_SPEED
