import * as THREE from "three/webgpu"
import type { Lamp } from "../context"
import { INTERIOR } from "../layout"
import { renderState } from "../../render/shared"
import { HALL } from "./core"
import { MODELS } from "../../render/models"
import { placeModels } from "./props"
import {
  type Builder,
  CEIL_Y,
  DOOR_H,
  FLOOR_Y,
  M,
  T,
  ceiling,
  corridorBands,
  door,
  doorOpening,
  flicker as flickerLevel,
  fluorescentPanel,
  PANEL_ON,
  TUBE,
  staticGlass,
  troffer,
  wall,
} from "./kit"

// The main corridor (concept r3-02) and the short link north from the lobby. The corridor runs from the link
// junction (x ≈ 0) west to the far double doors; layout's corridor rect starts at x = -9, so the junction stretch
// x -9..1.6 is built here too to join it to the link.

const COOL = TUBE
export const WALL_T = 0.15

export const CORRIDOR = {
  x0: INTERIOR.corridor.min[0],
  x1: INTERIOR.link.max[0],
  zn: INTERIOR.corridor.min[1],
  zs: INTERIOR.corridor.max[1],
}

/** Door centres (x) on the north and south walls. */
export const NORTH_DOORS = [-14, -21, -28, -34, -40, -46, -52.2]
export const SOUTH_DOORS = [-17, -24, -31, -37, -43, -49]
export const STATIC_DOOR = -14
export const LAB_DOOR = -21
export const CLOSET_DOOR = -31

