// The F-35C bombsight on a real GPU. Runs ON hailmary (Mac Studio, Metal) against a dev server there (`bun run dev`,
// rooms included: the offline game has no enemy carrier): flies an F-35C in a fresh room and captures the frame under
// the DOM (HUD) as scripts/f35-shot.ts does.
//
//   bun scripts/bombsight-shot.ts --base=http://localhost:5197/ --out=<dir>
//
// 1. level run-in at 1,000 m onto an enemy carrier: bombs selected (Digit2) switch to the bombsight view; the pipper
//    walks up the fall line onto the ship and turns solid. On the cue the jet is held still in the air (a capture rig:
//    the camera, the pipper and the released bomb all keep the release state), Space releases a bay bomb and the
//    frames follow it down onto the pipper; the burst is compared with the prediction at release.
// 2. a 25° dive from 2,300 m, released on the cue from a wing station with the jet flying on; the burst is seen from
//    off the ship and compared with the prediction.
// 3. the SIGHT tab of the debug menu (the shared Lab panel with the bombsight's settings).
import { chromium, type Page } from "playwright-core"
import { mkdirSync } from "node:fs"
import { join } from "node:path"

const args = process.argv.slice(2)
const opt = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
const base = opt("base", "http://localhost:5197/")
const out = opt("out", "out")
const [vw, vh] = opt("size", "1536x960").split("x").map(Number) as [number, number]
const room = opt("room", `bs${Math.random().toString(36).slice(2, 7)}`)
const tod = opt("tod", "10.5")
mkdirSync(out, { recursive: true })

const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--enable-features=WebGPU", "--ignore-gpu-blocklist"],
})
const logs: string[] = []
let failures = 0
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`)
  if (!ok) failures++
}

const page = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1 })
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") logs.push(`${m.type()}: ${m.text()}`)
})
page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`))
await page.addInitScript(() => localStorage.setItem("carrier.name", "BOMBER"))
await page.goto(`${base}?room=${room}&tod=${tod}`, { waitUntil: "load" })
await page.waitForFunction(() => !!(globalThis as { carrier?: { game?: { state: { sea: unknown } } } }).carrier?.game?.state.sea, null, { timeout: 60_000 })

const js = <T = unknown>(fn: string): Promise<T> => page.evaluate(`(() => { const c = globalThis.carrier; const f = c.flight.flight; const w = c.flight.weapons; ${fn} })()`) as Promise<T>

async function until(cond: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await js<boolean>(`return !!(${cond})`)) return true
    await page.waitForTimeout(30)
  }
  return false
}

/** The current frame as a PNG data URL, read back through the game's device. */
function frame(): Promise<string> {
  return page.evaluate(async () => {
    const c = (globalThis as unknown as { carrier: { renderer: { context: { device: GPUDevice } } } }).carrier
    const device = c.renderer.context.device
    const ctx = (c.renderer as unknown as { canvas: GPUCanvasContext }).canvas
    const format = navigator.gpu.getPreferredCanvasFormat()
    ctx.configure({ device, format, alphaMode: "opaque", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC })
    const w = (ctx.canvas as HTMLCanvasElement).width
    const h = (ctx.canvas as HTMLCanvasElement).height
    const row = Math.ceil((w * 4) / 256) * 256
    const buf = device.createBuffer({ size: row * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    await new Promise<void>((resolve) => {
      const get = ctx.getCurrentTexture.bind(ctx)
      const submit = device.queue.submit.bind(device.queue)
      let tex: GPUTexture | null = null
      ctx.getCurrentTexture = () => {
        tex = get()
        ctx.getCurrentTexture = get
        return tex
      }
      device.queue.submit = (cbs: Iterable<GPUCommandBuffer>) => {
        submit(cbs)
        if (!tex) return
        device.queue.submit = submit
        const enc = device.createCommandEncoder()
        enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: row }, [w, h])
        submit([enc.finish()])
        resolve()
      }
    })
    await buf.mapAsync(GPUMapMode.READ)
    const src = new Uint8Array(buf.getMappedRange())
    const img = new ImageData(w, h)
    const bgra = format === "bgra8unorm"
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const s = y * row + x * 4
        const d = (y * w + x) * 4
        img.data[d] = src[s + (bgra ? 2 : 0)]!
        img.data[d + 1] = src[s + 1]!
        img.data[d + 2] = src[s + (bgra ? 0 : 2)]!
        img.data[d + 3] = 255
      }
    buf.unmap()
    const cv = document.createElement("canvas")
    cv.width = w
    cv.height = h
    cv.getContext("2d")!.putImageData(img, 0, 0)
    return cv.toDataURL("image/png")
  })
}

