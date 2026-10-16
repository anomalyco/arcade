import { buildFoliageBush, buildFoliageTree, emitGrassClump, scatterGrassClumps, type FoliageParams } from "../../gpu/foliage"
import type { LevelData } from "../../gpu/level"
import { MAT, Mesh, hex, type Rgb } from "../../gpu/mesh"
import type { SceneLight } from "../../gpu/scene-frame"
import { flatLighting } from "../../gpu/scene-frame"
import type { Rect } from "../../sim/geom"
import { Rng } from "../../sim/rng"

/**
 * The Lab's base scene: a few metres of street in front of a house corner, built from the kit renderer's own mesh
 * materials (`MAT`, the floor patterns) and the production foliage generators. Everything sits in positive plan
 * coordinates because the renderer's floor and bounce maps cover [0, MAP] on both axes.
 *
 *   z  8–14  house: front wall with a doorway and a window, a side wall at x = 19 (the corner), planks inside
 *   z 14–17  front yard: lawn, a flagstone path to the door, a bush and a tree
 *   z 17–19  sidewalk with a streetlamp and a character
 *   z 19–26  street with a parked car and a puddle by the curb, far sidewalk beyond
 */
export const WORLD_MAP = 40
/**
 * The set is laid out in the plan coordinates above and then moved so the street sits at the Lab origin, where
 * effects spawn. The renderer's floor and bounce maps are uniform here, so negative plan coordinates are fine.
 */
export const WORLD_ORIGIN = [19, 21] as const
export const WORLD_FOCUS = [0.2, 0.9, -3.8] as const
export const WORLD_CAMERA = { yaw: 0.5, pitch: 0.44, dist: 18.5 } as const

/** Floor pattern ids from the kit scene shader's `floorPattern`. */
export const FLOOR = { carpet: 0, lino: 1, planks: 2, concrete: 3, asphalt: 5, sidewalk: 6, plaza: 7, grass: 8, wetAsphalt: 9, flagstone: 10 } as const

export const WALL_PAINTS = {
  clapboard: { label: "White clapboard", color: 0xb9b3a4, trim: 0xe6e0d0 },
  sage: { label: "Sage", color: 0x7d8a72, trim: 0xd9d4c2 },
  brick: { label: "Brick red", color: 0x8a4a38, trim: 0xd2c7b0 },
  slate: { label: "Blue grey", color: 0x5f6b78, trim: 0xd8dde0 },
} as const
export type WallPaint = keyof typeof WALL_PAINTS

export const CAR_PAINTS = {
  red: { label: "Cherry red", color: 0x8e1c18 },
  teal: { label: "Teal", color: 0x1f6a6a },
  cream: { label: "Cream", color: 0xd8cfb4 },
  black: { label: "Black", color: 0x15171b },
} as const
export type CarPaint = keyof typeof CAR_PAINTS

export type WorldBuild = {
  seed: number
  street: number
  walk: number
  path: number
  floor: number
  wall: WallPaint
  car: CarPaint
  vegetation: Readonly<FoliageParams>
  tree: boolean
  bush: boolean
  grass: boolean
}

/** Fixture ids for `MAT.lamp`: the renderer dims each by `lampPower[id]`. */
export const LAMP = { porch: 0, street: 1, interior: 2, headlights: 3 } as const
export const LAMP_COUNT = 4

export type WorldGeometry = {
  level: LevelData
  /** Static light occluders: plan rect and height. */
  boxes: { rect: Rect; h: number }[]
  /** Round casters: the tree trunk, the lamp pole and the character. */
  casters: { x: number; y: number; r: number; h: number }[]
  vertices: number
}

const rgb = hex
const shade = (c: Rgb, k: number): Rgb => [c[0] * k, c[1] * k, c[2] * k]

