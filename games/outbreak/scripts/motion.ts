/**
 * Temporal stability of Outbreak in motion, the lot's metric (`games/lot/scripts/motion.ts`) on Outbreak's camera:
 * scripted walks at night (seed 7, no zombies) stepped on a synthetic 60 fps clock (`__arcadeHarness.step`), headless
 * and muted, with Lab settings toggled per variant to attribute what crawls.
 *
 * Per frame, on display luminance (0..255) of the canvas, each pixel's world point (unprojected from the scene depth,
 * kept for the run) is reprojected into the previous frame and compared with the range of the four texels it falls
 * between, so a still world under a moving camera scores ~0 and only appearance changes count (disoccluded and
 * off-screen pixels are skipped):
 * - **pops**: pixels 12 or more outside that range per frame; **flicker**: mean distance outside it.
 * - **flash frames**: frames with a 32×32 px block whose mean signed change is over 3 (an area brightening at once).
 * Every path also runs held still (`<path>-still`), the floor of what animates on its own (rain, ripples, flicker).
 * Each run writes a pop map (`<path>-<variant>-pops.png`: white = popped every 10th frame or more).
 *
 *   hivemind run --kind browser --browser-approval "<Kit's request>" -- bun scripts/motion.ts
 *
 * MOTION_OUT=<dir> (default captures/outbreak-motion), MOTION_PATHS=street,lamps,…, MOTION_VARIANTS=base,before,…,
 * MOTION_RECORD=<variant,…> saves JPEG frames of those variants (`frames/<path>-<variant>/0001.jpg`) for clips,
 * MOTION_VIEWPORT=WxH (default 1536x960), MOTION_STILL=0 skips the still runs, MOTION_STILL_VARIANTS=<variant,…> (default
 * base) are the variants that also run still, MOTION_FRAMES=<n> caps path length.
 */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright-core"
import { createServer } from "vite"

const root = resolve(import.meta.dir, "..")
const out = resolve(process.env.MOTION_OUT ?? resolve(root, "../../captures/outbreak-motion"))
mkdirSync(out, { recursive: true })
const viewport = (process.env.MOTION_VIEWPORT ?? "1536x960").split("x").map(Number) as [number, number]

/**
 * Where the survivor starts and how it moves: `mx`/`my` the walk input, `aim` radians (0 east, −π/2 north). `pan`
 * slides the camera's target by (dx, dz) metres with the survivor standing still: the view moves and no light does.
 */
