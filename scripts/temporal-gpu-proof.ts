/**
 * Off-browser GPU proof for `@arcade/kit/gpu/temporal` (TAA / TAAU): builds the real pipelines on the machine's WebGPU
 * (Deno's wgpu on Metal), renders an analytic aliasing-prone ground plane with thin stripes and a raised box through a
 * perspective camera with the renderer's Halton jitter, resolves it, and compares the output with a 144-sample
 * supersampled ground truth through the same reconstruction filter: still camera (convergence), panning camera (reprojection), a box that moves 5 px a
 * frame (ghosting) and a box that pops in (disocclusion).
 *
 *   deno run -A --sloppy-imports scripts/temporal-gpu-proof.ts
 */
import { mat4 } from "wgpu-matrix"
import { TemporalResolve, jitterViewProj, type TemporalSettings } from "../packages/kit/gpu/temporal"

const IN_W = 200, IN_H = 124
const OUT_W = 300, OUT_H = 186
const SAMPLES = 4

const adapter = await navigator.gpu.requestAdapter()
if (!adapter) throw new Error("no WebGPU adapter")
const device = await adapter.requestDevice()
const errors: string[] = []
device.addEventListener("uncapturederror", (e) => errors.push((e as GPUUncapturedErrorEvent).error.message))

const sceneCode = /* wgsl */ `
struct S { invVP: mat4x4f, vp: mat4x4f, size: vec4f, box: vec4f, boxOn: vec4f, light: vec4f }
@group(0) @binding(0) var<uniform> U: S;
struct VO { @builtin(position) pos: vec4f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VO;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  return o;
}
struct FO { @location(0) color: vec4f, @builtin(frag_depth) depth: f32 }
fn ground(p: vec2f) -> f32 {
  let s = select(0.08, 1.0, fract(p.x * 3.1 + p.y * 1.3) < 0.14);
  let c = select(0.0, 0.25, (i32(floor(p.x)) + i32(floor(p.y))) % 2 == 0);
  return s + c;
}
@fragment fn fs(o: VO) -> FO {
  let ndc = vec2f(o.pos.x / U.size.x * 2.0 - 1.0, 1.0 - o.pos.y / U.size.y * 2.0);
  let a = U.invVP * vec4f(ndc, 0.0, 1.0);
  let b = U.invVP * vec4f(ndc, 1.0, 1.0);
  let ro = a.xyz / a.w;
  let rd = b.xyz / b.w - ro;
  var hit = ro + rd * (-ro.y / rd.y);
  var col = vec3f(ground(hit.xz));
  var alpha = -0.6;
  if (U.light.w > 0.5) {
    col *= select(0.15, 2.0, distance(hit.xz, U.light.xy) < U.light.z);
  }
  if (U.boxOn.x > 0.5) {
    let top = ro + rd * ((1.0 - ro.y) / rd.y);
    if (top.x > U.box.x && top.x < U.box.z && top.z > U.box.y && top.z < U.box.w) {
      hit = top;
      col = vec3f(2.5, 0.3, 0.2);
      alpha = 3.0;
    }
  }
  let clip = U.vp * vec4f(hit, 1.0);
  var out: FO;
  out.color = vec4f(col, alpha); // a packed mask outside 0..1, like Outbreak's shroud
  out.depth = clip.z / clip.w;
  return out;
}
`

