import { expect, test } from "bun:test"
import type { MapDef } from "../shared/maps"
import { bakeFloor } from "../src/render/level-mesh"

const room = (): MapDef => ({
  kind: "office", id: "window-test", seed: 1, name: "Window test", size: [8, 8],
  floors: [{ kind: "wood", rect: [0, 0, 8, 8] }], walls: [], props: [], lights: [],
  windows: [[0, 0, 0.2, 8]], glass: [], tape: [], spawns: [],
})
const moonAt = ({ moon: f }: ReturnType<typeof bakeFloor>, x: number, y: number) => f.data[Math.floor(y / 8 * f.h) * f.w + Math.floor(x / 8 * f.w)]!

test("a sub-texel blocker casts a continuous shadow without ray-march holes", () => {
  const map = room(), lit = bakeFloor(map)
  // Two centimetres thick: much narrower than both a texel and the former march step.
  const blocked = bakeFloor({ ...map, walls: [{ rect: [1.003, 2, 1.023, 2.5], h: 2.7, style: "wall" }] })
  for (const y of [2.75, 2.875, 3]) {
    expect(moonAt(lit, 2, y)).toBe(255)
    expect(moonAt(blocked, 2, y)).toBe(0)
  }
  expect(moonAt(blocked, 2, 2.5)).toBe(255)
})

test("mullions retain a dark core with coverage only at the boundary, not a box-blurred band", () => {
  const f = bakeFloor(room())
  expect(moonAt(f, 2, 3.65)).toBeLessThan(32)
  expect([...f.moon.data].some(v => v > 0 && v < 255)).toBe(true)
  expect(moonAt(f, 2, 3.4)).toBe(255)
  expect(moonAt(f, 2, 3.9)).toBe(255)
})

test("quarter-turning a window and blocker rotates its baked coverage", () => {
  // Three complete 2.4 m panes: reflection of the window axis preserves its mullion phase.
  const map = { ...room(), windows: [[0, 0.4, 0.2, 7.6] as const], walls: [{ rect: [1.003, 2, 1.023, 2.5] as const, h: 2.7, style: "wall" as const }] }
  const turn = (r: readonly number[]) => [8 - r[3]!, r[0]!, 8 - r[1]!, r[2]!] as const
  const a = bakeFloor(map).moon, b = bakeFloor({ ...map, windows: map.windows.map(turn), walls: map.walls.map(w => ({ ...w, rect: turn(w.rect) })) }).moon
  for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x++) {
    expect(Math.abs(b.data[x * b.w + (a.h - 1 - y)]! - a.data[y * a.w + x]!)).toBeLessThanOrEqual(1)
  }
})
