// Stills of one night (NIGHT.md) from the production build, headless and muted (run after `bun run build`, through
// HiveMind's browser kind): a clue found (caption, its evidence and the beam on it), the held map with the clue
// pencilled and the watch, the naming card at the radio once it's live, then (after naming a decoy, so it starts taking
// searchers) the end card and the debrief once the bots play the night out. Writes PNGs and night.json to --out.
//   bun scripts/night-proof.ts [--out <dir>] [--size 1600x900] [--night 5]
import { mkdirSync, writeFileSync } from "node:fs"
import { resolve, sep } from "node:path"
import { browserBudget } from "../../../scripts/browser-budget"

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1]! : fallback }
const out = resolve(arg("--out", process.env.LEASE_OUT ?? "captures/barbara-night"))
const [W, H] = arg("--size", "1600x900").split("x").map(Number) as [number, number]
const night = Number(arg("--night", "5"))
mkdirSync(out, { recursive: true })

type P = { id: number; bot: boolean; x: number; z: number; light: boolean; map: { clues: number[] } }
type Clue = { id: number; kind: string; x: number; z: number; y: number }
type Woods = {
  frames: number; paused: boolean; autoplay: boolean
  setPose(x: number, z: number, yaw: number, pitch?: number): void
  step(ms: number): void
  hold(code: string, down: boolean): void
  camera: { yaw: number; pitch: number; flashlight: boolean }
  state: { t: number; players: P[]; brains: { id: number; mode: string; timer: number }[] }
  world: { camp: { x: number; z: number; radius: number }; trees: { x: number; z: number; radius: number }[] }
  night: {
    seed: number; phase: string; reason: string; start: number; end: number; finds: { clue: number; by: number; at: number }[]
    layout: { ridge: { x: number; z: number }; radio: { x: number; z: number }; clues: Clue[]; verdict: { culprit: string } }
    verdict: { struck: string[]; gone: { id: number }[] }
  }
  verdictCard: { open(): void; close(): void }
  vote(s: string): void
  session: { tick(i: { yaw: number; pitch: number; light: boolean; tie: boolean; map: boolean; mx: number; mz: number }): void }
  endCard: { show(): void; visible: boolean }
  nextNight(): void
}
declare const woods: Woods

await using budget = browserBudget()
const root = resolve("dist/arcade/barbara"), prefix = "/arcade/barbara/"
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  const path = new URL(req.url).pathname
  if (!path.startsWith(prefix)) return new Response("no", { status: 404 })
  const file = resolve(root, decodeURIComponent(path.slice(prefix.length)) || "index.html")
  if (!file.startsWith(root + sep)) return new Response("no", { status: 404 })
  const f = Bun.file(file)
  return (await f.exists()) ? new Response(f) : new Response("no", { status: 404 })
} })
const browser = await budget.chromium.launch({ timeout: 120000, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist"] })
const page = await browser.newPage({ viewport: { width: W, height: H } })
const errors: string[] = []
page.on("pageerror", (e) => errors.push(String(e)))
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()) })
await page.goto(`http://127.0.0.1:${server.port}${prefix}?quality=high&night=${night}`, { waitUntil: "load" })
await page.waitForFunction(() => (window as unknown as { woods?: Woods }).woods && woods.frames > 2, null, { timeout: 150000 }).catch((e) => { console.log(errors.join("\n")); throw e })
const settle = (n: number) => page.evaluate(async (n) => { for (let i = 0; i < n; i++) { woods.step(1000 / 60); if (i % 5 === 4) await new Promise((r) => setTimeout(r, 0)) } }, n)
const report: Record<string, unknown> = {}

// 1. A clue found: stand 3 m off her badge with a clear line to it, torch on it.
report.clue = await page.evaluate(() => {
  for (const el of document.querySelectorAll<HTMLElement>(".arcade-shell, #hud, #prompt, #room")) el.style.visibility = "hidden"
  woods.paused = true
  woods.autoplay = true
  const badge = woods.night.layout.clues.find((c) => c.kind === "badge")!
  const clear = (x: number, z: number) => woods.world.trees.every((t) => {
    const dx = x - badge.x, dz = z - badge.z, k = Math.max(0, Math.min(1, ((t.x - badge.x) * dx + (t.z - badge.z) * dz) / (dx * dx + dz * dz)))
    return Math.hypot(t.x - badge.x - dx * k, t.z - badge.z - dz * k) > t.radius + 0.5
  })
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2, x = badge.x + Math.cos(a) * 3, z = badge.z + Math.sin(a) * 3
    if (!clear(x, z)) continue
    woods.setPose(x, z, Math.atan2(-(badge.x - x), -(badge.z - z)), -0.5)
    woods.camera.flashlight = true
    // The friends wait well away, so the find is yours.
    for (const b of woods.state.brains) { b.mode = "wait"; b.timer = 999; const p = woods.state.players.find((q) => q.id === b.id)!; p.x = woods.world.camp.x; p.z = woods.world.camp.z }
    return { at: [x, z], badge: [badge.x, badge.z] }
  }
  return null
})
await settle(40)
report.clueFound = await page.evaluate(() => ({ finds: woods.night.finds, toast: document.getElementById("toast")!.textContent }))
await page.screenshot({ path: `${out}/clue.png` })

