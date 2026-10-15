/**
 * Arenas: a tile map that wraps on both axes (a gap in a wall leads to the opposite side, a hole in the floor drops
 * you in from the top), with spawns, chest spots and the decor the renderer dresses it with. Rows are written top
 * first; the sim's y axis points up, so row 0 of the array is y = H - 1.
 */
export type ArenaDef = {
  id: string
  name: string
  rows: readonly string[]
  /** Feet positions (tile units, y up). */
  spawns: readonly (readonly [number, number])[]
  chests: readonly (readonly [number, number])[]
  /** Fire bowls: decor that lights the scene and throws embers. */
  braziers: readonly (readonly [number, number])[]
  /** Background set the renderer builds behind the plane. */
  backdrop: "belltower" | "cloister" | "aqueduct"
}

export type Arena = ArenaDef & {
  w: number
  h: number
  solid: Uint8Array
}

const BELL_TOWER: ArenaDef = {
  id: "belltower",
  name: "Bell Tower",
  rows: [
    "############........############",
    "######....................######",
    "######....................######",
    "##............................##",
    "##............................##",
    "##..........########..........##",
    "##............................##",
    "###########..........###########",
    "########................########",
    "########................########",
    "##............................##",
    "......####............####......",
    ".............######.............",
    "................................",
    "############........############",
    "############........############",
    "############........############",
    "############........############",
  ],
  spawns: [[4, 4], [27.5, 4], [5, 11], [26.5, 11]],
  chests: [[16, 13], [15.5, 6], [4.5, 11], [27, 11]],
  braziers: [[24.5, 4], [9.5, 11]],
  backdrop: "belltower",
}

const CLOISTER: ArenaDef = {
  id: "cloister",
  name: "Cloister",
  rows: [
    "####......##########......######",
    "#..............##..............#",
    "#..............##..............#",
    "#..............................#",
    "#....######..........######....#",
    "#.........#..........#.........#",
    ".........................#.....",
    "...............................",
    "######......########......######",
    "#..............................#",
    "#..............................#",
    "#...######............######...#",
    "#..............................#",
    "...............................",
    "...........##########..........",
    "#####......#........#......#####",
    "#####......#........#......#####",
    "####......##########......######",
  ],
  spawns: [[3, 4], [28.5, 4], [7, 7.5], [24.5, 7.5]],
  chests: [[16, 10], [16, 4], [3, 14], [29, 14]],
  braziers: [[13, 4], [19, 4]],
  backdrop: "cloister",
}

/**
 * A broken aqueduct over a ravine. The deck stands on pillars; under it three chambers open onto the drop, so falling
 * out of the bottom brings you in at the top, onto the keystone or back down to the deck. The outer chambers open at
 * the foot onto the side shaft (which wraps across the edge). The keystone and the
 * centre ledge are mostly reached by wrapping.
 */
const AQUEDUCT: ArenaDef = {
  id: "aqueduct",
  name: "Aqueduct",
  rows: [
    "####........................####",
    "##...........######...........##",
    "................................",
    "................................",
    "..............####..............",
    "......#####..........#####......",
    "................................",
    "................................",
    "................................",
    "...###########....###########...",
    "...##.....##........##.....##...",
    "...##.....##........##.....##...",
    "...##.....##........##.....##...",
    "...##.....##..####..##.....##...",
    "..........##........##..........",
    "..........##........##..........",
    "......###.##........##.###......",
    "#####.....##........##.....#####",
  ],
  spawns: [[7, 9], [24.5, 9], [8, 13], [23.5, 13]],
  chests: [[16, 14], [16, 5], [7, 2], [24.5, 2]],
  braziers: [[4.5, 9], [27, 9]],
  backdrop: "aqueduct",
}

export const ARENA_DEFS: readonly ArenaDef[] = [BELL_TOWER, CLOISTER, AQUEDUCT]

function pad(rows: readonly string[], w: number): string[] {
  return rows.map((r) => (r.length >= w ? r.slice(0, w) : r + ".".repeat(w - r.length)))
}

export function buildArena(def: ArenaDef): Arena {
  const w = Math.max(...def.rows.map((r) => r.length))
  const h = def.rows.length
  const rows = pad(def.rows, w)
  const solid = new Uint8Array(w * h)
  for (let r = 0; r < h; r++) {
    const y = h - 1 - r
    for (let x = 0; x < w; x++) if (rows[r]![x] === "#") solid[y * w + x] = 1
  }
  return { ...def, rows, w, h, solid }
}

export const ARENAS: Record<string, Arena> = Object.fromEntries(ARENA_DEFS.map((d) => [d.id, buildArena(d)]))
export const arenaOf = (id: string | undefined): Arena => ARENAS[id ?? ""] ?? ARENAS.belltower!

export const mod = (v: number, n: number) => ((v % n) + n) % n

/** Is the tile at integer (tx, ty) solid? Coordinates wrap. */
export function solidAt(a: Arena, tx: number, ty: number): boolean {
  return a.solid[mod(ty, a.h) * a.w + mod(tx, a.w)] === 1
}

/** Shortest signed distance from `b` to `a` on a wrapping axis of length n. */
export function wrapDelta(d: number, n: number): number {
  const m = mod(d, n)
  return m > n / 2 ? m - n : m
}
