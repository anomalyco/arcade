// Weather-cycle showcase video, rendered frame by frame on a real GPU. Runs ON hailmary (Mac Studio, Metal) from a
// snapshot copy of games/carrier with a production build in dist/ (other agents edit the live tree):
//
//   rsync/tar games/carrier + packages/kit to ~/.cache/carrier-video/arcade, then in games/carrier there:
//   bun install && bun scripts/build-id.ts && bun --bun ./node_modules/.bin/vite build
//   bun scripts/video-weather.ts --out=~/.cache/carrier-video/out
//
// How: serves dist/ on localhost, opens `?seed=7` (offline: the weather is driven locally), replaces the page's clock
// and requestAnimationFrame with a virtual one (an init script), then for every video frame sets the weather
// (weather.manual), forces lightning strikes, places the camera relative to the carrier (game.update is wrapped), steps
// exactly 1/60 s, copies the swapchain texture through the game's own device and pipes the raw BGRA into ffmpeg.
// Nothing in the game's source changes. A title card ("CARRIER", the menu's thin tracked type) is overlaid by ffmpeg.
//
// Options: --out=DIR  --fps=60  --size=1920x1080  --seed=7  --tod=H (freeze the clock hour; default the room's)
//          --stills=T1,T2,...  (PNG stills at those video seconds instead of the video, for previews)
//          --from=S --to=S (render only part of the timeline)  --kbps=12500 (delivery bitrate)  --warm=24 (warm-up s)
//          --encode=1 (title and delivery encode only, from an existing master)  --tele=1 (ship and jet telemetry)
//          --heading=deg (carrier heading; default into the primary swell)
import { mkdirSync, writeFileSync, existsSync, rmSync, readdirSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { spawn } from "node:child_process"
import { browserBudget } from "../../../scripts/browser-budget"
import { WEATHER_PRESETS, mixWeather, makeWeather, type Weather } from "../shared/weather"

await using budget = browserBudget()
const { chromium } = budget

const args = process.argv.slice(2)
const opt = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
const root = resolve(import.meta.dir, "..")
const out = resolve(opt("out", join(root, "video-out")).replace(/^~/, process.env.HOME ?? "~"))
const fps = Number(opt("fps", "60"))
const [vw, vh] = opt("size", "1920x1080").split("x").map(Number) as [number, number]
const seed = opt("seed", "7")
const tod = opt("tod", "")
const stills = opt("stills", "")
  .split(",")
  .filter(Boolean)
  .map(Number)
const warm = Number(opt("warm", "24"))
const DURATION = 30
const from = Number(opt("from", "0"))
const to = Number(opt("to", String(DURATION)))
const ffmpeg = existsSync("/opt/homebrew/bin/ffmpeg") ? "/opt/homebrew/bin/ffmpeg" : "ffmpeg"
mkdirSync(out, { recursive: true })

// ---------------------------------------------------------------------------------------------------------------
// The story: weather per video second (each parameter group on its own curve, so the sky leads and the sea lags)
// ---------------------------------------------------------------------------------------------------------------

const ease = (u: number) => {
  const x = Math.max(0, Math.min(1, u))
  return x * x * (3 - 2 * x)
}
const ramp = (t: number, a: number, b: number) => ease((t - a) / (b - a))
const lerp = (a: number, b: number, u: number) => a + (b - a) * u

const { clear, light, medium, heavy } = WEATHER_PRESETS
/** Storm intensity 0..3 (clear, light, medium, heavy) for the sky and rain, and for the sea. */
function storm(t: number): { sky: number; sea: number } {
  // Build: clouds from 4.5 s, light rain by 9, medium by 13.5, full storm by 17.5. Clear: the deck breaks from 25 s,
  // the sun is out by 28; the sea lags the sky both ways (the swell outlives the storm).
  const sky = ramp(t, 4.5, 9) + ramp(t, 9.5, 13.5) + ramp(t, 14, 17.5) - 3 * ramp(t, 24.6, 28.2)
  const sea = ramp(t, 6, 10.5) + ramp(t, 10.5, 14.5) + ramp(t, 14.5, 18) - 2.2 * ramp(t, 25.2, 30)
  return { sky, sea }
}
const KINDS = [clear, light, medium, heavy]
function presetAt(x: number, outW: Weather): Weather {
  const i = Math.max(0, Math.min(2, Math.floor(x)))
  return mixWeather(KINDS[i]!, KINDS[i + 1]!, Math.max(0, Math.min(1, x - i)), outW)
}
const SEA_KEYS = ["sea", "swell", "foam"] as const
function weatherAt(t: number): Weather {
  const s = storm(t)
  const w = presetAt(s.sky, makeWeather())
  const sw = presetAt(s.sea, makeWeather())
  for (const k of SEA_KEYS) w[k] = sw[k]
  // Wind tears the foam with the sea, not the sky.
  w.wind = Math.max(w.wind * 0.6 + sw.wind * 0.4, sw.wind)
  // Lightning comes from scripted strikes only.
  w.lightning = 0
  return w
}

/** Scripted lightning: video second, power, bearing offset from the camera's view (deg), distance (m). */
const STRIKES: [t: number, power: number, off: number, dist: number][] = [
  [17.4, 0.5, -25, 5200],
  [18.6, 1, 12, 2600],
  [20.4, 0.75, -18, 3400],
  [22.25, 0.9, 14, 2600],
  [23.75, 1, -4, 2400],
]

/** Ship operations at video seconds: the Hornet launch (line-up, spool and stroke take ~4.5 s to the bow). */
const OPS: [t: number, op: string][] = [[Number(opt("launch", "18.1")), "hornet"]]

// ---------------------------------------------------------------------------------------------------------------
// Camera: shots relative to the carrier (az 0 = ahead of the bow, 90 = starboard beam, 180 = astern)
// ---------------------------------------------------------------------------------------------------------------

type CamKey = {
  az: number
  el: number
  dist: number
  /** Look point in ship axes: metres ahead of midships, height above mean sea level (absolute), metres to starboard. */
  focus?: [fwd: number, up: number, stbd: number]
  fov?: number
  /** Minimum eye clearance above the water under it (m). */
  clear?: number
  /** 0..1: how far the look point moves from the ship focus to the jet. */
  jet?: number
  /** Eye placed directly in ship axes (fwd, absolute height, stbd) instead of az/el/dist around the focus. */
  eye?: [fwd: number, up: number, stbd: number]
  /** Look direction lag (s): an operator following the subject. */
  lag?: number
}
type Shot = { at: number; end: number; a: CamKey; b: CamKey }

const SHOTS: Shot[] = [
  // Sunny: low off the port quarter, looking up the glitter path past the carrier to the volcano.
  { at: 0, end: 6.2, a: { az: -172, el: 2.2, dist: 620, focus: [80, 14, 0], fov: 40 }, b: { az: -142, el: 3, dist: 490, focus: [40, 14, 0], fov: 40 } },
  // Clouds build: high chase, orbiting from the starboard quarter toward the beam.
  { at: 6.2, end: 12.0, a: { az: 150, el: 15, dist: 760, focus: [60, 10, 0], fov: 44 }, b: { az: 120, el: 10.5, dist: 630, focus: [40, 10, 0], fov: 44 } },
  // Medium: low off the starboard bow, the carrier shouldering into the rising sea as the rain sets in.
  { at: 12.0, end: 16.8, a: { az: 34, el: 2.6, dist: 460, focus: [40, 12, 0], fov: 34, clear: 5 }, b: { az: 60, el: 3, dist: 380, focus: [0, 12, 0], fov: 34, clear: 5 } },
  // Heavy: low off the port bow, the bow plunging into a trough and rearing up, a Hornet spooling on the catapult.
  { at: 16.8, end: 21.0, a: { az: -22, el: 1.6, dist: 560, focus: [60, 16, 0], fov: 36, clear: 6 }, b: { az: -34, el: 2.1, dist: 490, focus: [50, 16, 0], fov: 37, clear: 6 } },
  // Launch: off the port bow above the deck, the jet runs down the rearing deck, leaves the bow and climbs past.
  { at: 21.0, end: 24.4, a: { az: 0, el: 0, dist: 0, eye: [248, 76, -60], focus: [60, 28, 0], jet: 1, lag: 0.12, fov: 50, clear: 8 }, b: { az: 0, el: 0, dist: 0, eye: [262, 82, -66], focus: [60, 28, 0], jet: 1, fov: 50, clear: 8 } },
  // Clearing: pull back and up from the starboard quarter, sunlight returning over the leftover swell.
  { at: 24.4, end: 30.01, a: { az: 140, el: 6, dist: 700, focus: [20, 10, 0], fov: 42 }, b: { az: 118, el: 9.5, dist: 980, focus: [40, 10, 0], fov: 42 } },
]

let lastShot: Shot | null = null
function camAt(t: number): CamKey & { cut: boolean; shake: number } {
  const s = SHOTS.find((x) => t >= x.at && t < x.end) ?? SHOTS.at(-1)!
  const cut = s !== lastShot
  lastShot = s
  const u0 = Math.max(0, Math.min(1, (t - s.at) / (s.end - s.at)))
  // Mostly constant speed (a dolly), eased only a little at the ends.
  const u = u0 * 0.75 + ease(u0) * 0.25
  const fa = s.a.focus ?? [0, 10, 0]
  const fb = s.b.focus ?? fa
  return {
    az: lerp(s.a.az, s.b.az, u),
    el: lerp(s.a.el, s.b.el, u),
    dist: lerp(s.a.dist, s.b.dist, u),
    focus: [lerp(fa[0], fb[0], u), lerp(fa[1], fb[1], u), lerp(fa[2], fb[2], u)],
    fov: lerp(s.a.fov ?? 44, s.b.fov ?? 44, u),
    clear: lerp(s.a.clear ?? 4, s.b.clear ?? 4, u),
    jet: lerp(s.a.jet ?? 0, s.b.jet ?? 0, ease(u0)),
    eye: s.a.eye ? [lerp(s.a.eye[0], (s.b.eye ?? s.a.eye)[0], u), lerp(s.a.eye[1], (s.b.eye ?? s.a.eye)[1], u), lerp(s.a.eye[2], (s.b.eye ?? s.a.eye)[2], u)] : undefined,
    lag: s.a.lag ?? 0,
    // Bow slams shake the lens only in a big sea (the hull dips its bow hard at speed in calm water too).
    shake: ramp(storm(t).sea, 1.6, 2.6),
    cut,
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Serve the build, open the game with a virtual clock
// ---------------------------------------------------------------------------------------------------------------

const dist = join(root, "dist/arcade/carrier")
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const p = new URL(req.url).pathname
    const f = Bun.file(join(dist, p === "/" ? "index.html" : p))
    return (await f.exists()) ? new Response(f) : new Response("not found", { status: 404 })
  },
})
const base = `http://127.0.0.1:${server.port}/`

