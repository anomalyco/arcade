// Text chat on a real GPU. Runs ON hailmary: three pages in one fresh room. ADA and BO each helm a carrier of their
// own (enemies); CY boards ADA's carrier (her crew). Checks chat both ways (T, everyone), the crew channel (Y) reaching
// ADA but not BO, and that typing W/S/E/M/G/Tab/` into the open input moves nothing and opens nothing. Captures into
// --out (games/carrier/captures/chat/ once copied back).
//
//   ssh hailmary 'cd /tmp/carrier-chat && ~/.bun/bin/bun chat-shot.ts --out=/tmp/carrier-chat/out'
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
const out = opt("out", "/tmp/carrier-chat/out")
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

type M = { online: string; id: number; team: number; ship: number; role: string; order: number; feed: string; open: boolean; ops: boolean; teams: boolean; paused: boolean; lock: boolean }
const st = (p: Page): Promise<M> =>
  p.evaluate(() => {
    type C = {
      net: { state: string; id: number; crew: { players: { id: number; team: number; ship: number }[] } | null; ships: Map<number, number[]> }
      game: { state: { role: string }; paused: boolean }
      chat: { open: boolean }
      ops: { open: boolean }
      teams: { open: boolean }
    }
    const c = (globalThis as unknown as { carrier: C }).carrier
    const me = c.net.crew?.players.find((p) => p.id === c.net.id)
    return {
      online: c.net.state,
      id: c.net.id,
      team: me?.team ?? -1,
      ship: me?.ship ?? -1,
      role: c.game.state.role,
      order: me ? (c.net.ships.get(me.ship)?.[8] ?? Number.NaN) : Number.NaN,
      feed: [...document.querySelectorAll("#ct .achat-line")].map((e) => (e as HTMLElement).textContent).join(" | "),
      open: c.chat.open,
      ops: c.ops.open,
      teams: c.teams.open,
      paused: c.game.paused,
      lock: !!document.pointerLockElement,
    }
  })

async function until(p: Page, ok: (m: M) => boolean, ms = 15_000): Promise<M> {
  const end = Date.now() + ms
  let m = await st(p)
  while (!ok(m) && Date.now() < end) {
    await p.waitForTimeout(80)
    m = await st(p)
  }
  return m
}

/** The current frame under the DOM, then a page screenshot (as scripts/ffa-shot.ts). */
async function shot(page: Page, name: string, clip?: { x: number; y: number; width: number; height: number }): Promise<void> {
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
  await page.screenshot({ path: join(out, `${name}.png`), clip })
  await page.evaluate(() => {
    document.getElementById("shot-bg")?.remove()
    document.getElementById("view")!.style.visibility = ""
  })
  console.log(`${name}: ${JSON.stringify(await st(page))}`)
}

/** Opens the chat with `key` (KeyT / KeyY), types `text` key by key, Enter. */
async function say(p: Page, key: "KeyT" | "KeyY", text: string): Promise<void> {
  await p.bringToFront()
  await p.keyboard.press(key === "KeyT" ? "t" : "y")
  await until(p, (m) => m.open, 2000)
  await p.keyboard.type(text, { delay: 15 })
  await p.keyboard.press("Enter")
}

const room = `chat${Math.floor(Math.random() * 1e6)}`
const a = await open(`${base}?room=${room}`, "ADA")
await until(a, (m) => m.online === "online" && m.role !== "none", 20_000)
const b = await open(`${base}?room=${room}`, "BO")
await until(b, (m) => m.online === "online" && m.role !== "none", 20_000)
const c = await open(`${base}?room=${room}`, "CY")
await until(c, (m) => m.online === "online" && m.role !== "none", 20_000)
const ma = await st(a)
await c.evaluate((ship) => (globalThis as unknown as { carrier: { net: { board(s: number): void } } }).carrier.net.board(ship), ma.ship)
const mc = await until(c, (m) => m.ship === ma.ship, 5000)
const mb = await st(b)
console.log(`room ${room}: ADA team ${ma.team} ship ${ma.ship} ${ma.role}, BO team ${mb.team}, CY team ${mc.team} ship ${mc.ship}`)
check(ma.team !== mb.team && mc.team === ma.team, "ADA and CY crew one carrier, BO another")
await a.waitForTimeout(1500)

