// Headless, muted multiplayer check of a running woods Worker (wrangler dev behind tailscale serve, or the live site):
//   bun scripts/mp-test.ts [--url https://studio.taila8e7c7.ts.net:5298/arcade/woods/] [--out dir]
//   bun scripts/mp-test.ts --serve 8799     (after `bun run build`: runs its own `wrangler dev` there, e.g. in HiveMind)
// Three browsers join one room by link, look at each other's beams, Kit ties a tape everyone must see, Aiden compares
// maps with Kit, Ryan's socket drops and rejoins. Screenshots and a JSON report go to the out dir ($LEASE_OUT).
import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium, type Page } from "playwright-core"

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1]! : fallback }
const serve = arg("--serve", "")
const wrangler = serve ? Bun.spawn(["bunx", "wrangler", "dev", "--ip", "127.0.0.1", "--port", serve], { stdout: "ignore", stderr: "ignore" }) : null
const base = new URL(serve ? `http://127.0.0.1:${serve}/arcade/woods/` : arg("--url", "https://studio.taila8e7c7.ts.net:5298/arcade/woods/"))
for (let i = 0; wrangler && i < 90; i++) {
  if (await fetch(new URL("api/health", base)).then((r) => r.ok, () => false)) break
  await new Promise((r) => setTimeout(r, 1000))
}
const out = resolve(arg("--out", process.env.LEASE_OUT ?? "captures/mp"))
mkdirSync(out, { recursive: true })

type Net = { online: boolean; me: number; status: string | null; walkers: number; roster: { pid: number; name: string; connected: boolean }[]; tapes: number[]; bytesIn: number; kbps: number; self: { x: number; z: number }; heard: number[] }
type Woods = {
  frames: number; autoplay: boolean; net: Net; walking: boolean; debug: { beams: number }
  walkTo(x: number, z: number): void; face(x: number, z: number, pitch?: number): void; hold(code: string, down: boolean): void; drop(): void
  friend(id: number): { x: number; z: number } | undefined
  world: { trees: { id: number; x: number; z: number; radius: number }[] }
  camera: { flashlight: boolean; pitch: number }
}
declare const woods: Woods

