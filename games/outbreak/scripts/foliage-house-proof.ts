/**
 * Regression proof for "I went into the house and all the bushes disappeared": walks the survivor in through a front
 * door, along the hall and back out, then compares the porch frame before and after the visit, the level vertex
 * count, the drawn level chunks and which level path is live (the authored origin build or the streamed window).
 *
 *   bun scripts/foliage-house-proof.ts [--skip-build] [--coop] [--viewport 1728x1000] [--out captures/foliage-house]
 *
 * Solo runs frozen (`bench`) through the harness at three houses: Ash from a fresh page (origin build), Ash after a
 * reset, and a streamed house far east. `--coop` serves the build with `wrangler dev`, joins two pages to one room
 * and walks Ann into Ash with real keys. Headless Metal Chromium, muted, no visible window: run it through
 * `hivemind run --kind browser`.
 */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { randomRoomCode } from "@arcade/kit/sim/matchmaking"
import { chromium, type Page } from "playwright-core"
import { generateWorldChunk } from "../shared/world"

const game = resolve(import.meta.dir, "..")
const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const coopMode = process.argv.includes("--coop")
const out = resolve(game, "../..", arg("out", "captures/foliage-house")!)
const [vw, vh] = arg("viewport", "1728x1000")!.split("x").map(Number) as [number, number]
mkdirSync(out, { recursive: true })
if (!process.argv.includes("--skip-build")) assert.equal(Bun.spawnSync(["bun", "run", "build"], { cwd: game, stdout: "inherit", stderr: "inherit" }).exitCode, 0)

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache).filter(n => /^chromium-\d+$/.test(n)).sort().reverse().map(n => `${cache}/${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`).find(existsSync)
assert(chrome, "Install Chromium first")

type Snap = { chunks: number; drawn: number; vertices: number; streamed: boolean; inside: boolean; view: number[]; player: { x: number; y: number } }
type Phase = "before" | "inside" | "after"
const HUD = "#status, #hotbar, #stamina, #battery, #prompt, .callouts, .callout, .hud, #hud, .coop-hud, #coop"

async function snap(page: Page): Promise<Snap> {
  return page.evaluate(() => {
    const h = (window as any).__arcadeHarness
    const s = h.state()
    const town = h.session().view.town
    const p = s.player
    const buildings = s.world?.isStreamWindow ? s.world.windowBuildings : town.buildings
    const inside = buildings.some((b: { rect: number[] }) => p.x > b.rect[0] && p.x < b.rect[2] && p.y > b.rect[1] && p.y < b.rect[3])
    const d = h.levelDraw()
    return { chunks: d.chunks, drawn: d.drawn, vertices: Math.round(s.vertices), streamed: s.world?.isStreamWindow ?? false, inside, view: s.world.viewRect.map((v: number) => +v.toFixed(1)), player: { x: +p.x.toFixed(2), y: +p.y.toFixed(2) } }
  })
}

/** Saves the beauty frame and returns an albedo frame (Lab "Contribution: Albedo"), which ignores the day clock and lights. */
async function shot(page: Page, file: string, bench: boolean): Promise<Buffer> {
  const render = (diagnostic: number) => page.evaluate(async a => {
    const h = (window as any).__arcadeHarness
    h.setLab("diagnostic", a.diagnostic)
    if (a.bench) await h.step()
    else await new Promise(r => setTimeout(r, 150))
  }, { diagnostic, bench })
  await page.evaluate(sel => { for (const el of document.querySelectorAll<HTMLElement>(sel)) el.style.visibility = "hidden" }, HUD)
  await page.locator("#game").screenshot({ path: file })
  await render(1)
  const albedo = await page.locator("#game").screenshot({ path: file.replace(/\.png$/, "-albedo.png") })
  await render(0)
  await page.evaluate(sel => { for (const el of document.querySelectorAll<HTMLElement>(sel)) el.style.visibility = "" }, HUD)
  return albedo
}

/**
 * Share of 8×8 px blocks whose mean RGB moved by more than 36 levels in total. Block means ride out leaf sway and
 * sub-pixel camera settling; a hedge or tree that is gone changes whole blocks.
 */