// 2. The map up: the badge in red pencil with its bearing, the watch on the left wrist.
await page.evaluate(() => woods.hold("KeyG", true))
await settle(70)
await page.screenshot({ path: `${out}/map.png` })
await page.evaluate(() => woods.hold("KeyG", false))

// 3. The night without drawing until the radio by the tower is live: you walk with the nearest friend (sharing their
// light); the bots work the leads. A night lost before then moves on to the next one (up to four).
const walkUntil = (stopAtRadio: boolean) => page.evaluate((stopAtRadio) => {
  const live = () => woods.night.finds.some((f) => f.clue === 4)
  for (let i = 0; i < 25 * 3600 && (woods.night.phase === "camp" || woods.night.phase === "search") && !(stopAtRadio && live()); i++) {
    const me = woods.state.players[0]!
    let near: P | undefined, nd = Infinity
    for (const q of woods.state.players) if (q.bot) { const d = Math.hypot(q.x - me.x, q.z - me.z); if (d < nd) { nd = d; near = q } }
    let mx = 0, mz = 0
    if (woods.night.phase === "camp") { mz = -1 } else if (near && nd > 5) { mx = (near.x - me.x) / nd; mz = (near.z - me.z) / nd }
    woods.session.tick({ yaw: Math.atan2(-mx, -mz), pitch: -0.3, light: !near || nd > 9, tie: false, map: false, mx, mz })
  }
  const n = woods.night
  return { seed: n.seed, phase: n.phase, reason: n.reason, minutes: +((n.end - n.start) / 60).toFixed(1), finds: n.finds.map((f) => f.clue), radio: live() }
}, stopAtRadio)
const nights: unknown[] = []
for (let attempt = 0; attempt < 4; attempt++) {
  await page.evaluate(() => { for (const b of woods.state.brains) { b.mode = "wander"; b.timer = 0 } })
  const run = await walkUntil(true)
  nights.push(run)
  if (run.radio) break
  await page.evaluate(() => { woods.step(1000 / 60); woods.nextNight(); woods.step(1000 / 60) })
}
report.nights = nights

// 4. The naming moment: at the radio, facing it, torch on, the card up.
report.radio = await page.evaluate(() => {
  const r = woods.night.layout.radio, ridge = woods.night.layout.ridge
  const dx = r.x - ridge.x, dz = r.z - ridge.z, l = Math.hypot(dx, dz) || 1
  const x = r.x + (dx / l) * 2.2, z = r.z + (dz / l) * 2.2
  woods.setPose(x, z, Math.atan2(-(r.x - x), -(r.z - z)), -0.12)
  woods.camera.flashlight = true
  woods.verdictCard.open()
  return { radio: [r.x, r.z], culprit: woods.night.layout.verdict.culprit }
})
await settle(40)
await page.screenshot({ path: `${out}/naming.png` })

// 5. Name a decoy, so it starts taking searchers, and let the night play out.
report.named = await page.evaluate(() => {
  const decoy = ["bear", "man"].find((s) => s !== woods.night.layout.verdict.culprit)!
  woods.vote(decoy)
  woods.verdictCard.close()
  return decoy
})
report.end = await walkUntil(false)
report.verdict = await page.evaluate(() => ({ struck: woods.night.verdict.struck, gone: woods.night.verdict.gone.map((g) => g.id), reason: woods.night.reason }))
console.log(JSON.stringify({ nights: report.nights, end: report.end, verdict: report.verdict }))
// The end event plays in the next frame; the card would come up a few seconds later, so bring it up now.
await settle(3)
await page.evaluate(() => woods.endCard.show())
await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
await page.screenshot({ path: `${out}/end.png` })
await page.click("[data-night=debrief]")
await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
await page.screenshot({ path: `${out}/debrief.png` })

report.errors = errors
writeFileSync(`${out}/night.json`, JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
await browser.close()
server.stop(true)
