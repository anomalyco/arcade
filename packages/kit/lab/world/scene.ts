import { buildFoliageBush, buildFoliageTree, cloneFoliageParams, emitGrassClump, scatterGrassClumps, type FoliageParams } from "../../gpu/foliage"
import { HOUSE_LIGHTMAP_META, applyBakedUv2ToMesh, extractBakeSceneSpec, type BakeSceneSpec } from "../../gpu/gi/lightmap"
import type { LevelData } from "../../gpu/level"
import { finishTagged } from "../../gpu/finish"
import { lookIndex, type FinishLookId } from "../../gpu/materials/wear"
import { FLOATS_PER_VERT, MAT, Mesh, hex, type Rgb } from "../../gpu/mesh"
import { coldSodiumTint, type FlickerSample } from "../../gpu/lights/flicker"
import { cagedBulbMesh, fluorescentTubeMesh, ledIndicatorMesh, type CagedBulb, type FluorescentTube, type LedIndicator } from "../../gpu/lights/practicals"
import { screenSceneLight, type ScreenPlacement } from "../../gpu/screen/light"
import { createScreenDisplaySettings } from "../../gpu/screen/settings"
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
  /** The screen bench inside the house: a CRT television and a tape deck on a workbench (`screen` lab). */
  screen?: boolean
  /** Practical fixtures over the bench: a failing fluorescent tube and a caged bulb on the side wall. */
  tube?: boolean
  bulb?: boolean
  /** A row of finished props on the driveway, one per wear look (`gpu/finish`, `finishedProps` preset). */
  finishProps?: boolean
  /** The `baked-gi` room: ceiling soffit, bookcase shelves, interior dynamic actor, shaded lamp cone and Blender UV2s. */
  bakedRoom?: boolean
}

/** The world's flat bounce fill (`flatLighting`): daylight and sky returned off the ground, everywhere. */
export const WORLD_BOUNCE = [0.46, 0.46, 0.42] as const

/** Fixture ids for `MAT.lamp`: the renderer dims each by `lampPower[id]`. */
export const LAMP = { porch: 0, street: 1, interior: 2, headlights: 3, tube: 4, bulb: 5, tvLed: 6, deckLed: 7 } as const
export const LAMP_COUNT = 8

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
export const INTERIOR_ACTOR_AT = [13.2, 9.7] as const
/** Where the baked-GI preset looks from: inside the room viewing the table lamp, rug, bookcase, actor, ceiling, and CRT workbench. */
export const BAKED_GI_CAMERA = { target: [-4.72, 1.42, -11.15] as const, yaw: -0.52, pitch: -0.01, dist: 4.35 } as const
/** `SceneLight.id`s of the screen bench's lights. */
export const SCREEN_LIGHT_ID = { screen: 20, tube: 21, bulb: 22, tvLed: 23, deckLed: 24, deckActivity: 25 } as const
/** Reference emission (`display.emission()`) at which the `screen` (`id = 20`) area panel is baked in Cycles. */
export const SCREEN_BAKE_REFERENCE = 60

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
  if (b.screen) addScreenBench(m, b)
  if (b.finishProps) addFinishedProps(m)
  addStreetlamp(m, boxes, casters)
  addCar(m, glass, b, boxes)
  addCharacter(m, casters)
  if (b.bakedRoom) addCharacterAt(m, casters, INTERIOR_ACTOR_AT[0], INTERIOR_ACTOR_AT[1], 0.24)

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

  // After everything else is built, so the house, driveway and lawn occlude the props' bake.
  if (b.finishProps) finishTagged(m, { ground: DRIVEWAY_Y })

  const [ox, oz] = WORLD_ORIGIN
  m.place(0, 0, -ox, 0, -oz)
  glass.place(0, 0, -ox, 0, -oz)
  for (const b of boxes) b.rect = [b.rect[0] - ox, b.rect[1] - oz, b.rect[2] - ox, b.rect[3] - oz]
  for (const c of casters) { c.x -= ox; c.y -= oz }
  const data = m.pack()
  if (b.bakedRoom) applyBakedUv2ToMesh(data, HOUSE_LIGHTMAP_META)
  const glassData = glass.pack()
  const lighting = flatLighting(0, 1, WORLD_BOUNCE)
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

