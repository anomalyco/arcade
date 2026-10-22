// UI checks and captures on a real GPU: the Tab menu (players, carriers, captains) and DEPLOY. Runs ON hailmary
// (Mac Studio): Chrome with WebGPU on Metal loads the live dev server; DOM menus are captured over a readback of the
// game's own frame, as in scripts/mp-shot.ts.
//
//   ssh hailmary 'cd /tmp/carrier-ui && ~/.bun/bin/bun ui-shot.ts --out=/tmp/carrier-ui/out'
//
// Steps: the menu previews (menu.html); then five players in one fresh room. Ship operations: two pilots launch
// (cap 2), the helm waits; one jet goes down, its slot recharges with a countdown, then the helm launches. Squads: an
// empty carrier taken over by JOIN, the Tab view of every carrier; the captain locks (another player can't join), kicks
// a member (who lands on the least crewed other carrier), a JOIN to a rival carrier, the captain leaves (captaincy
// passes on).
import { type Page } from "playwright-core"
import { browserBudget } from "../../../scripts/browser-budget"
import { mkdirSync } from "node:fs"
import { join } from "node:path"

await using budget = browserBudget()
const { chromium } = budget

const args = process.argv.slice(2)
const opt = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
const base = opt("base", "https://carrier.lwoyjcaeyxv6.opentunnel.xyz/")
const out = opt("out", "/tmp/carrier-ui/out")
const [vw, vh] = opt("size", "1536x960").split("x").map(Number) as [number, number]
const room = opt("room", `ui${Math.random().toString(36).slice(2, 7)}`)
/** Steps to run: previews, ops (ship operations), squads (Tab and captains), mouse (Pointer Lock and the chase camera). */
const only = opt("only", "previews,ops,squads,mouse").split(",")
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

type Crew = { players: { id: number; name: string; team: number; ship: number; role: string; plane: number }[]; ships: { id: number; team: number; captain: number | null; locked: boolean; helm: number | null; aircraft: { pilot: number | null; readyAt: number }[] }[] }
type G = { carrier: { net: { id: number; state: string; crew: Crew | null; serverNow(): number; recover(how: string): void; board(ship: number): void }; game: { state: { sea: unknown; role: string } }; teams: { pin(o: boolean): void; open: boolean }; ops: { pin(o: boolean): void; open: boolean }; renderer: { context: { device: GPUDevice } } } }

async function open(url: string, name: string, size: [number, number] = [vw, vh]): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: size[0], height: size[1] }, deviceScaleFactor: 1 })
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") logs.push(`${name} ${m.type()}: ${m.text()}`)
  })
  page.on("pageerror", (e) => logs.push(`${name} pageerror: ${e.message}`))
  // Other agents edit files on the shared dev server: keep Vite's HMR socket from reloading the page mid-run.
  await page.addInitScript((n) => {
    localStorage.setItem("carrier.name", n)
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
  await page.waitForFunction(() => !!(globalThis as unknown as G).carrier?.game?.state.sea, null, { timeout: 30_000 })
  return page
}

/** The current frame as a PNG data URL, read back through the game's device. */
async function frame(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const c = (globalThis as unknown as G).carrier
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
    img.id = "ui-shot-bg"
    img.src = src
    Object.assign(img.style, { position: "fixed", inset: "0", width: "100%", height: "100%", zIndex: "0" })
    const canvas = document.getElementById("view")!
    canvas.style.visibility = "hidden"
    canvas.after(img)
    return new Promise((r) => (img.complete ? r(null) : (img.onload = () => r(null))))
  }, url)
  await page.screenshot({ path: join(out, `${name}.png`) })
  await page.evaluate(() => {
    document.getElementById("ui-shot-bg")?.remove()
    document.getElementById("view")!.style.visibility = ""
  })
  console.log(`shot ${name}`)
}

const crew = (page: Page): Promise<{ id: number; crew: Crew; now: number }> =>
  page.evaluate(() => {
    const n = (globalThis as unknown as G).carrier.net
    return { id: n.id, crew: n.crew!, now: n.serverNow() }
  })