export function buildCorridor(b: Builder) {
  const { x0, x1, zn, zs } = CORRIDOR
  const link = INTERIOR.link
  const lobbyZ = INTERIOR.lobby.min[1]
  const on = PANEL_ON

  // Floors: waxed linoleum with dark green border stripes, continuing up the link.
  b.floor("linoleum", x0, zn - WALL_T, x1, zs + WALL_T)
  b.floor("linoleum", link.min[0], zs + WALL_T, link.max[0], lobbyZ)
  const sy = FLOOR_Y + 0.0015
  // Edge stripes: the north one runs the full length; the south one stops at the hall and the link, whose own stripes
  // turn the corner into them (mitred at 0.42 m from the walls), so every stripe joins another.
  const zS = zs - 0.42
  b.box(M.stripe, x0 + 0.1, sy - 0.01, zn + 0.37, link.max[0] - 0.37, sy, zn + 0.47, { cast: false })
  for (const [a, c] of [
    [x0 + 0.1, HALL.x0 + 0.47],
    [HALL.x1 - 0.47, link.min[0] + 0.47],
  ])
    b.box(M.stripe, a, sy - 0.01, zS - 0.05, c, sy, zS + 0.05, { cast: false })
  b.box(M.stripe, link.max[0] - 0.47, sy - 0.01, zn + 0.37, link.max[0] - 0.37, sy, lobbyZ - 0.1, { cast: false })
  b.box(M.stripe, link.min[0] + 0.37, sy - 0.01, zS - 0.05, link.min[0] + 0.47, sy, lobbyZ - 0.1, { cast: false })

  // Walls
  const northOpenings = NORTH_DOORS.map((x) => doorOpening(x))
  const southOpenings = [
    ...SOUTH_DOORS.map((x) => doorOpening(x)),
    { a0: link.min[0], a1: link.max[0], top: CEIL_Y },
    { a0: HALL.x0 - 0.15, a1: HALL.x1 + 0.15, top: CEIL_Y },
  ]
  wall(b, "x", x0 - WALL_T, x1 + WALL_T, zn - WALL_T, zn, corridorBands, northOpenings)
  wall(b, "x", x0 - WALL_T, x1 + WALL_T, zs, zs + WALL_T, corridorBands, southOpenings)
  wall(b, "z", zn, zs, x0 - WALL_T, x0, corridorBands)
  wall(b, "z", zn, zs, x1, x1 + WALL_T, corridorBands, [doorOpening(0, 1.7)])
  wall(b, "z", zs, lobbyZ - WALL_T, link.min[0] - WALL_T, link.min[0], corridorBands)
  wall(b, "z", zs, lobbyZ - WALL_T, link.max[0], link.max[0] + WALL_T, corridorBands)

  // Doors. Front (local +Z) faces the corridor: north wall rot 0, south wall rot π.
  const glow = staticGlass()
  for (const x of NORTH_DOORS) {
    if (x === LAB_DOOR) continue
    door(b, x, zn - WALL_T / 2, { rot: 0, locked: true, glass: x === STATIC_DOOR ? glow.material : undefined })
  }
  for (const x of SOUTH_DOORS) {
    if (x === CLOSET_DOOR) continue
    door(b, x, zs + WALL_T / 2, { rot: Math.PI, locked: true })
  }
  // Hinged on the west jamb and swung well past square into the room: from the corridor the leaf reads as a dark slab
  // just inside the left jamb and the room opens up beyond it (concept r5-05).
  door(b, LAB_DOOR, zn - WALL_T / 2, { rot: 0, open: 1.6 })
  door(b, CLOSET_DOOR, zs + WALL_T / 2, { rot: Math.PI, open: 0.6 })
  door(b, x1 + WALL_T / 2, 0, { rot: -Math.PI / 2, width: 1.7, leaves: 2, plate: false, locked: true })

  // Static-lit room behind the north door: a narrow flickering spot aimed out through the vision panel.
  const staticSpec: Lamp = {
    kind: "fluorescent",
    position: [STATIC_DOOR + 0.1, FLOOR_Y + 1.75, zn - WALL_T - 0.7],
    direction: norm(0, -0.42, 1),
    color: [0.82, 0.9, 1.0],
    intensity: 30,
    range: 6,
    angle: 0.3,
    penumbra: 0.6,
    shadow: true,
    size: 0.3,
    flicker: 1,
  }
  const staticLamp = b.lamp(staticSpec)

  // Ceilings and fixtures every 3 m; two flicker halfway down, three are dead.
  ceiling(b, x0, zn, x1, zs)
  ceiling(b, link.min[0], zs, link.max[0], lobbyZ - WALL_T)
  const dead = new Set([-24, -39, -48])
  const flickering = new Map([
    [-30, 0.85],
    [-33, 0.65],
  ])
  const flickers: { level: THREE.UniformNode<"float", number>; amount: number; seed: number; lamp: Lamp }[] = []
  for (let x = 0; x >= x0 + 1; x -= 3) {
    const f = flickering.get(x)
    if (dead.has(x)) {
      troffer(b, x, 0, "off", on)
      continue
    }
    const lamp = b.lamp(fluoro(x, 0, f))
    if (f !== undefined) {
      const p = fluorescentPanel(1)
      flickers.push({ level: p.level, amount: f, seed: -x, lamp })
      troffer(b, x, 0, { flicker: f, ...p }, on)
    } else troffer(b, x, 0, "on", on)
  }
  for (const z of [3.6, 7.2]) {
    troffer(b, 0, z, "on", on)
    b.lamp(fluoro(0, z))
  }

  // Exit sign and hazard lamp over the far doors.
  b.box(M.frame, x0 + 0.0, FLOOR_Y + DOOR_H + 0.25, -0.32, x0 + 0.12, FLOOR_Y + DOOR_H + 0.55, 0.32)
  b.box(M.exitSign, x0 + 0.12, FLOOR_Y + DOOR_H + 0.28, -0.29, x0 + 0.125, FLOOR_Y + DOOR_H + 0.52, 0.29, { cast: false })
  b.lamp({ kind: "exit", position: [x0 + 0.25, FLOOR_Y + DOOR_H + 0.4, 0], color: [1, 0.08, 0.04], intensity: 1.2, range: 3, size: 0.4 })

  // Wall-mounted caged hazard lights on the north wall; the one by the far doors glows.
  for (const [x, lit] of [
    [-18, false],
    [-37, false],
    [-49.6, true],
  ] as const) {
    hazardLight(b, x, zn, lit)
    if (lit) b.lamp({ kind: "warning", position: [x, FLOOR_Y + 2.55, zn + 0.2], color: [1, 0.12, 0.05], intensity: 1.5, range: 3, size: 0.12 })
  }

  // Exposed conduit along the top of the south wall, with straps, junction boxes and drops to the hazard lights.
  const cy = CEIL_Y - 0.12
  b.cyl("metal_galvanized", T((x0 + x1) / 2, cy, zs - 0.05, 0, 0, Math.PI / 2), 0.016, 0.016, x1 - x0, 6)
  b.cyl("metal_galvanized", T((x0 + x1) / 2, cy + 0.06, zs - 0.06, 0, 0, Math.PI / 2), 0.024, 0.024, x1 - x0, 6)
  for (let x = x0 + 1; x < x1; x += 1.5) b.box("metal_galvanized", x - 0.012, cy - 0.025, zs - 0.09, x + 0.012, cy + 0.09, zs)
  for (let x = x0 + 4.5; x < x1; x += 9) b.box("metal_painted", x - 0.1, cy - 0.06, zs - 0.07, x + 0.1, cy + 0.12, zs)
  b.cyl("metal_galvanized", T((x0 + x1) / 2, cy, zn + 0.05, 0, 0, Math.PI / 2), 0.016, 0.016, x1 - x0, 6)
  for (let x = x0 + 1; x < x1; x += 1.5) b.box("metal_galvanized", x - 0.012, cy - 0.025, zn, x + 0.012, cy + 0.025, zn + 0.08)
  for (const x of [-18, -37, -49.6]) b.cyl("metal_galvanized", T(x, (cy + FLOOR_Y + 2.7) / 2, zn + 0.05), 0.016, 0.016, cy - FLOOR_Y - 2.7, 6)


  // Fire extinguisher cabinet (north wall), drinking fountain and bulletin board (south wall).
  extinguisher(b, -31, zn)
  fountain(b, -27.4, zs)
  bulletin(b, -20.5, zs)
  fountain(b, -45.9, zs)

  return {
    update(time: number) {
      // Follow the light rig's flicker when it drives these lamps, so panel and light stutter together.
      for (const f of flickers) f.level.value = rigLevel(f.lamp) ?? flickerLevel(time, f.seed, f.amount)
      glow.level.value = 0.35 + 0.65 * (rigLevel(staticLamp) ?? flickerLevel(time * 1.7, 7, 0.9))
    },
  }
}

