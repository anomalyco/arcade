// Regression capture: walls stop light even while the cutaway draws them as stubs. For houses at the origin and in a
// streamed chunk, the survivor stands indoors facing an outer wall at night; the ground just beyond the wall must not
// brighten when the flashlight turns on. Then through an open outer door, where it must. Headless Metal Chromium, no
// audio. Writes captures/outbreak-wall-light/<WALL_PHASE>/ (screenshots, probes.json) and exits non-zero on a leak.
//   WALL_PHASE=after WALL_SKIP_BUILD=1 WALL_LAB='{"beamQuality":3}' WALL_QUALITY=low bun scripts/wall-light-proof.ts
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { browserBudget } from "../../../scripts/browser-budget"

await using budget = browserBudget()
const { chromium } = budget

const game = resolve(import.meta.dir, "..")
const phase = process.env.WALL_PHASE ?? "after"
const lab: Record<string, number> = JSON.parse(process.env.WALL_LAB ?? "{}")
const enforce = process.env.WALL_ENFORCE !== "0"
// Optional quality tier (high, balanced, low); default auto.
const quality = process.env.WALL_QUALITY ?? ""
const out = resolve(process.env.WALL_OUT ?? resolve(game, "../../captures/outbreak-wall-light"), phase)
mkdirSync(out, { recursive: true })
if (process.env.WALL_SKIP_BUILD !== "1") assert.equal(Bun.spawnSync(["bun", "run", "build"], { cwd: game, stdout: "inherit", stderr: "inherit" }).exitCode, 0)
const root = resolve(game, "dist/arcade/outbreak")
const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  const path = new URL(req.url).pathname
  const file = Bun.file(resolve(root, `.${path === "/" ? "/index.html" : path}`))
  return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 })
} })
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const chrome = readdirSync(cache).filter(n => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse().map(n => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`).find(existsSync)
assert(chrome)

type Rect = [number, number, number, number]
/** A pose indoors facing one outer wall (or an open outer door) and the plan points just beyond it. */
type Case = { name: string; kind: "wall" | "door" | "window" | "open-window"; x: number; y: number; aim: number; outside: [number, number][]; door?: Rect; window?: Rect }

const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const results: Record<string, unknown>[] = []
let failures = 0
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 680 }, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("pageerror", e => errors.push(e.message))
  await page.goto(`http://127.0.0.1:${fixture.port}/?solo&seed=7&bench&peaceful=1`)
  await page.waitForFunction(() => (window as any).__arcadeHarness?.ready)
  await page.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLElement>("body > *:not(#game)")) el.style.visibility = "hidden"
  })

  // Origin houses first, then a house in a chunk streamed in well away from the spawn window.
  for (const region of [{ label: "origin", at: null as [number, number] | null }, { label: "streamed", at: [150, 118] as [number, number] }]) {
    const cases: Case[] = await page.evaluate(async ({ region, lab, quality }) => {
      const h = (window as any).__arcadeHarness
      h.reset(7)
      if (quality) h.setQuality(quality)
      h.setLab("timeScale", 0); h.setLab("hour", 22); h.setLab("zoom", 34); h.setLab("zombieCount", 0)
      for (const [k, v] of Object.entries(lab)) h.setLab(k, v)
      if (region.at) {
        // Walk the window over in steps so chunks stream in as they would in play.
        const st0 = h.state().player
        for (let i = 1; i <= 8; i++) {
          h.pose(st0.x + ((region.at[0] - st0.x) * i) / 8, st0.y + ((region.at[1] - st0.y) * i) / 8, 0)
          for (let k = 0; k < 30; k++) await h.step()
        }
      }
      for (let k = 0; k < 30; k++) await h.step()
      const town = h.session().view.town
      const st = h.state()
      const walls: Rect[] = town.barriers.filter((b: any) => b.kind === "wall").map((b: any) => b.rect)
      const openings: Rect[] = [...town.doors.map((d: any) => d.rect), ...town.barriers.filter((b: any) => b.kind === "window").map((b: any) => b.rect)]
      const ray = (ox: number, oy: number, dx: number, dy: number, rects: Rect[], max: number) => {
        let best = max
        for (const r of rects) {
          let t0 = 0, t1 = max
          for (const [o, d, lo, hi] of [[ox, dx, r[0], r[2]], [oy, dy, r[1], r[3]]] as const) {
            if (Math.abs(d) < 1e-9) { if (o < lo || o > hi) { t0 = Infinity; break } continue }
            let a = (lo - o) / d, b = (hi - o) / d
            if (a > b) [a, b] = [b, a]
            t0 = Math.max(t0, a); t1 = Math.min(t1, b)
          }
          if (t0 <= t1 && t0 < best) best = t0
        }
        return best
      }
      const near = (x: number, y: number, rects: Rect[], m: number) => rects.some(r => x > r[0] - m && x < r[2] + m && y > r[1] - m && y < r[3] + m)
      const px = st.player.x, py = st.player.y
      const houses = st.world.windowBuildings
        .sort((a: any, b: any) => Math.hypot((a.rect[0] + a.rect[2]) / 2 - px, (a.rect[1] + a.rect[3]) / 2 - py) - Math.hypot((b.rect[0] + b.rect[2]) / 2 - px, (b.rect[1] + b.rect[3]) / 2 - py))
      const found: Case[] = []
      for (const b of houses.slice(0, 6)) {
        const r = b.rect as Rect
        // Each side: inward normal, outward aim, and samples along the wall.
        const sides = [
          { side: "S", aim: Math.PI / 2, along: (t: number) => [r[0] + t * (r[2] - r[0]), r[3] - 0.15] as const, out: [0, 1] },
          { side: "N", aim: -Math.PI / 2, along: (t: number) => [r[0] + t * (r[2] - r[0]), r[1] + 0.15] as const, out: [0, -1] },
          { side: "E", aim: 0, along: (t: number) => [r[2] - 0.15, r[1] + t * (r[3] - r[1])] as const, out: [1, 0] },
          { side: "W", aim: Math.PI, along: (t: number) => [r[0] + 0.15, r[1] + t * (r[3] - r[1])] as const, out: [-1, 0] },
        ]
        for (const s of sides) {
          for (const kind of ["wall", "door", "window", "open-window"] as const) {
            if (found.some(c => c.kind === kind && c.name.startsWith(`${region.label}-${b.id}`))) continue
            for (let t = 0.2; t <= 0.8; t += 0.05) {
              let [wx, wy] = s.along(t)
              const door = kind === "door" ? town.doors.find((d: any) => near(wx, wy, [d.rect], 0.4)) : null
              if (kind === "door" && !door) continue
              const win = kind === "window" || kind === "open-window" ? town.windows.find((w: any) => near(wx, wy, [w.rect], 0.3) && Math.min(w.rect[2] - w.rect[0], w.rect[3] - w.rect[1]) < 0.5) : null
              if ((kind === "window" || kind === "open-window") && !win) continue
              if (kind === "open-window" && !win.openable) continue
              if (kind === "wall" && near(wx, wy, openings, 1.6)) continue
              // Aim through the middle of a door or window.
              const gap: Rect | undefined = door?.rect ?? win?.rect
              if (gap) {
                if (s.side === "S" || s.side === "N") wx = (gap[0] + gap[2]) / 2
                else wy = (gap[1] + gap[3]) / 2
              }
              const [ox, oy] = s.out
              // Stand 1.3 m inside, with nothing solid between the survivor and the outer wall.
              const sx = wx - ox * 1.3, sy = wy - oy * 1.3
              if (near(sx, sy, walls, 0.45) || near(sx, sy, openings, 0.45)) continue
              const hit = ray(sx, sy, ox, oy, walls.concat(town.doors.map((d: any) => d.rect)), 3)
              if (Math.abs(hit - 1.3 + 0.15) > 0.35 && kind === "wall") continue
              if (kind !== "wall" && hit < 0.9) continue
              const outside: [number, number][] = []
              // Behind a north wall the camera sees the wall's own (lit) inner face first, so sample further out there.
              for (const d of s.side === "N" ? [2.6, 3.4, 4.2] : [1.0, 1.8, 2.6, 3.4]) for (const l of [-0.8, 0, 0.8]) outside.push([wx + ox * (0.15 + d) + oy * l, wy + oy * (0.15 + d) + ox * l])
              if (outside.some(([x, y]) => near(x, y, walls, 0.2))) continue
              found.push({ name: `${region.label}-${b.id}-${s.side}-${kind}`, kind, x: sx, y: sy, aim: s.aim, outside, door: door?.rect, window: win?.rect })
              break
            }
          }
        }
        if (found.filter(c => c.kind === "wall").length >= 3 && found.filter(c => c.kind === "window").length >= 2 && found.some(c => c.kind === "door") && found.some(c => c.kind === "open-window")) break
      }
      const take = (k: Case["kind"], n: number) => found.filter(c => c.kind === k).slice(0, n)
      ;(window as any).__wallLightDebug = { kinds: houses.map((b: any) => b.kind + "/" + b.archetype).join(","), houses: houses.length, buildings: st.world.windowBuildings.length, player: [px, py], found: found.length }
      return [...take("door", 1), ...take("open-window", 1), ...take("window", 2), ...take("wall", 3)]
    }, { region, lab, quality })
    console.log(region.label, JSON.stringify(await page.evaluate(() => (window as any).__wallLightDebug)))
    assert(cases.some(c => c.kind === "wall"), `no outer-wall case found (${region.label})`)

    for (const c of cases) {
      const shots: Record<string, number[]> = {}
      for (const light of ["off", "on"] as const) {
        const pts = await page.evaluate(async ({ c, light }) => {
          const h = (window as any).__arcadeHarness
          const s = h.session()
          const same = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]!) < 1e-3)
          if (c.door) for (const d of s.view.town.doors) if (same(d.rect, c.door)) { d.open = true; s.view.revision++ }
          if (c.window) for (const w of s.view.town.windows) if (same(w.rect, c.window) && w.open !== (c.kind === "open-window")) { w.open = c.kind === "open-window"; s.view.revision++ }
          h.pose(c.x, c.y, c.aim)
          s.view.player.flashlightOn = light === "on"
          s.view.player.flashlightOutput = light === "on" ? 1 : 0
          for (let i = 0; i < 20; i++) await h.step(1 / 60, { aim: c.aim })
          s.view.player.flashlightOn = light === "on"
          s.view.player.flashlightOutput = light === "on" ? 1 : 0
          await h.step(1 / 60, { aim: c.aim })
          const gy = 0.02
          return c.outside.map(([x, y]: [number, number]) => {
            const r = h.resolveTargetRect({ world: [x, gy, y] })
            return r ? [r.x + 42, r.y + 42] : [-1, -1]
          })
        }, { c, light })
        const file = resolve(out, `${c.name}-${light}.png`)
        await page.locator("#game").screenshot({ path: file })
        // Mean luminance of 9×9 patches around each projected outside point.
        const lums: number[] = []
        for (const [x, y] of pts as [number, number][]) {
          if (x < 5 || y < 5 || x > 995 || y > 675) continue
          const cmd = ["magick", file, "-crop", `9x9+${Math.round(x - 4)}+${Math.round(y - 4)}`, "+repage", "-colorspace", "Gray", "-format", "%[fx:mean*255]", "info:"]
          lums.push(Number(new TextDecoder().decode(Bun.spawnSync(cmd).stdout)))
        }
        shots[light] = lums
      }
      const off = shots.off!, on = shots.on!
      const gain = on.map((v, i) => v - off[i]!)
      const meanGain = gain.reduce((a, b) => a + b, 0) / Math.max(1, gain.length)
      const maxGain = Math.max(...gain)
      // A wall must keep the flashlight off the ground beyond it; an open door must let it through.
      // Allow a few 8-bit levels for the lens glare and the lit inner face showing over the stub.
      const ok = c.kind === "wall" || c.kind === "window" ? maxGain < 8 && meanGain < 2 : meanGain > 10
      if (!ok) failures++
      results.push({ ...c, off, on, meanGain: +meanGain.toFixed(2), maxGain: +maxGain.toFixed(2), ok })
      console.log(`${ok ? "ok  " : "FAIL"} ${c.name} mean +${meanGain.toFixed(1)} max +${maxGain.toFixed(1)} (8-bit luma beyond the ${c.kind})`)
    }
  }
  assert.deepEqual(errors, [])
} finally {
  await Bun.write(resolve(out, "probes.json"), JSON.stringify({ phase, lab, quality, results }, null, 1))
  await browser.close()
  fixture.stop(true)
}
console.log(`wrote ${out}`)
if (failures && enforce) {
  console.error(`${failures} wall-light case(s) failed`)
  await budget.exit(1)
}
