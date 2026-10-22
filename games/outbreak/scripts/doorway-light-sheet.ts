/**
 * Doorway light sheet (AR-100, Kit: "the flashlight doesn't go through certain doorways"): fourteen doorways and
 * archways in seed 7's styled homes at 22:00, by flashlight, each framed from inside one room looking through the
 * opening. For a door, "before" reproduces the co-op client's stale state (the door opened while the light casters and
 * sight blockers stay as they were with it shut, `holdCasters`), "after" lets them follow the door as the fix does.
 * Archways have no state to go stale: one still each, showing the beam goes through.
 *
 *   bun scripts/doorway-light-sheet.ts [--skip-build] [--plan] [--viewport 960x640] [--out captures/doorway-light]
 *
 * Writes one PNG per shot, `sheet.png` and `report.json`. Headless Metal Chromium, muted, no visible window: run it
 * through `hivemind run --kind browser`.
 */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { browserBudget } from "../../../scripts/browser-budget"
import { sharedEdges } from "../shared/houses/geometry"
import { inBuildingFootprint, propShape } from "../shared/map"
import { generateWorldChunk } from "../shared/world"

await using budget = browserBudget()
const { chromium } = budget

const game = resolve(import.meta.dir, "..")
const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const out = resolve(game, "../..", arg("out", "captures/doorway-light")!)
const [vw, vh] = arg("viewport", "960x640")!.split("x").map(Number) as [number, number]

type Shot = { name: string; kind: "door" | "arch"; doorId?: string; x: number; y: number; aim: number; label: string }

/** Doorways and archways in seed 7's styled homes, each with a standing spot 1.6 m back, clear of furniture. */
function plan(): Shot[] {
  const shots: Shot[] = []
  const seen = new Set<string>()
  const forms = new Map<string, number>()
  for (let r = 1; r <= 6 && shots.length < 16; r++) {
    for (let cy = -r; cy <= r; cy++) {
      for (let cx = -r; cx <= r; cx++) {
        if (Math.max(Math.abs(cx), Math.abs(cy)) !== r || shots.length >= 16) continue
        const ch = generateWorldChunk(7, 7, cx, cy, "streaming")
        for (const b of ch.buildings) {
          if (!b.style || seen.has(b.id) || (forms.get(b.style.form) ?? 0) >= 2) continue
          const solids = ch.props.map((p) => propShape(p)?.rect).filter((q) => q !== undefined)
          const free = (x: number, y: number) => inBuildingFootprint(b, x, y) && solids.every((q) => x < q[0] - 0.45 || x > q[2] + 0.45 || y < q[1] - 0.45 || y > q[3] + 0.45)
          const label = `${b.style.form}, ${b.style.condition}`
          const add = (s: Shot) => {
            if (seen.has(b.id) || !free(s.x, s.y)) return false
            seen.add(b.id)
            forms.set(b.style!.form, (forms.get(b.style!.form) ?? 0) + 1)
            shots.push(s)
            return true
          }
          const innerDoor = () => {
            for (const d of ch.doors.filter((q) => q.id.startsWith(`${b.id}-room`))) {
              const cx2 = (d.rect[0] + d.rect[2]) / 2
              if (add({ name: "", kind: "door", doorId: d.id, x: cx2, y: d.rect[3] + 1.6, aim: -Math.PI / 2, label: `${label}: inner door` })) return
            }
          }
          const arch = () => {
            for (const s of sharedEdges(b.style!.rooms)) {
              if (s.axis !== "z") continue
              const walls = ch.barriers.filter((w) => w.kind === "wall" && w.rect[0] <= s.at && w.rect[2] >= s.at)
              let start = -1
              for (let a = s.a0 + 0.025; a <= s.a1 + 0.025; a += 0.05) {
                const open = a <= s.a1 && !walls.some((w) => a >= w.rect[1] && a <= w.rect[3])
                if (open && start < 0) start = a
                if (!open && start >= 0) {
                  if (a - start > 1 && add({ name: "", kind: "arch", x: s.at - 1.6, y: (start + a) / 2, aim: 0, label: `${label}: archway` })) return
                  start = -1
                }
              }
            }
          }
          // Inner doors look north from the room south of them, archways east; front doors look out to the street.
          if (shots.filter((q) => q.kind === "arch").length < 4) arch()
          if (!seen.has(b.id)) innerDoor()
          if (!seen.has(b.id)) arch()
          if (seen.has(b.id)) continue
          const front = ch.doors.find((q) => q.id === `${b.id}-front`)
          if (front) add({ name: "", kind: "door", doorId: front.id, x: (front.rect[0] + front.rect[2]) / 2, y: front.rect[1] - 1.6, aim: Math.PI / 2, label: `${label}: front door` })
        }
      }
    }
  }
  shots.forEach((s, i) => (s.name = `${String(i + 1).padStart(2, "0")}-${s.kind}`))
  return shots
}

