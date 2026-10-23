// Ship damage on a real GPU. Runs ON hailmary (Mac Studio): three pages in one fresh room, each on a carrier of its own.
// B (team 1) helms its carrier at half speed; A (team 0) bombs it from an F-35C (direct hits and a near miss); C (team 2)
// strafes it and fires dumbfire missiles from a Hornet; A's bombs rearm and finish it. B watches its health drop, the
// edge flash, the deck burn, the sinking, and moves to its replacement. Captures through each game's own device under the DOM.
//
//   ssh hailmary 'cd /tmp/carrier-ocean && ~/.bun/bin/bun ships-shot.ts --out=/tmp/carrier-ships/out'
//
// Options: --base=URL  --size=1536x1024
import { type Page } from "playwright-core"
import { browserBudget } from "../../../scripts/browser-budget"
import { mkdirSync } from "node:fs"
import { join } from "node:path"

await using budget = browserBudget()
const { chromium } = budget

const args = process.argv.slice(2)
const opt = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
const base = opt("base", "https://carrier.lwoyjcaeyxv6.opentunnel.xyz/")
const out = opt("out", "/tmp/carrier-ships/out")
const [vw, vh] = opt("size", "1536x1024").split("x").map(Number) as [number, number]
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

async function open(room: string, name: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1 })
  page.on("console", (m) => {
    if (m.type() === "error") logs.push(`${name} ${m.type()}: ${m.text()}`)
  })
  page.on("pageerror", (e) => logs.push(`${name} pageerror: ${e.message}`))
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) console.log(`  [${name} navigated ${f.url()}]`)
  })
  page.on("console", (m) => {
    if (/reload|stale|full/i.test(m.text())) console.log(`  [${name} console ${m.text()}]`)
  })
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
  await page.goto(`${base}?room=${room}`, { waitUntil: "load" })
  await page.waitForFunction(() => !!(globalThis as unknown as { carrier?: { flight?: unknown } }).carrier?.flight, null, { timeout: 60_000 })
  return page
}

type M = { online: string; id: number; team: number; role: string; ship: number; phase: string; weapon: string; hp: number; deck: boolean; sinking: boolean; myHp: number; feed: string; tag: string; enemyBar: boolean; ships: number }
/** Page state; `hp` is ship `target`'s health as this page knows it. */
const st = (p: Page, target = -1): Promise<M> =>
  p.evaluate((target) => {
    type H = { hp: number; deckFire: number; sinkAt: number }
    type C = {
      net: { state: string; id: number; seaTime(): number; crew: { players: { id: number; team: number; ship: number; role: string }[] } | null; hulls: Map<number, H> }
      game: { state: { role: string } }
      flight: { flight: { phase: string }; weaponStatus: { weapon: string }; carriers: unknown[] }
    }
    const c = (globalThis as unknown as { carrier: C }).carrier
    const me = c.net.crew?.players.find((p) => p.id === c.net.id)
    const h = c.net.hulls.get(target)
    const mine = me ? c.net.hulls.get(me.ship) : undefined
    const txt = (s: string) => ((document.querySelector(s) as HTMLElement | null)?.innerText ?? "").replace(/\s+/g, " ").trim()
    const enemy = document.querySelector("#sh .enemy") as HTMLElement | null
    return {
      online: c.net.state,
      id: c.net.id,
      team: me?.team ?? -1,
      role: c.game.state.role,
      ship: me?.ship ?? -1,
      phase: c.flight.flight.phase,
      weapon: c.flight.weaponStatus.weapon,
      hp: h?.hp ?? -1,
      deck: h ? c.net.seaTime() >= h.deckFire && h.sinkAt === -1 : true,
      sinking: h ? h.sinkAt !== -1 : false,
      myHp: mine?.hp ?? -1,
      feed: txt("#wp .feed"),
      tag: txt("#sh .own .tag"),
      enemyBar: !!enemy && !enemy.hidden,
      ships: c.flight.carriers.length,
    }
  }, target)
const fmt = (m: M) => `${m.online} id ${m.id} team ${m.team} ${m.role} ship ${m.ship} ${m.phase} ${m.weapon} target hp ${m.hp.toFixed(1)} deck ${m.deck ? "open" : "closed"}${m.sinking ? " SINKING" : ""} my hp ${m.myHp.toFixed(1)} tag "${m.tag}" enemy bar ${m.enemyBar} feed "${m.feed}"`
async function until(p: Page, ok: (m: M) => boolean, ms: number, target = -1): Promise<M> {
  const end = Date.now() + ms
  let m = await st(p, target)
  while (!ok(m) && Date.now() < end) {
    await p.waitForTimeout(80)
    m = await st(p, target)
  }
  return m
}
const run = (p: Page, js: string) => p.evaluate(js)