// Both ways, everyone.
await say(a, "KeyT", "hello from ada")
await until(b, (m) => m.feed.includes("hello from ada"), 4000)
await say(b, "KeyT", "BO here, ahoy!")
const a1 = await until(a, (m) => m.feed.includes("ahoy"), 4000)
const b1 = await st(b)
check(b1.feed.includes("ADAhello from ada") && a1.feed.includes("BOBO here, ahoy!"), `T chat both ways (A: "${a1.feed}")`)
check(!a1.open && !b1.open, "Enter sent and closed the input")

// Crew channel: CY to ADA only.
await say(c, "KeyY", "crew only, launch soon")
const a2 = await until(a, (m) => m.feed.includes("launch soon"), 4000)
await b.waitForTimeout(1000)
const b2 = await st(b)
check(a2.feed.includes("[CREW]CYcrew only, launch soon"), "Y crew line reaches ADA, tagged [CREW]")
check(!b2.feed.includes("launch soon"), "the crew line never reaches BO (another carrier)")
await shot(c, "01-crew-sender")
await shot(b, "02-enemy-feed-no-crew-line")

// Input ownership: ADA at her helm types game keys into the open input.
await a.bringToFront()
await a.evaluate(() => {
  const w = globalThis as unknown as { leaked: string[] }
  w.leaked = []
  addEventListener("keydown", (e) => w.leaked.push((e as unknown as { code: string }).code))
})
const before = await st(a)
await a.keyboard.press("t")
const opened = await until(a, (m) => m.open && m.paused, 2000)
// The T that opened it was the game's key; from here on nothing may reach `window`.
await a.evaluate(() => ((globalThis as unknown as { leaked: string[] }).leaked = []))
check(opened.open && opened.paused && !opened.lock, "T opens the input: the game pauses, the cursor is free")
for (const k of ["w", "w", "w", "s", "e", "m", "g", "`", "1", "Tab", "c", "f"]) await a.keyboard.press(k)
await a.keyboard.type(" typing wasd and e here")
await a.waitForTimeout(400)
const typed = await st(a)
const leaked = await a.evaluate(() => (globalThis as unknown as { leaked: string[] }).leaked)
const value = await a.evaluate(() => (document.querySelector("#ct input") as HTMLInputElement).value)
const channel = await a.evaluate(() => (document.querySelector("#ct .achat-channel") as HTMLElement).textContent)
const debugOpen = await a.evaluate(() => !!(globalThis as unknown as { carrier: { debugMenu?: { visible: boolean } } }).carrier.debugMenu?.visible)
console.log(`typed: value "${value}", channel ${channel}, leaked [${leaked.join(",")}], order ${before.order} -> ${typed.order}`)
check(leaked.length === 0, "no keydown reached a window handler while typing")
check(typed.order === before.order, "W/S typed into the input left the throttle order alone")
check(!typed.ops && !typed.teams && !debugOpen, "E, Tab and ` opened no menu")
check(value.startsWith("wwwsemg`1cf"), "the letters went into the input")
check(channel === "CREW", "Tab in the input switched the channel")
await shot(a, "03-typing-game-keys")
await a.keyboard.press("Escape")
const closed = await until(a, (m) => !m.open && !m.paused, 2000)
check(!closed.open && !closed.paused, "Esc cancels and the game resumes")
await a.waitForTimeout(500)
check((await st(a)).feed.includes("wwwsemg") === false, "a cancelled line is never sent")

// The feed fades after ~10 s and comes back while the input is open.
await a.waitForTimeout(10_500)
const faded = await a.evaluate(() => [...document.querySelectorAll("#ct .achat-line")].map((e) => getComputedStyle(e).opacity))
check(faded.every((o) => Number(o) < 0.05), `lines faded (${faded.join(",")})`)
await shot(a, "04-faded")
await a.keyboard.press("t")
await a.waitForTimeout(200)
const back = await a.evaluate(() => [...document.querySelectorAll("#ct .achat-line")].map((e) => getComputedStyle(e).opacity))
check(back.every((o) => Number(o) > 0.5), `opening the input shows them again (${back.join(",")})`)
await shot(a, "05-open-shows-history")
await a.keyboard.press("Enter")
const empty = await until(a, (m) => !m.open, 2000)
check(!empty.open, "empty Enter closes")

