// Worker side of __bench.worker(): bake the terrain grids off the main thread (cold: fresh worker, no JIT warm-up)
// in JS or in the Rust/WASM port, and transfer them back.
import { createTerrain, GRID_N, MICRO_N, type TerrainInput } from "../kernels/terrain-js"

const started = performance.now()
self.onmessage = async (e: MessageEvent<{ input: TerrainInput; mode: "js" | "wasm" }>) => {
  const { input, mode } = e.data
  const t = performance.now()
  let coarse: Float32Array, roadDist: Float32Array, micro: Float32Array
  let setupMs = 0
  if (mode === "wasm") {
    const { instance } = await WebAssembly.instantiateStreaming(fetch("terrain.wasm"), {})
    const w = instance.exports as any
    setupMs = performance.now() - t
    const v = new Float64Array(w.memory.buffer, w.input_ptr(), 8192)
    const na = input.access.length / 2
    const nc = input.county.length / 2
    v.set([input.worldHalf, input.accessHalfWidth, input.countyHalfWidth, ...input.fence, ...input.apron, na, nc])
    v.set(input.access, 13)
    v.set(input.county, 13 + na * 2)
    w.bake()
    const G = GRID_N * GRID_N
    coarse = new Float32Array(w.memory.buffer, w.coarse_ptr(), G).slice()
    roadDist = new Float32Array(w.memory.buffer, w.road_ptr(), G).slice()
    micro = new Float32Array(w.memory.buffer, w.micro_ptr(), MICRO_N * MICRO_N).slice()
  } else {
    const terrain = createTerrain(input)
    terrain.bake()
    ;({ coarse, roadDist, micro } = terrain)
  }
  const bakeMs = performance.now() - t
  const posted = performance.timeOrigin + performance.now()
  ;(self as unknown as Worker).postMessage({ started: performance.timeOrigin + started, setupMs, bakeMs, posted, coarse, roadDist, micro }, [coarse.buffer, roadDist.buffer, micro.buffer])
}
