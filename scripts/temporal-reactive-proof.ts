/**
 * Off-browser proof that everything moving on its own writes the temporal reactive mask (AR-72): the shared Renderer
 * with Outbreak's real shaders on the machine's WebGPU (Deno's wgpu on Metal) draws one TAA + upscale frame per source
 * (alpha and additive sprites, kit particles, rain, splatter drops, tyre smoke, a `reactive` batch), reads the mask back
 * and counts the pixels each lit. Outbreak's beam dust plugin runs its reactive draw too, but its motes need Outbreak's
 * light and visibility uniforms, so here it only proves the pipeline validates. Also checks that rain gets the jittered
 * camera and the internal size, that an unflagged batch stays out, and that nothing raises a WebGPU validation error.
 *
 *   deno run -A --sloppy-imports scripts/temporal-reactive-proof.ts
 */
import { mat4 } from "wgpu-matrix"
import { LIGHT_FLOATS, MAX_LIGHTS, MAX_OCCLUDERS, OCC_FLOATS, MAX_MAP_LIGHTS } from "../packages/kit/limits"
import { FRAME_FLOATS } from "../packages/kit/gpu/shaders"
import { Mesh } from "../packages/kit/gpu/mesh"
import { Renderer, SPRITE_FLOATS, type FrameInput, type TemporalSettings } from "../packages/kit/gpu/renderer"
import { Particles, type ParticleSpec } from "../packages/kit/fx/particles"
import { Splatter } from "../packages/kit/fx/splatter"
import type { SplatterSurfaces } from "../packages/kit/fx/splatter-surfaces"
import { SmokeTrail } from "../packages/kit/fx/smoke-trail"
import { createWeatherSettings, WeatherSimulation, type WeatherPrepareInput } from "../packages/kit/weather"
import { shaders } from "../games/outbreak/src/shaders"
import { DustPass } from "../games/outbreak/src/air/dust"

const W = 640
const H = 360
const adapter = await navigator.gpu.requestAdapter()
if (!adapter) throw new Error("no WebGPU adapter")
const device = await adapter.requestDevice()
const errors: string[] = []
device.addEventListener("uncapturederror", (e) => errors.push((e as GPUUncapturedErrorEvent).error.message))
const format: GPUTextureFormat = "bgra8unorm"
const ctx = { getCurrentTexture: () => target } as unknown as GPUCanvasContext
const target = device.createTexture({ size: [W, H], format, usage: GPUTextureUsage.RENDER_ATTACHMENT })
const renderer = new Renderer(device, ctx, format, shaders)
renderer.resize(W, H)
const taau: TemporalSettings = { mode: "taau", renderScale: 0.67, sharpen: 0.35, history: 0.9 }

const frame = new Float32Array(FRAME_FLOATS)
const eye = [0, 30, 20]
const vp = mat4.multiply(mat4.perspective(0.6, W / H, 1, 200), mat4.lookAt(eye, [0, 0, 0], [0, 1, 0]))
frame.set(vp, 0)
frame.set([...eye, 1], 16)
frame.set([W, H, 2, 0], 20)
frame.set([0.05, 0.06, 0.08, 0.2], 28)
const lights = new Float32Array(MAX_LIGHTS * LIGHT_FLOATS)
lights.set([0, 1.2, 0, 12, 1, 0.9, 0.7, 1, 0, -1, 0.9, 1, -1, 0, 0, -1], 0)
lights.set([3, 2, 3, 6, 1, 0.6, 0.3, 1, 0, 0, 0, 0, -1, 0, 0, -1], LIGHT_FLOATS)

const mesh = new Mesh()
mesh.box(-0.6, 0, -0.6, 0.6, 1.2, 0.6, [0.8, 0.8, 0.8])
const model = renderer.addModel(mesh)
const inst = (x: number) => new Float32Array([x, 1, 0, 0, 1, 1, 1, 1, 0, 0, 1, 0])

const sprites = (n: number, y: number) => {
  const a = new Float32Array(n * SPRITE_FLOATS)
  for (let i = 0; i < n; i++) a.set([i * 2 - n, y, 0, 0.8, 1, 0.5, 0.1, 1, 0, 0, 0, 0], i * SPRITE_FLOATS)
  return a
}

const particles = new Particles()
const puff: ParticleSpec = { kind: "soft", life: 4, size: 0.9, growth: 0, gravity: 0, drag: 0, bounce: 0, r: 0.6, g: 0.6, b: 0.6, alpha: 1 }
for (let i = 0; i < 12; i++) particles.spawn(puff, i - 6, 1.5, 1, 0, 0.2, 0, i)

const splatter = new Splatter({ triangles: new Float32Array(16) } as unknown as SplatterSurfaces)
for (let i = 0; i < 12; i++) splatter.particles.set([i - 6, 1.2, -1, 0.12, 0, -1, 0, 1, 0.5, 0.02, 0.02, 1, 0], i * 13)

const smoke = new SmokeTrail()
for (let i = 0; i < 20; i++) smoke.spawn(i * 0.5 - 5, 0.4, 2, 0, 0, 0, 1)
smoke.update(1 / 60)
smoke.prepare()

