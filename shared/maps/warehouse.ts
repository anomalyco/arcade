import type { Rect } from "../geom"
import type { MapDef } from "./types"

const W = 44
const H = 30
const T = 0.6
const LAMP_COLOR = [1, 0.95, 0.86] as const

const racks: Rect[] = [10, 14, 18, 22, 26, 30].flatMap((x): Rect[] => [
  [x, 4, x + 1, 11],
  [x, 15, x + 1, 22],
])

/** A warehouse with a racked floor, an office block in the north-east and two doors into it. */
export const warehouse: MapDef = {
  id: "warehouse",
  name: "Warehouse",
  blurb: "Tight aisles, fast fights",
  size: [W, H],
  walls: [
    [0, 0, W, T],
    [0, H - T, W, H],
    [0, T, T, H - T],
    [W - T, T, W, H - T],
    [33, T, 33.6, 3],
    [33, 4, 33.6, 7.4],
    [33.6, 7.4, 36.4, 8],
    [37.6, 7.4, W - T, 8],
    [36.5, 2, 40, 3.2],
    [38, 5, 42, 5.8],
    ...racks,
    [4, 24, 6, 26],
    [6.5, 26, 8, 27.5],
    [12, 24, 14, 25.5],
    [16, 25.5, 17.2, 26.7],
    [36, 20, 37, 22],
  ],
  doors: [
    { id: 0, rect: [33, 3, 33.6, 4] },
    { id: 1, rect: [36.4, 7.4, 37.6, 8] },
  ],
  lamps: [
    { id: 0, x: 5.5, y: 8, radius: 9, power: 1, color: LAMP_COLOR },
    { id: 1, x: 5.5, y: 21, radius: 9, power: 1, color: LAMP_COLOR },
    { id: 2, x: 12.5, y: 8, radius: 9, power: 1, color: LAMP_COLOR },
    { id: 3, x: 12.5, y: 21, radius: 9, power: 1, color: LAMP_COLOR },
    { id: 4, x: 16.5, y: 15, radius: 9, power: 1, color: LAMP_COLOR },
    { id: 5, x: 20.5, y: 8, radius: 9, power: 1, color: LAMP_COLOR },
    { id: 6, x: 20.5, y: 21, radius: 9, power: 1, color: LAMP_COLOR },
    { id: 7, x: 24.5, y: 15, radius: 9, power: 1, color: LAMP_COLOR },
    { id: 8, x: 29.5, y: 15, radius: 9, power: 1, color: LAMP_COLOR },
    { id: 9, x: 38, y: 22, radius: 9, power: 1, color: LAMP_COLOR },
  ],
  spawns: [
    { x: 3, y: 2 },
    { x: 3, y: 15 },
    { x: 3, y: 27 },
    { x: 16, y: 27.5 },
    { x: 25, y: 2 },
    { x: 27, y: 27 },
    { x: 41, y: 14 },
    { x: 41, y: 26 },
  ],
  nav: [
    { x: 5.5, y: 4 },
    { x: 5.5, y: 15 },
    { x: 5.5, y: 28 },
    { x: 12.5, y: 4 },
    { x: 12.5, y: 15 },
    { x: 12.5, y: 26 },
    { x: 16.5, y: 4 },
    { x: 14.5, y: 27.5 },
    { x: 20.5, y: 4 },
    { x: 20.5, y: 15 },
    { x: 20.5, y: 26 },
    { x: 24.5, y: 4 },
    { x: 24.5, y: 26 },
    { x: 28.5, y: 4 },
    { x: 28.5, y: 15 },
    { x: 28.5, y: 26 },
    { x: 36, y: 12 },
    { x: 36, y: 26 },
    { x: 40, y: 15 },
  ],
  noisy: [
    { rect: [22, 24, 27, 27.5], kind: "grate" },
    { rect: [34, 14, 37, 16.5], kind: "puddle" },
  ],
}
