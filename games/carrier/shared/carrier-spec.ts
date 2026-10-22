// The player's aircraft carrier: dimensions and deck layout ("layout A"), shared by the renderer, physics and gameplay.
//
// Ship-local frame, metres, right-handed like the engine: origin at the waterline, mid-length, on the centreline.
// +Y up, +Z toward the BOW, +X toward PORT, −X toward STARBOARD. Facing the bow, starboard (−X) is on your right.
// The island, apron and parking are on the starboard side (−X), like real carriers; the runway and the deck-edge
// elevator are on the port side (+X).
//
// The concept images are drawn mirror-handed: seen from ahead of the bow they put the island on the screen's right,
// which in a true (unmirrored) view is the ship's port side; their designer intent is a starboard island. So the
// measurements below are taken from the images and mirrored; preview comparisons flip the references to match.
//
// Proportions were measured on the concepts (`concept/carrier-1-hero.png`, `carrier-3-yaw-strip.png`, the overhead of
// `carrier-4-pitch-strip.png`, and the elevations of `carrier-2-turnaround.png`) as fractions of the deck's length and
// width, then scaled to the 330 m x 76 m deck:
// - runway: port deck edge line to the solid apron line, 0.03-0.64 of the width measured from the port edge (hero
//   0.03-0.67, yaw 0° 0.04-0.64, deck plan 0.04-0.64); dashed centreline at 0.30 from the port edge (hero 0.29)
// - parking apron: the starboard 0.35 of the width (hero 0.33, yaw 0° 0.36, deck plan 0.36), full length
// - island: the starboard 0.21 of the width, 0.32-0.50 of the length from the stern (hero, measured by back-projecting
//   its base corners onto the fitted deck plane; the overhead of the pitch strip puts it further aft), radar top ~45 m
//   above the deck. The hero wins over the other sheets where they disagree.
// - deck-edge elevator: port, 0.51-0.60 of the length from the stern (hero), protruding ~0.23 of the width
// - "07": two 11 m x 21 m digits on the runway centreline, 10 m from the bow end (hero: 40 px tall at the bow)
// - stern threshold: 7 piano-key stripes 2.2 m x 16 m (deck plan, mirrored)
// - freeboard: the hero camera fits best (6.8 px rms over the deck corners) with the deck 26 m above the waterline;
//   the turnaround elevations agree (deck ~0.08 of the length above the red band)

export const LENGTH = 330
export const DECK_WIDTH = 76
/** Height of the flight deck surface above the waterline. */
export const DECK_Y = 26
/** Depth of the keel below the waterline. */
export const DRAFT = 7
/** Hull beam at the waterline (the deck overhangs it on sponsons). */
export const BEAM_WL = 51
export const BOW_Z = LENGTH / 2
export const STERN_Z = -LENGTH / 2
export const DECK_X0 = -DECK_WIDTH / 2
export const DECK_X1 = DECK_WIDTH / 2
/** Bottom of the flight deck slab; the hull and sponsons hang below it. */
export const DECK_SLAB_Y = 18
/** Bow corners of the deck are notched by this much in x and z. */
export const BOW_NOTCH = 1.6

export type Rect = { x0: number; z0: number; x1: number; z1: number }
export type Box = Rect & { y0: number; y1: number }

/** The landing/takeoff strip: from the solid line that bounds the apron (starboard, −X) to the port deck-edge line. */
export const RUNWAY: Rect = { x0: -8.6, z0: STERN_Z + 1, x1: 36.1, z1: BOW_Z - 2 }
/** Dashed runway centreline (painted on the measured line, not the rect centre); the catapult track runs on it. */
export const CENTERLINE_X = 15.2
/** Thin yellow guide line, from the stern to just short of the "07" (on the apron side of the centreline). */
export const GUIDE_X = 8.6
/** Solid line between runway and apron: white aft of `APRON_LINE_YELLOW_Z`, yellow forward of it. */
export const APRON_LINE_X = -9.1
export const APRON_LINE_YELLOW_Z = -24
/** Parking strip along the starboard (−X) edge; it holds the island. */
export const APRON: Rect = { x0: DECK_X0 + 0.6, z0: STERN_Z + 1, x1: -9.7, z1: BOW_Z - 2 }
/** Island superstructure footprint (main block) on the starboard edge, and its top (radar array). */
export const ISLAND: Box = { x0: -38.4, z0: -58, x1: -23, z1: 0, y0: DECK_Y, y1: DECK_Y + 48 }
/** Deck-edge elevator platform on the port (+X) side, flush with the deck. */
export const ELEVATOR: Rect = { x0: 36.4, z0: 2, x1: 54, z1: 34 }
/** "07" digits: each digit's plan rect in ship space. */
export const NUMBER_DIGIT_W = 11
export const NUMBER_DIGIT_L = 21
export const NUMBER_GAP = 2.4
export const NUMBER_Z0 = BOW_Z - 10 - NUMBER_DIGIT_L
export const NUMBER_Z1 = BOW_Z - 10
export const DASH = { from: STERN_Z + 26, to: NUMBER_Z0 - 6, length: 9, period: 15 } as const
export const THRESHOLD = { stripes: 7, width: 2.2, pitch: 4.1, z0: STERN_Z + 3, z1: STERN_Z + 19 } as const