const shots = plan()
if (process.argv.includes("--plan")) {
  for (const s of shots) console.log(s.name, s.label, s.doorId ?? "", s.x.toFixed(2), s.y.toFixed(2))
  await budget.exit(0)
}
assert(shots.length >= 12, `only ${shots.length} openings`)
mkdirSync(out, { recursive: true })
if (!process.argv.includes("--skip-build")) assert.equal(Bun.spawnSync(["bun", "run", "build"], { cwd: game, stdout: "inherit", stderr: "inherit" }).exitCode, 0)
const root = resolve(game, "dist/arcade/outbreak")
const fixture = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname
    if (path.startsWith("/shots/")) return new Response(Bun.file(resolve(out, path.slice(7))))
    const file = Bun.file(resolve(root, `.${path === "/" ? "/index.html" : path}`))
    return (await file.exists()) ? new Response(file) : new Response("Not found", { status: 404 })
  },
})
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
assert(chrome, "Install Chromium first")

const HUD = "#status, #hotbar, #stamina, #battery, #prompt, .callouts, .callout, .hud, #hud"
const report: Record<string, unknown> = { viewport: [vw, vh], shots: [] as unknown[] }
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
try {
  const page = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text())
  })
  await page.goto(`http://127.0.0.1:${fixture.port}/?solo&seed=7&bench&peaceful=1`)
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready)
  await page.evaluate((sel) => {
    for (const el of document.querySelectorAll<HTMLElement>(sel)) el.style.visibility = "hidden"
  }, HUD)
  const settle = (shot: Shot, phase: "closed" | "before" | "after" | "arch") =>
    page.evaluate(
      async ({ a, phase }) => {
        const h = (window as any).__arcadeHarness
        const s = h.session()
        const door = a.doorId ? s.view.town.doors.find((d: { id: string }) => d.id === a.doorId) : undefined
        if (phase === "closed") {
          h.setLab("timeScale", 0)
          h.setLab("hour", 22)
          h.setLab("zoom", 34)
          h.holdCasters(false)
          h.pose(a.x, a.y, a.aim)
        }
        if (door) {
          door.open = phase !== "closed"
          // The co-op client's state: the door is drawn open, the casters still have it shut.
          h.holdCasters(phase === "before")
          s.rebuildCollision()
        }
        s.view.player.aim = a.aim
        s.view.player.flashlightOn = true
        const t0 = performance.now()
        for (let i = 0; performance.now() - t0 < 12000; i++) {
          s.ai.agents.length = 0
          await h.step()
          if (i > (phase === "closed" ? 50 : 12) && h.state().world.pendingBakes === 0) break
          await new Promise((r) => setTimeout(r, 10))
        }
        return { found: Boolean(door) || !a.doorId, open: door?.open ?? null, inside: h.state().world?.isStreamWindow ?? null }
      },
      { a: shot, phase },
    )
  const rows: { label: string; before?: string; after: string }[] = []
  for (const shot of shots) {
    const first = await settle(shot, "closed")
    const entry: Record<string, unknown> = { ...shot, ...first }
    if (shot.kind === "door") {
      await settle(shot, "before")
      await page.locator("#game").screenshot({ path: resolve(out, `${shot.name}-before.png`) })
      entry.after = await settle(shot, "after")
      await page.locator("#game").screenshot({ path: resolve(out, `${shot.name}-after.png`) })
      rows.push({ label: `${shot.name} ${shot.label}`, before: `${shot.name}-before.png`, after: `${shot.name}-after.png` })
    } else {
      await settle(shot, "arch")
      await page.locator("#game").screenshot({ path: resolve(out, `${shot.name}-after.png`) })
      rows.push({ label: `${shot.name} ${shot.label} (no state to go stale)`, after: `${shot.name}-after.png` })
    }
    ;(report.shots as unknown[]).push(entry)
    console.log(shot.name, shot.label, JSON.stringify(first))
  }
  report.errors = errors
  // Contact sheet: before | after per opening, two openings a row.
  const cell = (src?: string, tag?: string) =>
    src ? `<figure><img src="/shots/${src}"><figcaption>${tag}</figcaption></figure>` : `<figure class="none"><figcaption>—</figcaption></figure>`
  const html = `<!doctype html><style>body{margin:0;background:#111;color:#ddd;font:13px system-ui}h1{font-size:16px;margin:10px 12px}
    .grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;padding:0 10px 10px}.row{background:#1b1b1b;padding:6px}
    .pair{display:grid;grid-template-columns:1fr 1fr;gap:4px}figure{margin:0}img{width:100%;display:block}figcaption{padding:2px 0;color:#9a9}
    .none{display:flex;align-items:center;justify-content:center;background:#151515}</style>
    <h1>AR-100 · flashlight through doorways (22:00, seed 7) · before: co-op client's own door opened, casters stale · after: fix</h1>
    <div class="grid">${rows.map((r) => `<div class="row"><div>${r.label}</div><div class="pair">${cell(r.before, "before")}${cell(r.after, "after")}</div></div>`).join("")}</div>`
  writeFileSync(resolve(out, "sheet.html"), html)
  const sheet = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 })
  await sheet.goto(`http://127.0.0.1:${fixture.port}/shots/sheet.html`)
  await sheet.waitForFunction(() => [...document.images].every((i) => i.complete))
  await sheet.screenshot({ path: resolve(out, "sheet.png"), fullPage: true })
} finally {
  writeFileSync(resolve(out, "report.json"), JSON.stringify(report, null, 2))
  await browser.close()
  fixture.stop()
}
console.log(out)
