// "Epic" showcase video (32 s), the fast renderer: the same shot list, direction and audio mastering as
// scripts/video-epic.ts, rendered through scripts/video/ in ~23 s instead of ~6 min. Runs ON hailmary (Mac Studio, Metal)
// from a snapshot build; from this machine one command syncs, builds if needed, renders and fetches:
//
//   bun scripts/video/remote.ts scripts/video-epic-fast.ts --fetch=epic.mp4 --to=captures/video
//   bun scripts/video/remote.ts scripts/video-epic-fast.ts --preview --fetch=preview/epic.mp4 --to=video-out
//   bun scripts/video/remote.ts scripts/video-epic-fast.ts --only=storm --fetch=epic-review.mp4 --to=video-out
//
// How it differs from video-epic.ts (one page.evaluate per frame, BGRA as base64 over DevTools into libx264):
// - every run of frames (a setup's unseen steps, a preroll, a shot's visible frames) is ONE page.evaluate looping in the
//   page; it waits for the GPU only when two frames are in flight;
// - each visible frame becomes `new VideoFrame(canvas)` for a hardware VideoEncoder (HEVC, VideoToolbox) and only the
//   compressed stream leaves the page, over a local WebSocket in 4 MB batches; each shot is its own stream from a fresh
//   encoder, so a shot re-rendered alone splices in bit-identically;
// - the host tees each shot into ffmpeg, which decodes it on the media engine, overlays the title cards and encodes the
//   libx264 delivery while the page keeps rendering;
// - the offline audio mix runs on separate pages (below), so the video page never waits for it;
// - start-up is deterministic (the clock stays frozen while the page loads, then a fixed number of steps) and
//   Math.random is seeded, so every run renders the same frames.
//
// Options: --out=DIR  --seed=7  --warm=20 (warm-up s)  --audio=0 (silent)  --tele=1 (telemetry every 0.25 s)
//          --preview (960x540, 30 fps: every other step captured, fast delivery encode)  --size=WxH  --fps=60|30
//          --only=shot (re-render one shot after replaying the timeline before it unseen and undrawn; splice it into the
//          last full render's per-shot streams and audio: epic-review.mp4 = spliced master + audio, no re-encode;
//          add --deliver to rebuild epic.mp4 too)
//          --master=h264:40000 | h264:qpN | hevc:K | hevc:qpN (in-page hardware encode)  --hwdec=0 (CPU-decode it)
//          --kbps=11400 (delivery)  --preset=slow (libx264 delivery preset)
//          --pages=2 (a video page and audio pages in parallel; 1: one page does both)  --audio-pages=3
//          --audio-size=480x270
//          --setup-sync=8 (muted setup steps render audio in batches of this many; 1 = every step, as video-epic.ts)
//          --stills=T1,T2,... (PNG stills at those video seconds, cut from the master after the render)
//          --truth (raw BGRA readbacks into a libx264 crf 8 4:4:4 master, epic-truth.mp4: the quality reference)
// Output in --out (--preview: in --out/preview): shots/<shot>.hevc|h264 + shots/<shot>.f32 (per-shot master video and
// audio), epic-master.mp4, epic.mp4 (H.264 High, AAC, fast start), epic-review.mp4 (--only).
import { mkdirSync, writeFileSync, existsSync, rmSync, readdirSync, statSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { spawn } from "node:child_process"
import { WEATHER_PRESETS, mixWeather, makeWeather, type Weather } from "../shared/weather"
import { phaseOfHour } from "../shared/daycycle"
import { launch, requireGpu, masterSpec, streamFormat, h264In, fileSink, procSink, teeSink, muxH264, ffmpeg, run, sec, type Session, type Sink } from "./video/core"
import { browserBudget } from "../../../scripts/browser-budget"

await using budget = browserBudget()

const args = process.argv.slice(2)
const opt = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
const flag = (k: string) => args.includes(`--${k}`) || opt(k, "") === "1"
const root = resolve(import.meta.dir, "..")
const preview = flag("preview")
// Previews live in their own folder (their shots are another size and codec, and must not be spliced into full renders).
const out = join(resolve(opt("out", join(root, "video-out")).replace(/^~/, process.env.HOME ?? "~")), preview ? "preview" : "")
const STEP_HZ = 60
const FPS = Number(opt("fps", preview ? "30" : "60"))
/** Simulation steps per captured frame (the game always steps 1/60 s). */
const EVERY = STEP_HZ / FPS
const RATE = 48000
const SPF = RATE / STEP_HZ
const [vw, vh] = opt("size", preview ? "960x540" : "1920x1080").split("x").map(Number) as [number, number]
const seed = opt("seed", "7")
const stills = opt("stills", "")
  .split(",")
  .filter(Boolean)
  .map(Number)
const only = opt("only", "")
const truth = flag("truth")
const warm = Number(opt("warm", "20"))
const tele = flag("tele")
const withAudio = opt("audio", "1") !== "0"
const master0 = masterSpec(opt("master", preview ? "h264:8000" : "hevc:40000"), "idle", vw, vh, FPS)
const fmt = streamFormat(master0)
const hwdec = opt("hwdec", "1") !== "0"
const setupSync = Number(opt("setup-sync", "8"))
/** Fixed start-up steps (a fixed count keeps runs identical; the game is ready after a handful). */
const BOOT = 60
const kbps = Number(opt("kbps", preview ? "3000" : "11400"))
const preset = opt("preset", preview ? "veryfast" : "medium")
const DURATION = 32
const shotsDir = join(out, "shots")
mkdirSync(shotsDir, { recursive: true })
if (!Number.isInteger(EVERY) || EVERY < 1) throw new Error(`--fps must divide ${STEP_HZ}`)
const T0 = performance.now()
// Any failure ends the run (an open encoder pipe or browser would otherwise keep the process alive).
const die = async (e: unknown) => {
  console.error(e)
  await budget.exit(1)
}
process.on("unhandledRejection", die)
process.on("uncaughtException", die)
const lap = (what: string) => console.log(`[${sec(T0)} s] ${what}`)

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
const logs: string[] = []

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
rmSync(helperEntry, { force: true })

type V = { step(ms: number): number; now: number; frame(ms: number, capture: boolean, key: boolean): Promise<boolean> }
type FrameSpec = { t: number; s: number; u: number; shot: number; wx: Weather; phase: number; strike: Strike | null; fire: string[] }
const fnSrc = (f: PageFn) => f.toString()
/** The frame spec of shot `i` at shot-local time s. */
function specAt(i: number, s: number, prevS: number | null): FrameSpec {
  const sh = SHOTS[i]!
  const dur = sh.end - sh.at
  const strike = prevS === null ? null : (sh.strikes ?? []).find((k) => s >= k[0] && prevS < k[0]) ?? null
  const fire = prevS === null ? [] : (sh.events ?? []).filter((e) => s >= e[0] && prevS < e[0]).map((e) => fnSrc(e[1]))
  return { t: sh.at + s, s, u: clamp01(s / dur), shot: i, wx: sh.weather(s), phase: phaseFor(sh.hour(s)), strike, fire }
}

// ---------------------------------------------------------------------------------------------------------------
// Render: per shot, its setup and preroll unseen, then its visible frames recorded into their own stream
// ---------------------------------------------------------------------------------------------------------------

const target = only ? SHOTS.findIndex((s) => s.name === only) : -1
if (only && target < 0) throw new Error(`no shot "${only}" (${SHOTS.map((s) => s.name).join(", ")})`)
if (only && !SHOTS.every((s, i) => i === target || existsSync(join(shotsDir, `${s.name}.${fmt}`)))) throw new Error("--only needs a full render in --out first")
const lastShot = only ? target : SHOTS.length - 1
const videoOnly = join(out, "epic-video.mp4")
// Full renders stream every shot into the delivery encoder as it is recorded (--only --deliver encodes from the files).
let delivery = null as Sink | null
const toDelivery: Sink[] = [{ write: (b) => delivery?.write(b), end: async () => {} }]
// --truth: raw BGRA frames (lossless readback) into the old pipeline's master encode, for quality comparisons.
const truthOut = join(out, "epic-truth.mp4")
const truthSink = truth
  ? procSink(spawn(ffmpeg, ["-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "bgra", "-s", `${vw}x${vh}`, "-r", String(FPS), "-i", "-", "-c:v", "libx264", "-preset", "medium", "-crf", "8", "-pix_fmt", "yuv444p", truthOut], { stdio: ["pipe", "inherit", "inherit"] }), true)
  : null
const shotSink = (name: string): Sink => (truthSink ? { write: (b) => truthSink.write(b), end: async () => {} } : teeSink(fileSink(join(shotsDir, `${name}.${fmt}`)), ...toDelivery))
const rawAudio = join(out, "epic-audio.f32")
const sessions: Session[] = []
const disarm = new Map<Role, () => void>()

/** The cards, then (full renders) the delivery encoder, which takes every shot's stream as it is recorded. */
async function ready(s: Session): Promise<void> {
  await card(s, `<div class="t">CARRIER</div>`, "title.png")
  await card(s, `<div class="u">ANOMA.LY/ARCADE/CARRIER</div>`, "url.png")
  if (!only && !truth) delivery = procSink(spawn(ffmpeg, deliverArgs(h264In("-", FPS, fmt, hwdec)), { stdio: ["pipe", "inherit", "inherit"] }))
  lap(truth ? "truth: raw frames into libx264 crf 8 4:4:4" : `delivery encoder ${delivery ? "streaming" : "deferred"}: libx264 ${preset} ${kbps} kbit/s; master: ${master0.codec} ${master0.quantizer == null ? `${master0.bitrate / 1000} kbit/s` : `qp ${master0.quantizer}`} in page`)
}

// Pages run in parallel, each playing the identical deterministic script: the video page records every frame with no
// audio running, and audio pages (small viewports) each render the game's mix in lockstep for a run of shots. The
// offline mix is the slow part (its DSP and a main-thread round trip per step), so it is split: an audio page replays
// the shots before its run silently and undrawn (about 1 ms a step), starts the mixer 1.5 s before its run so beds and
// engines are up, and keeps only its own shots. Events land on the same steps on every page (checked: every page's
// simulation state must match at every shot end). --pages=1: one page does both, as video-epic.ts does.
type Role = { name: string; width: number; height: number; capture: "h264" | "raw" | null; audio: boolean; from: number; to: number; audioFrom: number; ready?: (s: Session) => Promise<void> }
const pages = truth || !withAudio ? 1 : Number(opt("pages", "2"))
const [aw, ah] = opt("audio-size", "480x270").split("x").map(Number) as [number, number]
const first = only ? target : 0
/** Steps a shot runs after its setup (preroll + visible). */
function stepsOf(i: number): number {
  const sh = SHOTS[i]!
  return Math.round((sh.pre ?? 0) * 60) + Math.round(sh.end * 60) - Math.round(sh.at * 60)
}
/** Audio warm-up before a run that does not start the video: the last 1.5 s of the shot before it. */
const WARM = 90
const signatures: { shot: string; role: string; sig: string }[] = []
/**
 * Splits the shots into `n` runs of about equal length (preroll + visible steps), one per audio page. Fixed by the shot
 * list alone: where a run starts decides how its mix warms up, so the same split renders the same audio every time.
 * Audio pages draw nothing and finish well before the video page, so a rough balance is enough.
 */
function audioRuns(n: number): [number, number][] {
  const w = SHOTS.map((_, i) => (i < first || i > lastShot ? 0 : stepsOf(i)))
  const total = w.reduce((a, b) => a + b, 0)
  const runs: [number, number][] = []
  let start = first
  let acc = 0
  for (let i = first; i <= lastShot; i++) {
    acc += w[i]!
    if (runs.length < n - 1 && i < lastShot && acc >= (total * (runs.length + 1)) / n) {
      runs.push([start, i])
      start = i + 1
    }
  }
  runs.push([start, lastShot])
  return runs
}
const roles: Role[] =
  pages === 2
    ? [
        { name: "video", width: vw, height: vh, capture: "h264", audio: false, from: first, to: lastShot, audioFrom: -1, ready },
        ...audioRuns(Math.min(Number(opt("audio-pages", only ? "1" : "3")), lastShot - first + 1)).map(([a, b], k): Role => ({ name: `audio${k}`, width: aw, height: ah, capture: null, audio: true, from: a, to: b, audioFrom: Math.max(0, a - 1) })),
      ]
    : [{ name: truth ? "truth" : "video", width: vw, height: vh, capture: truth ? "raw" : "h264", audio: withAudio && !truth, from: first, to: lastShot, audioFrom: 0, ready }]
console.log(`pages: ${roles.map((r) => `${r.name} [${SHOTS[r.from]!.name}..${SHOTS[r.to]!.name}]${r.audio ? ` audio from ${SHOTS[r.audioFrom]!.name}` : ""}`).join(", ")}`)
const tAll = performance.now()
/** Audio pages are rerun after a stall (deterministic, so the rerun renders the same audio). */
async function attempt(role: Role): Promise<void> {
  for (let k = 0; ; k++) {
    try {
      return await render(role)
    } catch (e) {
      disarm.get(role)?.()
      if (!role.audio || role.capture || !String(e).includes("STALL") || k >= 3) throw e
      console.log(`${role.name}: ${String(e).split("\n")[0]}; rerunning the page`)
    }
  }
}
await Promise.all(roles.map((r) => attempt(r))).catch(die)
lap(`rendered ${roles.map((r) => r.name).join(" + ")} in ${sec(tAll)} s`)
{
  const bad = signatures.filter((x) => x.sig !== signatures.find((y) => y.shot === x.shot && y.role === roles[0]!.name)?.sig)
  if (bad.length) console.log(`WARNING: pages disagree on the simulation (audio may drift from the picture):\n${bad.map((x) => `${x.role} ${x.shot}: ${x.sig}`).join("\n")}`)
  else if (roles.length > 1) lap(`all ${roles.length} pages agree on the simulation state at every shot end`)
}
if (withAudio && !truth) {
  const segs = SHOTS.map((s) => ({ shot: s.name, loud: s.loud ?? null, samples: statSync(join(shotsDir, `${s.name}.f32`)).size / 8 }))
  writeFileSync(join(out, "epic-audio.json"), JSON.stringify(segs))
  writeFileSync(rawAudio, Buffer.concat(SHOTS.map((s) => readFileSync(join(shotsDir, `${s.name}.f32`)))))
  lap(`audio track ${(segs.reduce((a, g) => a + g.samples, 0) / RATE).toFixed(3)} s`)
}
if (truthSink) {
  await truthSink.end()
  lap(`truth: ${truthOut}`)
  for (const s of sessions) await s.shutdown()
  await budget.exit(0)
}

/** Plays the whole script on one page: video (records the shots), audio (renders the mix in lockstep) or both. */
async function render(role: Role): Promise<void> {
  const session = await launch({ dist, width: role.width, height: role.height, path: `?seed=${seed}&lab=0`, logs, quiet: !role.capture }, budget)
  // Browsers close at the very end: on macOS, Bun stops reporting child-process exits once a Playwright browser has
  // been closed (later ffmpeg runs would never resolve).
  sessions.push(session)
  const { page } = session
  // Watchdog: a page that stops making progress for 60 s reports its state and ends the run.
  let progress = performance.now()
  let finished = false
  const watch = setInterval(async () => {
    if (finished || performance.now() - progress < 60_000) return
    clearInterval(watch)
    const st = await Promise.race([
      page.evaluate(() => {
        const g = globalThis as unknown as Record<string, any>
        const A = g.__aud
        return { now: g.__vc.now, inflight: g.carrier?.renderer?.inflight, audio: A ? { n: A.n, synced: A.synced, state: A.ctx.state, time: A.ctx.currentTime } : null, rec: g.__rec.stats() }
      }),
      new Promise((r) => setTimeout(() => r("page not responding"), 5000)),
    ])
    die(new Error(`${role.name} stalled: ${JSON.stringify(st)}`))
  }, 5000)
  disarm.set(role, () => {
    finished = true
    clearInterval(watch)
  })
  await page.addScriptTag({ content: helperJs })
  const adapter = await requireGpu(page)
  if (role.capture) console.log(`adapter: ${adapter}`)

  // Deterministic start: the page loads and initialises in real time with the virtual clock frozen (no frames run until
  // the game object exists and the network is idle), then a fixed number of steps, with real pauses so pipelines and
  // assets finish compiling and loading.
  await page.waitForFunction(() => !!(globalThis as unknown as { carrier?: { game?: unknown } }).carrier?.game, null, { timeout: 120_000, polling: 50 })
  await page.waitForLoadState("networkidle")
  for (let i = 0; i < BOOT; i++) {
    await page.evaluate(() => (globalThis as unknown as { __vc: V }).__vc.step(1000 / 60))
    await page.waitForTimeout(10)
  }
  const booted = await page.evaluate(() => {
    const c = (globalThis as unknown as { carrier?: { weather?: { view: unknown }; ocean?: { tiles: number }; game?: { state: { ship: unknown } } } }).carrier
    return !!c?.weather?.view && (c.ocean?.tiles ?? 0) > 0 && !!c.game?.state.ship
  })
  if (!booted) throw new Error(`the game was not ready after ${BOOT} steps`)
  // Pages skip drawing frames nobody sees: nothing in the game reads the GPU back, so the simulation is the same (the
  // shot-end signatures check it). Audio pages never draw; a video page re-rendering one shot draws from its setup on.
  const draw = (on: boolean) =>
    page.evaluate((on) => {
      const r = (globalThis as unknown as Record<string, any>).carrier.renderer
      r.__render ??= r.render
      r.render = on ? r.__render : () => {}
    }, on)
  if (!role.capture || role.from > 0) await draw(false)
  lap(`${role.name}: game ready`)

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
  if (role.capture) console.log(`setup: ${JSON.stringify(info)}`)
  day0 = Math.floor(info.phase)

  // ---------------------------------------------------------------------------------------------------------------
  // Stepping
  // ---------------------------------------------------------------------------------------------------------------

  /** Audio step index (OfflineAudioContext suspends at step n's sample) of each kept video frame, per shot. */
  const keptSteps: { shot: string; loud: number | null; steps: number[] }[] = []

  let curShot = -1

  await page.evaluate((k) => ((globalThis as unknown as Record<string, any>).__setupSync = k), setupSync)
  // Page-side runner: one call steps a whole run of frames. Per step it applies the frame spec (weather, clock hour,
  // lightning, one-shots, mute), runs one 1/60 s game frame (recording the canvas when asked), then renders that step's
  // audio on the offline context. Shot changes reset the camera state, as in video-epic.ts.
  await page.evaluate(() => {
    const g = globalThis as unknown as Record<string, any>
    const c = g.carrier
    const v = g.__vid
    const ev = (src: string) => (0, eval)(`(${src})`)
    const apply = (fs: Record<string, any>, muted: boolean) => {
      v.spec = { s: fs.s, u: fs.u, t: fs.t, cam: v.camFn, act: v.actFn, remoteAudio: v.remote, boomDist: v.boomDist, fire: fs.fire.map(ev) }
      Object.assign(c.weather.manual, fs.wx)
      c.daynight.manual = fs.phase
      c.daynight.manualSpeed = 0
      if (fs.strike) {
        const [, power, off, dist] = fs.strike
        const yaw = Math.atan2(c.camera.forward[0], -c.camera.forward[2])
        c.weather.forced = { t: c.net.seaTime() + 1 / 60 - 0.005, power, bearing: yaw + (off * Math.PI) / 180, dist, seed: Math.floor(power * 9973 + dist) }
      }
      if (g.__aud) {
        const m = c.flight.audio.mixer
        if (m.muted !== muted) {
          m.muted = muted
          m.apply()
        }
      }
    }
    // Renders the audio up to the current step (suspend at its sample, resume, wait). Muted setup steps only sync every
    // `setupSync` steps: their audio is cut out anyway, so a few steps of scheduling slack there costs nothing heard.
    const sync = async () => {
      const A = g.__aud
      if (!A || A.synced === A.n) return
      A.synced = A.n
      const at = (Math.floor((A.n * 800) / 128) * 128) / 48000
      const p = A.ctx.suspend(at)
      if (!A.started) {
        A.started = true
        A.done = A.ctx.startRendering()
      } else void A.ctx.resume()
      // Chrome's offline renderer occasionally never restarts after a resume (it stays at the last suspend point while
      // reporting "running"; more often with several pages busy). Nothing revives it: the page fails and is rerun.
      const ok = await Promise.race([p.then(() => true), new Promise((r) => g.__vc.realTimeout(() => r(false), 1500))])
      if (!ok) throw new Error(`STALL: the offline audio context stopped at ${A.ctx.currentTime.toFixed(4)} s (${A.ctx.state}), step ${A.n}`)
    }
    const audio = async (exact: boolean) => {
      const A = g.__aud
      if (!A) return 0
      A.n++
      if (exact || A.n - A.synced >= g.__setupSync) await sync()
      return A.n
    }
    const telemetry = () => {
      const s = c.game.state.ship
      const f = c.flight.flight
      const e = c.camera.eye
      const jet = f.phase === "idle" ? "" : ` jet ${f.vehicle} ${f.phase} d ${Math.hypot(f.draw.x - e[0], f.draw.y - e[1], f.draw.z - e[2]).toFixed(0)} y ${f.draw.y.toFixed(0)} spd ${Math.hypot(f.draw.vx, f.draw.vy, f.draw.vz).toFixed(0)} doors ${c.flight.weapons.doors.toFixed(2)} bombs ${c.flight.weapons.loadout.bombs}`
      return `x ${s.x.toFixed(0)} z ${s.z.toFixed(0)} pitch ${((s.pitch * 180) / Math.PI).toFixed(1)} heave ${s.heave.toFixed(1)} slam ${s.slam.toFixed(2)} kn ${(s.u / 0.5144).toFixed(0)} flash ${c.weather.flash.toFixed(2)} hour ${c.daynight.sky.hour.toFixed(2)} k ${((c.net.seaTime() - s.t) * 60).toFixed(2)}${jet}`
    }
    const one = async (fs: Record<string, any>, muted: boolean, cap: boolean, key: boolean) => {
      apply(fs, muted)
      if (cap) await g.__rec.room()
      if (!(await g.__vc.frame(1000 / 60, cap, key)) && cap) throw new Error(`the frame at ${fs.t.toFixed(3)} s did not render`)
      return audio(!muted)
    }
    g.__epic = {
      shot(o: { cam: string; act: string | null; remote: boolean; boomDist: number | null }) {
        v.memo = {}
        v.cut = true
        v.look = null
        v.camFn = ev(o.cam)
        v.actFn = o.act ? ev(o.act) : null
        v.remote = o.remote
        v.boomDist = o.boomDist
      },
      /** Steps `list`; captures the steps flagged in `cap` (a keyframe on the first). Returns each step's audio index. */
      async frames(list: Record<string, any>[], o: { muted: boolean; cap: boolean[] | null; tele: number }) {
        const steps: number[] = []
        const tel: string[] = []
        let first = true
        for (let i = 0; i < list.length; i++) {
          const cap = o.cap?.[i] ?? false
          steps.push(await one(list[i]!, o.muted, cap, cap && first))
          if (cap) first = false
          if (o.tele && i % o.tele === 0) tel.push(`${list[i]!.t.toFixed(2)} ${telemetry()}`)
        }
        return { steps, tel }
      },
      async hold(fs: Record<string, any>, n: number) {
        for (let i = 0; i < n; i++) await one(fs, true, false, false)
        await sync()
      },
      async until(src: string, fs: Record<string, any>, max: number) {
        const fn = ev(src)
        for (let i = 0; i < max; i++) {
          if (fn(g.__H)) {
            await sync()
            return true
          }
          await one(fs, true, false, false)
        }
        await sync()
        return false
      },
      telemetry,
    }
  })

  /** Switches the page to shot `i` if it is not current (camera memo, lag and eye smoothing reset at a cut). */
  async function enter(i: number): Promise<void> {
    if (i === curShot) return
    curShot = i
    const sh = SHOTS[i]!
    await page.evaluate((o) => (globalThis as unknown as Record<string, any>).__epic.shot(o), { cam: fnSrc(sh.cam), act: sh.act ? fnSrc(sh.act) : null, remote: sh.remoteAudio === true, boomDist: sh.boomDist ?? null })
  }

  async function frames(i: number, list: FrameSpec[], muted: boolean, cap: boolean[] | null): Promise<{ steps: number[]; tel: string[] }> {
    await enter(i)
    return page.evaluate(([list, o]) => (globalThis as unknown as Record<string, any>).__epic.frames(list, o), [list, { muted, cap, tele: tele ? 15 : 0 }] as const)
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
      await enter(setupShot)
      await page.evaluate(([fs, n]) => (globalThis as unknown as Record<string, any>).__epic.hold(fs, n), [holdSpec(), Math.round(sec * 60)] as const)
    },
    async until(fn: PageFn, maxSec: number) {
      await enter(setupShot)
      return page.evaluate(([src, fs, n]) => (globalThis as unknown as Record<string, any>).__epic.until(src, fs, n), [fnSrc(fn), holdSpec(), Math.ceil(maxSec * 60)] as const)
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
  await director.run(warm)
  const phase = await page.evaluate(() => {
    const c = (globalThis as unknown as Record<string, any>).carrier
    return (c.net.seaTime() - c.game.state.ship.t) * 60
  })
  const fixMs = ((((0.5 - phase) % 1) + 1) % 1) * (1000 / 60)
  await page.evaluate((ms) => (globalThis as unknown as { __vc: V }).__vc.step(ms), fixMs)
  lap(`${role.name}: warm-up ${warm}s, tick phase ${phase.toFixed(3)} -> +${fixMs.toFixed(2)} ms`)

  // The game's mixer on an offline context, rendered in lockstep from here on.
  const installAudio = async () => {
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
      g.__aud = { ctx, n: 0, synced: 0, started: false, done: null }
      // The sound bank loads its recorded takes after that gesture: wait until every fetch and decode has finished.
      const settled = await g.__vc.settle(300, 20000)
      return { state: ctx.state, rate: ctx.sampleRate, weather: !!c.weather.sound?.ctx, weapons: !!c.flight.weapons.audio?.ctx, settled }
    })
    lap(`${role.name}: audio ${JSON.stringify(ok)}`)
  }

  if (role.capture) console.log(`recorder: ${await session.record(role.capture === "raw" ? { mode: "raw", codec: "", width: role.width, height: role.height, fps: FPS, bitrate: 0, stream: "idle" } : master0)}`)
  await role.ready?.(session)
  const tRender = performance.now()
  let captured = 0

  for (let i = 0; i <= role.to; i++) {
    const sh = SHOTS[i]!
    const seen = i >= role.from
    const ts = performance.now()
    const audioHere = role.audio && i === role.audioFrom
    // The mixer starts before this shot's setup (the first run), or WARM steps before the end of the shot before a run.
    const warmHere = audioHere && role.audioFrom < role.from && stepsOf(i) > WARM
    if (audioHere && !warmHere) await installAudio()
    if (role.capture && role.from > 0 && i === role.from) await draw(true)
    setupShot = i
    curShot = -1
    if (sh.setup) await sh.setup(director)
    const tSetup = performance.now()
    // Preroll (the shot running unseen, unmuted, so the beds and engines are up when it starts) and the visible frames,
    // in one page-side run.
    const pre = Math.round((sh.pre ?? 0) * 60)
    const first = Math.round(sh.at * 60)
    const last = Math.round(sh.end * 60)
    const list: FrameSpec[] = []
    const cap: boolean[] = []
    let prevS: number | null = null
    for (let k = -pre; k < last - first; k++) {
      const s = k / 60
      list.push(specAt(i, s, prevS))
      cap.push(seen && k >= 0 && (first + k) % EVERY === 0)
      prevS = s
    }
    const stream = `shot-${sh.name}`
    if (seen && role.capture) {
      session.open(stream, shotSink(sh.name))
      await page.evaluate((n) => (globalThis as unknown as Record<string, any>).__rec.cut(n), stream)
    }
    let r: { steps: number[]; tel: string[] }
    if (warmHere) {
      const k = list.length - WARM
      await frames(i, list.slice(0, k), false, null)
      await installAudio()
      r = await frames(i, list.slice(k), false, null)
    } else r = await frames(i, list, false, seen && role.capture ? cap : null)
    if (seen && role.capture) {
      await page.evaluate(() => (globalThis as unknown as Record<string, any>).__rec.cut("idle"))
      await session.close(stream)
      captured += cap.filter(Boolean).length
    }
    if (seen) keptSteps.push({ shot: sh.name, loud: sh.loud ?? null, steps: r.steps.slice(pre) })
    for (const line of r.tel) console.log(`[${sh.name}] ${line}`)
    // The simulation state at the end of the shot: every page must agree on it (their audio and video line up).
    signatures.push({
      shot: sh.name,
      role: role.name,
      sig: await page.evaluate(() => {
        const g = globalThis as unknown as Record<string, any>
        const s = g.carrier.game.state.ship
        const f = g.carrier.flight.flight
        const n = (x: number) => x.toFixed(3)
        return `t ${n(g.__vc.now)} ship ${n(s.x)} ${n(s.z)} ${n(s.pitch)} ${n(s.heave)} jet ${f.phase} ${n(f.draw.x)} ${n(f.draw.y)} ${n(f.draw.z)}`
      }),
    })
    progress = performance.now()
    console.log(`${role.name} ${sh.name.padEnd(7)} ${sh.at}-${sh.end}: setup ${((tSetup - ts) / 1000).toFixed(1)} s, ${pre} + ${last - first} steps ${((performance.now() - tSetup) / 1000).toFixed(1)} s${seen ? "" : " (unseen)"}`)
  }
  if (role.capture) await page.evaluate(() => (globalThis as unknown as Record<string, any>).__rec.end())
  lap(`${role.name}: ${role.capture ? `rendered ${captured} frames` : "stepped"} in ${sec(tRender)} s`)

  // Audio: finish the offline render, join the kept shots' sample ranges (short fades at the cuts), post it back.
  if (role.audio && keptSteps.length) {
    const ranges = keptSteps.map((k) => [(k.steps[0]! - 1) * SPF, k.steps.at(-1)! * SPF] as [number, number])
    session.open("audio", fileSink(join(out, `epic-audio-${role.name}.f32`)))
    const meta = await page.evaluate(async (ranges) => {
      const g = globalThis as unknown as Record<string, any>
      const A = g.__aud
      // The context still has the rest of its 300 s to render: cut the mix off the output so that costs next to nothing
      // (nothing upstream of the master is pulled any more).
      g.carrier.flight.audio.mixer.master.disconnect()
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
      let peak = 0
      for (let i = 0; i < outB.length; i++) peak = Math.max(peak, Math.abs(outB[i]!))
      await g.__rec.connect()
    g.__rec.post("audio", new Uint8Array(outB.buffer))
      await g.__rec.drain()
      return { n, peak }
    }, ranges)
    await session.close("audio")
    // Per-shot audio next to the per-shot video (the whole track is rebuilt from the shot files).
    const fresh = readFileSync(join(out, `epic-audio-${role.name}.f32`))
    rmSync(join(out, `epic-audio-${role.name}.f32`))
    let at = 0
    keptSteps.forEach((k, n) => {
      const len = (ranges[n]![1] - ranges[n]![0]) * 8
      writeFileSync(join(shotsDir, `${k.shot}.f32`), fresh.subarray(at, at + len))
      at += len
    })
    lap(`${role.name}: ${meta.n} audio frames (${(meta.n / RATE).toFixed(3)} s), peak ${(20 * Math.log10(meta.peak + 1e-9)).toFixed(1)} dBFS`)
  }

  if (logs.length) console.log(`${role.name} console:\n${[...new Set(logs)].slice(0, 30).join("\n")}`)
  finished = true
  clearInterval(watch)
}

// Master: the shot streams joined (each starts on a keyframe with its parameter sets) and wrapped without re-encoding.
const masterH264 = join(out, `epic-master.${fmt}`)
writeFileSync(masterH264, Buffer.concat(SHOTS.map((s) => readFileSync(join(shotsDir, `${s.name}.${fmt}`)))))
const mid = join(out, "epic-master.mp4")
const masterDone = muxH264(masterH264, mid, FPS, fmt)
// The audio master runs while the delivery encoder finishes the last frames.
const wav = withAudio ? await master() : null
const reencode = !only || flag("deliver")
if (delivery) await delivery.end()
else if (reencode) await run(ffmpeg, deliverArgs(h264In(masterH264, FPS, fmt, hwdec)))
await masterDone
rmSync(masterH264)
const audioArgs = wav ? ["-i", wav, "-map", "0:v", "-map", "1:a", "-c:a", "aac", "-b:a", "256k", "-ar", "48000"] : ["-an"]
if (reencode) {
  lap("delivery video encoded")
  const final = join(out, "epic.mp4")
  await run(ffmpeg, ["-y", "-loglevel", "error", "-i", videoOnly, ...audioArgs, "-c:v", "copy", "-t", String(DURATION), "-movflags", "+faststart", final])
  rmSync(videoOnly)
  lap(`video: ${final} (${(statSync(final).size / 1e6).toFixed(1)} MB)`)
} else {
  // --only: the spliced master with the spliced audio, for review (no title cards; --deliver re-encodes epic.mp4).
  const review = join(out, "epic-review.mp4")
  await run(ffmpeg, ["-y", "-loglevel", "error", "-i", mid, ...audioArgs, "-c:v", "copy", "-tag:v", fmt === "hevc" ? "hvc1" : "avc1", "-t", String(DURATION), "-movflags", "+faststart", review])
  lap(`review: ${review} (${(statSync(review).size / 1e6).toFixed(1)} MB; epic.mp4 is from the last full render, --deliver to rebuild it)`)
}
for (const t of stills) {
  await run(ffmpeg, ["-y", "-loglevel", "error", "-ss", t.toFixed(4), "-i", mid, "-frames:v", "1", join(out, `still-${t.toFixed(2)}.png`)])
}

/** Runs ffmpeg without blocking the event loop (the delivery encoder is still being fed); resolves with its stderr. */
function ff(a: string[]): Promise<{ status: number; stderr: string }> {
  return new Promise((res) => {
    const p = spawn(ffmpeg, a, { stdio: ["ignore", "ignore", "pipe"] })
    let stderr = ""
    p.stderr!.on("data", (d) => (stderr += d))
    p.on("close", (c) => res({ status: c ?? 1, stderr }))
  })
}

/** Integrated loudness (LUFS) and true peak (dBTP) of raw stereo f32 audio, or of the sample range [from, to). */
async function measure(file: string, range?: [number, number]): Promise<{ i: number; tp: number }> {
  const af = `${range ? `atrim=start_sample=${range[0]}:end_sample=${range[1]},` : ""}ebur128=peak=true`
  const r = await ff(["-hide_banner", "-nostats", "-f", "f32le", "-ar", String(RATE), "-ac", "2", "-i", file, "-af", af, "-f", "null", "-"])
  const sum = r.stderr.slice(r.stderr.lastIndexOf("Summary:"))
  return { i: Number(/I:\s+(-?[\d.]+|-inf) LUFS/.exec(sum)?.[1] ?? "-70"), tp: Number(/Peak:\s+(-?[\d.]+|-inf) dBFS/.exec(sum)?.[1] ?? "-70") }
}

/**
 * The master: each shot brought to its loudness (`Shot.loud`, short ramps at the cuts), the title hit, then one gain to
 * -14 LUFS integrated and a peak limiter for -1 dBTP (iterated, since the limiter takes a little loudness back).
 */
async function master(): Promise<string | null> {
  if (!existsSync(rawAudio)) return null
  const segs = JSON.parse(readFileSync(join(out, "epic-audio.json"), "utf8")) as { shot: string; loud: number | null; samples: number }[]
  const raw = readFileSync(rawAudio)
  const a = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length))
  const gains: number[] = []
  let at = 0
  const ms = await Promise.all(segs.map((g, k) => (g.loud === null ? null : measure(rawAudio, [segs.slice(0, k).reduce((a, x) => a + x.samples, 0), segs.slice(0, k + 1).reduce((a, x) => a + x.samples, 0)]))))
  for (const [k, g] of segs.entries()) {
    const m = ms[k] ?? null
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
  const ph = await ff(["-y", "-hide_banner", "-loglevel", "error", "-f", "f32le", "-ar", String(RATE), "-ac", "2", "-i", shots, "-i", join(sfx, "far-1.mp3"), "-i", join(sfx, "bomb-water-2.mp3"),
    "-filter_complex", `[1:a]aresample=${RATE},aformat=channel_layouts=stereo,volume=1.6,adelay=${t}|${t}[r];[2:a]aresample=${RATE},aformat=channel_layouts=stereo,lowpass=f=900,volume=0.6,adelay=${t - 30}|${t - 30}[b];[0:a][r][b]amix=inputs=3:duration=first:normalize=0[o]`,
    "-map", "[o]", "-f", "f32le", "-ar", String(RATE), "-ac", "2", hit])
  if (ph.status !== 0) throw new Error(`title hit: ${ph.stderr}`)
  const m0 = await measure(hit)
  console.log(`loudness in: ${m0.i} LUFS, ${m0.tp} dBTP`)
  const lim = join(out, "epic-audio-master.f32")
  let gain = -14 - m0.i
  let m = m0
  for (let k = 0; k < 4; k++) {
    const r = await ff(["-y", "-hide_banner", "-loglevel", "error", "-f", "f32le", "-ar", String(RATE), "-ac", "2", "-i", hit, "-af", `volume=${gain.toFixed(2)}dB,alimiter=limit=0.8:attack=1:release=80:level=false:latency=true`, "-f", "f32le", lim])
    if (r.status !== 0) throw new Error(`limiter: ${r.stderr}`)
    m = await measure(lim)
    if (Math.abs(m.i + 14) < 0.15) break
    gain += -14 - m.i
  }
  console.log(`loudness out: ${m.i} LUFS, ${m.tp} dBTP (gain ${gain.toFixed(1)} dB)`)
  const wav = join(out, "epic-audio.wav")
  const r = await ff(["-y", "-hide_banner", "-loglevel", "error", "-f", "f32le", "-ar", String(RATE), "-ac", "2", "-i", lim, "-c:a", "pcm_f32le", wav])
  if (r.status !== 0) throw new Error(`wav: ${r.stderr}`)
  return wav
}

/** A title card ("CARRIER" in the load screen's thin tracked caps, or the URL under it) as a transparent PNG. */
async function card(s: Session, html: string, name: string): Promise<string> {
  const font = readdirSync(join(dist, "assets")).find((f) => /ibm-plex-mono-latin-300-normal.*\.woff2$/.test(f))
  const base = s.base
  const p = await s.browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1 })
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

/**
 * The delivery encode from the master (`input`: ffmpeg input args): title and URL faded in over the master (kept in
 * YUV, BT.709 as WebCodecs wrote it; tagged BT.709 throughout, where Chrome tags the transfer as sRGB), libx264 High yuv420p, one pass at the target bitrate with a VBV cap so the
 * 32 s stay under 50 MB with audio. Video only; the audio is muxed afterwards.
 */
function deliverArgs(input: string[]): string[] {
  const [tin, tdur, uin, udur] = [29.95, 1.1, 30.6, 0.9]
  const img = (f: string) => ["-loop", "1", "-framerate", String(FPS), "-t", String(DURATION), "-i", f]
  const graph = `[1:v]format=rgba,fade=t=in:st=${tin}:d=${tdur}:alpha=1[t];[2:v]format=rgba,fade=t=in:st=${uin}:d=${udur}:alpha=1[u];[0:v][t]overlay=0:0:shortest=1[a];[a][u]overlay=0:0:shortest=1,format=yuv420p,setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709[v]`
  return ["-y", "-loglevel", "error", ...input, ...img(join(out, "title.png")), ...img(join(out, "url.png")), "-filter_complex", graph, "-map", "[v]",
    "-c:v", "libx264", "-preset", preset, "-profile:v", "high", "-pix_fmt", "yuv420p", "-r", String(FPS), "-b:v", `${kbps}k`, "-maxrate", `${Math.round(kbps * 1.6)}k`, "-bufsize", `${kbps * 2}k`,
    "-an", join(out, "epic-video.mp4")]
}

for (const s of sessions) await s.shutdown()
lap("done")
