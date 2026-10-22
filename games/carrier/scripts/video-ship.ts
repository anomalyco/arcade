// "Ship portrait" showcase video (30 s): the carrier through one whole day, dawn to dawn, with the weather building
// into a night storm and clearing to stars, scored with trailer music. A copy of scripts/video-epic.ts (same
// deterministic frame stepping on a real GPU, same in-page director) with ship-only shots, and runs ON hailmary (Mac
// Studio, Metal) from a snapshot copy of the workspace with a production build in dist/:
//
//   tar package.json bun.lock bunfig.toml packages/kit games/carrier (+ the other games' package.json) to
//   ~/.cache/carrier-video/ship/arcade, then: bun install; in games/carrier: bun scripts/build-id.ts &&
//   bun --bun ../../node_modules/.bin/vite build
//   bun scripts/video-ship.ts --out=~/.cache/carrier-video/ship/out --music=~/.cache/carrier-video/ship/music.mp3
//
// Per step it sets the weather (weather.manual), the time of day (daynight.manual), lightning strikes and a scripted
// flicker of the practical lights, places the camera inside the flight module's per-frame hook, steps exactly 1/60 s
// and copies the swapchain texture into ffmpeg. Cuts are free time skips. Before the first shot it picks a course for
// the carrier that stays in deep water (no reef within 320 m of the track for 3.2 km), as near into the swell as it can.
//
// Audio: the music (--music, an mp3 starting at --music-at seconds) is the score. The game's own mixer renders in
// lockstep on an OfflineAudioContext as in video-epic.ts (ocean, wind, rain, thunder with each strike, hull slams),
// each shot brought to its `loud` level, and goes in well under the music; then -14 LUFS integrated, -1 dBTP.
//
// Options: --out=DIR  --size=1920x1080  --seed=7  --warm=20 (warm-up s)  --kbps=11400 (video)  --audio=0 (silent)
//          --stills=T1,T2,...  (PNG stills at those video seconds instead of the video)  --shots=a,b (only those)
//          --tele=1 (telemetry every 0.25 s)  --encode=1 (encode from the master)  --music=FILE  --music-at=S
//          --game-db=N (game audio level against the music, default -12)  --title=S (title card start, default 28)
// Output in --out: ship-master.mp4 (near-lossless), ship-day.mp4 (delivery: title, URL, audio, two-pass < 50 MB).
import { mkdirSync, writeFileSync, existsSync, rmSync, readdirSync, statSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { browserBudget } from "../../../scripts/browser-budget"
import { WEATHER_PRESETS, mixWeather, makeWeather, type Weather } from "../shared/weather"
import { phaseOfHour } from "../shared/daycycle"

await using budget = browserBudget()
const { chromium } = budget

const args = process.argv.slice(2)
const opt = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
const root = resolve(import.meta.dir, "..")
const out = resolve(opt("out", join(root, "video-out")).replace(/^~/, process.env.HOME ?? "~"))
const FPS = 60
const RATE = 48000
const SPF = RATE / FPS
const [vw, vh] = opt("size", "1920x1080").split("x").map(Number) as [number, number]
const seed = opt("seed", "7")
const stills = opt("stills", "")
  .split(",")
  .filter(Boolean)
  .map(Number)
const only = opt("shots", "").split(",").filter(Boolean)
const warm = Number(opt("warm", "20"))
const tele = opt("tele", "") === "1"
const withAudio = opt("audio", "1") !== "0"
const DURATION = 30
const TITLE = Number(opt("title", "27.25"))
/** Video seconds the music is low-passed and ducked under the clearing night (opening again into the final hit). */
const CALM: [number, number] = [24.4, 27.1]
const ffmpeg = existsSync("/opt/homebrew/bin/ffmpeg") ? "/opt/homebrew/bin/ffmpeg" : "ffmpeg"
mkdirSync(out, { recursive: true })

// ---------------------------------------------------------------------------------------------------------------
// Story helpers
// ---------------------------------------------------------------------------------------------------------------

const clamp01 = (x: number) => Math.max(0, Math.min(1, x))
const ease = (u: number) => {
  const x = clamp01(u)
  return x * x * (3 - 2 * x)
}
const ramp = (t: number, a: number, b: number) => ease((t - a) / (b - a))
const lerp = (a: number, b: number, u: number) => a + (b - a) * u

const { clear, light, medium, heavy } = WEATHER_PRESETS
const KINDS = [clear, light, medium, heavy]
function presetAt(x: number): Weather {
  const i = Math.max(0, Math.min(2, Math.floor(x)))
  return mixWeather(KINDS[i]!, KINDS[i + 1]!, clamp01(x - i), makeWeather())
}
const SEA_KEYS = ["sea", "swell", "foam"] as const
/** Weather from a sky level and a sea level (0 clear .. 3 heavy each); lightning only from scripted strikes, rain only past 1.7. */
function wx(sky: number, sea: number): Weather {
  const w = presetAt(sky)
  const sw = presetAt(sea)
  for (const k of SEA_KEYS) w[k] = sw[k]
  w.wind = Math.max(w.wind * 0.6 + sw.wind * 0.4, sw.wind)
  w.lightning = 0
  // Clouds build without rain: it only starts with the squall (fast lenses turn light rain into warp-speed streaks).
  w.rain *= ramp(sky, 1.7, 2.5)
  return w
}

/** Clock hours unwrapped from 04:30 of the video's first day (28.6 = 04:36 the next morning). */
let day0 = 0
function phaseFor(hour: number): number {
  const off = Math.floor((hour - 4.5) / 24)
  return day0 + off + phaseOfHour(hour)
}

// ---------------------------------------------------------------------------------------------------------------
// Shots
// ---------------------------------------------------------------------------------------------------------------

/** Page-side camera and control functions get `H` (see the director below); they are serialised, so no closures. */
type PageFn = (H: any, arg?: any) => any
type Strike = [s: number, power: number, offDeg: number, dist: number]
type Shot = {
  name: string
  at: number
  end: number
  /** Unseen seconds of the shot before `at`. */
  pre?: number
  setup?: (d: Director) => Promise<void>
  /** Weather and clock hour at shot-local time s (negative in the preroll). */
  weather: (s: number) => Weather
  hour: (s: number) => number
  cam: PageFn
  strikes?: Strike[]
  /** Loudness the shot's audio is brought to before the master (LUFS over the shot); unset: left as rendered. */
  loud?: number
  /** Practical lights at shot-local time s: [floor, gain]; level = max(game level, floor) * gain (a flicker). */
  lights?: (s: number) => [number, number]
  /** Lightning boost [ambient, clouds]: a strike lights the ship and the deck behind it more than the night grade allows. */
  flash?: [number, number]
}

type Director = {
  js: <T = unknown>(fn: PageFn, arg?: unknown) => Promise<T>
  run: (sec: number) => Promise<void>
  until: (fn: PageFn, maxSec: number) => Promise<boolean>
}

/** Deterministic 0..1 hash for the light flicker. */
const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return x - Math.floor(x)
}
/** Deck lights off until a, then stuttering on until b: each 1/15 s slot is on with a probability rising to 1 by b. */
function flicker(s: number, a: number, b: number): [number, number] {
  if (s < a) return [0, 0]
  if (s >= b) return [0.9, 1]
  const u = (s - a) / (b - a)
  const on = hash(Math.floor(s * 15)) < 0.25 + 0.75 * u
  return [0.9, on ? 0.55 + 0.45 * u : 0.04]
}