async function pixelDiff(page: Page, a: Buffer, b: Buffer): Promise<number> {
  return page.evaluate(async ([a, b]) => {
    const load = async (b64: string) => {
      const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob())
      const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext("2d")!
      g.drawImage(bmp, 0, 0)
      return g.getImageData(0, 0, bmp.width, bmp.height)
    }
    const [ia, ib] = await Promise.all([load(a!), load(b!)])
    const B = 8, S = 4, w = ia.width
    const bw = Math.floor((w - 2 * S) / B), bh = Math.floor((ia.height - 2 * S) / B)
    // Real-key co-op walking stops a few centimetres off the first spot, so take the best of small camera shifts.
    let best = 1
    for (let sy = -S; sy <= S; sy++) for (let sx = -S; sx <= S; sx++) {
      let changed = 0
      for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
        let d0 = 0, d1 = 0, d2 = 0
        for (let y = S + by * B; y < S + by * B + B; y++) for (let x = S + bx * B; x < S + bx * B + B; x++) {
          const i = (y * w + x) * 4, j = ((y + sy) * w + x + sx) * 4
          d0 += ia.data[i]! - ib.data[j]!; d1 += ia.data[i + 1]! - ib.data[j + 1]!; d2 += ia.data[i + 2]! - ib.data[j + 2]!
        }
        if ((Math.abs(d0) + Math.abs(d1) + Math.abs(d2)) / (B * B) > 36) changed++
      }
      best = Math.min(best, changed / (bw * bh))
    }
    return best
  }, [a.toString("base64"), b.toString("base64")])
}

const report: Record<string, unknown> = { viewport: [vw, vh], scenes: {} as Record<string, unknown> }
const failures: string[] = []
function judge(name: string, snaps: Record<Phase, Snap>, diff: number, extra: Record<string, unknown> = {}) {
  const { before, inside, after } = snaps
  const problems: string[] = []
  if (!inside.inside) problems.push("never got inside")
  if (after.inside) problems.push("never got back out")
  if (after.streamed !== before.streamed) problems.push(`level path changed (${before.streamed ? "streamed" : "origin build"} -> ${after.streamed ? "streamed" : "origin build"})`)
  if (after.vertices < before.vertices * 0.98) problems.push(`level vertices dropped ${before.vertices} -> ${after.vertices}`)
  if (after.drawn < before.drawn) problems.push(`drawn level chunks dropped ${before.drawn} -> ${after.drawn}`)
  if (diff > 0.06) problems.push(`porch frame changed ${(diff * 100).toFixed(1)}%`)
  ;(report.scenes as Record<string, unknown>)[name] = { ...snaps, beforeAfterDiff: +diff.toFixed(4), problems, ...extra }
  console.log(name, problems.length ? `FAIL: ${problems.join("; ")}` : "ok", JSON.stringify({ diff: +diff.toFixed(4), before: [before.streamed, before.vertices, before.drawn, before.view], inside: [inside.streamed, inside.vertices, inside.drawn, inside.view], after: [after.streamed, after.vertices, after.drawn] }))
  for (const p of problems) failures.push(`${name}: ${p}`)
}

const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
try {
  if (!coopMode) await solo()
  else await coop()
} finally {
  writeFileSync(resolve(out, "report.json"), JSON.stringify(report, null, 2))
  await browser.close()
}
console.log(out)
if (failures.length) {
  console.error(failures.join("\n"))
  process.exit(1)
}

async function solo() {
  const root = resolve(game, "dist/arcade/outbreak")
  const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const path = new URL(req.url).pathname
    const file = Bun.file(resolve(root, `.${path === "/" ? "/index.html" : path}`))
    return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 })
  } })
  // A streamed house a few chunks east of the origin block, from the same deterministic generator the game uses.
  let streamed: { x: number; y: number } | null = null
  for (let cx = 4; cx < 9 && !streamed; cx++) for (const cy of [1, 2, 0]) {
    const b = generateWorldChunk(7, 7, cx, cy, "streaming").buildings.find(b => b.kind === "house")
    if (b) { streamed = { x: (b.rect[0] + b.rect[2]) / 2, y: b.rect[3] + 3 }; break }
  }
  assert(streamed)
  try {
    const page = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1 })
    const errors: string[] = []
    page.on("pageerror", e => errors.push(e.message))
    page.on("console", m => { if (m.type() === "error") errors.push(m.text()) })
    await page.goto(`http://127.0.0.1:${fixture.port}/?solo&seed=7&bench&peaceful=1`)
    await page.waitForFunction(() => (window as any).__arcadeHarness?.ready)
    for (const scene of [{ name: "solo-ash-fresh", spawn: true, x: 0, y: 0 }, { name: "solo-ash-reset", x: 27.7, y: 38 }, { name: "solo-streamed", ...streamed }]) {
      await soloVisit(page, scene.name, scene)
    }
    report.soloErrors = errors
    if (errors.length) failures.push(...errors.slice(0, 5).map(e => `solo page error: ${e}`))
    await page.close()
  } finally {
    fixture.stop()
  }
}

