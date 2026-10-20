/**
 * Stills, a contact sheet, a rain-night clip and paired GPU cost of the Details · Life touches (AR-87), one headless
 * run:
 *
 *   bun scripts/life-stills.ts --out <dir>      (via hivemind run --kind browser)
 *
 * Finds each touch in the seed-7 town from the presenter's own plan (moth lamps, fly sites, dens, washing lines,
 * open car doors, sprinklers, televisions, drip points), poses the survivor beside it and captures it by day and by
 * night; lays the stills out as `contact-sheet.png`; records a street at night after rain (`clip/NNNN.jpg`, 30 fps,
 * encoded to `rain-night.mp4` when ffmpeg is on PATH); then times "Life touches" off/on on the same frozen frame with
 * the renderer's timestamp queries. Headless Metal Chromium, muted, no visible window.
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium, type Page } from "playwright-core"
import { createServer } from "vite"

const root = resolve(import.meta.dir, "..")
const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const out = resolve(arg("out", resolve(root, "../../captures/life"))!)
const rounds = Number(arg("rounds", "8"))
const frames = resolve(out, "clip")
rmSync(out, { recursive: true, force: true })
mkdirSync(frames, { recursive: true })

const server = await createServer({ root, logLevel: "error", server: { host: "127.0.0.1", port: 0 } })
await server.listen()
const port = (server.httpServer!.address() as { port: number }).port
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const executablePath = readdirSync(cache).filter((n) => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
assert(executablePath, "Playwright Chromium not found")
const browser = await chromium.launch({ executablePath, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })

const HUD = "#status, #hotbar, #stamina, #battery, .callouts, .callout, #hud, .hud, #markers, #prompt, #sound-cues"
const errors: string[] = []
const meta: Record<string, unknown> = { shots: {} }

async function open(width: number, height: number, dpr: number): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: dpr })
  await page.addInitScript(() => {
    const request = GPUAdapter.prototype.requestDevice
    GPUAdapter.prototype.requestDevice = function (desc: GPUDeviceDescriptor = {}) {
      return request.call(this, { ...desc, requiredFeatures: this.features.has("timestamp-query") ? ["timestamp-query"] : [] })
    }
  })
  page.on("pageerror", (e) => errors.push(e.message))
  page.on("console", (m) => { if (m.type() === "error" || /wgsl|WGSL|validation/i.test(m.text())) errors.push(m.text()) })
  await page.goto(`http://127.0.0.1:${port}/?solo&seed=7&bench&peaceful=1&infiniteAmmo=1`)
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready, null, { timeout: 90000 })
  await page.addStyleTag({ content: `${HUD} { visibility: hidden !important; } #shot-label{position:fixed;left:14px;top:10px;z-index:99;font:600 17px -apple-system,sans-serif;color:#fff;text-shadow:0 1px 3px #000;pointer-events:none}` })
  // Page-side helpers: the details presenter (same module instance as the game's) and a staged pose.
  await page.evaluate(async () => {
    const w = window as any
    const h = w.__arcadeHarness
    const D = (await import(/* @vite-ignore */ `${location.origin}/src/details/presenter.ts`)).currentDetails()
    const { openDoorOf } = await import(/* @vite-ignore */ `${location.origin}/src/details/leftovers.ts`)
    const { DEFAULT_DETAIL_SETTINGS } = await import(/* @vite-ignore */ `${location.origin}/src/details/settings.ts`)
    const { groundKind } = await import(/* @vite-ignore */ `${location.origin}/src/details/prints.ts`)
    const steps = async (n: number, cmd: Record<string, unknown> = {}) => {
      for (let i = 0; i < n; i++) await h.step(1 / 60, { mx: 0, my: 0, aim: h.session().view.player.aim, ...cmd })
    }
    w.__life = {
      D,
      steps,
      /** Freezes the clock at `hour`, clears the dead, poses the survivor and lets the window stream in. */
      async stage(s: { hour: number; zoom: number; x: number; y: number; aim: number; flashlight: boolean; wet?: number; elapsed?: number; night?: number; lab?: Record<string, number | boolean> }) {
        h.freeze(true)
        h.setLab("timeScale", 0)
        h.setLab("zombieCount", 0)
        h.session().ai.agents.length = 0
        h.setLab("hour", s.hour)
        h.setWeatherState("clear")
        h.setLab("weatherWetnessOverride", s.wet ?? -0.05)
        for (const [k, v] of Object.entries({ ...DEFAULT_DETAIL_SETTINGS, lifeTouches: true, ...s.lab })) if (k.startsWith("lf") || k === "lifeTouches") h.setLab(k, v)
        h.setZoomRaw(s.zoom)
        const sim = h.session().sim
        sim.elapsedHours = s.elapsed ?? 0
        const ramp = sim.getFeatureState("nightRamp")
        if (ramp) ramp.night = s.night ?? 1
        h.pose(s.x, s.y, s.aim)
        const p = h.session().view.player
        p.flashlightOn = s.flashlight
        p.flashlightOutput = s.flashlight ? 1 : 0
        const t0 = performance.now()
        while (performance.now() - t0 < 8000) {
          await steps(4, { aim: s.aim })
          const world = h.state().world
          if (!world?.pendingBakes && performance.now() - t0 > 400) break
        }
        await steps(30, { aim: s.aim })
      },
      /** The plan the presenter made for the streamed window, nearest to (x, y) first. */
      targets(x: number, y: number, doorShare = DEFAULT_DETAIL_SETTINGS.lfOpenDoors) {
        const T = D.touches
        const near = <P extends { x: number }>(list: P[], at: (p: P) => [number, number]) =>
          list.map((p) => ({ p, d: Math.hypot(at(p)[0] - x, at(p)[1] - y) })).sort((a, b) => a.d - b.d).map((e) => e.p)
        const town = h.session().view.town
        const vehicles = (h.session().view.vehicles ?? []).filter((v: any) => openDoorOf(town, v, { ...DEFAULT_DETAIL_SETTINGS, lfOpenDoors: doorShare }))
        return {
          moths: near(T.moths.filter((m: any) => m.n > 0), (m: any) => [m.x, m.z]).map((m: any) => ({ x: m.x, y: m.y, z: m.z })),
          flies: near([...T.flies], (f: any) => [f.x, f.z]).map((f: any) => ({ x: f.x, z: f.z, body: !!f.store })),
          dens: near([...T.eyes.states.values()].map((s: any) => s.den), (d: any) => [d.x, d.z]).map((d: any) => ({ x: d.x, z: d.z, kind: d.kind })),
          lines: near([...D.lines], (l: any) => [l.x, l.z]).map((l: any) => ({ x: l.x, z: l.z, yaw: l.yaw })),
          doors: near(vehicles, (v: any) => [v.x, v.y]).map((v: any) => ({ x: v.x, z: v.y, kind: v.kind })),
          sprinklers: near([...T.sprinklers], (s: any) => [s.x, s.z]).map((s: any) => ({ x: s.x, z: s.z })),
          tvs: near([...D.tvs], (t: any) => [t.x, t.z]).map((t: any) => {
            const r = town.buildings.find((b: any) => b.id === t.building)?.rect ?? [t.x - 1, t.z - 1, t.x + 1, t.z + 1]
            // JSON has no Infinity: a house that never loses power reads 1e9.
            const loss = D.power.get(t.building) ?? 1e9
            return { x: t.x, z: t.z, building: t.building, loss: Number.isFinite(loss) ? loss : 1e9, cx: (r[0] + r[2]) / 2, cz: (r[1] + r[3]) / 2 }
          }),
          drips: near([...T.drips], (d: any) => [d.x, d.z]).map((d: any) => ({ x: d.x, z: d.z })),
        }
      },
      shown: () => ({ ...D.shown, life: { ...D.touches.shown, printsMade: D.touches.prints.made, deadPrintsMade: D.touches.deadPrints.made } }),
      /** Where to stand `dist` m from (x, z), facing it: the first of a few bearings that is not inside a building. */
      stand(x: number, z: number, dist: number, bearings: number[]) {
        const town = h.session().view.town
        for (const b of bearings) {
          const sx = x + Math.cos(b) * dist
          const sz = z + Math.sin(b) * dist
          if (groundKind(town, sx, sz) !== "floor") return { x: sx, y: sz, aim: b + Math.PI }
        }
        const b = bearings[0]!
        return { x: x + Math.cos(b) * dist, y: z + Math.sin(b) * dist, aim: b + Math.PI }
      },
      /** Screen point (CSS px) of a world point. */
      screen(x: number, y: number, z: number) {
        const r = h.resolveTargetRect({ world: [x, y, z] })
        return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null
      },
      /** A lawn point with open hard ground (sidewalk, road) a few metres south of it: where mud gets carried from. */
      yard(x0: number, y0: number) {
        const town = h.session().view.town
        for (let r = 0; r < 24; r += 0.5)
          for (const x of [x0 + r, x0 - r])
            for (let y = y0 - 8; y < y0; y += 0.5) {
              if (groundKind(town, x, y) !== "yard") continue
              let ok = true
              let hard = -1
              for (let k = 0.5; k < 6 && ok; k += 0.5) {
                const g = groundKind(town, x, y + k)
                if (g === "floor") ok = false
                if (g === "hard" && hard < 0) hard = k
              }
              if (ok && hard > 1.2 && hard < 4) return { x, y }
            }
        return { x: x0, y: y0 - 4 }
      },
    }
  })
  return page
}

