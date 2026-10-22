// Frame-by-frame evidence for HUD transitions. Each transition is triggered with the game frozen, then every running
// CSS transition and Web Animation is paused and stepped through in 1/60 s increments; at each step the script reads
// the tracked elements' boxes and effective opacity and saves a crop. A transition passes when no tracked element
// jumps (moves more than JUMP_PX, or more than a third of its total travel, in one frame) or pops (effective opacity
// changes by more than POP in one frame, or it appears or vanishes while visible). Frames become muted MP4 clips.
// Run from games/outbreak: hivemind run --kind browser -- bun scripts/hud-motion-proof.ts
// Env: HUD_OUT (folder), HUD_DPR (default 2), HUD_ONLY (comma list of transition names), HUD_REDUCED=1.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { type Page } from "playwright-core"
import { browserBudget } from "../../../scripts/browser-budget"
import { createServer } from "vite"

await using budget = browserBudget()
const { chromium } = budget

const root = resolve(import.meta.dir, "..")
const out = resolve(process.env.HUD_OUT ?? process.env.LEASE_OUT ?? resolve(root, "../../captures/hud-polish/motion"))
mkdirSync(out, { recursive: true })
const dpr = Number(process.env.HUD_DPR ?? 2)
const only = process.env.HUD_ONLY?.split(",")
const reduced = process.env.HUD_REDUCED === "1"
const FRAME_MS = 1000 / 60
const JUMP_PX = 10
const POP = 0.34

const server = await createServer({
  root,
  logLevel: "warn",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "hud-motion-hooks",
      enforce: "pre",
      transform(code, id) {
        if (id !== resolve(root, "src/main.ts")) return
        return code.replace("Object.assign(window, { __arcadeHarness: harness })", "Object.assign(window, { __arcadeHarness: Object.assign(harness, { inventoryHud, hud }) })")
      },
    },
  ],
})
await server.listen()
const port = (server.httpServer!.address() as { port: number }).port
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
assert(chrome, "Playwright Chromium binary not found")
const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"],
})

type Sample = { t: number; els: Record<string, { x: number; y: number; w: number; h: number; o: number } | null> }
type Issue = { t: number; el: string; kind: "jump" | "pop"; detail: string }
type Result = { name: string; caption: string; frames: number; issues: Issue[]; clip?: string; samples: Sample[] }
const results: Result[] = []

async function sim(page: Page, fn: string) {
  return page.evaluate((fn) => {
    const h = (window as any).__arcadeHarness
    const view = h.session().view
    return new Function("progression", "ledger", "view", "hud", "h", fn)(view.progression, view.progression.ledger, view, h.inventoryHud, h)
  }, fn)
}

async function step(page: Page, n = 1, command: Record<string, unknown> = {}) {
  await page.evaluate(
    async ({ n, command }) => {
      const h = (window as any).__arcadeHarness
      for (let i = 0; i < n; i++) await h.step(1 / 60, { aim: h.session().view.player.aim, ...command })
    },
    { n, command },
  )
}

async function stage(page: Page, s: { x: number; y: number; aim: number; hour?: number }) {
  await page.evaluate(async (s) => {
    const h = (window as any).__arcadeHarness
    h.freeze(true)
    h.reset(7)
    h.setLab("timeScale", 0)
    h.setLab("hour", s.hour ?? 17)
    h.setLab("zoom", 30)
    h.setLab("zombieCount", 0)
    h.inventoryHud.close()
    h.pose(s.x, s.y, s.aim)
    for (let i = 0; i < 4; i++) await h.step()
  }, s)
  await page.waitForTimeout(1200)
}