/** Frame under the DOM (the HUD and the sight), then a page screenshot. */
async function shot(name: string): Promise<void> {
  const url = await frame()
  await page.evaluate((src) => {
    const img = document.createElement("img")
    img.id = "bs-shot-bg"
    img.src = src
    Object.assign(img.style, { position: "fixed", inset: "0", width: "100%", height: "100%", zIndex: "0" })
    const canvas = document.getElementById("view")!
    canvas.style.visibility = "hidden"
    canvas.after(img)
    return new Promise((r) => (img.complete ? r(null) : (img.onload = () => r(null))))
  }, url)
  await page.screenshot({ path: join(out, `${name}.png`) })
  await page.evaluate(() => {
    document.getElementById("bs-shot-bg")?.remove()
    document.getElementById("view")!.style.visibility = ""
  })
  const s = await js<string>("const a = w.aim; return `${f.phase} sight ${f.cam.sighting} y ${Math.round(f.plane.y)} bombs ${w.loadout.bombs} impact ${a.impact.kind} ${a.impact.time.toFixed(1)} s cue ${a.cue}`")
  console.log(`shot ${name}: ${s}`)
}

await page.waitForTimeout(3000)
const ships = await js<{ id: number; team: number; x: number; z: number; u: number }[]>("return c.flight.carriers.map((s) => ({ id: s.id, team: s.team, x: s.x, z: s.z, u: s.u }))")
console.log(`carriers: ${JSON.stringify(ships)}`)

// Fly an F-35C off the deck.
await js("c.net.op('f35')")
check(await until("f.phase !== 'idle' && f.vehicle === 'f35'", 6000), "an F-35C sortie starts")
check(await until("f.phase === 'flying'", 15000), "the F-35C leaves the catapult")
await page.waitForTimeout(2500)
check(await js<boolean>("return w.status.weapon === 'missile' && !f.cam.sighting"), "it launches on its missiles, in the chase view (no bombsight until bombs are selected)")

// Rig: `__hold` keeps the jet on a straight path (heading, dive angle, speed) after every step; `__freeze` holds it
// still in the air (no step at all); `__booms` records every bomb burst and ship strike; `__look` places the camera.
await js(`
  const g = globalThis
  g.__hold = null
  g.__freeze = false
  g.__booms = []
  g.__look = null
  const tick = f.tick.bind(f)
  f.tick = (ship, world) => {
    if (g.__freeze && f.phase === "flying") {
      Object.assign(f.prev, f.plane)
      f.plane.t += 1 / 60
      return
    }
    tick(ship, world)
    const h = g.__hold
    if (!h || f.phase !== "flying") return
    const p = f.plane
    const a = (Math.PI - h.heading) / 2
    const s = Math.sin(h.dive / 2), co = Math.cos(h.dive / 2)
    Object.assign(p, { qx: Math.cos(a) * s, qy: Math.sin(a) * co, qz: -Math.sin(a) * s, qw: Math.cos(a) * co, p: 0, r: 0, w: 0, stall: 0, outside: 0 })
    const cd = Math.cos(h.dive)
    p.vx = Math.sin(h.heading) * cd * h.speed
    p.vy = -Math.sin(h.dive) * h.speed
    p.vz = -Math.cos(h.heading) * cd * h.speed
  }
  const apply = w.apply.bind(w)
  w.apply = (e) => {
    if ((e.k === "boom" && e.bomb) || (e.k === "ship" && e.w === "bomb")) g.__booms.push({ ...e, at: performance.now() })
    apply(e)
  }
  const cam = f.cam
  const upd = cam.update.bind(cam)
  cam.update = (...a) => {
    upd(...a)
    const l = g.__look
    if (!l) return
    const d = [l.at[0] - l.eye[0], l.at[1] - l.eye[1], l.at[2] - l.eye[2]]
    const n = Math.hypot(...d)
    cam.eye.splice(0, 3, ...l.eye)
    cam.forward.splice(0, 3, d[0] / n, d[1] / n, d[2] / n)
    cam.up.splice(0, 3, 0, 1, 0)
    cam.fov = (38 * Math.PI) / 180
    cam.compute(innerWidth / innerHeight)
  }
  // Every release, with the game's own prediction (shared/combat.ts bombImpact, served by Vite) from its exact state.
  g.__launches = []
  const launch = w.launch.bind(w)
  w.launch = (m) => {
    const i = g.__combat.bombImpact(w.world.ground, w.fleetShips, m, g.__combat.makeBombImpact())
    g.__launches.push({ ...m, kind: i.kind, ix: i.x, iy: i.y, iz: i.z, time: i.time, local: [...i.local] })
    launch(m)
  }
  // On the first frame the pipper sits on the watched ship with the cue lit, at most d m short of its centre: freeze the jet,
  // or press Space (a keyboard event through the game's own input).
  g.__watch = null
  g.__fired = null
  const loop = () => {
    requestAnimationFrame(loop)
    const wt = g.__watch
    const s = wt && c.flight.carriers.find((s) => s.id === wt.ship)
    if (!s) return
    const dx = Math.sin(wt.heading), dz = -Math.cos(wt.heading)
    const d = (s.x - w.aim.draw[0]) * dx + (s.z - w.aim.draw[2]) * dz
    if (d < -300) {
      g.__watch = null
      g.__fired = { cue: false, d }
      return
    }
    if (!w.aim.cue || d > wt.d) return
    g.__watch = null
    const i = w.aim.impact
    g.__fired = { cue: true, d, side: (s.x - w.aim.draw[0]) * dz - (s.z - w.aim.draw[2]) * dx, kind: i.kind, x: i.x, y: i.y, z: i.z, time: i.time }
    if (wt.freeze) g.__freeze = true
    if (wt.release) {
      dispatchEvent(new KeyboardEvent("keydown", { code: "Space", key: " ", bubbles: true }))
      setTimeout(() => dispatchEvent(new KeyboardEvent("keyup", { code: "Space", key: " ", bubbles: true })), 120)
    }
  }
  requestAnimationFrame(loop)
`)
await page.evaluate(async () => {
  ;(globalThis as unknown as { __combat: unknown }).__combat = await import(["", "shared", "combat.ts"].join("/"))
})