/** The current frame under the DOM, then a page screenshot (scripts/mp-shot.ts). */
async function shot(page: Page, name: string, target = -1): Promise<void> {
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
  console.log(`${name}: ${fmt(await st(page, target))}`)
}

/**
 * Puts page `p`'s jet in flight relative to carrier `ship` (as that page draws it): at ship-local (lx, up above the deck,
 * lz), heading along the ship (or `turn` rad off it), pitched `pitch`, at `speed` m/s relative to the ship.
 */
const place = (p: Page, ship: number, lx: number, up: number, lz: number, speed: number, pitch = 0, turn = 0) =>
  p.evaluate(
    ([ship, lx, up, lz, speed, pitch, turn]) => {
      type S = { id: number; x: number; z: number; heading: number; heave: number; u: number }
      type P = Record<string, number | string>
      const c = (globalThis as unknown as { carrier: { flight: { carriers: S[]; flight: { plane: P; prev: P; cam: { reset(): void } }; input: { override: unknown } } } }).carrier
      const s = c.flight.carriers.find((x) => x.id === ship)
      if (!s) return false
      const f = [Math.sin(s.heading), -Math.cos(s.heading)]
      const r = [Math.cos(s.heading), Math.sin(s.heading)]
      // Ship-local +X is port, starboard is −X.
      const x = s.x + f[0]! * lz - r[0]! * lx
      const z = s.z + f[1]! * lz - r[1]! * lx
      const h = s.heading + turn!
      const fh = [Math.sin(h), -Math.cos(h)]
      const pl = c.flight.flight.plane
      const a = (Math.PI - h) / 2
      // Heading quaternion, then the pitch about the body's left (+X) axis (nose up +).
      const qy = Math.sin(a)
      const qw = Math.cos(a)
      const pa = -pitch! / 2
      const px = Math.sin(pa)
      const pw = Math.cos(pa)
      const q = { qx: qw * px, qy: qy * pw, qz: -qy * px, qw: qw * pw }
      const v = speed!
      Object.assign(pl, { x, y: s.heave + 26 + up!, z, ...q, vx: fh[0]! * v * Math.cos(pitch!) + f[0]! * s.u, vy: v * Math.sin(pitch!), vz: fh[1]! * v * Math.cos(pitch!) + f[1]! * s.u, p: 0, r: 0, w: 0, throttle: 0.77, blend: 1, stall: 0, outside: 0 })
      Object.assign(c.flight.flight.prev, pl)
      c.flight.flight.cam.reset()
      c.flight.input.override = { pitch: 0, roll: 0, yaw: 0 }
      return true
    },
    [ship, lx, up, lz, speed, pitch, turn],
  )
const trigger = (p: Page, on: boolean) => p.evaluate((on) => ((globalThis as unknown as { carrier: { flight: { weapons: { input: { trigger: boolean | null } } } } }).carrier.flight.weapons.input.trigger = on), on)
const stick = (p: Page, v: { pitch: number; roll: number } | null) => p.evaluate((v) => ((globalThis as unknown as { carrier: { flight: { input: { override: unknown } } } }).carrier.flight.input.override = v), v)

/** Parks a jet out of harm's way: high astern of the carrier, flying away from the islands ahead of it. */
const hold = (p: Page, ship: number) => place(p, ship, 600, 700, -1800, 140, 0, Math.PI)

/** A bomb run on ship-local (lx, lz): 160 m over the deck, released so it falls onto that point. */
async function bombRun(a: Page, ship: number, lx: number, lz: number): Promise<void> {
  const speed = 140
  const fall = Math.sqrt((2 * 160) / 9.81)
  await place(a, ship, lx, 160, lz - speed * fall - 6, speed)
  await trigger(a, true)
  await a.waitForTimeout(90)
  await trigger(a, false)
  // Climb away, out of the burst, then park.
  await stick(a, { pitch: 0.5, roll: 0 })
  await a.waitForTimeout(1500)
  await hold(a, ship)
}

