// The fixed, hand-authored layout of the world. Every builder reads its positions from here so the pieces line up.
// Units are metres, Y is up, +Z is south. The facility sits north, the county road runs east-west in the south, and
// one access road winds north through the pines from the county road to the gate.

export type Vec2 = readonly [number, number]
export type Rect = { min: Vec2; max: Vec2 }

export const WORLD_HALF = 700

export const COUNTY_ROAD = {
  /** Centre line z at x = 0; the road bends gently with `countyRoadZ`. */
  z: 430,
  width: 7.4,
  shoulder: 1.6,
}

/** Centre line of the county road at a given x. */
export const countyRoadZ = (x: number) => COUNTY_ROAD.z + Math.sin(x / 140) * 9

export const ACCESS_ROAD = {
  width: 6.4,
  shoulder: 1.2,
  /** Control points from the county road north to the gate and into the parking lot (Catmull-Rom through these). */
  points: [
    [0, countyRoadZ(0)],
    [-5, 385],
    [-13, 330],
    [-11, 270],
    [3, 210],
    [3, 165],
    [0, 135],
    [0, 122],
    [0, 60],
  ] as Vec2[],
}

export const FENCE = {
  min: [-95, -125] as Vec2,
  max: [95, 122] as Vec2,
  height: 2.5,
  /** Barbed-wire outrigger above the mesh. */
  barbHeight: 0.55,
  postSpacing: 3,
  /** Opening in the south fence line (z = max.z) for the gate. */
  gate: { x0: -5.5, x1: 5.5 },
}

/** Guard booth just outside the fence, east of the gate (see concept r5-03 / r3-01). */
export const BOOTH = { x: 9, z: 127.5, w: 3.4, d: 2.8, h: 2.9 }

export const PARKING_LOT: Rect = { min: [-42, 38], max: [42, 112] }

export const BUILDING = {
  /** Five-storey concrete research block: `storeys` floors of `storeyHeight`, plus parapet up to `height`. */
  main: { min: [-55, -22] as Vec2, max: [35, 22] as Vec2, height: 19.6, storeys: 5, storeyHeight: 3.8 },
  /** Single-storey east annex. */
  annex: { min: [35, -38] as Vec2, max: [62, 6] as Vec2, height: 5.2 },
  wallThickness: 0.35,
  /** Ground-floor slab top inside the building. */
  floorY: 0.15,
  /** Main entrance on the south face of the main block. */
  entrance: { x: 0, z: 22, width: 3.6, height: 2.7 },
  /** Large radio dish on the roof, tilted so it points down at the ground behind the building. */
  dish: { x: 6, z: -4, diameter: 25.5, tilt: 0.95, yaw: Math.PI },
  /** Loading dock on the north face. */
  dock: { x: -30, z: -22, width: 14, depth: 9, height: 1.25 },
}

/** Interior spaces inside the main block. Walls between them are the interior builder's; the outer shell is not. */
export const INTERIOR = {
  ceiling: 3.1,
  lobby: { min: [-9, 9] as Vec2, max: [9, 21.65] as Vec2 },
  /** Main corridor running west from the lobby (concept r3-02: pale green tile, waxed linoleum, steel doors). */
  corridor: { min: [-54, -1.6] as Vec2, max: [-9, 1.6] as Vec2 },
  /** A short corridor north from the lobby to the junction with the main corridor. */
  link: { min: [-1.6, -1.6] as Vec2, max: [1.6, 9] as Vec2 },
}

/**
 * Vertical plan of the main block, shared by the facility (exterior) and interior agents.
 * Storey i (0 = ground) has its finished floor at `storeyY(i)`; ceilings are `INTERIOR.ceiling` above that.
 * The roof deck (walkable) is at `ROOF_Y`.
 */
export const storeyY = (i: number) => BUILDING.floorY + i * BUILDING.main.storeyHeight
export const ROOF_Y = storeyY(BUILDING.main.storeys)

/**
 * Stair and lift core (the facility's blank tower on the south face, x -43.45..-35.95, projecting to z 25.2).
 * Inside: a switchback stair from the ground floor to the roof, and one lift shaft beside it. A short hall on every
 * storey joins the core to that storey's main corridor (x -42..-38.5, z 1.6..16.2). On the roof the stair exits
 * through a door in the core tower's north face onto the roof deck.
 */