type Pt = { x: number; z: number }
type Targets = { moths: (Pt & { y: number })[]; flies: (Pt & { body: boolean })[]; dens: (Pt & { kind: string })[]; lines: (Pt & { yaw: number })[]; doors: (Pt & { kind: string })[]; sprinklers: Pt[]; tvs: (Pt & { building: string; loss: number; cx: number; cz: number })[]; drips: Pt[] }
type Stage = { hour: number; zoom: number; x: number; y: number; aim: number; flashlight: boolean; wet?: number; elapsed?: number; night?: number; lab?: Record<string, number | boolean> }

const ASH = { x: 29, y: 40 }
/** A street of streamed, styled homes south of the origin block (the road runs north–south at x 44). */
const STREET = { x: 44, y: 150 }
/** Stands `dist` m from a target along `bearing` (radians, from the target), facing it. */
const facing = (t: Pt, dist: number, bearing: number) => ({ x: t.x + Math.cos(bearing) * dist, y: t.z + Math.sin(bearing) * dist, aim: bearing + Math.PI })
const SOUTH_FIRST = [Math.PI / 2, 0, Math.PI, -Math.PI / 2]

const stills: { file: string; label: string }[] = []

try {
  const page = await open(1280, 800, 1)
  meta.adapter = await page.evaluate(() => (window as any).__arcadeHarness.adapterInfo)
  const stage = (s: Stage) => page.evaluate((s) => (window as any).__life.stage(s), s)
  const steps = (n: number, cmd: Record<string, unknown> = {}) => page.evaluate(({ n, cmd }) => (window as any).__life.steps(n, cmd), { n, cmd })
  const label = (text: string) => page.evaluate((text) => {
    document.querySelector("#shot-label")?.remove()
    if (text) document.body.append(Object.assign(document.createElement("div"), { id: "shot-label", textContent: text }))
  }, text)
  /** Stages, runs `after`, and saves a 480×300 (CSS px) crop round `focus` (a world point), or the whole frame. */
  const snap = async (name: string, text: string, s: Stage, after?: () => Promise<unknown>, focus?: [number, number, number]) => {
    try {
      await label("")
      await stage(s)
      if (after) await after()
      const shown = await page.evaluate(() => (window as any).__life.shown())
      const at = focus ? await page.evaluate(([x, y, z]) => (window as any).__life.screen(x, y, z), focus) : null
      const vw = 1280
      const vh = 800
      const clip = at ? { x: Math.max(0, Math.min(vw - 480, at.x - 240)), y: Math.max(0, Math.min(vh - 300, at.y - 150)), width: 480, height: 300 } : undefined
      await page.screenshot({ path: resolve(out, `${name}.png`), timeout: 120_000, clip })
      stills.push({ file: `${name}.png`, label: text })
      ;(meta.shots as Record<string, unknown>)[name] = { label: text, stage: s, shown }
      console.log(name, JSON.stringify(shown.life))
    } catch (e) {
      errors.push(`${name}: ${(e as Error).message}`)
      console.error(name, (e as Error).message)
    }
  }

  // Plan the window round Ash's front at night, then find each touch nearest to it.
  await stage({ hour: 22, zoom: 30, ...ASH, aim: 0, flashlight: true })
  const T: Targets = await page.evaluate(({ x, y }) => (window as any).__life.targets(x, y), ASH)
  meta.targets = Object.fromEntries(Object.entries(T).map(([k, v]) => [k, (v as unknown[]).slice(0, 4)]))
  console.log("targets", JSON.stringify(Object.fromEntries(Object.entries(T).map(([k, v]) => [k, (v as unknown[]).length]))))

  // Each still is a crop round its touch; the survivor stands a little way off, outside any building.
  const stand = (t: Pt, dist: number, bearings = SOUTH_FIRST): Promise<{ x: number; y: number; aim: number }> =>
    page.evaluate(({ t, dist, bearings }) => (window as any).__life.stand(t.x, t.z, dist, bearings), { t, dist, bearings })
  const lamp = T.moths[0]
  if (lamp) {
    const at = await stand(lamp, 2.2)
    await snap("moths-22h", "Moths at a porch light, 22:00", { hour: 22, zoom: 9, ...at, flashlight: false }, undefined, [lamp.x, lamp.y, lamp.z])
    await snap("moths-22h-off", "Same porch, Life touches off", { hour: 22, zoom: 9, ...at, flashlight: false, lab: { lifeTouches: false } }, undefined, [lamp.x, lamp.y, lamp.z])
  }
  const fly = T.flies.find((f) => f.body) ?? T.flies[0]
  if (fly) {
    const at = await stand(fly, 2)
    const what = fly.body ? "a body" : "a bin"
    await snap("flies-14h", `Flies over ${what}, 14:00`, { hour: 14, zoom: 8, ...at, flashlight: false }, undefined, [fly.x, 0.5, fly.z])
    await snap("flies-22h", `Flies over ${what} in the beam, 22:00`, { hour: 22, zoom: 8, ...at, flashlight: true }, undefined, [fly.x, 0.5, fly.z])
  }
  // Eyes hold the beam a moment and then bolt: stand beyond the animal's flee distance, torch on a few frames before.
  const torchOn = (n: number) => page.evaluate(async (n) => {
    const w = window as any
    const p = w.__arcadeHarness.session().view.player
    p.flashlightOn = true
    p.flashlightOutput = 1
    await w.__life.steps(n)
  }, n)
  // The animal's flee distance (`SPECIES` in details/eyeshine.ts): the closest den to frame is the shyest-but-nearest.
  const FLEE: Record<string, number> = { cat: 5, raccoon: 6, fox: 8, deer: 11 }
  const den = [...T.dens].filter((d) => d.kind in FLEE).sort((a, b) => FLEE[a.kind]! - FLEE[b.kind]!)[0]
  if (den) {
    const at = await stand(den, FLEE[den.kind]! + 1.5, [0, Math.PI, Math.PI / 2, -Math.PI / 2])
    await snap("eyes-23h", `Eyes under a yard tree (${den.kind}), 23:00`, { hour: 23, zoom: 18, ...at, flashlight: false }, () => torchOn(10), [den.x, 0.8, den.z])
  }
  // Breath comes in puffs: step until one is out.
  const breathAt = { x: ASH.x + 4, y: 44 }
  await snap("breath-23h", "Breath over the torch in the cold, 23:00", { hour: 23, zoom: 7, ...breathAt, aim: 0, flashlight: true }, () =>
    page.evaluate(async () => {
      const L = (window as any).__life
      for (let i = 0; i < 400 && L.D.touches.shown.breath < 2; i++) await L.steps(1)
    }), [breathAt.x + 0.4, 1.6, breathAt.y])
  // Open doors are rare (15 % of parked cars); with none in the window, every car is left open for the shot.
  const doorLab: Record<string, number> = T.doors[0] ? {} : { lfOpenDoors: 1 }
  const car = T.doors[0] ?? ((await page.evaluate(({ x, y }) => (window as any).__life.targets(x, y, 1), ASH)) as Targets).doors[0]
  if (car) {
    const at = await stand(car, 3.6, [-Math.PI / 2, Math.PI / 2, 0, Math.PI])
    const focus: [number, number, number] = [car.x, 1, car.z]
    await snap("car-door-22h", `A ${car.kind} left open, dome light on, 22:00 (night 1)`, { hour: 22, zoom: 12, ...at, flashlight: false, lab: doorLab }, undefined, focus)
    await snap("car-door-22h-night3", "The same dome light sputtering, night 3", { hour: 22, zoom: 12, ...at, flashlight: false, night: 3, elapsed: 52, lab: doorLab }, undefined, focus)
    await snap("car-door-14h", "Left open, 14:00", { hour: 14, zoom: 12, ...at, flashlight: false, lab: doorLab }, undefined, focus)
  }
  // Brass: eight shots down the road, then look at where it fell.
  const shoot = async () => {
    for (let k = 0; k < 8; k++) {
      await steps(1, { fire: true, fireHeld: true, aim: 0 })
      await steps(9, { aim: 0 })
    }
    await steps(60, { aim: 0 })
  }
  const gun = { x: ASH.x + 6, y: 44 }
  await snap("casings-14h", "Brass where it fell, 14:00", { hour: 14, zoom: 7, ...gun, aim: 0, flashlight: false }, shoot, [gun.x, 0, gun.y + 0.6])
  await snap("casings-22h", "Brass in the beam, 22:00", { hour: 22, zoom: 7, ...gun, aim: Math.PI / 2 + 0.3, flashlight: true }, async () => {
    await shoot()
    await steps(10, { aim: Math.PI / 2 + 0.3 })
  }, [gun.x, 0, gun.y + 0.6])
  // After rain: the ground soaked, the rain stopped.
  const drip = T.drips.find((d) => T.moths.some((m) => Math.hypot(m.x - d.x, m.z - d.z) < 4)) ?? T.drips[0]
  if (drip) {
    const at = await stand(drip, 2)
    await snap("drips-22h-after-rain", "Eaves still dripping after the rain, 22:00", { hour: 22, zoom: 9, ...at, flashlight: true, wet: 0.85 }, undefined, [drip.x, 0, drip.z])
  }
  // Mud from the lawn onto the road (about four metres), then turn round to see the trail.
  const yard: { x: number; y: number } = await page.evaluate(({ x, y }) => (window as any).__life.yard(x, y), ASH)
  meta.yard = yard
  const muddy = async () => {
    for (let i = 0; i < 80; i++) await steps(1, { mx: 0, my: 1, aim: Math.PI / 2 })
    await steps(20, { aim: -Math.PI / 2 })
  }
  const trail: [number, number, number] = [yard.x, 0, yard.y + 3]
  await snap("prints-22h-after-rain", "Mud carried off the lawn onto the road, 22:00", { hour: 22, zoom: 13, ...yard, aim: Math.PI / 2, flashlight: true, wet: 0.85 }, muddy, trail)
  await snap("prints-10h-after-rain", "The same trail by day, 10:00", { hour: 10, zoom: 13, ...yard, aim: Math.PI / 2, flashlight: false, wet: 0.85 }, muddy, trail)
  // The dead crossing from the lawns over the wet road, held on a straight line (their own steering is overridden).
  await snap("dead-prints-22h", "Where the dead crossed after the rain, 22:00", { hour: 22, zoom: 14, x: yard.x, y: yard.y + 8, aim: -Math.PI / 2, flashlight: true, wet: 0.85 }, () =>
    page.evaluate(async (yard) => {
      const w = window as any
      const h = w.__arcadeHarness
      const zs = [-2, 0.5, 2.5].map((dx) => ({ z: h.spawnZombie(yard.x + dx, yard.y, "wander", Math.PI / 2), x: yard.x + dx }))
      for (let i = 0; i < 200; i++) {
        for (const { z, x } of zs) if (z) Object.assign(z, { x, y: yard.y + i * 0.022, vx: 0, vy: 0 })
        await w.__life.steps(1)
      }
      h.session().ai.agents.length = 0
      await w.__life.steps(4)
    }, yard), [yard.x, 0, yard.y + 3])

  // A streamed street of styled homes for the rest: washing, sprinklers and televisions.
  await stage({ hour: 22, zoom: 30, ...STREET, aim: Math.PI / 2, flashlight: true })
  const S: Targets = await page.evaluate(({ x, y }) => (window as any).__life.targets(x, y), STREET)
  meta.streetTargets = Object.fromEntries(Object.entries(S).map(([k, v]) => [k, (v as unknown[]).slice(0, 4)]))
  console.log("street targets", JSON.stringify(Object.fromEntries(Object.entries(S).map(([k, v]) => [k, (v as unknown[]).length]))))
  const line = S.lines[0] ?? T.lines[0]
  if (line) {
    const at = await stand(line, 3)
    await snap("washing-14h", "Washing left on the line, 14:00", { hour: 14, zoom: 12, ...at, flashlight: false }, undefined, [line.x, 1.5, line.z])
    await snap("washing-22h", "Washing in the beam, 22:00", { hour: 22, zoom: 12, ...at, flashlight: true }, undefined, [line.x, 1.5, line.z])
  }
  const spr = S.sprinklers[0] ?? T.sprinklers[0]
  if (spr) {
    const at = await stand(spr, 3)
    await snap("sprinkler-0650", "The lawn sprinkler's timer, 06:50", { hour: 6.84, zoom: 11, ...at, flashlight: false }, undefined, [spr.x, 0.3, spr.z])
  }
  const watcher = [...S.dens, ...T.dens].find((d) => d.kind === "watcher")
  if (watcher) {
    const at = await stand(watcher, 10.5, [0, Math.PI, Math.PI / 2, -Math.PI / 2])
    await snap("watcher-01h-night2", "The one that does not run, night 2, 01:00", { hour: 1, zoom: 20, ...at, flashlight: false, night: 2 }, () => torchOn(30), [watcher.x, 1.5, watcher.z])
  }


  // The contact sheet: every still, labelled.
  const cells = stills.map((s) => `<figure><img src="data:image/png;base64,${readFileSync(resolve(out, s.file)).toString("base64")}"><figcaption>${s.label}</figcaption></figure>`).join("")
  const sheet = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
  await sheet.setContent(`<style>body{margin:0;background:#111;font:600 15px -apple-system,sans-serif;color:#ddd;display:grid;grid-template-columns:repeat(4,1fr);gap:6px;padding:6px}figure{margin:0}img{width:100%;display:block}figcaption{padding:3px 2px 6px}</style>${cells}`, { waitUntil: "domcontentloaded", timeout: 120_000 })
  await sheet.waitForFunction(() => [...document.images].every((i) => i.complete), null, { timeout: 120_000 })
  await sheet.screenshot({ path: resolve(out, "contact-sheet.png"), fullPage: true })
  await sheet.close()

  // A street at night after rain: the last of the rain, then walking south past the porch lights, the beam sweeping
  // the yards either side.
  await stage({ hour: 22, zoom: 18, x: STREET.x, y: STREET.y - 10, aim: Math.PI / 2, flashlight: true, wet: 0.9 })
  await page.evaluate(() => (window as any).__arcadeHarness.setWeatherState("rain"))
  await label("After the rain, 22:00")
  let shot = 0
  const frame = async (cmd: Record<string, unknown>) => {
    await steps(1, cmd)
    await steps(1, cmd)
    await page.screenshot({ path: resolve(frames, `${String(shot++).padStart(4, "0")}.jpg`), type: "jpeg", quality: 88, timeout: 120_000 })
  }
  for (let i = 0; i < 45; i++) await frame({ aim: Math.PI / 2 })
  await page.evaluate(() => (window as any).__arcadeHarness.setWeatherState("clear"))
  for (let i = 0; i < 180; i++) await frame({ mx: 0, my: i < 150 ? 0.55 : 0, aim: Math.PI / 2 + Math.sin(i / 28) * 0.9 })
  for (let i = 0; i < 45; i++) await frame({ aim: Math.PI / 2 + 0.9 + (Math.PI - 0.9) * (i / 45) })
  meta.clipFrames = shot
  if (spawnSync("ffmpeg", ["-version"]).status === 0) {
    const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", "30", "-i", resolve(frames, "%04d.jpg"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-an", resolve(out, "rain-night.mp4")])
    if (r.status !== 0) errors.push(`ffmpeg: ${r.stderr}`)
  }
  // CPU over the end of the clip (moths, drips, prints in view).
  // performance.now() is coarse in the page, so replay one captured frame's call 2000 times in a row.
  meta.cpu = await page.evaluate(async () => {
    const L = (window as any).__life
    const T = L.D.touches
    const write = T.write
    let args: unknown[] | null = null
    T.write = function (...a: unknown[]) {
      args = a
      return write.apply(this, a)
    }
    await L.steps(2)
    T.write = write
    if (!args) return null
    const f = (args as any[])[0]
    const t0 = performance.now()
    for (let i = 0; i < 2000; i++) {
      f.time += 1 / 60
      write.apply(T, args)
    }
    return { usPerFrame: ((performance.now() - t0) / 2000) * 1000, shown: { ...T.shown } }
  })
  console.log("CPU", JSON.stringify(meta.cpu))
  await page.close()

  // Paired GPU cost at the bench resolution: the streamed street after rain (moths, drips, eyes, washing), Life touches
  // off vs on.
  const gpuPage = await open(1728, 947, 2)
  const med = (xs: number[]) => { const s = [...xs].sort((p, q) => p - q); return (s[(s.length - 1) >> 1]! + s[s.length >> 1]!) / 2 }
  const at = { ...STREET, aim: Math.PI / 2 }
  const a: number[] = []
  const b: number[] = []
  for (let r = 0; r < rounds; r++) {
    for (const on of r % 2 ? [true, false] : [false, true]) {
      await gpuPage.evaluate((s) => (window as any).__life.stage(s), { hour: 22, zoom: 30, ...at, flashlight: true, wet: 0.85, lab: { lifeTouches: on } })
      const ms = await gpuPage.evaluate(async () => {
        const h = (window as any).__arcadeHarness
        const v: number[] = []
        for (let i = 0; i < 18; i++) v.push(await h.renderer.measure(h.render))
        return v.slice(2).sort((x: number, y: number) => x - y)[1]!
      })
      ;(on ? b : a).push(ms)
    }
  }
  const diffs = a.map((x, i) => b[i]! - x)
  meta.gpu = { scene: "streamed street after rain, 22:00, zoom 30, 3456×1894", off: med(a), on: med(b), pairedDeltaMedian: med(diffs), pairedDeltaMad: med(diffs.map((d) => Math.abs(d - med(diffs)))), raw: { a, b } }
  console.log(`GPU off=${med(a).toFixed(3)} ms on=${med(b).toFixed(3)} ms paired Δ=${med(diffs).toFixed(3)} ms`)
  // CPU: the touches' own write, timed in the page over the same frame.
  meta.errors = errors
} finally {
  writeFileSync(resolve(out, "meta.json"), JSON.stringify(meta, null, 2))
  await browser.close()
  await server.close()
}
if (errors.length) console.error(errors.slice(0, 10).join("\n"))
console.log(out)