const HOUSE = { x0: 11, x1: 19, z0: 8, z1: 14, h: 2.9 } as const
const DOOR = { x0: 15.2, x1: 16.2, h: 2.15 } as const
const WINDOW = { x0: 12, x1: 14, y0: 1.0, y1: 2.2 } as const
const SIDE_WINDOW = { z0: 10, z1: 11.6, y0: 1.0, y1: 2.2 } as const
export const TREE_AT = [23.6, 15.4] as const
export const BUSH_AT = [18.2, 15.0] as const
export const CHARACTER_AT = [18.6, 18.1] as const
export const STREETLAMP_AT = [21.2, 18.5] as const
export const CAR_BOX = { x0: 23.4, x1: 27.8, z0: 19.7, z1: 21.5 } as const
export const PUDDLE_AT = [17.4, 20.4] as const
export const INTERIOR_LIGHT = [15.0, 11.0] as const

export function buildWorld(b: WorldBuild): WorldGeometry {
  const m = new Mesh()
  const glass = new Mesh()
  const boxes: { rect: Rect; h: number }[] = []
  const casters: { x: number; y: number; r: number; h: number }[] = []
  const F = MAT.floor

  // Ground well beyond the set (rough grass), so the edges fall away instead of ending in void.
  m.quad([-40, -0.03, 80], [80, -0.03, 80], [80, -0.03, -40], [-40, -0.03, -40], [0, 1, 0], rgb(0x2c3622), F, FLOOR.grass)

  // Street, curbs, sidewalks.
  m.box(2, -0.06, 19.2, 38, 0, 26, rgb(0x34373b), F, b.street)
  for (let x = 4; x < 37; x += 3) m.box(x, 0.001, 22.55, x + 1.6, 0.004, 22.7, rgb(0xc9a645), MAT.tape)
  m.box(2, 0, 19, 38, 0.13, 19.2, rgb(0x8d8a82), F, FLOOR.concrete)
  m.box(2, 0, 26, 38, 0.13, 26.2, rgb(0x8d8a82), F, FLOOR.concrete)
  m.box(2, 0, 17, 38, 0.12, 19, rgb(0x8f8b83), F, b.walk)
  m.box(2, 0, 26.2, 38, 0.12, 28.2, rgb(0x8f8b83), F, b.walk)
  // A low garden wall and a dark hedge-line across the street keep the background from reading as void.
  m.box(2, 0.12, 28.2, 38, 0.75, 28.5, rgb(0x6d665c), MAT.lit)
  m.box(2, 0, 28.5, 38, 1.6, 30.5, rgb(0x1d2a1a), MAT.lit)
  // The puddle by the near curb: a smooth, slightly darker, glossy sheet just above the asphalt that catches the lamps.
  const [px, pz] = PUDDLE_AT
  const rim = (a: number) => 1 + 0.12 * Math.sin(a * 2 + 0.6) + 0.06 * Math.sin(a * 3 + 1.9)
  for (let i = 0; i < 28; i++) {
    const a0 = (i / 28) * Math.PI * 2, a1 = ((i + 1) / 28) * Math.PI * 2
    const at = (a: number) => [px + Math.cos(a) * rim(a) * 1.5, 0.004, pz + Math.sin(a) * rim(a) * 0.5]
    m.quad([px, 0.004, pz], at(a1), at(a0), [px, 0.004, pz], [0, 1, 0], rgb(0x23272c), MAT.shiny)
  }

  // Front yard: lawn on either side of a flagstone path to the door; a driveway to the left.
  m.box(8, -0.02, 14, 38, 0.02, 17, rgb(0x3d4a2a), F, FLOOR.grass)
  m.box(DOOR.x0 - 0.1, 0, 14, DOOR.x1 + 0.1, 0.035, 17, rgb(0x8c8478), F, b.path)
  m.box(2, -0.02, 8, 11, 0.025, 17, rgb(0x6f6c66), F, FLOOR.concrete)
  m.box(19, -0.02, 6, 38, 0.02, 14, rgb(0x3a4628), F, FLOOR.grass)
  m.box(2, -0.02, 2, 38, 0.02, 8, rgb(0x343f25), F, FLOOR.grass)
  // A board fence along the back of the lot and a dark tree line beyond it.
  for (let x = 2; x < 38; x += 0.16) m.box(x, 0, 2.4, x + 0.13, 1.5 + 0.06 * Math.sin(x * 7.1), 2.5, rgb(0x5a4a3a), MAT.lit)
  m.box(-20, 0, -6, 60, 3.2, 1.6, rgb(0x16201a), MAT.lit)

  addHouse(m, glass, b, boxes)
  addStreetlamp(m, boxes, casters)
  addCar(m, glass, b, boxes)
  addCharacter(m, casters)

  // Vegetation from the production generators: a tree, a foundation bush and lawn grass around them.
  const veg = b.vegetation
  if (b.tree) {
    const [tx, tz] = TREE_AT
    buildFoliageTree(m, tx, tz, veg.treeHeight, veg.crownRadius, b.seed * 31 + 7, 0.02, veg, veg.crownShape)
    casters.push({ x: tx, y: tz, r: 0.22, h: veg.treeHeight * 0.55 })
  }
  if (b.bush) {
    const [bx, bz] = BUSH_AT
    buildFoliageBush(m, bx, bz, veg.bushHeight, veg.bushSpread, b.seed * 17 + 3, 0.02, veg)
    buildFoliageBush(m, 12.6, 14.7, veg.bushHeight * 0.85, veg.bushSpread * 0.9, b.seed * 23 + 5, 0.02, veg)
    boxes.push({ rect: [bx - 0.5, bz - 0.4, bx + 0.5, bz + 0.4], h: veg.bushHeight * 0.8 })
  }
  if (b.grass) {
    const rng = new Rng(b.seed ^ 0x51a9)
    const avoid = (x: number, z: number) =>
      (x > DOOR.x0 - 0.2 && x < DOOR.x1 + 0.2) || Math.hypot(x - TREE_AT[0], z - TREE_AT[1]) < 0.4 || Math.hypot(x - BUSH_AT[0], z - BUSH_AT[1]) < 0.6
    for (const c of scatterGrassClumps({ seed: b.seed, bounds: [8.4, 14.2, 30, 16.8], clusterCount: 70, tuftsPerCluster: 4, params: veg, avoid })) {
      emitGrassClump(m, c, 0.02, rng, 1.05)
    }
  }

  const [ox, oz] = WORLD_ORIGIN
  m.place(0, 0, -ox, 0, -oz)
  glass.place(0, 0, -ox, 0, -oz)
  for (const b of boxes) b.rect = [b.rect[0] - ox, b.rect[1] - oz, b.rect[2] - ox, b.rect[3] - oz]
  for (const c of casters) { c.x -= ox; c.y -= oz }
  const data = m.pack()
  const glassData = glass.pack()
  const lighting = flatLighting(0, 1, [0.46, 0.46, 0.42])
  return {
    level: {
      chunks: [{ data, box: [-ox, -oz, WORLD_MAP - ox, WORLD_MAP - oz] }],
      glass: glassData.byteLength ? [{ data: glassData, box: [-ox, -oz, WORLD_MAP - ox, WORLD_MAP - oz] }] : [],
      floor: lighting.floor,
      bounce: lighting.bounce,
    },
    boxes,
    casters,
    vertices: (m.v.length + glass.v.length) / 11,
  }
}

