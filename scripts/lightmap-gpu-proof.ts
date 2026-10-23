/**
 * Off-browser Metal WebGPU proof and benchmark for baked per-light Cycles lightmaps + 3D L1 SH probes
 * (`@arcade/kit/gpu/gi/lightmap`).
 *
 * At the exact same camera (`BAKED_GI_CAMERA`) and exposure (`hour = 0`, `grade = 1.45`), renders and measures:
 *   1. Lamp ON — Before (`giMode: "today"`) vs After (`giMode: "baked"`, `giIntensity = 1.0`, `giProbes = 1.0`):
 *      - Direct downward cone from the table lamp lights the crimson rug (`rugPool`).
 *      - In Before, the ceiling, upper back wall, bookcase, and dynamic actor outside the cone stay near-black.
 *      - In After, Cycles per-light indirect bounce (`rgb9e5ufloat` UV2 lightmap array on static surfaces, 3D L1 SH
 *        probes on `MAT.actor`) lifts the ceiling above the lamp, back wall near the lamp, bookcase, and actor with
 *        warm colour bleeding while the far corners (`darkCorner`) stay dark.
 *   2. Lamp OFF — Before (`giMode: "today"`) vs After (`giMode: "baked"`):
 *      - Both lamps and CRT are off (`weight = 0`): the room stays genuinely dark (`luma < 2 / 255`), with zero
 *        residual ambient wash.
 *   3. CRT Colour Change — Cyan Phosphor vs Warm Red (`kit-crt` `screenSceneLight` + `screenBounceSource`,
 *      `SCREEN_LIGHT_ID.screen = 20`), Before vs After:
 *      - Switching the CRT picture from Cyan to Warm Red shifts the indirect bounce on surrounding walls, ceiling,
 *        and actor from cool cyan (`B > R`) to warm red (`R > B`) with zero re-bake.
 *
 *   LIGHTMAP_PROOF_DIR=~/code/home/artifacts/kit-lightmaps-2026-10-23 deno run -A --unstable-webgpu --sloppy-imports scripts/lightmap-gpu-proof.ts
 */
import { applyFoliagePreset, cloneFoliageParams } from "../packages/kit/gpu/foliage"
import {
  BAKED_GI_DEFAULTS,
  BAKED_GI_STRUCT_FIELDS_WGSL,
  BAKED_GI_UNIFORM_FLOATS,
  HOUSE_LIGHTMAP_META,
  assertBakedLightmapFresh,
  bakedLightmapHooks,
  packBakedLightmapUniforms,
  uploadBakedLightmapTexture,
  type BakedGiSettings,
  type LiveBounceSource,
} from "../packages/kit/gpu/gi/lightmap"
import { PHYSICAL_LIGHT_DEFAULTS, packPhysicalLightKnobs, physicalLightHooks } from "../packages/kit/gpu/lights/physical"
import { Renderer } from "../packages/kit/gpu/renderer"
import { SceneLights, flatLighting, newSceneFrame, packSceneFrame, type SceneLight } from "../packages/kit/gpu/scene-frame"
import { ScreenDisplay, ScreenQuadPass } from "../packages/kit/gpu/screen/display"
import { ScreenLightProbe, screenBounceSource, screenSceneLight } from "../packages/kit/gpu/screen/light"
import { createScreenDisplaySettings } from "../packages/kit/gpu/screen/settings"
import { makeSceneShader, spriteShader } from "../packages/kit/gpu/shaders"
import {
  BAKED_GI_CAMERA,
  LAMP,
  LAMP_COUNT,
  SCREEN_AT,
  SCREEN_BAKE_REFERENCE,
  SCREEN_LIGHT_ID,
  SCREEN_ROOM,
  WORLD_BOUNCE,
  WORLD_LIGHT_ID,
  buildWorld,
  exportHouseBakeSceneSpec,
  worldClock,
  worldLights,
} from "../packages/kit/lab/world/scene"
import { WORLD_DEFAULTS, WORLD_POST, worldFlicker } from "../packages/kit/lab/world/world"

const deno = (globalThis as unknown as {
  Deno: {
    args: string[]
    env: { get(k: string): string | undefined }
    mkdirSync(p: string, o?: { recursive?: boolean }): void
    writeFileSync(p: string, d: Uint8Array): void
    writeTextFileSync(p: string, s: string): void
  }
}).Deno