// Same scene on the CPU for the ground truth.
const groundCpu = (x: number, z: number) => {
  const f = x * 3.1 + z * 1.3
  const s = f - Math.floor(f) < 0.14 ? 1 : 0.08
  const c = (((Math.floor(x) + Math.floor(z)) % 2) + 2) % 2 === 0 ? 0.25 : 0
  return s + c
}
const xf = (m: Float32Array, v: number[]) => [0, 1, 2, 3].map((r) => m[r]! * v[0]! + m[4 + r]! * v[1]! + m[8 + r]! * v[2]! + m[12 + r]! * v[3]!)
function shadeCpu(inv: Float32Array, nx: number, ny: number, box: number[] | null, light: number[] | null = null): number {
  const a = xf(inv, [nx, ny, 0, 1]), b = xf(inv, [nx, ny, 1, 1])
  const ro = [a[0]! / a[3]!, a[1]! / a[3]!, a[2]! / a[3]!]
  const rd = [b[0]! / b[3]! - ro[0]!, b[1]! / b[3]! - ro[1]!, b[2]! / b[3]! - ro[2]!]
  if (box) {
    const t = (1 - ro[1]!) / rd[1]!
    const x = ro[0]! + rd[0]! * t, z = ro[2]! + rd[2]! * t
    if (x > box[0]! && x < box[2]! && z > box[1]! && z < box[3]!) return 2.5 * 0.2126 + 0.3 * 0.7152 + 0.2 * 0.0722
  }
  const t = -ro[1]! / rd[1]!
  const x = ro[0]! + rd[0]! * t, z = ro[2]! + rd[2]! * t
  const g = groundCpu(x, z)
  return light ? g * (Math.hypot(x - light[0]!, z - light[1]!) < light[2]! ? 2 : 0.15) : g
}
function truth(vp: Float32Array, box: number[] | null, light: number[] | null = null): Float32Array {
  const inv = mat4.inverse(vp) as Float32Array
  // The resolve's own reconstruction filter (Gaussian fit of Blackman-Harris, exp(-2.29 d²) in output pixels),
  // integrated over 12×12 samples in a 3×3-pixel window: what an ideal, fully converged resolve shows.
  const out = new Float32Array(OUT_W * OUT_H)
  const n = 12
  for (let y = 0; y < OUT_H; y++) for (let x = 0; x < OUT_W; x++) {
    let s = 0, ws = 0
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const dx = ((i + 0.5) / n) * 3 - 1.5, dy = ((j + 0.5) / n) * 3 - 1.5
      const w = Math.exp(-2.29 * (dx * dx + dy * dy))
      const px = x + 0.5 + dx, py = y + 0.5 + dy
      s += w * shadeCpu(inv, (px / OUT_W) * 2 - 1, 1 - (py / OUT_H) * 2, box, light)
      ws += w
    }
    out[y * OUT_W + x] = s / ws
  }
  return out
}

function camera(panX: number): Float32Array {
  const proj = mat4.perspective((40 * Math.PI) / 180, OUT_W / OUT_H, 1, 200)
  const view = mat4.lookAt([panX, 22, 18], [panX, 0, 0], [0, 1, 0])
  return mat4.multiply(proj, view) as Float32Array
}

const hdr = device.createTexture({ size: [IN_W, IN_H], format: "rgba16float", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING })
const msaa = device.createTexture({ size: [IN_W, IN_H], format: "rgba16float", sampleCount: SAMPLES, usage: GPUTextureUsage.RENDER_ATTACHMENT })
const depth = device.createTexture({ size: [IN_W, IN_H], format: "depth24plus", sampleCount: SAMPLES, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING })
const sceneBuf = device.createBuffer({ size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
const sceneMod = device.createShaderModule({ code: sceneCode })
const scenePipe = device.createRenderPipeline({
  layout: "auto",
  vertex: { module: sceneMod, entryPoint: "vs" },
  fragment: { module: sceneMod, entryPoint: "fs", targets: [{ format: "rgba16float" }] },
  depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "always" },
  multisample: { count: SAMPLES },
})
const sceneGroup = device.createBindGroup({ layout: scenePipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: sceneBuf } }] })

device.pushErrorScope("validation")
const taa = new TemporalResolve(device, "rgba16float", SAMPLES)
const createErr = await device.popErrorScope()
if (createErr) throw new Error(`pipeline creation: ${createErr.message}`)

