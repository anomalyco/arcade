/**
 * Boot-to-ready timeline of a built Outbreak bundle, the way `scripts/smoke.mjs` loads it: when `#status` first shows,
 * when `window.__arcadeHarness` is set, main-thread long tasks, WebGPU pipeline/shader creation counts and their
 * synchronous JS cost, and optionally the main thread's top self-time functions from a CPU profile.
 *
 *   bun scripts/boot-profile.ts [--dist dist/arcade/outbreak]... [--gpu swiftshader|metal] [--runs 3] [--profile]
 *
 * Several `--dist` directories compare builds in one browser session (each run is a fresh browser). Headless and muted;
 * run it through `hivemind run --kind browser`. `--build <label>=<dir>` names a dist in the report.
 */
import { resolve, sep } from "node:path"
import { chromium, type CDPSession } from "playwright-core"

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(name)
const values = (name: string) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]!] : []))
const dists = [...values("--dist"), ...values("--build")].map((spec) => {
  const [label, dir] = spec.includes("=") ? (spec.split("=", 2) as [string, string]) : [spec, spec]
  return { label, root: resolve(dir) }
})
if (dists.length === 0) dists.push({ label: "dist", root: resolve("dist/arcade/outbreak") })
const gpus = values("--gpu").length ? values("--gpu") : ["swiftshader"]
const runs = Number(values("--runs")[0] ?? 3)
const profile = flag("--profile")
const prefix = "/arcade/outbreak/"

const INIT = `(() => {
  const boot = (window.__boot = { marks: {}, longTasks: [], gpu: {} });
  const mark = (name) => { if (boot.marks[name] === undefined) boot.marks[name] = Math.round(performance.now()) };
  let harness;
  Object.defineProperty(window, "__arcadeHarness", { configurable: true, get: () => harness, set: (v) => { harness = v; mark("ready") } });
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) boot.longTasks.push([Math.round(e.startTime), Math.round(e.duration)]) }).observe({ type: "longtask", buffered: true }) } catch {}
  document.addEventListener("DOMContentLoaded", () => {
    mark("dom");
    const status = document.querySelector("#status");
    if (status) new MutationObserver(() => { if (status.textContent) mark("status") }).observe(status, { childList: true, characterData: true, subtree: true });
  });
  const wrap = (proto, name) => {
    const fn = proto && proto[name];
    if (typeof fn !== "function") return;
    proto[name] = function (...a) {
      const t = performance.now();
      try { return fn.apply(this, a) } finally {
        const g = (boot.gpu[name] ??= { n: 0, ms: 0, first: Math.round(t) });
        g.n++; g.ms += performance.now() - t; g.last = Math.round(t);
      }
    };
  };
  if (typeof GPUDevice !== "undefined") {
    for (const n of ["createRenderPipeline", "createComputePipeline", "createRenderPipelineAsync", "createComputePipelineAsync", "createShaderModule", "createBuffer", "createTexture"]) wrap(GPUDevice.prototype, n);
    wrap(GPUQueue.prototype, "submit");
    wrap(GPUQueue.prototype, "writeBuffer");
  }
})()`

function serve(root: string) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (path === `${prefix}api/stats`) return Response.json({ players: 0, games: 0 })
      if (!path.startsWith(prefix)) return new Response("Not found", { status: 404 })
      const file = resolve(root, decodeURIComponent(path.slice(prefix.length)) || "index.html")
      if (!file.startsWith(root + sep)) return new Response("Not found", { status: 404 })
      const asset = Bun.file(file)
      return (await asset.exists()) ? new Response(asset) : new Response("Not found", { status: 404 })
    },
  })
}

type ProfileNode = { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] }
type CpuProfile = { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[] }

