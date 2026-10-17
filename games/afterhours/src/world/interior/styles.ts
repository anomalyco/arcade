import { type Band, type Mat, M, corridorBands, paint } from "./kit"

// Each storey's corridor finish, shared by the corridor builder and the core hall that joins it, so bands, floors and
// stripes line up where they meet. Storey 0 is the concept's green tile.

export type Style = {
  floor: Mat
  bands: Band[]
  stripe: Mat | null
  leaf?: Mat
  missing: number
  louvre: boolean
  /** Wallcovering butt seams: drawn by `partition()`/`spine()` on solid wall spans only (never across openings). */
  seam?: { mat: Mat; every: number; y0: number }
}

/** Room-side finishes (painted plaster on a rubber base) for partitions between rooms. */
export const ROOM_BANDS: Band[] = [
  [0, 0.1, M.rubber],
  [0.1, 99, "painted_wall"],
]
/** Wet rooms (toilets, janitor, labs' wet walls): glazed tile to 1.5 m. */
export const WET_BANDS: Band[] = [
  [0, 0.12, "tile_green_dark"],
  [0.12, 1.5, "tile_green"],
  [1.5, 99, "painted_wall"],
]
/** Bare block (services, plant). */
export const PLANT_BANDS: Band[] = [[0, 99, "concrete_wall"]]

/** Each upper storey's own corridor finish (storey 0 is the concept's green tile, built in corridor.ts). */
export const STYLES: Record<number, Style> = {
  0: { floor: "linoleum", bands: corridorBands, stripe: M.stripe, missing: 0, louvre: false },
  // Offices: carpet tiles, beige vinyl wallcovering over a hardwood skirting and chair rail, veneer doors, parabolic
  // louvres in the fittings.
  1: {
    floor: M.carpet,
    bands: [
      [0, 0.1, M.veneerDark],
      [0.1, 0.86, M.vinylBeige],
      [0.86, 0.93, M.veneer],
      [0.93, 99, M.vinylBeige],
    ],
    stripe: null,
    leaf: M.veneer,
    missing: 0,
    louvre: true,
    seam: { mat: M.vinylSeam, every: 0.9, y0: 0.93 },
  },
  // Labs: sheet vinyl with yellow safety lanes, two-tone epoxy-painted block.
  2: { floor: "linoleum", bands: [[0, 99, M.block]], stripe: paint(0x8a7212, 0.35), missing: 0, louvre: false },
  // Records and computers: anti-static grey vinyl, grey walls with a blue band.
  3: {
    floor: paint(0x5f6361, 0.32),
    bands: [
      [0, 0.1, M.rubber],
      [0.1, 1.0, M.antistatic],
      [1.0, 1.08, M.blue],
      [1.08, 99, paint(0x9a9e9a, 0.7)],
    ],
    stripe: M.blue,
    missing: 0,
    louvre: false,
  },
  // Abandoned: stripped to the slab and the block, the grid mostly bare.
  4: {
    floor: "concrete_floor_dry",
    bands: [
      [0, 0.08, M.rubber],
      [0.08, 99, "concrete_wall"],
    ],
    stripe: null,
    missing: 0.72,
    louvre: false,
  },
}