const SHOTS: Shot[] = [
  // 1. Dawn: low over the water south of the carrier, the sun coming up behind her, the glitter path, a slow dolly.
  {
    name: "dawn",
    loud: -29,
    at: 0,
    end: 4.6,
    pre: 0.5,
    weather: () => wx(0, 0.35),
    hour: (s) => lerp(5.9, 6.8, clamp01(s / 4.6)),
    cam: (H) => {
      const u = H.u * 0.75 + H.ease(H.u) * 0.25
      return { eye: H.W(H.ship, 194 - 18 * u, 620 - 110 * u, 5 + 3 * u), look: H.P(0, 50 + 6 * u, 30), fov: 36, clear: 3.5 }
    },
  },
  // 2. Noon: a high reveal, craning up and round from the quarter, the carrier over blue water and the reefs beyond.
  {
    name: "noon",
    loud: -32,
    at: 4.6,
    end: 8.9,
    pre: 0.5,
    weather: () => wx(0.12, 0.6),
    hour: (s) => lerp(11.4, 12.9, clamp01(s / 4.3)),
    cam: (H) => {
      const u = H.u * 0.6 + H.ease(H.u) * 0.4
      const az = H.freeze("az", () => H.isleAz())
      const b = az + 180 - 34 + 26 * u
      return { eye: H.W(H.ship, b, 520 - 60 * u, 70 + 150 * u), look: H.P(0, 10 - 10 * u, 0), fov: 44 - 4 * u, clear: 5 }
    },
  },
  // 3. Afternoon: along the starboard deck edge from aft, past the island and the sponsons, clouds building.
  {
    name: "deck",
    loud: -32,
    at: 8.9,
    end: 12.7,
    pre: 0.5,
    weather: (s) => wx(0.3 + 0.3 * clamp01(s / 3.8), 0.8),
    hour: (s) => lerp(14.4, 15.8, clamp01(s / 3.8)),
    cam: (H) => {
      const u = H.u * 0.85 + H.ease(H.u) * 0.15
      return { eye: H.S(-52, 33 + 7 * u, -240 + 100 * u), look: H.S(-34, 27, 175), fov: 48, clear: 3 }
    },
  },
  // 4. Golden hour: the hero three-quarter, low, the bow cutting the swell, warm side light and long shadows.
  {
    name: "golden",
    loud: -32,
    at: 12.7,
    end: 16.25,
    pre: 0.5,
    weather: (s) => wx(0.4 + 0.35 * clamp01(s / 3.55), 1.0 + 0.3 * clamp01(s / 3.55)),
    hour: (s) => lerp(17.55, 17.86, clamp01(s / 3.55)),
    lights: () => [0, 0],
    cam: (H) => {
      const u = H.u * 0.7 + H.ease(H.u) * 0.3
      const h = (H.ship.heading * 180) / Math.PI
      return { eye: H.W(H.ship, h + 34 + 14 * u, 440 - 40 * u, 13 + 4 * u), look: H.P(0, 30, 10), fov: 34, clear: 4 }
    },
  },
  // 5. Sunset into the squall: high and wide, orbiting, the deck lights stuttering on as the deck rolls in.
  {
    name: "sunset",
    loud: -28,
    at: 16.25,
    end: 18.4,
    pre: 0.5,
    weather: (s) => wx(2.9 * ramp(s, 0.55, 2.15), 1.2 + 1.2 * ramp(s, 0.2, 2.15)),
    hour: (s) => lerp(17.95, 18.6, clamp01(s / 2.15)),
    lights: (s) => flicker(s, 0.45, 1.7),
    cam: (H) => {
      const u = H.u
      return { eye: H.W(H.ship, 213 + 9 * u, 470 - 30 * u, 78 - 10 * u), look: H.P(0, 22, 60), fov: 44 }
    },
  },
  // 6. Night storm: low off the bow (the lens kept high off the foam), the carrier rearing and slamming, lightning.
  {
    name: "storm",
    loud: -26,
    at: 18.4,
    end: 21.8,
    pre: 0.4,
    setup: async (d) => {
      await d.js((H) => {
        const s = H.c.game.state.ship
        s.u = 18
        s.power = s.order = 0.8
        H.c.game.state.helm.order = 0.8
        H.g.__pw = []
      })
      await d.run(4)
      const ok = await d.until((H) => {
        const s = H.c.game.state.ship
        const w = H.g.__pw as number[]
        w.push(s.pitch)
        if (w.length > 420) w.shift()
        const big = Math.max(...w) - Math.min(...w) > (13 * Math.PI) / 180
        const prev = w.length > 1 ? w[w.length - 2]! : 0
        return big && s.pitch > (-4 * Math.PI) / 180 && prev <= (-4 * Math.PI) / 180
      }, 60)
      console.log(`storm: big set ${ok ? "found" : "not found"}`)
    },
    weather: () => wx(3, 3),
    hour: (s) => lerp(19.0, 19.3, clamp01(s / 3.4)),
    flash: [1.1, 0.5],
    strikes: [
      [-0.1, 1, 4, 1300],
      [1.46, 1, -9, 1500],
    ],
    cam: (H) => {
      const u = H.u
      return { eye: H.P(-180 - 20 * u, 40, 540 - 30 * u), look: H.P(0, 44, 20), fov: 31, clear: 12, shake: 0.6 }
    },
  },
  // 7. The storm from the starboard quarter: the island's bridge and the deck lights through the rain, lit by strikes.
  {
    name: "squall",
    loud: -26,
    at: 21.8,
    end: 24.4,
    pre: 0.4,
    weather: () => wx(3, 2.9),
    hour: (s) => lerp(19.7, 19.95, clamp01(s / 2.6)),
    flash: [1.1, 0.5],
    strikes: [
      [0.87, 1, 2, 1700],
      [1.97, 0.85, -12, 2100],
    ],
    cam: (H) => {
      const u = H.u
      return { eye: H.P(330 - 10 * u, 60, -380 + 15 * u), look: H.P(0, 38, 10), fov: 30, clear: 14, shake: 0.4 }
    },
  },
  // 8. Clearing: the deck breaks, stars and the Milky Way over the carrier, the moon path, the reefs' cyan surf.
  {
    name: "night",
    loud: -30,
    at: 24.4,
    end: 27.2,
    pre: 0.6,
    weather: (s) => wx(1.8 * (1 - ramp(s, -0.4, 1.6)), 2.0 - 0.9 * ramp(s, 0, 2.8)),
    hour: (s) => lerp(25.0, 25.3, clamp01(s / 2.8)),
    cam: (H) => {
      const u = H.u * 0.6 + H.ease(H.u) * 0.4
      const eye = H.W(H.ship, 196 + 8 * u, 540 - 20 * u, 9)
      const look = H.P(0, 60, 0)
      return { eye, look: [look[0], look[1] + 40 + 70 * u, look[2]], fov: 58, clear: 4 }
    },
  },
  // 9. Dawn again: high and wide, the sky running up to sunrise over the carrier; the title.
  {
    name: "title",
    loud: -34,
    at: 27.2,
    end: 30.0,
    pre: 0.5,
    weather: () => wx(0, 0.5),
    hour: (s) => lerp(28.6, 30.1, ease(clamp01(s / 2.8)) * 0.4 + clamp01(s / 2.8) * 0.6),
    cam: (H) => {
      const u = H.u
      const sun = H.freeze("sun", () => H.sunAz())
      const look = H.W(H.ship, sun, 1400, 0)
      return { eye: H.W(H.ship, sun + 186, 1000 - 120 * u, 55 + 20 * u), look: [look[0], 230 + 30 * u, look[2]], fov: 46 }
    },
  },
]

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

