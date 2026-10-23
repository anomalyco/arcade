import { expect, test } from "bun:test"
import type { FrameParts } from "@arcade/kit/gpu/frame-parts"
import type { Mesh } from "@arcade/kit/gpu/mesh"
import type { Renderer } from "@arcade/kit/gpu/renderer"
import { drawnTrunk } from "@arcade/kit/forest/trunk"
import { forestTrunkSway } from "@arcade/kit/forest/wind"
import { FEEL, type Tape } from "../shared/sim"
import { forestTree } from "../shared/forest-world"
import { makeWorld, terrainHeight } from "../shared/world"
import { TapeView } from "../src/tape-view"

const world = makeWorld()
const look = { wind: 1.5, gust: 0.6, trunkSway: 1 }

/** Signed distance from a plan point to a polygon's boundary: negative inside. */
function signedDist(poly: [number, number][], x: number, z: number): number {
  let inside = false, d = Infinity
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!
    if ((a[1] > z) !== (b[1] > z) && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside
    const dx = b[0] - a[0], dz = b[1] - a[1], k = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz || 1)))
    d = Math.min(d, Math.hypot(x - a[0] - dx * k, z - a[1] - dz * k))
  }
  return inside ? -d : d
}

/** A renderer that keeps a copy of each model's last vertices, and a sink that records which models were pushed. */
function fakeGpu() {
  const models: number[][] = []
  const pushed: number[] = []
  const renderer = { addModel: (m: Mesh) => models.push([...m.v]) - 1, setModel: (id: number, m: Mesh) => { models[id] = [...m.v] } } as unknown as Renderer
  const fp = { push: (id: number) => { pushed.push(id) } } as unknown as FrameParts
  return { models, pushed, renderer, fp }
}

test("tape wraps the drawn trunk snugly, off the bark, and its tails hang clear of it in wind", () => {
  const { models, renderer, fp } = fakeGpu()
  const height = (x: number, z: number) => terrainHeight(world.terrain, x, z)
  const picks = (["pine", "fir", "birch", "snag"] as const).map((sp) => world.trees.find((t) => t.species === sp && Math.abs(t.x) < 150 && Math.abs(t.z) < 150)!)
  for (const tree of picks) for (const yaw of [0.3, 2.2, -1.9]) {
    models.length = 0
    const view = new TapeView(renderer)
    const tape: Tape = { id: 1, tree: tree.id, x: tree.x, y: tree.y + 1.5, z: tree.z, yaw, by: 0, at: 0 }
    const eye = [tree.x + Math.cos(yaw) * 1.5, tree.y + 1.68, tree.z + Math.sin(yaw) * 1.5]
    // Three seconds of wind at 60 fps, close enough to simulate and to draw the near trunk and the knot.
    for (let f = 0; f <= 180; f++) view.draw(fp, world, [tape], f / 60, eye, FEEL, look, 35)
    const trunk = drawnTrunk(world.params.seed, height, forestTree(tree))
    const yc = trunk.base + 0.05 + 1.4
    // The trunk as drawn on the last frame: swayed by the wind, which the tape follows.
    const [sx, sz] = forestTrunkSway(tree.x, tree.z, 3, trunk.swayShare(yc), trunk.phase, look, [0, 0])
    const section = (y: number) => trunk.section(y).map(([x, z]) => [x + sx, z + sz] as [number, number])
    const v = models[0]!
    let clear = Infinity, lowest = Infinity
    const band: [number, number, number][] = []
    for (let i = 0; i < v.length; i += 11) {
      const x = v[i]!, y = v[i + 1]!, z = v[i + 2]!
      clear = Math.min(clear, signedDist(section(y), x, z))
      lowest = Math.min(lowest, y)
      if (Math.abs(y - yc) < 0.03) band.push([x, y, z])
    }
    // Nothing inside the bark.
    expect(clear).toBeGreaterThan(0.001)
    // Tails hang 25–50 cm below the knot.
    expect(yc - lowest).toBeGreaterThan(0.25)
    expect(yc - lowest).toBeLessThan(0.55)
    // Round the back, away from the knot, the band hugs the bark: within 2 cm of it everywhere, under 1 cm typically.
    const sec = section(yc)
    const gaps: number[] = []
    for (let k = 0; k < 48; k++) {
      const a = (k / 48) * Math.PI * 2
      // Skip the knot (up to 0.55 rad to one side of the tier) and the slack either side of it.
      if (Math.abs(Math.atan2(Math.sin(a - yaw), Math.cos(a - yaw))) < 1.25) continue
      const cx = sec.reduce((s, p) => s + p[0], 0) / sec.length, cz = sec.reduce((s, p) => s + p[1], 0) / sec.length
      const near = band.filter(([x, , z]) => Math.abs(Math.atan2(Math.sin(Math.atan2(z - cz, x - cx) - a), Math.cos(Math.atan2(z - cz, x - cx) - a))) < 0.12)
      if (!near.length) throw new Error(`no band at angle ${a.toFixed(2)} on ${tree.species}`)
      gaps.push(Math.min(...near.map(([x, , z]) => signedDist(sec, x, z))))
    }
    gaps.sort((a, b) => a - b)
    expect(gaps[gaps.length - 1]!).toBeLessThan(0.02)
    expect(gaps[Math.floor(gaps.length / 2)]!).toBeLessThan(0.01)
  }
})