/** Samples `selectors` through every animation started by `trigger`, frame by frame. */
async function trace(page: Page, name: string, caption: string, trigger: () => Promise<void>, selectors: string[], crop: string, ms = 700) {
  await page.evaluate(() => {
    for (const a of document.getAnimations()) a.finish()
  })
  const rect = await page.evaluate((sel) => {
    const rs = sel.split(",").flatMap((s) => [...document.querySelectorAll(s.trim())]).map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0)
    if (!rs.length) return null
    const x = Math.min(...rs.map((r) => r.left))
    const y = Math.min(...rs.map((r) => r.top))
    return { x, y, w: Math.max(...rs.map((r) => r.right)) - x, h: Math.max(...rs.map((r) => r.bottom)) - y }
  }, crop)
  await trigger()
  await page.evaluate(() => {
    ;(window as any).__traceAnims = document.getAnimations()
    for (const a of (window as any).__traceAnims) a.pause()
  })
  const dir = resolve(out, name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const samples: Sample[] = []
  const frames = Math.ceil(ms / FRAME_MS) + 1
  let clip: { x: number; y: number; width: number; height: number } | null = null
  for (let i = 0; i < frames; i++) {
    const t = i * FRAME_MS
    const els = await page.evaluate(
      ({ t, selectors }) => {
        for (const a of (window as any).__traceAnims as Animation[]) a.currentTime = t
        const read = (e: Element) => {
          let o = 1
          for (let n: Element | null = e; n; n = n.parentElement) {
            const cs = getComputedStyle(n)
            if (cs.display === "none" || cs.visibility === "hidden" || (n as HTMLElement).hidden) return null
            o *= Number(cs.opacity)
          }
          const r = e.getBoundingClientRect()
          return { x: r.left, y: r.top, w: r.width, h: r.height, o }
        }
        const map: Record<string, { x: number; y: number; w: number; h: number; o: number } | null> = {}
        for (const sel of selectors) {
          document.querySelectorAll(sel).forEach((e, k) => {
            const id = (e as HTMLElement).dataset.item ?? (e as HTMLElement).dataset.slot ?? (e.id || String(k))
            map[`${sel}#${id}`] = read(e)
          })
        }
        return map
      },
      { t, selectors },
    )
    samples.push({ t, els })
    if (!clip) {
      const after = await page.evaluate((sel) => {
        const rs = sel.split(",").flatMap((s) => [...document.querySelectorAll(s.trim())]).map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0)
        if (!rs.length) return null
        const x = Math.min(...rs.map((r) => r.left))
        const y = Math.min(...rs.map((r) => r.top))
        return { x, y, w: Math.max(...rs.map((r) => r.right)) - x, h: Math.max(...rs.map((r) => r.bottom)) - y }
      }, crop)
      const vw = page.viewportSize()!
      const boxes = [rect, after].filter(Boolean) as { x: number; y: number; w: number; h: number }[]
      if (!boxes.length) boxes.push({ x: 120, y: 120, w: vw.width - 240, h: vw.height - 160 })
      const x0 = Math.max(0, Math.min(...boxes.map((b) => b.x)) - 120)
      const y0 = Math.max(0, Math.min(...boxes.map((b) => b.y)) - 120)
      const x1 = Math.min(vw.width, Math.max(...boxes.map((b) => b.x + b.w)) + 120)
      const y1 = Math.min(vw.height, Math.max(...boxes.map((b) => b.y + b.h)) + 40)
      clip = { x: Math.floor(x0), y: Math.floor(y0), width: Math.floor((x1 - x0) / 2) * 2, height: Math.floor((y1 - y0) / 2) * 2 }
    }
    const wantVideo = process.argv.includes("--video") || process.env.ARCADE_VIDEO === "1"
    if (wantVideo || i === 0 || i === Math.floor(frames / 2) || i === frames - 1) {
      await page.screenshot({ path: resolve(dir, `f${String(i).padStart(3, "0")}.png`), clip })
    }
  }
  await page.evaluate(() => {
    for (const a of (window as any).__traceAnims as Animation[]) a.finish()
  })
  const issues = analyse(samples)
  const wantVideo = process.argv.includes("--video") || process.env.ARCADE_VIDEO === "1"
  const mp4 = resolve(out, `${name}.mp4`)
  const ff = wantVideo
    ? spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", "60", "-i", resolve(dir, "f%03d.png"), "-vf", "tpad=stop_mode=clone:stop_duration=0.6,format=yuv420p", "-c:v", "libx264", "-crf", "16", "-an", mp4])
    : { status: 1 }
  results.push({ name, caption, frames, issues, clip: ff.status === 0 ? mp4 : undefined, samples })
  console.log(`${name}: ${frames} frames, ${issues.length} issues${issues.length ? `\n  ${issues.slice(0, 6).map((i) => `${i.kind} ${i.el} @${i.t.toFixed(0)}ms ${i.detail}`).join("\n  ")}` : ""}`)
}

