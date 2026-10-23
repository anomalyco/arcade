// "R LAND" captures and checks on a real GPU. Runs ON hailmary (Mac Studio): Chrome with WebGPU on Metal loads the live
// dev server's game and captures the frame under the DOM (the HUD) as scripts/f35-shot.ts does.
//
//   ssh hailmary 'cd /tmp/carrier-land && ~/.bun/bin/bun land-shot.ts --out=/tmp/carrier-land/out'
//
// solo (offline, ?seed=7): launch, fly near the carrier (the prompt), press R, the landing frames, then back on deck as
// a pilot with the slot free and the page still running. mp: two pages in a fresh room on one team: A lands on its own
// carrier (B watches the landing glued to the deck), then on the other friendly carrier and ends up aboard it.
// launch (--only=launch, into <out>/launch-v2/): the one continuous catapult launch, pinned at 0, 0.5, 1.5, 3 s after
// launchStart and at the bow, then free.
import { type Page } from "playwright-core"
import { browserBudget } from "../../../scripts/browser-budget"
import { mkdirSync } from "node:fs"
import { join } from "node:path"

await using budget = browserBudget()
const { chromium } = budget

const args = process.argv.slice(2)
const opt = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
const base = opt("base", "https://carrier.lwoyjcaeyxv6.opentunnel.xyz/")
const out = opt("out", "/tmp/carrier-land/out")
const [vw, vh] = opt("size", "1536x960").split("x").map(Number) as [number, number]
const only = opt("only", "solo,mp").split(",")
mkdirSync(out, { recursive: true })

const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--enable-features=WebGPU", "--ignore-gpu-blocklist"],
})
let failures = 0
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`)
  if (!ok) failures++
}

async function open(url: string, name: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1 })
  page.on("console", (m) => {
    if (m.type() === "error") console.log(`${name} error: ${m.text().slice(0, 300)}`)
  })
  page.on("pageerror", (e) => console.log(`${name} pageerror: ${e.message}`))
  page.on("crash", () => console.log(`${name} CRASHED`))
  await page.addInitScript((n) => {
    localStorage.setItem("carrier.name", n)
    const g = globalThis as unknown as { __frames: number }
    g.__frames = 0
    const raf = requestAnimationFrame.bind(globalThis)
    globalThis.requestAnimationFrame = (cb) => raf((t) => (g.__frames++, cb(t)))
    const Real = WebSocket
    const Fake = function (this: unknown, url: string | URL, protocols?: string | string[]) {
      const p = Array.isArray(protocols) ? protocols : protocols ? [protocols] : []
      if (p.some((x) => x.startsWith("vite"))) return Object.assign(new EventTarget(), { readyState: 0, send() {}, close() {} })
      return new Real(url, protocols)
    } as unknown as typeof WebSocket
    Object.assign(Fake, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3, prototype: Real.prototype })
    globalThis.WebSocket = Fake
  }, name)
  await page.goto(url, { waitUntil: "load" })
  await page.waitForFunction(() => !!(globalThis as { carrier?: { game?: { state: { sea: unknown } } } }).carrier?.game?.state.sea, null, { timeout: 60_000 })
  return page
}

/** Runs `fn` in the page with c = carrier, f = the flight, with a time limit (a hung page fails the check). */
async function js<T = unknown>(page: Page, fn: string, ms = 5000): Promise<T> {
  const run = page.evaluate(`(() => { const c = globalThis.carrier; const f = c.flight.flight; ${fn} })()`) as Promise<T>
  return Promise.race([run, new Promise<T>((_, no) => setTimeout(() => no(new Error(`page did not answer in ${ms} ms (hung?)`)), ms))])
}

async function until(page: Page, cond: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await js<boolean>(page, `return !!(${cond})`)) return true
    await page.waitForTimeout(50)
  }
  return false
}

/** The current frame under the DOM (the HUD), then a page screenshot. */
async function shot(page: Page, name: string): Promise<void> {
  const url = await page.evaluate(async () => {
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
  await page.evaluate((src) => {
    const img = document.createElement("img")
    img.id = "land-shot-bg"
    img.src = src
    Object.assign(img.style, { position: "fixed", inset: "0", width: "100%", height: "100%", zIndex: "0" })
    const canvas = document.getElementById("view")!
    canvas.style.visibility = "hidden"
    canvas.after(img)
    return new Promise((r) => (img.complete ? r(null) : (img.onload = () => r(null))))
  }, url)
  await page.screenshot({ path: join(out, `${name}.png`) })
  await page.evaluate(() => {
    document.getElementById("land-shot-bg")?.remove()
    document.getElementById("view")!.style.visibility = ""
  })
  console.log(`shot ${name}: ${await state(page)}`)
}

const state = (page: Page) =>
  js<string>(
    page,
    `const me = c.net.crew && c.net.crew.players.find((p) => p.id === c.net.id)
    const l = f.landing
    return \`\${c.game.state.role} ship \${me?.ship} plane \${me?.plane} | \${f.phase}\${l ? "/" + l.phase + " " + l.since.toFixed(1) + " s" : ""} | prompt \${f.landPrompt} | \${c.net.state}\``,
  )

