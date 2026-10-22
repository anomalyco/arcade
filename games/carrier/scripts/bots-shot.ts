// Bot captures on a real GPU (dev builds and dev rooms only). Runs ON hailmary (Mac Studio): Chrome with WebGPU on
// Metal loads the live dev server's game in a fresh dev room, opens the BOTS tab of the debug menu and drives its real
// buttons, capturing the frame under the DOM (menus, HUD) as scripts/f35-shot.ts does.
//
//   ssh hailmary 'cd /tmp/carrier-bots && ~/.bun/bin/bun bots-shot.ts --out=/tmp/carrier-bots/out'
//
// Steps (--only=panel,duel,bomber,boat,prod): panel: the BOTS tab open in a dev room. duel: ADA flies, "1v1 dogfight ·
// 2 km" spawns a dogfighter that closes and shoots at her; her client's rounds (the `hits` path) shoot it down. bomber:
// BO, at the helm of another carrier, runs "Bomber run on my carrier": an F-35C bot bombs it. boat: BO runs "Boat attack
// ×2". prod: a production build (--prod=URL, the built dist served as is) has no debug menu: ` does nothing.
import { chromium, type Page } from "playwright-core"
import { mkdirSync } from "node:fs"
import { join } from "node:path"

const args = process.argv.slice(2)
const opt = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
const base = opt("base", "https://carrier.lwoyjcaeyxv6.opentunnel.xyz/")
const prod = opt("prod", "")
const out = opt("out", "/tmp/carrier-bots/out")
const [vw, vh] = opt("size", "1536x960").split("x").map(Number) as [number, number]
const only = opt("only", "panel,duel,bomber,boat,prod").split(",")
const room = opt("room", `bots-${Math.floor(Math.random() * 1e6)}`)
mkdirSync(out, { recursive: true })