const me = async (page: Page) => {
  const { id, crew: c } = await crew(page)
  return c.players.find((p) => p.id === id)!
}
const shipOf = async (page: Page, id: number) => (await crew(page)).crew.ships.find((s) => s.id === id)!
async function until(page: Page, ok: () => Promise<boolean>, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await ok()) return true
    await page.waitForTimeout(150)
  }
  return ok()
}
const pinTeams = (page: Page, o: boolean) => page.evaluate((x) => (globalThis as unknown as G).carrier.teams.pin(x), o)
/** Clicks in the Tab menu (it acts on pointerdown). */
async function tab(page: Page, selector: string): Promise<void> {
  await pinTeams(page, true)
  await page.waitForTimeout(250)
  await page.locator(selector).first().dispatchEvent("pointerdown", { button: 0 })
}

async function joinRoom(name: string): Promise<Page> {
  const page = await open(`${base}?room=${room}`, name)
  await until(page, async () => page.evaluate(() => (globalThis as unknown as G).carrier.net.state === "online" && (globalThis as unknown as G).carrier.game.state.role !== "none"), 15_000)
  return page
}

const locked = (page: Page) => page.evaluate(() => document.pointerLockElement === document.getElementById("view"))
const camYaw = (page: Page) => page.evaluate(() => (globalThis as unknown as { carrier: { camera: { yaw: number } } }).carrier.camera.yaw)
const wrapA = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))

// 0. The mouse: Pointer Lock on the first click, then plain movement orbits the chase camera; menus free the cursor
// and give the lock back; the hand-off to the jet and back keeps it; drag still orbits if Pointer Lock is denied.
if (only.includes("mouse")) {
  const page = await open(`${base}?room=${room}m`, "mouse")
  await until(page, async () => page.evaluate(() => (globalThis as unknown as G).carrier.game.state.role === "helm"), 15_000)
  await page.waitForTimeout(1500)
  check(!(await locked(page)), "no lock before a click")
  await page.mouse.move(vw / 2, vh / 2)
  await page.mouse.click(vw / 2, vh / 2)
  check(await until(page, () => locked(page), 3000), "the first click on the canvas takes Pointer Lock")
  const y0 = await camYaw(page)
  for (let i = 0; i < 10; i++) await page.mouse.move(vw / 2 + (i + 1) * 25, vh / 2)
  await page.waitForTimeout(300)
  const y1 = await camYaw(page)
  check(Math.abs(wrapA(y1 - y0)) > 0.4, `plain mouse movement (no button) orbits the camera: ${wrapA(y1 - y0).toFixed(2)} rad`)
  await shot(page, "mouse-orbit")
  await page.waitForTimeout(6500)
  const y2 = await camYaw(page)
  check(Math.abs(wrapA(y2 - y0)) < 0.12, `idle: the orbit springs back behind the ship (${wrapA(y2 - y0).toFixed(3)} rad off)`)
  // Tab held: cursor free; released: the lock comes back without a click.
  await page.keyboard.down("Tab")
  await page.waitForTimeout(400)
  check(!(await locked(page)), "holding Tab frees the cursor")
  await page.keyboard.up("Tab")
  check(await until(page, () => locked(page), 2000), "releasing Tab takes the lock back")
  // DEPLOY pinned: free; closed: locked.
  await page.keyboard.press("KeyG")
  await page.waitForTimeout(400)
  check(!(await locked(page)), "DEPLOY frees the cursor")
  await page.keyboard.press("KeyG")
  check(await until(page, () => locked(page), 2000), "closing DEPLOY takes the lock back")
  // The debug menu.
  await page.keyboard.press("Backquote")
  await page.waitForTimeout(400)
  check(!(await locked(page)), "the debug menu frees the cursor")
  await page.keyboard.press("Backquote")
  check(await until(page, () => locked(page), 2000), "closing the debug menu takes the lock back")
  // Launch: the jet's stick keeps the same lock through the catapult and back to the deck.
  await page.keyboard.press("KeyG")
  await page.waitForTimeout(250)
  await page.keyboard.press("Digit2")
  check(await until(page, async () => (await me(page)).plane >= 0), "launched from DEPLOY")
  check(await until(page, () => locked(page), 2000), "the lock is back after the menu, as the jet takes over")
  let held = true
  for (let i = 0; i < 20; i++) {
    held &&= await locked(page)
    await page.waitForTimeout(200)
  }
  check(held, "the lock holds through the catapult launch and into flight (4 s)")
  await shot(page, "mouse-flying")
  await page.evaluate(() => (globalThis as unknown as G).carrier.net.recover("landed"))
  await until(page, async () => (await me(page)).plane === -1)
  await page.waitForTimeout(1500)
  check(await locked(page), "back on deck: still locked, no second click")
  const y3 = await camYaw(page)
  for (let i = 0; i < 8; i++) await page.mouse.move(vw / 2 - (i + 1) * 25, vh / 2)
  await page.waitForTimeout(300)
  check(Math.abs(wrapA((await camYaw(page)) - y3)) > 0.3, "on deck the mouse orbits the ship camera again")
  // Esc (the browser's release, as exitPointerLock here): movement no longer orbits; Pointer Lock denied: drag does.
  await page.evaluate(() => document.exitPointerLock())
  await page.waitForTimeout(300)
  await page.evaluate(() => {
    HTMLElement.prototype.requestPointerLock = () => Promise.reject(new DOMException("denied", "NotAllowedError"))
  })
  const y4 = await camYaw(page)
  for (let i = 0; i < 8; i++) await page.mouse.move(vw / 2 + (i + 1) * 25, vh / 2)
  await page.waitForTimeout(300)
  check(Math.abs(wrapA((await camYaw(page)) - y4)) < 0.02, "unlocked: plain movement doesn't orbit")
  await page.mouse.move(vw / 2, vh / 2)
  await page.mouse.down()
  for (let i = 0; i < 8; i++) await page.mouse.move(vw / 2 + (i + 1) * 25, vh / 2)
  await page.mouse.up()
  await page.waitForTimeout(300)
  check(!(await locked(page)) && Math.abs(wrapA((await camYaw(page)) - y4)) > 0.3, "Pointer Lock denied: dragging still orbits")
  await page.close()
}

