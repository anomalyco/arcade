// Damage and reward feedback (src/feedback/**) captures against a dev server (`?seed=N&bots` plays on the in-page dev
// room, src/dev/local-room.ts): we launch a Hornet, take hits in the chase and cockpit views (sparks, damage edge,
// canopy cracks, oil), shoot down two bots through the real `hits` path (SPLASH ONE, then DOUBLE KILL with the kill
// moment and debris past the canopy), and skim the sea (CLOSE CALL). Frames of each moment go to --out, numbered for
// `ffmpeg -framerate 12 -pattern_type glob -i '<out>/f-*.png'`.
//
//   bun scripts/feedback-shot.ts --base=http://127.0.0.1:5397/ --out=captures/feedback [--swiftshader]
//
// On hailmary (Metal) leave out --swiftshader and pass --chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome".
import { type Page } from "playwright-core"
import { browserBudget } from "../../../scripts/browser-budget"
import { mkdirSync } from "node:fs"
import { join } from "node:path"

await using budget = browserBudget()
const { chromium } = budget

const args = process.argv.slice(2)
const opt = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
const base = opt("base", "http://127.0.0.1:5397/")
const out = opt("out", "captures/feedback")
const [vw, vh] = opt("size", "1280x720").split("x").map(Number) as [number, number]
const swiftshader = args.includes("--swiftshader")
const chrome = opt("chrome", "")
mkdirSync(out, { recursive: true })

