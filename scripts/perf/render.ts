import { chromium } from "../../games/blackout/node_modules/playwright-core"
import { existsSync, mkdirSync, appendFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { gzipSync } from "node:zlib"

const root = join(import.meta.dir, "../..")
const output = join(root, "perf/proposals-data")
mkdirSync(output, { recursive: true })
const opt = (k: string, d: string) => process.argv.find(x => x.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
const game = opt("game", "getaway")
const scenario = opt("scenario", game)
const variants = opt("variants", "baseline").split(",")
const experiment = opt("experiment", "validated")
const repetitions = Number(opt("runs", "8"))
const frames = Number(opt("frames", "90"))
const cwd = join(root, "games", game)
const command = async (args: string[]) => {
  const p = Bun.spawn(args, { cwd, stdout: "ignore", stderr: "inherit" })
  if (await p.exited) throw Error(`Failed: ${args.join(" ")}`)
}
await command(["bun", "install", "--frozen-lockfile"])
// Vite production mode; names retained for readable CPU profiles. No dev server/HMR.
await command(["bun", "run", "build", "--minify=false", "--sourcemap"])
const reserve = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
const port = reserve.port!; reserve.stop(true)
const server = Bun.spawn(["bun", "x", "vite", "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd, stdout: "ignore", stderr: "inherit" })
const url = `http://localhost:${port}`
const executablePath = [chromium.executablePath(), ...["1243", "1234"].map(n => join(homedir(), `Library/Caches/ms-playwright/chromium-${n}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`))].find(existsSync)
const rows: any[] = []
const median = (xs: number[]) => [...xs].sort((a,b)=>a-b)[Math.floor(xs.length/2)]!
const summary = (xs: number[]) => ({ median: median(xs), mad: median(xs.map(x => Math.abs(x - median(xs)))), min: Math.min(...xs), max: Math.max(...xs), runs: xs })
try {
  const deadline = Date.now() + 15000
  while (!(await fetch(url).then(x => x.ok).catch(() => false))) {
    if (Date.now() > deadline || server.exitCode !== null) throw Error("Preview unavailable")
    await Bun.sleep(100)
  }
  const browser = await chromium.launch({ executablePath, headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist"] })
  try {
    for (let run = 0; run < repetitions; run++) for (const variant of run % 2 ? [...variants].reverse() : variants) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: variant === "dpr2" ? 2 : 1 })
      const page = await context.newPage()
      const errors: string[] = []
      page.on("pageerror", e => errors.push(e.message))
      page.on("console", e => { if (e.type() === "error") errors.push(e.text()) })
      await page.route("**/favicon.ico", route => route.fulfill({ status: 204 }))
      await page.addInitScript({ content: await Bun.file(join(import.meta.dir, "gpu-browser.js")).text() + `\nwindow.__measure.variant = ${JSON.stringify(variant)}` })
      await page.goto(url + (game === "getaway" ? "/?solo&bench&seed=7&proposalBench" : `/?practice&map=${scenario.includes("downtown") ? "downtown" : "office"}&proposalBench`))
      await page.waitForFunction("window.__proposal", undefined, { timeout: 60000, polling: 100 }).catch(e => { throw Error(`${e.message}; page errors: ${errors.join('; ')}`) })
      const step = async (count: number, start: number) => page.evaluate(async ({ count, start, game }) => {
        const w = window as any, p = w.__measure
        const cpu: number[] = [], uploads: number[] = [], bytes: number[] = [], lights: number[] = [], instances: number[] = []
        for (let i = 0; i < count; i++) {
          p.uploads.length = 0
          const t = performance.now()
          if (game === "getaway") await w.__getawayBench.step(start + i, 1/30, false)
          else { p.raf(); await Promise.resolve(); await Promise.resolve() }
          cpu.push(performance.now() - t)
          uploads.push(p.uploads.length); bytes.push(p.uploads.reduce((a: number,b: number)=>a+b,0))
          lights.push(p.lightCount ?? 0); instances.push(p.instances ?? 0)
          await p.device.queue.onSubmittedWorkDone(); await p.pending
        }
        return { cpu, uploads, bytes, lights, instances }
      }, { count, start, game })
      await page.evaluate(async (game) => {
        const w = window as any, hook = w.__proposal, p = w.__measure
        hook.telemetry.enabled = false
        p.calls = {}
        const wrap = (object: any, key: string, name: string) => {
          const original = object[key]
          object[key] = function (...args: any[]) {
            const t = performance.now()
            if (name === "Renderer.render" || name === "Renderer.draw") p.packStart = t
            const result = original.apply(this, args)
            if (p.enabled) (p.calls[name] ??= []).push(performance.now() - t)
            return result
          }
        }
        if (game === "getaway") {
          await w.__getawayBench.ready; w.__getawayBench.reset()
          wrap(hook.scene, "draw", "Scene.draw"); wrap(hook.scene, "animate", "Scene.animate")
          wrap(hook.renderer, "render", "Renderer.render")
          const render = hook.renderer.render.bind(hook.renderer)
          hook.renderer.render = (f: any) => { p.lightCount = f.frame[42]; p.instances = f.batches.reduce((n: number,b: any)=>n+b.count,0); render(f) }
        } else {
          const g = hook.game()
          wrap(g, "build", "Game.build"); wrap(g, "update", "Game.update"); wrap(g.culler, "update", "LightCuller.update"); wrap(hook.renderer, "draw", "Renderer.draw")
          const render = hook.renderer.render.bind(hook.renderer)
          hook.renderer.render = (f: any) => { p.lightCount = f.lightCount; p.shadowLights = f.shadowLightCount; p.occluders = f.occluderCount; p.instances = f.batches.reduce((n: number,b: any)=>n+b.count,0); render(f) }
        }
      }, game)
      if (scenario.includes("driving")) {
        await page.evaluate(() => {
          const w = window as any, world = w.practice, v = world.vehicles[0], human = world.players.get('you')
          human.x = v.x; human.y = v.y
          world.push('you',1,{mx:0,my:0,aim:0,fire:false,reload:false,sprint:false,equip:false,tx:0,ty:0,use:false,enter:true})
          world.step()
          if (human.veh !== v.id || human.seat !== 0) throw Error('Driving fixture did not enter the vehicle')
          w.__proposal.game().session.publish()
          w.__proposal.cam.snap(v.x,v.y)
          w.__measure.vehicleStart = { id:v.id,x:v.x,y:v.y }
        })
        await page.keyboard.down("KeyW")
      }
      await step(30, 0)
      await page.evaluate(() => { const p = (window as any).__measure; p.enabled = true; p.samples.length = 0; p.calls = {} })
      const profile = run === repetitions - 1 && variant === "baseline"
      const metrics = await step(frames, 30)
      const data = await page.evaluate(() => {
        const p = (window as any).__measure
        return { adapter: p.adapter, passes: p.samples, calls: p.calls, shadowLights: p.shadowLights, occluders: p.occluders, width: document.querySelector('canvas')!.width, height: document.querySelector('canvas')!.height, vehicles: (window as any).practice?.vehicles.length, vehicleStart:p.vehicleStart,vehicleEnd:p.vehicleStart ? (window as any).practice.vehicles.map((v:any)=>({id:v.id,x:v.x,y:v.y})) : undefined }
      })
      const cdp = await context.newCDPSession(page)
      const trace: any[] = []
      if (profile) {
        // CPU/allocation diagnostic excludes our per-pass logging and readbacks.
        await page.evaluate(() => { (window as any).__measure.enabled = false })
        await cdp.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval", { interval: 100 }); await cdp.send("Profiler.start")
        await cdp.send("HeapProfiler.startSampling", { samplingInterval: 16384, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true })
        cdp.on("Tracing.dataCollected", e => trace.push(...e.value))
        await cdp.send("Tracing.start", { categories: "v8,devtools.timeline,disabled-by-default-v8.gc", options: "record-as-much-as-possible" })
      }
      if (profile) {
        await step(1200, 30 + frames)
        const { profile: cpu } = await cdp.send("Profiler.stop")
        const { profile: heap } = await cdp.send("HeapProfiler.stopSampling")
        const complete = new Promise<void>(r => cdp.once("Tracing.tracingComplete", () => r()))
        await cdp.send("Tracing.end"); await complete
        writeFileSync(join(output, `${scenario}-cpu.json.gz`), gzipSync(JSON.stringify(cpu)))
        writeFileSync(join(output, `${scenario}-heap.json.gz`), gzipSync(JSON.stringify(heap)))
        writeFileSync(join(output, `${scenario}-trace.json.gz`), gzipSync(JSON.stringify({ traceEvents: trace })))
        const weights = new Map<number, number>()
        cpu.samples?.forEach((id: number,i: number) => weights.set(id, (weights.get(id) ?? 0) + (cpu.timeDeltas?.[i] ?? 0)))
        const hottest = cpu.nodes.map(n => ({ name: n.callFrame.functionName, line: n.callFrame.lineNumber, self_ms: (weights.get(n.id) ?? 0) / 1000 })).sort((a,b)=>b.self_ms-a.self_ms).slice(0,30)
        const alloc: Record<string,number> = {}
        const visit = (n: any) => { const name = n.callFrame.functionName || '(anonymous)'; alloc[name] = (alloc[name] ?? 0) + n.selfSize; n.children.forEach(visit) }; visit(heap.head)
        const gc = trace.filter(e => e.ph === "X" && /MinorGC|MajorGC/.test(e.name))
        writeFileSync(join(output, `${scenario}-profile-summary.json`), JSON.stringify({ frames:1200, hottest, sampled_allocations_bytes: Object.entries(alloc).sort((a,b)=>b[1]-a[1]).slice(0,30), gc: gc.map(e=>({ name:e.name, duration_ms:e.dur/1000 })), note: 'Separate 1200-frame diagnostic after final measured block, per-pass instrumentation disabled; CPU sampling includes GPU waits. Heap sampling includes collected objects; byte estimates are sampled, not exact.' }, null, 2))
      }
      if (errors.length) throw Error(errors.join("\n"))
      const partition = (passes: any[]) => {
        const label = (p: any,i: number) => p.kind === "compute" ? "polar" : p.depthOnly ? "shadow" : p.resolve ? "main-resolve" : i === passes.length - 1 ? "post" : "bloom"
        const spans = passes.map((p,i)=>({ name:label(p,i), start:p.range[0], end:p.range[1] }))
        if (spans.some(s => s.end < s.start)) throw Error('Invalid timestamp ordering')
        const edges = [...new Set(spans.flatMap(s => [s.start,s.end]))].sort((a,b)=>a-b)
        const result: Record<string,number> = { polar:0, shadow:0, 'main-resolve':0, bloom:0, post:0, overlap:0, gap:0, envelope:edges.at(-1)! - edges[0]!, union:0 }
        for (let i=1;i<edges.length;i++) {
          const left=edges[i-1]!,right=edges[i]!, active=spans.filter(s=>s.start<=left&&s.end>=right)
          const names=[...new Set(active.map(s=>s.name))]
          result[names.length === 0 ? 'gap' : names.length === 1 ? names[0]! : 'overlap']! += right-left
          if (names.length) result.union! += right-left
        }
        return result
      }
      const parts = data.passes.map(partition)
      const avg = (a: number[]) => a.reduce((n,x)=>n+x,0)/a.length
      const row = { scenario, variant, run, warmup:run===0, profiled:profile, metrics: Object.fromEntries(Object.entries(metrics).map(([k,v])=>[k, avg(v)])), gpu:Object.fromEntries(Object.keys(parts[0] ?? {}).map(k=>[k,avg(parts.map((p: any)=>p[k]))])), ...data }
      rows.push(row)
      console.log(JSON.stringify({ scenario, variant, run, metrics:row.metrics, gpu:row.gpu, samples:parts.length }))
      writeFileSync(join(output, `${scenario}-${experiment}-render.json.gz`), gzipSync(JSON.stringify(rows)))
      await context.close()
    }
  } finally { await browser.close() }
  for (const variant of variants) {
    const rs = rows.filter(r=>r.variant===variant&&!r.warmup)
    const record = { experiment:`proposals-render-${experiment}`, scenario, variant, warmup:1, measured:rs.length, timestamp:new Date().toISOString(), adapter:rs[0].adapter, gpu:Object.fromEntries(Object.keys(rs[0].gpu).map(k=>[k,summary(rs.map(r=>r.gpu[k]))])), cpu:Object.fromEntries(Object.keys(rs[0].metrics).map(k=>[k,summary(rs.map(r=>r.metrics[k]))])), calls:Object.fromEntries(Object.keys(rs[0].calls).map(k=>[k,summary(rs.map(r=>r.calls[k].reduce((n:number,x:number)=>n+x,0)/r.calls[k].length))])) }
    appendFileSync(join(root,"perf/results.jsonl"), JSON.stringify(record)+"\n")
  }
} finally { server.kill(); await server.exited }