export const CORE = {
  stair: { min: [-43.1, 16.2] as Vec2, max: [-39.7, 24.9] as Vec2 },
  lift: { min: [-39.5, 19.6] as Vec2, max: [-36.3, 24.9] as Vec2 },
  /** Lift lobby in front of the lift doors on every storey. */
  liftLobby: { min: [-39.5, 16.2] as Vec2, max: [-36.3, 19.6] as Vec2 },
  hall: { min: [-42, 1.6] as Vec2, max: [-38.5, 16.2] as Vec2 },
  roofDoor: { x: -39.7, z: 16.2, width: 1.1 },
}

/**
 * Exterior steel fire escape on the west face (x = BUILDING.main.min x): zig-zag stairs with a landing at every
 * upper storey and a drop ladder from the first landing to the ground. Each landing has a door through the west wall
 * into the west end of that storey's corridor (door centre z = 0, width 1.0). A caged ladder continues from the top
 * landing over the parapet onto the roof.
 */
export const FIRE_ESCAPE = { x: -55, z0: -6, z1: 6, depth: 2.1, door: { z: 0, width: 1.0 } }

/** Upper-storey plan: the same double-loaded corridor as the ground floor, the full length of the main block. */
export const UPPER = { corridor: { min: [-54.65, -1.6] as Vec2, max: [34.65, 1.6] as Vec2 } }

/** Ground-floor spine east of the lobby (building program §0); the upper storeys use `UPPER.corridor`. */
export const CORRIDOR_EAST = { min: [1.6, -1.6] as Vec2, max: [34.65, 1.6] as Vec2 }

/** Freight lift FL-1 between the ground floor (receiving / decon) and the Sublevel only. */
export const FREIGHT = { car: { min: [-36.85, -20.5] as Vec2, max: [-33.25, -15.5] as Vec2 }, stops: ["SL", 0] as const }

/** Sublevel floor height (placeholder until the Sublevel is built). */
export const SUBLEVEL_Y = -6.2

/** Riser W-1 under the dish feed: a locked cupboard on every storey, trunk down to the Sublevel. */
export const RISER = { min: [5.4, -4.6] as Vec2, max: [6.6, -3.4] as Vec2 }

/** Ground-floor door through the main block's east wall into the annex. */
export const ANNEX_DOOR = { x: 34.65, z: -8, width: 1.2 }

/** Utility poles carrying power lines along the east side of the access road, then into the compound. */
export const POWER = { spacing: 42, offset: 7.5, poleHeight: 10.5 }

/** Named camera viewpoints. Yaw 0 looks north (-Z); positive yaw turns left (towards -X). */
export const VIEWPOINTS = {
  road: { pos: [-2, 1.7, 250], yaw: 0.05, pitch: 0.02, label: "Access road" },
  gate: { pos: [-2.5, 1.7, 142], yaw: -0.08, pitch: 0.03, label: "Gate" },
  lot: { pos: [-26, 1.7, 100], yaw: -0.3, pitch: 0.1, label: "Parking lot" },
  entrance: { pos: [2, 1.7, 34], yaw: 0, pitch: 0.05, label: "Entrance" },
  lobby: { pos: [5, 1.7, 19], yaw: 0.6, pitch: -0.02, label: "Lobby" },
  corridor: { pos: [-11, 1.65, 0.2], yaw: Math.PI / 2, pitch: -0.04, label: "Corridor" },
  dock: { pos: [-30, 1.7, -50], yaw: Math.PI, pitch: 0.04, label: "Loading dock" },
  county: { pos: [24, 1.7, countyRoadZ(24)], yaw: Math.PI / 2, pitch: 0.01, label: "County road" },
  forest: { pos: [-70, 1.7, 175], yaw: -0.7, pitch: 0.05, label: "Forest" },
} as const

export type ViewpointName = keyof typeof VIEWPOINTS

/** Samples the access road centre line as a Catmull-Rom spline, `step` metres apart (approximately). */
export function accessRoadSamples(step = 2): Vec2[] {
  const p = ACCESS_ROAD.points
  const out: Vec2[] = []
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = p[Math.max(i - 1, 0)]!
    const p1 = p[i]!
    const p2 = p[i + 1]!
    const p3 = p[Math.min(i + 2, p.length - 1)]!
    const n = Math.max(1, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / step))
    for (let j = 0; j < n; j++) {
      const t = j / n
      const t2 = t * t
      const t3 = t2 * t
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3)
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])])
    }
  }
  out.push(p[p.length - 1]!)
  return out
}

/** Samples the county road centre line from x0 to x1. */
export function countyRoadSamples(x0 = -WORLD_HALF, x1 = WORLD_HALF, step = 4): Vec2[] {
  const out: Vec2[] = []
  for (let x = x0; x <= x1; x += step) out.push([x, countyRoadZ(x)])
  return out
}
