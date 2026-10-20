// Generator microbenchmarks, runtime-agnostic (Bun/JSC and Chrome/V8): the game's terrain CPU work in JS (frozen
// copy, bench/kernels/terrain-js.ts) vs the Rust/WASM port (scalar f64 and SIMD128), including the cost of copying
// results out of WASM memory, plus the live forest placement for scale and a "baked blob" decode.
import { ACCESS_ROAD, BOOTH, COUNTY_ROAD, FENCE, WORLD_HALF, accessRoadSamples, countyRoadSamples } from "../../src/world/layout"
import { createTerrain, FAR_SEGMENTS, GRID_N, MICRO_N, NEAR_N, type TerrainInput } from "./terrain-js"
import * as live from "../../src/world/height"
import { placeTrees } from "../../src/world/forest/placement"

const flat = (s: readonly (readonly [number, number])[]) => Float64Array.from(s.flat())

export function terrainInput(): TerrainInput {
  const apron: [number, number, number, number] = [-16, FENCE.max[1], Math.max(16, BOOTH.x + BOOTH.w / 2 + 5), BOOTH.z + BOOTH.d / 2 + 6]
  return {
    worldHalf: WORLD_HALF,
    access: flat(accessRoadSamples(3)),
    accessHalfWidth: ACCESS_ROAD.width / 2,
    county: flat(countyRoadSamples(-WORLD_HALF - 8, WORLD_HALF + 8, 4)),
    countyHalfWidth: COUNTY_ROAD.width / 2,
    fence: [FENCE.min[0], FENCE.min[1], FENCE.max[0], FENCE.max[1]],
    apron,
  }
}

const now = () => performance.now()
function time(fn: () => void, reps: number, warm = 2) {
  for (let i = 0; i < warm; i++) fn()
  const xs: number[] = []
  for (let i = 0; i < reps; i++) {
    const t = now()
    fn()
    xs.push(now() - t)
  }
  xs.sort((a, b) => a - b)
  return { median: +xs[xs.length >> 1]!.toFixed(3), min: +xs[0]!.toFixed(3) }
}
const maxDiff = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let m = 0
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!))
  return +m.toExponential(2)
}

type Wasm = {
  memory: WebAssembly.Memory
  input_ptr(): number
  bake(): void
  bake_simd?(): void
  fill_patch(cx: number, cz: number): void
  fill_far(): void
  height_at(x: number, z: number): number
  coarse_ptr(): number
  road_ptr(): number
  micro_ptr(): number
  pos_ptr(): number
  nor_ptr(): number
  uv_ptr(): number
  surf_ptr(): number
  far_pos_ptr(): number
  far_surf_ptr(): number
}

async function instantiate(bytes: ArrayBuffer | Uint8Array) {
  const t = now()
  const { instance } = (await WebAssembly.instantiate(bytes as BufferSource, {})) as unknown as WebAssembly.WebAssemblyInstantiatedSource
  return { w: instance.exports as unknown as Wasm, instantiateMs: +(now() - t).toFixed(2) }
}

function writeInput(w: Wasm, inp: TerrainInput) {
  const v = new Float64Array(w.memory.buffer, w.input_ptr(), 8192)
  const na = inp.access.length / 2
  const nc = inp.county.length / 2
  v.set([inp.worldHalf, inp.accessHalfWidth, inp.countyHalfWidth, ...inp.fence, ...inp.apron, na, nc])
  v.set(inp.access, 13)
  v.set(inp.county, 13 + na * 2)
}

