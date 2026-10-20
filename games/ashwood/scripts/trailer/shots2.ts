// Trailer v2 shots: cinematic camera moves only (free camera, player body hidden, no HUD), never the creature. Same
// deterministic recorder as v1 (scripts/trailer/lib.ts), 1920×1080 30 fps, one muted headless browser at a time.
//
//   bun scripts/trailer/shots2.ts [names...] [--preview 10]
//
// Output: captures/trailer/frames-v2/<name>/NNNNN.jpg (`--preview k`: a contact sheet of every k-th frame instead).
import type { Page } from "playwright-core"
import { mkdirSync, readdirSync, rmSync } from "node:fs"
import { ROOT, Recorder, launch, open, run, waitWorld, type Any } from "./lib"

const args = process.argv.slice(2)
const pi = args.indexOf("--preview")
const preview = pi >= 0 ? Number(args.splice(pi, 2)[1]) : 0
const Y0 = 0.16
const Y3 = 0.16 + 3 * 3.8
const DESK = Y3 + 0.76

/** [t (s), x, y (eye, world m; with `ground`, metres above the terrain), z, yaw (0 = −Z), pitch]. */
type Key = [number, number, number, number, number, number]
type Shot = {
  url: string
  ready: (p: Page) => Promise<unknown>
  frames: number
  keys?: Key[]
  ground?: boolean
  flash?: boolean
  dom?: boolean
  settle?: number
  setup?: (p: Page, rec: Recorder) => Promise<void>
}

/** Camera path on the free camera, eased in and out over the whole move (a dolly/crane with weight). */
function path(p: Page, keys: Key[], ground: boolean, flash: boolean) {
  return run(p, (a: { keys: Key[]; ground: boolean; flash: boolean }) => {
    const g = globalThis as Any
    const P = g.__ashwoodPlayer
    const T = g.__trailer
    const S = g.__ashwoodRender?.settings
    if (S) S["body.show"] = false
    P.fly = true
    P.flashlight = a.flash
    const k = a.keys.map((q) => (a.ground ? [q[0], q[1], q[2] + P.groundAt(q[1], q[3], 999), q[3], q[4], q[5]] : q))
    const end = k[k.length - 1]![0]
    let t = 0
    T.pathRun = false
    const at = (t: number) => {
      // Global ease so the move starts and stops softly, then piecewise linear through the keys.
      const u0 = Math.min(1, Math.max(0, t / end))
      const s = (u0 * u0 * (3 - 2 * u0)) * end
      let i = 0
      while (i < k.length - 2 && s > k[i + 1]![0]) i++
      const k0 = k[i]!
      const k1 = k[Math.min(i + 1, k.length - 1)]!
      const u = k1[0] > k0[0] ? Math.min(1, Math.max(0, (s - k0[0]) / (k1[0] - k0[0]))) : 0
      return k0.map((v, j) => v + (k1[j]! - v) * u)
    }
    T.hooks = [
      (dt: number) => {
        if (T.pathRun) t += dt
        const [, x, y, z, yaw, pitch] = at(t)
        P.pos.x = x
        P.pos.y = y! - 1.65
        P.pos.z = z
        P.yaw = yaw
        P.pitch = pitch
        P.vel.x = P.vel.y = P.vel.z = 0
      },
    ]
  }, { keys, ground, flash })
}
const debugWorld = (p: Page) => waitWorld(p, "__ashwoodPlayer")
/** A story chapter loaded (debug `story=`), with the hunter put to sleep: it must never be on screen. */
const storyWorld = async (p: Page) => {
  await debugWorld(p)
  await p.waitForTimeout(6000)
  await run(p, () => (globalThis as Any).__ashwoodHunter?.handle?.sleep?.())
  await p.waitForTimeout(500)
}

function mapShot(q: string): Shot {
  return {
    url: `scripts/trailer/map.html?${q}`,
    dom: true,
    ready: (p) => p.waitForFunction(() => (globalThis as Any).__mapShot?.ready, null, { timeout: 60_000 }),
    frames: 135,
    settle: 2,
    setup: async (p) => {
      await run(p, () => (globalThis as Any).__mapShot.start())
    },
  }
}