type Path = {
  hour: number; x: number; y: number; frames: number; flashlight: boolean; rain?: boolean
  walk: (t: number) => { mx: number; my: number; aim: number }
  pan?: (t: number) => [number, number]
  /** Lab settings this path always runs with (over the variant's). */
  knobs?: Record<string, number>
}
export const PATHS: Record<string, Path> = {
  // East down the start street with the flashlight on: potholes holding water, kerbs, verges, lit windows.
  street: { hour: 21, x: 20, y: 43.4, frames: 150, flashlight: true, walk: () => ({ mx: 1, my: 0, aim: 0.15 }) },
  // Past Ash's street lamp (pool at 40.6, 42.4) and the lit houses beside it, flashlight off: lamp pools, bounce, glints.
  lamps: { hour: 22, x: 31, y: 41.6, frames: 150, flashlight: false, walk: (t) => ({ mx: 1, my: 0.15 * Math.sin(t * 1.3), aim: 0 }) },
  // The street walk in rain: drops, wet paving, every puddle mirroring the lights, ripples.
  rain: { hour: 21, x: 20, y: 43.4, frames: 150, flashlight: true, rain: true, walk: () => ({ mx: 1, my: 0, aim: 0.15 }) },
  // The camera pans 6 m east past Ash's lamp and the lit houses while the survivor stands in its pool.
  "pan-lamps": { hour: 22, x: 38.5, y: 43.2, frames: 150, flashlight: false, walk: () => ({ mx: 0, my: 0, aim: 0 }), pan: (t) => [-3 + 2.4 * t, 0.4 * Math.sin(t * 2)] },
  // The lamp pan after rain (Lab wetness, no drops or ripples): wet paving and puddles mirroring the lamp and windows.
  "pan-wet": { hour: 22, x: 38.5, y: 43.2, frames: 150, flashlight: false, knobs: { reflectWetness: 1 }, walk: () => ({ mx: 0, my: 0, aim: 0 }), pan: (t) => [-3 + 2.4 * t, 0.4 * Math.sin(t * 2)] },
  // The same pan down the rain-soaked street with the flashlight held on the puddles.
  "pan-rain": { hour: 21, x: 27, y: 43.4, frames: 150, flashlight: true, rain: true, walk: () => ({ mx: 0, my: 0, aim: 0.15 }), pan: (t) => [-3 + 2.4 * t, 0] },
  // Through the start house at night with the flashlight: rugs, furniture, table lamps, bounce off the walls.
  indoor: { hour: 21, x: 24.6, y: 31.2, frames: 90, flashlight: true, walk: (t) => ({ mx: 0.78, my: -0.28, aim: -0.35 + 0.3 * Math.sin(t * 1.5) }) },
  // The same walk with the flashlight off, lit by the room's lamps only: what crawls under a moving camera alone.
  "indoor-lamps": { hour: 21, x: 24.6, y: 31.2, frames: 90, flashlight: false, walk: (t) => ({ mx: 0.78, my: -0.28, aim: -0.35 + 0.3 * Math.sin(t * 1.5) }) },
}

/**
 * Lab settings per variant, applied over the shipped defaults: soft shadows (D-48) on in all but `soft-off`, and the
 * grade's film grain off (it is new noise every frame by design and would bury everything else), and the coloured night
 * practicals off (police light bars, alarm beacons, neon and dying sodium lamps strobe by design: a light bar just off
 * screen floods a quarter of the frame on every flash).
 */
const BASE: Record<string, number | string | boolean> = { softShadowMode: 1, dayGrain: 0, nightGrain: 0, shroudGrain: 0, nightLights: false }
const VARIANTS: Record<string, Record<string, number | string | boolean>> = {
  base: {},
  // The fixes in this pass off: glints without LEAN and every stability fix reverted to main.
  before: { glintAA: 0, lampReachFade: 0 },
  "glint-aa-off": { glintAA: 0 },
  "reach-fade-off": { lampReachFade: 0 },
  "refl-off": { reflections: 0 },
  "bounce-off": { bouncedLight: 0 },
  "soft-off": { softShadowMode: 0 },
  // The camera at its farthest (Lab › View › Camera distance), where glints and ripples shrink toward a pixel.
  far: { zoom: 65 },
  "far-glint-aa-off": { zoom: 65, glintAA: 0 },
  taa: { aaMode: 1 },
  "taa-before": { aaMode: 1, glintAA: 0, lampReachFade: 0 },
}
const pathNames = (process.env.MOTION_PATHS ?? Object.keys(PATHS).join(",")).split(",").filter(Boolean)
const variantNames = (process.env.MOTION_VARIANTS ?? "base,before").split(",").filter(Boolean)
const record = new Set((process.env.MOTION_RECORD ?? "").split(",").filter(Boolean))
const withStill = process.env.MOTION_STILL !== "0"
const stillVariants = new Set((process.env.MOTION_STILL_VARIANTS ?? "base").split(",").filter(Boolean))
const frameCap = Number(process.env.MOTION_FRAMES ?? 0)
for (const v of variantNames) assert(v in VARIANTS || v.startsWith("json:"), `unknown variant ${v}`)

/**
 * One frame's reprojection score (standalone so V8 optimises the per-pixel loop): returns [sum of out-of-range
 * change, pops, valid pixels, flash blocks, max block mean]. `heat` counts pops per pixel.
 */