function addHouse(m: Mesh, glass: Mesh, b: WorldBuild, boxes: { rect: Rect; h: number }[]): void {
  const paint = WALL_PAINTS[b.wall] ?? WALL_PAINTS.clapboard
  const wall = rgb(paint.color), trim = rgb(paint.trim)
  const { x0, x1, z0, z1, h } = HOUSE
  const t = 0.18
  // Foundation and the floor inside.
  m.box(x0 - 0.05, 0, z0 - 0.05, x1 + 0.05, 0.22, z1 + 0.05, rgb(0x6a655d), MAT.lit)
  m.box(x0 + t, 0.22, z0 + t, x1 - t, 0.24, z1 - t, rgb(0x8a6440), MAT.floor, b.floor)
  // Back and left walls.
  m.box(x0, 0.22, z0, x1, h, z0 + t, wall, MAT.wall)
  m.box(x0, 0.22, z0, x0 + t, h, z1, wall, MAT.wall)
  boxes.push({ rect: [x0, z0, x1, z0 + t], h }, { rect: [x0, z0, x0 + t, z1], h })
  // Front wall around the doorway and the window.
  const fz0 = z1 - t, fz1 = z1
  m.box(x0, 0.22, fz0, WINDOW.x0, h, fz1, wall, MAT.wall)
  m.box(WINDOW.x0, 0.22, fz0, WINDOW.x1, WINDOW.y0, fz1, wall, MAT.wall)
  m.box(WINDOW.x0, WINDOW.y1, fz0, WINDOW.x1, h, fz1, wall, MAT.wall)
  m.box(WINDOW.x1, 0.22, fz0, DOOR.x0, h, fz1, wall, MAT.wall)
  m.box(DOOR.x0, DOOR.h, fz0, DOOR.x1, h, fz1, wall, MAT.wall)
  m.box(DOOR.x1, 0.22, fz0, x1, h, fz1, wall, MAT.wall)
  boxes.push({ rect: [x0, fz0, WINDOW.x0, fz1], h }, { rect: [WINDOW.x0, fz0, WINDOW.x1, fz1], h: WINDOW.y0 }, { rect: [WINDOW.x1, fz0, DOOR.x0, fz1], h }, { rect: [DOOR.x1, fz0, x1, fz1], h })
  // Side wall at the corner (x = x1) with a window.
  const sx0 = x1 - t
  m.box(sx0, 0.22, z0, x1, h, SIDE_WINDOW.z0, wall, MAT.wall)
  m.box(sx0, 0.22, SIDE_WINDOW.z0, x1, SIDE_WINDOW.y0, SIDE_WINDOW.z1, wall, MAT.wall)
  m.box(sx0, SIDE_WINDOW.y1, SIDE_WINDOW.z0, x1, h, SIDE_WINDOW.z1, wall, MAT.wall)
  m.box(sx0, 0.22, SIDE_WINDOW.z1, x1, h, z1, wall, MAT.wall)
  boxes.push({ rect: [sx0, z0, x1, SIDE_WINDOW.z0], h }, { rect: [sx0, SIDE_WINDOW.z0, x1, SIDE_WINDOW.z1], h: SIDE_WINDOW.y0 }, { rect: [sx0, SIDE_WINDOW.z1, x1, z1], h })
  // Clapboard lap lines on the street-facing walls.
  for (let y = 0.5; y < h - 0.1; y += 0.26) {
    m.box(x0, y, fz1, WINDOW.x0, y + 0.025, fz1 + 0.012, shade(wall, 0.82), MAT.lit)
    m.box(DOOR.x1, y, fz1, x1, y + 0.025, fz1 + 0.012, shade(wall, 0.82), MAT.lit)
    m.box(x1, y, z0, x1 + 0.012, y + 0.025, SIDE_WINDOW.z0, shade(wall, 0.82), MAT.lit)
    m.box(x1, y, SIDE_WINDOW.z1, x1 + 0.012, y + 0.025, z1, shade(wall, 0.82), MAT.lit)
  }
  // Trim: corner boards, window and door casings, sills.
  m.box(x1 - 0.02, 0.22, z1 - 0.02, x1 + 0.08, h, z1 + 0.08, trim, MAT.lit)
  m.box(x0 - 0.06, 0.22, z1 - 0.02, x0 + 0.04, h, z1 + 0.08, trim, MAT.lit)
  const casing = (ax: number, ay: number, bx: number, by: number) => {
    m.box(ax - 0.1, ay - 0.08, fz1, bx + 0.1, ay, fz1 + 0.09, trim, MAT.lit)
    m.box(ax - 0.1, by, fz1, bx + 0.1, by + 0.1, fz1 + 0.06, trim, MAT.lit)
    m.box(ax - 0.1, ay, fz1, ax, by, fz1 + 0.06, trim, MAT.lit)
    m.box(bx, ay, fz1, bx + 0.1, by, fz1 + 0.06, trim, MAT.lit)
  }
  casing(WINDOW.x0, WINDOW.y0, WINDOW.x1, WINDOW.y1)
  m.box((WINDOW.x0 + WINDOW.x1) / 2 - 0.03, WINDOW.y0, fz0 + 0.07, (WINDOW.x0 + WINDOW.x1) / 2 + 0.03, WINDOW.y1, fz0 + 0.11, trim, MAT.lit)
  m.box(DOOR.x0 - 0.1, 0.22, fz1, DOOR.x0, DOOR.h + 0.1, fz1 + 0.06, trim, MAT.lit)
  m.box(DOOR.x1, 0.22, fz1, DOOR.x1 + 0.1, DOOR.h + 0.1, fz1 + 0.06, trim, MAT.lit)
  m.box(DOOR.x0 - 0.1, DOOR.h, fz1, DOOR.x1 + 0.1, DOOR.h + 0.12, fz1 + 0.06, trim, MAT.lit)
  m.box(x1, SIDE_WINDOW.y0 - 0.08, SIDE_WINDOW.z0 - 0.1, x1 + 0.09, SIDE_WINDOW.y0, SIDE_WINDOW.z1 + 0.1, trim, MAT.lit)
  m.box(x1, SIDE_WINDOW.y1, SIDE_WINDOW.z0 - 0.1, x1 + 0.06, SIDE_WINDOW.y1 + 0.1, SIDE_WINDOW.z1 + 0.1, trim, MAT.lit)
  // Glazing (translucent: it picks up the interior lamp).
  glass.quad([WINDOW.x0, WINDOW.y0, fz0 + 0.09], [WINDOW.x1, WINDOW.y0, fz0 + 0.09], [WINDOW.x1, WINDOW.y1, fz0 + 0.09], [WINDOW.x0, WINDOW.y1, fz0 + 0.09], [0, 0, 1], rgb(0x9fb4c4), MAT.glass)
  glass.quad([x1 - 0.09, SIDE_WINDOW.y0, SIDE_WINDOW.z1], [x1 - 0.09, SIDE_WINDOW.y0, SIDE_WINDOW.z0], [x1 - 0.09, SIDE_WINDOW.y1, SIDE_WINDOW.z0], [x1 - 0.09, SIDE_WINDOW.y1, SIDE_WINDOW.z1], [1, 0, 0], rgb(0x9fb4c4), MAT.glass)
  // The door stands open into the room.
  m.yawBox(DOOR.x0 + 0.05, fz0 - 0.48, 0.06, 0.95, 0.24, DOOR.h - 0.04, 0, rgb(0x4b3424), MAT.lit)
  // Porch step, porch lamp beside the door, and the interior: a table lamp, a rug-coloured block, a bookcase.
  m.box(DOOR.x0 - 0.45, 0, z1, DOOR.x1 + 0.45, 0.16, z1 + 0.7, rgb(0x7c766c), MAT.floor, FLOOR.concrete)
  m.box(DOOR.x1 + 0.22, 1.85, fz1 + 0.04, DOOR.x1 + 0.36, 2.15, fz1 + 0.18, rgb(0xffd79a), MAT.lamp, LAMP.porch)
  const [ix, iz] = INTERIOR_LIGHT
  m.box(12.6, 0.24, 9.4, 17.6, 0.25, 12.6, rgb(0x6e2a22), MAT.lit)
  m.prism(ix, iz, 0.06, 0.06, 0.24, 1.2, 8, rgb(0x2b2622))
  m.prism(ix, iz, 0.28, 0.16, 1.2, 1.5, 10, rgb(0xffe2b0), MAT.lamp, LAMP.interior)
  m.box(11.3, 0.24, 8.3, 13.4, 2.1, 8.7, rgb(0x3b2a1e), MAT.lit)
  // Roof: a shallow gable along x with eaves overhanging every wall.
  const ex0 = x0 - 0.45, ex1 = x1 + 0.45, ez0 = z0 - 0.45, ez1 = z1 + 0.45, ridge = h + 1.35, mid = (z0 + z1) / 2
  const roof = rgb(0x3b3532)
  m.quadAuto([ex0, h - 0.05, ez1], [ex1, h - 0.05, ez1], [ex1, ridge, mid], [ex0, ridge, mid], roof, MAT.roof)
  m.quadAuto([ex1, h - 0.05, ez0], [ex0, h - 0.05, ez0], [ex0, ridge, mid], [ex1, ridge, mid], roof, MAT.roof)
  m.facet([x1, h, z0], [x1, h, z1], [x1, ridge - 0.05, mid], wall, MAT.wall)
  m.facet([x0, h, z1], [x0, h, z0], [x0, ridge - 0.05, mid], wall, MAT.wall)
  m.box(ex0, h - 0.18, ez1 - 0.06, ex1, h - 0.02, ez1, trim, MAT.lit)
}