const weatherSim = new WeatherSimulation()
const weather: WeatherPrepareInput = {
  settings: { ...createWeatherSettings("storm"), litOnly: 0 },
  state: weatherSim.state,
  viewProj: vp,
  eye,
  viewportWidth: W,
  viewportHeight: H,
}

const dust = new DustPass(renderer.passContext)

const base = (): FrameInput => ({
  frame,
  lights,
  lightCount: 2,
  shadowLightCount: 0,
  occluders: new Float32Array(MAX_OCCLUDERS * OCC_FLOATS),
  occluderCount: 0,
  lampPower: new Float32Array(MAX_MAP_LIGHTS),
  lampCount: 0,
  view: [-30, -30, 30, 30],
  batches: [],
  alphaSprites: new Float32Array(SPRITE_FLOATS),
  alphaCount: 0,
  addSprites: new Float32Array(SPRITE_FLOATS),
  addCount: 0,
  grade: [0, 0, 0, 1],
})

type Internals = {
  temporal: { reactive: GPUTexture }
  weatherRenderer?: { uniformData: Float32Array }
}
const internals = renderer as unknown as Internals

async function maskPixels(): Promise<number> {
  const tex = internals.temporal.reactive
  const bpr = Math.ceil((tex.width * 4) / 256) * 256
  const buf = device.createBuffer({ size: bpr * tex.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
  const enc = device.createCommandEncoder()
  enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: bpr }, [tex.width, tex.height])
  device.queue.submit([enc.finish()])
  await buf.mapAsync(GPUMapMode.READ)
  const px = new Uint8Array(buf.getMappedRange())
  let lit = 0
  for (let y = 0; y < tex.height; y++)
    for (let x = 0; x < tex.width; x++) {
      const o = y * bpr + x * 4
      if (Math.max(px[o]!, px[o + 1]!, px[o + 2]!, px[o + 3]!) > 8) lit++
    }
  buf.unmap()
  buf.destroy()
  return lit
}

const sources: [string, (f: FrameInput) => void][] = [
  ["nothing", () => {}],
  ["alpha sprites", (f) => ((f.alphaSprites = sprites(8, 1)), (f.alphaCount = 8))],
  ["additive sprites", (f) => ((f.addSprites = sprites(8, 2)), (f.addCount = 8))],
  ["kit particles", (f) => (f.fxParticles = particles)],
  ["rain", (f) => (f.weather = weather)],
  ["splatter drops", (f) => (f.splatter = splatter)],
  ["tyre smoke", () => renderer.setSmoke(smoke, true)],
  ["reactive batch", (f) => (f.batches = [{ model, data: inst(0), count: 1, reactive: true }])],
  ["plain batch", (f) => (f.batches = [{ model, data: inst(0), count: 1 }])],
  ["beam dust plugin", () => renderer.addPass("alpha", dust)],
]

renderer.setTemporal(taau)
const results: Record<string, number> = {}
for (const [name, add] of sources) {
  const f = base()
  add(f)
  dust.frame(f.lightCount, "high", true)
  for (let i = 0; i < 2; i++) renderer.drawTo(f, target.createView())
  await device.queue.onSubmittedWorkDone()
  results[name] = await maskPixels()
  renderer.setSmoke(smoke, false)
  renderer.removePass(dust)
}

// Rain under TAA: the jittered matrix (not the game's `viewProj`) and the internal size.
const f = base()
f.weather = weather
renderer.drawTo(f, target.createView())
await device.queue.onSubmittedWorkDone()
const u = internals.weatherRenderer!.uniformData
const rainJittered = Array.from(u.subarray(0, 16)).some((v, i) => Math.abs(v - vp[i]!) > 1e-7)
const rainSize = [u[24], u[25]]
const internal = [renderer.internalWidth, renderer.internalHeight]
renderer.setTemporal(null)
renderer.drawTo(f, target.createView())
await device.queue.onSubmittedWorkDone()
const msaaRainCamera = Array.from(u.subarray(0, 16)).every((v, i) => Math.abs(v - vp[i]!) < 1e-6) && u[24] === W && u[25] === H

await new Promise((r) => setTimeout(r, 200))
console.log(JSON.stringify({ maskPixels: results, internal, rainJittered, rainSize, msaaRainCamera }, null, 1))
const must = ["alpha sprites", "additive sprites", "kit particles", "rain", "splatter drops", "tyre smoke", "reactive batch"]
const failures = [
  ...must.filter((k) => !(results[k]! > 0)).map((k) => `${k} wrote no reactive pixels`),
  ...(results.nothing ? ["empty frame lit the mask"] : []),
  ...(results["plain batch"] ? ["an unflagged batch lit the mask"] : []),
  ...(rainJittered ? [] : ["rain kept the unjittered camera under TAA"]),
  ...(rainSize[0] === internal[0] && rainSize[1] === internal[1] && internal[0]! < W ? [] : ["rain kept the canvas size under TAA"]),
  ...(msaaRainCamera ? [] : ["MSAA rain lost the game's camera"]),
  ...errors.map((e) => `WebGPU: ${e}`),
]
if (failures.length) throw new Error(`temporal reactive proof failed:\n${[...new Set(failures)].join("\n")}`)
console.log("PASS")