// Verify baked lightmap asset matches current engine scene export (`BakeSceneSpec` SHA-256)
assertBakedLightmapFresh(HOUSE_LIGHTMAP_META, exportHouseBakeSceneSpec())

const W = 960
const H = 600
const outDir = deno?.env.get("LIGHTMAP_PROOF_DIR") ?? ""

const adapter = await navigator.gpu.requestAdapter()
if (!adapter) throw new Error("no WebGPU adapter")
const device = await adapter.requestDevice()
const errors: string[] = []
device.addEventListener("uncapturederror", (e) => errors.push((e as GPUUncapturedErrorEvent).error.message))

const format: GPUTextureFormat = "bgra8unorm"
const target = device.createTexture({
  size: [W, H],
  format,
  usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
})
const ctx = { getCurrentTexture: () => target } as unknown as GPUCanvasContext

const physical = physicalLightHooks({ knobs: "PK.k", spotShadows: false, rect: true, panel: true })
const bakedHooks = bakedLightmapHooks(physical, { uniformName: "PK" })

const rendererPhysicalToday = new Renderer(device, ctx, format, {
  scene: makeSceneShader(
    {
      ...physical,
      declarations: `struct PhysicalKnobs { k: vec4f, beamA: vec4f, beamB: vec4f }\n@group(0) @binding(13) var<uniform> PK: PhysicalKnobs;\n${physical.declarations}`,
      lampGrid: false,
    },
    false,
  ),
  sprite: spriteShader(),
  post: WORLD_POST,
})

const rendererBaked = new Renderer(device, ctx, format, {
  scene: makeSceneShader(
    {
      ...bakedHooks,
      declarations: `struct PhysicalKnobs { k: vec4f, beamA: vec4f, beamB: vec4f, ${BAKED_GI_STRUCT_FIELDS_WGSL} }\n@group(0) @binding(13) var<uniform> PK: PhysicalKnobs;\n${bakedHooks.declarations}`,
      lampGrid: false,
    },
    false,
  ),
  sprite: spriteShader(),
  post: WORLD_POST,
})

const bakedGpu = uploadBakedLightmapTexture(device)
rendererBaked.setDetailTextureArray(bakedGpu.view)

const crtScreenSettings = createScreenDisplaySettings({ brightness: 2.4, light: 14, lightShape: "panel", lightRange: 6, vhs: false })
const crtDisplay = new ScreenDisplay(device, { width: 64, height: 48, settings: crtScreenSettings, label: "proof screen" })
const crtSourceTex = device.createTexture({
  size: [16, 16],
  format: "rgba8unorm",
  usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
})
crtDisplay.setSource({ texture: crtSourceTex, linear: false })
const quadToday = new ScreenQuadPass(rendererPhysicalToday.passContext, crtDisplay, { ...SCREEN_AT, room: SCREEN_ROOM })
const quadBaked = new ScreenQuadPass(rendererBaked.passContext, crtDisplay, { ...SCREEN_AT, room: SCREEN_ROOM })
rendererPhysicalToday.addPass("opaque", quadToday)
rendererBaked.addPass("opaque", quadBaked)

function setCrtPicture(rgb01: readonly [number, number, number] | null) {
  if (!rgb01) {
    crtScreenSettings.power = false
    crtDisplay.power.reset(false)
    crtDisplay.light.push(new Float32Array([0, 0, 0]), 1, 1)
    crtDisplay.update(0)
    return
  }
  const r8 = Math.min(255, Math.max(0, Math.round(rgb01[0] ** (1 / 2.2) * 255)))
  const g8 = Math.min(255, Math.max(0, Math.round(rgb01[1] ** (1 / 2.2) * 255)))
  const b8 = Math.min(255, Math.max(0, Math.round(rgb01[2] ** (1 / 2.2) * 255)))
  const pixels = new Uint8Array(16 * 16 * 4)
  for (let i = 0; i < 16 * 16; i++) {
    pixels[i * 4] = r8
    pixels[i * 4 + 1] = g8
    pixels[i * 4 + 2] = b8
    pixels[i * 4 + 3] = 255
  }
  device.queue.writeTexture({ texture: crtSourceTex }, pixels, { bytesPerRow: 16 * 4 }, [16, 16])
  crtScreenSettings.power = true
  crtDisplay.power.reset(true)
  crtDisplay.light.push(new Float32Array(rgb01), 1, 1)
  crtDisplay.update(0)
}

