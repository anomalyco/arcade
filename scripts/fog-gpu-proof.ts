/**
 * Off-browser GPU proof for the kit fog (`@arcade/kit/gpu/fog-scatter`, `volume-pass`): the shared Renderer on the
 * machine's WebGPU (Deno's wgpu on Metal) draws the fog test lot (`scripts/fog-scene/scene.ts`: fog scene shader with
 * height fog and fog-sky ambient, sodium lamps, wet ground) with two volume slots (a no-depth bilinear slot and
 * `fogScatterVolume` with depth, half-res history and the depth-aware upsample), under TAA and under MSAA. It reads the
 * temporal output back and checks that the fog light lands under and round the lamp, that it leaves HDR alpha alone
 * (Outbreak packs its shroud there), that the history steadies the jittered samples, and that nothing raises a WebGPU
 * validation error. FOG_PROOF_IMAGE=<dir> writes today.ppm / fog.ppm / raw.ppm.
 *
 *   deno run -A --sloppy-imports scripts/fog-gpu-proof.ts
 */
import { FOG_SCENE_ALPHA, buildFogScene } from "./fog-scene/scene"

const W = 480
const H = 270
const adapter = await navigator.gpu.requestAdapter()
if (!adapter) throw new Error("no WebGPU adapter")
const device = await adapter.requestDevice()
const errors: string[] = []
device.addEventListener("uncapturederror", (e) => errors.push((e as GPUUncapturedErrorEvent).error.message))
const format: GPUTextureFormat = "bgra8unorm"
const target = device.createTexture({ size: [W, H], format, usage: GPUTextureUsage.RENDER_ATTACHMENT })
const ctx = { getCurrentTexture: () => target } as unknown as GPUCanvasContext
const scene = buildFogScene(device, ctx, format, W, H)
const { renderer, fog, viewProj: vp } = scene

const half = (h: number) => {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff
  return e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15)
}
async function readOutput(): Promise<Float32Array> {
  const tex = (renderer as unknown as { temporal: { output: GPUTexture } }).temporal.output
  const bpr = Math.ceil((tex.width * 8) / 256) * 256
  const buf = device.createBuffer({ size: bpr * tex.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
  const enc = device.createCommandEncoder()
  enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: bpr }, [tex.width, tex.height])
  device.queue.submit([enc.finish()])
  await buf.mapAsync(GPUMapMode.READ)
  const raw = new Uint16Array(buf.getMappedRange())
  const out = new Float32Array(tex.width * tex.height * 4)
  for (let y = 0; y < tex.height; y++) for (let x = 0; x < tex.width * 4; x++) out[y * tex.width * 4 + x] = half(raw[(y * bpr) / 2 + x]!)
  buf.unmap()
  buf.destroy()
  return out
}
const project = (p: number[]) => {
  const c = [0, 1, 2, 3].map((r) => vp[r]! * p[0]! + vp[4 + r]! * p[1]! + vp[8 + r]! * p[2]! + vp[12 + r]!)
  return [Math.round((c[0]! / c[3]! * 0.5 + 0.5) * W), Math.round((0.5 - c[1]! / c[3]! * 0.5) * H)]
}
const lum = (img: Float32Array, x: number, y: number) => {
  const o = (y * W + x) * 4
  return 0.2126 * img[o]! + 0.7152 * img[o + 1]! + 0.0722 * img[o + 2]!
}
const boxMean = (img: Float32Array, cx: number, cy: number, r: number) => {
  let s = 0, n = 0
  for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) if (x >= 0 && y >= 0 && x < W && y < H) (s += lum(img, x, y)), n++
  return s / n
}

renderer.setTemporal({ mode: "taa", renderScale: 1, sharpen: 0, history: 0.9 })
const render = async (fogOn: boolean, plain = false) => {
  renderer.drawTo(scene.input(fogOn, plain), target.createView())
  await device.queue.onSubmittedWorkDone()
}
for (let i = 0; i < 40; i++) await render(false)
const today = await readOutput()
renderer.resetTemporalHistory()
for (let i = 0; i < 40; i++) await render(true)
const lit = await readOutput()
await render(true)
const next = await readOutput()