export async function runSuite(wasm: { scalar: ArrayBuffer | Uint8Array; simd: ArrayBuffer | Uint8Array }, reps = 7) {
  const inp = terrainInput()
  const js = createTerrain(inp)
  js.bake()
  const out: Record<string, unknown> = {}
  out.copyMatchesLiveHeight = {
    coarse: maxDiff(js.coarse, live.coarse),
    roadDist: maxDiff(js.roadDist, live.roadDist),
    micro: maxDiff(js.micro, live.micro),
  }

  const cx = -20
  const cz = 260
  const r: Record<string, Record<string, Record<string, unknown>>> = {}
  r.bake = { js: time(() => js.bake(), reps) }
  r.fillPatch = { js: time(() => js.fillPatch(cx, cz), reps) }
  r.fillFar = { js: time(() => js.fillFar(), reps) }
  let hsum = 0
  r.heightAt1M = { js: time(() => { for (let i = 0; i < 1_000_000; i++) hsum += js.heightAt(-600 + (i % 1000) * 1.2, -600 + Math.floor(i / 1000) * 1.2) }, 3, 1) }
  const jsPatch = js.fillPatch(cx, cz)
  const jsPatchCopy = { pos: jsPatch.pos.slice(), nor: jsPatch.nor.slice(), surf: jsPatch.surf.slice() }
  const jsFarPos = js.fillFar().pos.slice()

  for (const [name, bytes] of [["wasm", wasm.scalar], ["wasmSimd", wasm.simd]] as const) {
    const { w, instantiateMs } = await instantiate(bytes)
    writeInput(w, inp)
    const mem = () => w.memory.buffer
    const G = GRID_N * GRID_N
    // Copy-out: what a caller pays to get owned Float32Arrays (e.g. to hand to a BufferAttribute or postMessage).
    const copyGrids = () => [new Float32Array(mem(), w.coarse_ptr(), G).slice(), new Float32Array(mem(), w.road_ptr(), G).slice(), new Float32Array(mem(), w.micro_ptr(), MICRO_N * MICRO_N).slice()]
    const N3 = NEAR_N * NEAR_N * 3
    const N2 = NEAR_N * NEAR_N * 2
    const copyPatch = () => [new Float32Array(mem(), w.pos_ptr(), N3).slice(), new Float32Array(mem(), w.nor_ptr(), N3).slice(), new Float32Array(mem(), w.uv_ptr(), N2).slice(), new Float32Array(mem(), w.surf_ptr(), N2).slice()]
    const FN = (FAR_SEGMENTS + 1) ** 2
    w.bake()
    const bakeFn = name === "wasmSimd" && w.bake_simd ? () => w.bake_simd!() : () => w.bake()
    bakeFn()
    const grids = copyGrids()
    r.bake[name] = { ...time(bakeFn, reps), copyOutMs: time(copyGrids, reps).median, instantiateMs, maxDiffCoarse: maxDiff(grids[0]!, js.coarse), maxDiffRoad: maxDiff(grids[1]!, js.roadDist) }
    // Patch and far mesh from the scalar bake so the comparison is like for like.
    w.bake()
    r.fillPatch[name] = { ...time(() => w.fill_patch(cx, cz), reps), copyOutMs: time(copyPatch, reps).median }
    w.fill_patch(cx, cz)
    const p = copyPatch()
    r.fillPatch[name]!.maxDiffPos = maxDiff(p[0]!, jsPatchCopy.pos)
    r.fillPatch[name]!.maxDiffSurf = maxDiff(p[3]!, jsPatchCopy.surf)
    r.fillFar[name] = { ...time(() => w.fill_far(), reps), copyOutMs: time(() => [new Float32Array(mem(), w.far_pos_ptr(), FN * 3).slice(), new Float32Array(mem(), w.far_surf_ptr(), FN * 2).slice()], reps).median }
    w.fill_far()
    r.fillFar[name]!.maxDiffPos = maxDiff(new Float32Array(mem(), w.far_pos_ptr(), FN * 3), jsFarPos)
    // Fine-grained calls across the JS↔WASM boundary (what porting only heightAt would look like).
    r.heightAt1M[name] = time(() => { for (let i = 0; i < 1_000_000; i++) hsum += w.height_at(-600 + (i % 1000) * 1.2, -600 + Math.floor(i / 1000) * 1.2) }, 3, 1)
  }
  out.kernels = r

  // Live forest placement (src/world/forest/placement.ts), JS only, for scale: it runs in the forest Worker today.
  out.placeTrees = time(() => placeTrees({ density: 1, seed: 7 }), 3, 1)
  out.placeTreesCount = placeTrees({ density: 1, seed: 7 }).count

  // Baked blob: the three grids as one binary (what an offline bake would ship) → views, vs baking.
  const blob = new Uint8Array(4 * (2 * GRID_N * GRID_N + MICRO_N * MICRO_N))
  const f = new Float32Array(blob.buffer)
  f.set(js.coarse, 0)
  f.set(js.roadDist, GRID_N * GRID_N)
  f.set(js.micro, 2 * GRID_N * GRID_N)
  out.bakedBlobBytes = blob.byteLength
  out.bakedBlobDecodeMs = time(() => {
    const copy = blob.slice()
    void new Float32Array(copy.buffer, 0, GRID_N * GRID_N)
  }, reps).median
  out.sink = hsum > 0
  return out
}