function addStreetlamp(m: Mesh, boxes: { rect: Rect; h: number }[], casters: { x: number; y: number; r: number; h: number }[]): void {
  const [lx, lz] = STREETLAMP_AT
  const pole = rgb(0x2f3436)
  m.prism(lx, lz, 0.13, 0.07, 0.12, 4.4, 8, pole)
  m.box(lx - 0.04, 4.2, lz, lx + 0.04, 4.32, lz + 1.5, pole)
  m.box(lx - 0.2, 4.08, lz + 1.25, lx + 0.2, 4.24, lz + 1.85, pole)
  m.box(lx - 0.16, 4.03, lz + 1.3, lx + 0.16, 4.08, lz + 1.8, rgb(0xffc27a), MAT.lamp, LAMP.street)
  casters.push({ x: lx, y: lz, r: 0.1, h: 4.3 })
  void boxes
}

function addCar(m: Mesh, glass: Mesh, b: WorldBuild, boxes: { rect: Rect; h: number }[]): void {
  const paint = rgb((CAR_PAINTS[b.car] ?? CAR_PAINTS.red).color)
  const { x0, x1, z0, z1 } = CAR_BOX
  const dark = rgb(0x121314), chrome = rgb(0xb8bcc0)
  // Body, a lower sill, the cabin and its glass; front at x1.
  m.bevelBox(x0, 0.32, z0, x1, 0.95, z1, 0.08, paint, paint, MAT.shiny)
  m.box(x0 + 0.05, 0.2, z0 + 0.05, x1 - 0.05, 0.34, z1 - 0.05, dark, MAT.lit)
  const c0 = x0 + 1.05, c1 = x1 - 1.3
  m.box(c0 + 0.12, 0.95, z0 + 0.12, c1 - 0.08, 1.42, z1 - 0.12, paint, MAT.shiny)
  m.box(c0 + 0.2, 1.42, z0 + 0.16, c1 - 0.14, 1.47, z1 - 0.16, paint, MAT.shiny)
  glass.quad([c0 + 0.13, 1.0, z1 - 0.115], [c1 - 0.09, 1.0, z1 - 0.115], [c1 - 0.09, 1.38, z1 - 0.115], [c0 + 0.13, 1.38, z1 - 0.115], [0, 0, 1], rgb(0x7b8a96), MAT.glass)
  glass.quad([c1 - 0.075, 1.0, z1 - 0.15], [c1 - 0.075, 1.0, z0 + 0.15], [c1 - 0.075, 1.38, z0 + 0.15], [c1 - 0.075, 1.38, z1 - 0.15], [1, 0, 0], rgb(0x7b8a96), MAT.glass)
  // Wheels, bumpers, lights.
  for (const wx of [x0 + 0.8, x1 - 0.8]) {
    for (const wz of [z0 + 0.02, z1 - 0.26]) {
      m.box(wx - 0.36, 0, wz, wx + 0.36, 0.66, wz + 0.24, dark, MAT.lit)
      m.box(wx - 0.18, 0.15, wz - 0.005, wx + 0.18, 0.51, wz + 0.25, rgb(0x5a5d61), MAT.shiny)
    }
  }
  m.box(x1 - 0.02, 0.3, z0 + 0.1, x1 + 0.08, 0.46, z1 - 0.1, chrome, MAT.shiny)
  m.box(x0 - 0.08, 0.3, z0 + 0.1, x0 + 0.02, 0.46, z1 - 0.1, chrome, MAT.shiny)
  m.box(x1 - 0.01, 0.62, z0 + 0.15, x1 + 0.02, 0.78, z0 + 0.45, rgb(0xfff2d0), MAT.lamp, LAMP.headlights)
  m.box(x1 - 0.01, 0.62, z1 - 0.45, x1 + 0.02, 0.78, z1 - 0.15, rgb(0xfff2d0), MAT.lamp, LAMP.headlights)
  m.box(x0 - 0.02, 0.66, z0 + 0.12, x0 + 0.01, 0.8, z0 + 0.4, rgb(0xb01010), MAT.glow, 0.6)
  m.box(x0 - 0.02, 0.66, z1 - 0.4, x0 + 0.01, 0.8, z1 - 0.12, rgb(0xb01010), MAT.glow, 0.6)
  boxes.push({ rect: [x0, z0, x1, z1], h: 1.45 })
}