async function soloVisit(page: Page, name: string, start: { x: number; y: number; spawn?: boolean }) {
  const door = await page.evaluate(async s => {
    const h = (window as any).__arcadeHarness
    // The fresh scene keeps the page's own first level (the origin build at spawn) instead of a reset.
    if (!s.spawn) h.reset(7)
    h.setLab("timeScale", 0)
    h.setLab("hour", 22)
    if (s.spawn) { const p = h.state().player; s.x = p.x; s.y = p.y } else h.pose(s.x, s.y, -Math.PI / 2)
    const t0 = performance.now()
    while (performance.now() - t0 < 8000) {
      await h.step()
      if (h.state().world.pendingBakes === 0 && performance.now() - t0 > 600) break
      await new Promise(r => setTimeout(r, 20))
    }
    // Nearest south-facing front door.
    const town = h.session().view.town
    let best: { x: number; y: number; d: number } | null = null
    for (const d of town.doors) {
      const [x0, y0, x1, y1] = d.rect
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2
      if (x1 - x0 < y1 - y0) continue
      if (!town.buildings.some((b: { rect: number[] }) => cx > b.rect[0] && cx < b.rect[2] && Math.abs(cy - b.rect[3]) < 0.5)) continue
      const dist = Math.hypot(cx - s.x, cy - s.y)
      if (!best || dist < best.d) best = { x: cx, y: cy, d: dist }
    }
    return best
  }, start)
  assert(door, `${name}: no front door near ${JSON.stringify(start)}`)
  const walk = (tx: number, ty: number, frames: number) => page.evaluate(async a => {
    const h = (window as any).__arcadeHarness
    for (let i = 0; i < a.frames; i++) {
      const p = h.state().player
      const dx = a.tx - p.x, dy = a.ty - p.y, len = Math.hypot(dx, dy)
      if (len < 0.12) break
      const label = h.session().view.prompt?.primary?.label
      // Streamed chunks bring their own zombies even when peaceful; keep them out of the comparison.
      h.session().ai.agents.length = 0
      await h.step(1 / 60, { mx: dx / len, my: dy / len, aim: Math.atan2(dy, dx), interact: label === "Open" && i % 20 === 0 })
    }
  }, { tx, ty, frames })
  const porch = { x: door.x, y: door.y + 2.2 }
  const settleAtPorch = () => page.evaluate(async p => {
    const h = (window as any).__arcadeHarness
    h.pose(p.x, p.y, -Math.PI / 2)
    const player = h.session().view.player
    for (let i = 0; i < 150; i++) {
      h.session().ai.agents.length = 0
      player.health = player.maxHealth
      await h.step()
    }
  }, porch)
  const snaps = {} as Record<Phase, Snap>
  const shots = {} as Record<Phase, Buffer>
  // The fresh scene walks up from spawn so nothing but walking happens before the first frame.
  if (start.spawn) await walk(porch.x, porch.y, 1500)
  await settleAtPorch()
  snaps.before = await snap(page)
  shots.before = await shot(page, resolve(out, `${name}-before.png`), true)
  // In, then along the hall so the camera pans across the house the way a player looks around.
  await walk(door.x, door.y - 2.4, 600)
  await walk(door.x - 3.6, door.y - 2.4, 400)
  for (let i = 0; i < 10; i++) await page.evaluate(() => (window as any).__arcadeHarness.step())
  snaps.inside = await snap(page)
  shots.inside = await shot(page, resolve(out, `${name}-inside.png`), true)
  await walk(door.x, door.y - 2.4, 400)
  await walk(porch.x, porch.y, 600)
  // Same porch pose and aim as the first frame (the level path and geometry are whatever the visit left behind).
  await settleAtPorch()
  snaps.after = await snap(page)
  shots.after = await shot(page, resolve(out, `${name}-after.png`), true)
  judge(name, snaps, await pixelDiff(page, shots.before, shots.after), { door })
}

