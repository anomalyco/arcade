/**
 * Off-browser GPU proof for the kit's physical lights (`@arcade/kit/gpu/lights/physical`): the shared Renderer on the
 * machine's WebGPU (Deno's wgpu on Metal) draws the Lab's base debug world (`packages/kit/lab/world/scene.ts`) at a
 * clock hour under Today and under Physical, from the Lab camera, and checks for WebGPU validation errors and that both
 * images are lit (no black or blown frame). Then Physical again with two spot shadow maps (`gpu/shadows/spot-shadows.ts`),
 * which may only darken. LIGHT_PROOF_FLASHLIGHT=1 adds the survivor's flashlight (a torch beam under Physical).
 * LIGHT_PROOF_IMAGE=<dir> writes today.ppm, physical.ppm and shadowed.ppm.
 *
 *   LIGHT_PROOF_IMAGE=/tmp/x deno run -A --sloppy-imports scripts/light-gpu-proof.ts [hour] [street floor] [yaw pitch dist fx fy fz]
 */
import { cloneFoliageParams, applyFoliagePreset } from "../packages/kit/gpu/foliage"
import { physicalLightHooks, packPhysicalLightKnobs, PHYSICAL_LIGHT_DEFAULTS } from "../packages/kit/gpu/lights/physical"
import { VERT_BYTES } from "../packages/kit/gpu/mesh"
import { Renderer } from "../packages/kit/gpu/renderer"
import { SpotShadows, type SpotCandidate } from "../packages/kit/gpu/shadows/spot-shadows"
import { SceneLights, newSceneFrame, packSceneFrame } from "../packages/kit/gpu/scene-frame"
import { makeSceneShader, spriteShader } from "../packages/kit/gpu/shaders"
import { LAMP, LAMP_COUNT, WORLD_CAMERA, WORLD_FOCUS, buildWorld, worldClock, worldLights } from "../packages/kit/lab/world/scene"
import { WORLD_DEFAULTS } from "../packages/kit/lab/world/world"

const deno = (globalThis as { Deno?: { args: string[]; env: { get(k: string): string | undefined }; writeFileSync(p: string, d: Uint8Array): void } }).Deno
const W = 960
const H = 600
const hour = Number(deno?.args[0] ?? 0)
const street = Number(deno?.args[1] ?? WORLD_DEFAULTS.street)
const flashlight = deno?.env.get("LIGHT_PROOF_FLASHLIGHT") === "1"

const adapter = await navigator.gpu.requestAdapter()
if (!adapter) throw new Error("no WebGPU adapter")
const device = await adapter.requestDevice()
const errors: string[] = []
device.addEventListener("uncapturederror", (e) => errors.push((e as GPUUncapturedErrorEvent).error.message))
const format: GPUTextureFormat = "bgra8unorm"
const target = device.createTexture({ size: [W, H], format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC })
const ctx = { getCurrentTexture: () => target } as unknown as GPUCanvasContext

const physical = physicalLightHooks({ knobs: "PK.k", spotShadows: true })
const renderers = {
  today: new Renderer(device, ctx, format),
  physical: new Renderer(device, ctx, format, {
    scene: makeSceneShader({ ...physical, declarations: `struct PhysicalKnobs { k: vec4f }\n@group(0) @binding(13) var<uniform> PK: PhysicalKnobs;\n${physical.declarations}`, lampGrid: false }, false),
    sprite: spriteShader(),
  }),
}
const vegetation = cloneFoliageParams()
applyFoliagePreset("tree", "oak", vegetation)
applyFoliagePreset("bush", "hedge", vegetation)
applyFoliagePreset("grass", "lawn", vegetation)
const geometry = buildWorld({ ...WORLD_DEFAULTS, street, vegetation })

// The Lab's orbit camera (lab/stage.ts writeOrbitCamera) at its default framing of the set.
const vp = new Float32Array(16)
const eye = [0, 0, 0]
{
  const a = (deno?.args ?? []).slice(2).map(Number)
  const [yaw, pitch, dist] = a.length >= 3 ? a : [WORLD_CAMERA.yaw, WORLD_CAMERA.pitch, WORLD_CAMERA.dist]
  const f0 = a.length >= 6 ? a.slice(3, 6) as [number, number, number] : WORLD_FOCUS
  const cp = Math.cos(pitch), sp = Math.sin(pitch), cy = Math.cos(yaw), sy = Math.sin(yaw)
  const ex = f0[0] + sy * cp * dist, ey = f0[1] + sp * dist, ez = f0[2] + cy * cp * dist
  eye[0] = ex; eye[1] = ey; eye[2] = ez
  let zx = ex - f0[0], zy = ey - f0[1], zz = ez - f0[2]
  const zl = Math.hypot(zx, zy, zz); zx /= zl; zy /= zl; zz /= zl
  let xx = zz, xz = -zx
  const xl = Math.hypot(xx, xz); xx /= xl; xz /= xl
  const yx = zy * xz, yy = zz * xx - zx * xz, yz = -zy * xx
  const f = 1 / Math.tan(0.325), near = 0.1, far = 150, nf = 1 / (near - far)
  const p0 = f / (W / H), p5 = f, p10 = far * nf, p14 = far * near * nf
  const tx = -(xx * ex + xz * ez), ty = -(yx * ex + yy * ey + yz * ez), tz = -(zx * ex + zy * ey + zz * ez)
  vp.set([p0 * xx, p5 * yx, p10 * zx, -zx, 0, p5 * yy, p10 * zy, -zy, p0 * xz, p5 * yz, p10 * zz, -zz, p0 * tx, p5 * ty, p10 * tz + p14, -tz])
}