export type VehicleKind = "jet" | "helicopter" | "tractor" | "cart" | "crew-yellow" | "crew-red" | "crew-green"
export type ParkingSpot = {
  kind: VehicleKind
  x: number
  z: number
  /** Heading: the vehicle's nose (local +Z) points along (sin yaw, 0, cos yaw) in ship space. */
  yaw: number
  /** Plan half-extent for overlap checks (a circle around x, z). */
  radius: number
}

/** Spawn spots on the apron for aircraft, vehicles and crew (the model's deck ships empty), as in the hero concept:
 *  jets angled nose-in toward the runway (bow-and-port), the helicopter aft of the island, the tow tractor near the
 *  bow, a cart at the island's foot, and handlers between them. */
export const PARKING: readonly ParkingSpot[] = [
  { kind: "helicopter", x: -16.4, z: -30, yaw: 0.25, radius: 6.4 },
  { kind: "cart", x: -19.5, z: -2, yaw: 0, radius: 1.8 },
  { kind: "jet", x: -25, z: 36, yaw: 0.55, radius: 8.6 },
  { kind: "jet", x: -25.6, z: 92, yaw: 0.55, radius: 8.6 },
  // Aft of the island, ahead of the stern quarter: the strike jet's bay (shared/deck-jets.ts).
  { kind: "jet", x: -25, z: -96, yaw: 0.55, radius: 8.6 },
  { kind: "tractor", x: -17, z: 116, yaw: -0.35, radius: 2.6 },
  { kind: "crew-yellow", x: -13.6, z: 14, yaw: 1.2, radius: 0.6 },
  { kind: "crew-yellow", x: -15, z: 62, yaw: 0.8, radius: 0.6 },
  { kind: "crew-red", x: -35, z: 60, yaw: 1.6, radius: 0.6 },
  { kind: "crew-yellow", x: -20.5, z: 104, yaw: 0.4, radius: 0.6 },
  { kind: "crew-red", x: -34.5, z: 120, yaw: 2.4, radius: 0.6 },
  { kind: "crew-green", x: -13.5, z: 80, yaw: -1.2, radius: 0.6 },
  { kind: "crew-yellow", x: -14.6, z: -44, yaw: 1, radius: 0.6 },
]

/** Plan outline of the flight deck (without the elevator), counter-clockwise seen from above. */
export const DECK_OUTLINE: readonly (readonly [number, number])[] = [
  [DECK_X0, STERN_Z],
  [DECK_X0, BOW_Z - BOW_NOTCH],
  [DECK_X0 + BOW_NOTCH, BOW_Z - BOW_NOTCH],
  [DECK_X0 + BOW_NOTCH, BOW_Z],
  [DECK_X1 - BOW_NOTCH, BOW_Z],
  [DECK_X1 - BOW_NOTCH, BOW_Z - BOW_NOTCH],
  [DECK_X1, BOW_Z - BOW_NOTCH],
  [DECK_X1, STERN_Z],
]

export const inRect = (r: Rect, x: number, z: number) => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1

/** Walkable flight deck height at ship-local (x, z): the deck (including the elevator, raised) or null off the deck.
 *  The island's footprint counts as off the deck. */
export function deckHeightAt(x: number, z: number): number | null {
  if (inRect(ISLAND, x, z)) return null
  if (inRect(ELEVATOR, x, z)) return DECK_Y
  if (z < STERN_Z || z > BOW_Z || x < DECK_X0 || x > DECK_X1) return null
  if (z > BOW_Z - BOW_NOTCH && (x < DECK_X0 + BOW_NOTCH || x > DECK_X1 - BOW_NOTCH)) return null
  return DECK_Y
}