/** Our jet in free flight `dist` m from carrier `id` (own when absent) at relative bearing `bearing` (rad, 0 = ahead of
 *  the bow), `height` m above the sea, heading back toward the carrier plus `off` rad, at 150 m/s. */
const warpNear = (page: Page, dist: number, bearing: number, height: number, off = 0, id = -1) =>
  js(
    page,
    `const s = ${id} >= 0 ? c.flight.carriers.find((x) => x.id === ${id}) : c.flight.ctx.deck()
    const a = s.heading + ${bearing}
    const x = s.x + Math.sin(a) * ${dist}, z = s.z - Math.cos(a) * ${dist}
    const h = Math.atan2(s.x - x, -(s.z - z)) + ${off}
    const p = f.plane
    Object.assign(p, { x, y: ${height}, z, vx: 150 * Math.sin(h), vy: 0, vz: -150 * Math.cos(h), p: 0, r: 0, w: 0, throttle: 0.75, crashed: "", blend: 1, stall: 0, outside: 0 })
    const q = (Math.PI - h) / 2
    Object.assign(p, { qx: 0, qy: Math.sin(q), qz: 0, qw: Math.cos(q) })
    Object.assign(f.prev, p)
    f.phase = "flying"
    f.airborne = 10`,
  )

/** Launches a Hornet and waits until it flies. */
async function launch(page: Page, name: string): Promise<void> {
  await js(page, "c.net.op('hornet')")
  check(await until(page, "f.phase === 'flying'", 15_000), `${name}: launched and flying`)
}

/** Presses R at the prompt and follows the landing, capturing `prefix`-NN frames; checks it ends back on deck. */
async function landNow(page: Page, prefix: string, name: string): Promise<void> {
  check(await until(page, "f.landPrompt", 3000), `${name}: R LAND prompt shows`)
  await shot(page, `${prefix}-1-prompt`)
  const flares = await js<number>(page, "return c.flight.weapons.loadout.flares")
  await page.keyboard.press("KeyR")
  check(await until(page, "f.phase === 'landing'", 2000), `${name}: R starts the landing`)
  check((await js<number>(page, "return c.flight.weapons.loadout.flares")) === flares, `${name}: R dropped no flares`)
  await page.waitForTimeout(1500)
  await shot(page, `${prefix}-2-approach`)
  await until(page, "f.landing && f.landing.seg === f.landing.segs.length - 1", 20_000)
  await page.waitForTimeout(1200)
  await shot(page, `${prefix}-3-final`)
  check(await until(page, "f.landing && f.landing.phase !== 'approach'", 20_000), `${name}: touchdown`)
  await page.waitForTimeout(400)
  await shot(page, `${prefix}-4-trap`)
  const t0 = Date.now()
  check(await until(page, "c.flight.phase === 'idle'", 8000), `${name}: the flight ended (${Date.now() - t0} ms after the trap)`)
  check(await until(page, "(() => { const me = c.net.crew.players.find((p) => p.id === c.net.id); return me.role === 'pilot' && me.plane < 0 })()", 4000), `${name}: back on deck as a pilot, slot freed`)
  const f0 = await js<number>(page, "return globalThis.__frames")
  await page.waitForTimeout(1500)
  const f1 = await js<number>(page, "return globalThis.__frames")
  check(f1 - f0 > 30, `${name}: still running after landing (${f1 - f0} frames in 1.5 s)`)
  await shot(page, `${prefix}-5-on-deck`)
}