export const rigIndex = new Map<Lamp, number>()
export function rigLevel(lamp: Lamp): number | undefined {
  const list = renderState.lamps
  let i = rigIndex.get(lamp)
  if (i === undefined || list[i]?.lamp !== lamp) {
    i = list.findIndex((r) => r.lamp === lamp)
    if (i < 0) return undefined
    rigIndex.set(lamp, i)
  }
  return list[i]!.level
}

function norm(x: number, y: number, z: number): [number, number, number] {
  const l = Math.hypot(x, y, z)
  return [x / l, y / l, z / l]
}

export function fluoro(x: number, z: number, flicker?: number, intensity = 4): Lamp {
  return {
    kind: "fluorescent",
    // The rig drops omni lamps 0.12 m along their direction; keep the emitter just under the tiles so the ceiling
    // around each fixture stays dark (troffers don't light the ceiling they're recessed into).
    position: [x, CEIL_Y + 0.1, z],
    direction: [0, -1, 0],
    color: COOL,
    intensity,
    range: 7,
    angle: 1.3,
    penumbra: 0.7,
    size: 1.2,
    ...(flicker ? { flicker } : {}),
  }
}

export function hazardLight(b: Builder, x: number, zWall: number, lit: boolean) {
  const y = FLOOR_Y + 2.55
  const z = zWall
  b.box("metal_dark", x - 0.08, y - 0.1, z, x + 0.08, y - 0.06, z + 0.08)
  b.cyl(lit ? M.hazardRed : M.hazardOff, T(x, y, z + 0.1), 0.055, 0.06, 0.14, 12, { cast: false })
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4
    b.box("metal_dark", x + Math.cos(a) * 0.065 - 0.004, y - 0.07, z + 0.1 + Math.sin(a) * 0.065 - 0.004, x + Math.cos(a) * 0.065 + 0.004, y + 0.08, z + 0.1 + Math.sin(a) * 0.065 + 0.004)
  }
  b.cyl("metal_dark", T(x, y + 0.085, z + 0.1), 0.07, 0.07, 0.02, 12)
}