export type WeaponKind = "ciws" | "sam" | "gun"
export type WeaponMount = {
  kind: WeaponKind
  side: "port" | "starboard"
  /** Centre of the mount's base on its sponson (ship-local); the yaw axis is vertical through it. */
  pos: readonly [number, number, number]
  /** Heading the weapon is drawn at when idle: its bore points along (sin yaw, 0, cos yaw) in ship space. */
  restYaw: number
  /** Idle elevation, radians up from horizontal. */
  restPitch: number
  /** Training limits in ship space (radians, same convention as `restYaw`, min < max; may run past ±π), so it never
   *  fires through the ship. */
  yawArc: readonly [number, number]
  /** Elevation limits, radians. */
  pitchArc: readonly [number, number]
  /** The sponson the weapon stands on: a box hanging off the hull just below the deck edge (its top is `pos[1]`). */
  sponson: Box
  /** Hit-test sphere around the mount (centre `pos` raised by `radius * 0.8`). */
  radius: number
}

/** Every mount trains through `TRAVERSE` (200°), centred on `mid` (ship-local yaw). */
const TRAVERSE = (200 * Math.PI) / 180
const arc = (mid: number): readonly [number, number] => [mid - TRAVERSE / 2, mid + TRAVERSE / 2]

/** Top of the weapon sponsons, just under the deck edge (above every catwalk sponson's top). */
const WEAPON_Y = DECK_Y - 0.3
/** Mount centres stand 5 m outboard of the deck edge; sponsons reach 10 m out. */
const WEAPON_X = DECK_X1 + 5
const SPONSON_OUT = DECK_X1 + 10
const sponson = (side: 1 | -1, z: number, half: number): Box => {
  const [x0, x1] = side > 0 ? [DECK_X1 - 4, SPONSON_OUT] : [-SPONSON_OUT, DECK_X0 + 4]
  return { x0, x1, z0: z - half, z1: z + half, y0: WEAPON_Y - 4.6, y1: WEAPON_Y }
}

/**
 * Ship weapons on deck-edge sponsons, clear of the runway and the apron (the real Nimitz layout: point defence on the
 * quarters, Sea Sparrow boxes fore and aft), as in `concept/weapons-1-hero.png`: the 5-inch gun on the starboard bow
 * sponson, an 8-cell SAM launcher on the starboard side ahead of the island and one on the port quarter, a CIWS on the
 * port bow (abreast the "07") and one on the starboard quarter.
 */
export const WEAPON_MOUNTS: readonly WeaponMount[] = [
  { kind: "gun", side: "starboard", pos: [-WEAPON_X, WEAPON_Y, 140], restYaw: -0.12, restPitch: 0.04, yawArc: arc(-1.15), pitchArc: [-0.12, 1.1], sponson: sponson(-1, 140, 8.5), radius: 8 },
  { kind: "sam", side: "starboard", pos: [-WEAPON_X, WEAPON_Y, 86], restYaw: -Math.PI / 2, restPitch: 0.35, yawArc: arc(-Math.PI / 2), pitchArc: [0, 1.2], sponson: sponson(-1, 86, 7.5), radius: 7 },
  { kind: "ciws", side: "port", pos: [WEAPON_X, WEAPON_Y, 130], restYaw: 0.6, restPitch: 0.05, yawArc: arc((Math.PI - 0.45) / 2), pitchArc: [-0.35, 1.4], sponson: sponson(1, 130, 7), radius: 7 },
  { kind: "sam", side: "port", pos: [WEAPON_X, WEAPON_Y, -154], restYaw: Math.PI / 2, restPitch: 0.35, yawArc: arc(Math.PI / 2), pitchArc: [0, 1.2], sponson: sponson(1, -154, 7.5), radius: 7 },
  { kind: "ciws", side: "starboard", pos: [-WEAPON_X, WEAPON_Y, -155], restYaw: -Math.PI + 0.6, restPitch: 0.05, yawArc: arc((0.45 - Math.PI) / 2), pitchArc: [-0.35, 1.4], sponson: sponson(-1, -155, 7), radius: 7 },
]

/** Axis-aligned bounds of everything the carrier model draws (hull, island, radar, elevator, weapon sponsons, vehicles). */
export const BOUNDS: Box = { x0: -SPONSON_OUT - 4, x1: ELEVATOR.x1 + 1, y0: -DRAFT - 0.5, y1: ISLAND.y1, z0: STERN_Z - 1, z1: BOW_Z + 1 }
