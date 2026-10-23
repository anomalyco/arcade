import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { browserBudget } from "../../../scripts/browser-budget"
import { build } from "vite"
import { serveDist } from "./serve-dist"
import { SurfaceQuery } from "../src/surface-query"
import { matchedPaths } from "./motion-paths"

await using budget = browserBudget()
const { chromium } = budget

/**
 * Temporal stability of the lot in motion: scripted camera paths (walk, strafe, turn) rendered frame by frame on a
 * synthetic 60 fps clock (`lot.step`), headless and muted, with each pass toggled to attribute what flickers.
 *
 * Per frame, on display luminance (0..255) of the canvas, each pixel's world point (from the temporal resolve's linear
 * depth) is reprojected into the previous frame and compared with the range of the four texels it falls between, so a still world under motion
 * scores ~0 and only appearance changes count (disoccluded and off-screen pixels are skipped):
 * - **flicker**: mean distance outside that range, per 3×3 screen region; **pops**: pixels ≥ 12 outside it.
 * - **flash**: 32×32 px blocks whose mean signed change is over 3 (an area brightening or dimming at once).
 * - **rois**: the same within a box around a projected world point (a lamp head, the stairwell glow).
 * Each run also writes a heat map of the summed change (`<path>-<variant>-heat.png`).
 *
 *   hivemind run --kind browser --browser-approval "<Kit's request>" -- bun games/lot/scripts/motion.ts
 *
 * MOTION_OUT=<dir> (default captures/lot-motion), MOTION_PATHS=walk,strafe,…, MOTION_VARIANTS=all,ssr-off,…,
 * MOTION_RECORD=<variant,…> saves JPEG frames of those variants (`frames/<path>-<variant>/0001.jpg`) for clips,
 * MOTION_VIEWPORT=WxH (default 1920x1080), MOTION_BASE=<dist dir> serves a prebuilt dist instead of building.
 */
const root = resolve(import.meta.dir, "..")
const out = resolve(process.env.MOTION_OUT ?? resolve(root, "../../captures/lot-motion"))
mkdirSync(out, { recursive: true })
const viewport = (process.env.MOTION_VIEWPORT ?? "1920x1080").split("x").map(Number) as [number, number]

type Pose = { x: number; z: number; yaw: number; pitch: number }
/**
 * A box of half-size r px (at 1080 p) around a world point, or with `mirror` around its reflection in the ground (y 0).
 * `anchored` also scores the box with every pixel moved by the point's own screen motion instead of its depth: how a
 * halo or glow around that point should move (its depth is the sky behind it), reported as `<name>@`.
 */
type Roi = { name: string; p: [number, number, number]; r: number; mirror?: boolean; anchored?: boolean }
type Path = { frames: number; pose: (t: number) => Pose; rois?: Roi[] }
const WALK = 2.1
/** Seconds → pose. Yaw 0 looks along −z, toward the facility. */
export const PATHS: Record<string, Path> = {
  // The title camera walking toward the facility, the far lamps and the wet road reflections (Kit's pin 1).
  walk: { frames: 150, pose: (t) => ({ x: -2.3, z: 157 - WALK * t, yaw: -0.03, pitch: 0.035 }), rois: [{ name: "head100", p: [-6.3, 9.2, 100], r: 50 }, { name: "head58", p: [19.8, 9.2, 57.8], r: 50 }] },
  // Kit's second pin: from the gate, the facility's left end (stairwell glow column, warm bays, fence-line lights).
  gate: { frames: 180, pose: (t) => ({ x: -3 + 0.3 * t, z: 152 - WALK * t, yaw: 0.25 + 0.04 * Math.sin(t * 2), pitch: 0.03 }), rois: [{ name: "stairwell", p: [-41.4, 9, 25], r: 60 }, { name: "bays", p: [-30, 6, 22], r: 90 }] },
  "gate-turn": { frames: 150, pose: (t) => ({ x: -3, z: 150, yaw: 0.05 + 0.18 * t, pitch: 0.03 }), rois: [{ name: "stairwell", p: [-41.4, 9, 25], r: 60 }, { name: "bays", p: [-30, 6, 22], r: 90 }] },
  // Under the booth's sodium head (x 4.6, z 129.6): its pool and the wagon pass underfoot.
  lamp: { ...matchedPaths.lamp!, rois: [{ name: "boothHead", p: [4.5, 6.4, 129.6], r: 60, anchored: true }, { name: "pool", p: [3, 0, 126], r: 160 }, { name: "booth", p: [9, 1.4, 127.5], r: 160 }] },
  // Kit's first Scrawl at 0:12–0:16: past the mid-lot head (x −6.3, z 100) toward the facility, the far head's wet streak
  // (x 19.8, z 57.8) and the road glitter between.
  kit: { ...matchedPaths.kit!, rois: [{ name: "head58", p: [19.8, 9.2, 57.8], r: 50 }, { name: "mirror58", p: [19.8, 9.2, 57.8], r: 60, mirror: true }, { name: "horizon", p: [12, 0, 62], r: 120 }, { name: "kerbL", p: [-12, 0.15, 60], r: 140 }, { name: "farPool", p: [13, 0.1, 40], r: 90 }, { name: "windows", p: [5, 7, 22], r: 110 }] },
  // The lamp path's first pose, held: the renderer's own noise floor with the camera still.
  still: { frames: 90, pose: () => ({ x: 1, z: 138, yaw: 0.05, pitch: -0.02 }), rois: [{ name: "boothHead", p: [4.5, 6.4, 129.6], r: 60 }] },
  // Across the lot facing the facility, between the two far heads.
  strafe: { frames: 150, pose: (t) => ({ x: -8 + WALK * t, z: 90, yaw: 0, pitch: 0.03 }) },
  // Looking around from the lot's centre, at a mouse-turn pace.
  turn: matchedPaths.turn!,
  // Close to the facility: lit windows, the far sodium head and wet asphalt at grazing angles.
  facility: { frames: 150, pose: (t) => ({ x: -4 + 0.4 * t, z: 72 - WALK * t, yaw: 0.25 * Math.sin(t * 0.9), pitch: 0.05 }) },
}