type Run = { heading: number; dive: number; speed: number; alt: number; short: number }

/** Puts the jet on a straight run at `ship` so the pipper starts `short` m short of it (from the sight's own aim). */
async function runIn(ship: { x: number; z: number }, r: Run): Promise<void> {
  const dx = Math.sin(r.heading)
  const dz = -Math.cos(r.heading)
  const place = (x: number, z: number) =>
    js(`
      const p = f.plane
      Object.assign(p, { x: ${x}, y: ${r.alt}, z: ${z}, crashed: "", blend: 1, throttle: 0.8 })
      Object.assign(f.prev, p)
      f.phase = "flying"
      f.airborne = 10
      f.landing = null
      globalThis.__hold = ${JSON.stringify({ heading: r.heading, dive: r.dive, speed: r.speed })}`)
  // First guess 5 km out, then move so the pipper sits `short` short of the ship on the run line.
  await place(ship.x - dx * 5000, ship.z - dz * 5000)
  await page.waitForTimeout(300)
  const a = await js<{ x: number; z: number; px: number; pz: number }>("return { x: w.aim.draw[0], z: w.aim.draw[2], px: f.plane.x, pz: f.plane.z }")
  const throw_ = (a.x - a.px) * dx + (a.z - a.pz) * dz
  await place(ship.x - dx * (throw_ + r.short), ship.z - dz * (throw_ + r.short))
}

/** Along-track distance from the pipper to the ship centre (positive: the pipper is still short of it). */
const short = (ship: { id: number; x: number; z: number }, heading: number) =>
  js<{ d: number; side: number; cue: boolean }>(
    `const s = c.flight.carriers.find((s) => s.id === ${ship.id}) ?? { x: ${ship.x}, z: ${ship.z} }
    const dx = Math.sin(${heading}), dz = -Math.cos(${heading})
    const ex = s.x - w.aim.draw[0], ez = s.z - w.aim.draw[2]
    return { d: ex * dx + ez * dz, side: ex * dz - ez * dx, cue: w.aim.cue }`,
  )

const mine = await js<number>("return w.team")
const target = ships.find((s) => s.team !== mine) ?? null
check(!!target, `an enemy carrier to bomb (${target ? `ship ${target.id}, team ${target.team}` : "none"})`)
if (!target) throw new Error("no enemy carrier")

// Sun behind the camera on the run (Frame sunDir points at the sun).
const sun = await js<{ x: number; z: number }>("const l = Math.hypot(c.frame[20], c.frame[22]) || 1; return { x: c.frame[20] / l, z: c.frame[22] / l }")
const heading1 = Math.atan2(-sun.x, sun.z)