let lastAlpha = new Float32Array(0)
async function readOutput(): Promise<Float32Array> {
  const bpr = Math.ceil((OUT_W * 8) / 256) * 256
  const buf = device.createBuffer({ size: bpr * OUT_H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
  const enc = device.createCommandEncoder()
  enc.copyTextureToBuffer({ texture: taa.output }, { buffer: buf, bytesPerRow: bpr }, [OUT_W, OUT_H])
  device.queue.submit([enc.finish()])
  await buf.mapAsync(GPUMapMode.READ)
  const u16 = new Uint16Array(buf.getMappedRange())
  const half = (h: number) => {
    const e = (h >> 10) & 31, m = h & 1023, s = h & 32768 ? -1 : 1
    return e === 0 ? s * 2 ** -14 * (m / 1024) : e === 31 ? NaN : s * 2 ** (e - 15) * (1 + m / 1024)
  }
  const out = new Float32Array(OUT_W * OUT_H)
  lastAlpha = new Float32Array(OUT_W * OUT_H)
  for (let y = 0; y < OUT_H; y++) for (let x = 0; x < OUT_W; x++) {
    const o = (y * bpr) / 2 + x * 4
    out[y * OUT_W + x] = 0.2126 * half(u16[o]!) + 0.7152 * half(u16[o + 1]!) + 0.0722 * half(u16[o + 2]!)
    lastAlpha[y * OUT_W + x] = half(u16[o + 3]!)
  }
  buf.unmap()
  buf.destroy()
  return out
}

const settings: TemporalSettings = { mode: "taau", renderScale: IN_W / OUT_W, sharpen: 0, history: 0.9 }
const frame = new Float32Array(22)
const sceneData = new Float32Array(64)
async function step(vp: Float32Array, box: number[] | null, sharpen = 0, light: number[] | null = null): Promise<void> {
  frame.set(vp, 0)
  frame[16] = 0
  frame[17] = 22
  frame[18] = 18
  const [jx, jy] = taa.begin(frame, { ...settings, sharpen }, false)
  const jvp = vp.slice()
  jitterViewProj(jvp, jx, jy, IN_W, IN_H)
  sceneData.set(mat4.inverse(jvp) as Float32Array, 0)
  sceneData.set(jvp, 16)
  sceneData.set([IN_W, IN_H, 0, 0], 32)
  sceneData.set(box ?? [0, 0, 0, 0], 36)
  sceneData[40] = box ? 1 : 0
  sceneData.set(light ? [light[0]!, light[1]!, light[2]!, 1] : [0, 0, 0, 0], 44)
  device.queue.writeBuffer(sceneBuf, 0, sceneData)
  const enc = device.createCommandEncoder()
  const p = enc.beginRenderPass({
    colorAttachments: [{ view: msaa.createView(), resolveTarget: hdr.createView(), loadOp: "clear", storeOp: "discard", clearValue: [0, 0, 0, 1] }],
    depthStencilAttachment: { view: depth.createView(), depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" },
  })
  p.setPipeline(scenePipe)
  p.setBindGroup(0, sceneGroup)
  p.draw(3)
  p.end()
  taa.encode(enc, hdr.createView(), depth.createView(), sharpen > 0)
  device.queue.submit([enc.finish()])
  await device.queue.onSubmittedWorkDone()
}

const rmse = (a: Float32Array, b: Float32Array, mask?: (x: number, y: number) => boolean) => {
  let s = 0, n = 0, nan = 0
  for (let y = 2; y < OUT_H - 2; y++) for (let x = 2; x < OUT_W - 2; x++) {
    if (mask && !mask(x, y)) continue
    const d = a[y * OUT_W + x]! - b[y * OUT_W + x]!
    if (!Number.isFinite(d)) { nan++; continue }
    s += d * d
    n++
  }
  if (nan) throw new Error(`${nan} non-finite output pixels`)
  return Math.sqrt(s / Math.max(1, n))
}

taa.resize(OUT_W, OUT_H, IN_W, IN_H)
const results: Record<string, number | string | boolean> = {}

// 1. Still camera: the first frame is one jittered sample per input pixel; 48 frames later it should approach truth.
const still = camera(0)
const gtStill = truth(still, null)
await step(still, null)
results.stillFrame1 = +rmse(await readOutput(), gtStill).toFixed(4)
for (let i = 0; i < 46; i++) await step(still, null)
const prevStill = await readOutput()
await step(still, null)
const lastStill = await readOutput()
results.stillConverged = +rmse(lastStill, gtStill).toFixed(4)
// Frame-to-frame shimmer of a still view: resolved, versus each jittered frame on its own (no history).
results.shimmerResolved = +rmse(lastStill, prevStill).toFixed(4)
taa.reset()
await step(still, null)
const rawA = await readOutput()
taa.reset()
await step(still, null)
results.shimmerRaw = +rmse(await readOutput(), rawA).toFixed(4)
for (let i = 0; i < 48; i++) await step(still, null)
await step(still, null, 0.35)
results.stillSharpened = +rmse(await readOutput(), gtStill).toFixed(4)

// 2. Panning camera (0.03 world units a frame, about a third of an output pixel): the reprojected history must keep up.
taa.reset()
let pan = 0
for (let i = 0; i < 48; i++) await step(camera((pan += 0.03)), null)
results.panConverged = +rmse(await readOutput(), truth(camera(pan), null)).toFixed(4)

// 3. A box sliding 0.35 world units (about 5 output pixels) a frame over the still ground: the trail must not ghost.
taa.reset()
for (let i = 0; i < 24; i++) await step(still, null)
let boxX = -6
for (let i = 0; i < 20; i++) await step(still, [(boxX += 0.35), -1, boxX + 1.2, 0.2])
const box = [boxX, -1, boxX + 1.2, 0.2]
const outBox = await readOutput()
const gtBox = truth(still, box)
const proj = (x: number, z: number) => {
  const c = xf(still, [x, 1, z, 1])
  return [((c[0]! / c[3]!) * 0.5 + 0.5) * OUT_W, (0.5 - (c[1]! / c[3]!) * 0.5) * OUT_H]
}
const [bx0] = proj(box[0]!, 0.2), [bx1] = proj(box[2]!, 0.2)
const [, by0] = proj(box[0]!, -1), [, by1] = proj(box[0]!, 0.2)
const trailW = bx1! - bx0!
results.boxTrailRmse = +rmse(outBox, gtBox, (x, y) => x > bx0! - trailW && x < bx0! - 1 && y > by0! && y < by1!).toFixed(4)
results.boxRestRmse = +rmse(outBox, gtBox, (x, y) => !(x > bx0! - trailW - 4 && x < bx1! + 4 && y > by0! - 6 && y < by1! + 6)).toFixed(4)

// 4. A box that pops in: on its first frame its pixels must show the box, not the ground's history.
taa.reset()
for (let i = 0; i < 24; i++) await step(still, null)
const popBox = [-1, -1, 1, 1]
await step(still, popBox)
const outPop = await readOutput()
const gtPop = truth(still, popBox)
const [px0, py0] = proj(-1, -1), [px1, py1] = proj(1, 1)
const inside = (x: number, y: number) => x > Math.min(px0!, px1!) + 2 && x < Math.max(px0!, px1!) - 2 && y > Math.min(py0!, py1!) + 2 && y < Math.max(py0!, py1!) - 2
let aIn = 0, nIn = 0, aOut = 0, nOut = 0
for (let y = 4; y < OUT_H - 4; y++) for (let x = 4; x < OUT_W - 4; x++) {
  const a = lastAlpha[y * OUT_W + x]!
  if (inside(x, y)) { aIn += a; nIn++ } else if (y > Math.max(py0!, py1!) + 6) { aOut += a; nOut++ }
}
// Packed alpha must survive the resolve (box 3.0, ground -0.6).
results.alphaInsideBox = +(aIn / nIn).toFixed(3)
results.alphaGround = +(aOut / nOut).toFixed(3)
results.popInsideRmse = +rmse(outPop, gtPop, (x, y) => x > Math.min(px0!, px1!) + 2 && x < Math.max(px0!, px1!) - 2 && y > Math.min(py0!, py1!) + 2 && y < Math.max(py0!, py1!) - 2).toFixed(4)

// 5. A torch pool sweeping over still ground (lighting changes, depth doesn't): only the clip can stop a smear.
taa.reset()
for (let i = 0; i < 24; i++) await step(still, null, 0, [-8, 0, 2])
let lx = -8
for (let i = 0; i < 20; i++) await step(still, null, 0, [(lx += 0.4), 0, 2])
const outLight = await readOutput()
const gtLight = truth(still, null, [lx, 0, 2])
const [lc] = proj(lx, 0)
const [lr] = proj(lx + 2, 0)
const rad = lr! - lc!
const [, lcy] = proj(lx, 0)
const trail = (x: number, y: number) => x < lc! - rad - 1 && x > lc! - 3 * rad && Math.abs(y - lcy!) < rad * 0.6
taa.reset()
await step(still, null, 0, [lx, 0, 2])
results.torchFrame1TrailRmse = +rmse(await readOutput(), gtLight, trail).toFixed(4)
for (let i = 0; i < 47; i++) await step(still, null, 0, [lx, 0, 2])
results.torchStillTrailRmse = +rmse(await readOutput(), gtLight, trail).toFixed(4)
results.torchTrailRmse = +rmse(outLight, gtLight, trail).toFixed(4)

results.errors = errors.join(" | ") || "none"
console.log(JSON.stringify(results, null, 2))
const ok =
  errors.length === 0 &&
  (results.stillConverged as number) < (results.stillFrame1 as number) * 0.8 &&
  (results.shimmerResolved as number) < (results.shimmerRaw as number) * 0.35 &&
  (results.panConverged as number) < (results.stillFrame1 as number) &&
  (results.boxTrailRmse as number) < 0.25 &&
  (results.popInsideRmse as number) < 0.25 &&
  Math.abs((results.alphaInsideBox as number) - 3) < 0.05 &&
  Math.abs((results.alphaGround as number) + 0.6) < 0.02 &&
  (results.torchTrailRmse as number) < (results.torchFrame1TrailRmse as number) * 1.1
console.log(ok ? "PASS" : "FAIL")
if (!ok) throw new Error("temporal GPU proof failed")