/** Recessed-look extinguisher cabinet (steel frame, felt back, glass front) with the extinguisher model inside, on a
 *  wall at zWall facing the corridor; signal panel above. Works on either corridor wall. */
export function extinguisher(b: Builder, x: number, zWall: number) {
  const y0 = FLOOR_Y + 0.9
  const s = zWall < 0 ? 1 : -1
  const z = zWall
  const d = 0.21
  const z1 = z + s * d
  const lo = Math.min(z, z1)
  const hi = Math.max(z, z1)
  b.box(M.frame, x - 0.3, y0, lo, x + 0.3, y0 + 0.03, hi)
  b.box(M.frame, x - 0.3, y0 + 0.77, lo, x + 0.3, y0 + 0.8, hi)
  b.box(M.frame, x - 0.3, y0, lo, x - 0.27, y0 + 0.8, hi)
  b.box(M.frame, x + 0.27, y0, lo, x + 0.3, y0 + 0.8, hi)
  b.box(M.felt, x - 0.27, y0 + 0.03, z + s * 0.004, x + 0.27, y0 + 0.77, z + s * 0.006, { cast: false })
  b.quad(M.glass, T(x, y0 + 0.4, z1 - s * 0.004, s > 0 ? 0 : Math.PI), 0.54, 0.74, { cast: false })
  b.box(M.steel, x + 0.2, y0 + 0.34, z1, x + 0.24, y0 + 0.46, z1 + s * 0.015)
  b.box(M.red, x - 0.18, y0 + 0.86, z, x + 0.18, y0 + 0.98, z + s * 0.02)
  placeModels(b, "fire_extinguisher", [
    { position: [x, y0 + 0.06, z + s * (0.02 + MODELS.fire_extinguisher.size[2] / 2)], yaw: s > 0 ? Math.PI : 0, collide: false, blob: 0 },
  ])
  b.collide(x - 0.3, y0, lo, x + 0.3, y0 + 0.8, hi)
}

/** Wall-hung steel drinking fountain (library model), back to the wall at zWall. */
export function fountain(b: Builder, x: number, zWall: number) {
  const s = zWall < 0 ? 1 : -1
  const [, , d] = MODELS.drinking_fountain.size
  placeModels(b, "drinking_fountain", [{ position: [x, FLOOR_Y + 0.3, zWall + (s * d) / 2], yaw: s > 0 ? Math.PI : 0, collide: false, blob: 0 }])
  b.collide(x - 0.24, FLOOR_Y, Math.min(zWall, zWall + s * d), x + 0.24, FLOOR_Y + 0.95, Math.max(zWall, zWall + s * d))
}

export function bulletin(b: Builder, x: number, zWall: number) {
  const y0 = FLOOR_Y + 1.05
  const z = zWall
  const w = 1.6
  const h = 0.95
  b.box(M.wood, x - w / 2 - 0.03, y0 - 0.03, z - 0.03, x + w / 2 + 0.03, y0 + h + 0.03, z)
  b.box(M.cork, x - w / 2, y0, z - 0.032, x + w / 2, y0 + h, z - 0.03, { cast: false })
  const papers = [
    [-0.55, 0.62, 0.22, 0.28, 0.03],
    [-0.25, 0.58, 0.22, 0.28, -0.04],
    [0.12, 0.66, 0.28, 0.2, 0.02],
    [0.5, 0.55, 0.22, 0.28, 0.06],
    [-0.5, 0.24, 0.3, 0.22, -0.02],
    [-0.08, 0.22, 0.22, 0.28, 0.0],
    [0.36, 0.25, 0.22, 0.28, -0.05],
  ] as const
  papers.forEach(([px, py, pw, ph, r], i) => {
    b.quad(M.paper, T(x - px, y0 + py, z - 0.034 - i * 0.0004, Math.PI, 0, r), pw, ph, { cast: false })
  })
}
