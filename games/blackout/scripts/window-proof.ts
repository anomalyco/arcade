import { chromium } from "playwright-core"
import { mkdirSync, writeFileSync, unlinkSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { findChromeExecutable, installGpuInstrumentation } from "./compare"

const root = join(import.meta.dir, "../../.."), out = join(root, "captures/blackout-window")
mkdirSync(out, { recursive: true })
const baseline = join(root, "games/blackout/src/render/.window-baseline.ts")
const saved = join(import.meta.dir, "window-baseline.txt")
const old = existsSync(saved) ? readFileSync(saved) : Bun.spawnSync(["git", "show", "4479061:games/blackout/src/render/level-mesh.ts"], { cwd: root }).stdout
if (!old.length) throw new Error("Save git show 4479061:games/blackout/src/render/level-mesh.ts to scripts/window-baseline.txt first")
writeFileSync(baseline, old)
const reserve = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }), port = reserve.port!
reserve.stop(true)
const server = Bun.spawn(["bun", "x", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: join(root, "games/blackout"), stdout: "ignore", stderr: "inherit" })
const browser = await chromium.launch({ executablePath: findChromeExecutable(), headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--ignore-gpu-blocklist", "--mute-audio"] })
const report: any = { baseline: "4479061", views: [], errors: [] }
const costOnly = process.argv.includes("--cost-only")
try {
  const base = `http://localhost:${port}`, until = Date.now() + 15000
  while (!await fetch(base).then(r => r.ok).catch(() => false)) {
    if (Date.now() > until) throw new Error("Vite failed")
    await Bun.sleep(100)
  }
  for (const fixture of [{ name: "wood", seed: 2, x: 47.8, y: 24 }, { name: "blue", seed: 4, x: 46.5, y: 14 }]) {
    if (costOnly && fixture.name !== "wood") continue
    const poses: string[] = []
    for (const look of [false, true]) for (const motion of [false, true]) {
      if (costOnly && (!look || motion)) continue
      const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
      page.on("pageerror", e => report.errors.push(e.message))
      page.on("console", m => { if (m.type() === "error" && !m.location().url.endsWith("favicon.ico")) report.errors.push(m.text()) })
      await installGpuInstrumentation(page)
      await page.addInitScript(() => {
        const w = window as any
        w.__modules = new WeakMap(); w.__pipelines = new WeakMap()
        const module = GPUDevice.prototype.createShaderModule, pipe = GPUDevice.prototype.createRenderPipeline
        GPUDevice.prototype.createShaderModule = function(d) { const m = module.call(this, d); w.__modules.set(m, d); return m }
        GPUDevice.prototype.createRenderPipeline = function(d) { const p = pipe.call(this, d); w.__pipelines.set(p, d); return p }
      })
      await page.goto(`${base}/?sandbox=1&seed=${fixture.seed}&manualVideo=1`, { waitUntil: "networkidle" })
      await page.waitForFunction("window.__stepManualVideo && window.__gpuDevice")
      await page.evaluate(async ({ fixture, look, motion }) => {
        const w = window as any
        const gp = "/src/game/game.ts", rp = "/src/render/renderer.ts", bp = "/src/render/.window-baseline.ts", np = "/src/render/level-mesh.ts"
        const { Game } = await import(/* @vite-ignore */ gp), { Renderer } = await import(/* @vite-ignore */ rp)
        w.__oldBake = (await import(/* @vite-ignore */ bp)).bakeFloor
        w.__newBake = (await import(/* @vite-ignore */ np)).bakeFloor
        const build = Game.prototype.build, render = Renderer.prototype.render
        Game.prototype.build = function(cam: any, ...args: any[]) { w.__game = this; w.__cam = cam; return build.call(this, cam, ...args) }
        Renderer.prototype.render = function(f: any) { w.__renderer = this; w.__frame = f; render.call(this, f) }
        await w.__stepManualVideo(1000 / 60); await w.__gpuDevice.queue.onSubmittedWorkDone()
        const g = w.__game, cam = w.__cam
        g.sync({ x: fixture.x, y: fixture.y, vx: 0, vy: 0, aim: Math.PI / 2, tx: fixture.x, ty: fixture.y + 2 })
        cam.snap(fixture.x, fixture.y); cam.dist = 12; cam.follow = () => {}
        const host = document.querySelector<HTMLElement>("[data-lab]")!, controls = host.shadowRoot!
        for (const input of controls.querySelectorAll<HTMLInputElement>('input[type="checkbox"][data-key^="look"]')) {
          input.checked = input.dataset.key === "lookMotion" ? motion : look
          input.dispatchEvent(new Event("change"))
        }
        host.style.display = "none"
        w.__uploadFloor = (variant: string) => {
          const f = (variant === "before" ? w.__oldBake : w.__newBake)(g.map)
          w.__gpuDevice.queue.writeTexture({ texture: w.__renderer.floorTex }, f.data, { bytesPerRow: f.w * 2 }, [f.w, f.h])
          const moon = f.moon ?? { w: f.w, h: f.h, data: f.data.filter((_: number, i: number) => i % 2 === 1) }
          if (variant === "no-moon") moon.data.fill(0)
          w.__renderer.moonTex.destroy()
          w.__renderer.moonTex = w.__gpuDevice.createTexture({ size: [moon.w, moon.h], format: "r8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
          w.__gpuDevice.queue.writeTexture({ texture: w.__renderer.moonTex }, moon.data, { bytesPerRow: moon.w }, [moon.w, moon.h])
          w.__renderer.makeSceneGroup()
        }
        for (let i = 0; i < 60; i++) { await w.__stepManualVideo(1000 / 60); await w.__gpuDevice.queue.onSubmittedWorkDone(); await w.__gpuDrain() }
      }, { fixture, look, motion })
      const prefix = `${fixture.name}-look${+look}-motion${+motion}`
      for (const variant of ["before", "after", "no-moon"]) {
        await page.evaluate(async variant => {
          const w = window as any
          w.__uploadFloor(variant)
          w.__renderer.render(w.__frame); await Promise.resolve(); await w.__gpuDevice.queue.onSubmittedWorkDone()
        }, variant)
        await page.screenshot({ path: join(out, `${prefix}-${variant}.png`) })
      }
      // Same ordinary movement and camera across all four settings, retaining the production animation path.
      await page.evaluate(() => (window as any).__uploadFloor("after"))
      await page.keyboard.down("s")
      const trace = await page.evaluate(async () => {
        const w = window as any, poses = []
        for (let i = 0; i < 24; i++) {
          await w.__stepManualVideo(1000 / 60); await w.__gpuDevice.queue.onSubmittedWorkDone(); await w.__gpuDrain()
          poses.push({ state: w.__game.muxState(), camera: [...w.__cam.viewProj], batches: w.__frame.batches.map((b: any) => [...b.data]) })
        }
        return poses
      })
      await page.keyboard.up("s")
      poses.push(createHash("sha256").update(JSON.stringify(trace)).digest("hex"))
      if (!trace.some(p => Math.hypot(p.state.vx, p.state.vy) > 1)) throw new Error("Movement fixture was blocked")
      await page.screenshot({ path: join(out, `${prefix}-moving.png`) })
      if (fixture.name === "wood" && look && !motion) {
        await page.setViewportSize({ width: 2560, height: 1440 })
        report.gpu = await page.evaluate(async () => {
          const w = window as any, d = w.__gpuDevice, r = w.__renderer
          await w.__stepManualVideo(1000 / 60); await d.queue.onSubmittedWorkDone(); await w.__gpuDrain()
          const frame = w.__frame, after = r.pipes, before = { ...after }, modules = new Map()
          for (const key of ["level", "levelCut", "glass", "inst", "instAlpha"]) {
            const desc = w.__pipelines.get(after[key]), mod = desc.vertex.module
            if (!modules.has(mod)) {
              const source = w.__modules.get(mod).code as string
              const code = source.replace(/fn floorData\(p: vec2f\) -> vec2f \{[\s\S]*?\n\}/, "fn floorData(p: vec2f) -> vec2f { return textureSampleLevel(floorTex, floorSamp, p * F.map.xy, 0.0).rg; }")
              if (source === code) throw new Error("Missing baseline sampler anchor")
              modules.set(mod, d.createShaderModule({ code }))
            }
            before[key] = d.createRenderPipeline({ ...desc, vertex: { ...desc.vertex, module: modules.get(mod) }, fragment: { ...desc.fragment, module: modules.get(mod) } })
          }
          const output = d.createTexture({ size: [2560, 1440], format: navigator.gpu.getPreferredCanvasFormat(), usage: GPUTextureUsage.RENDER_ATTACHMENT })
          r.context = { getCurrentTexture: () => output }
          const groups: any = {}
          for (const variant of ["before", "after"]) {
            const f = (variant === "before" ? w.__oldBake : w.__newBake)(w.__game.map)
            const moon = f.moon ?? { w: f.w, h: f.h, data: f.data.filter((_: number, i: number) => i % 2 === 1) }
            r.floorTex = d.createTexture({ size: [f.w, f.h], format: "rg8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
            r.moonTex = d.createTexture({ size: [moon.w, moon.h], format: "r8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
            d.queue.writeTexture({ texture: r.floorTex }, f.data, { bytesPerRow: f.w * 2 }, [f.w, f.h])
            d.queue.writeTexture({ texture: r.moonTex }, moon.data, { bytesPerRow: moon.w }, [moon.w, moon.h])
            r.makeSceneGroup(); groups[variant] = r.sceneGroup
          }
          const draw = async (variant: string) => {
            r.pipes = variant === "before" ? before : after
            r.sceneGroup = groups[variant]
            r.render(frame); await Promise.resolve(); await d.queue.onSubmittedWorkDone(); await w.__gpuDrain()
            return w.__gpuSamples.at(-1).gpuHwMs
          }
          for (let i = 0; i < 32; i++) { await draw("before"); await draw("after") }
          const pairs = []
          for (let i = 0; i < 8; i++) {
            const samples: any = { before: [], after: [] }, values: any = {}
            w.__clearGpuSamples()
            for (let j = 0; j < 48; j++) for (const variant of ((i + j) % 2 ? ["after", "before"] : ["before", "after"])) samples[variant].push(await draw(variant))
            for (const variant of ["before", "after"]) {
              if (samples[variant].some((s: number) => !(s > 0))) throw new Error("Missing GPU timestamps")
              values[variant] = { ms: samples[variant].reduce((a: number, b: number) => a + b, 0) / 48, samples: samples[variant] }
            }
            pairs.push({ warmup: i === 0, ...values, delta: values.after.ms - values.before.ms })
          }
          return { adapter: w.__gpuAdapterInfo, resolution: [2560, 1440], offscreen: true, pairs }
        })
      }
      if (!look && !motion) {
        report.views.push(await page.evaluate(() => {
          const w = window as any, map = w.__game.map, pairs = []
          for (let i = 0; i < 10; i++) for (const variant of (i % 2 ? ["after", "before"] : ["before", "after"])) {
            const start = Date.now(), f = (variant === "before" ? w.__oldBake : w.__newBake)(map)
            pairs.push({ variant, warmup: i < 3, ms: Date.now() - start, bytes: f.data.byteLength + (f.moon?.data.byteLength ?? 0), w: f.w, h: f.h })
          }
          const a = w.__oldBake(map), b = w.__newBake(map)
          let aoDifferences = 0
          for (let i = 0; i < a.data.length; i += 2) if (a.data[i] !== b.data[i]) aoDifferences++
          return { seed: map.seed, pairs, aoDifferences }
        }))
      }
      await page.close()
    }
    report.views.push({ fixture, poseHashes: poses, identicalMotion: new Set(poses).size === 1 })
    if (new Set(poses).size !== 1) throw new Error("Presentation changed animation/input")
  }
  if (report.errors.length) throw new Error(report.errors.join("\n"))
  writeFileSync(join(out, costOnly ? "cost.json" : "proof.json"), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ ...report, gpu: report.gpu && { ...report.gpu, pairs: report.gpu.pairs.map(({ before, after, ...p }: any) => ({ ...p, before: before.ms, after: after.ms })) } }))
} finally { await browser.close(); server.kill(); await server.exited; unlinkSync(baseline) }