const browser = await chromium.launch({
  executablePath: chrome || undefined,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--mute-audio", "--enable-features=WebGPU,Vulkan", "--ignore-gpu-blocklist", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", ...(swiftshader ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--use-vulkan=swiftshader"] : ["--use-angle=metal"])],
})
let failures = 0
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`)
  if (!ok) failures++
}

const page: Page = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1 })
page.on("console", (m) => m.type() === "error" && console.log(`error: ${m.text()}`))
page.on("pageerror", (e) => console.log(`pageerror: ${e.message}`))
await page.addInitScript(() => localStorage.setItem("carrier.name", "ADA"))
await page.goto(`${base}?seed=7&bots&tod=10.5&weather=clear`, { waitUntil: "load" })
await page.waitForFunction(() => !!(globalThis as { carrier?: { game?: { state: { ship: unknown } } } }).carrier?.game?.state.ship, null, { timeout: 120_000 })
const js = <T>(body: string): Promise<T> => page.evaluate(`(() => { const c = globalThis.carrier; const n = c.net; const f = c.flight.flight; const w = c.flight.weapons; const fb = c.flight.feedback; ${body} })()`) as Promise<T>
const until = async (cond: string, ms: number) => {
  for (const end = Date.now() + ms; Date.now() < end; await page.waitForTimeout(200)) if (await js<boolean>(`return !!(${cond})`)) return true
  return false
}
let frame = 0
const shot = async (name: string) => {
  await page.screenshot({ path: join(out, `${name}.png`) })
  console.log(`  ${name}.png`)
}
/** A burst of numbered frames for the video. */
const burst = async (n: number, gap: number) => {
  for (let i = 0; i < n; i++) {
    await page.screenshot({ path: join(out, `f-${String(frame++).padStart(4, "0")}.png`) })
    await page.waitForTimeout(gap)
  }
}

await js("c.debugMenu?.close()")
check(await until("n.crew && n.crew.ships.length >= 2 && c.game.state.shipId >= 0", 30_000), "joined the in-page room aboard a carrier")
await page.waitForTimeout(3000)
await js("n.op('hornet')")
check(await until("f.phase === 'flying'", 20_000), "the Hornet flies")
await page.waitForTimeout(2500)
// Up to a clear altitude, level, for the bots to meet.
const lift = (alt: number) => js(`for (const p of [f.plane, f.prev]) { p.y = ${alt}; p.vy = 0 }`)
await lift(700)
await page.waitForTimeout(1500)
// A hit from a point off to one side (the damage edge leans toward it): a stand-in attacker jet in the weapons' view.
const hurt = (amount: number, side = 1) =>
  js(`const p = f.plane; w.jets.set(-7, { ...[...w.jets.values()][0], id: -7, x: p.x + ${side} * 300, y: p.y, z: p.z }); w.apply({ k: "hp", on: w.id, hp: Math.max(1, w.world.hp(w.id) - ${amount}), by: -7, w: "" }); w.jets.delete(-7)`)

// Chase: a gun hit (sparks off the airframe, the damage edge).
await hurt(8)
await page.waitForTimeout(60)
await shot("1-chase-hit")
await burst(6, 60)

// Cockpit: a missile hit spiderwebs the glass, more hits, oil once below half health, caution below a quarter.
await js("f.cam.mode = 'cockpit'")
await page.waitForTimeout(600)
await hurt(30)
await page.waitForTimeout(60)
await shot("2-cockpit-missile-hit")
await burst(6, 70)
await hurt(6)
await page.waitForTimeout(250)
await hurt(14)
await page.waitForTimeout(250)
await hurt(20)
await burst(10, 120)
await page.waitForTimeout(800)
await shot("3-cockpit-cracks-oil")
check(await js<number>("return fb.canopy.count") >= 3, "the canopy carries the cracks")

// Kills: a bot 220 m ahead on our heading and speed, shot down through the room's `hits` path.
const enemy = await js<number>("const me = n.crew.players.find((p) => p.id === n.id); return n.crew.ships.find((s) => s.team !== me.team).id")
const spawnAhead = (d: number, off: number) =>
  js<number[]>(`
    const p = f.plane, h = Math.atan2(p.vx, -p.vz), s = Math.hypot(p.vx, p.vz)
    const before = n.crew.players.map((q) => q.id)
    n.sendBot({ c: "spawn", role: "hornet", ship: ${enemy}, n: 1, start: "air", rules: false,
      at: [p.x + Math.sin(h) * ${d} + Math.cos(h) * ${off}, p.y + 10, p.z - Math.cos(h) * ${d} + Math.sin(h) * ${off}, h],
      s: { behavior: "straight", alt: Math.round(p.y + 10), speed: Math.max(70, Math.min(230, Math.round(s))), radius: 1500, throttle: 0.6, skill: 0.2, aggression: 0, accuracy: 0, weapons: false, flares: false, ammo: false, invulnerable: false, respawn: false, target: -1, targetShip: -1 } })
    return before
  `)
const newBot = async (before: number[]) => {
  await until(`n.crew.players.some((q) => !${JSON.stringify(before)}.includes(q.id) && q.plane >= 0)`, 5000)
  return js<number>(`return n.crew.players.find((q) => !${JSON.stringify(before)}.includes(q.id) && q.plane >= 0)?.id ?? -1`)
}
const shootDown = async (id: number) => {
  for (let i = 0; i < 40; i++) {
    if (await js<boolean>(`return w.world.hp(${id}) <= 0 || !w.jets.has(${id})`)) return true
    await js(`n.sendHits(${id}, 5)`)
    await page.waitForTimeout(100)
  }
  return false
}
await js("f.cam.mode = 'chase'")
const b1 = await newBot(await spawnAhead(220, 10))
check(b1 >= 0, "a bot flies ahead")
await page.waitForTimeout(1500)
check(await shootDown(b1), "shot it down: SPLASH ONE")
await page.waitForTimeout(60)
await shot("4-splash-one")
await burst(14, 60)
const b2 = await newBot(await spawnAhead(160, -6))
await page.waitForTimeout(1200)
await js("f.cam.mode = 'cockpit'")
await page.waitForTimeout(300)
check(await shootDown(b2), "a second one within the window: DOUBLE KILL")
await page.waitForTimeout(60)
await shot("5-double-kill-cockpit")
await burst(14, 60)
check(await js<number>("return fb.streak") === 2, "streak 2")

// Close call: skim the sea at speed.
await js("f.cam.mode = 'chase'")
await js("for (const p of [f.plane, f.prev]) { p.y = 30; p.vy = 0 }")
await page.waitForTimeout(300)
await js("for (const p of [f.plane, f.prev]) { p.y = 3.5; p.vy = 0 }")
await page.waitForTimeout(120)
await shot("6-close-call")
await burst(10, 60)
await lift(500)

await browser.close()
console.log(failures ? `${failures} check(s) failed` : "all checks passed")
await budget.exit(failures ? 1 : 0)
