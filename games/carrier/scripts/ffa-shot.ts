// Every carrier for itself, on a real GPU. Runs ON hailmary (Mac Studio): three pages in one fresh room, each on a
// carrier of its own (teams 0, 1, 2: orange, cyan, pink). Ship damage goes round the ring (A strafes B's carrier, B
// strafes C's, C strafes A's) and jet kills too (A guns B's jet down, then C guns A's), so every page has damaged and
// been damaged by both others. Captures the Tab ships list, the kill feed in each carrier's colour and the colours on
// the jets and carriers, through each game's own device under the DOM (scripts/ships-shot.ts).
//
//   ssh hailmary 'cd /tmp/carrier-ffa && ~/.bun/bin/bun ffa-shot.ts --out=/tmp/carrier-ffa/out'
//
// Options: --base=URL  --size=1536x960
import { type Page } from "playwright-core"
import { browserBudget } from "../../../scripts/browser-budget"
import { mkdirSync } from "node:fs"
import { join } from "node:path"

await using budget = browserBudget()
const { chromium } = budget

const args = process.argv.slice(2)
const opt = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
const base = opt("base", "https://carrier.lwoyjcaeyxv6.opentunnel.xyz/")
const out = opt("out", "/tmp/carrier-ffa/out")
const [vw, vh] = opt("size", "1536x960").split("x").map(Number) as [number, number]
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

async function open(url: string, name: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1 })
  page.on("console", (m) => {
    if (m.type() === "error") logs.push(`${name} ${m.type()}: ${m.text()}`)
  })
  page.on("pageerror", (e) => logs.push(`${name} pageerror: ${e.message}`))
  // Vite's HMR socket would reload the page when another agent edits a file mid-run.
  await page.addInitScript(() => {
    const Real = WebSocket
    const Fake = function (this: unknown, url: string | URL, protocols?: string | string[]) {
      const p = Array.isArray(protocols) ? protocols : protocols ? [protocols] : []
      if (p.some((x) => x.startsWith("vite"))) return Object.assign(new EventTarget(), { readyState: 0, send() {}, close() {} })
      return new Real(url, protocols)
    } as unknown as typeof WebSocket
    Object.assign(Fake, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3, prototype: Real.prototype })
    globalThis.WebSocket = Fake
  })
  await page.addInitScript((n) => localStorage.setItem("carrier.name", n), name)
  await page.goto(url, { waitUntil: "load" })
  await page.waitForFunction(() => !!(globalThis as unknown as { carrier?: { flight?: unknown } }).carrier?.flight, null, { timeout: 60_000 })
  return page
}

type M = { online: string; id: number; team: number; role: string; ship: number; phase: string; crashed: string; hp: number; shipHp: number; feed: string; kd: string; remote: number }
const st = (p: Page): Promise<M> =>
  p.evaluate(() => {
    type C = {
      net: { state: string; id: number; crew: { players: { id: number; team: number; ship: number }[] } | null; hulls: Map<number, { hp: number }>; stats: Map<number, { kills: number; deaths: number }> }
      game: { state: { role: string } }
      flight: { flight: { phase: string; plane: { crashed: string } }; weaponStatus: { hp: number }; remotes: { jets: Map<number, unknown> } }
    }
    const c = (globalThis as unknown as { carrier: C }).carrier
    const me = c.net.crew?.players.find((p) => p.id === c.net.id)
    const txt = (s: string) => ((document.querySelector(s) as HTMLElement | null)?.innerText ?? "").replace(/\s+/g, " ").trim()
    return {
      online: c.net.state,
      id: c.net.id,
      team: me?.team ?? -1,
      role: c.game.state.role,
      ship: me?.ship ?? -1,
      phase: c.flight.flight.phase,
      crashed: c.flight.flight.plane.crashed,
      hp: c.flight.weaponStatus.hp,
      shipHp: me ? (c.net.hulls.get(me.ship)?.hp ?? -1) : -1,
      feed: txt("#wp .feed"),
      kd: [...c.net.stats].map(([id, v]) => `${id}:${v.kills}/${v.deaths}`).join(" "),
      remote: c.flight.remotes.jets.size,
    }
  })