// 1. Previews with fake crews (menu.html).
if (only.includes("previews")) for (const [show, size] of [
  ["teams", [vw, vh]],
  ["ops", [vw, vh]],
  ["teams", [720, 900]],
] as [string, [number, number]][]) {
  const page = await open(`${base}menu.html?seed=7&show=${show}`, `preview-${show}`, size)
  await page.waitForTimeout(1500)
  await shot(page, `preview-${show}${size[0] < 1000 ? "-narrow" : ""}`)
  await page.close()
}
if (only.includes("previews")) {
  const page = await open(base, "menu")
  await page.waitForTimeout(1500)
  await shot(page, "start-menu")
  await page.close()
}
if (!only.includes("ops") && !only.includes("squads")) {
  console.log(logs.length ? `console:\n${logs.slice(0, 30).join("\n")}` : "console: clean")
  console.log(failures ? `${failures} FAILED` : "all checks passed")
  await browser.close()
  await budget.exit(failures ? 1 : 0)
}

// 2. Five players in a fresh room, each joiner on a carrier of their own until bo and di board ada's (pilots on deck)
// and ed boards cy's: ada (helm, captain), bo and di; cy (helm), ed.
console.log(`room ${room}`)
const ada = await joinRoom("ada")
const bo = await joinRoom("bo")
const cy = await joinRoom("cy")
const di = await joinRoom("di")
const ed = await joinRoom("ed")
const boardShip = (page: Page, ship: number) => page.evaluate((id) => (globalThis as unknown as G).carrier.net.board(id), ship)
await boardShip(bo, (await me(ada)).ship)
await boardShip(di, (await me(ada)).ship)
await boardShip(ed, (await me(cy)).ship)
await until(ed, async () => (await me(ed)).ship === (await me(cy)).ship && (await me(di)).ship === (await me(ada)).ship)
const A = await me(ada)
const B = await me(bo)
const D = await me(di)
check(A.role === "helm" && B.role === "pilot" && D.role === "pilot" && B.ship === A.ship && D.ship === A.ship, `ada helms ship ${A.ship}; bo and di are pilots on its deck (${B.role}/${D.role}, plane ${B.plane}/${D.plane})`)
check(B.plane === -1 && D.plane === -1, "pilots wait on deck: nobody auto-launched")
check((await shipOf(ada, A.ship)).captain === A.id, "the first aboard captains the ship")
await bo.waitForTimeout(1500)
await shot(bo, "hud-pilot-on-deck")

