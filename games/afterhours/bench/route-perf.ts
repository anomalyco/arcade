// Play-route performance: frame-time percentiles, long tasks, GC events, JS heap growth, draw calls and triangles per
// frame, and (optionally) a sampled allocation profile, on a frozen production build in the real play shell.
//
//   bunx vite build --outDir $TMP/ash --minify false --logLevel warn
//   bun bench/route-perf.ts --dir $TMP/ash [--routes intro,lot,s3,reveal,escape] [--seconds 120] [--cpu 4]
//                           [--size 1280x720] [--alloc] [--out f.json]
//
// One headless Chromium (Metal, --mute-audio), one route at a time. Each route boots at 1× (boot isn't measured),
// gets to its starting point, collects garbage, then switches CPU throttling on and measures for `--seconds`:
//   intro   `?play` with autoplay: the title card and the intro drive (measured from the intro's start)
//   lot     `?play&start=arrival`: walk/run from the parked car through the main doors into the lobby and back
//   s3      `?play&start=3-08`: out of 3-08 into the storey-3 spine, west to the core, east to the end, back into 3-08
//   reveal  `?play&start=after-reveal`: the hunter is active; walk 3-08 → spine → west and back
//   escape  `?play&start=escape-truck`: get in, start, open the shed, autopilot out along the logging road
// Walking is the real controller: W (and Shift) held through synthetic key events, yaw steered towards the next
// waypoint each frame, E pressed when stuck (doors), waypoints ping-pong until time is up.
import { writeFileSync } from "node:fs"
import { arg, launch, serve, sourceResolver, TMP } from "./lib"

const args = process.argv.slice(2)
const dir = arg(args, "dir", `${TMP}/ash`)!
const routes = arg(args, "routes", "intro,lot,s3,reveal,escape")!.split(",")
const seconds = Number(arg(args, "seconds", "120"))
const cpuRate = Number(arg(args, "cpu", "4"))
const [W, H] = arg(args, "size", "1280x720")!.split("x").map(Number) as [number, number]
const alloc = args.includes("--alloc")
const outFile = arg(args, "out")
const profile = args.includes("--profile")
const resolve = await sourceResolver(dir)
const where = (url: string, line: number, col: number) => {
  const file = url.split("/").pop() ?? ""
  return resolve(file, line, col) ?? `${file}:${line + 1}`
}
const PORT = 5226
const server = serve(dir, PORT, { prefix: "/arcade/ashwood/", isolate: false })
const BASE = `http://localhost:${PORT}/arcade/ashwood/`

const URLS: Record<string, string> = {
  intro: "?play",
  lot: "?play&start=arrival",
  s3: "?play&start=3-08",
  reveal: "?play&start=after-reveal",
  escape: "?play&start=escape-truck",
}

const pct = (xs: number[], p: number) => {
  const v = [...xs].sort((a, b) => a - b)
  return v.length ? +v[Math.min(v.length - 1, Math.floor(v.length * p))]!.toFixed(2) : NaN
}

