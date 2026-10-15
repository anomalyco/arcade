// GPU frame time per quality tier per game, and what Auto picks, on headless Metal (muted, no window).
// Serves each game's production build, opens a live scene at the given viewport and device scale with `?quality=<tier>`,
// warms up, then samples the game's hardware GPU timestamps (`globalThis.__quality.gpuMs()`), rAF intervals and canvas
// size. Auto runs longer and reports the tier, pixel ratio and resolution scale it settled on.
//
// Build first: bun run --cwd games/<game> build (for each game). Then, via the fleet:
//   hivemind run --kind browser -- bun scripts/bench-quality.ts [--games=brawl,blackout,getaway,carrier]
//     [--viewport=2560x1440] [--dpr=2] [--seconds=6] [--auto-seconds=14] [--json=out.json]
import { writeFileSync } from "node:fs"
import { resolve, sep } from "node:path"
import { chromium, type Browser } from "playwright-core"

const opt = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
const games = opt("games", "brawl,blackout,getaway,carrier").split(",")
const [vw = 2560, vh = 1440] = opt("viewport", "2560x1440").split("x").map(Number)
const dpr = Number(opt("dpr", "2"))
const seconds = Number(opt("seconds", "6"))
const autoSeconds = Number(opt("auto-seconds", "14"))
const jsonOut = opt("json", "")
const modes = opt("modes", "high,balanced,low,auto").split(",")

/** A live scene per game: bots, a sandbox, a solo chase, an offline sea. */
const SCENES: Record<string, string | undefined> = {
  brawl: "watch&bots=6&seed=3",
  blackout: "sandbox=1&seed=1",
  getaway: "solo",
  carrier: "seed=7",
}

const root = resolve(opt("root", resolve(import.meta.dir, "..")))

function serve(game: string) {
  const prefix = `/arcade/${game}/`
  const dist = resolve(root, `games/${game}/dist/arcade/${game}`)
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (path.startsWith(`${prefix}api/`)) return Response.json({ players: 0, games: 0, rooms: [] })
      if (!path.startsWith(prefix)) return new Response("Not found", { status: 404 })
      const file = resolve(dist, decodeURIComponent(path.slice(prefix.length)) || "index.html")
      if (!file.startsWith(dist + sep) && file !== dist) return new Response("Not found", { status: 404 })
      const asset = Bun.file(file)
      return (await asset.exists()) ? new Response(asset) : new Response("Not found", { status: 404 })
    },
  })
}

type QualityHook = { state(): { activeTier: string; pixelRatio: number; resolutionScale: number; adaptations: number; mode: string }; gpuMs(): number }

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b)
  return s.length ? s[s.length >> 1]! : 0
}
const pct = (v: number[], p: number) => {
  const s = [...v].sort((a, b) => a - b)
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))]! : 0
}
const r2 = (v: number) => Math.round(v * 100) / 100

async function measure(browser: Browser, game: string, port: number, mode: string) {
  const page = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: dpr })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  await page.goto(`http://127.0.0.1:${port}/arcade/${game}/?${SCENES[game] ?? ""}&quality=${mode}`)
  // Builds from before quality tiers have no hook: they still report frame times.
  await page.waitForFunction(() => typeof (globalThis as { __quality?: unknown }).__quality === "object", null, { timeout: 15_000 }).catch(() => undefined)
  const run = mode === "auto" ? autoSeconds : seconds
  const result = await page.evaluate(
    async ({ warm, run }) => {
      const none = { state: () => ({ activeTier: "-", pixelRatio: 0, resolutionScale: 0, adaptations: 0, mode: "-" }), gpuMs: () => 0 }
      const q = (globalThis as unknown as { __quality?: QualityHook }).__quality ?? none
      await new Promise((r) => setTimeout(r, warm * 1000))
      const gpu: number[] = []
      const frames: number[] = []
      let last = 0
      let lastGpu = -1
      const end = performance.now() + run * 1000
      await new Promise<void>((done) => {
        const tick = (now: number) => {
          if (last) frames.push(now - last)
          last = now
          const g = q.gpuMs()
          if (g > 0 && g !== lastGpu) gpu.push(g)
          lastGpu = g
          if (now < end) requestAnimationFrame(tick)
          else done()
        }
        requestAnimationFrame(tick)
      })
      const canvas = [...document.querySelectorAll("canvas")].sort((a, b) => b.width * b.height - a.width * a.height)[0]!
      return { gpu, frames, state: q.state(), canvas: [canvas.width, canvas.height] }
    },
    { warm: 4, run },
  )
  await page.close()
  return {
    game,
    mode,
    tier: result.state.activeTier,
    pixelRatio: result.state.pixelRatio,
    resolutionScale: result.state.resolutionScale,
    adaptations: result.state.adaptations,
    canvas: result.canvas.join("×"),
    gpuMedianMs: r2(median(result.gpu)),
    gpuP95Ms: r2(pct(result.gpu, 0.95)),
    gpuSamples: result.gpu.length,
    frameMedianMs: r2(median(result.frames)),
    frameP95Ms: r2(pct(result.frames, 0.95)),
    errors: errors.slice(0, 3),
  }
}

const browser = await chromium.launch({
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio", "--autoplay-policy=user-gesture-required"],
})
const rows: Awaited<ReturnType<typeof measure>>[] = []
try {
  for (const game of games) {
    const server = serve(game)
    for (const mode of modes) {
      const row = await measure(browser, game, server.port ?? 0, mode)
      rows.push(row)
      console.log(JSON.stringify(row))
    }
    server.stop(true)
  }
} finally {
  await browser.close()
}
console.log(`\n| Game | Mode | Tier | Canvas | GPU median ms | GPU p95 ms | Frame median ms |`)
console.log(`|---|---|---|---|---:|---:|---:|`)
for (const r of rows) {
  console.log(`| ${r.game} | ${r.mode} | ${r.tier}${r.mode === "auto" ? ` (scale ${r.resolutionScale})` : ""} | ${r.canvas} | ${r.gpuMedianMs} | ${r.gpuP95Ms} | ${r.frameMedianMs} |`)
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ viewport: [vw, vh], dpr, rows }, null, 2))