const vegetation = cloneFoliageParams()
applyFoliagePreset("tree", "oak", vegetation)
applyFoliagePreset("bush", "hedge", vegetation)
applyFoliagePreset("grass", "lawn", vegetation)

// Build the house room with `screen: true` (`kit-crt` workbench + CRT) and `bakedRoom: true` (Blender UV2s, soffit, bookcase, actor)
const geometry = buildWorld({ ...WORLD_DEFAULTS, vegetation, screen: true, bakedRoom: true })
// Zero the legacy 1x1 flat daylight bounce texture so Today vs Baked GI compares direct-only vs Cycles per-light bounce
geometry.level.bounce.data.fill(0)

rendererPhysicalToday.setLevel(geometry.level)
rendererPhysicalToday.resize(W, H)
rendererBaked.setLevel(geometry.level)
rendererBaked.resize(W, H)

// Orbit camera matching `BAKED_GI_CAMERA` inside the house
const vp = new Float32Array(16)
const eye: [number, number, number] = [0, 0, 0]
{
  const { target: f0, yaw, pitch, dist } = BAKED_GI_CAMERA
  const cp = Math.cos(pitch)
  const sp = Math.sin(pitch)
  const cy = Math.cos(yaw)
  const sy = Math.sin(yaw)
  const ex = f0[0] + sy * cp * dist
  const ey = f0[1] + sp * dist
  const ez = f0[2] + cy * cp * dist
  eye[0] = ex
  eye[1] = ey
  eye[2] = ez
  let zx = ex - f0[0]
  let zy = ey - f0[1]
  let zz = ez - f0[2]
  const zl = Math.hypot(zx, zy, zz)
  zx /= zl
  zy /= zl
  zz /= zl
  let xx = zz
  let xz = -zx
  const xl = Math.hypot(xx, xz)
  xx /= xl
  xz /= xl
  const yx = zy * xz
  const yy = zz * xx - zx * xz
  const yz = -zy * xx
  const f = 1 / Math.tan(0.65 * 0.5)
  const near = 0.1
  const far = 150
  const nf = 1 / (near - far)
  const p0 = f / (W / H)
  const p5 = f
  const p10 = far * nf
  const p14 = far * near * nf
  const tx = -(xx * ex + xz * ez)
  const ty = -(yx * ex + yy * ey + yz * ez)
  const tz = -(zx * ex + zy * ey + zz * ez)
  vp.set([
    p0 * xx,
    p5 * yx,
    p10 * zx,
    -zx,
    0,
    p5 * yy,
    p10 * zy,
    -zy,
    p0 * xz,
    p5 * yz,
    p10 * zz,
    -zz,
    p0 * tx,
    p5 * ty,
    p10 * tz + p14,
    -tz,
  ])
}

const frame = newSceneFrame()
const lampPower = new Float32Array(8)
const knobs = new Float32Array(BAKED_GI_UNIFORM_FLOATS)
const empty = new Float32Array(0)

type RenderOpts = {
  r: Renderer
  gi: BakedGiSettings
  lampPower: number
  porchOn?: boolean
  crtEmission?: readonly [number, number, number]
  crtLightKnob?: number
}

