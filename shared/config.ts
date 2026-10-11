export const TICK_HZ = 30
export const DT = 1 / TICK_HZ
export const SNAPSHOT_HZ = 15

export const CELL = 76
export const ROAD_HALF = 8
export const GRID = 7
export const WORLD_MAX = GRID * CELL + ROAD_HALF
export const WATER_Z = GRID * CELL + ROAD_HALF

export const MIN_COPS = 3
export const MAX_PLAYERS = 16
/** Online: a player with no input activity this long is kicked. The driver sitting dark (engine off) gets longer. */
export const IDLE_KICK_SECONDS = 120
export const IDLE_DARK_KICK_SECONDS = 240
/** The last this-many seconds before a kick, the player's snapshots carry a countdown. */
export const IDLE_WARN_SECONDS = 20
export const ROUND_SECONDS = 180
export const INTRO_SECONDS = 4
export const HEAD_START_SECONDS = 5
export const END_SECONDS = 9
export const EXTRACT_SECONDS = 3
export const EXTRACT_RADIUS = 14
export const EXTRACT_SPEED = 12
/** Extraction progress rate while boxed in by cops. */
export const EXTRACT_BOXED_RATE = 0.7
/** Extraction progress rate under the helicopter's spotlight. */
export const EXTRACT_SPOTLIT_RATE = 0.6
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

/** Handling and size shared by the getaway car and the police cruiser. */
const DRIVING = { mass: 1.1, maxSpeed: 42, accel: 15, brake: 22, turn: 1.9, grip: 6.5, boost: 1.0, length: 4.8, width: 1.95 }

export const VEHICLES: Vehicle[] = [
  { id: "muscle", name: "Muscle", role: "robber", ...DRIVING, hp: 100, paint: [0.7, 0.09, 0.07], accent: [0.07, 0.07, 0.08], tier: 0, blurb: "Brutal straight-line power. Wide slides." },
  { id: "compact", name: "Compact", role: "robber", mass: 0.8, maxSpeed: 36, accel: 17, brake: 20, turn: 2.6, grip: 8.5, hp: 80, boost: 0.9, paint: [0.08, 0.6, 0.58], accent: [0.1, 0.1, 0.11], length: 3.9, width: 1.7, tier: 0, blurb: "Quick on the turn. Fits the alleys." },
  { id: "van", name: "Van", role: "robber", mass: 1.6, maxSpeed: 32, accel: 11, brake: 16, turn: 1.4, grip: 7.5, hp: 150, boost: 0.8, paint: [0.7, 0.72, 0.74], accent: [0.14, 0.14, 0.15], length: 5.2, width: 2.1, tier: 1, blurb: "Carries the heavy take. Tough to stop." },
  { id: "bike", name: "Motorbike", role: "robber", mass: 0.4, maxSpeed: 46, accel: 19, brake: 18, turn: 3.1, grip: 9.5, hp: 50, boost: 1.1, paint: [0.12, 0.13, 0.16], accent: [0.2, 0.9, 0.95], length: 2.6, width: 0.9, tier: 2, blurb: "Fastest route through a crowd. Fragile." },
  // Same handling and hitbox as the getaway car: the chase is decided by driving, not by the car.
  { id: "cruiser", name: "Cruiser", role: "cop", ...DRIVING, hp: 120, paint: [0.8, 0.81, 0.84], accent: [0.05, 0.05, 0.06], tier: 0, blurb: "The standard cruiser." },
  { id: "interceptor", name: "Interceptor", role: "cop", mass: 0.9, maxSpeed: 46, accel: 17, brake: 24, turn: 2.4, grip: 8.0, hp: 110, boost: 1.0, paint: [0.8, 0.81, 0.84], accent: [0.05, 0.05, 0.06], length: 5.0, width: 2.0, tier: 1, blurb: "Fastest in the motor pool. Lighter frame." },
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
  spike: { id: "spike", name: "SPIKE STRIP", role: "cop", charges: 3, cooldown: 10, ttl: 25, radius: 6 },
  roadblock: { id: "roadblock", name: "ROADBLOCK", role: "cop", charges: 1, cooldown: 20, ttl: 25, radius: 6.5 },
}

/** Q = slot 0, E = slot 1. */
/** In survival only the cops' spike strip is active; Q or E deploys it. */
export const LOADOUT: Record<Role, [GadgetId, GadgetId]> = { robber: ["oil", "smoke"], cop: ["spike", "roadblock"] }

export const OIL_SPIN_SECONDS = 1.2
/**
 * Flat tires, indexed by how many are popped (0..4): fractions of top speed, grip and acceleration. Four flats is
 * driving on the rims: slow, sluggish and slidey, but the car can still limp to a repair shop.
 */
export const FLAT_SPEED = [1, 0.8, 0.6, 0.38, 0.2] as const
export const FLAT_GRIP = [1, 0.85, 0.7, 0.5, 0.35] as const
export const FLAT_ACCEL = [1, 0.9, 0.75, 0.55, 0.35] as const
/** Seconds the driver has to sit still in a repair bay to get every tire fixed. */
export const REPAIR_SECONDS = 2.5
/** Faster than this (m/s) in a bay and the mechanics can't work. */
export const REPAIR_SPEED = 2
/** Seconds before a shop can fix the driver's tires again. */
export const SHOP_COOLDOWN = 45
/** Bust progress per second for each cop pressed against the driver: two cops bust twice as fast as one. */
export const BUST_RATE_PER_COP = 0.5
export const SPIKE_THICK = 0.8
export const ROADBLOCK_THICK = 1.6
/** The robber only notices a spike strip glinting in the headlights inside this range. */
export const SPIKE_SPOT_RANGE = 40
export const SIGHT_RANGE = 70
/** Inside this range cops always know where the robber is (sirens, engine noise), even around a corner. */
export const HEAR_RANGE = 20

/** Fixed camera yaw (radians). The camera never rotates, so "on screen" is a box in these ground axes. */
export const CAMERA_YAW = Math.PI / 4 + 0.16
/**
 * The ground area a player's screen shows around their car at the default zoom, in camera axes (meters):
 * sideways half-width, and how far it reaches toward the bottom and top of the screen.
 */
export const SCREEN_HALF_WIDTH = 40
export const SCREEN_BACK = 24
export const SCREEN_AHEAD = 40