const room = `shp${Math.floor(Math.random() * 1e6)}`
const a = await open(room, "ADA")
let ma = await until(a, (m) => m.online === "online" && m.role !== "none", 20_000)
const b = await open(room, "BO")
let mb = await until(b, (m) => m.online === "online" && m.role !== "none", 20_000)
mb = await until(b, (m) => m.team === 1 && m.role === "helm", 5000)
const c = await open(room, "CY")
let mc = await until(c, (m) => m.online === "online" && m.role !== "none", 20_000)
const target = mb.ship
console.log(`room ${room}: A ${fmt(ma)}\nB ${fmt(mb)}\nC ${fmt(mc)}`)
check(ma.team === 0 && mb.team === 1 && mc.team === 2, "A, B and C each on a carrier of their own; B helms team 1's")
// B rings up half speed (helm preset 5): the deck moves under the bombs.
await b.bringToFront()
await b.keyboard.press("Digit5")
await run(a, 'carrier.net.op("f35")')
await run(c, 'carrier.net.op("hornet")')
ma = await until(a, (m) => m.phase === "flying", 20_000)
mc = await until(c, (m) => m.phase === "flying", 20_000)
check(ma.phase === "flying" && mc.phase === "flying", `A flies the F-35C, C the Hornet: ${fmt(ma)} | ${fmt(mc)}`)
await a.waitForTimeout(2000)
// The carriers spawn a few hundred metres apart, and the auto-landing captures a jet heading at its own ship from well
// out: the attackers opt out of landing for this run (a fresh array, no longer the one the seam refills).
for (const p of [a, c]) await run(p, "carrier.flight.flight.landables = []")
// Both park astern of B's carrier (straight ahead lie the islands).
await hold(a, target)
await hold(c, target)
await a.waitForTimeout(1500)
mb = await until(b, (m) => m.hp === 1000, 3000, target)
check(mb.hp === 1000 && mb.myHp === 1000, `B's carrier at full health: ${fmt(mb)}`)

// 1. A direct bomb hit on the runway.
await a.bringToFront()
await a.keyboard.press("Digit2")
await a.waitForTimeout(300)
ma = await st(a, target)
check(ma.weapon === "bomb", `A selects bombs: ${fmt(ma)}`)
await bombRun(a, target, 15, 40)
await a.waitForTimeout(300)
await shot(a, "damage/01-a-bomb-away", target)
mb = await until(b, (m) => m.myHp < 1000, 9000, target)
await b.waitForTimeout(60)
await shot(b, "damage/02-b-direct-hit-flash", target)
check(mb.myHp <= 1000 - 170 && mb.myHp >= 1000 - 180 && !mb.deck, `direct hit: ~17.5% and the deck burns: ${fmt(mb)}`)
const afterDirect = mb.myHp
await b.waitForTimeout(1500)
await shot(b, "damage/03-b-deck-fire", target)
// B can't launch from a burning deck.
await run(b, 'carrier.net.op("hornet")')
await b.waitForTimeout(400)
const refused = await b.evaluate(() => (globalThis as unknown as { carrier: { net: { refused: { error: string } | null } } }).carrier.net.refused?.error ?? "")
check(refused === "deck-fire", `launching from a burning deck is refused: "${refused}"`)

// 2. A near miss ~18 m off the starboard waterline (clear of the deck's overhang, which reaches 38 m out).
await stick(a, null)
await bombRun(a, target, -44, -30)
mb = await until(b, (m) => m.myHp < afterDirect - 1, 9000, target)
check(afterDirect - mb.myHp > 10 && afterDirect - mb.myHp < 70, `near miss: reduced splash damage ${(afterDirect - mb.myHp).toFixed(1)}: ${fmt(mb)} | A ${fmt(await st(a, target))}`)
await shot(b, "damage/04-b-near-miss", target)