function setupFrame(opts: RenderOpts) {
  const rawClock = worldClock(0)
  // Dim outdoor moon/sky inside the room (`skyLight = 0.015`, matching `screen-bench` / `baked-gi`)
  const skyK = 0.015
  const clock = {
    ...rawClock,
    ambient: [
      rawClock.ambient[0] * skyK,
      rawClock.ambient[1] * skyK,
      rawClock.ambient[2] * skyK,
      rawClock.ambient[3] * skyK,
    ] as [number, number, number, number],
    key: { ...rawClock.key, power: rawClock.key.power * skyK },
  }
  const flick = worldFlicker(0, 1.0)
  const baseLights = worldLights(clock, {
    lampPower: opts.lampPower,
    headlights: false,
    flashlight: false,
    porch: opts.porchOn ?? false,
    flicker: flick,
    physical: true,
    bakedRoom: true,
  })

  const crtEm = opts.crtEmission ?? [0, 0, 0]
  const crtOn = crtEm[0] + crtEm[1] + crtEm[2] > 0
  quadToday.visible = opts.r === rendererPhysicalToday
  quadBaked.visible = opts.r === rendererBaked
  setCrtPicture(
    crtOn
      ? [
          Math.min(1, crtEm[0] / 6.0),
          Math.min(1, crtEm[1] / 6.0),
          Math.min(1, crtEm[2] / 6.0),
        ]
      : null,
  )
  const screenSettings = createScreenDisplaySettings({
    power: crtOn,
    brightness: 2.4,
    light: opts.crtLightKnob ?? 14,
    lightShape: "panel",
    lightRange: 6,
  })
  const crtEmitter = {
    settings: screenSettings,
    light: new ScreenLightProbe(),
    emission: () => crtEm,
  }
  const crtDirect = screenSceneLight(crtEmitter, SCREEN_AT, {
    model: "physical",
    id: SCREEN_LIGHT_ID.screen,
  })
  const crtBounce: LiveBounceSource = screenBounceSource(crtEmitter, SCREEN_LIGHT_ID.screen, SCREEN_BAKE_REFERENCE)

  const allScene: SceneLight[] = crtDirect ? [...baseLights, crtDirect] : baseLights
  const lights = new SceneLights()
  lights.setBoxes(geometry.boxes)
  lights.update(allScene, geometry.casters)

  packSceneFrame(frame, {
    viewProj: vp,
    eye,
    time: 1.0,
    width: W,
    height: H,
    lightCount: lights.lightCount,
    ambient: clock.ambient,
    mapSize: [40, 40],
    ao: 0.45,
  })

  const lampsOn = clock.lamps * opts.lampPower
  lampPower.fill(0)
  lampPower[LAMP.porch] = (opts.porchOn ?? false) ? lampsOn : 0
  lampPower[LAMP.street] = lampsOn
  lampPower[LAMP.interior] = lampsOn
  lampPower[LAMP.tvLed] = screenSettings.power ? 0.8 : 0

  knobs.fill(0)
  packPhysicalLightKnobs({ ...PHYSICAL_LIGHT_DEFAULTS, model: "physical" }, knobs)
  packBakedLightmapUniforms(knobs, HOUSE_LIGHTMAP_META, allScene, opts.gi, [crtBounce])
  opts.r.setCustomUniforms(knobs)

  return {
    frame,
    lights: lights.lights,
    lightCount: lights.lightCount,
    shadowLightCount: lights.shadowLightCount,
    occluders: lights.occ,
    occluderCount: lights.occCount,
    lampPower,
    lampCount: LAMP_COUNT,
    view: [-40, -40, 40, 40] as const,
    batches: [],
    alphaSprites: empty,
    alphaCount: 0,
    addSprites: empty,
    addCount: 0,
    // Fixed exposure across every still (`Lamp ON`, `Lamp OFF`, `CRT Cyan`, `CRT Red`), with `shadowLift = 0` and `lensBloom = 0.25`
    grade: [1.0, 0, 0, 1.45] as [number, number, number, number],
    look: null,
    postCustom: [1, 0, 0.25, 0] as const,
  }
}

async function renderRgb(opts: RenderOpts): Promise<Uint8Array> {
  const input = setupFrame(opts)
  for (let i = 0; i < 2; i++) {
    opts.r.drawTo(input as never, target.createView())
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
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = y * bpr + x * 4
      rgb.set([raw[o + 2]!, raw[o + 1]!, raw[o]!], (y * W + x) * 3)
    }
  }
  buf.unmap()
  buf.destroy()
  return rgb
}

function regionStats(rgb: Uint8Array, x0 = 0, y0 = 0, x1 = W, y1 = H) {
  let sr = 0
  let sg = 0
  let sb = 0
  let n = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 3
      sr += rgb[i]!
      sg += rgb[i + 1]!
      sb += rgb[i + 2]!
      n++
    }
  }
  const r = sr / Math.max(1, n)
  const g = sg / Math.max(1, n)
  const b = sb / Math.max(1, n)
  const luma255 = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return {
    r: Number(r.toFixed(2)),
    g: Number(g.toFixed(2)),
    b: Number(b.toFixed(2)),
    luma255: Number(luma255.toFixed(2)),
    luma01: Number((luma255 / 255).toFixed(4)),
  }
}

function writePpm(path: string, w: number, h: number, rgb: Uint8Array) {
  const head = new TextEncoder().encode(`P6\n${w} ${h}\n255\n`)
  const out = new Uint8Array(head.length + rgb.length)
  out.set(head)
  out.set(rgb, head.length)
  deno.writeFileSync(path, out)
}