// Ship operations: bo opens DEPLOY (tap G) and launches with 2; di clicks LAUNCH HORNET.
await bo.bringToFront()
await bo.keyboard.press("KeyG")
await bo.waitForTimeout(400)
check(await bo.evaluate(() => (globalThis as unknown as G).carrier.ops.open), "G opens DEPLOY")
await shot(bo, "ops-pilot-available")
await bo.keyboard.press("Digit2")
check(await until(bo, async () => (await me(bo)).plane >= 0), "bo launches a Hornet with 2")
check(!(await bo.evaluate(() => (globalThis as unknown as G).carrier.ops.open)), "the menu closes after an operation")
await di.bringToFront()
await di.keyboard.press("KeyG")
await di.waitForTimeout(300)
await di.locator('.om-op.available[data-op="1"]').dispatchEvent("pointerdown", { button: 0 })
check(await until(di, async () => (await me(di)).plane >= 0), "di launches a Hornet by clicking")
await bo.waitForTimeout(3500)
await shot(bo, "flight-after-launch")
// ada (the helm) is third: both slots are in use.
await ada.bringToFront()
await ada.keyboard.press("KeyG")
await ada.waitForTimeout(400)
const inUse = await ada.locator(".om-op.in-use").count()
check(inUse === 1, `helm sees LAUNCH HORNET in use (${inUse} row)`)
await shot(ada, "ops-helm-hornets-in-use")
await ada.keyboard.press("Digit2")
await ada.waitForTimeout(400)
check((await me(ada)).role === "helm", "the third can't launch while both are out")
const order = await ada.evaluate(() => (globalThis as unknown as { carrier: { game: { state: { helm: { order: number } } } } }).carrier.game.state.helm.order)
check(order === 0, `a number pressed in the menu never reaches the helm's throttle presets (order ${order})`)
// bo's jet goes down: its slot recharges.
await bo.evaluate(() => (globalThis as unknown as G).carrier.net.recover("crashed"))
check(await until(ada, async () => (await me(bo)).plane === -1), "bo's jet is down, bo back on deck")
await ada.keyboard.press("KeyG") // closes
await ada.keyboard.press("KeyG") // opens again
await ada.waitForTimeout(1500)
const charging = await ada.locator(".om-op.recharging").count()
const label = await ada.locator(".om-op.recharging .om-state").first().textContent().catch(() => "")
check(charging === 1 && /RECHARGING \d+S/.test(label ?? ""), `slot recharging with a countdown (${label})`)
await shot(ada, "ops-recharging")
await bo.bringToFront()
await bo.keyboard.press("KeyG")
await bo.waitForTimeout(300)
await shot(bo, "ops-pilot-recharging")
await bo.keyboard.press("Escape")
// Wait out the recharge, then the helm launches (handing off the helm).
const left = await ada.evaluate(() => {
  const n = (globalThis as unknown as G).carrier.net
  const s = n.crew!.ships.find((x) => x.helm === n.id)!
  return Math.max(...s.aircraft.map((a) => a.readyAt)) - n.serverNow()
})
await ada.waitForTimeout(Math.max(0, left) - 4000)
await shot(ada, "ops-recharging-late")
await ada.waitForTimeout(4500)
check((await ada.locator(".om-op.available").count()) >= 1 && (await ada.locator('.om-op.available[data-op="1"]').count()) === 1, "the slot is AVAILABLE again")
await shot(ada, "ops-available-again")
await ada.keyboard.press("Digit2")
check(await until(ada, async () => { const m = await me(ada); return m.role === "pilot" && m.plane >= 0 }), "the helm launches after the recharge (and hands off the helm)")
await ada.waitForTimeout(3000)
await shot(ada, "hud-pilot-airborne")
// ada lands back aboard (the recovery the auto-landing sends): her slot frees at once, no recharge.
const slotOf = async () => (await me(ada)).plane
const mySlot = await slotOf()
await ada.bringToFront()
await ada.evaluate(() => (globalThis as unknown as G).carrier.net.recover("landed"))
check(await until(ada, async () => (await me(ada)).plane === -1), "landing puts ada back on deck")
const ready = await ada.evaluate((i) => {
  const n = (globalThis as unknown as G).carrier.net
  const p = n.crew!.players.find((x) => x.id === n.id)!
  const a = n.crew!.ships.find((x) => x.id === p.ship)!.aircraft[i]!
  return a.pilot === null && a.readyAt <= n.serverNow()
}, mySlot)
check(ready, "a landed jet's slot is ready at once")
// ada takes the free helm back from the menu.
await ada.bringToFront()
await ada.keyboard.press("KeyG")
await ada.waitForTimeout(300)
await ada.keyboard.press("Digit1")
check(await until(ada, async () => (await me(ada)).role === "helm"), "TAKE HELM from the menu")

