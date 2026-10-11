export const TICK_HZ = 30
export const DT = 1 / TICK_HZ
export const SNAPSHOT_HZ = 15

export const CELL = 76
export const ROAD_HALF = 8
export const GRID = 7
export const WORLD_MAX = GRID * CELL + ROAD_HALF
export const WATER_Z = GRID * CELL + ROAD_HALF

export const MIN_COPS = 3
export const MAX_PLAYERS = 6
export const ROUND_SECONDS = 180
export const INTRO_SECONDS = 4
export const HEAD_START_SECONDS = 5
export const END_SECONDS = 9
export const EXTRACT_SECONDS = 3
export const EXTRACT_RADIUS = 14
export const EXTRACT_SPEED = 12
/** Extraction progress rate while boxed in by cops. */
export const EXTRACT_BOXED_RATE = 0.3
/** Chase seconds before the getaway ride reaches the extraction point. Until then the robber has to stay loose. */
export const EXTRACT_OPEN_SECONDS = 40
export const BUST_SECONDS = 4
export const BUST_RANGE = 9
export const CAR_RADIUS = 2.0
export const NEAR_MISS_DIST = 4.2
export const NEAR_MISS_SPEED = 22

export type Role = "robber" | "cop"

export type Vehicle = {
  id: string
  name: string
  role: Role
  mass: number
  maxSpeed: number
  accel: number
  brake: number
  turn: number
  grip: number
  hp: number
  boost: number
  paint: [number, number, number]
  accent: [number, number, number]
  length: number
  width: number
  tier: number
  blurb: string
}

export const VEHICLES: Vehicle[] = [
  { id: "muscle", name: "Muscle", role: "robber", mass: 1.1, maxSpeed: 42, accel: 15, brake: 22, turn: 1.9, grip: 6.5, hp: 100, boost: 1.0, paint: [0.78, 0.09, 0.1], accent: [0.95, 0.85, 0.5], length: 4.8, width: 1.95, tier: 0, blurb: "Brutal straight-line power. Wide slides." },
  { id: "compact", name: "Compact", role: "robber", mass: 0.8, maxSpeed: 36, accel: 17, brake: 20, turn: 2.6, grip: 8.5, hp: 80, boost: 0.9, paint: [0.92, 0.6, 0.2], accent: [0.2, 0.2, 0.22], length: 3.9, width: 1.7, tier: 0, blurb: "Quick on the turn. Fits the alleys." },
  { id: "van", name: "Van", role: "robber", mass: 1.6, maxSpeed: 32, accel: 11, brake: 16, turn: 1.4, grip: 7.5, hp: 150, boost: 0.8, paint: [0.25, 0.42, 0.45], accent: [0.9, 0.9, 0.92], length: 5.2, width: 2.1, tier: 1, blurb: "Carries the heavy take. Tough to stop." },
  { id: "bike", name: "Motorbike", role: "robber", mass: 0.4, maxSpeed: 46, accel: 19, brake: 18, turn: 3.1, grip: 9.5, hp: 50, boost: 1.1, paint: [0.12, 0.13, 0.16], accent: [0.2, 0.9, 0.95], length: 2.6, width: 0.9, tier: 2, blurb: "Fastest route through a crowd. Fragile." },
  { id: "cruiser", name: "Cruiser", role: "cop", mass: 1.2, maxSpeed: 40, accel: 14, brake: 22, turn: 1.9, grip: 7.0, hp: 120, boost: 0.9, paint: [0.93, 0.94, 0.96], accent: [0.2, 0.42, 0.95], length: 4.9, width: 2.0, tier: 0, blurb: "The standard cruiser. Steady and heavy." },
  { id: "interceptor", name: "Interceptor", role: "cop", mass: 0.9, maxSpeed: 46, accel: 17, brake: 24, turn: 2.4, grip: 8.0, hp: 110, boost: 1.0, paint: [0.12, 0.16, 0.26], accent: [0.9, 0.2, 0.2], length: 5.0, width: 2.0, tier: 1, blurb: "Fastest in the motor pool. Lighter frame." },
  { id: "swat", name: "SWAT Van", role: "cop", mass: 2.0, maxSpeed: 30, accel: 10, brake: 16, turn: 1.3, grip: 7.0, hp: 220, boost: 0.7, paint: [0.12, 0.14, 0.16], accent: [0.3, 0.6, 1.0], length: 5.6, width: 2.3, tier: 2, blurb: "Plow through a roadblock. Slow to start." },
]

export const VEHICLE_BY_ID = new Map(VEHICLES.map((v) => [v.id, v]))

export type JobSite = {
  id: string
  name: string
  kind: "bank" | "jewelry" | "gallery"
  value: number
  x: number
  z: number
}

export type Extraction = { id: string; name: string; x: number; z: number }

export type GadgetId = "oil" | "smoke" | "spike" | "roadblock"

/** charges per round, cooldown between uses (s), prop lifetime (s), prop radius or half-length (m). */
export type GadgetSpec = { id: GadgetId; name: string; role: Role; charges: number; cooldown: number; ttl: number; radius: number }

export const GADGETS: Record<GadgetId, GadgetSpec> = {
  oil: { id: "oil", name: "OIL SLICK", role: "robber", charges: 3, cooldown: 8, ttl: 12, radius: 3 },
  smoke: { id: "smoke", name: "SMOKE SCREEN", role: "robber", charges: 2, cooldown: 14, ttl: 6, radius: 9 },
  spike: { id: "spike", name: "SPIKE STRIP", role: "cop", charges: 2, cooldown: 12, ttl: 20, radius: 6 },
  roadblock: { id: "roadblock", name: "ROADBLOCK", role: "cop", charges: 1, cooldown: 20, ttl: 25, radius: 6.5 },
}

/** Q = slot 0, E = slot 1. */
export const LOADOUT: Record<Role, [GadgetId, GadgetId]> = { robber: ["oil", "smoke"], cop: ["spike", "roadblock"] }

export const OIL_SPIN_SECONDS = 1.2
export const FLAT_SECONDS = 6
export const SPIKE_THICK = 0.8
export const ROADBLOCK_THICK = 1.6
/** The robber only notices a spike strip glinting in the headlights inside this range. */
export const SPIKE_SPOT_RANGE = 40
export const SIGHT_RANGE = 70
/** Inside this range cops always know where the robber is (sirens, engine noise), even around a corner. */
export const HEAR_RANGE = 20