const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--enable-features=WebGPU", "--ignore-gpu-blocklist", "--disable-background-timer-throttling", "--disable-renderer-backgrounding"],
})
let failures = 0
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`)
  if (!ok) failures++
}

async function open(url: string, name: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1 })
  page.on("console", (m) => {
    if (m.type() === "error") console.log(`${name} error: ${m.text()}`)
  })
  page.on("pageerror", (e) => console.log(`${name} pageerror: ${e.message}`))
  // Other agents edit files on the shared dev server: keep Vite's HMR socket from reloading the page mid-run.
  await page.addInitScript((n) => {
    localStorage.setItem("carrier.name", n)
    const Real = WebSocket
    const Fake = function (this: unknown, url: string | URL, protocols?: string | string[]) {
      const p = Array.isArray(protocols) ? protocols : protocols ? [protocols] : []
      if (p.some((x) => x.startsWith("vite"))) return Object.assign(new EventTarget(), { readyState: 0, send() {}, close() {} })
      const ws = new Real(url, protocols)
      const at = performance.now()
      ws.addEventListener("close", (e) => ((globalThis as { __closes?: string[] }).__closes ??= []).push(`${Math.round((performance.now() - at) / 100) / 10}s code ${e.code} ${e.reason}`))
      return ws
    } as unknown as typeof WebSocket
    Object.assign(Fake, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3, prototype: Real.prototype })
    globalThis.WebSocket = Fake
  }, name)
  await page.goto(url, { waitUntil: "load" })
  await page.waitForFunction(() => !!(globalThis as { carrier?: { game?: { state: { sea: unknown } } } }).carrier?.game?.state.sea, null, { timeout: 60_000 })
  // `__look` puts the flight camera at `eye` looking at `at`.
  await page.evaluate(() => {
    type V = [number, number, number]
    type Cam = { eye: V; forward: V; up: V; fov: number; update(...rest: unknown[]): void }
    const g = globalThis as unknown as { carrier: { flight: { flight: { cam: Cam } } }; __look: { eye: V; at: V } | null }
    g.__look = null
    const cam = g.carrier.flight.flight.cam
    const orig = cam.update.bind(cam)
    cam.update = (...rest) => {
      orig(...rest)
      const l = g.__look
      if (!l) return
      const f: V = [l.at[0] - l.eye[0], l.at[1] - l.eye[1], l.at[2] - l.eye[2]]
      const n = Math.hypot(...f)
      cam.eye.splice(0, 3, ...l.eye)
      cam.forward.splice(0, 3, f[0] / n, f[1] / n, f[2] / n)
      cam.up.splice(0, 3, 0, 1, 0)
      cam.fov = (50 * Math.PI) / 180
    }
  })
  return page
}

const js = <T = unknown>(page: Page, fn: string): Promise<T> => page.evaluate(`(() => { const c = globalThis.carrier; const n = c.net; const f = c.flight.flight; ${fn} })()`) as Promise<T>

/** The current frame as a PNG data URL, read back through the game's device. */
async function frame(page: Page): Promise<string> {
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

/** Frame under the DOM (menus, HUD), then a page screenshot. */
async function shot(page: Page, name: string): Promise<void> {
  const url = await frame(page)
  await page.evaluate((src) => {
    const img = document.createElement("img")
    img.id = "bots-shot-bg"
    img.src = src
    Object.assign(img.style, { position: "fixed", inset: "0", width: "100%", height: "100%", zIndex: "0" })
    const canvas = document.getElementById("view")!
    canvas.style.visibility = "hidden"
    canvas.after(img)
    return new Promise((r) => (img.complete ? r(null) : (img.onload = () => r(null))))
  }, url)
  await page.screenshot({ path: join(out, `${name}.png`) })
  await page.evaluate(() => {
    document.getElementById("bots-shot-bg")?.remove()
    document.getElementById("view")!.style.visibility = ""
  })
  console.log(`shot ${name}`)
}

async function until(page: Page, cond: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await js<boolean>(page, `return !!(${cond})`)) return true
    await page.waitForTimeout(100)
  }
  return false
}

/** Clicks a Bots button on the dev panel by its label. */
async function press(page: Page, label: string): Promise<void> {
  await js(page, `if (!c.debugMenu.visible) c.debugMenu.open("bots"); else c.debugMenu.select("bots")`)
  await page.waitForTimeout(400)
  const b = page.locator("[data-carrier-dev] button", { hasText: label }).first()
  await b.click({ timeout: 5000 })
  console.log(`pressed "${label}"`)
  await page.waitForTimeout(300)
}

const closeMenu = (page: Page) => js(page, "c.debugMenu.close()")

/** Our jet in free flight at (x, y, z) heading h (rad), level, at `speed`. */
const warp = (page: Page, x: number, y: number, z: number, h: number, speed: number) =>
  js(
    page,
    `const p = f.plane
    Object.assign(p, { x: ${x}, y: ${y}, z: ${z}, vx: ${speed} * Math.sin(${h}), vy: 0, vz: ${-speed} * Math.cos(${h}), p: 0, r: 0, w: 0, throttle: 0.75, crashed: "", blend: 1, stall: 0, outside: 0 })
    const a = (Math.PI - ${h}) / 2
    Object.assign(p, { qx: 0, qy: Math.sin(a), qz: 0, qw: Math.cos(a) })
    Object.assign(f.prev, p)
    f.phase = "flying"
    f.airborne = 10
    f.landing = null`,
  )

const url = `${base}?room=${room}&tod=10.5&weather=clear`

if (only.includes("panel") || only.includes("duel")) {
  const a = await open(`${url}&bots`, "ada")
  await a.waitForTimeout(2500)
  const status = await js<string>(a, `return document.querySelector('[data-carrier-dev] .knobs-row[data-field="bots-status"]')?.textContent ?? ""`)
  check(/dev room/i.test(status), `panel status: ${status}`)
  check(await js<boolean>(a, "return n.dev"), "the room says it is in dev mode")
  await shot(a, "panel")
  if (only.includes("duel")) {
    await closeMenu(a)
    await js(a, `n.op("hornet")`)
    check(await until(a, "f.mode === 1", 20_000), "ADA is airborne")
    const s = await js<{ x: number; z: number }>(a, "return { x: f.plane.x, z: f.plane.z }")
    await warp(a, s.x, 1100, s.z - 1500, 0, 150)
    await a.waitForTimeout(500)
    await press(a, "1v1 dogfight")
    await closeMenu(a)
    check(await until(a, "n.bots.length === 1 && [...n.planes.keys()].includes(n.bots[0].id)", 8000), `a dogfighter is up and relayed (${await js(a, "return n.bots.map(b => b.name + ' ' + b.state).join()")})`)
    console.log("raw", await a.evaluate(async (r) => {
      const { BUILD } = await import(/* @vite-ignore */ `${location.origin}/shared/build.gen.ts`)
      ;(globalThis as any).__build = BUILD
      const ws = new WebSocket(`${location.origin.replace("http", "ws")}/ws?room=${r}`)
      const got: string[] = []
      ws.onopen = () => ws.send(JSON.stringify({ type: "hello", build: (globalThis as any).__build ?? "x", name: "diag" }))
      ws.onmessage = (e) => got.push(String(e.data).slice(0, 600))
      await new Promise((res) => setTimeout(res, 1500))
      ws.close()
      return got.filter((g) => !g.includes('"crew"')).slice(0, 6).join("\n")
    }, room))
    console.log("diag", await js(a, `return JSON.stringify({ closes: globalThis.__closes ?? [], state: n.state, room: n.room, phase: f.phase, crashed: f.plane.crashed, y: Math.round(f.plane.y), planes: [...n.planes.keys()], bots: n.bots, hp: c.flight.weapons.world.hp(n.id) })`))
    const look = (from: "me" | "bot", back = 60, up = 14) =>
      js(
        a,
        `const b = n.bots[0]; const t = b && n.planes.get(b.id); if (!t) return
        const p = f.plane; const me = [p.x, p.y, p.z], bot = [t[2], t[3], t[4]]
        const [o, q] = ${from === "me" ? "[me, bot]" : "[bot, me]"}
        const d = [q[0] - o[0], q[1] - o[1], q[2] - o[2]], l = Math.hypot(...d)
        globalThis.__look = { eye: [o[0] - d[0] / l * ${back}, o[1] - d[1] / l * ${back} + ${up}, o[2] - d[2] / l * ${back}], at: q }`,
      )
    let closing = false
    let hit = false
    const end = Date.now() + 60_000
    while (Date.now() < end && !hit) {
      const st = await js<{ d: number; hp: number; seek: boolean }>(a, `const b = n.bots[0]; const t = b && n.planes.get(b.id); const p = f.plane; return { d: t ? Math.hypot(t[2] - p.x, t[3] - p.y, t[4] - p.z) : 1e9, hp: c.flight.weapons.world.hp(n.id), seek: !!b }`)
      if (!closing && st.d < 900) {
        closing = true
        await look("bot", 70, 12)
        await shot(a, "duel-closing")
        await js(a, "globalThis.__look = null")
      }
      if (st.hp < 100) {
        hit = true
        await look("bot", 50, 8)
        await shot(a, "duel-shot-at")
        await js(a, "globalThis.__look = null")
        await shot(a, "duel-hit-hud")
        console.log(`ADA hp ${st.hp}, bot ${Math.round(st.d)} m away`)
      }
      await a.waitForTimeout(150)
    }
    check(closing, "the dogfighter closed within 900 m")
    check(hit, "the dogfighter's rounds or missile hit ADA")
    // ADA's client reports rounds on it through the room's hits check (range, budget, alive enemies).
    const botId = await js<number>(a, "return n.bots[0]?.id ?? -1")
    // Hold its fire (the panel's set command) so ADA lives to return it.
    await js(a, `n.sendBot({ c: "set", ids: [${botId}], s: { weapons: false } })`)
    // Shot down by it? Launch again (the ship's other Hornet) and come in 600 m behind it.
    if (!(await js<boolean>(a, "return f.mode === 1 && c.flight.weapons.world.hp(n.id) > 0"))) {
      await until(a, "f.phase === 'idle' || f.mode === 0", 10_000)
      await a.waitForTimeout(3000)
      await js(a, `n.op("hornet")`)
      check(await until(a, "f.mode === 1", 20_000), "ADA launched again")
    }
    const tail = await js<number[] | null>(a, `const t = n.planes.get(${botId}); if (!t) return null; const sp = Math.hypot(t[9], t[11]) || 1; return [t[2] - t[9] / sp * 600, t[3], t[4] - t[11] / sp * 600, Math.atan2(t[9], -t[11])]`)
    if (tail) await warp(a, tail[0]!, tail[1]!, tail[2]!, tail[3]!, 170)
    let down = false
    for (let i = 0; i < 160 && !down; i++) {
      await js(a, `const t = n.planes.get(${botId}); const p = f.plane; if (t && Math.hypot(t[2] - p.x, t[3] - p.y, t[4] - p.z) < 1600) n.sendHits(${botId}, 30)`)
      await a.waitForTimeout(250)
      down = await js<boolean>(a, `return n.planes.get(${botId})?.[1] === 2`)
    }
    if (!down) console.log("shoot diag", await js(a, `const t = n.planes.get(${botId}); const p = f.plane; return JSON.stringify({ d: t ? Math.round(Math.hypot(t[2] - p.x, t[3] - p.y, t[4] - p.z)) : null, mode: t?.[1], me: c.flight.weapons.world.hp(n.id), phase: f.phase, bot: n.bots.map(b => [b.state, b.hp, b.note]) })`))
    check(down, "ADA's rounds shot the bot down (its relayed jet reads crashed)")
    await a.waitForTimeout(250)
    const wreck = await js<number[] | null>(a, `const t = n.planes.get(${botId}); return t ? [t[2], t[3], t[4]] : null`)
    if (wreck) await js(a, `globalThis.__look = { eye: [${wreck[0]} + 160, ${wreck[1]} + 50, ${wreck[2]} + 160], at: [${wreck[0]}, ${wreck[1]} - 20, ${wreck[2]}] }`)
    await shot(a, "duel-bot-down")
    await js(a, "globalThis.__look = null")
    const feed = await js<string>(a, `return document.body.innerText.match(/[^\\n]*BOT·[^\\n]*/g)?.slice(0, 4).join(" | ") ?? ""`)
    console.log(`kill feed: ${feed}`)
    await shot(a, "duel-feed")
    await press(a, "Remove all bots")
    await a.waitForTimeout(1500)
    await shot(a, "duel-panel-after")
    await a.close()
  }
}

if (only.includes("bomber") || only.includes("boat")) {
  const b = await open(`${base}?room=${room}-b&tod=10.5&weather=clear&bots`, "bo")
  await b.waitForTimeout(2000)
  const ship = await js<number>(b, "return c.game.state.shipId")
  console.log(`BO at the helm of ship ${ship}`)
  const view = (dist: number, pitch: number, yaw: number) =>
    js(b, `const s = c.game.state.ship; c.game.state.free = true; c.camera.set({ x: s.x, z: s.z, yaw: ${yaw}, pitch: ${pitch}, dist: ${dist} })`)
  if (only.includes("bomber")) {
    await press(b, "Bomber run on my carrier")
    await closeMenu(b)
    check(await until(b, "n.bots.some(x => x.role === 'f35' && x.state === 'flying')", 8000), "an F-35C bomber is flying")
    let near = false
    const end = Date.now() + 120_000
    while (Date.now() < end) {
      const st = await js<{ d: number; hp: number }>(b, `const x = n.bots.find(x => x.role === 'f35'); const t = x && n.planes.get(x.id); const s = c.game.state.ship; return { d: t ? Math.hypot(t[2] - s.x, t[4] - s.z) : 1e9, hp: n.hulls.get(${ship})?.hp ?? 1000 }`)
      if (!near && st.d < 1600) {
        near = true
        await js(b, `const x = n.bots.find(x => x.role === 'f35'); const t = n.planes.get(x.id); c.game.state.free = true; c.camera.set({ x: t[2], z: t[4], yaw: Math.atan2(t[9], -t[11]) * 180 / Math.PI + 160, pitch: 12, dist: 120 })`)
        await shot(b, "bomber-run")
      }
      if (st.hp < 1000) {
        await view(520, 22, 30)
        await b.waitForTimeout(600)
        await shot(b, "bomber-hit")
        console.log(`BO's carrier hull ${Math.round(st.hp)} / 1000`)
        break
      }
      await b.waitForTimeout(150)
    }
    check(near, "the bomber came over BO's carrier")
    check(await js<number>(b, `return n.hulls.get(${ship})?.hp ?? 1000`) < 1000, "its bombs hit BO's carrier")
    await b.waitForTimeout(2500)
    await shot(b, "bomber-after")
    await press(b, "Remove all bots")
    await closeMenu(b)
  }
  if (only.includes("boat")) {
    await press(b, "Boat attack")
    await closeMenu(b)
    check(await until(b, "n.bots.filter(x => x.role === 'boat' && x.state === 'driving').length === 2", 15_000), "two attack boats are in the water")
    await b.waitForTimeout(6000)
    await js(b, `const x = n.bots.find(x => x.role === 'boat'); const t = n.boats.get(x.id); c.game.state.free = true; c.camera.set({ x: t[2], z: t[3], yaw: t[4] * 180 / Math.PI + 150, pitch: 14, dist: 70 })`)
    await shot(b, "boat-attack")
    const fired = await until(b, "n.bots.some(x => x.role === 'boat' && /attack →/.test(x.note)) && [...n.boats.values()].some(t => t[18] === 1)", 40_000)
    check(fired, `a boat attacks and fires (${await js(b, "return n.bots.map(x => x.note).join(' | ')")})`)
    await js(b, `const x = n.bots.find(x => x.role === 'boat'); const t = n.boats.get(x.id); c.camera.set({ x: t[2], z: t[3], yaw: t[4] * 180 / Math.PI + 150, pitch: 14, dist: 70 })`)
    await shot(b, "boat-firing")
    await press(b, "Remove all bots")
  }
  await b.close()
}