// Shared functions for the page (sea height, ship frames, terrain), bundled from shared/ and injected as a script.
const helperEntry = join(out, ".video-helper.ts")
writeFileSync(
  helperEntry,
  `import { seaHeight } from ${JSON.stringify(join(root, "shared/sea.ts"))}
import { shipToWorld } from ${JSON.stringify(join(root, "shared/plane.ts"))}
import { terrainHeight } from ${JSON.stringify(join(root, "shared/islands.ts"))}
;Object.assign(globalThis, { __seaHeight: seaHeight, __shipToWorld: shipToWorld, __terrain: terrainHeight })\n`,
)
const helper = await Bun.build({ entrypoints: [helperEntry], target: "browser", format: "iife" })
const helperJs = await helper.outputs[0]!.text()

const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--enable-features=WebGPU", "--ignore-gpu-blocklist", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--autoplay-policy=no-user-gesture-required"],
})
const page = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1 })
const logs: string[] = []
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") logs.push(`${m.type()}: ${m.text()}`)
  if (m.text().startsWith("[video]")) console.log(m.text())
})
page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`))

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

await page.goto(`${base}?seed=${seed}&lab=0`, { waitUntil: "load" })
await page.addScriptTag({ content: helperJs })
const adapter = await page.evaluate(async () => {
  const a = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" })
  return a ? `${a.info.vendor} / ${a.info.architecture} / ${a.info.description}` : "no adapter"
})
console.log(`adapter: ${adapter}`)
if (/swiftshader/i.test(adapter) || adapter === "no adapter") await budget.exit(2)

type V = { step(ms: number): number; now: number }
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
for (let i = 0; i < 60; i++) {
  await page.evaluate(() => (globalThis as unknown as { __vc: V }).__vc.step(1000 / 60))
  await page.waitForTimeout(30)
}

// ---------------------------------------------------------------------------------------------------------------
// Page-side director: helpers, controls, camera (inside the flight module's frame hook), audio lockstep
// ---------------------------------------------------------------------------------------------------------------

const info = await page.evaluate(() => {
  const g = globalThis as unknown as Record<string, any>
  const c = g.carrier
  document.getElementById("hud")!.style.display = "none"
  c.debugMenu.visible && c.debugMenu.toggle?.()
  const ship = c.game.state.ship
  const [sx, sz] = c.weather.view.sea.swell as [number, number]
  // The course: as near into the swell as possible with no reef or shore within 320 m of the track for 3.2 km.
  const into = Math.atan2(-sx, sz)
  const reef = (x: number, z: number) => g.__terrain(c.arch, x, z) > -14
  const clearRun = (x0: number, z0: number, h: number) => {
    const fx = Math.sin(h)
    const fz = -Math.cos(h)
    for (let d = -300; d <= 3200; d += 40) for (const l of [-320, -160, 0, 160, 320]) if (reef(x0 + fx * d - fz * l, z0 + fz * d + fx * l)) return false
    return true
  }
  let course: { h: number; x: number; z: number; back: number } | null = null
  search: for (const back of [1600, 0, 3000]) {
    for (let k = 0; k <= 36; k++) {
      for (const sgn of k === 0 ? [1] : [1, -1]) {
        const h = into + (sgn * k * 5 * Math.PI) / 180
        const x = ship.x - Math.sin(h) * back
        const z = ship.z + Math.cos(h) * back
        if (clearRun(x, z, h)) {
          course = { h, x, z, back }
          break search
        }
      }
    }
  }
  if (!course) throw new Error("no clear course")
  ship.heading = course.h
  ship.x = course.x
  ship.z = course.z
  ship.u = 15.4
  ship.power = 0.65
  ship.order = 0.65
  c.game.state.helm.order = 0.65
  console.log(`[video] course ${((course.h * 180) / Math.PI).toFixed(0)} deg (into swell ${((into * 180) / Math.PI).toFixed(0)}), back ${course.back} m`)
  // Lightning that lights the ship (Shot.flash): after the weather writes this frame's look, add ambient and cloud glow.
  const wup = c.weather.update.bind(c.weather)
  c.weather.update = (dt: number, t: number, look?: { atmosphere: { ambient: number } }) => {
    wup(dt, t, look)
    const F = g.__vid?.spec?.flash as [number, number] | null | undefined
    const fl = c.weather.flash as number
    if (F && fl > 0 && look) {
      look.atmosphere.ambient += F[0] * fl
      c.weather.clouds.flash = Math.max(c.weather.clouds.flash, F[1] * fl)
    }
  }
  // The practical lights' flicker (Shot.lights).
  const lup = c.lights.upload.bind(c.lights)
  c.lights.upload = (level: number, night: number, fov: number, height: number) => {
    const L = g.__vid?.spec?.lights as [number, number] | null | undefined
    return L ? lup(Math.max(level, L[0]) * L[1], Math.max(night, L[0] * 0.8) * L[1], fov, height) : lup(level, night, fov, height)
  }
  c.lab.frame = () => {}
  c.weather.manual = { ...c.weather.current }
  const D = 180 / Math.PI
  const v = (g.__vid = {
    spec: null as null | Record<string, any>,
    shot: null as null | Record<string, any>,
    memo: {} as Record<string, any>,
    look: null as null | number[],
    eyeY: null as null | number,
    shake: 0,
    time: 0,
    cut: true,
    cam: null as null | { eye: number[]; fwd: number[] },
  })
  const q = [0, 0, 0]
  const H: Record<string, any> = {
    g,
    c,
    ease: (u: number) => {
      const x = Math.max(0, Math.min(1, u))
      return x * x * (3 - 2 * x)
    },
    lerp3: (a: number[], b: number[], u: number) => [a[0]! + (b[0]! - a[0]!) * u, a[1]! + (b[1]! - a[1]!) * u, a[2]! + (b[2]! - a[2]!) * u],
    sea: (x: number, z: number) => g.__seaHeight(c.weather.view.sea, x, z, c.net.seaTime()),
    terrain: (x: number, z: number) => g.__terrain(c.arch, x, z),
    /** Ship-local point (carrier-spec: +x port, +y up from the keel datum, +z bow), riding the hull. */
    S: (x: number, y: number, z: number) => {
      const r = g.__shipToWorld(H.ship, x, y, z, q)
      return [r[0], r[1], r[2]]
    },
    /** Ship plan frame: stbd metres, height above mean sea level, metres ahead of midships. */
    P: (stbd: number, y: number, fwd: number) => {
      const h = H.ship.heading
      return [H.ship.x + Math.sin(h) * fwd + Math.cos(h) * stbd, y, H.ship.z - Math.cos(h) * fwd + Math.sin(h) * stbd]
    },
    /** World point at compass bearing `deg` and `dist` metres from (s.x, s.z), height y. */
    W: (s: { x: number; z: number }, deg: number, dist: number, y: number) => [s.x + Math.sin(deg / D) * dist, y, s.z - Math.cos(deg / D) * dist],
    freeze: (k: string, fn: () => any) => (v.memo[k] ??= fn()),
    /** Compass bearing (deg) from the ship to the nearest island with a reef worth seeing. */
    isleAz: () => {
      const s = H.ship
      const i = (c.arch.islands as { x: number; z: number; radius: number }[])
        .filter((i) => i.radius > 200)
        .map((i) => ({ i, d: Math.hypot(i.x - s.x, i.z - s.z) - i.radius }))
        .sort((a, b) => a.d - b.d)[0]!.i
      return Math.atan2(i.x - s.x, -(i.z - s.z)) * D
    },
    /** Compass bearing (deg) of the painted sun. */
    sunAz: () => Math.atan2(c.daynight.sunView[0], -c.daynight.sunView[2]) * D,
  }
  g.__H = H
  // Thunder with its flash (a trailer cheat: the game delays it by the distance).
  const snd = c.weather.sound
  const strike = snd.strike.bind(snd)
  snd.strike = (st: Record<string, number>, delay: number) => strike({ ...st, dist: Math.min(st.dist, 900) }, Math.min(delay, 0.12))
  // Per frame, before the game: the shot clock.
  const update = c.game.update
  c.game.update = (dt: number, t: number, aspect: number) => {
    const s = v.spec
    if (s) {
      H.s = s.s
      H.u = s.u
      H.t = s.t
    }
    const r = update(dt, t, aspect)
    return s ? true : r
  }

  // The camera, placed inside the flight module's per-frame hook: after the ship and the jet are posed for this frame,
  // before jets, weapon effects, lights and the listener read the camera.
  const fframe = c.flight.frame.bind(c.flight)
  c.flight.frame = (fv: Record<string, any>) => {
    const s = v.spec
    if (s) {
      const ship = fv.ships?.[0] ?? c.game.state.ship
      H.ship = ship
      v.time += fv.dt
      const k = s.cam(H) as { eye: number[]; look: number[]; fov: number; clear?: number; lag?: number; roll?: number; shake?: number }
      let [ex, ey, ez] = k.eye as [number, number, number]
      const clear = k.clear ?? 3
      const sea = c.weather.view.sea
      const st = c.net.seaTime()
      let water = -1e9
      for (const [ox, oz] of [[0, 0], [12, 0], [-12, 0], [0, 12], [0, -12]]) water = Math.max(water, g.__seaHeight(sea, ex + ox!, ez + oz!, st))
      const want = Math.max(ey, water + clear)
      v.eyeY = v.cut || v.eyeY === null ? want : v.eyeY + (want - v.eyeY) * (1 - Math.exp(-fv.dt / 0.35))
      v.eyeY = Math.max(v.eyeY, water + clear * 0.6)
      ey = v.eyeY
      v.shake = Math.max(v.shake * Math.exp(-fv.dt / 0.5), (ship.slam ?? 0) * 0.7 * (k.shake ?? 0))
      const n = v.time
      const kk = 0.0012 + v.shake * 0.006
      const jx = kk * (Math.sin(n * 0.71) * 0.6 + Math.sin(n * 1.37 + 1.3) * 0.4) + v.shake * 0.004 * Math.sin(n * 23.1)
      const jy = kk * (Math.sin(n * 0.53 + 0.7) * 0.6 + Math.sin(n * 1.13 + 2.1) * 0.4) + v.shake * 0.004 * Math.sin(n * 29.3 + 0.7)
      let lx = k.look[0]! - ex
      let ly = k.look[1]! - ey
      let lz = k.look[2]! - ez
      const len = Math.hypot(lx, ly, lz) || 1
      lx /= len
      ly /= len
      lz /= len
      if (!v.cut && (k.lag ?? 0) > 0 && v.look) {
        const k2 = 1 - Math.exp(-fv.dt / k.lag!)
        lx = v.look[0]! + (lx - v.look[0]!) * k2
        ly = v.look[1]! + (ly - v.look[1]!) * k2
        lz = v.look[2]! + (lz - v.look[2]!) * k2
        const l3 = Math.hypot(lx, ly, lz)
        lx /= l3
        ly /= l3
        lz /= l3
      }
      v.look = [lx, ly, lz]
      const rx = -lz
      const rz = lx
      const rl = Math.hypot(rx, rz) || 1
      lx += (rx / rl) * jx
      lz += (rz / rl) * jx
      ly += jy
      const l2 = Math.hypot(lx, ly, lz)
      const fwd = [lx / l2, ly / l2, lz / l2]
      // Roll: the up vector turned about the view direction.
      const roll = ((k.roll ?? 0) * Math.PI) / 180
      const up = [-Math.sin(roll) * (rx / rl), Math.cos(roll), -Math.sin(roll) * (rz / rl)]
      c.camera.lookAlong([ex, ey, ez], fwd, up, (k.fov * Math.PI) / 180, c.renderer.canvas.canvas.width / c.renderer.canvas.canvas.height)
      fv.eye = c.camera.eye
      v.cut = false
    }
    return fframe(fv)
  }

  return { swell: [sx, sz], heading: ship.heading * D, phase: c.daynight.phase, x: ship.x, z: ship.z, islands: c.arch.islands.slice(0, 12).map((i: Record<string, number>) => [Math.round(i.x), Math.round(i.z), Math.round(i.radius), i.kind]) }
})
console.log(`setup: ${JSON.stringify(info)}`)
day0 = Math.floor(info.phase)

// ---------------------------------------------------------------------------------------------------------------
// Stepping
// ---------------------------------------------------------------------------------------------------------------

const fnSrc = (f: PageFn) => f.toString()
/** Audio step index (OfflineAudioContext suspends at step n's sample) of each kept video frame, per shot. */
const keptSteps: { shot: string; loud: number | null; steps: number[] }[] = []

type FrameSpec = { t: number; s: number; u: number; shot: number; wx: Weather; phase: number; strike: Strike | null; lights: [number, number] | null; flash: [number, number] | null }
let curShot = -1

async function step(fs: FrameSpec, grab: "raw" | "png" | "none", muted: boolean): Promise<{ data: string; tel: string; n: number }> {
  const sh = SHOTS[fs.shot]!
  const newShot = fs.shot !== curShot
  curShot = fs.shot
  return page.evaluate(
    async ({ fs, grab, newShot, cam, muted }) => {
      const g = globalThis as unknown as Record<string, any>
      const c = g.carrier
      const v = g.__vid
      if (newShot) {
        v.memo = {}
        v.cut = true
        v.look = null
        v.camFn = (0, eval)(`(${cam})`)
      }
      v.spec = { s: fs.s, u: fs.u, t: fs.t, cam: v.camFn, lights: fs.lights, flash: fs.flash }
      Object.assign(c.weather.manual, fs.wx)
      c.daynight.manual = fs.phase
      c.daynight.manualSpeed = 0
      if (fs.strike) {
        const [, power, off, dist] = fs.strike
        const yaw = Math.atan2(c.camera.forward[0], -c.camera.forward[2])
        c.weather.forced = { t: c.net.seaTime() + 1 / 60 - 0.005, power, bearing: yaw + (off * Math.PI) / 180, dist, seed: Math.floor(power * 9973 + dist) }
      }
      const A = g.__aud
      if (A) {
        const m = c.flight.audio.mixer
        if (m.muted !== muted) {
          m.muted = muted
          m.apply()
        }
      }
      const device: GPUDevice = c.renderer.context.device
      const ctx: GPUCanvasContext = c.renderer.canvas
      if (!g.__configured) {
        g.__configured = true
        ctx.configure({ device, format: navigator.gpu.getPreferredCanvasFormat(), alphaMode: "opaque", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC })
      }
      await device.queue.onSubmittedWorkDone()
      while (c.renderer.inflight > 0) await new Promise((r) => setTimeout(r, 0))
      const drawn: { tex: GPUTexture | null } = { tex: null }
      const get = ctx.getCurrentTexture.bind(ctx)
      ctx.getCurrentTexture = () => (drawn.tex ??= get())
      const ran = g.__vc.step(1000 / 60)
      await Promise.resolve()
      ctx.getCurrentTexture = get
      // Copy the frame now: the swapchain texture is gone once the page yields (the audio await below).
      let copy: { buf: GPUBuffer; row: number; w2: number; h2: number; bgra: boolean } | null = null
      if (grab !== "none") {
        const tex = drawn.tex
        if (!tex) throw new Error(`the frame did not render (${ran} rAF callbacks)`)
        const w2 = tex.width
        const h2 = tex.height
        const row = Math.ceil((w2 * 4) / 256) * 256
        const buf = device.createBuffer({ size: row * h2, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
        const enc = device.createCommandEncoder()
        enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: row }, [w2, h2])
        device.queue.submit([enc.finish()])
        copy = { buf, row, w2, h2, bgra: tex.format === "bgra8unorm" }
      }
      // Audio: render this step's 800 samples after the step scheduled its sounds.
      if (A) {
        A.n++
        const at = (Math.floor((A.n * 800) / 128) * 128) / 48000
        const p = A.ctx.suspend(at)
        if (!A.started) {
          A.started = true
          A.done = A.ctx.startRendering()
        } else void A.ctx.resume()
        await p
      }
      const s = c.game.state.ship
      const tel = `x ${s.x.toFixed(0)} z ${s.z.toFixed(0)} pitch ${((s.pitch * 180) / Math.PI).toFixed(1)} heave ${s.heave.toFixed(1)} slam ${s.slam.toFixed(2)} kn ${(s.u / 0.5144).toFixed(0)} flash ${c.weather.flash.toFixed(2)} hour ${c.daynight.sky.hour.toFixed(2)} k ${((c.net.seaTime() - s.t) * 60).toFixed(2)} lights ${c.daynight.state.lights.toFixed(2)} sunAz ${(Math.atan2(c.daynight.sunView[0], -c.daynight.sunView[2]) * 57.3).toFixed(0)} hdg ${((s.heading * 180) / Math.PI).toFixed(0)}`
      const an = A ? A.n : 0
      if (grab === "none") {
        await device.queue.onSubmittedWorkDone()
        return { data: "", tel, n: an }
      }
      const { buf, row, w2, h2, bgra } = copy!
      await buf.mapAsync(GPUMapMode.READ)
      const src = new Uint8Array(buf.getMappedRange())
      let bytes: Uint8Array
      if (grab === "raw") {
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
      return { data: btoa(bin), tel, n: an }
    },
    { fs, grab, newShot, cam: fnSrc(sh.cam), muted },
  )
}

/** The frame spec of shot `i` at shot-local time s. */
function specAt(i: number, s: number, prevS: number | null): FrameSpec {
  const sh = SHOTS[i]!
  const dur = sh.end - sh.at
  const strike = prevS === null ? null : (sh.strikes ?? []).find((k) => s >= k[0] && prevS < k[0]) ?? null
  return { t: sh.at + s, s, u: clamp01(s / dur), shot: i, wx: sh.weather(s), phase: phaseFor(sh.hour(s)), strike, lights: sh.lights ? sh.lights(s) : null, flash: sh.flash ?? null }
}

// Setup steps hold the shot at its first preroll moment, muted.
let setupShot = 0
const holdSpec = () => specAt(setupShot, -(SHOTS[setupShot]!.pre ?? 0), null)
const director: Director = {
  js: <T,>(fn: PageFn, arg?: unknown) =>
    page.evaluate(({ src, arg }) => {
      const g = globalThis as unknown as Record<string, any>
      return (0, eval)(`(${src})`)(g.__H, arg)
    }, { src: fnSrc(fn), arg }) as Promise<T>,
  async run(sec: number) {
    for (let i = 0; i < Math.round(sec * 60); i++) await step(holdSpec(), "none", true)
  },
  async until(fn: PageFn, maxSec: number) {
    for (let i = 0; i < maxSec * 60; i++) {
      if (await director.js<boolean>(fn)) return true
      await step(holdSpec(), "none", true)
    }
    return false
  },
}

// Warm-up: under way in the dawn weather, a wake laid down, then align the clock half a ship tick off the 60 Hz grid.
setupShot = 0
for (let i = 0; i < Math.round(warm * 60); i++) await step(holdSpec(), "none", true)
const phase = await page.evaluate(() => {
  const c = (globalThis as unknown as Record<string, any>).carrier
  return (c.net.seaTime() - c.game.state.ship.t) * 60
})
const fixMs = ((((0.5 - phase) % 1) + 1) % 1) * (1000 / 60)
await page.evaluate((ms) => (globalThis as unknown as { __vc: V }).__vc.step(ms), fixMs)
console.log(`warm-up ${warm}s, tick phase ${phase.toFixed(3)} -> +${fixMs.toFixed(2)} ms`)

// The game's mixer on an offline context, rendered in lockstep from here on.
if (withAudio) {
  const ok = await page.evaluate(async () => {
    const g = globalThis as unknown as Record<string, any>
    const c = g.carrier
    const m = c.flight.audio.mixer
    const ctx = new OfflineAudioContext(2, 48000 * 300, 48000)
    m.levels = { master: 0.7, engines: 0.35, flyby: 0.5, sfx: 0.9, weapons: 1, weather: 1, ui: 0 }
    m.muted = true
    m.explosionSamples = true
    m.use(ctx)
    // The weather and weapon sounds start on the first gesture: give them one (they pick up this context).
    dispatchEvent(new PointerEvent("pointerdown"))
    g.__aud = { ctx, n: 0, started: false, done: null }
    await new Promise((r) => setTimeout(r, 2500))
    return { state: ctx.state, rate: ctx.sampleRate, weather: !!c.weather.sound?.ctx, weapons: !!c.flight.weapons.audio?.ctx }
  })
  console.log(`audio: ${JSON.stringify(ok)}`)
}

const t0 = Date.now()
const wantStills = new Set(stills.map((s) => Math.round(s * 60)))
const lastStill = stills.length ? Math.max(...wantStills) : Number.POSITIVE_INFINITY
const mid = join(out, "ship-master.mp4")
let enc: ReturnType<typeof spawn> | null = null
let encDone: Promise<number> | null = null
if (!stills.length && !only.length && opt("encode", "") !== "1") {
  enc = spawn(ffmpeg, ["-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "bgra", "-s", `${vw}x${vh}`, "-r", String(FPS), "-i", "-", "-c:v", "libx264", "-preset", "medium", "-crf", "8", "-pix_fmt", "yuv444p", mid], { stdio: ["pipe", "inherit", "inherit"] })
  encDone = new Promise<number>((r) => enc!.on("close", (code) => r(code ?? 1)))
}

if (opt("encode", "") !== "1") {
  for (let i = 0; i < SHOTS.length; i++) {
    const sh = SHOTS[i]!
    if (only.length && !only.includes(sh.name)) continue
    if (stills.length && sh.at * 60 > lastStill) break
    const ts = Date.now()
    setupShot = i
    curShot = -1
    if (sh.setup) await sh.setup(director)
    // Preroll: the shot running unseen (unmuted, so the beds and engines are up when it starts).
    const pre = Math.round((sh.pre ?? 0) * 60)
    let prevS: number | null = null
    for (let k = -pre; k < 0; k++) {
      const s = k / 60
      await step(specAt(i, s, prevS), "none", false)
      prevS = s
    }
    const first = Math.round(sh.at * 60)
    const last = Math.round(sh.end * 60)
    const kept = { shot: sh.name, loud: sh.loud ?? null, steps: [] as number[] }
    keptSteps.push(kept)
    for (let n = first; n < last; n++) {
      const s = (n - first) / 60
      const still = wantStills.has(n)
      const grab = enc ? "raw" : still ? "png" : "none"
      const r = await step(specAt(i, s, prevS), grab, false)
      prevS = s
      kept.steps.push(r.n)
      if (grab === "raw") {
        const b = Buffer.from(r.data, "base64")
        if (!enc!.stdin!.write(b)) await new Promise((res) => enc!.stdin!.once("drain", res))
      } else if (grab === "png") {
        writeFileSync(join(out, `still-${(n / 60).toFixed(2)}.png`), Buffer.from(r.data, "base64"))
        console.log(`still ${(n / 60).toFixed(2)} [${sh.name}]: ${r.tel}`)
      }
      if (tele && (n - first) % 15 === 0) console.log(`${(n / 60).toFixed(2)} [${sh.name}] ${r.tel}`)
    }
    console.log(`shot ${sh.name} ${sh.at}-${sh.end}: ${((Date.now() - ts) / 1000).toFixed(0)} s (total ${((Date.now() - t0) / 1000).toFixed(0)} s)`)
  }
}

if (enc) {
  enc.stdin!.end()
  if ((await encDone!) !== 0) throw new Error("ffmpeg failed")
  console.log(`master: ${mid} (${((Date.now() - t0) / 1000).toFixed(0)} s)`)
}

// Audio: finish the offline render, join the shots' sample ranges (short fades at the cuts), master it.
const rawAudio = join(out, "ship-game.f32")
if (withAudio && keptSteps.length && (enc || only.length)) {
  const ranges = keptSteps.map((k) => [(k.steps[0]! - 1) * SPF, k.steps.at(-1)! * SPF] as [number, number])
  writeFileSync(join(out, "ship-game.json"), JSON.stringify(keptSteps.map((k, i) => ({ shot: k.shot, loud: k.loud, samples: ranges[i]![1] - ranges[i]![0] }))))
  const total = ranges.reduce((a, r) => a + r[1] - r[0], 0)
  const meta = await page.evaluate(async (ranges) => {
    const g = globalThis as unknown as Record<string, any>
    const A = g.__aud
    void A.ctx.resume()
    const buf: AudioBuffer = await A.done
    const L = buf.getChannelData(0)
    const R = buf.getChannelData(1)
    const n = ranges.reduce((a: number, r: number[]) => a + r[1]! - r[0]!, 0)
    const outB = new Float32Array(n * 2)
    const fade = 240
    let o = 0
    for (const [a, b] of ranges as [number, number][]) {
      for (let i = a; i < b; i++) {
        const k = Math.min(1, (i - a) / fade, (b - 1 - i) / fade)
        outB[o * 2] = L[i]! * k
        outB[o * 2 + 1] = R[i]! * k
        o++
      }
    }
    g.__audioOut = outB
    let peak = 0
    for (let i = 0; i < outB.length; i++) peak = Math.max(peak, Math.abs(outB[i]!))
    return { n, peak }
  }, ranges)
  console.log(`audio: ${meta.n} frames (${(meta.n / RATE).toFixed(3)} s), peak ${(20 * Math.log10(meta.peak + 1e-9)).toFixed(1)} dBFS, expected ${total}`)
  const chunks: Buffer[] = []
  const CH = 1 << 20
  for (let i = 0; i < meta.n * 2; i += CH) {
    const b64 = await page.evaluate(
      ([i, CH]) => {
        const a = (globalThis as unknown as Record<string, any>).__audioOut as Float32Array
        const u = new Uint8Array(a.buffer, i! * 4, Math.min(CH!, a.length - i!) * 4)
        let bin = ""
        for (let j = 0; j < u.length; j += 0x8000) bin += String.fromCharCode(...u.subarray(j, j + 0x8000))
        return btoa(bin)
      },
      [i, CH],
    )
    chunks.push(Buffer.from(b64, "base64"))
  }
  writeFileSync(rawAudio, Buffer.concat(chunks))
  console.log(`audio raw: ${rawAudio}`)
}

if (opt("encode", "") === "1" || enc) await finish(mid)

/** Integrated loudness (LUFS) and true peak (dBTP) of raw stereo f32 audio, or of the sample range [from, to). */
function measure(file: string, range?: [number, number]): { i: number; tp: number } {
  const af = `${range ? `atrim=start_sample=${range[0]}:end_sample=${range[1]},` : ""}ebur128=peak=true`
  const r = spawnSync(ffmpeg, ["-hide_banner", "-nostats", "-f", "f32le", "-ar", String(RATE), "-ac", "2", "-i", file, "-af", af, "-f", "null", "-"], { encoding: "utf8" })
  const sum = r.stderr.slice(r.stderr.lastIndexOf("Summary:"))
  return { i: Number(/I:\s+(-?[\d.]+|-inf) LUFS/.exec(sum)?.[1] ?? "-70"), tp: Number(/Peak:\s+(-?[\d.]+|-inf) dBFS/.exec(sum)?.[1] ?? "-70") }
}

/**
 * The mix: the game's audio, each shot brought to its loudness (`Shot.loud`, short ramps at the cuts), under the music
 * (normalised to -16 LUFS, the game stem at its absolute shot levels plus --game-db), then one gain to -14 LUFS
 * integrated and a peak limiter for -1 dBTP (iterated, since the limiter takes a little loudness back).
 */
function master(): string | null {
  const music = opt("music", "").replace(/^~/, process.env.HOME ?? "~")
  const n = DURATION * RATE
  const mix = new Float32Array(n * 2)
  if (music) {
    // The score from --music-at, faded out over the last 0.6 s.
    // The score from --music-at seconds into the file (negative: it starts that late), faded out over the last 0.6 s;
    // under the night (CALM) it crossfades to a low-passed, ducked copy and opens again into the final hit.
    const at = Number(opt("music-at", "0"))
    const decode = (name: string, extra: string) => {
      const f = join(out, name)
      const pos = at >= 0 ? ["-ss", String(at)] : []
      const delay = at < 0 ? `adelay=${Math.round(-at * 1000)}:all=1,` : ""
      const r = spawnSync(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", ...pos, "-i", music, "-af", `aresample=${RATE},aformat=channel_layouts=stereo,${delay}${extra}apad,atrim=end=${DURATION},afade=t=out:st=${DURATION - 0.6}:d=0.6`, "-f", "f32le", "-ar", String(RATE), "-ac", "2", f], { encoding: "utf8" })
      if (r.status !== 0) throw new Error(`music: ${r.stderr}`)
      const raw = readFileSync(f)
      return { f, a: new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length)) }
    }
    const dry = decode("ship-music.f32", "")
    const wet = decode("ship-music-calm.f32", "lowpass=f=520,lowpass=f=900,volume=-4dB,")
    const m = measure(dry.f)
    const gain = Math.pow(10, (-16 - m.i) / 20)
    console.log(`music: ${m.i} LUFS -> -16 (${(20 * Math.log10(gain)).toFixed(1)} dB)`)
    const [c0, c1] = CALM
    for (let i = 0; i < Math.min(dry.a.length, wet.a.length, mix.length); i++) {
      const t = Math.floor(i / 2) / RATE
      const w = t < c0 ? clamp01((t - c0 + 0.3) / 0.3) : t < c1 - 0.12 ? 1 : 1 - clamp01((t - c1 + 0.12) / 0.12)
      mix[i] = (dry.a[i]! * (1 - w) + wet.a[i]! * w) * gain
    }
  }
  if (existsSync(rawAudio)) {
    const segs = JSON.parse(readFileSync(join(out, "ship-game.json"), "utf8")) as { shot: string; loud: number | null; samples: number }[]
    const raw = readFileSync(rawAudio)
    const a = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length))
    const extra = Number(opt("game-db", music ? "0" : "18"))
    const gains: number[] = []
    let at = 0
    for (const g of segs) {
      const m = g.loud === null ? null : measure(rawAudio, [at, at + g.samples])
      const db = m === null || !Number.isFinite(m.i) ? 0 : Math.max(-24, Math.min(24, g.loud! + extra - m.i))
      console.log(`game ${g.shot.padEnd(7)} ${m ? `${m.i.toFixed(1)} LUFS` : "-"} ${db >= 0 ? "+" : ""}${db.toFixed(1)} dB`)
      gains.push(Math.pow(10, db / 20))
      at += g.samples
    }
    const ramp = 480
    at = 0
    segs.forEach((g, k) => {
      const prev = gains[k - 1] ?? gains[k]!
      for (let i = 0; i < g.samples && at + i < n; i++) {
        const w = Math.min(1, i / ramp)
        const gain = prev + (gains[k]! - prev) * w
        mix[(at + i) * 2] = mix[(at + i) * 2]! + a[(at + i) * 2]! * gain
        mix[(at + i) * 2 + 1] = mix[(at + i) * 2 + 1]! + a[(at + i) * 2 + 1]! * gain
      }
      at += g.samples
    })
  }
  if (!music && !existsSync(rawAudio)) return null
  const pre = join(out, "ship-audio-mix.f32")
  writeFileSync(pre, Buffer.from(mix.buffer))
  const m0 = measure(pre)
  console.log(`loudness in: ${m0.i} LUFS, ${m0.tp} dBTP`)
  const lim = join(out, "ship-audio-master.f32")
  let gain = -14 - m0.i
  let m = m0
  for (let k = 0; k < 4; k++) {
    const r = spawnSync(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-f", "f32le", "-ar", String(RATE), "-ac", "2", "-i", pre, "-af", `volume=${gain.toFixed(2)}dB,alimiter=limit=0.8:attack=1:release=80:level=false:latency=true`, "-f", "f32le", lim], { encoding: "utf8" })
    if (r.status !== 0) throw new Error(`limiter: ${r.stderr}`)
    m = measure(lim)
    if (Math.abs(m.i + 14) < 0.15) break
    gain += -14 - m.i
  }
  console.log(`loudness out: ${m.i} LUFS, ${m.tp} dBTP (gain ${gain.toFixed(1)} dB)`)
  const wav = join(out, "ship-audio.wav")
  const r = spawnSync(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-f", "f32le", "-ar", String(RATE), "-ac", "2", "-i", lim, "-c:a", "pcm_f32le", wav], { encoding: "utf8" })
  if (r.status !== 0) throw new Error(`wav: ${r.stderr}`)
  return wav
}

/** Title card ("CARRIER" in the load screen's thin tracked caps, the URL under it), audio, delivery encode. */
async function finish(mid: string): Promise<void> {
  const font = readdirSync(join(dist, "assets")).find((f) => /ibm-plex-mono-latin-300-normal.*\.woff2$/.test(f))
  const card = async (html: string, name: string) => {
    const p = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1 })
    await p.goto(`${base}card-blank`)
    await p.setContent(`<style>
      @font-face { font-family: "Plex"; font-weight: 300; src: url("${base}assets/${font}") format("woff2"); }
      html, body { margin: 0; height: 100%; background: transparent; }
      body { display: grid; place-items: center; }
      .t { font: 300 ${Math.round(vh * 0.085)}px "Plex", monospace; letter-spacing: 0.62em; margin-right: -0.62em; color: #f4f7fb;
        text-shadow: 0 0 60px rgba(10, 24, 54, 0.55), 0 2px 26px rgba(10, 30, 60, 0.6), 0 1px 3px rgba(10, 30, 60, 0.45); transform: translateY(${Math.round(-vh * 0.2)}px); }
      .u { position: absolute; left: 0; right: 0; top: ${Math.round(vh * 0.385)}px; text-align: center; font: 300 ${Math.round(vh * 0.026)}px "Plex", monospace;
        letter-spacing: 0.42em; margin-right: -0.42em; color: rgba(244, 247, 251, 0.92); text-shadow: 0 0 30px rgba(10, 24, 54, 0.7), 0 1px 10px rgba(10, 30, 60, 0.8); }
    </style>${html}`)
    await p.evaluate(() => document.fonts.ready)
    const path = join(out, name)
    writeFileSync(path, await p.screenshot({ omitBackground: true }))
    await p.close()
    return path
  }
  const title = await card(`<div class="t">CARRIER</div>`, "title.png")
  const url = await card(`<div class="u">ANOMA.LY/ARCADE/CARRIER</div>`, "url.png")
  const wav = withAudio ? master() : null
  const final = join(out, "ship-day.mp4")
  const kbps = Number(opt("kbps", "11400"))
  const log = join(out, "x264-pass")
  const [tin, tdur, uin, udur] = [TITLE, 0.7, TITLE + 0.45, 0.6]
  const inputs = ["-i", mid, "-loop", "1", "-framerate", String(FPS), "-t", String(DURATION), "-i", title, "-loop", "1", "-framerate", String(FPS), "-t", String(DURATION), "-i", url]
  const graph = `[1:v]format=rgba,fade=t=in:st=${tin}:d=${tdur}:alpha=1[t];[2:v]format=rgba,fade=t=in:st=${uin}:d=${udur}:alpha=1[u];[0:v][t]overlay=0:0:shortest=1[a];[a][u]overlay=0:0:shortest=1,format=yuv420p[v]`
  const vargs = ["-filter_complex", graph, "-map", "[v]", "-c:v", "libx264", "-preset", "slower", "-profile:v", "high", "-pix_fmt", "yuv420p", "-r", String(FPS), "-b:v", `${kbps}k`, "-maxrate", `${Math.round(kbps * 1.6)}k`, "-bufsize", `${kbps * 2}k`, "-passlogfile", log]
  const run = (a: string[]) => new Promise<number>((res) => spawn(ffmpeg, ["-y", "-loglevel", "error", ...a], { stdio: "inherit" }).on("close", (c) => res(c ?? 1)))
  if ((await run([...inputs, ...vargs, "-pass", "1", "-an", "-f", "mp4", "/dev/null"])) !== 0) throw new Error("encode pass 1 failed")
  const aargs = wav ? ["-i", wav, "-map", "3:a", "-c:a", "aac", "-b:a", "256k", "-ar", "48000"] : ["-an"]
  if ((await run([...inputs, ...(wav ? ["-i", wav] : []), ...vargs, ...(wav ? aargs.slice(2) : aargs), "-t", String(DURATION), "-pass", "2", "-movflags", "+faststart", final])) !== 0) throw new Error("encode pass 2 failed")
  console.log(`video: ${final} (${(statSync(final).size / 1e6).toFixed(1)} MB)`)
}

if (logs.length) console.log(`console:\n${[...new Set(logs)].slice(0, 30).join("\n")}`)
await browser.close()
server.stop()
rmSync(helperEntry, { force: true })