/** Driveway surface height (the concrete box's top) the finished props stand on. */
const DRIVEWAY_Y = 0.025
/** Plan x of each finished prop along the driveway at `FINISHED_Z`, in `FINISHED_LOOKS` order. */
const FINISHED_X = [3.5, 4.72, 5.92, 6.8, 7.74, 8.79] as const
const FINISHED_Z = 15.4
export const FINISHED_LOOKS = ["worn-lab-metal", "damp-cinderblock", "old-wood", "painted-steel", "wet-bark", "weathered-stone"] as const satisfies readonly FinishLookId[]
/**
 * The finished props from the driveway's edge, close enough that chamfers, grime and scan detail read: all six fit
 * a 1.26:1 canvas at the stage's 0.65 rad field of view.
 */
export const FINISHED_CAMERA = { target: [6.13 - WORLD_ORIGIN[0], 0.45, FINISHED_Z - WORLD_ORIGIN[1]] as const, yaw: 0.12, pitch: 0.3, dist: 8 } as const

/**
 * One prop per wear look on the driveway, built chamfered and tagged with `Mesh.finishPart`; `buildWorld` bakes them
 * (`finishTagged`) once the rest of the set is in place. Looks that replace the albedo (metal, cinderblock, painted
 * steel) ignore the vertex colour; the others wear it.
 */