test("contact shadows go to the nearest tapes, each on its own swaying trunk, on the bark and never in it", () => {
  const { models, pushed, renderer, fp } = fakeGpu()
  const height = (x: number, z: number) => terrainHeight(world.terrain, x, z)
  // Six tapes round a point in the woods; the eye is nearest the last two (a birch sways several mm, a pine ~1 mm).
  const at = world.trees.find((t) => t.species === "birch" && Math.abs(t.x) < 150 && Math.abs(t.z) < 150)!
  const near = world.trees.filter((t) => t.id !== at.id && Math.hypot(t.x - at.x, t.z - at.z) < 7).sort((a, b) => Math.hypot(b.x - at.x, b.z - at.z) - Math.hypot(a.x - at.x, a.z - at.z)).slice(0, 5)
  const trees = [...near, at]
  const tapes: Tape[] = trees.map((t, i) => ({ id: i + 1, tree: t.id, x: t.x, y: t.y + 1.5, z: t.z, yaw: 1, by: 0, at: 0 }))
  const eye = [at.x + 1.2, at.y + 1.68, at.z]
  const view = new TapeView(renderer)
  for (let f = 0; f <= 60; f++) { pushed.length = 0; view.draw(fp, world, tapes, 2 + f / 60, eye, FEEL, look, 35) }
  const skirts = pushed.filter((id) => id !== 0)
  expect(skirts.length).toBe(Math.min(4, trees.filter((t) => Math.hypot(t.x - eye[0]!, t.z - eye[2]!) < 9).length))
  const nearest = [...trees].sort((a, b) => Math.hypot(a.x - eye[0]!, a.z - eye[2]!) - Math.hypot(b.x - eye[0]!, b.z - eye[2]!)).slice(0, skirts.length)
  for (const id of skirts) {
    const v = models[id]!
    // Which tree: the one whose trunk the strip surrounds.
    const tree = nearest.find((t) => Math.hypot(v[0]! - t.x, v[2]! - t.z) < t.radius * 2 + 0.1)
    expect(tree).toBeDefined()
    const trunk = drawnTrunk(world.params.seed, height, forestTree(tree!))
    const [sx, sz] = forestTrunkSway(tree!.x, tree!.z, 3, trunk.swayShare(trunk.base + 1.45), trunk.phase, look, [0, 0])
    for (let i = 0; i < v.length; i += 11) {
      const d = signedDist(trunk.section(v[i + 1]!).map(([x, z]) => [x + sx, z + sz] as [number, number]), v[i]!, v[i + 2]!)
      expect(d).toBeGreaterThan(0.0005)
      expect(d).toBeLessThan(0.004)
    }
  }
})

test("tails keep moving after the world is regenerated and the clock restarts", () => {
  const { models, renderer, fp } = fakeGpu()
  const tree = world.trees.find((t) => t.species === "pine" && Math.abs(t.x) < 150)!
  const tape: Tape = { id: 1, tree: tree.id, x: tree.x, y: tree.y + 1.5, z: tree.z, yaw: 0, by: 0, at: 0 }
  const eye = [tree.x + 1.5, tree.y + 1.68, tree.z]
  const view = new TapeView(renderer)
  for (let f = 0; f <= 120; f++) view.draw(fp, world, [tape], 50 + f / 60, eye, FEEL, look, 35)
  for (const reset of [true, false]) {
    if (reset) view.reset()
    const frames: number[][] = []
    for (let f = 0; f <= 60; f++) { view.draw(fp, world, [tape], f / 60, eye, FEEL, look, 35); frames.push([...models[0]!]) }
    const moved = frames[60]!.reduce((m, x, i) => Math.max(m, Math.abs(x - frames[30]![i]!)), 0)
    expect(moved).toBeGreaterThan(0.002)
  }
})
