// "Epic" showcase video (32 s): every weather state and the whole day-night cycle, with jets, weapons and the game's
// own audio. Extends scripts/video-weather.ts (same deterministic frame stepping on a real GPU) and runs ON hailmary
// (Mac Studio, Metal) from a snapshot copy of games/carrier with a production build in dist/:
//
//   tar games/carrier + packages/kit to ~/.cache/carrier-video/epic/arcade, then in games/carrier there:
//   bun install && bun scripts/build-id.ts && bun --bun ./node_modules/.bin/vite build
//   bun scripts/video-epic.ts --out=~/.cache/carrier-video/epic/out
//
// How: serves dist/ on localhost, opens `?seed=7` offline, replaces the page clock and requestAnimationFrame with a
// virtual one, and plays a shot list. Each shot has an optional setup (invisible steps: launch or warp a jet, end a
// flight), a preroll (the shot running unseen, so camera lag, ship motion and falling bombs settle), then its visible
// frames. Per step it sets the weather (weather.manual), the time of day (daynight.manual), lightning, jet controls
// and weapons, places the camera inside the flight module's per-frame hook (so effects, listeners and lights all see
// the video camera), steps exactly 1/60 s and copies the swapchain texture into ffmpeg. Cuts are free time skips.
//
// Audio: the game's own mixer is moved onto one OfflineAudioContext (mixer.use) that renders in lockstep with the
// video (suspend at every step's sample, resume after the step), so engines, catapults, flybys, rain, thunder, guns
// and the recorded explosions are the game's, heard from the video camera. Setup steps are muted and cut out; the
// shots' sample ranges are joined, loudness-normalised (-14 LUFS, -1 dBTP) and muxed. Nothing in the game changes.
//
// Options: --out=DIR  --size=1920x1080  --seed=7  --warm=20 (warm-up s)  --kbps=11400 (video)  --audio=0 (silent)
//          --stills=T1,T2,...  (PNG stills at those video seconds instead of the video)  --shots=a,b (only those)
//          --tele=1 (telemetry every 0.25 s while rendering stills or video)  --encode=1 (encode from the master)
//          --probe=1 (log the day-night state at a few evening hours)
// Output in --out: epic-master.mp4 (near-lossless), epic.mp4 (delivery: title, URL, audio, two-pass to stay < 50 MB).
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
const DURATION = 32
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
/** Weather from a sky level and a sea level (0 clear .. 3 heavy each); lightning only from scripted strikes. */
function wx(sky: number, sea: number): Weather {
  const w = presetAt(sky)
  const sw = presetAt(sea)
  for (const k of SEA_KEYS) w[k] = sw[k]
  w.wind = Math.max(w.wind * 0.6 + sw.wind * 0.4, sw.wind)
  w.lightning = 0
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
  act?: PageFn
  /** Page-side one-shots at shot-local times. */
  events?: [s: number, fn: PageFn][]
  strikes?: Strike[]
  /** Hear the player's jet as another player's (flyby air rush past the lens). */
  remoteAudio?: boolean
  /** Explosions heard from at most this far (m): a distant burst lands with its picture, not seconds later. */
  boomDist?: number
  /** Loudness the shot's audio is brought to before the master (LUFS over the shot); unset: left as rendered. */
  loud?: number
}

type Director = {
  js: <T = unknown>(fn: PageFn, arg?: unknown) => Promise<T>
  run: (sec: number) => Promise<void>
  until: (fn: PageFn, maxSec: number) => Promise<boolean>
  ensureJet: (kind: "hornet" | "f35") => Promise<void>
  noJet: () => Promise<void>
  /** Puts the jet in free flight at ship plan point (stbd m, fwd m), altitude y, heading = ship heading + dh (deg). */
  warp: (stbd: number, fwd: number, y: number, dh: number, speed: number) => Promise<void>
  /** As `warp`, with an absolute compass heading (deg). */
  warpWorld: (stbd: number, fwd: number, y: number, bearing: number, speed: number) => Promise<void>
  /** The F-35C on its bomb run at the island picked by `bombIsland` (stored as `__bomb`). */
  warpBomb: () => Promise<void>
  /** A jet lined up `behind` m behind the stern on the glide slope, captured by the landing autopilot. */
  landingFrom: (behind: number) => Promise<void>
}