function analyzeFrame(
  W: number, H: number, cur: Float32Array, prev: Float32Array, dcur: Float32Array, dprev: Float32Array,
  iv: Float64Array, ipv: Float64Array, pv: Float32Array, ex: number, ey: number, ez: number, heat: Uint16Array,
): number[] {
  const BS = 32, bw = Math.ceil(W / BS), bh = Math.ceil(H / BS)
  const block = new Float64Array(bw * bh), blockN = new Uint32Array(bw * bh)
  const i0 = iv[0]!, i1 = iv[1]!, i2 = iv[2]!, i3 = iv[3]!, i4 = iv[4]!, i5 = iv[5]!, i6 = iv[6]!, i7 = iv[7]!
  const i8 = iv[8]!, i9 = iv[9]!, i10 = iv[10]!, i11 = iv[11]!, i12 = iv[12]!, i13 = iv[13]!, i14 = iv[14]!, i15 = iv[15]!
  const j0 = ipv[0]!, j1 = ipv[1]!, j2 = ipv[2]!, j3 = ipv[3]!, j4 = ipv[4]!, j5 = ipv[5]!, j6 = ipv[6]!, j7 = ipv[7]!
  const j8 = ipv[8]!, j9 = ipv[9]!, j10 = ipv[10]!, j11 = ipv[11]!, j12 = ipv[12]!, j13 = ipv[13]!, j14 = ipv[14]!, j15 = ipv[15]!
  const p0 = pv[0]!, p1 = pv[1]!, p3 = pv[3]!, p4 = pv[4]!, p5 = pv[5]!, p7 = pv[7]!, p8 = pv[8]!, p9 = pv[9]!, p11 = pv[11]!, p12 = pv[12]!, p13 = pv[13]!, p15 = pv[15]!
  let sum = 0, pops = 0, valid = 0
  for (let y = 0; y < H; y++) {
    const ny = 1 - ((y + 0.5) / H) * 2
    const brow = ((y / BS) | 0) * bw
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      const z = dcur[i]!
      if (!(z < 0.99999)) continue
      const nx = ((x + 0.5) / W) * 2 - 1
      const hw = i3 * nx + i7 * ny + i11 * z + i15
      const wx = (i0 * nx + i4 * ny + i8 * z + i12) / hw
      const wy = (i1 * nx + i5 * ny + i9 * z + i13) / hw
      const wz = (i2 * nx + i6 * ny + i10 * z + i14) / hw
      const pw = p3 * wx + p7 * wy + p11 * wz + p15
      if (pw <= 0) continue
      const qx = ((p0 * wx + p4 * wy + p8 * wz + p12) / pw * 0.5 + 0.5) * W - 0.5
      const qy = (0.5 - (p1 * wx + p5 * wy + p9 * wz + p13) / pw * 0.5) * H - 0.5
      const cx = Math.round(qx), cy = Math.round(qy)
      if (cx < 1 || cy < 1 || cx >= W - 1 || cy >= H - 1) continue
      // Disoccluded: what the previous frame showed there is a different surface.
      const pz = dprev[cy * W + cx]!
      const pnx = ((cx + 0.5) / W) * 2 - 1, pny = 1 - ((cy + 0.5) / H) * 2
      const phw = j3 * pnx + j7 * pny + j11 * pz + j15
      const dx = (j0 * pnx + j4 * pny + j8 * pz + j12) / phw - wx
      const dy = (j1 * pnx + j5 * pny + j9 * pz + j13) / phw - wy
      const dz = (j2 * pnx + j6 * pny + j10 * pz + j14) / phw - wz
      const ox = wx - ex, oy = wy - ey, oz = wz - ez
      const tol = 0.02 * Math.sqrt(ox * ox + oy * oy + oz * oz) + 0.08
      if (dx * dx + dy * dy + dz * dz > tol * tol) continue
      const fx = Math.floor(qx), fy = Math.floor(qy), a = fy * W + fx
      const t00 = prev[a]!, t10 = prev[a + 1]!, t01 = prev[a + W]!, t11 = prev[a + W + 1]!
      const lo = t00 < t10 ? (t01 < t11 ? (t00 < t01 ? t00 : t01) : (t00 < t11 ? t00 : t11)) : (t01 < t11 ? (t10 < t01 ? t10 : t01) : (t10 < t11 ? t10 : t11))
      const hi = t00 > t10 ? (t01 > t11 ? (t00 > t01 ? t00 : t01) : (t00 > t11 ? t00 : t11)) : (t01 > t11 ? (t10 > t01 ? t10 : t01) : (t10 > t11 ? t10 : t11))
      const v = cur[i]!
      const signed = v > hi ? v - hi : v < lo ? v - lo : 0
      const diff = signed < 0 ? -signed : signed
      sum += diff
      valid++
      if (diff >= 12) { pops++; heat[i]!++ }
      const bi = brow + ((x / BS) | 0)
      block[bi]! += signed
      blockN[bi]!++
    }
  }
  let flash = 0, flashMax = 0
  for (let i = 0; i < block.length; i++) if (blockN[i]! > BS * BS * 0.5) {
    const m = Math.abs(block[i]! / blockN[i]!)
    if (m > 3) flash++
    if (m > flashMax) flashMax = m
  }
  return [sum, pops, valid, flash, flashMax]
}