const SHOTS: Record<string, Shot> = {
  // Pines in the fog, a slow pan across the trunks.
  forest: { url: "?view=forest", ready: debugWorld, frames: 135, ground: true, keys: [[0, -70, 1.7, 175, -0.5, 0.05], [4.5, -70.6, 1.7, 175.4, -0.82, 0.05]] },
  // The south gate: the booth's sodium light on the wet road, a slow crane up to the block and the dish behind.
  gate: { url: "?view=gate", ready: debugWorld, frames: 120, ground: true, keys: [[0, -2.5, 2.2, 152, -0.05, 0.07], [4, -2.6, 4.6, 149, -0.05, 0.0]] },
  // The block from the north woods, through the pines: a slow crane down behind a trunk.
  woods: { url: "?view=forest", ready: debugWorld, frames: 120, ground: true, keys: [[0, -22.4, 6.2, -118, 2.95, -0.06], [4, -23.2, 3.6, -117, 2.98, -0.01]] },
  // The north gate standing open, from the woods: the lit block beyond it, a slow push towards the gap.
  northgate: { url: "?view=forest", ready: debugWorld, frames: 105, ground: true, keys: [[0, -20, 1.5, -98, Math.PI, 0.01], [3.5, -20, 1.5, -95.2, Math.PI, 0.01]] },
  // The logging road into the trees, locked off, low.
  road: { url: "?view=forest", ready: debugWorld, frames: 105, ground: true, flash: true, keys: [[0, -28.2, 1.1, -131, 0.1, -0.13], [3.5, -28.3, 1.1, -133.5, 0.12, -0.12]] },
  // The ground-floor corridor, empty, a slow dolly in under the tubes.
  corridor: { url: "?view=corridor", ready: debugWorld, frames: 120, keys: [[0, -13, Y0 + 1.55, 0.2, Math.PI / 2, -0.02], [4, -15.5, Y0 + 1.55, 0.2, Math.PI / 2, -0.02]] },
  // Storey 2's dark corridor, the red exit sign at the far end, locked off with a creeping push.
  exit: { url: "?view=corridor", ready: debugWorld, frames: 105, keys: [[0, -29, 5.5, 0.2, Math.PI / 2, 0], [3.5, -30.2, 5.5, 0.2, Math.PI / 2, 0]] },
  // 3-08, torchlight: low lateral dolly past Hargrove, face down at the foot of TX-1, ON AIR lit above him.
  hargrove: { url: "?view=corridor&story=tx-on", ready: storyWorld, frames: 105, flash: true, keys: [[0, 7.6, Y3 + 0.65, -10.1, -2.18, -0.1], [3.5, 8.5, Y3 + 0.7, -9.7, -2.38, -0.12]] },
  // Kessler slumped over the console: the receiver, the mic, the blood, a slow pan.
  operator: { url: "?view=corridor&story=tx-on", ready: storyWorld, frames: 105, flash: true, keys: [[0, 10.1, Y3 + 1.25, -12.1, 0.95, -0.33], [3.5, 9.8, Y3 + 1.2, -12.4, 0.68, -0.36]] },
  // Bellamy against the west wall.
  wall: { url: "?view=corridor&story=tx-on", ready: storyWorld, frames: 90, flash: true, keys: [[0, 4.4, Y3 + 1.4, -10.6, 1.0, -0.3], [3, 4.1, Y3 + 1.3, -11.4, 1.17, -0.3]] },
  // The note on the blotter, top down, a slow push: DO NOT TURN ON THE RADIO / it hears it.
  note: { url: "?view=corridor&story=after-reveal", ready: storyWorld, frames: 90, flash: true, keys: [[0, 8.4, DESK + 0.62, -13.36, 0.3, -1.22], [3, 8.41, DESK + 0.44, -13.5, 0.3, -1.32]] },
  // The clipboard's sheets on a desk in torchlight (scripts/trailer/map.html, the game's own pages): the site plan,
  // pushing onto the handwritten "Station radio silent 48 hrs".
  mapsite: mapShot("page=0&from=1024,820,0.6,-4.5&to=980,260,1.0,-2.8&light=1000,300&dur=4.5"),
  // Level 3: onto the circled 3-08, "RADIO TRAFFIC: LISTENING ROOM?".
  map308: mapShot("page=4&from=1150,640,0.72,3&to=1240,430,1.12,1.6&light=1300,450&dur=4.5"),
  // End card: ASHWOOD on the home screen's snow.
  title: {
    url: "scripts/trailer/title.html?total=4.6",
    dom: true,
    ready: (p) => p.waitForFunction(() => (globalThis as Any).__title?.ready, null, { timeout: 60_000 }),
    frames: 138,
    settle: 2,
    setup: async (p) => {
      await run(p, () => (globalThis as Any).__title.start())
    },
  },
}

const names = args.length ? args : Object.keys(SHOTS)
for (const name of names) {
  const s = SHOTS[name]
  if (!s) throw new Error(`no shot ${name}`)
  const browser = await launch()
  const t0 = Date.now()
  const dir = `${ROOT}/frames-v2/${name}`
  try {
    const { page, errors, cdp } = await open(browser, `http://localhost:5196/${s.url}`, s.ready, !s.dom)
    const rec = new Recorder(page, cdp, dir)
    await rec.start()
    if (s.keys) await path(page, s.keys, !!s.ground, !!s.flash)
    if (s.setup) await s.setup(page, rec)
    await rec.advance(s.settle ?? 50)
    await run(page, () => ((globalThis as Any).__trailer.pathRun = true))
    if (preview) {
      for (let i = 0; i < s.frames; i++) {
        if (i % preview === 0) await rec.record(1)
        else await rec.advance(1)
      }
    } else await rec.record(s.frames)
    if (errors.length) console.log(name, "errors:", errors.slice(0, 4))
  } finally {
    await browser.close()
  }
  if (preview) {
    const n = readdirSync(dir).length
    mkdirSync(`${ROOT}/scratch`, { recursive: true })
    Bun.spawnSync(["ffmpeg", "-loglevel", "error", "-y", "-i", `${dir}/%05d.jpg`, "-vf", `scale=480:-1,tile=4x${Math.ceil(n / 4)}`, "-frames:v", "1", `${ROOT}/scratch/preview-${name}.jpg`])
    rmSync(dir, { recursive: true, force: true })
  }
  console.log(name, `${s.frames} frames, ${((Date.now() - t0) / 1000).toFixed(0)} s`)
}
