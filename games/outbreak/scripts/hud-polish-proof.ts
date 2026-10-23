// Headless Metal stills of every HUD surface for the HUD design pass (AR-24): the bottom belt and hand slots, the
// pack, field craft, world prompts (door, window, container, strip, keyed door), the workbench, callouts and the
// ground ring, markers, a teammate, the map sheet and the vehicle HUD. Each surface is captured as a crop.
// Run from games/outbreak: hivemind run --kind browser -- bun scripts/hud-polish-proof.ts
// Env: HUD_OUT (folder), HUD_DPR (comma list, default 2), HUD_ONLY (comma list of surface names).
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { type Page } from "playwright-core"
import { browserBudget } from "../../../scripts/browser-budget"
import { createServer } from "vite"

await using budget = browserBudget()
const { chromium } = budget

const root = resolve(import.meta.dir, "..")
const out = resolve(process.env.HUD_OUT ?? process.env.LEASE_OUT ?? resolve(root, "../../captures/hud-polish/stills"))
mkdirSync(out, { recursive: true })
const dprs = (process.env.HUD_DPR ?? "2").split(",").map(Number)
const only = process.env.HUD_ONLY?.split(",")

const server = await createServer({
  root,
  logLevel: "warn",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "hud-polish-hooks",
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
const launch = () =>
  chromium.launch({
    executablePath: chrome,
    headless: true,
    args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"],
  })
let browser = await launch()

type Shot = { name: string; dpr: number; caption: string; file: string; crop?: string; rect?: { x: number; y: number; width: number; height: number }; offGrid?: { total: number; bad: string[] } }
const shots: Shot[] = []
const settle = (page: Page, ms = 900) => page.waitForTimeout(ms)

async function stage(page: Page, s: { x: number; y: number; aim: number; zoom?: number; hour?: number }) {
  await page.evaluate(async (s) => {
    const h = (window as any).__arcadeHarness
    h.freeze(true)
    h.reset(7)
    h.setLab("timeScale", 0)
    h.setLab("hour", s.hour ?? 17)
    h.setLab("zoom", s.zoom ?? 30)
    h.setLab("zombieCount", 0)
    h.inventoryHud.close()
    h.map?.close?.()
    h.pose(s.x, s.y, s.aim)
    for (let i = 0; i < 4; i++) await h.step()
  }, s)
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

async function sim(page: Page, fn: string) {
  return page.evaluate((fn) => {
    const h = (window as any).__arcadeHarness
    const view = h.session().view
    return new Function("progression", "ledger", "view", "hud", "h", fn)(view.progression, view.progression.ledger, view, h.inventoryHud, h)
  }, fn)
}

/** Stands next to the first opening of `kind` whose prompt shows from one of four sides. */
async function faceOpening(page: Page, kind: "door" | "window", keyed = false) {
  const spots = (await sim(
    page,
    `const list = ${JSON.stringify(kind)} === "door" ? view.town.doors.filter((d) => ${keyed} ? d.id === "hardware-room" : !d.keyed && !d.lockedBy && d.id !== "hardware-room") : view.town.windows
     return list.slice(0, 24).map((o) => ({ x: (o.rect[0] + o.rect[2]) / 2, y: (o.rect[1] + o.rect[3]) / 2 }))`,
  )) as { x: number; y: number }[]
  for (const c of spots) {
    for (const [dx, dy] of [[0, 0.75], [0, -0.75], [0.75, 0], [-0.75, 0]] as const) {
      await stage(page, { x: c.x + dx, y: c.y + dy, aim: Math.atan2(-dy, -dx) })
      await step(page, 2)
      const k = await sim(page, `return view.prompt?.kind ?? null`)
      if (k === kind) return true
    }
  }
  return false
}

async function snap(page: Page, name: string, dpr: number, caption: string, selector: string | null, pad = 16) {
  await settle(page)
  // One more drawn frame after motion settles, as the live game would draw (HUD pixel snapping runs per frame).
  await page.evaluate(() => (window as any).__arcadeHarness.step())
  await page.waitForTimeout(50)
  const file = resolve(out, `${name}@${dpr}x.png`)
  await page.screenshot({ path: file })
  const shot: Shot = { name, dpr, caption, file }
  if (selector) {
    const rect = await page.evaluate((sel) => {
      const els = sel.split(",").flatMap((s) => [...document.querySelectorAll(s.trim())])
      const shown = els.filter((e) => !(e as HTMLElement).hidden && getComputedStyle(e).display !== "none" && Number(getComputedStyle(e).opacity) > 0.01)
      const rs = shown.map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0)
      if (!rs.length) return null
      const x = Math.min(...rs.map((r) => r.left))
      const y = Math.min(...rs.map((r) => r.top))
      return { x, y, width: Math.max(...rs.map((r) => r.right)) - x, height: Math.max(...rs.map((r) => r.bottom)) - y }
    }, selector)
    // Crisp text: each surface's box starts on a whole device pixel, and every line of text in it sits on a whole
    // device-pixel row. (Glyphs are positioned horizontally at subpixel precision anyway, so inline x is not checked.)
    shot.offGrid = await page.evaluate(
      ({ sel, dpr }) => {
        const on = (v: number) => Math.abs(v * dpr - Math.round(v * dpr)) <= 0.05
        const visible = (e: Element) => {
          for (let n: Element | null = e; n; n = n.parentElement) if (getComputedStyle(n).opacity === "0" || (n as HTMLElement).hidden) return false
          return true
        }
        const roots = sel.split(",").flatMap((s) => [...document.querySelectorAll(s.trim())]).filter(visible)
        const bad: string[] = []
        let total = 0
        for (const r of roots) {
          const b = r.getBoundingClientRect()
          if (b.width === 0 || !r.textContent?.trim()) continue
          total++
          if (!on(b.left) || !on(b.top)) bad.push(`surface ${r.id || String(r.className)}: ${(b.left * dpr).toFixed(2)},${(b.top * dpr).toFixed(2)}`)
          const walker = document.createTreeWalker(r, NodeFilter.SHOW_TEXT)
          const seen = new Set<Element>()
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const el = n.parentElement
            if (!el || seen.has(el) || !n.textContent?.trim() || !visible(el)) continue
            seen.add(el)
            if (el.closest(".roll-reel")) continue
            const t = el.getBoundingClientRect()
            if (t.width === 0) continue
            total++
            if (!on(t.top)) bad.push(`${el.className || el.tagName}:"${n.textContent.trim().slice(0, 12)}" y ${(t.top * dpr).toFixed(2)}`)
          }
        }
        return { total, bad }
      },
      { sel: selector, dpr },
    )
    if (rect) {
      const vw = page.viewportSize()!
      const clip = { x: Math.max(0, rect.x - pad), y: Math.max(0, rect.y - pad), width: 0, height: 0 }
      clip.width = Math.min(vw.width - clip.x, rect.width + pad * 2)
      clip.height = Math.min(vw.height - clip.y, rect.height + pad * 2)
      shot.crop = resolve(out, `${name}@${dpr}x-crop.png`)
      shot.rect = rect
      await page.screenshot({ path: shot.crop, clip })
    }
  }
  shots.push(shot)
}

const want = (name: string) => !only || only.includes(name)

try {
  for (const dpr of dprs) {
    // A fresh browser per pixel ratio: a second WebGPU page in one headless Metal browser has crashed it.
    if (dpr !== dprs[0]) browser = await launch()
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: dpr })
    const errors: string[] = []
    page.on("pageerror", (e) => errors.push(e.message))
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text())
    })
    await page.goto(`http://127.0.0.1:${port}/?seed=7&bench`)
    await page.waitForFunction(() => (window as any).__arcadeHarness?.ready, null, { timeout: 120_000 })
    await page.evaluate(() => {
      const h = (window as any).__arcadeHarness
      h.setLab("discoveryOpenContainers", false)
      h.setLab("discoveryGroundProps", false)
      h.setLab("discoveryFadeWords", false)
    })
    const kit = `for (const [item, n] of [["crowbar",1],["noisemaker",2],["toolbox",1],["chem",3],["scrap",4],["plank",3],["ammo",18],["battery",1],["medkit",1]]) ledger.apply({ kind: "grant", actor: view.actorId, item, count: n })`

    if (want("dock")) {
      await stage(page, { x: 44, y: 44, aim: 0 })
      await sim(page, kit)
      await step(page, 2)
      await snap(page, "dock-active", dpr, "Belt and hand slots right after a change", "#dock")
      await page.waitForTimeout(4200)
      await step(page, 1)
      await snap(page, "dock-idle", dpr, "Belt and hand slots after a few idle seconds", "#dock")
      await sim(page, `hud.togglePack()`)
      await step(page, 2)
      await snap(page, "pack-open", dpr, "Tab: the pack open", "#dock, #pack-sheet")
      await sim(page, `hud.close()`)
      await step(page, 2)
      await snap(page, "pack-closed", dpr, "Tab again: the pack closed", "#dock")
    }

    if (want("craft")) {
      await stage(page, { x: 44, y: 44, aim: 0, hour: 22 })
      await sim(page, `${kit}; ledger.apply({ kind: "grant", actor: view.actorId, item: "learned:bandage", store: "team/known" }); ledger.apply({ kind: "grant", actor: view.actorId, item: "learned:lure", store: "team/known" }); if (!hud.craftOpen) hud.toggleCraft()`)
      await step(page, 2)
      await snap(page, "field-craft", dpr, "Hold Q: field craft", "#craft")
    }

    if (want("door") && (await faceOpening(page, "door"))) await snap(page, "prompt-door", dpr, "Door prompt: tap E and hold E", "#prompt", 24)
    if (want("door")) {
      await step(page, 1, { interactHeld: true })
      await step(page, 10, { interactHeld: true })
      await snap(page, "prompt-door-hold", dpr, "Door prompt while holding E", "#prompt", 24)
    }
    if (want("window") && (await faceOpening(page, "window"))) await snap(page, "prompt-window", dpr, "Window prompt", "#prompt", 24)
    if (want("keyed") && (await faceOpening(page, "door", true))) {
      await sim(page, `ledger.apply({ kind: "grant", actor: view.actorId, item: "crowbar" })`)
      await step(page, 2)
      await snap(page, "prompt-keyed", dpr, "Keyed door with a crowbar", "#prompt", 24)
    }

    if (want("container")) {
      const dresser = await sim(page, `const c = view.containers.find((x) => x.kind === "dresser" && x.buildingId === "ash"); return { id: c.id, x: c.x, y: c.y }`)
      await stage(page, { x: dresser.x, y: dresser.y + 0.75, aim: -Math.PI / 2 })
      await sim(page, `const st = ledger.store(${JSON.stringify(dresser.id)}); st.slots.fill(null); st.slots[0] = { item: "ammo", count: 6 }; st.slots[1] = { item: "medkit", count: 1 }; st.slots[2] = { item: "scrap", count: 2 }; st.revealed = false; st.rev = ++ledger.rev`)
      await step(page, 2)
      await snap(page, "prompt-search", dpr, "Unsearched container: E search, Shift+E smash", "#prompt", 24)
      await step(page, 1, { interact: true })
      await step(page, 30)
      await snap(page, "searching", dpr, "Search in progress", ".callout-body, #prompt", 40)
      await step(page, 60)
      await snap(page, "prompt-strip", dpr, "Searched: the strip of contents", "#prompt", 24)
    }

    if (want("bench")) {
      const bench = await sim(page, `const b = progression.benches[0]; return b ? { id: b.id, x: b.bench.x, y: b.bench.y } : null`)
      if (bench) {
        await stage(page, { x: bench.x - 0.85, y: bench.y, aim: 0, hour: 15 })
        await sim(page, `for (const [item, n] of [["scrap",6],["chem",3],["plank",3],["battery",1],["toolbox",1]]) ledger.apply({ kind: "grant", actor: view.actorId, item, count: n })`)
        await step(page, 1, { interact: true })
        await step(page, 4)
        await snap(page, "bench", dpr, "Workbench", "#prompt", 24)
      }
    }

    if (want("callouts")) {
      await stage(page, { x: 44, y: 44, aim: 0, zoom: 26 })
      await page.evaluate(() => {
        const h = (window as any).__arcadeHarness
        Object.assign(h.state().player, { stamina: 0.4, health: 62 })
        h.hud.demo(h.session().view.player)
      })
      await step(page, 6, { sprint: true, mx: 1 })
      await snap(page, "callouts-ring", dpr, "Callouts below the feet and the ground ring", ".callout-body, .ground-ring path, .vital", 40)
    }

    if (want("markers")) {
      await sim(page, `h.freeze(true); h.reset(7); h.setLab("timeScale", 0); h.setLab("zombieCount", 0); h.stageProgression("handoff")`)
      await step(page, 24)
      await snap(page, "markers", dpr, "Drop, ping and noisemaker markers", "#markers .marker", 40)
    }

    if (want("teammate")) {
      await stage(page, { x: 30.5, y: 40.5, aim: 0, zoom: 26 })
      await page.evaluate(() => {
        const h = (window as any).__arcadeHarness
        const s = h.session().sim
        const slot = s.slots.find((x: any) => x.id === "Wren") ?? s.addSurvivor("Wren", 1)
        Object.assign(slot.survivor, { x: 32.2, y: 41.2, aim: Math.PI, health: 64, flashlightOn: true, flashlightOutput: 1, reloadRemaining: 0.8 })
      })
      await step(page, 4)
      await snap(page, "teammate", dpr, "A teammate's name tag and rings", ".coop-tag, .vital", 50)
    }

    if (want("map")) {
      await stage(page, { x: 44, y: 44, aim: 0 })
      await page.evaluate(() => (window as any).__arcadeHarness.map.toggle())
      await step(page, 2)
      await snap(page, "map", dpr, "The map sheet", null)
      await page.evaluate(() => (window as any).__arcadeHarness.map.close())
    }

    if (want("vehicle")) {
      await page.evaluate(async () => {
        const h = (window as any).__arcadeHarness
        h.freeze(true)
        h.reset(7)
        h.setLab("timeScale", 0)
        h.inventoryHud.close()
        h.stageVehicle("night-headlights")
        for (let i = 0; i < 8; i++) await h.step(1 / 60, { mx: 0, my: 0 })
      })
      await snap(page, "vehicle", dpr, "Driving: the vehicle HUD", "#vehicle-hud, #dock", 16)
      if (process.env.HUD_DEBUG) console.log(await page.evaluate(() => { const e = document.querySelector<HTMLElement>("#vehicle-hud")!; const p = e.offsetParent as HTMLElement; return { tr: e.style.translate, ol: e.offsetLeft, ot: e.offsetTop, p: p?.id, pr: p?.getBoundingClientRect().toJSON(), r: e.getBoundingClientRect().toJSON(), anims: e.getAnimations().length } }))
      await page.evaluate(async () => {
        const h = (window as any).__arcadeHarness
        h.stageVehicle("driveway")
        for (let i = 0; i < 4; i++) await h.step(1 / 60, { mx: 0, my: 0 })
      })
      await snap(page, "vehicle-prompt", dpr, "Next to a car: the enter prompt", "#prompt", 24)
    }

    assert.deepEqual(errors, [], `page errors at ${dpr}x`)
    await browser.close()
  }
  // Merge with earlier runs into the same folder, so a partial run (HUD_ONLY) keeps the other surfaces' stills.
  const index = resolve(out, "index.json")
  const prior: Shot[] = existsSync(index) ? (JSON.parse(readFileSync(index, "utf8")).shots ?? []) : []
  const merged = [...prior.filter((p) => !shots.some((s) => s.name === p.name && s.dpr === p.dpr)), ...shots]
  writeFileSync(index, JSON.stringify({ shots: merged }, null, 2))
  for (const s of shots) if (s.offGrid) console.log(`${s.name}@${s.dpr}x: ${s.offGrid.total - s.offGrid.bad.length}/${s.offGrid.total} text boxes on the device-pixel grid${s.offGrid.bad.length ? `\n  ${s.offGrid.bad.slice(0, 4).join("\n  ")}` : ""}`)
  console.log(`hud-polish proof: ${shots.length} stills in ${out}`)
} finally {
  await browser.close()
  await server.close()
}