function analyse(samples: Sample[]): Issue[] {
  const issues: Issue[] = []
  const ids = new Set(samples.flatMap((s) => Object.keys(s.els)))
  for (const id of ids) {
    const seq = samples.map((s) => s.els[id] ?? null)
    const first = seq.find(Boolean)
    const last = [...seq].reverse().find(Boolean)
    const travel = first && last ? Math.hypot(last.x - first.x, last.y - first.y) : 0
    for (let i = 1; i < seq.length; i++) {
      const a = seq[i - 1]
      const b = seq[i]
      const t = samples[i]!.t
      if (!a && b && b.o > 0.1) issues.push({ t, el: id, kind: "pop", detail: `appeared at opacity ${b.o.toFixed(2)}` })
      if (a && !b && a.o > 0.1) issues.push({ t, el: id, kind: "pop", detail: `vanished from opacity ${a.o.toFixed(2)}` })
      if (!a || !b) continue
      const visible = Math.max(a.o, b.o) > 0.05
      if (visible && Math.abs(b.o - a.o) > POP) issues.push({ t, el: id, kind: "pop", detail: `opacity ${a.o.toFixed(2)} → ${b.o.toFixed(2)}` })
      const d = Math.hypot(b.x - a.x, b.y - a.y)
      if (visible && d > JUMP_PX && d > travel / 3) issues.push({ t, el: id, kind: "jump", detail: `${d.toFixed(1)} px of ${travel.toFixed(1)} px travel` })
      const dw = Math.abs(b.w - a.w) + Math.abs(b.h - a.h)
      if (visible && dw > JUMP_PX * 2 && dw > (Math.abs(last!.w - first!.w) + Math.abs(last!.h - first!.h)) / 2) issues.push({ t, el: id, kind: "jump", detail: `size changed ${dw.toFixed(1)} px in one frame` })
    }
  }
  return issues
}

const want = (name: string) => !only || only.includes(name)