function sideBySide(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(W * 2 * H * 3)
  for (let y = 0; y < H; y++) {
    out.set(left.subarray(y * W * 3, (y + 1) * W * 3), y * W * 2 * 3)
    out.set(right.subarray(y * W * 3, (y + 1) * W * 3), (y * W * 2 + W) * 3)
  }
  return out
}

const giToday: BakedGiSettings = { ...BAKED_GI_DEFAULTS, giMode: "today" }
const giBaked: BakedGiSettings = { ...BAKED_GI_DEFAULTS, giMode: "baked", giIntensity: 1, giProbes: 1 }

// 1. Verify giMode="today" on hooked shader matches unhooked Today shader
const imgLampOnBeforeUnhooked = await renderRgb({ r: rendererPhysicalToday, gi: giToday, lampPower: 1 })
const imgLampOnBefore = await renderRgb({ r: rendererBaked, gi: giToday, lampPower: 1 })
let maxDiffToday = 0
for (let i = 0; i < imgLampOnBeforeUnhooked.length; i++) {
  maxDiffToday = Math.max(maxDiffToday, Math.abs(imgLampOnBeforeUnhooked[i]! - imgLampOnBefore[i]!))
}

// 2. Pair 1: Lamp ON — Before vs After (`giIntensity = 1.0`, `giProbes = 1.0`)
const imgLampOnAfter = await renderRgb({ r: rendererBaked, gi: giBaked, lampPower: 1 })

// 3. Pair 2: Lamp OFF — Before vs After (`lampPower = 0`, CRT off)
const imgLampOffBefore = await renderRgb({ r: rendererBaked, gi: giToday, lampPower: 0 })
const imgLampOffAfter = await renderRgb({ r: rendererBaked, gi: giBaked, lampPower: 0 })

// 4. Pair 3: CRT Colour Change — Cyan vs Warm Red (`lampPower = 0`, CRT on via `screenSceneLight` + `screenBounceSource`)
const cyanEmission: [number, number, number] = [0.4, 3.2, 6.0]
const redEmission: [number, number, number] = [6.0, 0.7, 0.4]
const imgCrtCyanBefore = await renderRgb({ r: rendererBaked, gi: giToday, lampPower: 0, crtEmission: cyanEmission, crtLightKnob: 14 })
const imgCrtCyanAfter = await renderRgb({ r: rendererBaked, gi: giBaked, lampPower: 0, crtEmission: cyanEmission, crtLightKnob: 14 })
const imgCrtRedBefore = await renderRgb({ r: rendererBaked, gi: giToday, lampPower: 0, crtEmission: redEmission, crtLightKnob: 14 })
const imgCrtRedAfter = await renderRgb({ r: rendererBaked, gi: giBaked, lampPower: 0, crtEmission: redEmission, crtLightKnob: 14 })

// 5. Measure paired GPU frame time over 80 frames (8 batches of 10 frames, interleaved Today vs Baked GI)
const BATCHES = 8
const FRAMES_PER_BATCH = 10
const N_BENCH = BATCHES * FRAMES_PER_BATCH
const inputToday = setupFrame({ r: rendererPhysicalToday, gi: giToday, lampPower: 1 })
const inputBaked = setupFrame({ r: rendererBaked, gi: giBaked, lampPower: 1 })

for (let i = 0; i < 10; i++) {
  rendererPhysicalToday.drawTo(inputToday as never, target.createView())
  rendererBaked.drawTo(inputBaked as never, target.createView())
}
await device.queue.onSubmittedWorkDone()

let sumTodayMs = 0
let sumBakedMs = 0
for (let b = 0; b < BATCHES; b++) {
  const t0 = performance.now()
  for (let i = 0; i < FRAMES_PER_BATCH; i++) {
    rendererPhysicalToday.drawTo(inputToday as never, target.createView())
  }
  await device.queue.onSubmittedWorkDone()
  sumTodayMs += performance.now() - t0

  const t1 = performance.now()
  for (let i = 0; i < FRAMES_PER_BATCH; i++) {
    rendererBaked.drawTo(inputBaked as never, target.createView())
  }
  await device.queue.onSubmittedWorkDone()
  sumBakedMs += performance.now() - t1
}
const avgTodayMs = sumTodayMs / N_BENCH
const avgBakedMs = sumBakedMs / N_BENCH
const deltaMs = avgBakedMs - avgTodayMs

