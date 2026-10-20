// Records the trailer's shots from the real game, deterministically (scripts/trailer/lib.ts: stepped clock, seeded
// random, TAA and grain on), at 1920×1080 30 fps, one headless browser at a time, muted.
//
//   bun scripts/trailer/shots.ts drive gate corridor ...   [--preview 10]   (all shots when none given)
//
// Output: captures/trailer/shots/<name>.mp4 (and the frames in captures/trailer/frames/<name>/). `--preview k` keeps
// only every k-th frame as a contact sheet (captures/trailer/preview-<name>.jpg) and skips the encode.
import type { Page } from "playwright-core"
import { mkdirSync, readdirSync, rmSync } from "node:fs"
import { ROOT, Recorder, launch, open, run, waitWorld, type Any } from "./lib"

const args = process.argv.slice(2)
const pi = args.indexOf("--preview")
const preview = pi >= 0 ? Number(args.splice(pi, 2)[1]) : 0
const Y3 = 0.16 + 3 * 3.8
const Y2 = 0.16 + 2 * 3.8

type Key = [t: number, x: number, y: number, z: number, yaw: number, pitch: number]
type Shot = {
  url: string
  /** Keep the page's DOM visible (the end card is DOM); otherwise only the game canvas shows. */
  dom?: boolean
  ready: (p: Page) => Promise<unknown>
  frames: number
  settle?: number
  setup?: (p: Page, rec: Recorder) => Promise<void>
  each?: (p: Page, i: number) => Promise<void>
}

/** Installs a camera path (eye positions, smoothstepped between keys) driving the player each step. `fly`: the free
 *  camera with the body hidden; else the walking player (feet placed under the eye, body shown). */