async function solo(): Promise<void> {
  const page = await open(`${base}?seed=7`, "solo")
  await page.waitForTimeout(3000)
  await launch(page, "solo")
  // F is flares away from the carrier: no prompt there.
  await warpNear(page, 4500, 1.6, 400)
  await page.waitForTimeout(400)
  check(!(await js<boolean>(page, "return f.landPrompt")), "solo: no prompt 4.5 km out")
  // 1.4 km off the starboard beam at 350 m, flying past: the prompt.
  await warpNear(page, 1400, -1.6, 350, 0.9)
  await landNow(page, "solo", "solo")
  // Head-on from ahead of the bow and from directly above also land.
  await launch(page, "solo 2")
  await warpNear(page, 1500, 0, 300)
  await page.waitForTimeout(300)
  await page.keyboard.press("KeyR")
  check(await until(page, "f.phase === 'landing'", 2000), "solo head-on: R starts the landing")
  await page.waitForTimeout(4500)
  await shot(page, "solo-6-head-on-swing")
  check(await until(page, "c.flight.phase === 'idle'", 25_000), "solo head-on: landed")
  await page.close()
}

async function mp(): Promise<void> {
  const chars = "abcdefghjkmnpqrstuvwxyz23456789"
  const room = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("")
  const a = await open(`${base}?room=${room}`, "ada")
  const b = await open(`${base}?room=${room}`, "bo")
  await a.waitForTimeout(4000)
  check((await js<string>(a, "return c.net.state")) === "online" && (await js<string>(b, "return c.net.state")) === "online", `room ${room}: both online`)
  const info = await js<{ me: number; team: number; ship: number; others: number[]; bship: number }>(
    a,
    `const me = c.net.crew.players.find((p) => p.id === c.net.id)
    return { me: me.id, team: me.team, ship: me.ship, others: c.net.crew.ships.filter((s) => s.team === me.team && s.id !== me.ship).map((s) => s.id), bship: -1 }`,
  )
  console.log(`A: player ${info.me} team ${info.team} ship ${info.ship}; other friendly ships ${info.others.join(",")}`)
  // A lands on its own carrier; B watches A's jet on the deck.
  await launch(a, "A")
  await warpNear(a, 1200, Math.PI * 0.75, 300, 0.3)
  check(await until(a, "f.landPrompt", 3000), "A: R LAND prompt (own carrier)")
  await a.keyboard.press("KeyR")
  check(await until(a, "f.phase === 'landing'", 2000), "A: landing on its own carrier")
  check(await until(b, "[...c.flight.remotes.jets.values()].some((j) => j.snaps.length && j.snaps[j.snaps.length - 1][1] === 3)", 8000), "B receives A's landing (ship-relative mode)")
  await until(a, "f.landing && f.landing.seg === f.landing.segs.length - 1", 20_000)
  await js(b, `const s = c.flight.carriers.find((x) => x.id === ${info.ship}); const F = [Math.sin(s.heading), -Math.cos(s.heading)], L = [-Math.cos(s.heading), -Math.sin(s.heading)];
    c.game.state.free = true; c.camera.set({ x: s.x - F[0] * 120 + L[0] * 60, z: s.z - F[1] * 120 + L[1] * 60, yaw: s.heading + 2.6, pitch: 0.32, dist: 330 }); c.camera.y = s.heave + 26`)
  await until(a, "f.landing && f.landing.phase !== 'approach'", 15_000)
  await b.waitForTimeout(250)
  await shot(b, "mp-1-b-sees-a-trap")
  check(await until(a, "c.flight.phase === 'idle'", 8000), "A: flight ended on its own carrier")
  check(await until(a, "(() => { const me = c.net.crew.players.find((p) => p.id === c.net.id); return me.role === 'pilot' && me.plane < 0 && me.ship === " + info.ship + " })()", 4000), "A: on deck of its own carrier as a pilot, slot free")
  await shot(a, "mp-2-a-on-own-deck")
  await js(b, "c.game.state.free = false")
  // A lands on the other friendly carrier.
  const other = info.others[0]
  if (other === undefined) {
    check(false, "no other friendly carrier in the room")
    return
  }
  await launch(a, "A 2")
  await warpNear(a, 900, Math.PI * 0.8, 250, 0.2, other)
  check(await until(a, "f.landPrompt", 3000), "A: R LAND prompt (other friendly carrier)")
  await shot(a, "mp-3-a-prompt-other")
  await a.keyboard.press("KeyR")
  check(await until(a, `f.phase === 'landing' && f.landingShip && f.landingShip.id === ${other}`, 2000), `A: landing on ship ${other}`)
  await page2frames(a)
  check(await until(a, "c.flight.phase === 'idle'", 25_000), "A: flight ended on the other carrier")
  check(await until(a, `(() => { const me = c.net.crew.players.find((p) => p.id === c.net.id); return me.role === 'pilot' && me.plane < 0 && me.ship === ${other} })()`, 4000), `A: aboard ship ${other} as a pilot on deck`)
  await a.waitForTimeout(1200)
  await shot(a, "mp-5-a-aboard-other")
  await a.close()
  await b.close()
}