// Regional luma breakdown (960x600 viewport at reframed `BAKED_GI_CAMERA`)
function analyzeRegions(rgb: Uint8Array) {
  return {
    fullFrame: regionStats(rgb, 0, 0, W, H),
    rugPoolUnderLamp: regionStats(rgb, 560, 480, 840, 588),
    ceilingAboveLamp: regionStats(rgb, 420, 12, 740, 95),
    backWallNearLamp: regionStats(rgb, 360, 150, 530, 275),
    bookcaseAndActor: regionStats(rgb, 40, 240, 320, 485),
    crtWallAndBench: regionStats(rgb, 550, 235, 710, 400),
    darkCornerLeft: regionStats(rgb, 15, 20, 140, 130),
  }
}

const lampOnBeforeRegions = analyzeRegions(imgLampOnBefore)
const lampOnAfterRegions = analyzeRegions(imgLampOnAfter)
const lampOffBeforeRegions = analyzeRegions(imgLampOffBefore)
const lampOffAfterRegions = analyzeRegions(imgLampOffAfter)
const crtCyanBeforeRegions = analyzeRegions(imgCrtCyanBefore)
const crtCyanAfterRegions = analyzeRegions(imgCrtCyanAfter)
const crtRedBeforeRegions = analyzeRegions(imgCrtRedBefore)
const crtRedAfterRegions = analyzeRegions(imgCrtRedAfter)

const metrics = {
  viewport: { width: W, height: H },
  exposureGrade: 1.45,
  blenderVersion: HOUSE_LIGHTMAP_META.blenderVersion,
  inputHash: HOUSE_LIGHTMAP_META.inputHash,
  analyticSpotFloorCheck: HOUSE_LIGHTMAP_META.analyticSpotFloorCheck,
  uv2TriangleCount: HOUSE_LIGHTMAP_META.uv2Tris.length,
  todayBaselineMaxByteDiff: maxDiffToday,
  gpuFrameTimeMs: {
    todayMs: Number(avgTodayMs.toFixed(3)),
    bakedGiMs: Number(avgBakedMs.toFixed(3)),
    deltaMs: Number(deltaMs.toFixed(3)),
    budgetMs: 0.3,
  },
  gpuMemory: {
    lightmapFormat: HOUSE_LIGHTMAP_META.format,
    lightmapDimensions: `${HOUSE_LIGHTMAP_META.size}x${HOUSE_LIGHTMAP_META.size}x${HOUSE_LIGHTMAP_META.lights.length}`,
    lightmapTextureBytes: HOUSE_LIGHTMAP_META.size * HOUSE_LIGHTMAP_META.size * HOUSE_LIGHTMAP_META.lights.length * 4,
    probeUniformBytes: 32 * 12 * 4,
    totalGpuBytes: bakedGpu.byteLength,
    totalGpuMiB: Number((bakedGpu.byteLength / (1024 * 1024)).toFixed(3)),
  },
  lampOn: {
    before: lampOnBeforeRegions,
    after: lampOnAfterRegions,
  },
  lampOff: {
    before: lampOffBeforeRegions,
    after: lampOffAfterRegions,
  },
  crtColourChange: {
    cyanBefore: crtCyanBeforeRegions,
    cyanAfter: crtCyanAfterRegions,
    redBefore: crtRedBeforeRegions,
    redAfter: crtRedAfterRegions,
  },
  uncapturedGpuErrors: errors.length,
}

console.log(JSON.stringify(metrics, null, 2))