/** In-page setting changes: each runs on a fresh copy of the shipped settings. */
const VARIANTS: Record<string, string> = {
  all: "",
  "taa-off": "lot.renderer.setTemporal({ ...lot.renderer.getTemporal(), mode: 'msaa' })",
  "ssr-off": "lot.ssr.settings.mode = 'today'",
  "wet-off": "lot.settings.wetness = 0",
  "glint-off": "lot.fog.settings.glint = 0",
  "fogrefl-off": "lot.fog.settings.reflection = 0",
  "foghist-off": "lot.fog.settings.history = 1",
  "bank-off": "lot.fog.settings.bank = 'today'",
  "blur-off": "lot.fog.settings.blur = 'today'",
  "clouds-off": "lot.fog.settings.clouds = 'today'",
  "scatter-off": "lot.fog.settings.strength = 0; lot.settings.haze = 0",
  "spots-off": "lot.spots.settings.count = 0",
  "contact-off": "lot.contact.mode = 'today'",
  "rooms-off": "lot.rooms.mode = 'today'; lot.glass.mode = 'today'",
  "forest-today": "Object.assign(lot.forest, lot.forestPresets.today, { look: 'today' })",
  // Depth precision probe: a farther near plane gives the distant facade ~3× the depth resolution.
  "near-0.5": "lot.camera.near = 0.5",
  // Today's depth (no glow decal offset), alone and with the probes that attribute the far window flashing.
  "decal-0": "lot.settings.decalDepth = 0",
  "decal-0-near": "lot.settings.decalDepth = 0; lot.camera.near = 0.5",
  "decal-0-taa-off": "lot.settings.decalDepth = 0; lot.renderer.setTemporal({ ...lot.renderer.getTemporal(), mode: 'msaa' })",
  "decal-0-rooms-off": "lot.settings.decalDepth = 0; lot.rooms.mode = 'today'; lot.glass.mode = 'today'",
  "ssr-move-0.3": "lot.ssr.settings.historyMoving = 0.3",
  "ssr-move-0.2": "lot.ssr.settings.historyMoving = 0.2",
  "fog-move-0.3": "lot.fog.settings.historyMoving = 0.3",
  "move-0.3": "lot.ssr.settings.historyMoving = 0.3; lot.fog.settings.historyMoving = 0.3",
  // Today: main before AR-118 (no glow decal offset, volume histories dropped in motion, spot shadows by time only).
  today: "lot.ssr.settings.historyMoving = 1; lot.fog.settings.historyMoving = 1; lot.settings.decalDepth = 0; lot.contact.historyMoving = 1; lot.rooms.mullions = 'today'",
  // Main before this round (#371): contact history dropped in motion, smoothstep mullions.
  main: "lot.contact.historyMoving = 1; lot.rooms.mullions = 'today'",
  "move-today": "lot.ssr.settings.historyMoving = 1; lot.fog.settings.historyMoving = 1",
  "contact-move": "lot.contact.historyMoving = 0.25",
  "contact-move-fog8": "lot.contact.historyMoving = 0.25; lot.fog.settings.samples = 8",
  "contact-move-fogfull": "lot.contact.historyMoving = 0.25; lot.fog.settings.halfRes = false",
  "contact-move-fogmove": "lot.contact.historyMoving = 0.25; lot.fog.settings.historyMoving = 0.3",
  "cm-wet-off": "lot.contact.historyMoving = 0.25; lot.settings.wetness = 0",
  "cm-sharpen-0": "lot.contact.historyMoving = 0.25; lot.renderer.setTemporal({ ...lot.renderer.getTemporal(), sharpen: 0 })",
  "cm-bloom-0": "lot.contact.historyMoving = 0.25; lot.renderer.setBloomLevels(1)",
  "cm-blur-off": "lot.contact.historyMoving = 0.25; lot.fog.settings.blur = 'today'",
  "cm-ssr-off": "lot.contact.historyMoving = 0.25; lot.ssr.settings.mode = 'today'",
  "cm-taa-off": "lot.contact.historyMoving = 0.25; lot.renderer.setTemporal({ ...lot.renderer.getTemporal(), mode: 'msaa' })",
  "cm-specaa-2": "lot.contact.historyMoving = 0.25; lot.settings.specularAA = 2",
  "rooms-only": "lot.glass.mode = 'today'",
  "puddles-0": "lot.wet.puddles = 0",
  "ripple-0": "lot.wet.ripple = 0",
  "bloom-0": "lot.renderer.setBloomLevels(1)",
  "glass-today": "lot.glass.mode = 'today'",
  "lamp-0": "lot.settings.lamp = 0",
  "haze-0": "lot.settings.haze = 0",
  "specaa-2": "lot.settings.specularAA = 2",
  "sharpen-0": "lot.renderer.setTemporal({ ...lot.renderer.getTemporal(), sharpen: 0 })",
  "taa-hist-0.95": "lot.renderer.setTemporal({ ...lot.renderer.getTemporal(), history: 0.95 })",
  "dressing-off": "Object.assign(lot.dressing, { look: 'today', weeds: 0, leaves: 0, gravel: 0, litter: 0 })",
  // Weather (run weather-today first: it starts loading the weather chunk, which the harness's 300 ms pause covers).
  "weather-today": "lot.setWeather('today'); void lot.loadStorm(); for (let i = 0; i < 900; i++) lot.step(1000 / 60)",
  "weather-rain": "lot.setWeather('rain'); lot.weather.strikes = 0; for (let i = 0; i < 300; i++) lot.step(1000 / 60)",
  "weather-rain-noglass": "lot.setWeather('rain'); lot.weather.strikes = 0; lot.weather.glass = 0; for (let i = 0; i < 300; i++) lot.step(1000 / 60)",
  "weather-storm": "lot.setWeather('storm'); lot.weather.strikes = 0; for (let i = 0; i < 300; i++) lot.step(1000 / 60)",
}
const pathNames = (process.env.MOTION_PATHS ?? Object.keys(PATHS).join(",")).split(",").filter(Boolean)
const variantNames = (process.env.MOTION_VARIANTS ?? Object.keys(VARIANTS).join(",")).split(",").filter(Boolean)
const record = new Set((process.env.MOTION_RECORD ?? "").split(",").filter(Boolean))
const limit = Number(process.env.MOTION_FRAMES ?? 0)
for (const v of variantNames) assert(v in VARIANTS || v.startsWith("eval:"), `unknown variant ${v}`)