const fmt = (m: M) => `${m.online} id ${m.id} team ${m.team} ${m.role} ship ${m.ship} ${m.phase}${m.crashed ? `(${m.crashed})` : ""} jet hp ${m.hp.toFixed(0)} ship hp ${m.shipHp.toFixed(1)} feed "${m.feed}" kd "${m.kd}"`
async function until(p: Page, ok: (m: M) => boolean, ms = 15_000): Promise<M> {
  const end = Date.now() + ms
  let m = await st(p)
  while (!ok(m) && Date.now() < end) {
    await p.waitForTimeout(80)
    m = await st(p)
  }
  return m
}
const run = (p: Page, js: string) => p.evaluate(js)

/** The current frame under the DOM, then a page screenshot. */
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
    img.id = "shot-bg"
    img.src = src
    Object.assign(img.style, { position: "fixed", inset: "0", width: "100%", height: "100%", zIndex: "0" })
    const canvas = document.getElementById("view")!
    canvas.style.visibility = "hidden"
    canvas.after(img)
    return new Promise((r) => (img.complete ? r(null) : (img.onload = () => r(null))))
  }, url)
  await page.screenshot({ path: join(out, `${name}.png`) })
  await page.evaluate(() => {
    document.getElementById("shot-bg")?.remove()
    document.getElementById("view")!.style.visibility = ""
  })
  console.log(`${name}: ${fmt(await st(page))}`)
}

/** Page `p`'s jet in flight relative to carrier `ship` as that page draws it (ship-local lx port, up above the deck, lz ahead). */
const near = (p: Page, ship: number, lx: number, up: number, lz: number, speed: number, pitch = 0, turn = 0) =>
  p.evaluate(
    ([ship, lx, up, lz, speed, pitch, turn]) => {
      type S = { id: number; x: number; z: number; heading: number; heave: number; u: number }
      type P = Record<string, number | string>
      const c = (globalThis as unknown as { carrier: { flight: { carriers: S[]; flight: { plane: P; prev: P; cam: { reset(): void } }; input: { override: unknown } } } }).carrier
      const s = c.flight.carriers.find((x) => x.id === ship)
      if (!s) return false
      const f = [Math.sin(s.heading), -Math.cos(s.heading)]
      const r = [Math.cos(s.heading), Math.sin(s.heading)]
      const x = s.x + f[0]! * lz - r[0]! * lx
      const z = s.z + f[1]! * lz - r[1]! * lx
      const h = s.heading + turn!
      const fh = [Math.sin(h), -Math.cos(h)]
      const a = (Math.PI - h) / 2
      const qy = Math.sin(a)
      const qw = Math.cos(a)
      const pa = -pitch! / 2
      const px = Math.sin(pa)
      const pw = Math.cos(pa)
      const v = speed!
      const pl = c.flight.flight.plane
      Object.assign(pl, { x, y: s.heave + 26 + up!, z, qx: qw * px, qy: qy * pw, qz: -qy * px, qw: qw * pw, vx: fh[0]! * v * Math.cos(pitch!) + f[0]! * s.u, vy: v * Math.sin(pitch!), vz: fh[1]! * v * Math.cos(pitch!) + f[1]! * s.u, p: 0, r: 0, w: 0, throttle: 0.77, blend: 1, stall: 0, outside: 0 })
      Object.assign(c.flight.flight.prev, pl)
      c.flight.flight.cam.reset()
      c.flight.input.override = { pitch: 0, roll: 0, yaw: 0 }
      return true
    },
    [ship, lx, up, lz, speed, pitch, turn],
  )
