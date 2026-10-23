import { expect, test } from "bun:test"
import { loadForestModels } from "@arcade/kit/forest/assets"
import { buildForest, CHUNK, type ForestBuild } from "@arcade/kit/forest/build"
import { boxDistanceXZ, boxInFrustum, nearStatic, STATIC_NEAR } from "@arcade/kit/forest/cull"
import { frustumPlanes } from "@arcade/kit/gpu/fog-scatter"
import { toForestWorld } from "../shared/forest-world"
import { makeWorld } from "../shared/world"

const world = makeWorld()
const dock = world.buildings.find((b) => b.kind === "dock")!
let built: ForestBuild | undefined
async function forest() {
  if (built) return built
  const fetch0 = globalThis.fetch
  globalThis.fetch = (async (url: string) => new Response(Bun.file(url))) as unknown as typeof fetch
  try {
    const models = await loadForestModels(new URL("../../../packages/kit/forest/assets/", import.meta.url).pathname)
    return (built = buildForest(toForestWorld(world), models, { scatter: 0, fernDensity: 0, litter: 0, campDetail: true }))
  } finally { globalThis.fetch = fetch0 }
}
const dockChunk = (b: ForestBuild) => b.chunks.find((c) => c.key === `${Math.floor((dock.rect[0] + dock.rect[2]) / 2 / CHUNK)},${Math.floor(dock.rect[1] / CHUNK)}`)!

/** Column-major WebGPU viewProj (clip z 0..1) of the woods camera: yaw 0 looks along −z, π along +z. */
function viewProj(eye: readonly number[], yaw: number, pitch: number, fovY = (68 * Math.PI) / 180, aspect = 16 / 9, near = 0.08, far = 350) {
  const f = [-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)]
  const rl = Math.hypot(f[2]!, f[0]!), r = [-f[2]! / rl, 0, f[0]! / rl]
  const u = [r[1]! * f[2]! - r[2]! * f[1]!, r[2]! * f[0]! - r[0]! * f[2]!, r[0]! * f[1]! - r[1]! * f[0]!]
  const dot = (a: number[]) => a[0]! * eye[0]! + a[1]! * eye[1]! + a[2]! * eye[2]!
  const view = [[...r, -dot(r)], [...u, -dot(u)], [-f[0]!, -f[1]!, -f[2]!, dot(f)], [0, 0, 0, 1]]
  const t = 1 / Math.tan(fovY / 2)
  const proj = [[t / aspect, 0, 0, 0], [0, t, 0, 0], [0, 0, far / (near - far), (near * far) / (near - far)], [0, 0, -1, 0]]
  const out = new Float32Array(16)
  for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) {
    let s = 0
    for (let k = 0; k < 4; k++) s += proj[row]![k]! * view[k]![col]!
    out[col * 4 + row] = s
  }
  return out
}

test("standing on the dock looking out along it, its chunk stays in view though its cell is behind", async () => {
  const c = dockChunk(await forest())
  const cell = [c.x, c.box[1]!, c.z, c.x + CHUNK, c.box[4]!, c.z + CHUNK]
  for (const pitch of [-0.3, 0]) {
    const planes = frustumPlanes(viewProj([-22, 2.21, 83], Math.PI, pitch))
    expect(boxInFrustum(planes, c.box)).toBe(true)
    expect(boxInFrustum(planes, cell)).toBe(false)
  }
}, 60_000)

test("the dock draws its full geometry by its own extent, not its cell's, and keeps a far version past that", async () => {
  const c = dockChunk(await forest())
  // 60 m past the dock's tip, out over the lake: 71+ m from the cell, inside the near ring by the dock.
  const x = -22, z = dock.rect[3] + 60
  expect(boxDistanceXZ([c.x, 0, c.z, c.x + CHUNK, 0, c.z + CHUNK], x, z)).toBeGreaterThan(STATIC_NEAR)
  expect(nearStatic(c.bakedBox, x, z)).toBe(true)
  expect(nearStatic(c.bakedBox, x, z + 20)).toBe(false)
  // From across the lake the far mesh still has the deck out over the water.
  const far = new Float32Array(c.far.opaque)
  let deck = 0
  for (let i = 0; i < far.length; i += 8) {
    if (far[i]! >= dock.rect[0] - 0.1 && far[i]! <= dock.rect[2] + 0.1 && far[i + 2]! > c.z + CHUNK && far[i + 2]! <= dock.rect[3] + 0.1 && far[i + 1]! > world.lake.level) deck++
  }
  expect(deck).toBeGreaterThan(0)
}, 60_000)
