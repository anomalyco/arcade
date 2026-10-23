// Jets parked on deck (shared/deck-jets.ts): captures of the parked set and of parked jets being destroyed, against a
// dev server (`?seed=N&bots` plays on the in-page dev room, src/dev/local-room.ts). A second player, RAIDER, joins that
// room through the same sockets and plays the real protocol: an F-35C drops a bomb on a parked Hornet, then a Hornet
// strafes the other one (its trigger relayed, its rounds reported as `deckhits`).
//
//   bun scripts/deck-jets-shot.ts --base=http://127.0.0.1:5297/ --out=captures/deck-jets [--swiftshader]
//
// On hailmary (Metal) leave out --swiftshader and pass --chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome".
import { type Page } from "playwright-core"
import { browserBudget } from "../../../scripts/browser-budget"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { DECK_BAYS } from "../shared/deck-jets"
import { DECK_Y } from "../shared/carrier-spec"

await using budget = browserBudget()
const { chromium } = budget

const args = process.argv.slice(2)
const opt = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
const base = opt("base", "http://127.0.0.1:5297/")
const out = opt("out", "captures/deck-jets")
const [vw, vh] = opt("size", "1280x800").split("x").map(Number) as [number, number]
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
await page.goto(`${base}?seed=7&bots&tod=10.5&weather=clear`, { waitUntil: "load" })
await page.waitForFunction(() => !!(globalThis as { carrier?: { game?: { state: { ship: unknown } } } }).carrier?.game?.state.ship, null, { timeout: 180_000 })
const js = <T>(body: string): Promise<T> => page.evaluate(`(() => { const c = globalThis.carrier; const n = c.net; const R = globalThis.carrierRoom; ${body} })()`) as Promise<T>
const until = async (cond: string, ms: number) => {
  for (const end = Date.now() + ms; Date.now() < end; await page.waitForTimeout(250)) if (await js<boolean>(`return !!(${cond})`)) return true
  return false
}
const shot = async (name: string) => {
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(out, `${name}.png`) })
  console.log(`  ${name}.png`)
}
await js("c.debugMenu?.close()")
check(await until("n.crew && n.crew.ships.length >= 2 && c.game.state.shipId >= 0", 30_000), "joined the in-page room aboard a carrier")
// Let the plane models load.
await page.waitForTimeout(4000)

// In-page helpers: my ship's room pose and ship-local → world (plan frame: bow along (sin h, −cos h), port along
// (−cos h, −sin h)), and the RAIDER player.
await js(`
  const me = () => R.core.ships.get(c.game.state.shipId)
  const local = (x, y, z) => { const s = me(); const h = s.heading; return [s.x + Math.sin(h) * z - Math.cos(h) * x, s.heave + y, s.z - Math.cos(h) * z - Math.sin(h) * x] }
  const seaT = () => (Date.now() - R.core.world.epoch) / 1000
  const raider = { sock: R.open(), inbox: [], id: -1, seq: 0, timer: null, pose: null }
  raider.sock.onmessage = (e) => { if (typeof e.data === "string") { const m = JSON.parse(e.data); raider.inbox.push(m); if (m.type === "welcome") raider.id = m.id } }
  raider.sock.onopen = () => raider.sock.send(JSON.stringify({ type: "hello", build: R.build, name: "RAIDER" }))
  // Relays the raider's jet every 50 ms at pose() (world position, nose direction, velocity).
  raider.fly = (pose) => {
    raider.pose = pose
    clearInterval(raider.timer)
    raider.timer = setInterval(() => {
      const p = raider.pose()
      const [dx, dy, dz] = p.nose
      const yaw = Math.atan2(dx, dz), pitch = -Math.asin(dy)
      const qy = [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)], qp = [Math.sin(pitch / 2), 0, 0, Math.cos(pitch / 2)]
      const q = [qy[3] * qp[0], qy[1] * qp[3], -qy[1] * qp[0], qy[3] * qp[3]]
      raider.sock.send(JSON.stringify({ type: "plane", p: [seaT(), 1, p.at[0], p.at[1], p.at[2], q[0], q[1], q[2], q[3], p.v[0], p.v[1], p.v[2], 0.8, 0, 0, 0, 0, p.kind, 0] }))
    }, 50)
  }
  raider.send = (m) => raider.sock.send(JSON.stringify(m))
  globalThis.__deck = { me, local, seaT, raider }
`)
check(await until("globalThis.__deck.raider.id >= 0", 10_000), "RAIDER joined the room")

const view = (lx: number, lz: number, yawOff: number, pitch: number, dist: number) =>
  js(`const s = globalThis.__deck.me(); const w = globalThis.__deck.local(${lx}, 26, ${lz}); c.game.state.free = true; c.camera.set({ x: w[0], z: w[2], yaw: s.heading * 180 / Math.PI + ${yawOff}, pitch: ${pitch}, dist: ${dist} })`)