// Side by side with Getaway's chat (the look this copies): two deployed Getaway pages in a fresh private room trade
// lines, then the chat corners of both games go next to each other in one capture.
await a.keyboard.press("y")
await until(a, (m) => m.open, 2000)
await a.keyboard.type("on my way to the zone")
await a.waitForTimeout(300)
await shot(a, "06-carrier-open")
const carrierBox = await a.evaluate(() => {
  const r = document.getElementById("ct")!.getBoundingClientRect()
  const z = Number(getComputedStyle(document.documentElement).getPropertyValue("--hud")) || 1
  return { x: 0, y: 40, width: Math.ceil((r.right * z) + 30), height: Math.ceil(r.bottom * z + 20 - 40) }
})
await shot(a, "carrier-crop", carrierBox)
await a.keyboard.press("Escape")

const gwBase = opt("getaway", "https://anoma.ly/arcade/getaway/")
const g1 = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1 })
await g1.goto(gwBase, { waitUntil: "load" })
await g1.locator(".lb-name").fill("Dax")
await g1.locator('[data-act="create"]').click()
await g1.waitForSelector(".h-chat", { timeout: 30_000, state: "attached" })
const code = new URL(g1.url()).searchParams.get("r")!
const g2 = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1 })
await g2.goto(`${gwBase}?r=${code}`, { waitUntil: "load" })
await g2.locator(".lb-name").fill("Officer")
await g2.locator('[data-act="join"]').click()
await g2.waitForSelector(".h-chat", { timeout: 30_000, state: "attached" })
const gsay = async (p: Page, text: string) => {
  await p.bringToFront()
  await p.keyboard.press("Enter")
  await p.waitForTimeout(150)
  await p.keyboard.type(text)
  await p.keyboard.press("Enter")
  await p.waitForTimeout(700)
}
await gsay(g1, "hello from the getaway car")
await gsay(g2, "cops here, ahoy!")
await gsay(g1, "meet at the bank")
await g1.bringToFront()
await g1.keyboard.press("Enter")
await g1.keyboard.type("on my way to the zone")
await g1.waitForTimeout(300)
await g1.screenshot({ path: join(out, "07-getaway-open.png") })
const gwBox = await g1.evaluate(() => {
  const r = document.querySelector(".h-chat")!.getBoundingClientRect()
  return { x: 0, y: Math.max(0, Math.floor(r.top - 20)), width: Math.ceil(r.right + 30), height: Math.ceil(r.height + 40) }
})
await g1.screenshot({ path: join(out, "getaway-crop.png"), clip: gwBox })
const gwLines = await g1.evaluate(() => [...document.querySelectorAll(".h-chat .c-line, .h-chat .achat-line")].map((e) => e.textContent).join(" | "))
check(/hello from the getaway car/.test(gwLines), `Getaway chat lines (${gwLines})`)
const { readFileSync } = await import("node:fs")
const b64 = (f: string) => `data:image/png;base64,${readFileSync(join(out, f)).toString("base64")}`
const sheet = await browser.newPage({ viewport: { width: 1200, height: 600 }, deviceScaleFactor: 1 })
await sheet.setContent(`<body style="margin:0;background:#111;color:#ddd;font:14px sans-serif;display:flex;gap:24px;padding:20px;align-items:flex-start">
<figure style="margin:0"><figcaption style="margin-bottom:8px">GETAWAY (deployed)</figcaption><img src="${b64("getaway-crop.png")}"></figure>
<figure style="margin:0"><figcaption style="margin-bottom:8px">CARRIER (new)</figcaption><img src="${b64("carrier-crop.png")}"></figure></body>`)
await sheet.screenshot({ path: join(out, "08-side-by-side.png"), fullPage: true })

if (logs.length) console.log(logs.slice(0, 20).join("\n"))
console.log(failures ? `${failures} FAILED` : "all ok")
await browser.close()
await budget.exit(failures ? 1 : 0)