const browser = await launch()
const results: Record<string, unknown> = {}
for (const route of routes) {
  const context = await browser.newContext({ viewport: { width: W, height: H } })
  const page = await context.newPage()
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 200)))
  await page.addInitScript((intro: boolean) => {
    if (intro) sessionStorage.setItem("afterhours.autoplay", "1")
    const g = globalThis as any
    const M = (g.__rp = { on: false, frames: [] as number[], draws: [] as number[], tris: [] as number[], long: [] as { t: number; d: number }[], loaf: [] as { t: number; d: number; s: string }[], heap: [] as number[] })
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (M.on) M.long.push({ t: e.startTime, d: e.duration })
    }).observe({ type: "longtask", buffered: false })
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries() as any[])
          if (M.on && e.duration > 50) M.loaf.push({ t: e.startTime, d: e.duration, s: (e.scripts ?? []).slice(0, 2).map((s: any) => `${s.sourceFunctionName || "?"}@${(s.sourceURL || "").split("/").pop()}:${s.sourceCharPosition} ${Math.round(s.duration)}ms`).join(" | ") })
      }).observe({ type: "long-animation-frame", buffered: false })
    } catch {}
    let last = 0
    const tick = (t: number) => {
      if (M.on) {
        if (last) M.frames.push(t - last)
        const info = g.__afterhoursDebug?.renderer?.info?.render
        if (info) {
          M.draws.push(info.drawCalls)
          M.tris.push(info.triangles)
        }
      }
      last = t
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    setInterval(() => M.on && M.heap.push((performance as any).memory?.usedJSHeapSize ?? 0), 1000)
  }, route === "intro")

  const t0 = Date.now()
  const log = (m: string) => console.error(`  [${route} ${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`)
  await page.goto(BASE + URLS[route])
  const want = route === "intro" ? "intro" : "explore"
  await page.waitForFunction((p) => (globalThis as any).__static?.flow?.phase === p, want, { timeout: 300_000, polling: 250 })
  const bootS = (Date.now() - t0) / 1000
  log("at start phase")
  await page.waitForTimeout(route === "intro" ? 500 : 5000)

  const cdp = await context.newCDPSession(page)
  await cdp.send("HeapProfiler.enable")
  await cdp.send("HeapProfiler.collectGarbage")
  const heap0 = (await cdp.send("Runtime.getHeapUsage")) as { usedSize: number; totalSize: number; embedderHeapUsedSize?: number; backingStorageSize?: number }
  if (cpuRate > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuRate })
  if (profile) {
    await cdp.send("Profiler.enable")
    await cdp.send("Profiler.setSamplingInterval", { interval: 250 })
    await cdp.send("Profiler.start")
  }
  if (alloc) await cdp.send("HeapProfiler.startSampling", { samplingInterval: 8192, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true } as any)
  else await browser.startTracing(page, { categories: ["devtools.timeline", "v8", "disabled-by-default-v8.gc"] })

  await page.evaluate(() => {
    const g = globalThis as any
    const r = g.__afterhoursDebug.renderer
    const M = g.__rp
    M.uploadMap = new Map()
    M.sync = {}
    const backend = r.backend
    const ua = backend.updateAttribute
    backend.updateAttribute = function (attr: any) {
      if (M.on) {
        let e = M.uploadMap.get(attr)
        if (!e) M.uploadMap.set(attr, (e = { n: 0, bytes: 0, stack: (new Error().stack ?? "").split("\n").slice(2, 30).join(" <- ") }))
        e.n++
        e.bytes += attr.array?.byteLength ?? 0
      }
      return ua.call(this, attr)
    }
    const nodes = r._nodes
    const gfr = nodes.getForRender
    nodes.getForRender = function (ro: any, useAsync: boolean) {
      const fresh = M.on && !useAsync && this.get(ro).nodeBuilderState === undefined
      const t = performance.now()
      const out = gfr.call(this, ro, useAsync)
      if (fresh) {
        const k = `${ro.object?.name || ro.object?.type}/${ro.material?.name || ro.material?.type}`
        const e = (M.sync[k] ??= { n: 0, ms: 0 })
        e.n++
        e.ms += performance.now() - t
      }
      return out
    }
    M.on = true
  })
  log("measuring")
  // Drivers.
  if (route === "lot" || route === "s3" || route === "reveal") {
    await page.evaluate((route) => {
      const g = globalThis as any
      const p = g.__afterhoursPlayer
      const key = (type: string, code: string) => dispatchEvent(new KeyboardEvent(type, { code, key: code === "KeyE" ? "e" : code === "KeyW" ? "w" : "Shift", bubbles: true }))
      let pts: [number, number, boolean?][]
      if (route === "lot") {
        pts = [[-14, 66, true], [2, 46, true], [2, 30, true], [0, 23.5], [0, 16], [4, 12], [-4, 6], [-11, 2]]
      } else {
        const door = (g.__interior?.doors ?? []).find((d: any) => d.room === "3-08") ?? { x: 6, z: -1.75 }
        const out: [number, number] = [door.x, 1.1]
        pts =
          route === "s3"
            ? [[door.x, door.z - 1.2], [door.x, door.z + 0.2], out, [-36, 1.1], [30, 1.1], out, [door.x, door.z - 1.2], [6, -10]]
            : [[6, -8], [door.x, door.z - 1.2], [door.x, door.z + 0.2], out, [-20, 1.1]]
      }
      let i = 0
      let dirn = 1
      let lastPos = { x: p.pos.x, z: p.pos.z, t: performance.now() }
      let run = false
      key("keydown", "KeyW")
      const step = () => {
        if (!g.__rp.on) {
          key("keyup", "KeyW")
          key("keyup", "ShiftLeft")
          return
        }
        const wp = pts[i]!
        const dx = wp[0] - p.pos.x
        const dz = wp[1] - p.pos.z
        p.yaw = Math.atan2(-dx, -dz)
        if (!!wp[2] !== run) {
          run = !!wp[2]
          key(run ? "keydown" : "keyup", "ShiftLeft")
        }
        const now = performance.now()
        const next = () => {
          i += dirn
          if (i >= pts.length || i < 0) {
            dirn = -dirn
            i += 2 * dirn
          }
          lastPos = { x: p.pos.x, z: p.pos.z, t: now }
        }
        if (Math.hypot(dx, dz) < 0.9) next()
        else if (now - lastPos.t > 1500) {
          if (Math.hypot(p.pos.x - lastPos.x, p.pos.z - lastPos.z) < 0.4) {
            key("keydown", "KeyE")
            setTimeout(() => key("keyup", "KeyE"), 80)
            if (now - lastPos.t > 6000) next()
          } else lastPos = { x: p.pos.x, z: p.pos.z, t: now }
        }
        requestAnimationFrame(step)
      }
      requestAnimationFrame(step)
    }, route)
  } else if (route === "escape") {
    void (async () => {
      await page.waitForTimeout(1200)
      await page.evaluate(() => dispatchEvent(new KeyboardEvent("keydown", { code: "KeyE", key: "e" })))
      await page.evaluate(() => setTimeout(() => dispatchEvent(new KeyboardEvent("keyup", { code: "KeyE", key: "e" })), 80))
      await page.waitForTimeout(1500)
      await page.evaluate(() => dispatchEvent(new KeyboardEvent("keydown", { code: "KeyE", key: "e" })))
      await page.evaluate(() => setTimeout(() => dispatchEvent(new KeyboardEvent("keyup", { code: "KeyE", key: "e" })), 80))
      await page.waitForTimeout(2500)
      await page.evaluate(() => (globalThis as any).__afterhoursPlayer.ctx.doors.get("motor-pool-button")?.open())
      await page.waitForTimeout(4500)
      await page.evaluate(() => {
        const e = (globalThis as any).__ashwoodEscape
        if (e) e.autopilot = true
      })
    })().catch(() => {})
  }

  await page.waitForTimeout(seconds * 1000)
  log("stopping")
  await page.evaluate(() => ((globalThis as any).__rp.on = false))
  const phaseEnd = await page.evaluate(() => (globalThis as any).__static?.flow?.phase ?? null)
  let gc: unknown = null
  let allocTop: unknown = null
  if (alloc) {
    log("stop heap sampling")
    const { profile } = (await cdp.send("HeapProfiler.stopSampling")) as { profile: any }
    const by = new Map<string, number>()
    let total = 0
    const walk = (n: any) => {
      const f = n.callFrame
      const k = `${f.functionName || "(anon)"} ${where(f.url, f.lineNumber, f.columnNumber)}`
      if (n.selfSize) {
        by.set(k, (by.get(k) ?? 0) + n.selfSize)
        total += n.selfSize
      }
      for (const c of n.children ?? []) walk(c)
    }
    walk(profile.head)
    const perS = (b: number) => +(b / seconds / 1024).toFixed(1)
    allocTop = { totalKBperS: perS(total), top: [...by].sort((a, b) => b[1] - a[1]).slice(0, 45).map(([k, v]) => [k, perS(v)]) }
  } else {
    const buf = await browser.stopTracing()
    const trace = JSON.parse(buf.toString()) as { traceEvents: { name: string; ph: string; dur?: number; args?: any; cat: string }[] }
    const ev = trace.traceEvents.filter((e) => (e.name === "MinorGC" || e.name === "MajorGC") && e.ph === "X")
    const minor = ev.filter((e) => e.name === "MinorGC")
    const major = ev.filter((e) => e.name === "MajorGC")
    const ms = (l: typeof ev) => +(l.reduce((a, e) => a + (e.dur ?? 0), 0) / 1000).toFixed(1)
    const freed = (l: typeof ev) => +(l.reduce((a, e) => a + ((e.args?.usedHeapSizeBefore ?? 0) - (e.args?.usedHeapSizeAfter ?? 0)), 0) / 1e6).toFixed(1)
    gc = {
      minor: minor.length,
      major: major.length,
      minorPerMin: +((minor.length / seconds) * 60).toFixed(1),
      majorPerMin: +((major.length / seconds) * 60).toFixed(1),
      minorMs: ms(minor),
      majorMs: ms(major),
      longestGcMs: +(Math.max(0, ...ev.map((e) => e.dur ?? 0)) / 1000).toFixed(1),
      freedMB: freed(ev),
      freedMBperS: +(freed(ev) / seconds).toFixed(2),
    }
  }
  let cpuTop: unknown = null
  if (profile) {
    log("stop cpu profile")
    const { profile: p } = (await cdp.send("Profiler.stop")) as { profile: { nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number }; children?: number[] }[]; samples: number[]; timeDeltas: number[] } }
    const byId = new Map(p.nodes.map((n) => [n.id, n]))
    const parent = new Map<number, number>()
    for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id)
    const self = new Map<string, number>()
    const total = new Map<string, number>()
    const fileTotal = new Map<string, number>()
    let busy = 0
    const key = (id: number) => {
      const f = byId.get(id)!.callFrame
      return `${f.functionName || "(anon)"} ${f.url ? where(f.url, f.lineNumber, f.columnNumber) : ""}`
    }
    for (let i = 0; i < p.samples.length; i++) {
      const dt = (p.timeDeltas[i + 1] ?? 0) / 1000
      const leaf = p.samples[i]!
      const lk = key(leaf)
      if (lk.startsWith("(idle)")) continue
      busy += dt
      self.set(lk, (self.get(lk) ?? 0) + dt)
      const seen = new Set<string>()
      const seenF = new Set<string>()
      for (let id: number | undefined = leaf; id !== undefined; id = parent.get(id)) {
        const k = key(id)
        if (!seen.has(k)) total.set(k, (total.get(k) ?? 0) + dt), seen.add(k)
        const file = k.split(" ")[1]?.replace(/:\d+$/, "") ?? ""
        if (file.startsWith("src/") && !seenF.has(file)) fileTotal.set(file, (fileTotal.get(file) ?? 0) + dt), seenF.add(file)
      }
    }
    const perS = (ms: number) => +(ms / seconds).toFixed(2)
    cpuTop = {
      busyMsPerS: perS(busy),
      self: [...self].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, v]) => [k, perS(v)]),
      total: [...total].sort((a, b) => b[1] - a[1]).slice(0, 60).map(([k, v]) => [k, perS(v)]),
      srcFilesInclusive: [...fileTotal].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, v]) => [k, perS(v)]),
    }
  }
  if (cpuRate > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 })
  await cdp.send("HeapProfiler.collectGarbage")
  const heap1 = (await cdp.send("Runtime.getHeapUsage")) as { usedSize: number; embedderHeapUsedSize?: number; backingStorageSize?: number }
  const M = (await page.evaluate(() => (globalThis as any).__rp)) as { frames: number[]; draws: number[]; tris: number[]; long: { t: number; d: number }[]; loaf: { t: number; d: number; s: string }[]; heap: number[] }
  const extra = (await page.evaluate(() => {
    const g = globalThis as any
    const M = g.__rp
    // Owner of each uploaded attribute: the mesh/geometry attribute name it belongs to.
    const owner = new Map<unknown, string>()
    g.__afterhoursDebug.scene.traverse((o: any) => {
      const geo = o.geometry
      if (!geo) return
      const path: string[] = []
      for (let p = o; p && p.parent; p = p.parent) path.unshift(p.name || p.type)
      for (const [name, a] of Object.entries(geo.attributes ?? {})) owner.set(a, `${path.slice(-3).join("/")}.${name}`)
      if (geo.index) owner.set(geo.index, `${path.slice(-3).join("/")}.index`)
      if (o.instanceMatrix) owner.set(o.instanceMatrix, `${path.slice(-3).join("/")}.instanceMatrix`)
      if (o.instanceColor) owner.set(o.instanceColor, `${path.slice(-3).join("/")}.instanceColor`)
    })
    const uploads: Record<string, { n: number; bytes: number; stack: string; owner: string; count: number }> = {}
    let i = 0
    for (const [a, e] of M.uploadMap as Map<any, any>) uploads[String(i++)] = { ...e, owner: owner.get(a) ?? `? ${a.name || ""} ${a.constructor?.name} count ${a.count}x${a.itemSize}`, count: a.count }
    return { uploads, sync: M.sync }
  })) as { uploads: Record<string, { n: number; bytes: number; stack: string; owner: string; count: number }>; sync: Record<string, { n: number; ms: number }> }
  const resolveStack = (st: string) =>
    st
      .split(" <- ")
      .map((f) => {
        const m = /\(?(https?:[^)\s]+):(\d+):(\d+)\)?/.exec(f)
        const fn = /at (\S+) \(/.exec(f)?.[1] ?? ""
        return m ? `${fn} ${where(m[1]!, Number(m[2]) - 1, Number(m[3]) - 1)}` : f.trim()
      })
      .filter((x) => !/three\/build|three\/examples/.test(x))
      .filter((x) => /src\//.test(x))
      .slice(0, 3)
      .join(" <- ")
  const uploadsTop = Object.values(extra.uploads)
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 25)
    .map((u) => ({ perS: +(u.n / seconds).toFixed(1), KBperS: +(u.bytes / seconds / 1024).toFixed(1), owner: u.owner, from: resolveStack(u.stack) }))
  const syncTop = Object.entries(extra.sync).sort((a, b) => b[1].ms - a[1].ms).slice(0, 15).map(([k, v]) => ({ k, n: v.n, ms: Math.round(v.ms) }))
  const loafBy = new Map<string, { n: number; ms: number }>()
  for (const l of M.loaf) {
    const k = l.s || "(no script)"
    const e = loafBy.get(k) ?? { n: 0, ms: 0 }
    e.n++
    e.ms += l.d
    loafBy.set(k, e)
  }
  results[route] = {
    bootS: +bootS.toFixed(1),
    seconds,
    cpuRate,
    phaseEnd,
    frames: M.frames.length,
    frameMs: { median: pct(M.frames, 0.5), p95: pct(M.frames, 0.95), p99: pct(M.frames, 0.99), max: pct(M.frames, 1), over50: M.frames.filter((f) => f > 50).length, over100: M.frames.filter((f) => f > 100).length },
    longTasks: { count: M.long.length, totalMs: Math.round(M.long.reduce((a, l) => a + l.d, 0)), max: Math.round(Math.max(0, ...M.long.map((l) => l.d))) },
    draws: { median: pct(M.draws, 0.5), p95: pct(M.draws, 0.95) },
    trisM: { median: +(pct(M.tris, 0.5) / 1e6).toFixed(2), p95: +(pct(M.tris, 0.95) / 1e6).toFixed(2) },
    heapMB: {
      afterGcStart: +(heap0.usedSize / 1e6).toFixed(1),
      afterGcEnd: +(heap1.usedSize / 1e6).toFixed(1),
      retainedGrowth: +((heap1.usedSize - heap0.usedSize) / 1e6).toFixed(1),
      backingStoreStart: +((heap0.backingStorageSize ?? 0) / 1e6).toFixed(1),
      backingStoreEnd: +((heap1.backingStorageSize ?? 0) / 1e6).toFixed(1),
      embedderStart: +((heap0.embedderHeapUsedSize ?? 0) / 1e6).toFixed(1),
      embedderEnd: +((heap1.embedderHeapUsedSize ?? 0) / 1e6).toFixed(1),
      sampledMin: +(Math.min(...M.heap) / 1e6).toFixed(1),
      sampledMax: +(Math.max(...M.heap) / 1e6).toFixed(1),
    },
    gc,
    uploads: { totalKBperS: +(Object.values(extra.uploads).reduce((a, u) => a + u.bytes, 0) / seconds / 1024).toFixed(1), perFrameAttrs: Object.values(extra.uploads).filter((u) => u.n > seconds * 20).length, top: uploadsTop },
    syncNodeBuilds: { count: Object.values(extra.sync).reduce((a, v) => a + v.n, 0), ms: Math.round(Object.values(extra.sync).reduce((a, v) => a + v.ms, 0)), top: syncTop },
    alloc: allocTop,
    cpu: cpuTop,
    loafTop: [...loafBy].sort((a, b) => b[1].ms - a[1].ms).slice(0, 8).map(([k, v]) => ({ k, n: v.n, ms: Math.round(v.ms) })),
    errors: errors.slice(0, 4),
  }
  console.error(route, JSON.stringify(results[route]).slice(0, 400))
  if (outFile) writeFileSync(outFile, JSON.stringify(results, null, 1))
  await context.close()
}
await browser.close()
server.stop(true)
if (outFile) writeFileSync(outFile, JSON.stringify(results, null, 1))
console.log(JSON.stringify(results, null, 1))
process.exit(0)