const room = ((await (await fetch(new URL("api/create", base), { method: "POST" })).json()) as { room: string }).room
const report: Record<string, unknown> = { room, url: base.href }
const checks: [string, boolean][] = []
const check = (what: string, ok: boolean) => { checks.push([what, ok]); console.log(`${ok ? "PASS" : "FAIL"} ${what}`) }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const errors: string[] = []
const names = ["Kit", "Aiden", "Ryan"]
const pages: Page[] = []
for (const name of names) {
  const ctx = await browser.newContext({ viewport: { width: 960, height: 540 } })
  const page = await ctx.newPage()
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`))
  page.on("console", (m) => { if (m.type() === "error") errors.push(`${name}: ${m.text()}`) })
  await page.goto(`${base.href}?room=${room}&name=${name}`, { waitUntil: "load" })
  await page.waitForFunction(() => (window as unknown as { woods?: Woods }).woods && woods.frames > 2 && woods.net.me > 0, null, { timeout: 60000 })
  await page.evaluate(() => { woods.autoplay = true })
  pages.push(page)
}
const [kit, aiden, ryan] = pages as [Page, Page, Page]
const net = (p: Page) => p.evaluate(() => woods.net)
await sleep(2500)
const nets = await Promise.all(pages.map(net))
report.joined = nets.map((n) => ({ me: n.me, walkers: n.walkers, roster: n.roster.map((r) => r.name) }))
check("three people joined one room by link, each sees 4 walkers (3 people + 1 bot)", nets.every((n) => n.walkers === 4 && n.roster.length === 3))

// Everyone turns to face the others and raises their beam a little.
const ids = nets.map((n) => n.me)
for (const [k, p] of pages.entries()) await p.evaluate((other) => { const f = woods.friend(other)!; woods.face(f.x, f.z, 0.05) }, ids[(k + 1) % 3]!)
await sleep(1200)
const beams = await Promise.all(pages.map((p) => p.evaluate(() => woods.debug.beams)))
report.beams = beams
check(`each sees friends' beams (beams drawn: ${beams.join(", ")})`, beams.every((b) => b >= 3))
for (const [k, p] of pages.entries()) await p.screenshot({ path: `${out}/beams-${names[k]}.png` })

// Kit walks to the nearest trunk and ties a tape.
const tree = await kit.evaluate(() => {
  const s = woods.net.self
  const t = [...woods.world.trees].sort((a, b) => Math.hypot(a.x - s.x, a.z - s.z) - Math.hypot(b.x - s.x, b.z - s.z))[0]!
  woods.walkTo(t.x, t.z + t.radius + 0.7)
  return t
})
await kit.waitForFunction(() => !woods.walking, null, { timeout: 20000 })
await kit.evaluate((t) => { woods.face(t.x, t.z, -0.1); woods.hold("KeyE", true) }, tree)
await sleep(2200)
await kit.evaluate(() => woods.hold("KeyE", false))
await sleep(500)
const tapes = await Promise.all(pages.map((p) => p.evaluate(() => woods.net.tapes)))
report.tapes = tapes
check(`Kit's tape on tree ${tree.id} is in everyone's world`, tapes.every((t) => t.includes(tree.id)))
await aiden.evaluate((t) => { woods.walkTo(t.x + 2.5, t.z + 3); }, tree)
await aiden.waitForFunction(() => !woods.walking, null, { timeout: 20000 })
await aiden.evaluate((t) => woods.face(t.x, t.z, 0.1), tree)
await sleep(800)
await aiden.screenshot({ path: `${out}/tape-seen-by-Aiden.png` })

// Aiden walks up to Kit and they both raise their maps.
const kitAt = (await net(kit)).self
await aiden.evaluate((k) => woods.walkTo(k.x + 1, k.z + 0.5), kitAt)
await aiden.waitForFunction(() => !woods.walking, null, { timeout: 20000 })
for (const p of [kit, aiden]) await p.evaluate(() => woods.hold("KeyG", true))
await sleep(2000)
const heard = await aiden.evaluate(() => woods.net.heard)
await aiden.screenshot({ path: `${out}/map-swap-Aiden.png` })
for (const p of [kit, aiden]) await p.evaluate(() => woods.hold("KeyG", false))
check(`Aiden's map has Kit's path after comparing maps (heard from ${heard.join(", ")})`, heard.includes(ids[0]!))

// Ryan's connection drops; he reconnects to the same seat and place.
const before = await net(ryan)
await ryan.evaluate(() => woods.drop())
let sawDrop = false
for (let i = 0; i < 40; i++) {
  const r = (await net(kit)).roster.find((x) => x.pid === before.me)
  if (r && !r.connected) sawDrop = true
  await sleep(100)
}
await sleep(3000)
const after = await net(ryan)
report.rejoin = { before: before.me, after: after.me, status: after.status, sawDrop, moved: Math.hypot(after.self.x - before.self.x, after.self.z - before.self.z) }
check(`Ryan rejoined as the same person (${before.me} → ${after.me}, status ${after.status ?? "ok"}, Kit saw the drop: ${sawDrop})`, after.me === before.me && !after.status)
check("Ryan still sees Kit's tape after rejoining", after.tapes.includes(tree.id))

const kbps = (await Promise.all(pages.map(net))).map((n) => +n.kbps.toFixed(2))
report.kbps = kbps
console.log(`down per player (3 people + 1 bot): ${kbps.join(", ")} KB/s`)
report.errors = errors
report.checks = checks
writeFileSync(`${out}/mp.json`, JSON.stringify(report, null, 2))
if (errors.length) console.log("browser errors:", errors.slice(0, 8))
await browser.close()
wrangler?.kill()
if (checks.some(([, ok]) => !ok)) process.exitCode = 1