// Squads. bo takes over an empty carrier from the Tab menu (and captains it): a rival of ada's now.
const empty = await bo.evaluate(() => (globalThis as unknown as G).carrier.net.crew!.ships.find((s) => s.helm === null && s.captain === null)!.id)
await tab(bo, `[data-tm="join"][data-ship="${empty}"]`)
check(await until(bo, async () => { const m = await me(bo); return m.ship === empty && m.role === "helm" }), "JOIN an empty carrier: bo helms it")
const B2 = await me(bo)
check((await shipOf(bo, B2.ship)).captain === B2.id && B2.team !== A.team, "the first aboard captains it, on its own side")
await pinTeams(bo, false)
await ada.waitForTimeout(800)
await pinTeams(ada, true)
await ada.waitForTimeout(400)
await shot(ada, "tab-captain-view")
// ada locks her ship: bo can't join it.
await tab(ada, '[data-tm="lock"]')
check(await until(ada, async () => (await shipOf(ada, A.ship)).locked), "the captain locks the ship")
await pinTeams(bo, true)
await bo.waitForTimeout(400)
const lockedBtn = bo.locator(`[data-tm="join"][data-ship="${A.ship}"]`)
check((await lockedBtn.isDisabled()) && (await lockedBtn.textContent()) === "LOCKED", `bo's JOIN shows LOCKED, disabled (${await lockedBtn.textContent()})`)
await shot(bo, "tab-locked")
await bo.evaluate((id) => (globalThis as unknown as G).carrier.net.board(id), A.ship)
await bo.waitForTimeout(600)
check((await me(bo)).ship === B2.ship, "the room refuses a join to a locked ship")
await pinTeams(bo, false)
// ada kicks di (two clicks): di lands on the least crewed other carrier, and can't come back for a while.
await tab(ada, `[data-tm="kick"][data-id="${D.id}"]`)
await ada.waitForTimeout(300)
await shot(ada, "tab-kick-confirm")
await ada.locator(`[data-tm="kick"][data-id="${D.id}"]`).dispatchEvent("pointerdown", { button: 0 })
check(await until(di, async () => { const m = await me(di); return m.ship !== A.ship && m.team !== A.team }), "kicked: di is moved to another carrier, a rival now")
await pinTeams(di, true)
await di.waitForTimeout(500)
const kicked = (await di.locator(`[data-tm="join"][data-ship="${A.ship}"]`).textContent()) ?? ""
check(/KICKED \d+S/.test(kicked), `di's JOIN on the old ship reads ${kicked}`)
await shot(di, "tab-kicked")
// JOIN: di joins cy's carrier and takes its side.
const C = await me(cy)
await tab(di, `[data-tm="join"][data-ship="${C.ship}"]`)
check(await until(di, async () => { const m = await me(di); return m.ship === C.ship && m.team === C.team }), "JOIN cy's carrier: di is on cy's side")
await di.waitForTimeout(500)
await shot(di, "tab-switched-ship")
await pinTeams(di, false)
// The captain leaves: the longest-serving member takes over (ed boarded cy's ship before di).
const E = await me(ed)
await cy.close()
check(await until(ed, async () => (await shipOf(ed, C.ship)).captain === E.id), "cy leaves: ed (longest-serving) captains the ship")
await pinTeams(ed, true)
await ed.waitForTimeout(500)
await shot(ed, "tab-captain-passed")
// Narrow window.
await ed.setViewportSize({ width: 720, height: 900 })
await ed.waitForTimeout(500)
await shot(ed, "tab-narrow")

console.log(logs.length ? `console:\n${logs.slice(0, 30).join("\n")}` : "console: clean")
console.log(failures ? `${failures} FAILED` : "all checks passed")
await browser.close()
await budget.exit(failures ? 1 : 0)