// Sea functions for the page (eye clearance over the waves): bundled from shared/ and injected as a script.
const helperEntry = join(out, ".video-helper.ts")
writeFileSync(helperEntry, `import { seaHeight } from ${JSON.stringify(join(root, "shared/sea.ts"))}\n;(globalThis as any).__seaHeight = seaHeight\n`)
const helper = await Bun.build({ entrypoints: [helperEntry], target: "browser", format: "iife" })
const helperJs = await helper.outputs[0]!.text()

const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--enable-features=WebGPU", "--ignore-gpu-blocklist", "--disable-background-timer-throttling", "--disable-renderer-backgrounding"],
})
const page = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1 })
const logs: string[] = []
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") logs.push(`${m.type()}: ${m.text()}`)
})
page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`))

// The virtual clock: performance.now, Date.now and requestAnimationFrame only move when the script steps them.
await page.addInitScript(() => {
  let now = 0
  const d0 = Date.now()
  let queue: FrameRequestCallback[] = []
  performance.now = () => now
  Date.now = () => d0 + now
  globalThis.requestAnimationFrame = (cb) => {
    queue.push(cb)
    return queue.length
  }
  globalThis.cancelAnimationFrame = () => {}
  ;(globalThis as unknown as { __vc: unknown }).__vc = {
    get now() {
      return now
    },
    step(ms: number) {
      now += ms
      const q = queue
      queue = []
      for (const cb of q) cb(now)
      return q.length
    },
  }
})

await page.goto(`${base}?seed=${seed}&lab=0${tod ? `&tod=${tod}` : ""}`, { waitUntil: "load" })
await page.addScriptTag({ content: helperJs })
const adapter = await page.evaluate(async () => {
  const a = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" })
  return a ? `${a.info.vendor} / ${a.info.architecture} / ${a.info.description}` : "no adapter"
})
console.log(`adapter: ${adapter}`)
if (/swiftshader/i.test(adapter) || adapter === "no adapter") await budget.exit(2)

type V = { step(ms: number): number; now: number }
// Load: tick the virtual clock until the world, the ocean and the player's carrier exist.
for (let i = 0; ; i++) {
  const ready = await page.evaluate(() => {
    const g = globalThis as unknown as { __vc: V; carrier?: { weather?: { view: unknown }; ocean?: { tiles: number }; game?: { state: { ship: unknown } } } }
    g.__vc.step(1000 / 60)
    const c = g.carrier
    return !!c?.weather?.view && (c.ocean?.tiles ?? 0) > 0 && !!c.game?.state.ship
  })
  if (ready) break
  if (i > 3000) throw new Error("the game never became ready")
  await page.waitForTimeout(i < 50 ? 50 : 10)
}
// Assets (the carrier and jet models) load asynchronously: give them real time.
for (let i = 0; i < 60; i++) {
  await page.evaluate(() => (globalThis as unknown as { __vc: V }).__vc.step(1000 / 60))
  await page.waitForTimeout(30)
}

// Page-side director: weather, strikes, camera, frame capture.
const heading = opt("heading", "")
const info = await page.evaluate(
  ({ heading }) => {
    type Ship = Record<string, number>
    const g = globalThis as unknown as Record<string, any>
    const c = g.carrier
    document.getElementById("hud")!.style.display = "none"
    c.debugMenu.visible && c.debugMenu.toggle?.()
    const ship: Ship = c.game.state.ship
    const [sx, sz] = c.weather.view.sea.swell as [number, number]
    // Into the primary swell: head seas pitch the most.
    ship.heading = heading === "" ? Math.atan2(-sx, sz) : (Number(heading) * Math.PI) / 180
    ship.u = 23.6
    ship.power = 1
    c.game.state.helm.order = 1
    // The weather lab would reset weather.manual every frame: this script owns it.
    c.lab.frame = () => {}
    c.weather.manual = { ...c.weather.current }
    const D = 180 / Math.PI
    const v = (g.__vid = {
      spec: null as null | Record<string, any>,
      hs: ship.heading as number,
      eyeY: null as null | number,
      shake: 0,
      time: 0,
      look: null as null | number[],
    })
    const orig = c.game.update
    c.game.update = (dt: number, t: number, aspect: number) => {
      const r = orig(dt, t, aspect)
      const s = v.spec
      const sh: Ship | null = c.game.state.ship
      if (!s || !sh) return r
      v.time += dt
      // Heading low-passed (the hull yaws in the waves; the camera shouldn't).
      let dh = sh.heading! - v.hs
      dh -= Math.PI * 2 * Math.round(dh / (Math.PI * 2))
      v.hs += s.cut ? dh : dh * (1 - Math.exp(-dt / 2.5))
      const h = v.hs
      const f = [Math.sin(h), -Math.cos(h)]
      const rgt = [Math.cos(h), Math.sin(h)]
      const px = sh.x!
      const pz = sh.z!
      const sx = px + f[0]! * s.focus[0] + rgt[0]! * s.focus[2]
      const sz = pz + f[1]! * s.focus[0] + rgt[1]! * s.focus[2]
      const sy = s.focus[1]
      let fx = sx
      let fy = sy
      let fz = sz
      // The look point slides from the ship onto the jet (the eye stays placed off the ship).
      const jw = s.jet ?? 0
      const jd = c.flight.flight.draw
      if (jw > 0 && c.flight.flight.phase !== "idle") {
        fx = sx + (jd.x - sx) * jw
        fy = sy + (jd.y - sy) * jw
        fz = sz + (jd.z - sz) * jw
      }
      const az = s.az / D
      const el = s.el / D
      const dir = [f[0]! * Math.cos(az) + rgt[0]! * Math.sin(az), f[1]! * Math.cos(az) + rgt[1]! * Math.sin(az)]
      let ex = sx + dir[0]! * Math.cos(el) * s.dist
      let ez = sz + dir[1]! * Math.cos(el) * s.dist
      let ey = sy + Math.sin(el) * s.dist
      if (s.eye) {
        ex = px + f[0]! * s.eye[0] + rgt[0]! * s.eye[2]
        ez = pz + f[1]! * s.eye[0] + rgt[1]! * s.eye[2]
        ey = s.eye[1]
      }
      // Keep the lens above the swell under it, eased so passing crests lift it smoothly.
      const sea = c.weather.view.sea
      let water = -1e9
      for (const [ox, oz] of [[0, 0], [12, 0], [-12, 0], [0, 12], [0, -12]]) water = Math.max(water, g.__seaHeight(sea, ex + ox!, ez + oz!, t))
      const want = Math.max(ey, water + s.clear)
      v.eyeY = s.cut || v.eyeY === null ? want : v.eyeY + (want - v.eyeY) * (1 - Math.exp(-dt / 0.35))
      v.eyeY = Math.max(v.eyeY, water + s.clear * 0.6)
      ey = v.eyeY
      // A little hand-held drift, and a jolt when the bow slams.
      v.shake = Math.max(v.shake * Math.exp(-dt / 0.5), sh.slam! * 0.7 * s.shake)
      const n = v.time
      const k = 0.0012 + v.shake * 0.006
      const jx = k * (Math.sin(n * 0.71) * 0.6 + Math.sin(n * 1.37 + 1.3) * 0.4) + v.shake * 0.004 * Math.sin(n * 23.1)
      const jy = k * (Math.sin(n * 0.53 + 0.7) * 0.6 + Math.sin(n * 1.13 + 2.1) * 0.4) + v.shake * 0.004 * Math.sin(n * 29.3 + 0.7)
      let lx = fx - ex
      let ly = fy - ey
      let lz = fz - ez
      const len = Math.hypot(lx, ly, lz)
      lx /= len
      ly /= len
      lz /= len
      // An operator's follow: the look direction eases toward the subject.
      if (!s.cut && s.lag > 0 && v.look) {
        const k2 = 1 - Math.exp(-dt / s.lag)
        lx = v.look[0] + (lx - v.look[0]) * k2
        ly = v.look[1] + (ly - v.look[1]) * k2
        lz = v.look[2] + (lz - v.look[2]) * k2
        const l3 = Math.hypot(lx, ly, lz)
        lx /= l3
        ly /= l3
        lz /= l3
      }
      v.look = [lx, ly, lz]
      // Jitter in screen axes (right, up).
      const rx = -lz
      const rz = lx
      const rl = Math.hypot(rx, rz) || 1
      lx += (rx / rl) * jx
      lz += (rz / rl) * jx
      ly += jy
      const l2 = Math.hypot(lx, ly, lz)
      c.camera.lookAlong([ex, ey, ez], [lx / l2, ly / l2, lz / l2], [0, 1, 0], s.fov / D, aspect)
      return true
    }
    return { swell: [sx, sz], heading: ship.heading * D, hour: c.daynight.state, sun: c.atmosphere.sunView ?? c.atmosphere.sunDir, x: ship.x, z: ship.z, seaTime: c.net.seaTime() }
  },
  { heading },
)
console.log(`setup: ${JSON.stringify(info)}`)

/** One frame: weather, camera and strikes for video time `t`, a 1/60 s step, then (optionally) the canvas pixels. */
async function frame(t: number, grab: "raw" | "png" | "none", dtMs = 1000 / 60): Promise<{ data: string; tel: string }> {
  const w = weatherAt(t)
  const cam = camAt(t)
  const strike = STRIKES.find((s) => t >= s[0] && t - 1 / 60 < s[0]) ?? null
  const op = OPS.find((o) => t >= o[0] && t - 1 / 60 < o[0])?.[1] ?? null
  return page.evaluate(
    async ({ w, cam, strike, grab, dtMs, op }) => {
      const g = globalThis as unknown as Record<string, any>
      const c = g.carrier
      if (op) {
        c.net.op(op)
        // Hands off the stick: wings level.
        c.flight.input.override = { pitch: 0, roll: 0 }
      }
      Object.assign(c.weather.manual, w)
      g.__vid.spec = cam
      if (strike) {
        const [, power, off, dist] = strike
        const yaw = Math.atan2(c.camera.forward[0], -c.camera.forward[2])
        c.weather.forced = { t: c.net.seaTime() + dtMs / 1000 - 0.005, power, bearing: yaw + (off * Math.PI) / 180, dist, seed: Math.floor(power * 9973 + dist) }
      }
      const device: GPUDevice = c.renderer.context.device
      const ctx: GPUCanvasContext = c.renderer.canvas
      if (!g.__configured) {
        g.__configured = true
        ctx.configure({ device, format: navigator.gpu.getPreferredCanvasFormat(), alphaMode: "opaque", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC })
      }
      // The renderer draws in a microtask and skips frames while two are in flight: let the GPU drain first, so this
      // step's frame is drawn, then catch the swapchain texture it draws into.
      await device.queue.onSubmittedWorkDone()
      while (c.renderer.inflight > 0) await new Promise((r) => setTimeout(r, 0))
      const drawn: { tex: GPUTexture | null } = { tex: null }
      const get = ctx.getCurrentTexture.bind(ctx)
      ctx.getCurrentTexture = () => (drawn.tex ??= get())
      const ran = g.__vc.step(dtMs)
      await Promise.resolve()
      ctx.getCurrentTexture = get
      const s = c.game.state.ship
      const j = c.flight.flight
      const jet = j.phase === "idle" ? "" : ` jet ${j.phase} ${(j.draw.x - s.x).toFixed(0)},${j.draw.y.toFixed(0)},${(j.draw.z - s.z).toFixed(0)}`
      const tel = `hdg ${((s.heading * 180) / Math.PI).toFixed(1)} pitch ${((s.pitch * 180) / Math.PI).toFixed(1)} heave ${s.heave.toFixed(1)} slam ${s.slam.toFixed(2)} kn ${(s.u / 0.5144).toFixed(0)} flash ${c.weather.flash.toFixed(2)} k ${((c.net.seaTime() - s.t) * 60).toFixed(2)}${jet}`
      if (grab === "none") {
        await device.queue.onSubmittedWorkDone()
        return { data: "", tel }
      }
      const tex = drawn.tex
      if (!tex) throw new Error(`the frame did not render (${ran} rAF callbacks)`)
      const w2 = tex.width
      const h2 = tex.height
      const row = Math.ceil((w2 * 4) / 256) * 256
      const buf = device.createBuffer({ size: row * h2, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
      const enc = device.createCommandEncoder()
      enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: row }, [w2, h2])
      device.queue.submit([enc.finish()])
      await buf.mapAsync(GPUMapMode.READ)
      const src = new Uint8Array(buf.getMappedRange())
      const bgra = tex.format === "bgra8unorm"
      let bytes: Uint8Array
      if (grab === "raw") {
        // Tight BGRA rows for ffmpeg.
        bytes = new Uint8Array(w2 * h2 * 4)
        for (let y = 0; y < h2; y++) bytes.set(src.subarray(y * row, y * row + w2 * 4), y * w2 * 4)
        if (!bgra) for (let i = 0; i < bytes.length; i += 4) [bytes[i], bytes[i + 2]] = [bytes[i + 2]!, bytes[i]!]
      } else {
        const img = new ImageData(w2, h2)
        for (let y = 0; y < h2; y++)
          for (let x = 0; x < w2; x++) {
            const a = y * row + x * 4
            const d = (y * w2 + x) * 4
            img.data[d] = src[a + (bgra ? 2 : 0)]!
            img.data[d + 1] = src[a + 1]!
            img.data[d + 2] = src[a + (bgra ? 0 : 2)]!
            img.data[d + 3] = 255
          }
        const cv = new OffscreenCanvas(w2, h2)
        cv.getContext("2d")!.putImageData(img, 0, 0)
        bytes = new Uint8Array(await (await cv.convertToBlob({ type: "image/png" })).arrayBuffer())
      }
      buf.unmap()
      buf.destroy()
      let bin = ""
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      return { data: btoa(bin), tel }
    },
    { w, cam, strike, grab, dtMs, op },
  )
}

// Warm-up: the carrier gets under way in the sunny weather and lays down a wake. Then align the virtual clock half a
// ship tick past the simulation's grid, so every 1/60 s frame advances exactly one ship step (no double steps).
const warmFrames = Math.round(warm * 60)
for (let i = 0; i < warmFrames; i++) await frame(0, "none")
const phase = await page.evaluate(() => {
  const c = (globalThis as unknown as Record<string, any>).carrier
  return (c.net.seaTime() - c.game.state.ship.t) * 60
})
const fixMs = ((((0.5 - phase) % 1) + 1) % 1) * (1000 / 60)
await frame(0, "none", fixMs)
console.log(`warm-up ${warm}s, tick phase ${phase.toFixed(3)} -> +${fixMs.toFixed(2)} ms`)

const step = 60 / fps
const total = Math.round(DURATION * fps)
const first = Math.round(from * fps)
const last = Math.min(total, Math.round(to * fps))

if (opt("tele", "") === "1") {
  for (let i = 0; i <= DURATION * 60; i++) {
    const r = await frame(i / 60, "none")
    if (i % 15 === 0) console.log(`${(i / 60).toFixed(2)} ${r.tel}`)
  }
} else if (opt("encode", "") === "1") {
  // Title and delivery encode only, from an existing master.
  await finish(join(out, "weather-cycle-master.mp4"))
} else if (stills.length) {
  // Previews: run the timeline at 60 Hz (the sim needs it) and save PNGs at the asked times.
  const want = new Set(stills.map((s) => Math.round(s * 60)))
  const end = Math.max(...want)
  for (let i = 0; i <= end; i++) {
    const t = i / 60
    const grab = want.has(i) ? "png" : "none"
    const r = await frame(t, grab)
    if (grab === "png") {
      writeFileSync(join(out, `still-${t.toFixed(2)}.png`), Buffer.from(r.data, "base64"))
      console.log(`still ${t.toFixed(2)}: ${r.tel}`)
    }
  }
} else {
  // Frames go straight into a near-lossless intermediate; the final encode adds the title and the delivery settings.
  const mid = join(out, "weather-cycle-master.mp4")
  const enc = spawn(ffmpeg, ["-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "bgra", "-s", `${vw}x${vh}`, "-r", String(fps), "-i", "-", "-c:v", "libx264", "-preset", "medium", "-crf", "8", "-pix_fmt", "yuv444p", mid], { stdio: ["pipe", "inherit", "inherit"] })
  const done = new Promise<number>((r) => enc.on("close", (code) => r(code ?? 1)))
  const t0 = Date.now()
  let ticks = 0
  for (let i = 0; i < last; i++) {
    // Always step the sim at 60 Hz; at 30 fps every other step is captured.
    for (let k = 0; k < step; k++) {
      const n = i * step + k
      const t = n / 60
      const keep = k === step - 1 && i >= first
      const r = await frame(t, keep ? "raw" : "none")
      ticks++
      if (keep) {
        const b = Buffer.from(r.data, "base64")
        if (!enc.stdin.write(b)) await new Promise((res) => enc.stdin.once("drain", res))
        if (i % 60 === 0) console.log(`frame ${i}/${last} t=${t.toFixed(2)} ${r.tel} (${((Date.now() - t0) / 1000).toFixed(0)} s)`)
      }
    }
  }
  enc.stdin.end()
  if ((await done) !== 0) throw new Error("ffmpeg failed")
  console.log(`master: ${mid} (${ticks} steps, ${((Date.now() - t0) / 1000).toFixed(0)} s)`)
  if (first === 0 && last === total) await finish(mid)
}

/** The title card (the load screen's thin, widely tracked caps, in the game's own font file) and the delivery encode. */
async function finish(mid: string): Promise<void> {
  const font = readdirSync(join(dist, "assets")).find((f) => /ibm-plex-mono-latin-300-normal.*\.woff2$/.test(f))
  const card = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1 })
  await card.goto(base)
  await card.setContent(`<style>
    @font-face { font-family: "Plex"; font-weight: 300; src: url("${base}assets/${font}") format("woff2"); }
    html, body { margin: 0; height: 100%; background: transparent; }
    body { display: grid; place-items: center; }
    div { font: 300 ${Math.round(vh * 0.075)}px "Plex", monospace; letter-spacing: 0.62em; margin-right: -0.62em; color: #f4f7fb;
      text-shadow: 0 2px 22px rgba(10, 30, 60, 0.55), 0 1px 3px rgba(10, 30, 60, 0.35); transform: translateY(${Math.round(vh * 0.25)}px); }
  </style><div>CARRIER</div>`)
  await card.evaluate(() => document.fonts.ready)
  const title = join(out, "title.png")
  writeFileSync(title, await card.screenshot({ omitBackground: true }))
  await card.close()
  const final = join(out, "weather-cycle.mp4")
  const [tin, tdur] = [DURATION - 2.2, 0.9]
  // Two-pass to a bitrate that keeps 30 s under 50 MB (X's limit is far above; rain and foam eat a CRF encode alive).
  const kbps = Number(opt("kbps", "12500"))
  const log = join(out, "x264-pass")
  const common = [
    "-y", "-loglevel", "error", "-i", mid, "-loop", "1", "-framerate", String(fps), "-t", String(DURATION), "-i", title,
    "-filter_complex", `[1:v]format=rgba,fade=t=in:st=${tin}:d=${tdur}:alpha=1[t];[0:v][t]overlay=0:0:shortest=1,format=yuv420p[v]`,
    "-map", "[v]", "-c:v", "libx264", "-preset", "slower", "-profile:v", "high", "-pix_fmt", "yuv420p",
    "-b:v", `${kbps}k`, "-maxrate", `${Math.round(kbps * 1.6)}k`, "-bufsize", `${kbps * 2}k`, "-passlogfile", log,
  ]
  const run = (extra: string[]) => new Promise<number>((res) => spawn(ffmpeg, [...common, ...extra], { stdio: "inherit" }).on("close", (c) => res(c ?? 1)))
  if ((await run(["-pass", "1", "-f", "mp4", "/dev/null"])) !== 0) throw new Error("encode pass 1 failed")
  if ((await run(["-pass", "2", "-movflags", "+faststart", final])) !== 0) throw new Error("encode pass 2 failed")
  console.log(`video: ${final} (${(statSync(final).size / 1e6).toFixed(1)} MB)`)
}

if (logs.length) console.log(`console:\n${[...new Set(logs)].slice(0, 30).join("\n")}`)
await browser.close()
server.stop()
rmSync(helperEntry, { force: true })