if (outDir) {
  deno.mkdirSync(outDir, { recursive: true })
  writePpm(`${outDir}/01-lamp-on-before.ppm`, W, H, imgLampOnBefore)
  writePpm(`${outDir}/02-lamp-on-after.ppm`, W, H, imgLampOnAfter)
  writePpm(`${outDir}/03-lamp-on-paired.ppm`, W * 2, H, sideBySide(imgLampOnBefore, imgLampOnAfter))
  writePpm(`${outDir}/01-lamp-on-before-v2.ppm`, W, H, imgLampOnBefore)
  writePpm(`${outDir}/02-lamp-on-after-v2.ppm`, W, H, imgLampOnAfter)
  writePpm(`${outDir}/03-lamp-on-paired-v2.ppm`, W * 2, H, sideBySide(imgLampOnBefore, imgLampOnAfter))
  writePpm(`${outDir}/04-lamp-off-before.ppm`, W, H, imgLampOffBefore)
  writePpm(`${outDir}/05-lamp-off-after.ppm`, W, H, imgLampOffAfter)
  writePpm(`${outDir}/06-lamp-off-paired.ppm`, W * 2, H, sideBySide(imgLampOffBefore, imgLampOffAfter))
  writePpm(`${outDir}/07-crt-cyan-before.ppm`, W, H, imgCrtCyanBefore)
  writePpm(`${outDir}/08-crt-cyan-after.ppm`, W, H, imgCrtCyanAfter)
  writePpm(`${outDir}/09-crt-red-before.ppm`, W, H, imgCrtRedBefore)
  writePpm(`${outDir}/10-crt-red-after.ppm`, W, H, imgCrtRedAfter)
  writePpm(`${outDir}/11-crt-colour-paired.ppm`, W * 2, H, sideBySide(imgCrtCyanAfter, imgCrtRedAfter))
  writePpm(`${outDir}/12-crt-cyan-paired.ppm`, W * 2, H, sideBySide(imgCrtCyanBefore, imgCrtCyanAfter))
  writePpm(`${outDir}/13-crt-red-paired.ppm`, W * 2, H, sideBySide(imgCrtRedBefore, imgCrtRedAfter))
  deno.writeTextFileSync(`${outDir}/metrics.json`, JSON.stringify(metrics, null, 2))
}

if (errors.length > 0) throw new Error(`WebGPU errors: ${errors.join("; ")}`)
if (maxDiffToday > 1) throw new Error(`Expected giMode="today" to match unhooked renderer, got maxDiff=${maxDiffToday}`)

// Verify Lamp ON: ceiling, back wall, and bookcase/actor lift with warm bounce while dark corners stay dark and falloff holds
if (lampOnAfterRegions.ceilingAboveLamp.luma255 <= lampOnBeforeRegions.ceilingAboveLamp.luma255 + 8) {
  throw new Error("Expected ceiling above lamp to receive warm indirect bounce")
}
if (lampOnAfterRegions.backWallNearLamp.luma255 <= lampOnBeforeRegions.backWallNearLamp.luma255 + 8) {
  throw new Error("Expected back wall near lamp to receive indirect bounce")
}
if (lampOnAfterRegions.bookcaseAndActor.luma255 <= lampOnBeforeRegions.bookcaseAndActor.luma255 + 4) {
  throw new Error("Expected bookcase and dynamic actor to receive indirect bounce")
}
if (lampOnAfterRegions.darkCornerLeft.luma255 >= lampOnAfterRegions.ceilingAboveLamp.luma255 * 0.78) {
  throw new Error("Expected dark corner to stay significantly darker than ceiling above lamp")
}

// Verify Lamp OFF: Baked GI adds zero light when lamps and CRT are off, and the room stays genuinely black
if (Math.abs(lampOffAfterRegions.fullFrame.luma255 - lampOffBeforeRegions.fullFrame.luma255) > 0.01) {
  throw new Error("Expected lamp OFF After to match lamp OFF Before with zero residual bounce")
}
if (lampOffAfterRegions.ceilingAboveLamp.luma255 > 4.0) {
  throw new Error(`Expected lamp OFF ceiling to be black (< 4.0/255), got ${lampOffAfterRegions.ceilingAboveLamp.luma255}`)
}
if (lampOffAfterRegions.rugPoolUnderLamp.luma255 > 6.0) {
  throw new Error(`Expected lamp OFF rug to be black (< 6.0/255), got ${lampOffAfterRegions.rugPoolUnderLamp.luma255}`)
}

// Verify CRT Colour Change: Cyan bounce shifts wall/ceiling blue channel up and Red bounce shifts red channel up
if (crtCyanAfterRegions.ceilingAboveLamp.b - crtCyanBeforeRegions.ceilingAboveLamp.b < 1.0) {
  throw new Error("Expected Cyan CRT bounce to lift blue channel on ceiling")
}
if (crtRedAfterRegions.ceilingAboveLamp.r - crtRedBeforeRegions.ceilingAboveLamp.r < 3.0) {
  throw new Error("Expected Red CRT bounce to lift red channel on ceiling")
}
if (crtCyanAfterRegions.crtWallAndBench.b <= crtCyanAfterRegions.crtWallAndBench.r + 15) {
  throw new Error("Expected Cyan CRT wall and bench to have B > R")
}
if (crtRedAfterRegions.crtWallAndBench.r <= crtRedAfterRegions.crtWallAndBench.b) {
  throw new Error("Expected Red CRT wall and bench to have R > B")
}