// ---- 1. level run-in, release on the cue with the jet held still, the bomb onto the pipper ----------------------------
await page.keyboard.press("Digit2")
check(await until("w.loadout.slot === 1", 1000), "Digit2 selects the bombs")
await runIn(target, { heading: heading1, dive: 0, speed: 210, alt: 1000, short: 1800 })
check(await until("f.cam.sighting", 1500), "selecting bombs switches to the bombsight view")
await page.waitForTimeout(700)
let s = await short(target, heading1)
console.log(`pipper ${s.d.toFixed(0)} m short, ${s.side.toFixed(0)} m off the line`)
await shot("01-runin-pipper-short")
while ((s = await short(target, heading1)).d > 700) await page.waitForTimeout(20)
await shot("02-runin-pipper-closing")
type Fired = { cue: boolean; d: number; side?: number; kind?: string; x: number; y: number; z: number; time: number }
type Launch = { x: number; y: number; z: number; vx: number; vy: number; vz: number; kind: string; ix: number; iy: number; iz: number; time: number; local: number[] }
await js(`globalThis.__fired = null; globalThis.__watch = { ship: ${target.id}, heading: ${heading1}, d: 0, freeze: true }`)
await until("globalThis.__fired", 20000)
const fired1 = await js<Fired>("return globalThis.__fired")
check(fired1.cue, `the pipper turns to the release cue on the enemy carrier (${fired1.d.toFixed(1)} m along, ${fired1.side?.toFixed(1)} m across its centre)`)
await page.waitForTimeout(300)
await shot("03-pipper-on-ship-cue")
const bombs0 = await js<number>("return w.loadout.bombs")
await page.keyboard.down("Space")
await page.waitForTimeout(120)
await page.keyboard.up("Space")
check(await until(`w.loadout.bombs === ${bombs0 - 1}`, 1500), "Space releases a bomb")
const want1 = (await js<Launch[]>("return globalThis.__launches.splice(0)"))[0]!
const released = Date.now()
await page.waitForTimeout(450)
await shot("04-release")
// The rest through the same view zoomed in on the pipper (the Lab's look-down and field of view, src/flight/camera.ts
// SIGHT_CAM), still frozen at the release: the bomb comes down onto the pipper.
const sightCam = (down: number, fov: number) =>
  page.evaluate(
    async ([down, fov]) => {
      const m = (await import(["", "src", "flight", "camera.ts"].join("/"))) as { SIGHT_CAM: { sightDown: number; sightFov: number } }
      m.SIGHT_CAM.sightDown = down!
      m.SIGHT_CAM.sightFov = fov!
    },
    [down, fov],
  )
const depression = await js<number>("const p = f.plane, d = w.aim.draw; return Math.atan2(p.y - d[1], Math.hypot(d[0] - p.x, d[2] - p.z)) * 180 / Math.PI")
await sightCam(depression, 8)
await page.waitForTimeout(Math.max(0, want1.time * 820 - (Date.now() - released)))
await shot("05-zoom-bomb-falling")
await until("globalThis.__booms.some((b) => b.k === 'boom')", want1.time * 1000 + 3000)
await page.waitForTimeout(100)
await shot("06-zoom-impact-on-pipper")
await page.waitForTimeout(600)
await shot("07-zoom-impact-b")
await sightCam(14, 42)
await page.waitForTimeout(700)
await shot("08-impact-sight-view")
type Boom = { k: string; x: number; y: number; z: number; water?: boolean; ship?: number; near?: number }
const booms1 = await js<Boom[]>("return globalThis.__booms.splice(0)")
const b1 = booms1.find((b) => b.k === "boom")
const hit1 = booms1.find((b) => b.k === "ship")
const miss1 = b1 ? Math.hypot(b1.x - want1.ix, b1.y - want1.iy, b1.z - want1.iz) : Infinity
const pip1 = b1 ? Math.hypot(b1.x - fired1.x, b1.y - fired1.y, b1.z - fired1.z) : Infinity
console.log(`run 1: predicted ${want1.kind} at (${want1.ix.toFixed(2)}, ${want1.iy.toFixed(2)}, ${want1.iz.toFixed(2)}) in ${want1.time.toFixed(2)} s; burst ${JSON.stringify(b1)}; ship ${JSON.stringify(hit1)}`)
console.log(`run 1: the burst is ${miss1.toFixed(3)} m from the impact predicted at release (the pipper's: ${pip1.toFixed(3)} m)`)
check(want1.kind === "ship" && !!hit1 && hit1.near === 0, "run 1: a direct hit on the enemy carrier, as predicted")
// The deck strike point is what the pipper shows; the burst itself is where the 60 Hz step ended inside the hull, which
// can differ by a step (~2-5 m) with the deck heaving and rolling during the fall (the prediction holds its attitude).
const deck1 = hit1 ? Math.hypot(hit1.x - want1.local[0]!, hit1.y - want1.local[1]!, hit1.z - want1.local[2]!) : Infinity
check(deck1 < 6, `run 1: it strikes the deck ${deck1.toFixed(2)} m from the predicted point (within a step)`)