/** Stands next to the first ordinary door whose prompt shows. */
async function faceDoor(page: Page) {
  const spots = (await sim(page, `return view.town.doors.filter((d) => !d.keyed && !d.lockedBy && d.id !== "hardware-room").slice(0, 24).map((o) => ({ x: (o.rect[0] + o.rect[2]) / 2, y: (o.rect[1] + o.rect[3]) / 2 }))`)) as { x: number; y: number }[]
  for (const c of spots) {
    for (const [dx, dy] of [[0, 0.75], [0, -0.75], [0.75, 0], [-0.75, 0]] as const) {
      await stage(page, { x: c.x + dx, y: c.y + dy, aim: Math.atan2(-dy, -dx) })
      await step(page, 2)
      if ((await sim(page, `return view.prompt?.kind ?? null`)) === "door") return { x: c.x + dx, y: c.y + dy, aim: Math.atan2(-dy, -dx) }
    }
  }
  throw new Error("no door prompt found")
}

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: dpr, reducedMotion: reduced ? "reduce" : "no-preference" })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  await page.goto(`http://127.0.0.1:${port}/?seed=7&bench`)
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready, null, { timeout: 120_000 })
  await page.evaluate(() => {
    const h = (window as any).__arcadeHarness
    h.setLab("discoveryOpenContainers", false)
    h.setLab("discoveryGroundProps", false)
    h.setLab("discoveryFadeWords", false)
  })
  const kit = `for (const [item, n] of [["crowbar",1],["noisemaker",2],["toolbox",1],["chem",3],["scrap",4],["plank",3],["ammo",9],["battery",1]]) ledger.apply({ kind: "grant", actor: view.actorId, item, count: n })`
  const dockSel = ["#pack-sheet", "#pack-sheet .sheet-grid", "#dock", "#pack", "#belt .chip", "#hotbar .slot"]

  if (want("tab-open") || want("tab-close")) {
    await stage(page, { x: 44, y: 44, aim: 0 })
    await sim(page, kit)
    await step(page, 2)
    await page.waitForTimeout(1200)
    if (want("tab-open")) await trace(page, "tab-open", "Tab: the pack grows out of its chip", async () => (await sim(page, `hud.togglePack()`), await step(page, 1)), dockSel, "#dock, #pack-sheet")
    if (want("tab-close")) await trace(page, "tab-close", "Tab again: the pack folds back into its chip", async () => (await sim(page, `if (!hud.packOpen) hud.togglePack()`), await step(page, 1), await page.evaluate(() => document.getAnimations().forEach((a) => a.finish())), await sim(page, `hud.togglePack()`), await step(page, 1)), dockSel, "#dock, #pack-sheet")
  }

  if (want("tab-reverse")) {
    await stage(page, { x: 44, y: 44, aim: 0 })
    await sim(page, kit)
    await step(page, 2)
    await trace(
      page,
      "tab-reverse",
      "Tab twice quickly: the fold starts from wherever the open had reached",
      async () => {
        await sim(page, `hud.togglePack()`)
        await step(page, 1)
        await page.waitForTimeout(140)
        await sim(page, `hud.togglePack()`)
        await step(page, 1)
      },
      dockSel,
      "#dock, #pack-sheet",
    )
  }

  if (want("pickup")) {
    await stage(page, { x: 44, y: 44, aim: 0 })
    await sim(page, `ledger.apply({ kind: "grant", actor: view.actorId, item: "ammo", count: 4 })`)
    await step(page, 2)
    await page.waitForTimeout(1200)
    await trace(page, "pickup", "Picking up scrap and 6 rounds: the scrap chip slides in, the 9mm count rolls", async () => (await sim(page, `ledger.apply({ kind: "grant", actor: view.actorId, item: "ammo", count: 6 }); ledger.apply({ kind: "grant", actor: view.actorId, item: "scrap", count: 2 })`), await step(page, 1)), [...dockSel, "#belt .chip .roll-strip"], "#dock")
  }

  if (want("dim")) {
    await stage(page, { x: 44, y: 44, aim: 0 })
    await sim(page, kit)
    await step(page, 2)
    await page.waitForTimeout(3500)
    await trace(page, "dim", "Idle: the dock dims", async () => void (await step(page, 1)), ["#dock"], "#dock", 900)
    await trace(page, "brighten", "A change: the dock brightens", async () => (await sim(page, `ledger.apply({ kind: "grant", actor: view.actorId, item: "plank", count: 1 })`), await step(page, 1)), ["#dock"], "#dock", 400)
  }

  const promptSel = ["#prompt", "#prompt .prompt-face", "#prompt .akc"]
  if (want("prompt-appear") || want("prompt-change") || want("prompt-leave")) {
    const at = await faceDoor(page)
    if (want("prompt-appear")) {
      await sim(page, `h.pose(44, 44, 0)`)
      await step(page, 30)
      await page.waitForTimeout(600)
      await sim(page, `h.pose(${at.x}, ${at.y}, ${at.aim})`)
      await step(page, 30)
      await page.waitForTimeout(600)
      await sim(page, `h.pose(44, 44, 0)`)
      await step(page, 30)
      await page.waitForTimeout(600)
      await trace(page, "prompt-appear", "Walking up to a door: the prompt fades in", async () => (await sim(page, `h.pose(${at.x}, ${at.y}, ${at.aim})`), await step(page, 4)), promptSel, "#prompt", 500)
    }
    if (want("prompt-change")) await trace(page, "prompt-change", "Opening the door: Open becomes Close in place", async () => (await step(page, 1, { interact: true }), await step(page, 3)), promptSel, "#prompt", 600)
    if (want("prompt-leave")) await trace(page, "prompt-leave", "Walking away: the prompt fades out where it was", async () => (await sim(page, `h.pose(44, 44, 0)`), await step(page, 4)), promptSel, "#prompt", 500)
  }

  if (want("prompt-strip")) {
    const dresser = await sim(page, `const c = view.containers.find((x) => x.kind === "dresser" && x.buildingId === "ash"); return { id: c.id, x: c.x, y: c.y }`)
    await stage(page, { x: dresser.x, y: dresser.y + 0.75, aim: -Math.PI / 2 })
    await sim(page, `const st = ledger.store(${JSON.stringify(dresser.id)}); st.slots.fill(null); st.slots[0] = { item: "ammo", count: 6 }; st.slots[1] = { item: "medkit", count: 1 }; st.slots[2] = { item: "scrap", count: 2 }; st.revealed = false; st.rev = ++ledger.rev`)
    await step(page, 2)
    await step(page, 1, { interact: true })
    await step(page, 70)
    await page.waitForTimeout(800)
    await trace(page, "prompt-take", "Taking the first aid kit: the strip resizes around what is left", async () => (await step(page, 1, { pick: { mode: "take", index: 1 } }), await step(page, 2)), [...promptSel, "#prompt .item"], "#prompt", 600)
  }

  if (want("craft")) {
    await stage(page, { x: 44, y: 44, aim: 0, hour: 22 })
    await sim(page, `${kit}; ledger.apply({ kind: "grant", actor: view.actorId, item: "learned:bandage", store: "team/known" })`)
    await step(page, 2)
    await page.waitForTimeout(800)
    await trace(page, "craft-open", "Hold Q: field craft rises out of the dock", async () => (await sim(page, `hud.toggleCraft()`), await step(page, 1)), ["#craft", ...dockSel], "#craft, #dock", 600)
    await trace(page, "craft-close", "Release: field craft folds back down", async () => (await sim(page, `hud.close()`), await step(page, 1)), ["#craft", ...dockSel], "#craft, #dock", 400)
  }

  if (want("map")) {
    await stage(page, { x: 44, y: 44, aim: 0 })
    await trace(page, "map-open", "N: the map sheet settles in", async () => (await sim(page, `h.map.toggle()`), await step(page, 1)), [".obmap", ".obmap-sheet"], ".obmap-sheet", 600)
    await trace(page, "map-close", "N again: the sheet fades out", async () => (await sim(page, `h.map.toggle()`), await step(page, 1)), [".obmap", ".obmap-sheet"], ".obmap-sheet", 400)
  }

  if (want("vehicle")) {
    await page.evaluate(async () => {
      const h = (window as any).__arcadeHarness
      h.freeze(true)
      h.reset(7)
      h.setLab("timeScale", 0)
      h.inventoryHud.close()
      h.stageVehicle("driveway")
      for (let i = 0; i < 4; i++) await h.step(1 / 60, { mx: 0, my: 0 })
    })
    await page.waitForTimeout(800)
    await trace(page, "vehicle-enter", "Getting in: the prompt leaves and the gauge and key hints rise in", async () => (await step(page, 1, { interact: true }), await step(page, 3)), ["#vehicle-hud", "#vehicle-hud .vh-hint", "#prompt"], "#vehicle-hud, #dock", 600)
    await trace(page, "vehicle-learn", "Pressing H once: the Horn hint fades and the others close the gap", async () => (await page.keyboard.down("KeyH"), await page.keyboard.up("KeyH"), await step(page, 1)), ["#vehicle-hud .vh-hint"], "#vehicle-hud", 600)
  }

  assert.deepEqual(errors, [])
  writeFileSync(resolve(out, "index.json"), JSON.stringify({ dpr, reduced, results: results.map(({ samples: _s, ...r }) => r) }, null, 2))
  writeFileSync(resolve(out, "samples.json"), JSON.stringify(results.map((r) => ({ name: r.name, samples: r.samples }))))
  const failed = results.filter((r) => r.issues.length)
  console.log(`hud motion proof: ${results.length} transitions, ${failed.length} with issues, in ${out}`)
  if (process.env.HUD_STRICT === "1") assert.equal(failed.length, 0, `transitions with pops or jumps: ${failed.map((r) => r.name).join(", ")}`)
} finally {
  await browser.close()
  await server.close()
}