function addFinishedProps(m: Mesh): void {
  const y = DRIVEWAY_Y, z = FINISHED_Z
  const part = (id: FinishLookId, build: () => void) => m.finishPart(lookIndex(id), build, "auto")
  const at = (id: FinishLookId) => FINISHED_X[FINISHED_LOOKS.indexOf(id as (typeof FINISHED_LOOKS)[number])]!
  // Worn lab metal: a cabinet on a plinth, two doors with a reveal between them and a bar handle.
  part("worn-lab-metal", () => {
    const x = at("worn-lab-metal"), c = rgb(0x8f9294)
    m.box(x - 0.3, y, z - 0.22, x + 0.3, y + 0.08, z + 0.2, shade(c, 0.6))
    m.box(x - 0.32, y + 0.08, z - 0.24, x + 0.32, y + 1.36, z + 0.22, c)
    m.box(x - 0.29, y + 0.12, z + 0.22, x - 0.008, y + 1.32, z + 0.235, c)
    m.box(x + 0.008, y + 0.12, z + 0.22, x + 0.29, y + 1.32, z + 0.235, c)
    m.box(x + 0.03, y + 0.62, z + 0.235, x + 0.05, y + 0.86, z + 0.265, c)
  })
  // Damp cinderblock: three courses of 39 × 19 cm blocks in running bond with 1 cm joints.
  part("damp-cinderblock", () => {
    const x = at("damp-cinderblock"), c = rgb(0x8a8781)
    const courses = [[0, 0.39, 0.4, 0.79, 0.8, 1.19], [0, 0.19, 0.2, 0.59, 0.6, 0.99, 1.0, 1.19]]
    for (let row = 0; row < 3; row++) {
      const y0 = y + row * 0.2, c0 = courses[row % 2]!
      for (let i = 0; i < c0.length; i += 2) m.box(x - 0.6 + c0[i]!, y0, z - 0.1, x - 0.6 + c0[i + 1]!, y0 + 0.19, z + 0.09, c)
    }
  })
  // Old wood: a slatted crate with corner posts.
  part("old-wood", () => {
    const x = at("old-wood"), c = rgb(0x7a634b), post = rgb(0x6a5440)
    const h = 0.56, s = 0.28
    for (const [px, pz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) m.box(x + px * s - 0.03, y, z + pz * s - 0.03, x + px * s + 0.03, y + h, z + pz * s + 0.03, post)
    for (let k = 0; k < 4; k++) {
      const y0 = y + 0.02 + k * 0.135
      m.box(x - s, y0, z + s - 0.005, x + s, y0 + 0.11, z + s + 0.015, c)
      m.box(x - s, y0, z - s - 0.015, x + s, y0 + 0.11, z - s + 0.005, c)
      m.box(x - s - 0.015, y0, z - s, x - s + 0.005, y0 + 0.11, z + s, c)
      m.box(x + s - 0.005, y0, z - s, x + s + 0.015, y0 + 0.11, z + s, c)
    }
  })
  // Painted steel: a 200 l drum with two rolling hoops.
  part("painted-steel", () => {
    const x = at("painted-steel"), c = rgb(0x3d5a44)
    m.cylinder(x, z, 0.29, y, y + 0.88, 20, c, MAT.lit, 0, { top: true })
    for (const h of [0.29, 0.59]) m.cylinder(x, z, 0.302, y + h, y + h + 0.025, 20, c, MAT.lit, 0, { top: true, bottom: true })
  })
  // Wet bark: a sawn stump with a shorter round leaning on it.
  part("wet-bark", () => {
    const x = at("wet-bark"), c = rgb(0x5a4838)
    m.cylinder(x - 0.08, z, 0.26, y, y + 0.5, 14, c, MAT.lit, 0, { top: true, topColor: rgb(0x9a8264) })
    m.cylinder(x + 0.3, z + 0.12, 0.16, y, y + 0.3, 12, c, MAT.lit, 0, { top: true, phase: 0.4, topColor: rgb(0x9a8264) })
  })
  // Weathered stone: a plinth with a projecting cap.
  part("weathered-stone", () => {
    const x = at("weathered-stone"), c = rgb(0x8c8a82)
    m.box(x - 0.27, y, z - 0.27, x + 0.27, y + 0.08, z + 0.27, shade(c, 0.95))
    m.box(x - 0.22, y + 0.08, z - 0.22, x + 0.22, y + 0.78, z + 0.22, c)
    m.box(x - 0.29, y + 0.78, z - 0.29, x + 0.29, y + 0.88, z + 0.29, shade(c, 1.04))
  })
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
  if (b.bakedRoom) {
    // Interior ceiling soffit and bookcase shadow occluder so upward bounce from the floor and rug illuminates the room.
    m.box(x0 + t, h - 0.06, z0 + t, x1 - t, h, z1 - t, shade(wall, 0.96), MAT.wall, 0, undefined, true)
    boxes.push({ rect: [11.3, 8.3, 13.4, 8.7], h: 2.1 })
  }
  // Roof: a shallow gable along x with eaves overhanging every wall.
  const ex0 = x0 - 0.45, ex1 = x1 + 0.45, ez0 = z0 - 0.45, ez1 = z1 + 0.45, ridge = h + 1.35, mid = (z0 + z1) / 2
  const roof = rgb(0x3b3532)
  m.quadAuto([ex0, h - 0.05, ez1], [ex1, h - 0.05, ez1], [ex1, ridge, mid], [ex0, ridge, mid], roof, MAT.roof)
  m.quadAuto([ex1, h - 0.05, ez0], [ex0, h - 0.05, ez0], [ex0, ridge, mid], [ex1, ridge, mid], roof, MAT.roof)
  m.facet([x1, h, z0], [x1, h, z1], [x1, ridge - 0.05, mid], wall, MAT.wall)
  m.facet([x0, h, z1], [x0, h, z0], [x0, ridge - 0.05, mid], wall, MAT.wall)
  m.box(ex0, h - 0.18, ez1 - 0.06, ex1, h - 0.02, ez1, trim, MAT.lit)
}

/**
 * The screen bench, inside the house against its back wall (plan coordinates; `SCREEN_*` below are in world
 * coordinates, after the set moves to the origin): a workbench with a wood-cased CRT television, a tape deck beside it,
 * and the practicals the screen lab can switch on over it.
 */
const BENCH = { x0: 15.5, x1: 17.45, z0: 8.22, z1: 8.87, top: 0.98 } as const
const TV = { x: 16.15, w: 0.58, h: 0.47, d: 0.5, y0: 0.995, front: 8.85, screenW: 0.4, screenH: 0.3, screenY: 1.245 } as const
const DECK = { x0: 16.62, x1: 17.08, y0: 0.985, y1: 1.075, z0: 8.38, z1: 8.76 } as const
const [OX, OZ] = WORLD_ORIGIN

/** The television's glass, facing into the room (world coordinates). */
export const SCREEN_AT: ScreenPlacement = { center: [TV.x - OX, TV.screenY, TV.front - 0.022 - OZ], yaw: Math.PI / 2, width: TV.screenW, height: TV.screenH }
/** The room the glass reflects (inside the house walls, world coordinates). */
export const SCREEN_ROOM = { min: [11.18 - OX, 0.24, 8.18 - OZ] as const, max: [18.64 - OX, 2.9, 13.64 - OZ] as const, albedo: 0.5 }
/**
 * An armchair on a pale rug, 1.6 m from the set and 46° off its axis, turned 30° from the set toward the camera: what
 * the screen's light falls on (plan coordinates, `turn` in radians). `half` is half its width and depth.
 */
export const SCREEN_CHAIR = { x: 15, z: 9.95, half: 0.4, turn: Math.PI / 6, seat: 0.66 } as const
const RUG = { x0: 14.3, x1: 16.6, z0: 9.0, z1: 10.75 } as const
/**
 * Where the screen lab looks from: the room's front corner at standing eye height, the set on the right third with its
 * glass 35° off axis, the chair three-quarter on (its lit front 46° from the camera) on the left, the rug between, and
 * the table lamp behind the chair just out of frame (its shade keeps a faint glow when off).
 */
export const SCREEN_CAMERA = { target: [15.69 - OX, 0.9, 9.277 - OZ] as const, yaw: 0.768, pitch: 0.24, dist: 4 } as const
export const SCREEN_TUBE: FluorescentTube = { at: [16.45 - OX, 2.55, 8.62 - OZ], length: 1.2, seed: 29, failing: 1.2, power: 1.1 }
export const SCREEN_BULB: CagedBulb = { at: [18.42 - OX, 1.95, 9.55 - OZ], seed: 31, wander: 0.7, power: 0.55 }
export const SCREEN_LEDS: { tv: LedIndicator; deck: LedIndicator; deckActivity: LedIndicator } = {
  tv: { at: [TV.x + TV.w / 2 - 0.06 - OX, TV.y0 + 0.032, TV.front + 0.001 - OZ], color: "red", pattern: "steady" },
  deck: { at: [DECK.x0 + 0.04 - OX, DECK.y0 + 0.05, DECK.z1 + 0.003 - OZ], color: "green", pattern: "steady" },
  deckActivity: { at: [DECK.x1 - 0.05 - OX, DECK.y0 + 0.05, DECK.z1 + 0.003 - OZ], color: "amber", pattern: "heartbeat", seed: 3 },
}

function addScreenBench(m: Mesh, b: WorldBuild): void {
  const wood = rgb(0x5d4029), dark = rgb(0x26231f), steel = rgb(0x45484a)
  const { x0, x1, z0, z1, top } = BENCH
  // Workbench: a thick top, four legs and a lower shelf.
  m.bevelBox(x0, top - 0.045, z0, x1, top, z1, 0.008, wood, rgb(0x6c4b31), MAT.shiny)
  for (const x of [x0 + 0.03, x1 - 0.08]) for (const z of [z0 + 0.03, z1 - 0.08]) m.box(x, 0.24, z, x + 0.05, top - 0.045, z + 0.05, wood, MAT.lit)
  m.box(x0 + 0.03, 0.34, z0 + 0.05, x1 - 0.03, 0.365, z1 - 0.05, wood, MAT.lit)
  m.box(x0 + 0.2, 0.365, z0 + 0.12, x0 + 0.62, 0.62, z1 - 0.12, rgb(0x3b3a37), MAT.lit)
  // The television: a wood-grain cabinet with a charcoal bezel round a 4:3 tube, a control strip under it.
  const cx = TV.x, hw = TV.w / 2, y0 = TV.y0, y1 = TV.y0 + TV.h, front = TV.front, back = front - TV.d
  const caseWood = rgb(0x6a4a2c), bezel = rgb(0x2b2927)
  for (const fx of [cx - hw + 0.04, cx + hw - 0.07]) m.box(fx, top, front - 0.08, fx + 0.03, y0, front - 0.03, dark, MAT.lit)
  m.bevelBox(cx - hw, y0, front - 0.17, cx + hw, y1, front - 0.06, 0.012, caseWood, rgb(0x765335), MAT.shiny)
  m.box(cx - hw * 0.75, y0 + 0.03, back, cx + hw * 0.75, y1 - 0.05, front - 0.17, rgb(0x34302b), MAT.lit)
  const sx0 = cx - TV.screenW / 2 - 0.012, sx1 = cx + TV.screenW / 2 + 0.012
  const sy0 = TV.screenY - TV.screenH / 2 - 0.012, sy1 = TV.screenY + TV.screenH / 2 + 0.012
  const bz0 = front - 0.06
  m.box(cx - hw, y0, bz0, sx0, y1, front, bezel, MAT.lit)
  m.box(sx1, y0, bz0, cx + hw, y1, front, bezel, MAT.lit)
  m.box(sx0, sy1, bz0, sx1, y1, front, bezel, MAT.lit)
  m.box(sx0, y0, bz0, sx1, sy0, front, bezel, MAT.lit)
  // The glass sits a little in from the bezel; a dark lip shows round it.
  m.box(sx0, sy0, bz0, sx1, sy1, front - 0.03, rgb(0x0b0b0b), MAT.lit)
  // Controls: a channel row and a speaker grille on the bezel's foot.
  for (let i = 0; i < 6; i++) m.box(cx - 0.17 + i * 0.03, y0 + 0.02, front, cx - 0.155 + i * 0.03, y0 + 0.045, front + 0.004, rgb(0x55524c), MAT.lit)
  for (let i = 0; i < 7; i++) m.box(cx + 0.03 + i * 0.016, y0 + 0.015, front, cx + 0.038 + i * 0.016, y0 + 0.05, front + 0.002, rgb(0x161514), MAT.lit)
  // A tape deck beside it, its LEDs on the front panel.
  m.bevelBox(DECK.x0, DECK.y0, DECK.z0, DECK.x1, DECK.y1, DECK.z1, 0.006, steel, rgb(0x505355), MAT.shiny)
  m.box(DECK.x0 + 0.1, DECK.y0 + 0.03, DECK.z1, DECK.x1 - 0.12, DECK.y0 + 0.06, DECK.z1 + 0.002, rgb(0x0f1011), MAT.lit)
  const shift = (l: LedIndicator): LedIndicator => ({ ...l, at: [l.at[0] + OX, l.at[1], l.at[2] + OZ] })
  ledIndicatorMesh(m, shift(SCREEN_LEDS.tv), LAMP.tvLed)
  ledIndicatorMesh(m, shift(SCREEN_LEDS.deck), LAMP.deckLed)
  ledIndicatorMesh(m, shift(SCREEN_LEDS.deckActivity), LAMP.deckLed)
  // A pale rug and an armchair near the set, both near-neutral so they take the picture's colour: the seat, a high back,
  // two arms and short feet.
  m.box(RUG.x0, 0.24, RUG.z0, RUG.x1, 0.252, RUG.z1, rgb(0xb3b0a9), MAT.lit)
  const fabric = rgb(0x9a968e), fabricDark = rgb(0x77736b)
  // Built round the origin facing −z, then turned to face the glass (less `turn`) and moved into place.
  const c = SCREEN_CHAIR, cx0 = -c.half, cx1 = c.half, cz0 = -c.half, cz1 = c.half, from = m.length
  for (const fx of [cx0 + 0.05, cx1 - 0.09]) for (const fz of [cz0 + 0.05, cz1 - 0.09]) m.box(fx, 0.252, fz, fx + 0.04, 0.33, fz + 0.04, dark, MAT.lit)
  m.bevelBox(cx0, 0.33, cz0, cx1, c.seat - 0.12, cz1, 0.02, fabricDark, fabric, MAT.lit)
  m.bevelBox(cx0 + 0.12, c.seat - 0.12, cz0 + 0.04, cx1 - 0.12, c.seat, cz1 - 0.18, 0.03, fabric, fabric, MAT.lit)
  m.bevelBox(cx0 + 0.04, 0.33, cz1 - 0.2, cx1 - 0.04, 1.32, cz1, 0.04, fabric, fabric, MAT.lit)
  for (const ax of [cx0, cx1 - 0.12]) m.bevelBox(ax, 0.33, cz0 + 0.02, ax + 0.12, 0.86, cz1 - 0.06, 0.03, fabric, fabric, MAT.lit)
  const face = Math.atan2(TV.front - 0.022 - c.z, TV.x - c.x) + c.turn
  turnFrom(m, from, Math.atan2(Math.cos(face), -Math.sin(face)), c.x, c.z)
  // The practicals, shown only when they're on.
  if (b.tube) {
    const t = { ...SCREEN_TUBE, at: [SCREEN_TUBE.at[0] + OX, SCREEN_TUBE.at[1], SCREEN_TUBE.at[2] + OZ] as const }
    fluorescentTubeMesh(m, t, LAMP.tube)
    for (const dx of [-0.45, 0.45]) m.box(t.at[0] + dx - 0.003, t.at[1] + 0.07, t.at[2] - 0.003, t.at[0] + dx + 0.003, 2.9, t.at[2] + 0.003, steel, MAT.lit)
  }
  if (b.bulb) {
    const bl = { ...SCREEN_BULB, at: [SCREEN_BULB.at[0] + OX, SCREEN_BULB.at[1], SCREEN_BULB.at[2] + OZ] as const }
    cagedBulbMesh(m, bl, LAMP.bulb)
    m.box(bl.at[0], bl.at[1] + 0.1, bl.at[2] - 0.012, 18.64, bl.at[1] + 0.124, bl.at[2] + 0.012, steel, MAT.lit)
  }
}

/** Turns every vertex added since `from` by `yaw` about the origin (as `Mesh.yawBox`), then moves it to (x, z). */
function turnFrom(m: Mesh, from: number, yaw: number, x: number, z: number): void {
  const c = Math.cos(yaw), s = Math.sin(yaw)
  for (let i = from; i < m.v.length; i += FLOATS_PER_VERT) {
    const px = m.v[i]!, pz = m.v[i + 2]!, nx = m.v[i + 3]!, nz = m.v[i + 5]!
    m.v[i] = px * c - pz * s + x
    m.v[i + 2] = px * s + pz * c + z
    m.v[i + 3] = nx * c - nz * s
    m.v[i + 5] = nx * s + nz * c
  }
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
  addCharacterAt(m, casters, CHARACTER_AT[0], CHARACTER_AT[1], 0.12)
}

function addCharacterAt(m: Mesh, casters: { x: number; y: number; r: number; h: number }[], cx: number, cz: number, y: number): void {
  const A = MAT.actor
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

export type WorldFlicker = Record<"street" | "porch" | "interior", FlickerSample>

const STEADY: FlickerSample = { level: 1, warmth: 1 }

/**
 * Converts a light tuned for the kit's top-down falloff into a physical one (`gpu/lights/physical.ts`) that matches it
 * straight under the fixture, so Today and Physical read at the same overall level and differ in shape: inverse-square
 * pools, 3D cones, GGX highlights. Plan cones become 3D spots aimed slightly down.
 */
export function physicalWorldLight(l: SceneLight, spot?: SceneLight["spot"], beam?: SceneLight["beam"]): SceneLight {
  const dn = Math.max(l.h, 1.25)
  const { cone, ...rest } = l
  const out: SceneLight = { ...rest, power: l.power * Math.PI * dn * dn * (0.1 + 2.6 / (1 + dn * dn * 0.3)) }
  if (beam) out.beam = beam
  else if (spot) out.spot = spot
  else if (cone) {
    const a = Math.acos(cone[2])
    out.spot = { axis: [cone[0], -0.12, cone[1]], cosOuter: cone[2], cosInner: Math.cos(a * 0.6) }
  }
  return out
}

/** Stable `SceneLight.id`s for the world's lights (spot shadow slots follow them). */
export const WORLD_LIGHT_ID = { street: 1, interior: 2, porch: 3, headlights: 4, flashlight: 6 } as const

/** The world's practical lights at a clock: porch, streetlamp, the lamp inside, headlights when on. */
export function worldLights(clock: WorldClock, opts: { lampPower: number; headlights: boolean; flashlight: boolean; porch: boolean; flicker?: WorldFlicker; physical?: boolean; bakedRoom?: boolean }): SceneLight[] {
  const k = clock.lamps * opts.lampPower
  const f = opts.flicker ?? { street: STEADY, porch: STEADY, interior: STEADY }
  const [lx, lz] = STREETLAMP_AT
  const [ix, iz] = INTERIOR_LIGHT
  const lights: SceneLight[] = [
    { x: clock.key.x, y: clock.key.y, h: clock.key.h, r: 46, color: clock.key.color, power: clock.key.power, size: 1.4 },
  ]
  if (k > 0.01) {
    lights.push({ x: lx, y: lz + 1.55, h: 4.0, r: 10, color: coldSodiumTint([1, 0.66, 0.32], f.street.warmth), power: 1.1 * k * f.street.level, size: 0.35, id: WORLD_LIGHT_ID.street })
    lights.push({ x: ix, y: iz, h: 1.5, r: 7, color: [1, 0.72, 0.42], power: 0.9 * k * f.interior.level, size: 0.3, id: WORLD_LIGHT_ID.interior })
    if (opts.porch) lights.push({ x: DOOR.x1 + 0.3, y: HOUSE.z1 + 0.3, h: 2.0, r: 5, color: [1, 0.78, 0.5], power: 0.7 * k * f.porch.level, size: 0.2, id: WORLD_LIGHT_ID.porch })
  }
  if (opts.headlights) {
    for (const [n, dz] of [0.3, 1.5].entries()) {
      lights.push({ id: WORLD_LIGHT_ID.headlights + n, x: CAR_BOX.x1 + 0.1, y: CAR_BOX.z0 + dz, h: 0.7, r: 12, color: [1, 0.95, 0.85], power: 1.2, size: 0.15, cone: [1, 0, Math.cos(0.42)] })
    }
  }
  if (opts.flashlight) {
    const [cx, cz] = CHARACTER_AT
    lights.push({ id: WORLD_LIGHT_ID.flashlight, x: cx + 0.2, y: cz + 0.3, h: 1.3, r: 9, color: [0.98, 0.95, 0.88], power: 1.4, size: 0.1, cone: [0.35, 0.94, Math.cos(0.36)] })
  }
  if (opts.physical) {
    // The streetlamp's head throws a downward cone (Aiden's sodium: 1.1 rad, penumbra 0.55) and the porch fitting a
    // wide shaded one, so neither lights the wall above it; the key and the lamp inside stay points. The flashlight is
    // a torch beam (Outbreak's profile, `gpu/lights/beam.ts`) tipped 0.3 rad down.
    const street = k > 0.01 ? 1 : -1
    const porch = k > 0.01 && opts.porch ? 3 : -1
    for (let i = 0; i < lights.length; i++) {
      const l = lights[i]!
      const spot = i === street ? { axis: [0, -1, 0] as const, cosOuter: Math.cos(1.1), cosInner: Math.cos(1.1 * 0.45) }
        : i === porch ? { axis: [0, -1, 0] as const, cosOuter: Math.cos(1.3), cosInner: Math.cos(0.7) }
        : opts.bakedRoom && l.id === WORLD_LIGHT_ID.interior ? { axis: [0, -1, 0] as const, cosOuter: Math.cos(1.15), cosInner: Math.cos(0.65) } : undefined
      const beam = l.id === WORLD_LIGHT_ID.flashlight && l.cone
        ? { axis: [l.cone[0] * Math.cos(0.3), -Math.sin(0.3), l.cone[1] * Math.cos(0.3)] as const, halfAngle: Math.acos(l.cone[2]) }
        : undefined
      lights[i] = physicalWorldLight(l, spot, beam)
    }
  }
  const [ox, oz] = WORLD_ORIGIN
  for (const l of lights.slice(1)) { l.x -= ox; l.y -= oz }
  return lights
}

export const HOUSE_BAKE_BOUNDS = { min: [-8.45, -0.05, -13.45] as const, max: [0.45, 4.3, -6.25] as const }

/**
 * Exports the canonical `BakeSceneSpec` for the house interior room directly from `buildWorld` and `worldLights`
 * (plus the `kit-crt` screen panel at reference emission `SCREEN_BAKE_REFERENCE`).
 */
export function exportHouseBakeSceneSpec(): BakeSceneSpec {
  const geom = buildWorld({
    street: FLOOR.wetAsphalt,
    walk: FLOOR.sidewalk,
    path: FLOOR.flagstone,
    floor: FLOOR.planks,
    wall: "clapboard",
    car: "red",
    vegetation: cloneFoliageParams(),
    tree: true,
    bush: true,
    grass: true,
    seed: 7,
    screen: true,
    bakedRoom: true,
  })
  const wLights = worldLights(worldClock(0), {
    lampPower: 1,
    headlights: false,
    flashlight: false,
    porch: true,
    physical: true,
    bakedRoom: true,
  })
  const byId = new Map(wLights.filter(l => l.id !== undefined).map(l => [l.id!, l]))
  const crtLight = screenSceneLight(
    {
      emission: () => [SCREEN_BAKE_REFERENCE, SCREEN_BAKE_REFERENCE, SCREEN_BAKE_REFERENCE],
      settings: createScreenDisplaySettings({ power: true, brightness: 1, light: 1, lightShape: "panel", lightRange: 6 }),
    },
    SCREEN_AT,
    { id: SCREEN_LIGHT_ID.screen, model: "physical" },
  )!
  return extractBakeSceneSpec({
    packed24: geom.level.chunks[0]!.data,
    bounds: HOUSE_BAKE_BOUNDS,
    lightmapBounds: HOUSE_LIGHTMAP_META.bounds,
    probes: HOUSE_LIGHTMAP_META.probes,
    lights: [
      { key: "interior", light: byId.get(WORLD_LIGHT_ID.interior)! },
      { key: "screen", light: crtLight },
      { key: "porch", light: byId.get(WORLD_LIGHT_ID.porch)! },
      { key: "street", light: byId.get(WORLD_LIGHT_ID.street)! },
    ],
  })
}