const HUD = "#status, #hotbar, #stamina, #battery, .callouts, .callout, #hud, .hud, #markers, #prompt, #sound-cues, .coop-tag, .ob-hud, [data-callout-layer], .ob-callout-layer"
// Its own dep cache and no HMR: runs sharing a checkout would otherwise reload each other's pages mid-walk.
const server = await createServer({
  root,
  logLevel: "error",
  cacheDir: resolve(root, `node_modules/.vite-motion-${process.pid}`),
  server: { host: "127.0.0.1", port: 0, hmr: false, watch: null, fs: { allow: [resolve(root, "../..")] } },
})
await server.listen()
const port = (server.httpServer!.address() as { port: number }).port
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache).filter((n) => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
assert(executablePath, "headless Chromium is missing")
const browser = await chromium.launch({ executablePath, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const report: Record<string, any> = { viewport, captured: new Date().toISOString(), base: BASE, runs: {} }
const errors: string[] = []
try {
  const page = await browser.newPage({ viewport: { width: viewport[0], height: viewport[1] }, deviceScaleFactor: 1 })
  // The canvas is copied out right after each frame is encoded, before it is presented.
  await page.addInitScript(() => {
    const configure = GPUCanvasContext.prototype.configure
    GPUCanvasContext.prototype.configure = function (c: GPUCanvasConfiguration) {
      return configure.call(this, { ...c, usage: (c.usage ?? GPUTextureUsage.RENDER_ATTACHMENT) | GPUTextureUsage.COPY_SRC })
    }
  })
  await page.addInitScript(`window.__motionAnalyze = ${analyzeFrame.toString()}`)
  page.on("pageerror", (e) => errors.push(e.message))
  page.on("console", (m) => {
    if (m.type() === "error" || /wgsl|validation/i.test(m.text())) errors.push(m.text())
    else if (m.text().startsWith("[motion]")) console.log(m.text())
  })
  await page.goto(`http://127.0.0.1:${port}/?solo&seed=7&bench&peaceful=1`, { timeout: 240_000 })
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready, null, { timeout: 240_000 })
  await page.addStyleTag({ content: `${HUD} { visibility: hidden !important; }` })
  report.adapter = await page.evaluate(() => (window as any).__arcadeHarness.adapterInfo)
  // Capture hook: after every frame the renderer encodes, copy the canvas and resolve depth sample 0 to r32float.
  await page.evaluate(() => {
    const h = (window as any).__arcadeHarness
    const r = h.renderer
    const device: GPUDevice = r.device
    const targets = r.targets
    const configure = targets.configureMainPass.bind(targets)
    targets.configureMainPass = (o: any) => configure({ ...o, storeDepth: true })
    const module = device.createShaderModule({ code: /* wgsl */ `
@group(0) @binding(0) var d: texture_depth_multisampled_2d;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f { return vec4f(textureLoad(d, vec2i(p.xy), 0), 0.0, 0.0, 1.0); }` })
    const pipe = device.createRenderPipeline({ layout: "auto", vertex: { module, entryPoint: "vs" }, fragment: { module, entryPoint: "fs", targets: [{ format: "r32float" }] }, primitive: { topology: "triangle-list" } })
    const cam = h.cam
    const follow = cam.follow.bind(cam)
    cam.follow = (x: number, z: number, ...rest: unknown[]) => follow(x + cap.pan[0], z + cap.pan[1], ...rest)
    const cap: any = { pan: [0, 0], on: false, depthTex: null, depthSrc: null, group: null, color: null, depth: null, vp: new Float32Array(19), W: 0, H: 0, format: "" }
    ;(window as any).__motionCap = cap
    const draw = r.draw.bind(r)
    r.draw = (f: any, view?: GPUTextureView) => {
      draw(f, view)
      if (!cap.on || view) return
      const tex: GPUTexture = r.context.getCurrentTexture()
      const W = tex.width, H = tex.height
      if (cap.W !== W || cap.H !== H) {
        cap.W = W; cap.H = H
        cap.row = Math.ceil((W * 4) / 256) * 256
        cap.color?.destroy(); cap.depth?.destroy(); cap.depthTex?.destroy()
        cap.color = device.createBuffer({ size: cap.row * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
        cap.depth = device.createBuffer({ size: cap.row * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
        cap.depthTex = device.createTexture({ size: [W, H], format: "r32float", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC })
        cap.depthSrc = null
      }
      if (cap.depthSrc !== targets.depth) {
        cap.depthSrc = targets.depth
        cap.group = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: targets.depthView }] })
      }
      cap.format = tex.format
      cap.vp.set(f.frame.subarray(0, 19))
      const enc = device.createCommandEncoder()
      enc.copyTextureToBuffer({ texture: tex }, { buffer: cap.color, bytesPerRow: cap.row }, [W, H])
      if (targets.depth.width === W && targets.depth.height === H) {
        const p = enc.beginRenderPass({ colorAttachments: [{ view: cap.depthTex.createView(), loadOp: "clear", storeOp: "store", clearValue: [1, 0, 0, 0] }] })
        p.setPipeline(pipe); p.setBindGroup(0, cap.group); p.draw(3); p.end()
        enc.copyTextureToBuffer({ texture: cap.depthTex }, { buffer: cap.depth, bytesPerRow: cap.row }, [W, H])
        cap.hasDepth = true
      } else cap.hasDepth = false
      device.queue.submit([enc.finish()])
      cap.fresh = true
    }
  })
  const runs: [string, string, boolean][] = []
  for (const path of pathNames) for (const variant of variantNames) {
    runs.push([path, variant, false])
    if (withStill && stillVariants.has(variant)) runs.push([path, variant, true])
  }
  for (const [path, variant, still] of runs) {
    const p = PATHS[path]!
    const knobs = { ...BASE, ...(variant.startsWith("json:") ? JSON.parse(variant.slice(5)) : VARIANTS[variant]!), ...p.knobs }
    const frames = frameCap > 0 ? Math.min(frameCap, p.frames) : p.frames
    const walks = Array.from({ length: frames }, (_, i) => {
      const w = still ? { mx: 0, my: 0, aim: p.walk(0).aim } : p.walk(i / 60)
      return { ...w, pan: p.pan ? p.pan(still ? 0 : i / 60) : [0, 0] }
    })
    const rec = record.has(variant) && !still
    const result = await page.evaluate(async ({ p, knobs, walks, rec }) => {
      const h = (window as any).__arcadeHarness
      const cap = (window as any).__motionCap
      const r = h.renderer
      const device: GPUDevice = r.device
      cap.pan = walks[0].pan
      const stage = () => {
        h.freeze(true)
        h.reset(7)
        h.setQuality("high")
        h.setLab("timeScale", 0)
        h.setLab("hour", p.hour)
        h.setLab("propsOn", true)
        h.setLab("weather.weatherOverride", p.rain ? 2 : 0)
        for (const [k, v] of Object.entries(knobs)) h.setLab(k, v)
        h.pose(p.x, p.y, walks[0].aim)
        h.cam.snap(p.x + walks[0].pan[0], p.y + walks[0].pan[1])
      }
      const light = () => Object.assign(h.state().player, { flashlightOn: p.flashlight, flashlightOutput: p.flashlight ? 1 : 0 })
      stage()
      console.log("[motion] staged")
      const tSettle = performance.now()
      while (performance.now() - tSettle < 20000) {
        Object.assign(h.state().player, { x: p.x, y: p.y, vx: 0, vy: 0 }); light()
        await h.step(1 / 60, { mx: 0, my: 0, aim: walks[0].aim })
        const props = h.state().props
        const rugs = h.interiors?.()
        if ((props?.ready ?? true) && (rugs?.settled ?? true) && performance.now() - tSettle > 400) break
        await new Promise((res) => setTimeout(res, 20))
      }
      stage()
      for (let i = 0; i < 40; i++) {
        Object.assign(h.state().player, { x: p.x, y: p.y, vx: 0, vy: 0 }); light()
        await h.step(1 / 60, { mx: 0, my: 0, aim: walks[0].aim })
      }
      cap.on = true
      console.log("[motion] warmed")
      const read = async (lum: Float32Array, depth: Float32Array, image: ImageData | null) => {
        await cap.color.mapAsync(GPUMapMode.READ)
        const src = new Uint8Array(cap.color.getMappedRange())
        const bgra = cap.format.startsWith("bgra")
        const W = cap.W, H = cap.H, row = cap.row
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          const s = y * row + x * 4, i = y * W + x
          const R = src[s + (bgra ? 2 : 0)]!, G = src[s + 1]!, B = src[s + (bgra ? 0 : 2)]!
          lum[i] = 0.2126 * R + 0.7152 * G + 0.0722 * B
          if (image) { image.data[i * 4] = R; image.data[i * 4 + 1] = G; image.data[i * 4 + 2] = B; image.data[i * 4 + 3] = 255 }
        }
        cap.color.unmap()
        if (!cap.hasDepth) return false
        await cap.depth.mapAsync(GPUMapMode.READ)
        const d = new Float32Array(cap.depth.getMappedRange())
        for (let y = 0; y < H; y++) depth.set(d.subarray((y * row) / 4, (y * row) / 4 + W), y * W)
        cap.depth.unmap()
        return true
      }
      const inv = (m: Float32Array) => {
        const o = new Float64Array(16)
        const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = Array.from(m) as number[]
        const b00 = a00! * a11! - a01! * a10!, b01 = a00! * a12! - a02! * a10!, b02 = a00! * a13! - a03! * a10!, b03 = a01! * a12! - a02! * a11!
        const b04 = a01! * a13! - a03! * a11!, b05 = a02! * a13! - a03! * a12!, b06 = a20! * a31! - a21! * a30!, b07 = a20! * a32! - a22! * a30!
        const b08 = a20! * a33! - a23! * a30!, b09 = a21! * a32! - a22! * a31!, b10 = a21! * a33! - a23! * a31!, b11 = a22! * a33! - a23! * a32!
        const det = 1 / (b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06)
        o[0] = (a11! * b11 - a12! * b10 + a13! * b09) * det; o[1] = (a02! * b10 - a01! * b11 - a03! * b09) * det
        o[2] = (a31! * b05 - a32! * b04 + a33! * b03) * det; o[3] = (a22! * b04 - a21! * b05 - a23! * b03) * det
        o[4] = (a12! * b08 - a10! * b11 - a13! * b07) * det; o[5] = (a00! * b11 - a02! * b08 + a03! * b07) * det
        o[6] = (a32! * b02 - a30! * b05 - a33! * b01) * det; o[7] = (a20! * b05 - a22! * b02 + a23! * b01) * det
        o[8] = (a10! * b10 - a11! * b08 + a13! * b06) * det; o[9] = (a01! * b08 - a00! * b10 - a03! * b06) * det
        o[10] = (a30! * b04 - a31! * b02 + a33! * b00) * det; o[11] = (a21! * b02 - a20! * b04 - a23! * b00) * det
        o[12] = (a11! * b07 - a10! * b09 - a12! * b06) * det; o[13] = (a00! * b09 - a01! * b07 + a02! * b06) * det
        o[14] = (a31! * b01 - a30! * b03 - a32! * b00) * det; o[15] = (a20! * b03 - a21! * b01 + a22! * b00) * det
        return o
      }
      let L: Float32Array[] = [], D: Float32Array[] = [], VP: Float32Array[] = [new Float32Array(19), new Float32Array(19)]
      let heatPops: Uint16Array | null = null, image: ImageData | null = null, g: OffscreenCanvasRenderingContext2D | null = null
      const frames: any[] = []
      const jpegs: string[] = []
      let timing = 0
      for (let f = 0; f < walks.length; f++) {
        const w = walks[f]!
        h.state().player.aim = w.aim; light()
        cap.pan = w.pan
        if (p.pan) Object.assign(h.state().player, { x: p.x, y: p.y, vx: 0, vy: 0 })
        cap.fresh = false
        const t0 = performance.now()
        await h.step(1 / 60, { mx: w.mx, my: w.my, aim: w.aim })
        const t1 = performance.now()
        if (!cap.fresh) throw new Error("no frame captured")
        const W = cap.W, H = cap.H, N = W * H
        if (!L.length) {
          L = [new Float32Array(N), new Float32Array(N)]; D = [new Float32Array(N), new Float32Array(N)]
          heatPops = new Uint16Array(N)
          const c2 = new OffscreenCanvas(W, H)
          g = c2.getContext("2d")!
          image = g.createImageData(W, H)
        }
        const k = f % 2, cur = L[k]!, prev = L[1 - k]!, dcur = D[k]!, dprev = D[1 - k]!
        VP[k]!.set(cap.vp)
        const hasDepth = await read(cur, dcur, rec ? image : null)
        const t2 = performance.now()
        if (rec) {
          g!.putImageData(image!, 0, 0)
          const blob = await (g!.canvas as OffscreenCanvas).convertToBlob({ type: "image/jpeg", quality: 0.92 })
          const b = new Uint8Array(await blob.arrayBuffer())
          let s = ""
          for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000))
          jpegs.push(btoa(s))
        }
        if (f % 30 === 0) console.log(`[motion] frame ${f} depth ${hasDepth} step ${(t1 - t0).toFixed(0)} ms read ${(t2 - t1).toFixed(0)} ms prev analysis ${timing.toFixed(0)} ms`)
        if (f === 0 || !hasDepth) continue
        const iv = inv(VP[k]!.subarray(0, 16)), ipv = inv(VP[1 - k]!.subarray(0, 16)), pv = VP[1 - k]!
        const eye = [VP[k]![16]!, VP[k]![17]!, VP[k]![18]!] as const
        const r = (window as any).__motionAnalyze(W, H, cur, prev, dcur, dprev, iv, ipv, pv, eye[0], eye[1], eye[2], heatPops)
        const [sum, pops, valid, flash, flashMax] = r as number[]
        frames.push({ flicker: valid ? sum / valid : 0, pops, flash, flashMax, valid: valid / N })
        timing = performance.now() - t2
      }
      cap.on = false
      const W = cap.W, H = cap.H, N = W * H
      const pimg = new ImageData(W, H)
      const pn = Math.max(1, walks.length / 10)
      for (let i = 0; i < N; i++) { const v = Math.min(255, (heatPops![i]! / pn) * 255); pimg.data[i * 4] = v; pimg.data[i * 4 + 1] = v; pimg.data[i * 4 + 2] = v; pimg.data[i * 4 + 3] = 255 }
      const pc = new OffscreenCanvas(W, H); pc.getContext("2d")!.putImageData(pimg, 0, 0)
      const pb = new Uint8Array(await (await pc.convertToBlob({ type: "image/png" })).arrayBuffer())
      let ps = ""
      for (let i = 0; i < pb.length; i += 0x8000) ps += String.fromCharCode(...pb.subarray(i, i + 0x8000))
      return { frames, jpegs, pops: btoa(ps), weather: h.state().weather?.state ?? null, player: [h.state().player.x, h.state().player.y] }
    }, { p: { hour: p.hour, x: p.x, y: p.y, flashlight: p.flashlight, rain: !!p.rain, pan: !!p.pan }, knobs, walks, rec })
    if (errors.length) throw new Error(errors.join("\n"))
    const fr = result.frames as { flicker: number; pops: number; flash: number; flashMax: number; valid: number }[]
    const mean = (f: (x: (typeof fr)[0]) => number) => fr.reduce((s, x) => s + f(x), 0) / Math.max(1, fr.length)
    const sorted = fr.map((x) => x.pops).sort((a, b) => a - b)
    const name = `${path}${still ? "-still" : ""}/${variant}`
    const summary = {
      pops: +mean((x) => x.pops).toFixed(1),
      popsP90: sorted[Math.floor(sorted.length * 0.9)] ?? 0,
      flicker: +mean((x) => x.flicker).toFixed(4),
      flashFrames: fr.filter((x) => x.flash > 0).length,
      flashMax: +Math.max(0, ...fr.map((x) => x.flashMax)).toFixed(2),
      valid: +mean((x) => x.valid).toFixed(3),
      frames: fr.length,
      end: result.player,
      perFrame: fr.map((x) => [x.pops, x.flash, +x.flicker.toFixed(3)]),
    }
    report.runs[name] = summary
    const file = `${path}${still ? "-still" : ""}-${variant.replace(/[^\w.-]+/g, "_")}`
    writeFileSync(resolve(out, `${file}-pops.png`), Buffer.from(result.pops, "base64"))
    if (rec) {
      const dir = resolve(out, "frames", `${path}-${variant}`)
      mkdirSync(dir, { recursive: true })
      result.jpegs.forEach((b: string, i: number) => writeFileSync(resolve(dir, `${String(i + 1).padStart(4, "0")}.jpg`), Buffer.from(b, "base64")))
    }
    console.log(`${name.padEnd(28)} pops ${String(summary.pops).padStart(7)}  p90 ${String(summary.popsP90).padStart(6)}  flicker ${summary.flicker.toFixed(4)}  flash frames ${summary.flashFrames} (max ${summary.flashMax})  valid ${summary.valid}  end ${summary.end.map((v: number) => v.toFixed(1)).join(",")}`)
    writeFileSync(resolve(out, "motion.json"), JSON.stringify(report, null, 1))
  }
  report.errors = errors
} finally {
  writeFileSync(resolve(out, "motion.json"), JSON.stringify(report, null, 1))
  await browser.close()
  await server.close()
  rmSync(server.config.cacheDir, { recursive: true, force: true })
}