/** Page `p`'s jet in level flight at (x, y, z), nose along compass `heading`, at cruise. */
const place = (p: Page, x: number, y: number, z: number, heading: number) =>
  p.evaluate(
    ([x, y, z, h]) => {
      type P = Record<string, number | string>
      const c = (globalThis as unknown as { carrier: { flight: { flight: { plane: P; prev: P; cam: { reset(): void } }; input: { override: unknown } } } }).carrier
      const f = c.flight.flight
      const a = (Math.PI - h!) / 2
      Object.assign(f.plane, { x, y, z, qx: 0, qy: Math.sin(a), qz: 0, qw: Math.cos(a), vx: 140 * Math.sin(h!), vy: 0, vz: -140 * Math.cos(h!), p: 0, r: 0, w: 0, throttle: 140 / 182, blend: 1, stall: 0, outside: 0 })
      Object.assign(f.prev, f.plane)
      f.cam.reset()
      c.flight.input.override = { pitch: 0, roll: 0, yaw: 0 }
    },
    [x, y, z, heading],
  )
const trigger = (p: Page, on: boolean) => p.evaluate((on) => ((globalThis as unknown as { carrier: { flight: { weapons: { input: { trigger: boolean | null } } } } }).carrier.flight.weapons.input.trigger = on), on)
const stick = (p: Page, v: { pitch: number; roll: number } | null) => p.evaluate((v) => ((globalThis as unknown as { carrier: { flight: { input: { override: unknown } } } }).carrier.flight.input.override = v), v)
/** Parks a jet high over the middle of the map, out of everyone's way. */
const park = (p: Page, i: number) => place(p, -3000 + i * 3000, 2500, 3000, Math.PI)

/** `shooter` strafes `victim`'s carrier from astern: gun damage on the deck. */
async function strafe(shooter: Page, ship: number): Promise<void> {
  await shooter.bringToFront()
  await near(shooter, ship, 15, 160, -900, 120, -0.17)
  await shooter.waitForTimeout(200)
  await trigger(shooter, true)
  await shooter.waitForTimeout(2500)
  await trigger(shooter, false)
  await stick(shooter, { pitch: 1, roll: 0 })
  await shooter.waitForTimeout(600)
}

/** `a` lines up 280 m behind `b`'s jet over open water and guns it down. */
async function gunDown(a: Page, b: Page, i: number): Promise<M> {
  const x = -4000 + i * 4000
  const z = -2000
  await place(b, x, 1200, z, 0)
  await place(a, x, 1200, z + 280, 0)
  await a.bringToFront()
  await a.waitForTimeout(700)
  await until(a, (m) => m.remote > 0, 3000)
  await trigger(a, true)
  const mb = await until(b, (m) => m.phase === "crashed", 8000)
  await trigger(a, false)
  return mb
}

const room = `ffa${Math.floor(Math.random() * 1e6)}`
const pages = [await open(`${base}?room=${room}`, "ADA")]
await until(pages[0]!, (m) => m.online === "online" && m.role !== "none", 20_000)
pages.push(await open(`${base}?room=${room}`, "BO"))
await until(pages[1]!, (m) => m.online === "online" && m.role !== "none", 20_000)
pages.push(await open(`${base}?room=${room}`, "CY"))
await until(pages[2]!, (m) => m.online === "online" && m.role !== "none", 20_000)
const [a, b, c] = pages as [Page, Page, Page]
let ms = await Promise.all(pages.map((p) => st(p)))
console.log(`room ${room}\n${ms.map(fmt).join("\n")}`)
check(ms.map((m) => m.team).join() === "0,1,2" && ms.every((m) => m.role === "helm") && new Set(ms.map((m) => m.ship)).size === 3, "three joiners, three carriers, three sides: each at their own helm")
const ships = ms.map((m) => m.ship)

// The Tab ships list: every carrier in its colour with its crew, a free-for-all.
await a.bringToFront()
await a.keyboard.press("Tab")
await a.waitForTimeout(600)
const cards = await a.locator(".tm-ship").count()
const head = (await a.locator(".tm-head").innerText()).replace(/\s+/g, " ")
check(cards === 4 && /FREE FOR ALL/.test(head), `Tab lists the four carriers (${cards}), header "${head}"`)
await shot(a, "01-tab-ships")
await a.keyboard.press("Tab")
await a.waitForTimeout(300)