if (only.includes("prod") && prod) {
  const p = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1 })
  await p.goto(`${prod}?seed=7&tod=10.5`, { waitUntil: "load" })
  await p.waitForFunction(() => !!(globalThis as { carrier?: { game?: { state: { sea: unknown } } } }).carrier?.game?.state.sea, null, { timeout: 60_000 })
  await p.waitForTimeout(2000)
  await p.keyboard.press("Backquote")
  await p.waitForTimeout(500)
  const none = await p.evaluate(() => !document.querySelector("[data-carrier-dev]") && !document.querySelector("[data-lab-panel]") && !(globalThis as unknown as { carrier: { debugMenu?: unknown } }).carrier.debugMenu)
  check(none, "a production build has no dev panel (` does nothing)")
  await p.screenshot({ path: join(out, "prod-no-menu.png") })
  // The dev entry points do nothing either: ?bots, ?lab=weather, ?sounds=1.
  await p.goto(`${prod}?seed=7&tod=10.5&bots&lab=weather&sounds=1`, { waitUntil: "load" })
  await p.waitForFunction(() => !!(globalThis as { carrier?: { game?: { state: { sea: unknown } } } }).carrier?.game?.state.sea, null, { timeout: 60_000 })
  await p.waitForTimeout(1500)
  check(await p.evaluate(() => !document.querySelector("[data-lab-panel]") && (globalThis as unknown as { carrier: { net: { state: string } } }).carrier.net.state === "offline"), "?bots, ?lab=weather and ?sounds=1 open nothing; ?seed stays offline")
  await p.close()
}

await browser.close()
console.log(failures ? `${failures} FAILED` : "all ok")
process.exit(failures ? 1 : 0)