const frame = newSceneFrame()
const lampPower = new Float32Array(8)
const knobs = new Float32Array(4)
const empty = new Float32Array(0)
let spots: SpotShadows | null = null
async function draw(model: "today" | "physical", shadowed = false) {
  const r = renderers[model]
  r.setLevel(geometry.level)
  r.resize(W, H)
  const lights = new SceneLights()
  lights.setBoxes(geometry.boxes)
  const clock = worldClock(hour)
  lights.update(worldLights(clock, { lampPower: 1, headlights: false, flashlight, porch: true, physical: model === "physical" }), geometry.casters)
  if (shadowed && !spots) {
    spots = new SpotShadows(device, { count: 2 })
    const data = geometry.level.chunks[0]!.data
    const buffer = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    device.queue.writeBuffer(buffer, 0, data)
    const candidates: SpotCandidate[] = []
    for (const l of worldLights(clock, { lampPower: 1, headlights: false, flashlight, porch: true, physical: true })) {
      if (l.spot && l.id !== undefined) candidates.push({ id: l.id, pos: [l.x, l.h, l.y], axis: l.spot.axis, cosOuter: l.spot.cosOuter, range: l.r, intensity: l.r * l.r })
    }
    const enc = device.createCommandEncoder()
    spots.update(enc, candidates, eye as [number, number, number], 1, (id) => lights.indexOf(id), [{ buffer, count: data.byteLength / VERT_BYTES, stride: VERT_BYTES }])
    device.queue.submit([enc.finish()])
    console.error(`spot shadow layers rendered: ${spots.rendered}`)
    r.setSpotShadows(spots.bindings())
  }
  packSceneFrame(frame, { viewProj: vp, eye, time: 1, width: W, height: H, lightCount: lights.lightCount, ambient: clock.ambient, mapSize: [40, 40], ao: 0.45 })
  lampPower[LAMP.porch] = lampPower[LAMP.street] = lampPower[LAMP.interior] = clock.lamps
  if (model === "physical") r.setCustomUniforms(packPhysicalLightKnobs({ ...PHYSICAL_LIGHT_DEFAULTS, model }, knobs))
  for (let i = 0; i < 3; i++) {
    r.drawTo({
      frame, lights: lights.lights, lightCount: lights.lightCount, shadowLightCount: lights.shadowLightCount,
      occluders: lights.occ, occluderCount: lights.occCount, lampPower, lampCount: LAMP_COUNT, view: [-40, -40, 40, 40],
      batches: [], alphaSprites: empty, alphaCount: 0, addSprites: empty, addCount: 0, grade: [1, 0, 0, clock.exposure], look: null,
    } as never, target.createView())
    await device.queue.onSubmittedWorkDone()
  }
  const bpr = Math.ceil((W * 4) / 256) * 256
  const buf = device.createBuffer({ size: bpr * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
  const enc = device.createCommandEncoder()
  enc.copyTextureToBuffer({ texture: target }, { buffer: buf, bytesPerRow: bpr }, [W, H])
  device.queue.submit([enc.finish()])
  await buf.mapAsync(GPUMapMode.READ)
  const raw = new Uint8Array(buf.getMappedRange())
  const rgb = new Uint8Array(W * H * 3)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = y * bpr + x * 4
    rgb.set([raw[o + 2]!, raw[o + 1]!, raw[o]!], (y * W + x) * 3)
  }
  buf.unmap()
  return rgb
}

const today = await draw("today")
const phys = await draw("physical")
const shad = await draw("physical", true)
let darker = 0, brighter = 0
for (let i = 0; i < phys.length; i++) {
  if (shad[i]! < phys[i]! - 2) darker++
  else if (shad[i]! > phys[i]! + 2) brighter++
}
const mean = (img: Uint8Array) => img.reduce((s, v) => s + v, 0) / img.length
const clipped = (img: Uint8Array) => img.filter((v) => v >= 254).length / img.length
const results = { hour, street, today: { mean: mean(today), clipped: clipped(today) }, physical: { mean: mean(phys), clipped: clipped(phys) }, shadowed: { mean: mean(shad), darker: darker / phys.length, brighter: brighter / phys.length }, errors }
console.log(JSON.stringify(results, null, 1))
const dir = deno?.env.get("LIGHT_PROOF_IMAGE")
if (deno && dir) {
  for (const [name, img] of [["today", today], ["physical", phys], ["shadowed", shad]] as const) {
    deno.writeFileSync(`${dir}/${name}.ppm`, new Uint8Array([...new TextEncoder().encode(`P6\n${W} ${H}\n255\n`), ...img]))
  }
}
const failures = [
  ...(errors.length ? [`WebGPU errors: ${errors.join("; ")}`] : []),
  ...(results.physical.mean > 2 ? [] : ["physical frame is black"]),
  ...(results.physical.clipped < 0.2 ? [] : ["physical frame is blown out"]),
  ...(hour < 6 || hour > 20 ? (darker > 0 ? [] : ["spot shadows changed nothing"]) : []),
  ...(brighter / phys.length < 0.001 ? [] : ["spot shadows brightened pixels"]),
]
if (failures.length) {
  console.error(failures.join("\n"))
  if (deno) (globalThis as unknown as { Deno: { exit(c: number): void } }).Deno.exit(1)
}