const dist = process.env.MOTION_BASE ? resolve(process.env.MOTION_BASE) : `${root}/dist`
if (!process.env.MOTION_BASE) await build({ root, logLevel: "error" })
const server = serveDist(dist)
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache).filter((n) => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
assert(executablePath, "headless Chromium is missing")
const browser = await chromium.launch({ executablePath, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const errors: string[] = []
const report: Record<string, any> = { viewport, captured: new Date().toISOString(), runs: {}, errors }
try {
  const page = await browser.newPage({ viewport: { width: viewport[0], height: viewport[1] }, deviceScaleFactor: 1 })
  let activeRun = ""
  await page.exposeFunction("motionCheckpoint", (checkpoint: unknown) => {
    // Separate from motion.json: partial runs must never look like complete comparisons.
    const file = resolve(out, "motion-progress.json")
    writeFileSync(`${file}.tmp`, JSON.stringify({
      complete: false, run: activeRun, viewport, adapter: report.adapter,
      saved: new Date().toISOString(), errors, checkpoint,
    }, null, 1))
    renameSync(`${file}.tmp`, file)
  })
  // The canvas texture is copied back on the GPU after each frame (drawImage of a presented WebGPU canvas reads black).
  await page.addInitScript(() => {
    const request=GPUAdapter.prototype.requestDevice
    GPUAdapter.prototype.requestDevice=function(descriptor) {
      const {vendor,architecture,device,description}=this.info
      ;(window as any).__lotMotionAdapter={vendor,architecture,device,description}
      return request.call(this,descriptor)
    }
    const configure = GPUCanvasContext.prototype.configure
    GPUCanvasContext.prototype.configure = function (c: GPUCanvasConfiguration) {
      return configure.call(this, { ...c, usage: (c.usage ?? GPUTextureUsage.RENDER_ATTACHMENT) | GPUTextureUsage.COPY_SRC })
    }
  })
  await page.addInitScript(() => {
    const create = GPUDevice.prototype.createTexture
    GPUDevice.prototype.createTexture = function (d: GPUTextureDescriptor) {
      return create.call(this, d.label === "temporal previous depth" ? { ...d, usage: d.usage | GPUTextureUsage.COPY_SRC } : d)
    }
  })
  const pending=new Set<string>()
  let failBoot:((error:Error)=>void)|undefined
  const fatal=new Promise<never>((_,reject)=>{failBoot=reject})
  void fatal.catch(()=>{})
  const fail=(message:string)=>{errors.push(message);console.error(message);failBoot?.(new Error(message))}
  page.on("pageerror",e=>fail(e.message))
  page.on("request",r=>pending.add(r.url()))
  page.on("requestfinished",r=>pending.delete(r.url()))
  page.on("requestfailed",r=>{pending.delete(r.url());fail(`${r.url()}: ${r.failure()?.errorText}`)})
  page.on("console",m=>{if(m.type()==="error")fail(m.text());else if(m.text().startsWith("Motion progress"))console.log(m.text())})
  const load = async () => {
    await page.goto(`http://127.0.0.1:${server.port}/arcade/lot/?time=8`, { timeout: 240_000 })
    try {
      await Promise.race([fatal,page.waitForFunction(() => (window as any).lot?.ready && (window as any).lot.frames > 8, undefined, { timeout: 600_000, polling:100 })])
    } catch(error) {
      report.bootFailure={message:String(error),pending:[...pending],state:await Promise.race([
        page.evaluate(()=>({hud:document.getElementById("hud")?.textContent,lot:(window as any).lot?{frames:(window as any).lot.frames,timings:(window as any).lot.timings}:null,marks:performance.getEntriesByType("mark").map(e=>({name:e.name,start:e.startTime}))})).catch(e=>({error:String(e)})),
        new Promise(resolve=>setTimeout(()=>resolve({error:"Page unresponsive to boot diagnostics for 5 s"}),5000)),
      ])}
      console.error("Motion boot failure",JSON.stringify(report.bootFailure))
      throw error
    }
    await page.addStyleTag({ content: "#hud,#credits,[data-lab-panel]{display:none!important}" })
    await page.evaluate(async queryCode => {
      const lot = (window as any).lot
      lot.paused = true
      if(!lot.surfaceQuery){
        const root="/arcade/lot/ashwood/",scene=await (await fetch(root+"scene.json")).json()
        const surfaces=await Promise.all(Object.keys(scene.surfaces).map(async name=>({name,vertices:await Promise.all((scene.files[`surface-${name}`]??[]).map(async (file:string)=>{
          const data=await (await fetch(root+file)).arrayBuffer(),bytes=new Uint8Array(data)
          return bytes[0]===31&&bytes[1]===139?await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer():data
        }))})))
        lot.surfaceQuery=new (new Function(`return (${queryCode})`)())(surfaces)
      }
      lot.defaults = JSON.stringify({ settings: lot.settings, wet: lot.wet, fog: lot.fog.settings, ssr: lot.ssr.settings, spots: lot.spots.settings, contact: lot.contact, glass: lot.glass, rooms: lot.rooms, forest: lot.forest, dressing: lot.dressing, temporal: lot.renderer.getTemporal() })
    },SurfaceQuery.toString())
  }
  await load()
  report.adapter=await page.evaluate(()=>(window as any).__lotMotionAdapter)
  console.log("MOTION adapter",JSON.stringify(report.adapter))
  assert(report.adapter && !/swiftshader/i.test(JSON.stringify(report.adapter)),"motion requires the worker's hardware GPU")
  assert.deepEqual(errors, [], "motion boot: browser errors invalidate measurements")
  for (const path of pathNames) {
    const p = PATHS[path]!
    const poses = Array.from({ length: limit || p.frames }, (_, i) => p.pose(i / 60))
    const warm = p.pose(0)
    for (const variant of variantNames) {
      assert.deepEqual(errors, [], "motion: browser errors invalidate measurements")
      console.log(`Starting ${path}/${variant}`)
      activeRun = `${path}/${variant}`
      const code = variant.startsWith("eval:") ? variant.slice(5) : VARIANTS[variant]!
      const rec = record.has(variant)
      const result = await Promise.race([fatal,page.evaluate(async ({ code, poses, warm, rec, size, rois }) => {
        const lot = (window as any).lot
        const d = JSON.parse(lot.defaults)
        Object.assign(lot.settings, d.settings); Object.assign(lot.fog.settings, d.fog); Object.assign(lot.ssr.settings, d.ssr)
        Object.assign(lot.wet, d.wet)
        Object.assign(lot.spots.settings, d.spots); Object.assign(lot.contact, d.contact); Object.assign(lot.glass, d.glass)
        Object.assign(lot.rooms, d.rooms); Object.assign(lot.forest, d.forest); Object.assign(lot.dressing, d.dressing)
        lot.renderer.setTemporal(d.temporal); lot.camera.near = 0.15
        new Function("lot", code)(lot)
        const device: GPUDevice = lot.renderer.passContext.device
        const cam = lot.camera
        const put = (q: { x: number; z: number; yaw: number; pitch: number }) => { cam.body.x = q.x; cam.body.y = q.z; cam.body.vx = cam.body.vy = 0; cam.yaw = q.yaw; cam.pitch = q.pitch }
        // Dressing rebuilds 150 ms after a change; spot slots snap on a jump; the histories settle at the start pose.
        put({ ...warm, z: warm.z + 50 }); lot.step(1000 / 60)
        await new Promise((r) => setTimeout(r, 300))
        put(warm)
        lot.renderer.resetTemporalHistory()
        for (let i = 0; i < 40; i++) lot.step(1000 / 60)
        await device.queue.onSubmittedWorkDone()
        const canvas: HTMLCanvasElement = document.querySelector("#view")!
        const [W, H] = [canvas.width, canvas.height]
        const c2 = new OffscreenCanvas(W, H), g = c2.getContext("2d", { willReadFrequently: true })!
        const N = W * H
        const ctx = canvas.getContext("webgpu") as GPUCanvasContext
        const row = Math.ceil((W * 4) / 256) * 256
        const readBuf = device.createBuffer({ size: row * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
        const image = g.createImageData(W, H)
        const grab = async () => {
          const tex = ctx.getCurrentTexture()
          const enc = device.createCommandEncoder()
          enc.copyTextureToBuffer({ texture: tex }, { buffer: readBuf, bytesPerRow: row }, [W, H])
          device.queue.submit([enc.finish()])
          await readBuf.mapAsync(GPUMapMode.READ)
          const src = new Uint8Array(readBuf.getMappedRange())
          const bgra = tex.format.startsWith("bgra")
          const d = image.data
          for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const s = y * row + x * 4, o = (y * W + x) * 4
            d[o] = src[s + (bgra ? 2 : 0)]!; d[o + 1] = src[s + 1]!; d[o + 2] = src[s + (bgra ? 0 : 2)]!; d[o + 3] = 255
          }
          readBuf.unmap()
          return d
        }
        // Linear depth (clip w) of each frame, from the temporal resolve's own copy, for the reprojection.
        const lin: GPUTexture | undefined = lot.renderer.temporal?.prevLin
        const drow = Math.ceil((W * 4) / 256) * 256
        const depthBuf = lin ? device.createBuffer({ size: drow * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }) : null
        const grabDepth = async (out: Float32Array) => {
          if (!lin || !depthBuf || lin.width !== W) return false
          const enc = device.createCommandEncoder()
          enc.copyTextureToBuffer({ texture: lin }, { buffer: depthBuf, bytesPerRow: drow }, [W, H])
          device.queue.submit([enc.finish()])
          await depthBuf.mapAsync(GPUMapMode.READ)
          const src = new Float32Array(depthBuf.getMappedRange())
          for (let y = 0; y < H; y++) out.set(src.subarray((y * drow) / 4, (y * drow) / 4 + W), y * W)
          depthBuf.unmap()
          return true
        }
        const L = [new Float32Array(N), new Float32Array(N)]
        const D = [new Float32Array(N), new Float32Array(N)]
        const VP: Float32Array[] = [new Float32Array(16), new Float32Array(16)]
        const heat = new Float32Array(N)
        const popMap = new Uint16Array(N)
        const BS = 32, bw = Math.ceil(W / BS), bh = Math.ceil(H / BS)
        const block = new Float64Array(bw * bh), blockN = new Uint32Array(bw * bh)
        const frames: any[] = []
        const regions: Record<string,number> = {}
        const worldPops: Record<string,number> = {}
        const jpegs: string[] = []
        const overlays: string[] = []
        const overlayCanvas=new OffscreenCanvas(W,H),og=overlayCanvas.getContext("2d")!
        const overlay=g.createImageData(W,H)
        const timings={readbackMs:0,metricMs:0,encodeMs:0}
        const inv = (m: Float32Array) => {
          const o = new Float64Array(16)
          const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = Array.from(m)
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
        for (let f = 0; f < poses.length; f++) {
          const frameStart=performance.now()
          put(poses[f]!)
          lot.step(1000 / 60)
          const px = await grab()
          if(rec)overlay.data.set(px)
          const k = f % 2, cur = L[k]!, prev = L[1 - k]!, dcur = D[k]!, dprev = D[1 - k]!
          VP[k]!.set(lot.input.frame.subarray(0, 16))
          const eye = Array.from(lot.input.frame.subarray(16, 19)) as number[]
          for (let i = 0, j = 0; i < N; i++, j += 4) cur[i] = 0.2126 * px[j]! + 0.7152 * px[j + 1]! + 0.0722 * px[j + 2]!
          const hasDepth = await grabDepth(dcur)
          timings.readbackMs+=performance.now()-frameStart
          const encodeStart=performance.now()
          if (rec) {
            g.putImageData(image, 0, 0)
            const blob = await c2.convertToBlob({ type: "image/jpeg", quality: 0.9 })
            const b = new Uint8Array(await blob.arrayBuffer())
            let s = ""
            for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000))
            jpegs.push(btoa(s))
          }
          timings.encodeMs+=performance.now()-encodeStart
          if (f === 0) continue
          const metricStart=performance.now()
          // Reproject: each pixel's world point (from its clip w) into last frame; compare with last frame's 3×3
          // neighbourhood range there, so sub-pixel resampling of a still scene scores zero and only appearance changes
          // (flashes, glitter, popping, smear) count. Disoccluded or off-screen pixels are skipped.
          const iv = inv(VP[k]!), pv = VP[1 - k]!
          const roiC = rois.map((r) => {
            const c = VP[k]!
            let x = r.p[0]!, y = r.p[1]!, z = r.p[2]!
            if (r.mirror) { const t = eye[1]! / (eye[1]! + y); x = eye[0]! + (x - eye[0]!) * t; z = eye[2]! + (z - eye[2]!) * t; y = 0 }
            const cw = c[3]! * x + c[7]! * y + c[11]! * z + c[15]!
            return { ...r, r: r.r * H / 1080, sx: ((c[0]! * x + c[4]! * y + c[8]! * z + c[12]!) / cw * 0.5 + 0.5) * W, sy: (0.5 - (c[1]! * x + c[5]! * y + c[9]! * z + c[13]!) / cw * 0.5) * H, ok: cw > 0, sum: 0, n: 0, pops: 0 }
          })
          const anchored: Record<string, [number, number]> = {}
          for (const r of roiC) {
            if (!r.anchored || !r.ok) continue
            const x = r.p[0]!, y = r.p[1]!, z = r.p[2]!, pw = pv[3]! * x + pv[7]! * y + pv[11]! * z + pv[15]!
            if (pw <= 0) continue
            const dx = r.sx - (((pv[0]! * x + pv[4]! * y + pv[8]! * z + pv[12]!) / pw) * 0.5 + 0.5) * W
            const dy = r.sy - ((0.5 - ((pv[1]! * x + pv[5]! * y + pv[9]! * z + pv[13]!) / pw) * 0.5)) * H
            let sum = 0, n = 0, pp = 0
            for (let py = Math.max(1, Math.floor(r.sy - r.r)); py < Math.min(H - 2, r.sy + r.r); py++) for (let px = Math.max(1, Math.floor(r.sx - r.r)); px < Math.min(W - 2, r.sx + r.r); px++) {
              const qx = px - dx, qy = py - dy
              if (qx < 0 || qy < 0 || qx >= W - 1 || qy >= H - 1) continue
              const fx = Math.floor(qx), fy = Math.floor(qy), a = fy * W + fx
              const lo = Math.min(prev[a]!, prev[a + 1]!, prev[a + W]!, prev[a + W + 1]!), hi = Math.max(prev[a]!, prev[a + 1]!, prev[a + W]!, prev[a + W + 1]!)
              const v = cur[py * W + px]!, diff = v > hi ? v - hi : v < lo ? lo - v : 0
              sum += diff; n++; if (diff >= 12) pp++
            }
            anchored[r.name + "@"] = [n ? sum / n : 0, pp]
          }
          const grid = new Float64Array(9), pops = new Uint32Array(9), cnt = new Uint32Array(9)
          block.fill(0); blockN.fill(0)
          let valid = 0
          const e0 = eye[0]!, e1 = eye[1]!, e2 = eye[2]!, c3 = VP[k]![3]!, c7 = VP[k]![7]!, c11 = VP[k]![11]!
          const roiOn = roiC.filter((r) => r.ok)
          for (let y = 0; y < H; y++) {
            const ny = 1 - ((y + 0.5) / H) * 2, gy = Math.min(2, Math.floor((y * 3) / H))
            for (let x = 0; x < W; x++) {
              const i = y * W + x
              const nx = ((x + 0.5) / W) * 2 - 1
              // World point: unproject at two depths for the ray, then walk to the stored clip w.
              const hx = iv[0]! * nx + iv[4]! * ny + iv[8]! * 0.5 + iv[12]!, hy = iv[1]! * nx + iv[5]! * ny + iv[9]! * 0.5 + iv[13]!
              const hz = iv[2]! * nx + iv[6]! * ny + iv[10]! * 0.5 + iv[14]!, hw = iv[3]! * nx + iv[7]! * ny + iv[11]! * 0.5 + iv[15]!
              let rx = hx / hw - e0, ry = hy / hw - e1, rz = hz / hw - e2
              const rl = 1 / Math.sqrt(rx * rx + ry * ry + rz * rz); rx *= rl; ry *= rl; rz *= rl
              const wr = c3 * rx + c7 * ry + c11 * rz
              let w = hasDepth ? dcur[i]! : 0
              if (!(w > 0) || w > 1e5) w = 3000 * wr
              const t = w / Math.max(wr, 1e-6)
              const wx = e0 + rx * t, wy = e1 + ry * t, wz = e2 + rz * t
              const pw = pv[3]! * wx + pv[7]! * wy + pv[11]! * wz + pv[15]!
              if (pw <= 0) continue
              const qx = ((pv[0]! * wx + pv[4]! * wy + pv[8]! * wz + pv[12]!) / pw * 0.5 + 0.5) * W - 0.5
              const qy = (0.5 - (pv[1]! * wx + pv[5]! * wy + pv[9]! * wz + pv[13]!) / pw * 0.5) * H - 0.5
              const cx = Math.round(qx), cy = Math.round(qy)
              if (cx < 1 || cy < 1 || cx >= W - 1 || cy >= H - 1) continue
              const pd = dprev[cy * W + cx]!
              if (hasDepth && pd > 0 && pd < 1e5 && w < 2000 && Math.abs(pd - pw) > 0.03 * pw + 0.05) continue
              // The four texels the reprojected point falls between bound what a still, resolved scene can show there.
              const fx = Math.floor(qx), fy = Math.floor(qy), a = fy * W + fx
              const t00 = prev[a]!, t10 = prev[a + 1]!, t01 = prev[a + W]!, t11 = prev[a + W + 1]!
              const lo = Math.min(t00, t10, t01, t11), hi = Math.max(t00, t10, t01, t11)
              const v = cur[i]!
              const diff = v > hi ? v - hi : v < lo ? lo - v : 0
              const gi = gy * 3 + Math.min(2, Math.floor((x * 3) / W))
              grid[gi]! += diff; cnt[gi]!++; heat[i]! += diff; valid++
              if (diff >= 12) {
                pops[gi]!++; popMap[i]!++
                const region=lot.surfaceQuery?.region(wx,wy,wz) ?? (wy<1?"ground":"above ground")
                regions[region]=(regions[region]??0)+1
                const cell=`${region}:${Math.round(wx)},${Math.round(wy)},${Math.round(wz)}`
                worldPops[cell]=(worldPops[cell]??0)+1
                if(rec){overlay.data[i*4]=255;overlay.data[i*4+1]=32;overlay.data[i*4+2]=0}
              }
              const bi = Math.floor(x / BS) + Math.floor(y / BS) * bw
              block[bi]! += v > hi ? v - hi : v < lo ? v - lo : 0; blockN[bi]!++
              for (let ri = 0; ri < roiOn.length; ri++) { const r = roiOn[ri]!; if (Math.abs(x - r.sx) < r.r && Math.abs(y - r.sy) < r.r) { r.sum += diff; r.n++; if (diff >= 12) r.pops++ } }
            }
          }
          // Flash: a 32 px block whose mean signed change, after reprojection, is over 3 (an area brightening or dimming).
          let flash = 0, flashMax = 0
          for (let i = 0; i < block.length; i++) if (blockN[i]! > BS * BS * 0.5) {
            const m = Math.abs(block[i]! / blockN[i]!)
            if (m > 3) flash++
            flashMax = Math.max(flashMax, m)
          }
          frames.push({ grid: Array.from(grid, (v, i) => (cnt[i] ? v / cnt[i]! : 0)), fire: Array.from(pops), flash, flashMax, valid: valid / N,
            roi: { ...Object.fromEntries(roiC.map((r) => [r.name, [r.n ? r.sum / r.n : 0, r.pops]])), ...anchored } })
          timings.metricMs+=performance.now()-metricStart
          const overlayStart=performance.now()
          if(rec){
            og.putImageData(overlay,0,0)
            const b=new Uint8Array(await (await overlayCanvas.convertToBlob({type:"image/jpeg",quality:.92})).arrayBuffer())
            let s="";for(let i=0;i<b.length;i+=0x8000)s+=String.fromCharCode(...b.subarray(i,i+0x8000))
            overlays.push(btoa(s))
          }
          timings.encodeMs+=performance.now()-overlayStart
          if (f % 30 === 0 || f === poses.length - 1) {
            await (window as any).motionCheckpoint({
              capturedFrames: f + 1, expectedFrames: poses.length,
              comparisons: frames.length, lastPose: poses[f], frames,
              regionPopTotals: regions, timings,
            })
            console.log("Motion progress", f, "/", poses.length, JSON.stringify(timings))
          }
        }
        depthBuf?.destroy()
        readBuf.destroy()
        // Heat map: summed second difference per pixel, scaled to the 99.9th percentile.
        const sorted = heat.slice().sort()
        const top = Math.max(1, sorted[Math.floor(N * 0.999)]!)
        const img = g.createImageData(W, H)
        for (let i = 0; i < N; i++) {
          const v = Math.min(1, heat[i]! / top)
          img.data[i * 4] = 255 * Math.min(1, v * 2); img.data[i * 4 + 1] = 255 * Math.max(0, v * 2 - 1); img.data[i * 4 + 2] = 40 * (1 - v); img.data[i * 4 + 3] = 255
        }
        g.putImageData(img, 0, 0)
        // Pop map: frames each pixel popped (white = every 10th frame or more).
        const pimg = g.createImageData(W, H)
        const pn = Math.max(1, poses.length / 10)
        for (let i = 0; i < N; i++) { const v = Math.min(255, (popMap[i]! / pn) * 255); pimg.data[i * 4] = v; pimg.data[i * 4 + 1] = v; pimg.data[i * 4 + 2] = v; pimg.data[i * 4 + 3] = 255 }
        const pc = new OffscreenCanvas(W, H); pc.getContext("2d")!.putImageData(pimg, 0, 0)
        const pb = new Uint8Array(await (await pc.convertToBlob({ type: "image/png" })).arrayBuffer())
        let ps = ""
        for (let i = 0; i < pb.length; i += 0x8000) ps += String.fromCharCode(...pb.subarray(i, i + 0x8000))
        const hb = new Uint8Array(await (await c2.convertToBlob({ type: "image/png" })).arrayBuffer())
        let hs = ""
        for (let i = 0; i < hb.length; i += 0x8000) hs += String.fromCharCode(...hb.subarray(i, i + 0x8000))
        return { frames, jpegs, overlays, timings, worldPops:Object.entries(worldPops).sort((a,b)=>b[1]-a[1]).slice(0,80), regions:Object.fromEntries(Object.entries(regions).map(([k,v])=>[k,v/(poses.length-1)])), heat: btoa(hs), pops: btoa(ps), size: [W, H] }
      }, { code, poses, warm, rec, size: viewport, rois: p.rois ?? [] })])
      if (errors.length) throw new Error(errors.join("\n"))
      const fr = result.frames as { grid: number[]; fire: number[]; flash: number; flashMax: number; valid: number; roi: Record<string, [number, number]> }[]
      const mean = (f: (x: (typeof fr)[0]) => number) => fr.reduce((s, x) => s + f(x), 0) / fr.length
      const grid = Array.from({ length: 9 }, (_, i) => mean((x) => x.grid[i]!))
      const summary = {
        timings:result.timings,
        gpuMs:await page.evaluate(()=>(window as any).lot.measureFrames(12,3)),
        regions:result.regions,
        worldPops:result.worldPops,
        flicker: grid.reduce((a, b) => a + b, 0) / 9,
        grid: grid.map((v) => +v.toFixed(3)),
        fireflies: mean((x) => x.fire.reduce((a, b) => a + b, 0)),
        fireGrid: Array.from({ length: 9 }, (_, i) => +mean((x) => x.fire[i]!).toFixed(1)),
        flashFrames: fr.filter((x) => x.flash > 0).length,
        flashBlocks: mean((x) => x.flash),
        flashMax: Math.max(...fr.map((x) => x.flashMax)),
        valid: mean((x) => x.valid),
        roi: Object.fromEntries(Object.keys(fr.find((x) => Object.keys(x.roi).length)?.roi ?? {}).map((n) => [n, { flicker: +mean((x) => x.roi[n]?.[0] ?? 0).toFixed(3), pops: +mean((x) => x.roi[n]?.[1] ?? 0).toFixed(2), popFrames: fr.filter((x) => (x.roi[n]?.[1] ?? 0) > 0).length }])),
        perFrame: fr.map((x) => [+(x.grid.reduce((a, b) => a + b, 0) / 9).toFixed(3), x.fire.reduce((a, b) => a + b, 0), x.flash, +x.flashMax.toFixed(2)]),
      }
      report.runs[`${path}/${variant}`] = summary
      writeFileSync(resolve(out, `${path}-${variant}-heat.png`), Buffer.from(result.heat, "base64"))
      writeFileSync(resolve(out, `${path}-${variant}-pops.png`), Buffer.from(result.pops, "base64"))
      if (rec) {
        const dir = resolve(out, "frames", `${path}-${variant}`)
        mkdirSync(dir, { recursive: true })
        result.jpegs.forEach((b: string, i: number) => writeFileSync(resolve(dir, `${String(i + 1).padStart(4, "0")}.jpg`), Buffer.from(b, "base64")))
        const overlayDir=resolve(out,"overlays",`${path}-${variant}`);mkdirSync(overlayDir,{recursive:true})
        result.overlays.forEach((b:string,i:number)=>writeFileSync(resolve(overlayDir,`${String(i+1).padStart(4,"0")}.jpg`),Buffer.from(b,"base64")))
      }
      console.log(`${path.padEnd(9)} ${variant.padEnd(14)} flicker ${summary.flicker.toFixed(3)}  pops ${summary.fireflies.toFixed(1)}  flash frames ${summary.flashFrames} (max ${summary.flashMax.toFixed(1)})  grid ${summary.grid.join(" ")}  valid ${summary.valid.toFixed(2)}  ${Object.entries(summary.roi).map(([n, r]) => `${n} ${r.flicker}/${r.pops}/${r.popFrames}f`).join("  ")}`)
      writeFileSync(resolve(out, "motion.json"), JSON.stringify(report, null, 1))
    }
  }
  report.errors = errors
} finally {
  writeFileSync(resolve(out, "motion.json"), JSON.stringify(report, null, 1))
  await browser.close()
  server.stop(true)
}