// ---- 2. a 25° dive, released on the cue from a wing station, the jet flying on -----------------------------------------
await js("globalThis.__freeze = false; w.loadout.bombs = 2; w.loadout.bombIn = 1e9; w.loadout.launchIn = 0")
const heading2 = heading1 + 0.9
await runIn(target, { heading: heading2, dive: (25 * Math.PI) / 180, speed: 230, alt: 2300, short: 900 })
await page.waitForTimeout(250)
await shot("09-dive-runin")
await js(`globalThis.__fired = null; globalThis.__watch = { ship: ${target.id}, heading: ${heading2}, d: 0, release: true }`)
await until("globalThis.__fired", 20000)
const fired2 = await js<Fired>("return globalThis.__fired")
check(fired2.cue, `run 2: the cue lights on the enemy carrier in the dive (${fired2.d.toFixed(1)} m along, ${fired2.side?.toFixed(1)} m across)`)
check(await until("globalThis.__launches.length > 0", 1500), "run 2: Space on the cue releases a bomb")
await shot("10-dive-release")
const want2 = (await js<Launch[]>("return globalThis.__launches.splice(0)"))[0]!
// Pull the jet clear and watch the ship from off its beam.
const tx = target.x
const tz = target.z
await js(`globalThis.__hold = { heading: ${heading2}, dive: 0, speed: 200 }; Object.assign(f.plane, { y: 2500 }); globalThis.__look = { eye: [${tx + sun.x * 420 + 160}, 150, ${tz + sun.z * 420 - 120}], at: [${tx}, 25, ${tz}] }`)
await until("globalThis.__booms.some((b) => b.k === 'boom')", 20000)
await page.waitForTimeout(120)
await shot("11-dive-impact")
await page.waitForTimeout(900)
await shot("12-dive-impact-b")
const booms2 = await js<Boom[]>("return globalThis.__booms.splice(0)")
const b2 = booms2.find((b) => b.k === "boom")
// Online the room's burst can come first (it snaps ours): a hit is a burst out of the water on the carrier.
const hit2 = booms2.find((b) => b.k === "ship")
const miss2 = b2 ? Math.hypot(b2.x - want2.ix, b2.y - want2.iy, b2.z - want2.iz) : Infinity
const pip2 = b2 ? Math.hypot(b2.x - fired2.x, b2.y - fired2.y, b2.z - fired2.z) : Infinity
console.log(`run 2: predicted ${want2.kind} at (${want2.ix.toFixed(2)}, ${want2.iy.toFixed(2)}, ${want2.iz.toFixed(2)}) in ${want2.time.toFixed(2)} s; burst ${JSON.stringify(b2)}; ship ${JSON.stringify(hit2)}`)
console.log(`run 2: the burst is ${miss2.toFixed(3)} m from the impact predicted at release; the pipper at the press was ${pip2.toFixed(1)} m from it (the bomb leaves on the next 60 Hz step)`)
check(want2.kind === "ship" && !!b2 && !b2.water && Math.hypot(b2.x - tx, b2.z - tz) < 60, "run 2: a direct hit on the enemy carrier, as predicted")
// Within a 60 Hz step of the bomb's fall (~4.5 m in the dive): where the step ends inside the hull depends on the deck's
// heave and roll during the fall, which the prediction holds still.
check(miss2 < 6, `run 2: the burst is within a step of the predicted one (${miss2.toFixed(2)} m)`)
if (hit2) console.log(`run 2: deck strike ${Math.hypot(hit2.x - want2.local[0]!, hit2.y - want2.local[1]!, hit2.z - want2.local[2]!).toFixed(2)} m from the predicted point`)
await js("globalThis.__look = null")

// ---- 3. the SIGHT tab ------------------------------------------------------------------------------------------------
await js("c.debugMenu.open('sight')")
await page.waitForTimeout(800)
await shot("13-lab-sight-tab")
const rows = await page.evaluate(() => document.querySelector("[data-debug]")?.shadowRoot?.querySelectorAll("[data-lab-panel] .knobs-slider, [data-lab-panel] .knobs-row").length ?? 0)
check(rows >= 8, `the SIGHT tab shows the bombsight settings on the Lab panel (${rows} rows)`)

console.log(logs.length ? `console:\n${logs.slice(0, 20).join("\n")}` : "no console errors")
await browser.close()
console.log(failures ? `${failures} FAILED` : "all ok")
process.exit(failures ? 1 : 0)