const parked = (): Promise<number[]> => js(`const s = n.crew.ships.find((x) => x.id === c.game.state.shipId); const now = n.serverNow(); return s.aircraft.map((a, i) => a.pilot === null && a.readyAt <= now ? i : -1).filter((i) => i >= 0 && i < 3)`)
check((await parked()).join() === "0,1,2", "two Hornets and the F-35C are ready: all three parked")
await view(-20, 0, 210, 32, 230)
await shot("1-parked-overview")
const [h0, h1, f35] = DECK_BAYS as [(typeof DECK_BAYS)[number], (typeof DECK_BAYS)[number], (typeof DECK_BAYS)[number]]
await view(h0.x, (h0.z + h1.z) / 2, 235, 20, 110)
await shot("2-parked-hornets")
await view(f35.x, f35.z, 250, 18, 70)
await shot("3-parked-f35")

// Bomb: RAIDER's F-35C, 140 m over the first Hornet's bay, releases one bomb.
await js(`const r = globalThis.__deck.raider; r.send({ type: "op", op: "f35" })`)
check(await until(`n.crew.players.find((p) => p.id === globalThis.__deck.raider.id)?.plane >= 0`, 5000), "RAIDER launched an F-35C")
await js(`
  const d = globalThis.__deck, r = d.raider
  r.fly(() => { const s = d.me(); const f = [Math.sin(s.heading), -Math.cos(s.heading)]; return { at: d.local(${h0.x}, ${DECK_Y + 140}, ${h0.z}), nose: [f[0], 0, f[1]], v: [f[0] * s.u, 0, f[1] * s.u], kind: 1 } })
`)
await page.waitForTimeout(600)
await view(h0.x, h0.z, 215, 14, 120)
await js(`
  const d = globalThis.__deck, r = d.raider, s = d.me(), f = [Math.sin(s.heading), -Math.cos(s.heading)]
  const at = d.local(${h0.x}, ${DECK_Y + 138}, ${h0.z})
  r.send({ type: "fire", m: [r.seq++, d.seaT(), at[0], at[1], at[2], f[0] * s.u, 0, f[1] * s.u, -1, 1] })
`)
await page.waitForTimeout(3000)
await shot("4-bomb-falling")
check(await until("n.crew.ships.find((x) => x.id === c.game.state.shipId).aircraft[0].readyAt > n.serverNow()", 15_000), "the bomb destroyed the parked Hornet: its slot is recharging")
await shot("5-bomb-impact")
await page.waitForTimeout(2500)
await shot("6-bomb-wreck-burning")
check((await parked()).join() === "1,2", `the other jets still stand (${(await parked()).join()})`)

// Strafe: RAIDER lands its F-35C's sortie (recover), launches a Hornet and dives on the second Hornet, gun hot.
await js(`const r = globalThis.__deck.raider; clearInterval(r.timer); r.send({ type: "recover", how: "landed" })`)
await page.waitForTimeout(6000)
await js(`globalThis.__deck.raider.send({ type: "op", op: "hornet" })`)
check(await until(`n.crew.players.find((p) => p.id === globalThis.__deck.raider.id)?.plane >= 0`, 8000), "RAIDER launched a Hornet")
await js(`
  const d = globalThis.__deck, r = d.raider
  r.fly(() => {
    const s = d.me(), h = s.heading
    const tgt = d.local(${h1.x}, ${DECK_Y + 1}, ${h1.z})
    const from = d.local(${h1.x - 120}, ${DECK_Y + 70}, ${h1.z - 260})
    const k = Math.min(1, ((Date.now() - r.t0) / 1000) / 3)
    const at = [from[0] + (tgt[0] - from[0]) * k * 0.55, from[1] + (tgt[1] - from[1]) * k * 0.55, from[2] + (tgt[2] - from[2]) * k * 0.55]
    const dir = [tgt[0] - at[0], tgt[1] - at[1], tgt[2] - at[2]], l = Math.hypot(...dir)
    return { at, nose: dir.map((x) => x / l), v: dir.map((x) => (x / l) * 90), kind: 0 }
  })
  r.t0 = Date.now()
  r.send({ type: "gun", on: true })
`)
await view(h1.x - 30, h1.z - 60, 200, 16, 170)
await page.waitForTimeout(1500)
await shot("7-strafe-run")
await js(`const d = globalThis.__deck, r = d.raider; r.send({ type: "deckhits", w: 0, ship: c.game.state.shipId, slot: 1, n: 30 })`)
check(await until("n.crew.ships.find((x) => x.id === c.game.state.shipId).aircraft[1].readyAt > n.serverNow()", 8000), "the strafe destroyed the second parked Hornet")
await shot("8-strafe-destroyed")
await js(`const r = globalThis.__deck.raider; r.send({ type: "gun", on: false })`)
await page.waitForTimeout(3000)
await view(-20, 0, 210, 32, 230)
await shot("9-bays-recharging")
check((await parked()).join() === "2", `only the F-35C still stands (${(await parked()).join()})`)

await browser.close()
console.log(failures ? `${failures} check(s) failed` : "all checks passed")
await budget.exit(failures ? 1 : 0)