// Without the fog's own history (response 1) for comparison.
fog.settings.history = 1
renderer.resetTemporalHistory()
for (let i = 0; i < 40; i++) await render(true)
const rawA = await readOutput()
await render(true)
const rawB = await readOutput()
fog.settings.history = 0.1

// Two slots at once, then MSAA with the half-res toggle off: no validation errors.
for (let i = 0; i < 3; i++) await render(true, true)
renderer.setTemporal(null)
fog.settings.halfRes = false
for (let i = 0; i < 3; i++) await render(true, true)

const head = project([4.5, 7.5, 22])
const under = project([4.5, 5.2, 22])
const above = project([4.5, 9.8, 22])
const add = (x: number, y: number, r = 2) => boxMean(lit, x, y, r) - boxMean(today, x, y, r)
// Alpha away from silhouettes (where the TAA's jitter phase alone moves it).
let alphaDiff = 0
let alphaSeen = 0
for (let y = 1; y < H - 1; y++)
  for (let x = 1; x < W - 1; x++) {
    let flat = true
    for (let k = -1; k <= 1 && flat; k++) for (let j = -1; j <= 1; j++) if (today[((y + k) * W + x + j) * 4 + 3] !== today[(y * W + x) * 4 + 3]) flat = false
    if (!flat) continue
    alphaDiff = Math.max(alphaDiff, Math.abs(today[(y * W + x) * 4 + 3]! - lit[(y * W + x) * 4 + 3]!))
    alphaSeen = Math.max(alphaSeen, lit[(y * W + x) * 4 + 3]!)
  }
const flicker = (a: Float32Array, b: Float32Array) => {
  let s = 0, n = 0
  for (let y = 10; y < H - 10; y++) for (let x = 10; x < W - 10; x++) (s += Math.abs(lum(a, x, y) - lum(b, x, y))), n++
  return s / n
}
const results = {
  head: add(head[0]!, head[1]!),
  underHead: add(under[0]!, under[1]!),
  aboveHead: add(above[0]!, above[1]!),
  alphaDiff,
  alphaSeen,
  flickerWithHistory: flicker(lit, next),
  flickerWithout: flicker(rawA, rawB),
}
console.log(JSON.stringify(results, null, 1))
// FOG_PROOF_IMAGE=dir writes today.ppm, fog.ppm and raw.ppm (exposure −2.2 EV, Reinhard, sRGB) for a look.
const deno = (globalThis as { Deno?: { env: { get(k: string): string | undefined }; writeFileSync(p: string, d: Uint8Array): void } }).Deno
const imageDir = deno?.env.get("FOG_PROOF_IMAGE")
if (deno && imageDir) {
  for (const [name, img] of [["today", today], ["fog", lit], ["raw", rawB]] as const) {
    const bytes = new Uint8Array(W * H * 3)
    for (let i = 0; i < W * H; i++)
      for (let c = 0; c < 3; c++) {
        const v = img[i * 4 + c]! * 2 ** -2.2 * 4
        const t = v / (1 + v)
        bytes[i * 3 + c] = Math.round(255 * Math.min(1, t <= 0.0031308 ? t * 12.92 : 1.055 * t ** (1 / 2.4) - 0.055))
      }
    deno.writeFileSync(`${imageDir}/${name}.ppm`, new Uint8Array([...new TextEncoder().encode(`P6\n${W} ${H}\n255\n`), ...bytes]))
  }
}
const failures = [
  ...(results.head > 0.01 ? [] : ["no fog light round the lamp head"]),
  ...(results.underHead > results.aboveHead * 2 ? [] : ["the cone under the head isn't brighter than the halo above it"]),
  ...(results.aboveHead > 0 ? [] : ["no halo above the head (side leak)"]),
  ...(alphaDiff < 1e-3 && Math.abs(alphaSeen - FOG_SCENE_ALPHA) < 1e-3 ? [] : [`the fog changed HDR alpha by ${alphaDiff}`]),
  ...(results.flickerWithHistory < results.flickerWithout * 0.6 ? [] : ["the fog history doesn't steady the jitter"]),
  ...errors.map((e) => `WebGPU: ${e}`),
]
if (failures.length) throw new Error(`fog GPU proof failed:\n${[...new Set(failures)].join("\n")}`)
console.log("PASS")