function path(p: Page, keys: Key[], opts: { fly?: boolean; flash?: boolean; ease?: boolean } = {}) {
  return run(p, (a: { keys: Key[]; fly: boolean; flash: boolean; ease: boolean }) => {
    const g = globalThis as Any
    const P = g.__ashwoodPlayer
    const T = g.__trailer
    const S = g.__ashwoodRender?.settings
    if (S && a.fly) S["body.show"] = false
    P.fly = a.fly
    P.flashlight = a.flash
    let t = 0
    T.pathT = () => t
    T.pathRun = false
    const at = (t: number) => {
      const k = a.keys
      let i = 0
      while (i < k.length - 2 && t > k[i + 1]![0]) i++
      const k0 = k[i]!
      const k1 = k[Math.min(i + 1, k.length - 1)]!
      let u = k1[0] > k0[0] ? Math.min(1, Math.max(0, (t - k0[0]) / (k1[0] - k0[0]))) : 0
      if (a.ease) u = u * u * (3 - 2 * u)
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
  }, { keys, fly: opts.fly ?? true, flash: opts.flash ?? false, ease: opts.ease ?? true })
}
const go = (p: Page) => run(p, () => ((globalThis as Any).__trailer.pathRun = true))
const key = (p: Page, code: string, down: boolean) => run(p, (a: { code: string; down: boolean }) => dispatchEvent(new KeyboardEvent(a.down ? "keydown" : "keyup", { code: a.code })), { code, down })
/** Yaw/pitch hold for a walking player (position left to the controller). */
const look = (p: Page, yaw: number, pitch: number, flash = true) =>
  run(p, (a: number[]) => {
    const g = globalThis as Any
    const P = g.__ashwoodPlayer
    P.fly = false
    P.flashlight = !!a[2]
    g.__trailer.hooks = [
      () => {
        P.yaw = a[0]
        P.pitch = a[1]
      },
    ]
  }, [yaw, pitch, flash ? 1 : 0])
const place = (p: Page, x: number, y: number, z: number) =>
  run(p, (a: number[]) => {
    const P = (globalThis as Any).__ashwoodPlayer
    P.fly = false
    P.pos.x = a[0]
    P.pos.y = a[1]
    P.pos.z = a[2]
    P.resetMotion()
  }, [x, y, z])
/** The 3-08 beat's interactions, as if E were pressed on them (same module instance as the game's, via Vite). */
const act = (p: Page, name: "switchOn" | "transmit" | "reveal") =>
  run(p, async (n: string) => {
    const m = await import("/src/world/interior/storeys/s3/transmitter-state.ts" as string)
    m.transmitter[n]()
  }, name)
const debugWorld = (p: Page) => waitWorld(p, "__ashwoodPlayer")
const storyWorld = async (p: Page) => {
  await debugWorld(p)
  await p.waitForTimeout(6000)
}
/** Play mode (the real game shell) started at a chapter. */
const playWorld = async (p: Page) => {
  await p.waitForFunction(() => (globalThis as Any).__ashwood?.complete && (globalThis as Any).__static, null, { timeout: 300_000 })
  await p.waitForTimeout(1500)
  await run(p, () => (globalThis as Any).__static.play())
  await p.waitForFunction(() => (globalThis as Any).__static.flow.phase === "explore", null, { timeout: 60_000 })
  await p.waitForTimeout(5000)
}

const SHOTS: Record<string, Shot> = {
  // The intro drive up the access road: pines in the headlights, the station's lights and dish ahead.
  drive: {
    url: "?intro",
    ready: (p) => waitWorld(p, "__ashwoodIntro"),
    frames: 210,
    setup: async (p, rec) => {
      await run(p, () => {
        const i = (globalThis as Any).__ashwoodIntro
        i.rate = 0
        i.seek(24)
      })
      await rec.advance(60)
      await run(p, () => ((globalThis as Any).__ashwoodIntro.rate = 1.35))
    },
  },
  // Slow push on the gate, the guard booth and the lit block behind it.
  gate: {
    url: "?view=gate",
    ready: debugWorld,
    frames: 120,
    setup: async (p) => {
      await path(p, [
        [0, -2.8, 1.75, 156, -0.07, 0.035],
        [4, -2.6, 1.85, 147, -0.08, 0.04],
      ], { ease: false })
    },
  },
  // The station block at night: a slow push on the lit windows and the entrance.
  building: {
    url: "?view=entrance",
    ready: debugWorld,
    frames: 90,
    setup: async (p) => {
      await path(p, [
        [0, 2.6, 1.5, 56, 0.03, 0.2],
        [3, 2.2, 1.6, 47, 0.0, 0.17],
      ], { ease: false })
    },
  },
  // End card: ASHWOOD on the home screen's snow.
  title: {
    url: "scripts/trailer/title.html?total=4.8",
    dom: true,
    ready: (p) => p.waitForFunction(() => (globalThis as Any).__title?.ready, null, { timeout: 60_000 }),
    frames: 144,
    settle: 2,
    setup: async (p) => {
      await run(p, () => (globalThis as Any).__title.start())
    },
  },
  // Flashlight down a tiled storey-2 corridor, walking.
  corridor: {
    url: "?view=corridor&flashlight=1",
    ready: debugWorld,
    frames: 120,
    settle: 40,
    setup: async (p, rec) => {
      await place(p, -4, Y2 + 0.02, 0.2)
      await look(p, Math.PI / 2 - 0.04, -0.06)
      await rec.advance(30)
      await key(p, "KeyW", true)
      await rec.advance(15)
    },
  },
  // 3-08 on the air: the transmitter's ON AIR lamp in the foreground, the operator slumped at the desk beyond.
  room: {
    url: "?view=corridor&story=tx-on",
    ready: storyWorld,
    frames: 90,
    setup: async (p) => {
      await path(p, [
        [0, 7.7, Y3 + 1.62, -4.9, -0.42, -0.14],
        [3, 8.1, Y3 + 1.58, -6.1, -0.36, -0.16],
      ], { ease: false })
    },
  },
  // Close on the operator's hand by the desk mic, lit by the torch.
  hand: {
    url: "?view=corridor&story=tx-on",
    ready: storyWorld,
    frames: 90,
    setup: async (p) => {
      await path(p, [
        [0, 9.55, DESK(0.5), -13.0, 0.42, -0.5],
        [3, 9.4, DESK(0.38), -13.3, 0.4, -0.52],
      ], { flash: true, ease: false })
    },
  },
  // TX POWER thrown: the hand on the switch, the ON AIR lamp flickers alight.
  switch: {
    url: "?play&start=3-08",
    ready: playWorld,
    frames: 105,
    setup: async (p, rec) => {
      await place(p, 9.7, Y3 + 0.02, -7.7)
      await look(p, -Math.PI / 2 + 0.08, -0.42, true)
      await rec.advance(40)
    },
    each: async (p, i) => {
      if (i === 8) await act(p, "switchOn")
    },
  },
  // The hand keys the desk mic.
  mic: {
    url: "?play&start=tx-on",
    ready: playWorld,
    frames: 90,
    setup: async (p, rec) => {
      await place(p, 9.0, Y3 + 0.02, -12.85)
      await look(p, 0.05, -0.42, false)
      await rec.advance(40)
    },
    each: async (p, i) => {
      if (i === 6) await act(p, "transmit")
    },
  },
  // The torn sheet on the desk: DO NOT TURN ON THE RADIO / it hears it.
  note: {
    url: "?view=corridor&story=after-reveal",
    ready: storyWorld,
    frames: 75,
    setup: async (p) => {
      await path(p, [
        [0, 8.4, DESK(0.6), -13.35, 0.3, -1.2],
        [2.5, 8.41, DESK(0.42), -13.5, 0.3, -1.3],
      ], { flash: true, ease: false })
    },
  },
  // Death Lab: the Wendigo's charge down the storey-3 corridor.
  charge: {
    url: "death-lab.html?place=corridor&clean=1",
    ready: (p) => p.waitForFunction(() => (globalThis as Any).__deathLab?.ready, null, { timeout: 300_000 }),
    frames: 150,
    settle: 30,
    each: async (p, i) => {
      if (i === 0) await run(p, () => (globalThis as Any).__deathLab.play("charge"))
    },
  },
  // The lift ambush: the ride, the doors open on an empty lobby, then it comes in from the side.
  ambush: {
    url: "?play&start=ambush",
    ready: async (p) => {
      await p.waitForFunction(() => (globalThis as Any).__ashwood?.complete && (globalThis as Any).__static, null, { timeout: 300_000 })
      await p.waitForTimeout(1500)
      await run(p, () => (globalThis as Any).__static.play())
      await p.waitForFunction(() => (globalThis as Any).__static.flow.phase === "explore", null, { timeout: 60_000 })
      await p.waitForFunction(() => ["armed"].includes((globalThis as Any).__ashwoodAmbush?.phase), null, { timeout: 120_000 })
      await p.waitForTimeout(1500)
    },
    frames: 150,
    settle: 1,
    setup: async (p, rec) => {
      const st = (await run(p, () => (globalThis as Any).__interior.lift.state())) as Any
      await place(p, -37.85, 0.16 + st.cur * 3.8 + 0.02, 20.3)
      await look(p, 0, -0.04, false)
      await rec.advance(20)
      await run(p, (d: number) => (globalThis as Any).__interior.lift.press(String(d)), st.cur === 2 ? 1 : 2)
      // Ride (not recorded) until the car is levelling at the landing.
      for (let k = 0; k < 200; k++) {
        const ph = (await run(p, () => (globalThis as Any).__interior.lift.state().phase)) as string
        if (ph === "level" || ph === "opening") break
        await rec.advance(5)
      }
    },
    // Step out once the landing doors are open: it comes in from the side.
    each: async (p, i) => {
      if (i === 84) await key(p, "KeyW", true)
    },
  },
}
function DESK(up: number) {
  return Y3 + 0.76 + up
}

const names = args.length ? args : Object.keys(SHOTS)
mkdirSync(`${ROOT}/shots`, { recursive: true })
for (const name of names) {
  const s = SHOTS[name]
  if (!s) throw new Error(`no shot ${name}`)
  const browser = await launch()
  const t0 = Date.now()
  try {
    const { page, errors, cdp } = await open(browser, `http://localhost:5196/${s.url}`, s.ready, !s.dom)
    const rec = new Recorder(page, cdp, `${ROOT}/frames/${name}`)
    await rec.start()
    if (s.setup) await s.setup(page, rec)
    await rec.advance(s.settle ?? 45)
    await go(page)
    if (preview) {
      for (let i = 0; i < s.frames; i++) {
        if (s.each) await s.each(page, i)
        if (i % preview === 0) await rec.record(1)
        else await rec.advance(1)
      }
    } else await rec.record(s.frames, s.each ? (i) => s.each!(page, i) : undefined)
    if (errors.length) console.log(name, "errors:", errors.slice(0, 4))
  } finally {
    await browser.close()
  }
  const dir = `${ROOT}/frames/${name}`
  if (preview) {
    const n = readdirSync(dir).length
    const cols = 4
    Bun.spawnSync(["ffmpeg", "-loglevel", "error", "-y", "-i", `${dir}/%05d.jpg`, "-vf", `scale=480:-1,tile=${cols}x${Math.ceil(n / cols)}`, "-frames:v", "1", `${ROOT}/preview-${name}.jpg`])
    rmSync(dir, { recursive: true, force: true })
    console.log(name, `preview ${n} frames, ${((Date.now() - t0) / 1000).toFixed(0)} s`)
  } else {
    const r = Bun.spawnSync(["ffmpeg", "-y", "-loglevel", "error", "-framerate", "30", "-i", `${dir}/%05d.jpg`, "-c:v", "libx264", "-crf", "14", "-pix_fmt", "yuv420p", `${ROOT}/shots/${name}.mp4`])
    if (r.exitCode !== 0) console.error(r.stderr.toString())
    console.log(name, `${s.frames} frames, ${((Date.now() - t0) / 1000).toFixed(0)} s`)
  }
}