// Everyone launches a Hornet and opts out of the auto-landing for the run.
for (const p of pages) await run(p, 'carrier.net.op("hornet")')
ms = await Promise.all(pages.map((p) => until(p, (m) => m.phase === "flying", 20_000)))
check(ms.every((m) => m.phase === "flying"), "all three airborne")
for (const p of pages) await run(p, "carrier.flight.flight.landables = []")
for (const [i, p] of pages.entries()) await park(p, i)
await a.waitForTimeout(1500)

// Ship damage round the ring: A strafes B's carrier, B strafes C's, C strafes A's.
const before = (await Promise.all(pages.map((p) => st(p)))).map((m) => m.shipHp)
for (const [i, p] of pages.entries()) {
  const victim = (i + 1) % 3
  await strafe(p, ships[victim]!)
  if (i === 2) await shot(p, "02-c-strafes-a-carrier")
  await park(p, i)
}
await a.waitForTimeout(1500)
ms = await Promise.all(pages.map((p) => until(p, (m) => m.shipHp < before[pages.indexOf(p)]! - 2, 5000)))
for (const [i, m] of ms.entries()) check(m.shipHp < before[i]! - 2, `${"ABC"[i]}'s carrier took ${"CAB"[i]}'s rounds: ${before[i]!.toFixed(1)} -> ${m.shipHp.toFixed(1)}`)

// Jet kills for the kill feed: A guns down B's jet, then C guns down A's.
let mb = await gunDown(a, b, 0)
check(mb.phase === "crashed", `A shot B down: ${fmt(mb)}`)
await park(a, 0)
await c.waitForTimeout(1500)
const ma = await gunDown(c, a, 2)
check(ma.phase === "crashed", `C shot A down: ${fmt(ma)}`)
await c.waitForTimeout(600)
const mc = await until(c, (m) => /ADA/.test(m.feed) && /BO/.test(m.feed) && /CY/.test(m.feed), 4000)
check(/CY.*ADA/.test(mc.feed) && /ADA.*BO/.test(mc.feed), `C's kill feed shows both kills: "${mc.feed}"`)
const colours = await c.evaluate(() => [...document.querySelectorAll("#wp .feed *")].map((e) => `${(e as HTMLElement).innerText.trim()}=${getComputedStyle(e).color}`).filter((s) => /^[A-Z]+=/.test(s)))
console.log(`feed colours on C: ${colours.join(" ")}`)
check(new Set(colours.map((s) => s.split("=")[1])).size >= 3, "the feed names wear three different carrier colours")
await shot(c, "03-c-kill-feed")
await c.keyboard.press("Tab")
await c.waitForTimeout(600)
await shot(c, "04-c-tab-ships-kd")
await c.keyboard.press("Tab")
mb = await st(b)
const kd = mb.kd
check(kd.includes(`${ms[0]!.id}:1/1`) && kd.includes(`${ms[2]!.id}:1/0`) && kd.includes(`${ms[1]!.id}:0/1`), `tallies: ${kd}`)

// The Tab preview (three crewed carriers and a refitting berth with CREATE SHIP) and the load screen's footer.
for (const p of pages) await p.close()
const preview = await open(`${base}menu.html?seed=7&show=teams`, "preview")
await preview.waitForTimeout(1500)
check((await preview.locator(".tm-berth [data-tm=create]").count()) === 1, "the preview's empty berth offers CREATE SHIP")
await shot(preview, "05-preview-tab-berth")
await preview.close()
const menu = await open(`${base}?shell`, "menu")
await menu.waitForTimeout(1500)
const foot = (await menu.locator(".as-card .as-controls").innerText()).replace(/\s+/g, " ")
check(/ships/i.test(foot) && !/teams/i.test(foot), `title footer: "${foot}"`)
await shot(menu, "06-start-menu")

console.log(logs.length ? `console:\n${logs.slice(0, 30).join("\n")}` : "console: clean")
console.log(failures ? `${failures} FAILED` : "all checks passed")
await browser.close()
await budget.exit(failures ? 1 : 0)