async function page2frames(a: Page): Promise<void> {
  await until(a, "f.landing && f.landing.phase !== 'approach'", 25_000)
  await a.waitForTimeout(300)
  await shot(a, "mp-4-a-trap-other")
}

/** The catapult launch: parked, then frames pinned at stroke times (s) after launchStart, and at the bow. */
async function launchShots(): Promise<void> {
  const page = await open(`${base}?seed=7`, "launch")
  await page.waitForTimeout(3000)
  await js(page, "c.net.op('hornet')")
  check(await until(page, "f.launch && f.launch.phase === 'ready'", 6000), "launch: parked on the shuttle")
  // Hold it parked for the first frame.
  await js(page, "globalThis.__pin = setInterval(() => { if (f.launch && f.launch.phase === 'ready') f.launch.time = 0 }, 5)")
  await page.waitForTimeout(1500)
  await shot(page, "launch-v2/00-parked")
  const T = await js<number>(page, "return 4.2")
  for (const [name, at] of [["01-start-0.0s", 0.02], ["02-0.5s", 0.5], ["03-1.5s", 1.5], ["04-3.0s", 3], ["05-bow", T - 0.06]] as const) {
    await js(page, `clearInterval(globalThis.__pin); globalThis.__pin = setInterval(() => { if (f.launch && f.launch.phase !== 'airborne') { if (f.launch.phase === 'ready') f.launch.time = 99; else f.launch.time = ${at} } }, 5)`)
    await until(page, "f.launch && f.launch.phase === 'stroke'", 3000)
    await page.waitForTimeout(500)
    const st = await js<string>(page, "return `stroke t ${f.launch.time.toFixed(2)} z ${f.launch.z.toFixed(1)} v ${f.launch.speed.toFixed(1)} progress ${f.launch.progress.toFixed(2)} throttle ${f.launch.throttle} burner ${f.launch.burner}`")
    console.log(name, st)
    await shot(page, `launch-v2/${name}`)
  }
  await js(page, "clearInterval(globalThis.__pin)")
  check(await until(page, "f.phase === 'flying'", 6000), "launch: left the bow, flying")
  await page.waitForTimeout(1500)
  await shot(page, "launch-v2/06-airborne")
  // A second launch on the same ship while one is on the catapult is refused (offline: the same rule, locally).
  await page.close()
}

try {
  if (only.includes("launch")) await launchShots()
  if (only.includes("solo")) await solo()
  if (only.includes("mp")) await mp()
} catch (e) {
  check(false, `aborted: ${(e as Error).message}`)
}
console.log(failures ? `${failures} FAILED` : "all ok")
await browser.close()
await budget.exit(failures ? 1 : 0)