async function coop() {
  const port = 8800 + Math.floor(Math.random() * 400)
  const dev = Bun.spawn(["bunx", "--no-install", "wrangler", "dev", "--port", String(port), "--ip", "127.0.0.1", "--log-level", "warn"], { cwd: game, stdout: "pipe", stderr: "pipe" })
  const base = `http://127.0.0.1:${port}/arcade/outbreak/`
  try {
    const end = Date.now() + 60000
    for (;;) {
      try { if ((await fetch(base)).ok) break } catch {}
      if (Date.now() > end) throw new Error("wrangler dev did not start")
      await new Promise(r => setTimeout(r, 300))
    }
    const room = `f${randomRoomCode(undefined, Math.random, 5)}`
    const pages: Page[] = []
    const errors: string[] = []
    for (const [name, size] of [["Ann", { width: vw, height: vh }], ["Bob", { width: 900, height: 600 }]] as const) {
      const context = await browser.newContext({ viewport: size, deviceScaleFactor: 1 })
      const page = await context.newPage()
      page.on("pageerror", e => errors.push(`${name}: ${e.message}`))
      page.on("console", m => { if (m.type() === "error") errors.push(`${name}: ${m.text()}`) })
      await page.goto(`${base}?room=${room}&name=${name}&peaceful=1`, { waitUntil: "load" })
      await page.waitForFunction(() => (window as any).__arcadeHarness?.ready, null, { timeout: 30000 })
      pages.push(page)
    }
    const [a] = pages as [Page, Page]
    const coopState = () => a.evaluate(() => (window as any).__arcadeHarness.coop())
    const until = async (what: string, test: () => Promise<boolean>, ms = 15000) => {
      const end = Date.now() + ms
      while (!(await test())) {
        if (Date.now() > end) throw new Error(`timed out: ${what}`)
        await new Promise(r => setTimeout(r, 50))
      }
    }
    await until("both connected", async () => { const c = await coopState(); return c.connected && c.roster.length === 2 })
    const hold = async (key: string, what: string, test: (p: { x: number; y: number }) => boolean, ms = 6000) => {
      await a.keyboard.down(key)
      try { await until(what, async () => test((await coopState()).local), ms) } finally { await a.keyboard.up(key) }
    }
    await a.bringToFront()
    // The cursor sits above the survivor for every capture so the aim (and flashlight) match.
    await a.mouse.click(vw / 2, vh * 0.3)
    await hold("KeyW", "Ann at the Ash porch", p => p.y < 37.9)
    await a.waitForTimeout(1500)
    const snaps = {} as Record<Phase, Snap>
    const shots = {} as Record<Phase, Buffer>
    snaps.before = await snap(a)
    shots.before = await shot(a, resolve(out, "coop-ash-before.png"), false)
    const porch = snaps.before.player
    await hold("KeyW", "Ann at the door", p => p.y < 36.6)
    await a.waitForTimeout(250)
    await a.keyboard.press("KeyE")
    await until("door open", async () => Boolean((await coopState()).doors.find((d: { id: string; open: boolean }) => d.id === "ash-front")?.open))
    await hold("KeyW", "Ann inside", p => p.y < 33.2)
    await hold("KeyA", "Ann down the hall", p => p.x < porch.x - 1.8)
    await a.waitForTimeout(1200)
    snaps.inside = await snap(a)
    shots.inside = await shot(a, resolve(out, "coop-ash-inside.png"), false)
    await hold("KeyD", "Ann back at the door line", p => p.x > porch.x - 0.05)
    await hold("KeyS", "Ann back on the porch", p => p.y > porch.y - 0.05)
    await a.waitForTimeout(1500)
    snaps.after = await snap(a)
    shots.after = await shot(a, resolve(out, "coop-ash-after.png"), false)
    judge("coop-ash", snaps, await pixelDiff(a, shots.before, shots.after), { room })
    report.coopErrors = errors
    if (errors.length) failures.push(...errors.slice(0, 5).map(e => `coop page error: ${e}`))
  } finally {
    dev.kill()
    await dev.exited
  }
}