// 3. C strafes the deck from astern, then puts two dumbfire missiles into the hull.
const beforeGuns = mb.myHp
await c.bringToFront()
await place(c, target, 15, 160, -900, 120, -0.17)
await c.waitForTimeout(200)
await trigger(c, true)
await c.waitForTimeout(700)
await shot(c, "damage/05-c-strafe", target)
await c.waitForTimeout(1800)
await trigger(c, false)
await stick(c, { pitch: 1, roll: 0 })
await c.waitForTimeout(800)
await hold(c, target)
mb = await until(b, (m) => m.myHp < beforeGuns - 2, 4000, target)
check(beforeGuns - mb.myHp > 5 && beforeGuns - mb.myHp < 50, `gun run: chip damage ${(beforeGuns - mb.myHp).toFixed(1)}: ${fmt(mb)}`)
await c.waitForTimeout(1500)
await c.keyboard.press("Digit2")
for (const lz of [20, -60]) {
  const before = (await st(b, target)).myHp
  // From 350 m off the port beam at deck height: a dumbfire leaves at the jet's speed and drops ~9 m on the way in.
  await place(c, target, 350, 0, lz, 140, 0, Math.PI / 2)
  await stick(c, null)
  await c.waitForTimeout(150)
  await trigger(c, true)
  await c.waitForTimeout(120)
  await trigger(c, false)
  await stick(c, { pitch: 1, roll: 0 })
  mb = await until(b, (m) => m.myHp < before - 1, 6000, target)
  check(before - mb.myHp > 40 && before - mb.myHp < 60, `dumbfire missile into the hull: ${(before - mb.myHp).toFixed(1)}: ${fmt(mb)}`)
  await c.waitForTimeout(1200)
  await hold(c, target)
}
mc = await st(c, target)
await place(c, target, 400, 250, -700, 140, -0.15, 0.4)
await c.waitForTimeout(600)
await shot(c, "damage/06-c-enemy-bar-fires", target)
mc = await st(c, target)
check(mc.enemyBar, `C sees the enemy carrier's health bar: ${fmt(mc)}`)

// 4. A's two remaining bombs, then the rearmed ones, until the carrier sinks.
await stick(a, null)
await b.bringToFront()
await b.keyboard.press("Tab")
await b.waitForTimeout(400)
await shot(b, "damage/07-b-tab-hull", target)
await b.keyboard.press("Tab")
let runs = 0
const deadline = Date.now() + 150_000
while (!(mb = await st(b, target)).sinking && runs < 12 && Date.now() < deadline) {
  const jet = await a.evaluate(() => {
    const c = (globalThis as unknown as { carrier: { flight: { flight: { phase: string }; weapons: { loadout: { bombs: number } } } } }).carrier
    return { bombs: c.flight.weapons.loadout.bombs, phase: c.flight.flight.phase }
  })
  console.log(`  run ${runs}: A ${jet.phase} bombs ${jet.bombs}, B hp ${mb.myHp.toFixed(1)}`)
  if (jet.phase !== "flying") {
    // A was lost (flew into something): launch the F-35C again when its slot is back.
    await run(a, 'carrier.net.op("f35")')
    await a.waitForTimeout(6000)
    await run(a, "carrier.flight.flight.landables = []")
    await a.keyboard.press("Digit2")
    continue
  }
  if (jet.bombs < 1) {
    await hold(a, target)
    await a.waitForTimeout(3000)
    continue
  }
  const before = mb.myHp
  await bombRun(a, target, 10 - runs * 4, 60 - runs * 30)
  await until(b, (m) => m.myHp < before - 1 || m.sinking, 9000, target)
  runs++
}
mb = await until(b, (m) => m.sinking, 5000, target)
check(mb.sinking && mb.myHp === 0 && mb.tag === "SINKING", `B's carrier is sinking: ${fmt(mb)}`)
ma = await until(a, (m) => m.feed.includes("SUNK"), 3000, target)
check(ma.feed.includes("SUNK") && ma.feed.includes("ADA"), `kill feed credits the final blow: ${fmt(ma)}`)
await b.waitForTimeout(400)
await shot(b, "damage/08-b-sinking", target)
await place(a, target, 700, 300, -600, 140, -0.2, 0.9)
await a.waitForTimeout(500)
await shot(a, "damage/09-a-sinking", target)
await b.waitForTimeout(8000)
await shot(b, "damage/10-b-going-under", target)
await b.waitForTimeout(8000)
await shot(b, "damage/10b-b-bow-under", target)
mb = await until(b, (m) => m.ship !== target, 25_000, target)
check(mb.ship !== target && mb.team === 1 && mb.ships >= 2, `B moved to its replacement (team 1) after the sinking: ${fmt(mb)}`)
await b.waitForTimeout(2500)
await shot(b, "damage/11-b-new-ship", target)
console.log(logs.slice(0, 30).join("\n"))
console.log(failures ? `${failures} FAILED` : "all ok")
await browser.close()