/** A standing figure facing the street: boots, jeans, a long coat, scarf and head. */
function addCharacter(m: Mesh, casters: { x: number; y: number; r: number; h: number }[]): void {
  const [cx, cz] = CHARACTER_AT
  const A = MAT.actor
  const y = 0.12
  for (const dx of [-0.11, 0.11]) {
    m.prism(cx + dx, cz, 0.075, 0.07, y, y + 0.12, 8, rgb(0x1c1814), A)
    m.prism(cx + dx, cz, 0.08, 0.075, y + 0.12, y + 0.82, 8, rgb(0x2c3a52), A)
  }
  m.prism(cx, cz, 0.27, 0.22, y + 0.62, y + 1.42, 10, rgb(0x5a4632), A)
  m.prism(cx, cz, 0.2, 0.15, y + 1.42, y + 1.5, 10, rgb(0x8a2a24), A)
  for (const dx of [-0.29, 0.29]) m.prism(cx + dx, cz + 0.02, 0.07, 0.06, y + 0.82, y + 1.4, 8, rgb(0x4e3d2c), A)
  m.prism(cx, cz, 0.06, 0.06, y + 1.5, y + 1.56, 8, rgb(0xc89a7c), A)
  m.prism(cx, cz, 0.12, 0.1, y + 1.56, y + 1.8, 10, rgb(0xc89a7c), A)
  m.prism(cx, cz, 0.125, 0.06, y + 1.76, y + 1.86, 10, rgb(0x2a201a), A)
  casters.push({ x: cx, y: cz, r: 0.26, h: 1.8 })
}