function topSelf(p: CpuProfile, n = 25) {
  const byId = new Map(p.nodes.map((node) => [node.id, node]))
  const self = new Map<string, number>()
  p.samples.forEach((id, i) => {
    const f = byId.get(id)!.callFrame
    const key = `${f.functionName || "(anon)"} ${f.url.split("/").pop()}:${f.lineNumber + 1}`
    self.set(key, (self.get(key) ?? 0) + (p.timeDeltas[i] ?? 0) / 1000)
  })
  return [...self].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, ms]) => `${ms.toFixed(0).padStart(6)} ms  ${k}`)
}

const results: Record<string, unknown>[] = []
for (const gpu of gpus) {
  const metal = gpu === "metal"
  const servers = dists.map((dist) => ({ dist, server: serve(dist.root) }))
  // Builds interleave within each round so machine load drifts evenly across them.
  for (let r = 0; r < runs; r++) {
    for (const { dist, server } of servers) {
      const browser = await chromium.launch({
        headless: true,
        args: metal
          ? ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"]
          : [
              "--enable-unsafe-webgpu", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
              "--enable-features=Vulkan", "--use-vulkan=swiftshader", "--mute-audio",
              ...(process.platform === "linux" ? ["--disable-vulkan-surface"] : []),
            ],
      })
      try {
        const page = await browser.newPage({ viewport: { width: 640, height: 360 } })
        await page.addInitScript(INIT)
        let cdp: CDPSession | undefined
        if (profile && r === 0) {
          cdp = await page.context().newCDPSession(page)
          await cdp.send("Profiler.enable")
          await cdp.send("Profiler.setSamplingInterval", { interval: 500 })
          await cdp.send("Profiler.start")
        }
        const wall = performance.now()
        await page.goto(`http://127.0.0.1:${server.port}${prefix}`, { waitUntil: "load", timeout: 60_000 }).catch(() => null)
        const load = Math.round(performance.now() - wall)
        const ready = await page
          .waitForFunction(() => (window as unknown as { __boot: { marks: { ready?: number } } }).__boot.marks.ready !== undefined, null, { timeout: 90_000, polling: 100 })
          .then(() => true, () => false)
        const boot = await page.evaluate(() => {
          const w = window as unknown as { __boot: { marks: Record<string, number> }; __arcadeHarness?: { renderer: unknown } }
          for (const m of performance.getEntriesByType("mark")) if (m.name.startsWith("outbreak:")) w.__boot.marks[m.name.slice(9)] = Math.round(m.startTime)
          // A private Renderer field: whether the material texture array loaded (not the neutral fallback).
          w.__boot.marks.texturesLoaded = Number((w.__arcadeHarness?.renderer as { texturesLoaded?: boolean } | undefined)?.texturesLoaded ?? -1)
          return w.__boot
        })
        const row: Record<string, unknown> = { build: dist.label, gpu, run: r + 1, ready, load, ...(boot as object) }
        if (cdp) {
          const { profile: p } = (await cdp.send("Profiler.stop")) as { profile: CpuProfile }
          row.topSelf = topSelf(p)
          const out = resolve(`.lab-output/boot-profile-${dist.label}-${gpu}.cpuprofile`)
          await Bun.write(out, JSON.stringify(p))
          row.cpuprofile = out
        }
        results.push(row)
        const b = boot as { marks: Record<string, number>; longTasks: [number, number][]; gpu: Record<string, { n: number; ms: number; first: number; last: number }> }
        console.log(`${dist.label} ${gpu} #${r + 1}: ${JSON.stringify(b.marks)} ready ${b.marks.ready ?? "TIMEOUT"} ms; long tasks ${JSON.stringify(b.longTasks.filter(([, d]) => d >= 200))}`)
        console.log(`  gpu ${Object.entries(b.gpu).map(([k, g]) => `${k} ${g.n}× ${g.ms.toFixed(0)}ms [${g.first}–${g.last}]`).join(" · ")}`)
        if (row.topSelf) console.log((row.topSelf as string[]).map((l) => `    ${l}`).join("\n"))
      } finally {
        await browser.close()
      }
    }
  }
  for (const { server } of servers) server.stop(true)
}
await Bun.write(resolve(".lab-output/boot-profile.json"), JSON.stringify(results, null, 2))