const SHOTS: Shot[] = [
  // 1. Dawn: low over the water south of the carrier, the sun coming up behind her, the glitter path, a slow dolly.
  {
    name: "dawn",
    loud: -23,
    at: 0,
    end: 4.6,
    pre: 0.5,
    setup: async (d) => d.noJet(),
    weather: () => wx(0, 0.35),
    hour: (s) => lerp(5.95, 6.3, clamp01(s / 4.6)),
    cam: (H) => {
      const u = H.u * 0.8 + H.ease(H.u) * 0.2
      return { eye: H.W(H.ship, 192 - 14 * u, 640 - 120 * u, 5 + 3 * u), look: H.P(0, 52 + 6 * u, 40), fov: 36, clear: 3.5 }
    },
  },
  // 2. Noon: on the deck beside the catapult near the bow, the Hornet spools, burner, and the stroke fires it past.
  {
    name: "launch",
    loud: -15,
    at: 4.6,
    end: 7.7,
    pre: 1.8,
    setup: async (d) => {
      await d.noJet()
      await d.js((H) => H.c.net.op("hornet"))
    },
    weather: () => wx(0, 1.25),
    hour: () => 12.2,
    act: (H) => H.ctl({ pitch: 0, roll: 0, boost: true, throttle: 1 }),
    cam: (H) => {
      const eye = H.S(15.2 - 12, 26 + 2.4, 136)
      const jet = H.jetOn ? [H.jet.x, H.jet.y + 1.2, H.jet.z] : H.S(15.2, 28, 40)
      // A slow zoom out as the jet comes down the deck at the lens.
      return { eye, look: jet, fov: 26 + 22 * H.ease(H.u * 1.25), lag: 0.08, clear: 2 }
    },
  },
  // 3. The flyby: a lens low over the swell astern, the Hornet in burner down the wake straight at it, past, and away.
  {
    name: "flyby",
    loud: -11,
    at: 7.7,
    end: 9.7,
    pre: 0.6,
    remoteAudio: true,
    setup: async (d) => {
      await d.ensureJet("hornet")
      await d.warp(0, -800 + 235 * 1.4, 19, 180, 235)
    },
    weather: () => wx(0, 1.25),
    hour: () => 12.5,
    act: (H) => H.ctl({ pitch: 0, roll: 0, boost: true, throttle: 1 }),
    cam: (H) => {
      const eye = H.freeze("eye", () => H.P(-30, 5, -800))
      return { eye, look: [H.jet.x, H.jet.y, H.jet.z], fov: 40, lag: 0.06, clear: 3 }
    },
  },
  // 4. Golden hour: the F-35C toward the low sun, the bay doors opening, seen from below and behind.
  {
    name: "f35",
    loud: -17,
    at: 9.7,
    end: 12.3,
    pre: 0.8,
    setup: async (d) => {
      await d.ensureJet("f35")
      await d.js((H) => {
        H.w.loadout.slot = 0
        H.w.doors = 0
      })
      await d.warpWorld(600, 1500, 260, 49, 150)
    },
    weather: () => wx(0, 0.8),
    hour: (s) => lerp(17.45, 17.6, clamp01(s / 2.6)),
    act: (H) => {
      H.ctl({ pitch: 0, roll: 0, boost: false, throttle: 1 })
      if (H.s > 0.45) H.w.loadout.slot = 1
    },
    cam: (H) => {
      const u = H.u * 0.7 + H.ease(H.u) * 0.3
      const a = -2.0 - 0.75 * u
      const r = 24 - 3 * u
      return { eye: H.J(Math.sin(a) * r, -5.5 - 1.5 * u, Math.cos(a) * r), look: H.J(0, 1.4, 6), fov: 44 }
    },
  },
  // 5. The drop: under the F-35C as four bombs leave the bay and the wings.
  {
    name: "drop",
    loud: -17,
    at: 12.3,
    end: 13.4,
    pre: 0.2,
    setup: async (d) => {
      await d.ensureJet("f35")
      await d.js((H) => {
        H.w.loadout.slot = 1
        H.w.doors = 1
        H.w.loadout.bombs = H.w.loadout.spec.bombs
        H.w.loadout.launchIn = 0
      })
      await d.warpBomb()
    },
    weather: () => wx(0, 0.8),
    hour: (s) => lerp(17.7, 17.74, clamp01(s / 1.1)),
    act: (H) => {
      H.ctl({ pitch: 0, roll: 0, boost: false, throttle: 0 })
      const k = [0.12, 0.42, 0.72, 1.02].find((x: number) => H.s >= x && H.s < x + 0.05)
      if (k !== undefined) H.w.loadout.launchIn = 0
      H.fire(k !== undefined)
    },
    cam: (H) => {
      const u = H.u
      return { eye: H.J(-10 + 2 * u, -5.5, -24 + 3 * u), look: H.J(0, -3.5, 4), fov: 46 }
    },
  },
  // 6. Sunset: the bombs walk out of the water up the beach under the volcano, spouts and ground bursts.
  {
    name: "impact",
    loud: -11,
    at: 13.4,
    end: 16.0,
    pre: 5.0,
    boomDist: 110,
    weather: () => wx(0, 0.8),
    hour: (s) => lerp(17.8, 18.05, clamp01(s / 2.6)),
    act: (H) => H.ctl({ pitch: 0, roll: 0, boost: false, throttle: 0 }),
    events: [
      [
        -4.9,
        (H) => {
          const p = H.f.plane
          p.y += 1400
          Object.assign(H.f.prev, p)
        },
      ],
    ],
    cam: (H) => {
      const b = H.g.__bomb
      return { eye: [b.cx, 7, b.cz], look: [b.lx, 34 + 8 * H.u, b.lz], fov: 19, clear: 3.5 }
    },
  },
  // 7. Dusk into the storm: high and wide, orbiting, the sky running into night as the deck rolls in.
  {
    name: "gather",
    loud: -16,
    at: 16.0,
    end: 19.0,
    pre: 0.5,
    setup: async (d) => d.noJet(),
    weather: (s) => wx(3 * ramp(s, 0, 2.7), 0.9 + 1.4 * ramp(s, 0.2, 3)),
    hour: (s) => lerp(18.05, 18.62, clamp01(s / 3)),
    cam: (H) => {
      const u = H.u
      return { eye: H.W(H.ship, 215 + 9 * u, 900 - 40 * u, 150 - 15 * u), look: H.P(0, 10, 60), fov: 44 }
    },
  },
  // 8. Night storm: low off the bow, the carrier rearing and slamming, lightning lighting her up.
  {
    name: "storm",
    loud: -13,
    at: 19.0,
    end: 22.0,
    pre: 0.4,
    setup: async (d) => {
      await d.noJet()
      await d.js((H) => {
        const s = H.c.game.state.ship
        s.u = 22
        s.power = s.order = 0.95
        H.c.game.state.helm.order = 0.95
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
      }, 90)
      console.log(`storm: big set ${ok ? "found" : "not found"}`)
    },
    weather: () => wx(3, 3),
    hour: () => 19.7,
    strikes: [
      [0.3, 1, 4, 1300],
      [1.75, 1, -9, 1500],
      [2.55, 0.8, 14, 2200],
    ],
    cam: (H) => {
      const u = H.u
      return { eye: H.P(-170 - 30 * u, 26, 520 - 40 * u), look: H.P(0, 46, 20), fov: 30, clear: 8, shake: 1 }
    },
  },
  // 9. Storm combat: a Hornet tears past low over the sea, guns and flares, a missile off its rail, lightning behind.
  {
    name: "combat",
    loud: -12,
    at: 22.0,
    end: 24.4,
    pre: 0.6,
    remoteAudio: true,
    setup: async (d) => {
      await d.ensureJet("hornet")
      await d.js((H) => {
        H.w.loadout.slot = 0
      })
      await d.warp(-116, -142, 60, 20, 175)
    },
    weather: () => wx(3, 2.8),
    hour: () => 21.0,
    strikes: [[0.9, 1, 4, 2000]],
    act: (H) => {
      H.ctl({ pitch: 0, roll: 0, boost: true, throttle: 1 })
      H.fire(H.s > 0.05 && H.s < 0.75)
      if (H.s > 1.2 && H.s < 1.22) H.flare()
      if (H.s > 0.85 && H.s < 0.9) H.w.loadout.slot = 1
      if (H.s > 0.95) H.fire(H.s < 1.0)
    },
    cam: (H) => {
      const eye = H.freeze("eye", () => H.P(-140, 34, 120))
      return { eye, look: [H.jet.x, H.jet.y, H.jet.z], fov: 40, lag: 0.16, clear: 6 }
    },
  },
  // 10. Clear night: the Milky Way standing up from the horizon over the carrier's deck lights.
  {
    name: "stars",
    loud: -23,
    at: 24.4,
    end: 25.5,
    pre: 4,
    setup: async (d) => d.noJet(),
    weather: () => wx(0, 1.0),
    hour: () => 25.2,
    cam: (H) => {
      const u = H.u
      const eye = H.W(H.ship, 125 + 4 * u, 420 - 10 * u, 7)
      const az = (-55 * Math.PI) / 180
      const el = ((26 - 4 * u) * Math.PI) / 180
      return { eye, look: [eye[0] + Math.sin(az) * Math.cos(el) * 1000, eye[1] + Math.sin(el) * 1000, eye[2] - Math.cos(az) * Math.cos(el) * 1000], fov: 72, clear: 4 }
    },
  },
  // 11. Moonlight: silver glitter on the sea, the carrier and the volcano against the moon.
  {
    name: "moon",
    loud: -22,
    at: 25.5,
    end: 26.7,
    pre: 0.5,
    setup: async (d) => {
      await d.noJet()
      await d.run(0.1)
      await d.js((H) => {
        const m = H.c.daynight.stars as number[]
        const n = [0.35, 0.55, 0.76]
        const l = Math.hypot(n[0]!, n[1]!, n[2]!)
        const w = [0, 1, 2].map((r) => (m[r]! * n[0]! + m[3 + r]! * n[1]! + m[6 + r]! * n[2]!) / l)
        const mv = H.c.daynight.moonView as number[]
        const az = (v: number[]) => ((Math.atan2(v[0]!, -v[2]!) * 180) / Math.PI).toFixed(0)
        const el = (v: number[]) => ((Math.asin(v[1]!) * 180) / Math.PI).toFixed(0)
        // Highest point of the band: up minus its component along the band's normal.
        const hb = [-w[1]! * w[0]!, 1 - w[1]! * w[1]!, -w[1]! * w[2]!]
        const hl = Math.hypot(hb[0]!, hb[1]!, hb[2]!)
        console.log(`[video] moon az ${az(mv)} el ${el(mv)}; band normal az ${az(w)} el ${el(w)}; band top az ${az(hb.map((x) => x / hl))} el ${el(hb.map((x) => x / hl))}`)
      })
    },
    weather: () => wx(0, 1.1),
    hour: () => 25.2,
    cam: (H) => {
      const u = H.u
      const eye = H.W(H.ship, 196 + 8 * u, 520, 9)
      const look = H.P(0, 60, 0)
      return { eye, look: [look[0], look[1] + 90, look[2]], fov: 60, clear: 4 }
    },
  },
  // 11. Night trap: a Hornet on final, nav lights and strobes, onto the floodlit deck and into the wires.
  {
    name: "trap",
    loud: -15,
    at: 26.7,
    end: 29.0,
    pre: 0.3,
    setup: async (d) => {
      await d.ensureJet("hornet")
      await d.landingFrom(1400)
      // Fly the approach unseen until the jet is ~1.6 s from the wires.
      if (!(await d.until((H) => H.f.landing && H.f.landing.z > -120 - 70 * 1.9, 40))) console.log("warning: the approach never got close")
    },
    weather: () => wx(0, 1.1),
    hour: () => 25.6,
    cam: (H) => {
      const eye = H.J(9, 3.5, -30)
      return { eye, look: H.J(0, 0, 40), fov: 50, clear: 3 }
    },
  },
  // 12. Dawn, fast: high and wide over the carrier and the archipelago, the sky running up to sunrise; the title.
  {
    name: "title",
    loud: -26,
    at: 29.0,
    end: 32.0,
    pre: 0.5,
    setup: async (d) => d.noJet(),
    weather: () => wx(0, 0.5),
    hour: (s) => lerp(28.55, 30.35, ease(clamp01(s / 3)) * 0.4 + clamp01(s / 3) * 0.6),
    cam: (H) => {
      const u = H.u
      return { eye: H.W(H.ship, 186, 1250 - 150 * u, 70 + 25 * u), look: H.P(0, 380 + 40 * u, 1400), fov: 46 }
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
  ship.heading = Math.atan2(-sx, sz)
  // Start well back along the course (the heading runs at the centrepiece island) and at 30 kn, so ~2 min of game
  // time never reaches its reef.
  ship.x -= Math.sin(ship.heading) * 1600
  ship.z += Math.cos(ship.heading) * 1600
  ship.u = 15.4
  ship.power = 0.65
  ship.order = 0.65
  c.game.state.helm.order = 0.65
  c.lab.frame = () => {}
  c.weather.manual = { ...c.weather.current }
  const D = 180 / Math.PI
  const f = c.flight.flight
  const w = c.flight.weapons

  // Jet controls: the stick override plus throttle and burner.
  const ctl: { pitch: number; roll: number; yaw?: number; throttle: number | null; boost: boolean | null } = { pitch: 0, roll: 0, throttle: null, boost: null }
  const input = c.flight.input
  const oc = input.controls.bind(input)
  input.controls = (dt: number, o: Record<string, any>) => {
    oc(dt, o)
    if (ctl.throttle !== null) o.throttle = ctl.throttle
    if (ctl.boost !== null) o.boost = ctl.boost
    return o
  }

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
    f,
    w,
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
    /** Jet heading frame: right, up, forward metres from the jet as drawn. */
    J: (x: number, y: number, z: number) => {
      const p = f.draw
      const h = Math.atan2(2 * (p.qx * p.qz + p.qw * p.qy), -(1 - 2 * (p.qx * p.qx + p.qy * p.qy)))
      return [p.x + Math.cos(h) * x + Math.sin(h) * z, p.y + y, p.z + Math.sin(h) * x - Math.cos(h) * z]
    },
    freeze: (k: string, fn: () => any) => (v.memo[k] ??= fn()),
    ctl: (o: { pitch: number; roll: number; yaw?: number; throttle?: number; boost?: boolean }) => {
      input.override = { pitch: o.pitch, roll: o.roll, yaw: o.yaw }
      ctl.throttle = o.throttle ?? null
      ctl.boost = o.boost ?? null
    },
    fire: (on: boolean) => (w.input.trigger = on),
    flare: () => (w.wantFlares = true),
    /** The bomb run: target the south-west shore of the nearest island with a beach, release point upwind. */
    bombIsland: () => {
      const s = H.ship
      const isl = (c.arch.islands as { x: number; z: number; radius: number; peak: number; kind: string }[])
        .filter((i) => i.radius > 250 && i.radius < 900 && i.kind !== "atoll")
        .map((i) => ({ i, d: Math.hypot(i.x - s.x, i.z - s.z) }))
        .sort((a, b) => a.d - b.d)[0]!.i
      return { isl }
    },
  }
  g.__H = H
  const wa = c.flight.weapons.audio
  const explosion = wa.explosion.bind(wa)
  wa.explosion = (dist: number, size?: number, kind?: string) => explosion(Math.min(dist, v.spec?.boomDist ?? dist), size, kind)
  // Thunder with its flash (a trailer cheat: the game delays it by the distance).
  const snd = c.weather.sound
  const strike = snd.strike.bind(snd)
  snd.strike = (st: Record<string, number>, delay: number) => strike({ ...st, dist: Math.min(st.dist, 900) }, Math.min(delay, 0.12))
  const fx = c.flight.weapons.fx
  const blast = fx.bombBlast.bind(fx)
  fx.bombBlast = (x: number, y: number, z: number, water: boolean) => {
    console.log(`[video] blast ${water ? "water" : "land"} ${x.toFixed(0)},${y.toFixed(0)},${z.toFixed(0)} at ${(H.t ?? 0).toFixed(2)}`)
    return blast(x, y, z, water)
  }

  // Per frame, before the game: shot controls and one-shots.
  const update = c.game.update
  c.game.update = (dt: number, t: number, aspect: number) => {
    const s = v.spec
    if (s) {
      H.s = s.s
      H.u = s.u
      H.t = s.t
      if (s.act) s.act(H)
      for (const e of s.fire ?? []) e(H)
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
      H.jet = f.draw
      H.jetOn = f.phase !== "idle" && f.phase !== "crashed"
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

  // The player's jet heard as another player's (the flyby rush only plays for others' jets).
  const au = c.flight.audio
  const own = au.own.bind(au)
  const tuple = new Array(19).fill(0)
  let snap = 0
  au.own = (fl: Record<string, any> | null, pose: Record<string, any> | null) => {
    if (!v.spec?.remoteAudio || !fl || fl.phase !== "flying" || !pose) return own(fl, pose)
    own(null, null)
    const p = fl.draw
    snap += 1
    tuple[0] = Math.floor(snap / 3) / 20
    tuple[1] = 1
    tuple[9] = p.vx
    tuple[10] = p.vy
    tuple[11] = p.vz
    au.remote(99, { ...pose, kind: fl.vehicle, burner: pose.burner, throttle: pose.throttle }, tuple)
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

type FrameSpec = { t: number; s: number; u: number; shot: number; wx: Weather; phase: number; strike: Strike | null; fire: string[] }
let curShot = -1

async function step(fs: FrameSpec, grab: "raw" | "png" | "none", muted: boolean): Promise<{ data: string; tel: string; n: number }> {
  const sh = SHOTS[fs.shot]!
  const newShot = fs.shot !== curShot
  curShot = fs.shot
  return page.evaluate(
    async ({ fs, grab, newShot, cam, act, muted, remote, boomDist }) => {
      const g = globalThis as unknown as Record<string, any>
      const c = g.carrier
      const v = g.__vid
      if (newShot) {
        v.memo = {}
        v.cut = true
        v.look = null
        v.camFn = (0, eval)(`(${cam})`)
        v.actFn = act ? (0, eval)(`(${act})`) : null
      }
      v.spec = { s: fs.s, u: fs.u, t: fs.t, cam: v.camFn, act: v.actFn, remoteAudio: remote, boomDist, fire: fs.fire.map((f: string) => (0, eval)(`(${f})`)) }
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
      const f = c.flight.flight
      const e = c.camera.eye
      const jet = f.phase === "idle" ? "" : ` jet ${f.vehicle} ${f.phase} d ${Math.hypot(f.draw.x - e[0], f.draw.y - e[1], f.draw.z - e[2]).toFixed(0)} y ${f.draw.y.toFixed(0)} spd ${Math.hypot(f.draw.vx, f.draw.vy, f.draw.vz).toFixed(0)} doors ${c.flight.weapons.doors.toFixed(2)} bombs ${c.flight.weapons.loadout.bombs}`
      const tel = `x ${s.x.toFixed(0)} z ${s.z.toFixed(0)} pitch ${((s.pitch * 180) / Math.PI).toFixed(1)} heave ${s.heave.toFixed(1)} slam ${s.slam.toFixed(2)} kn ${(s.u / 0.5144).toFixed(0)} flash ${c.weather.flash.toFixed(2)} hour ${c.daynight.sky.hour.toFixed(2)} k ${((c.net.seaTime() - s.t) * 60).toFixed(2)}${jet}`
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
    { fs, grab, newShot, cam: fnSrc(sh.cam), act: sh.act ? fnSrc(sh.act) : null, muted, remote: sh.remoteAudio === true, boomDist: sh.boomDist ?? null },
  )
}

/** The frame spec of shot `i` at shot-local time s. */
function specAt(i: number, s: number, prevS: number | null): FrameSpec {
  const sh = SHOTS[i]!
  const dur = sh.end - sh.at
  const strike = prevS === null ? null : (sh.strikes ?? []).find((k) => s >= k[0] && prevS < k[0]) ?? null
  const fire = prevS === null ? [] : (sh.events ?? []).filter((e) => s >= e[0] && prevS < e[0]).map((e) => fnSrc(e[1]))
  return { t: sh.at + s, s, u: clamp01(s / dur), shot: i, wx: sh.weather(s), phase: phaseFor(sh.hour(s)), strike, fire }
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
  async noJet() {
    const phase = await director.js<string>((H) => (H.c.flight.ctx ? H.f.phase : "idle"))
    if (phase === "idle") return
    // Fly it into the sea far from everything; the recovery puts the pilot back on deck without a jet.
    await director.js((H) => {
      const f = H.f
      const p = f.plane
      const s = H.c.game.state.ship
      Object.assign(p, { x: s.x + 6000, y: -40, z: s.z + 6000, vx: 0, vy: -50, vz: 0, crashed: "" })
      Object.assign(f.prev, p)
      if (f.phase !== "flying") f.phase = "flying"
      f.landing = null
    })
    if (!(await director.until((H) => !H.c.flight.ctx || H.f.phase === "idle", 8))) throw new Error(`the jet never recovered (${await director.js((H) => H.f.phase)})`)
    await director.run(0.2)
  },
  async ensureJet(kind) {
    const st = await director.js<{ phase: string; vehicle: string }>((H) => ({ phase: H.c.flight.ctx ? H.f.phase : "idle", vehicle: H.f.vehicle }))
    if ((st.phase === "flying" || st.phase === "landing") && st.vehicle === kind) return
    await director.noJet()
    await director.js((H, k) => H.c.net.op(k), kind)
    if (!(await director.until((H) => H.f.phase === "flying", 10))) throw new Error(`no ${kind} launch (${JSON.stringify(await director.js((H) => [H.f.phase, H.c.net.refused]))})`)
    await director.run(0.5)
  },
  async warp(stbd, fwd, y, dh, speed) {
    await director.js(
      (H, a) => {
        const s = H.c.game.state.ship
        const f = H.f
        const p = f.plane
        const h = s.heading + (a.dh * Math.PI) / 180
        const x = s.x + Math.sin(s.heading) * a.fwd + Math.cos(s.heading) * a.stbd
        const z = s.z - Math.cos(s.heading) * a.fwd + Math.sin(s.heading) * a.stbd
        Object.assign(p, { x, y: a.y, z, vx: a.speed * Math.sin(h), vy: 0, vz: -a.speed * Math.cos(h), p: 0, r: 0, w: 0, throttle: 0.75, crashed: "", blend: 1, stall: 0, outside: 0 })
        const qa = (Math.PI - h) / 2
        Object.assign(p, { qx: 0, qy: Math.sin(qa), qz: 0, qw: Math.cos(qa) })
        Object.assign(f.prev, p)
        f.phase = "flying"
        f.airborne = 10
        f.landing = null
        f.noCapture = 30
      },
      { stbd, fwd, y, dh, speed },
    )
  },
  async warpWorld(stbd, fwd, y, bearing, speed) {
    const h = await director.js<number>((H) => H.c.game.state.ship.heading)
    await director.warp(stbd, fwd, y, bearing - (h * 180) / Math.PI, speed)
  },
  async warpBomb() {
    // Four bombs 0.3 s apart from 220 m at 140 m/s, walking from the water up the beach of the nearest big island (on
    // the side facing the ship), the run angled 40 degrees into the shore; the camera sits low on the water 420 m out.
    await director.js((H) => {
      const g = H.g
      const i = H.bombIsland().isl
      const b = (g.__bomb = { isl: i } as Record<string, any>)
      const s = H.c.game.state.ship
      let dx = s.x - i.x
      let dz = s.z - i.z
      const l = Math.hypot(dx, dz)
      dx /= l
      dz /= l
      let r = i.radius * 0.3
      while (r < i.radius * 2 && H.terrain(i.x + dx * r, i.z + dz * r) > 0) r += 4
      const sx = i.x + dx * r
      const sz = i.z + dz * r
      const ang = (25 * Math.PI) / 180
      const hx = -dx * Math.cos(ang) + dz * Math.sin(ang)
      const hz = -dz * Math.cos(ang) - dx * Math.sin(ang)
      const V = 140
      const Y = 220
      const T = (-4 + Math.sqrt(16 + 2 * 9.81 * Y)) / 9.81
      const range = V * T * 0.985
      const t1x = sx + dx * 110
      const t1z = sz + dz * 110
      b.rx = t1x - hx * range
      b.rz = t1z - hz * range
      b.h = Math.atan2(hx, -hz)
      const mx = t1x + hx * 63
      const mz = t1z + hz * 63
      const ca = (-28 * Math.PI) / 180
      const cx = dx * Math.cos(ca) - dz * Math.sin(ca)
      const cz = dz * Math.cos(ca) + dx * Math.sin(ca)
      b.cx = mx + cx * 700
      b.cz = mz + cz * 700
      b.lx = mx - dx * 30
      b.lz = mz - dz * 30
      const f = H.f
      const p = f.plane
      Object.assign(p, { x: b.rx, y: Y, z: b.rz, vx: V * Math.sin(b.h), vy: 0, vz: -V * Math.cos(b.h), p: 0, r: 0, w: 0, throttle: 0.75, crashed: "", blend: 1, stall: 0, outside: 0 })
      const qa = (Math.PI - b.h) / 2
      Object.assign(p, { qx: 0, qy: Math.sin(qa), qz: 0, qw: Math.cos(qa) })
      Object.assign(f.prev, p)
      f.phase = "flying"
      f.airborne = 10
      f.landing = null
      f.noCapture = 30
      console.log(`[video] bomb run: island ${i.kind} r ${i.radius.toFixed(0)} shore ${sx.toFixed(0)},${sz.toFixed(0)} first ${t1x.toFixed(0)},${t1z.toFixed(0)} fall ${T.toFixed(2)} s`)
    })
  },
  async landingFrom(behind: number) {
    // Lined up behind the stern, 90 m over the deck, closing at 120 m/s: the landing autopilot captures and flies it.
    await director.js(
      (H, behind) => {
        const s = H.c.game.state.ship
        const f = H.f
        const p = f.plane
        const fz = -165 - behind
        const fx = 15.2
        const F = [Math.sin(s.heading), -Math.cos(s.heading)]
        const L = [-Math.cos(s.heading), -Math.sin(s.heading)]
        const x = s.x + F[0]! * fz + L[0]! * fx
        const z = s.z + F[1]! * fz + L[1]! * fx
        const V = 120 + s.u
        Object.assign(p, { x, y: 26 + 90, z, vx: V * F[0]!, vy: 0, vz: V * F[1]!, p: 0, r: 0, w: 0, throttle: 0.75, crashed: "", blend: 1, stall: 0, outside: 0 })
        const qa = (Math.PI - s.heading) / 2
        Object.assign(p, { qx: 0, qy: Math.sin(qa), qz: 0, qw: Math.cos(qa) })
        Object.assign(f.prev, p)
        f.phase = "flying"
        f.airborne = 10
        f.landing = null
        f.noCapture = 0
        H.ctl({ pitch: 0, roll: 0 })
      },
      behind,
    )
    if (!(await director.until((H) => H.f.phase === "landing", 3))) console.log("warning: the landing autopilot did not capture")
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
    m.levels = { ...m.levels, master: 0.7, engines: 0.35, flyby: 0.5, sfx: 0.9, weapons: 1, weather: 1 }
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

if (opt("probe", "") === "1") {
  for (const h of [18.5, 19, 19.3, 19.6, 19.8, 20, 20.5, 21]) {
    const fs = { ...specAt(7, 0, null), phase: phaseFor(h) }
    await step(fs, "none", true)
    await step(fs, "none", true)
    console.log(`probe ${h}: ${JSON.stringify(await page.evaluate(() => (globalThis as unknown as Record<string, any>).carrier.daynight.state))}`)
  }
}

const t0 = Date.now()
const wantStills = new Set(stills.map((s) => Math.round(s * 60)))
const lastStill = stills.length ? Math.max(...wantStills) : Number.POSITIVE_INFINITY
const mid = join(out, "epic-master.mp4")
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
const rawAudio = join(out, "epic-audio.f32")
if (withAudio && keptSteps.length && (enc || only.length)) {
  const ranges = keptSteps.map((k) => [(k.steps[0]! - 1) * SPF, k.steps.at(-1)! * SPF] as [number, number])
  writeFileSync(join(out, "epic-audio.json"), JSON.stringify(keptSteps.map((k, i) => ({ shot: k.shot, loud: k.loud, samples: ranges[i]![1] - ranges[i]![0] }))))
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
 * The master: each shot brought to its loudness (`Shot.loud`, short ramps at the cuts), the title hit, then one gain to
 * -14 LUFS integrated and a peak limiter for -1 dBTP (iterated, since the limiter takes a little loudness back).
 */
function master(): string | null {
  if (!existsSync(rawAudio)) return null
  const segs = JSON.parse(readFileSync(join(out, "epic-audio.json"), "utf8")) as { shot: string; loud: number | null; samples: number }[]
  const raw = readFileSync(rawAudio)
  const a = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length))
  const gains: number[] = []
  let at = 0
  for (const g of segs) {
    const m = g.loud === null ? null : measure(rawAudio, [at, at + g.samples])
    const db = m === null || !Number.isFinite(m.i) ? 0 : Math.max(-12, Math.min(24, g.loud! - m.i))
    console.log(`audio ${g.shot.padEnd(7)} ${m ? `${m.i.toFixed(1)} LUFS` : "-"} ${db >= 0 ? "+" : ""}${db.toFixed(1)} dB`)
    gains.push(Math.pow(10, db / 20))
    at += g.samples
  }
  const ramp = 480
  at = 0
  segs.forEach((g, k) => {
    const prev = gains[k - 1] ?? gains[k]!
    for (let i = 0; i < g.samples; i++) {
      const w = Math.min(1, i / ramp)
      const gain = prev + (gains[k]! - prev) * w
      a[(at + i) * 2] = a[(at + i) * 2]! * gain
      a[(at + i) * 2 + 1] = a[(at + i) * 2 + 1]! * gain
    }
    at += g.samples
  })
  const shots = join(out, "epic-audio-shots.f32")
  writeFileSync(shots, Buffer.from(a.buffer))
  // The title hit: the game's recorded distant rumble and a bomb burst (public/sfx/boom), low-passed, under the title.
  const hit = join(out, "epic-audio-hit.f32")
  const sfx = join(dist, "sfx/boom")
  const t = 29950
  const ph = spawnSync(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-f", "f32le", "-ar", String(RATE), "-ac", "2", "-i", shots, "-i", join(sfx, "far-1.mp3"), "-i", join(sfx, "bomb-water-2.mp3"),
    "-filter_complex", `[1:a]aresample=${RATE},aformat=channel_layouts=stereo,volume=1.6,adelay=${t}|${t}[r];[2:a]aresample=${RATE},aformat=channel_layouts=stereo,lowpass=f=900,volume=0.6,adelay=${t - 30}|${t - 30}[b];[0:a][r][b]amix=inputs=3:duration=first:normalize=0[o]`,
    "-map", "[o]", "-f", "f32le", "-ar", String(RATE), "-ac", "2", hit], { encoding: "utf8" })
  if (ph.status !== 0) throw new Error(`title hit: ${ph.stderr}`)
  const m0 = measure(hit)
  console.log(`loudness in: ${m0.i} LUFS, ${m0.tp} dBTP`)
  const lim = join(out, "epic-audio-master.f32")
  let gain = -14 - m0.i
  let m = m0
  for (let k = 0; k < 4; k++) {
    const r = spawnSync(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-f", "f32le", "-ar", String(RATE), "-ac", "2", "-i", hit, "-af", `volume=${gain.toFixed(2)}dB,alimiter=limit=0.8:attack=1:release=80:level=false:latency=true`, "-f", "f32le", lim], { encoding: "utf8" })
    if (r.status !== 0) throw new Error(`limiter: ${r.stderr}`)
    m = measure(lim)
    if (Math.abs(m.i + 14) < 0.15) break
    gain += -14 - m.i
  }
  console.log(`loudness out: ${m.i} LUFS, ${m.tp} dBTP (gain ${gain.toFixed(1)} dB)`)
  const wav = join(out, "epic-audio.wav")
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
  const final = join(out, "epic.mp4")
  const kbps = Number(opt("kbps", "11400"))
  const log = join(out, "x264-pass")
  const [tin, tdur, uin, udur] = [29.95, 1.1, 30.6, 0.9]
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