/** Light from the time of day: what the sky, sun or moon and the practical lamps do at `hour` (0–24). */
export type WorldClock = {
  hour: number
  /** 1 at noon, 0 at night, between in the dusk and dawn windows. */
  day: number
  /** Sky ambient (linear rgb) and moonlight strength, as `Frame.ambient`. */
  ambient: [number, number, number, number]
  /** The high key light standing in for the sun or moon (a point light far above, so walls and the car shade). */
  key: { color: [number, number, number]; power: number; x: number; y: number; h: number }
  /** How strongly the practical lamps are on (0 by day). */
  lamps: number
  exposure: number
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
const mix3 = (a: readonly number[], b: readonly number[], t: number): [number, number, number] => [a[0]! + (b[0]! - a[0]!) * t, a[1]! + (b[1]! - a[1]!) * t, a[2]! + (b[2]! - a[2]!) * t]

export function worldClock(hour: number): WorldClock {
  const h = ((hour % 24) + 24) % 24
  // Day ramps up 6–8 and down 17–20.5; dusk is the warm band around sunset.
  const day = smooth(5.8, 8, h) * (1 - smooth(17, 20.5, h))
  const dusk = Math.max(0, 1 - Math.abs(h - 19) / 1.7) * (h > 15 ? 1 : 0) + Math.max(0, 1 - Math.abs(h - 6.6) / 1.2)
  const night = 1 - day
  const skyNight = [0.03, 0.04, 0.075], skyDay = [0.42, 0.48, 0.56], skyDusk = [0.36, 0.24, 0.26]
  const sky = mix3(mix3(skyNight, skyDay, day), skyDusk, Math.min(1, dusk) * 0.65)
  // The sun swings east to west across the morning and afternoon; the moon sits high in the south-west.
  const sunAngle = ((h - 6) / 12) * Math.PI
  const sunX = WORLD_FOCUS[0] - Math.cos(sunAngle) * 16
  const sunY = WORLD_FOCUS[2] - 9
  const sunCol = mix3([1, 0.95, 0.86], [1, 0.58, 0.3], Math.min(1, dusk))
  const moonCol: [number, number, number] = [0.5, 0.62, 0.95]
  const key = day > 0.05
    ? { color: sunCol, power: 0.35 + day * 0.75, x: sunX, y: sunY, h: 8 + Math.sin(Math.max(0.15, sunAngle)) * 18 }
    : { color: moonCol, power: 0.22, x: WORLD_FOCUS[0] - 10, y: WORLD_FOCUS[2] - 12, h: 22 }
  return {
    hour: h,
    day,
    ambient: [sky[0], sky[1], sky[2], 0.35 * night],
    key,
    lamps: smooth(0.35, 0.95, night + Math.min(1, dusk) * 0.25),
    exposure: 1 + 0.25 * night,
  }
}

/** The world's practical lights at a clock: porch, streetlamp, the lamp inside, headlights when on. */
export function worldLights(clock: WorldClock, opts: { lampPower: number; headlights: boolean; flashlight: boolean; porch: boolean }): SceneLight[] {
  const k = clock.lamps * opts.lampPower
  const [lx, lz] = STREETLAMP_AT
  const [ix, iz] = INTERIOR_LIGHT
  const lights: SceneLight[] = [
    { x: clock.key.x, y: clock.key.y, h: clock.key.h, r: 46, color: clock.key.color, power: clock.key.power, size: 1.4 },
  ]
  if (k > 0.01) {
    lights.push({ x: lx, y: lz + 1.55, h: 4.0, r: 10, color: [1, 0.66, 0.32], power: 1.1 * k, size: 0.35 })
    lights.push({ x: ix, y: iz, h: 1.5, r: 7, color: [1, 0.72, 0.42], power: 0.9 * k, size: 0.3 })
    if (opts.porch) lights.push({ x: DOOR.x1 + 0.3, y: HOUSE.z1 + 0.3, h: 2.0, r: 5, color: [1, 0.78, 0.5], power: 0.7 * k, size: 0.2 })
  }
  if (opts.headlights) {
    for (const dz of [0.3, 1.5]) {
      lights.push({ x: CAR_BOX.x1 + 0.1, y: CAR_BOX.z0 + dz, h: 0.7, r: 12, color: [1, 0.95, 0.85], power: 1.2, size: 0.15, cone: [1, 0, Math.cos(0.42)] })
    }
  }
  if (opts.flashlight) {
    const [cx, cz] = CHARACTER_AT
    lights.push({ x: cx + 0.2, y: cz + 0.3, h: 1.3, r: 9, color: [0.98, 0.95, 0.88], power: 1.4, size: 0.1, cone: [0.35, 0.94, Math.cos(0.36)] })
  }
  const [ox, oz] = WORLD_ORIGIN
  for (const l of lights.slice(1)) { l.x -= ox; l.y -= oz }
  return lights
}
