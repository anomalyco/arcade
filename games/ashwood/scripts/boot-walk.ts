// Cold-load + scripted walk: what the first ~40 s feel like. Records a video, every frame interval, and attributes each
// hitch (> 33 ms between frames) to what ran in it: in-frame shader/pipeline builds, texture uploads, buffer uploads,
// GLB/audio loads, audio decode, GC and other JS (from a CPU profile aligned to the page clock), plus pop-in (objects
// that appeared while in view) and when the loading screen lifted ("playable").
//
//   bun scripts/boot-walk.ts                          # dev server :5196, installed Chrome (new headless), view=lot
//   bun scripts/boot-walk.ts --cpu 4 --tag cpu4        # loaded laptop
//   bun scripts/boot-walk.ts --port 5197 --tag prod    # against `bun run preview`
//
// Output: captures/boot-walk-<tag>.webm (+ .json with the raw timeline) and a summary on stdout. The walk: spawn in the
// parking lot, run to the main entrance, press E at the doors, walk into the lobby and on towards the corridor.
import { chromium } from "playwright-core"
import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs"

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`)
  if (i < 0) return undefined
  const v = args[i + 1]
  args.splice(i, 2)
  return v
}
const tag = flag("tag") ?? "walk"
const port = Number(flag("port") ?? 5196)
const cpu = Number(flag("cpu") ?? 1)
const seconds = Number(flag("seconds") ?? 40)
const view = flag("view") ?? "lot"
const extra = flag("q") ?? ""
const shell = args.includes("--shell")
const [w, h] = (flag("size") ?? "1280x800").split("x").map(Number) as [number, number]
const outDir = `${import.meta.dir}/../captures`
mkdirSync(outDir, { recursive: true })

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
const headlessShell = readdirSync(cache)
  .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
  .sort()
  .reverse()
  .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
  .find(existsSync)
const browser = await chromium.launch({
  executablePath: shell ? headlessShell : "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"],
})
const videoDir = `${outDir}/.boot-walk-${tag}`
const context = await browser.newContext({ viewport: { width: w, height: h }, recordVideo: { dir: videoDir, size: { width: w, height: h } } })
const page = await context.newPage()
const errors: string[] = []
page.on("pageerror", (e) => errors.push(e.message))
page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 300)))
// Swallow Vite's HMR socket so other agents' saves don't reload the page mid-run.
await page.routeWebSocket(/.*/, () => {})
const cdp = await context.newCDPSession(page)
if (cpu > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu })
await cdp.send("Profiler.enable")
await cdp.send("Profiler.setSamplingInterval", { interval: 500 })

await page.addInitScript(() => {
  type Ev = { t: number; kind: string; ms: number; what?: string }
  const g = globalThis as unknown as {
    __walk: { frames: number[]; events: Ev[]; loaf: { start: number; dur: number; scripts: string[] }[]; marker?: number }
    __ashwoodDebug?: { renderer: unknown }
  }
  performance.setResourceTimingBufferSize(10000)
  const W = (g.__walk = { frames: [] as number[], events: [] as Ev[], loaf: [] as { start: number; dur: number; scripts: string[] }[] })
  const tick = (t: number) => {
    W.frames.push(t)
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries() as unknown as { startTime: number; duration: number; scripts: { invoker: string; sourceFunctionName: string; sourceURL: string; duration: number }[] }[])
        W.loaf.push({
          start: e.startTime,
          dur: e.duration,
          scripts: e.scripts
            .filter((s) => s.duration > 5)
            .map((s) => `${Math.round(s.duration)}ms ${s.sourceFunctionName || s.invoker} ${s.sourceURL.split("/").pop()?.split("?")[0] ?? ""}`),
        })
    }).observe({ type: "long-animation-frame", buffered: true })
  } catch {}
  // Audio decode (async; the time to resolve, not main-thread time).
  const dec = BaseAudioContext.prototype.decodeAudioData
  BaseAudioContext.prototype.decodeAudioData = function (this: BaseAudioContext, ...a: Parameters<typeof dec>) {
    const t = performance.now()
    const p = dec.apply(this, a)
    p.then(() => W.events.push({ t, kind: "audio-decode", ms: performance.now() - t })).catch(() => {})
    return p
  } as typeof dec
  // three internals, hooked as soon as the renderer exists.
  const hook = setInterval(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = g.__ashwoodDebug?.renderer as any
    if (!r?._nodes || !r._textures || !r.backend) return
    clearInterval(hook)
    const wrap = (obj: any, key: string, kind: string, filter: (args: any[], self: any) => string | null | undefined) => {
      const orig = obj[key]
      obj[key] = function (...a: any[]) {
        const what = filter(a, this)
        if (what === null) return orig.apply(this, a)
        const t = performance.now()
        const res = orig.apply(this, a)
        W.events.push({ t, kind, ms: performance.now() - t, what })
        return res
      }
    }
    const nodes = r._nodes
    wrap(nodes, "getForRender", "sync-node-build", (a, self) => (!a[1] && self.get(a[0]).nodeBuilderState === undefined ? `${a[0].object.name || a[0].object.type}/${a[0].material.name || a[0].material.type}` : null))
    wrap(r.backend, "createRenderPipeline", "sync-pipeline", (a) => (a[1] ? null : a[0].material?.name ?? ""))
    wrap(r._textures, "updateTexture", "texture-upload", (a) => (a[0].version > 0 && r._textures.get(a[0]).version !== a[0].version ? `${a[0].name || a[0].constructor?.name || "tex"} ${a[0].image?.width ?? "?"}x${a[0].image?.height ?? "?"}${a[0].isRenderTargetTexture ? " rt" : ""}` : null))
    wrap(r.backend, "createAttribute", "buffer-upload", () => "")
    wrap(r.backend, "createStorageAttribute", "buffer-upload", () => "")
  }, 5)
})

const t0 = Date.now()
await cdp.send("Profiler.start")
await page.goto(`http://localhost:${port}/?view=${view}${extra ? `&${extra}` : ""}`)
// Align the CPU profile clock with performance.now(): a 6 ms busy marker function.
const marker = await page.evaluate(() => {
  const t = performance.now()
  ;(function __walkMarker() {
    const end = performance.now() + 6
    while (performance.now() < end);
  })()
  return t
})

// Playable = the loading cover is gone (removed, or faded with the `live`/`done` class and no longer opaque).
const playable = await page
  .waitForFunction(
    () => {
      const b = document.querySelector("#boot")
      if (!b || b.classList.contains("live") || b.classList.contains("done")) return performance.now()
      return null
    },
    undefined,
    { timeout: 180_000, polling: 50 },
  )
  .then((h) => h.jsonValue() as Promise<number>)
  .catch(() => NaN)

// The walk, driven through the real keyboard; only the heading is set directly (no pointer lock headless).
type P = { pos: { x: number; y: number; z: number }; yaw: number }
const player = <T,>(fn: (p: P, arg: number[]) => T, arg: number[] = []) =>
  page.evaluate(({ src, arg }) => new Function("p", "arg", `return (${src})(p, arg)`)((globalThis as unknown as { __ashwoodPlayer: P }).__ashwoodPlayer, arg), { src: fn.toString(), arg }) as Promise<T>
const route: { x: number; z: number; door?: boolean; run?: boolean }[] = [
  { x: -14, z: 66, run: true },
  { x: 2, z: 46, run: true },
  { x: 2, z: 30, run: true },
  { x: 0, z: 23.5, door: true },
  { x: 0, z: 16 },
  { x: 4, z: 12 },
  { x: -4, z: 6 },
  { x: -11, z: 2 },
]
const deadline = t0 + seconds * 1000
const walkStart = Date.now()
await page.keyboard.down("KeyW")
let shift = false
for (const wp of route) {
  if (wp.run && !shift) await page.keyboard.down("ShiftLeft"), (shift = true)
  if (!wp.run && shift) await page.keyboard.up("ShiftLeft"), (shift = false)
  let stuck = 0
  let lastD = Infinity
  while (Date.now() < deadline) {
    const d = await player((p, a) => {
      const dx = a[0]! - p.pos.x
      const dz = a[1]! - p.pos.z
      p.yaw = Math.atan2(-dx, -dz)
      return Math.hypot(dx, dz)
    }, [wp.x, wp.z])
    if (d < 1.2) break
    if ((wp.door && d < 4) || stuck > 5) await page.keyboard.press("KeyE")
    stuck = d > lastD - 0.02 ? stuck + 1 : 0
    lastD = d
    if (stuck > 40) break // blocked (a closed door or a wall): move on
    await page.waitForTimeout(100)
  }
}
await page.keyboard.up("KeyW")
if (shift) await page.keyboard.up("ShiftLeft")
const left = deadline - Date.now()
if (left > 0) await page.waitForTimeout(left)

const { profile } = (await cdp.send("Profiler.stop")) as { profile: Profile }
const data = await page.evaluate(() => {
  const g = globalThis as unknown as { __walk: unknown; __ashwood?: { completeAt: number | null } }
  const res = (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
    .filter((r) => /\.(glb|ktx2|ogg|opus|webm|mp3|wav|m4a)(\?|$)/.test(r.name))
    .map((r) => ({ name: r.name.split("/").pop()!.split("?")[0]!, start: r.startTime, end: r.responseEnd }))
  const marks = performance.getEntriesByType("mark").map((m) => ({ name: m.name, t: m.startTime }))
  return { walk: g.__walk, res, marks, complete: g.__ashwood?.completeAt ?? null }
})
const pos = await player((p) => [p.pos.x, p.pos.y, p.pos.z])
await context.close()
await browser.close()

// Video: Playwright names it randomly; move it next to the JSON.
const vids = existsSync(videoDir) ? readdirSync(videoDir).filter((f) => f.endsWith(".webm")) : []
const video = `${outDir}/boot-walk-${tag}.webm`
if (vids[0]) renameSync(`${videoDir}/${vids[0]}`, video)

// ---------------------------------------------------------------------------------------------- CPU profile buckets
type Profile = { nodes: { id: number; callFrame: { functionName: string; url: string }; children?: number[] }[]; samples: number[]; timeDeltas: number[]; startTime: number }
const parent = new Map<number, number>()
for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id)
const byId = new Map(profile.nodes.map((n) => [n.id, n]))
const BUCKETS: [string, RegExp][] = [
  ["GC", /^\(garbage collector\)/],
  ["shader node build", /buildAsync|getNodeBuilderState|buildCode|NodeBuilder|flowNode|analyze three|generate three/],
  ["texture upload", /copyExternalImageToTexture|_copyImageToTexture|writeTexture|updateTexture|KTX2|transcode/],
  ["GLB parse/decode", /GLTFLoader|GLTFParser|meshopt|parse three_addons_loaders|decodeGltfBuffer/],
  ["audio", /decodeAudioData|audio\/|AudioBuffer/],
  ["world build", /build (terrain|roads|compound|facility|forest|interior)|buildModule|mergeGeometries|computeVertexNormals/],
  ["render (frame)", /^render three|_renderScene|renderObject|post\.ts/],
]
const sampleTimes: number[] = []
let tt = profile.startTime
for (let i = 0; i < profile.samples.length; i++) {
  tt += profile.timeDeltas[i] ?? 0
  sampleTimes.push(tt / 1000)
}
const stackOf = (id: number) => {
  const out: string[] = []
  for (let n: number | undefined = id; n !== undefined; n = parent.get(n)) {
    const f = byId.get(n)!.callFrame
    out.push(`${f.functionName || "(anon)"} ${f.url.split("/").pop()?.split("?")[0] ?? ""}`)
  }
  return out
}
// Offset between the profile clock (ms) and performance.now(): first sample inside __walkMarker.
let offset = 0
for (let i = 0; i < profile.samples.length; i++) {
  if (stackOf(profile.samples[i]!).some((s) => s.startsWith("__walkMarker"))) {
    offset = sampleTimes[i]! - marker
    break
  }
}
const bucketsIn = (a: number, b: number) => {
  const m = new Map<string, number>()
  for (let i = 0; i < profile.samples.length; i++) {
    const t = sampleTimes[i]! - offset
    if (t < a || t > b) continue
    const dt = (profile.timeDeltas[i + 1] ?? 0) / 1000
    const stack = stackOf(profile.samples[i]!)
    if (stack[0]!.startsWith("(idle)")) continue
    let k = "other JS"
    for (const [label, re] of BUCKETS) if (stack.some((s) => re.test(s))) { k = label; break }
    if (k === "other JS" && stack[0]!.startsWith("(program)")) k = "browser"
    m.set(k, (m.get(k) ?? 0) + dt)
  }
  return [...m].sort((x, y) => y[1] - x[1]).filter(([, v]) => v >= 3).map(([k, v]) => `${k} ${Math.round(v)}`).join(", ")
}

// ---------------------------------------------------------------------------------------------- summary
type Walk = { frames: number[]; events: { t: number; kind: string; ms: number; what?: string }[]; loaf: { start: number; dur: number; scripts: string[] }[] }
const W = data.walk as Walk
const after = Number.isFinite(playable) ? playable : 0
const end = (data.walk as Walk).frames.at(-1) ?? 0
const hitches: { at: number; gap: number; why: string }[] = []
const gaps: number[] = []
for (let i = 1; i < W.frames.length; i++) {
  const a = W.frames[i - 1]!
  const b = W.frames[i]!
  if (a < after) continue
  gaps.push(b - a)
  if (b - a <= 33) continue
  const ev = new Map<string, { n: number; ms: number }>()
  for (const e of W.events) if (e.t >= a && e.t < b) {
    const v = ev.get(e.kind) ?? { n: 0, ms: 0 }
    v.n++
    v.ms += e.ms
    ev.set(e.kind, v)
  }
  for (const r of data.res) if (r.end >= a && r.end < b) ev.set(`loaded ${r.name}`, { n: 1, ms: 0 })
  for (const m of data.marks) if (m.t >= a && m.t < b && /^(mod:|pop:|boot:|body:)/.test(m.name)) ev.set(m.name, { n: 1, ms: 0 })
  const evs = [...ev].map(([k, v]) => (v.ms ? `${k}×${v.n} ${Math.round(v.ms)}ms` : k)).join(", ")
  hitches.push({ at: Math.round(a), gap: Math.round(b - a), why: `${evs}${evs ? " | " : ""}cpu: ${bucketsIn(a, b)}` })
}
const sorted = [...gaps].sort((x, y) => x - y)
const pops = data.marks.filter((m) => m.name.startsWith("pop:") && m.t >= after)
console.log(`\nboot-walk ${tag} · view=${view} · ${w}×${h} · cpu ${cpu}× · ${seconds}s · ${shell ? "headless-shell" : "chrome"}`)
console.log(`playable (loading screen gone): ${Math.round(playable)} ms · everything in: ${data.complete ? Math.round(data.complete) : "-"} ms · walk started ${walkStart - t0} ms after launch`)
console.log(`frames after playable: ${gaps.length} · median ${sorted[sorted.length >> 1]?.toFixed(1)} ms · p95 ${sorted[Math.floor(sorted.length * 0.95)]?.toFixed(1)} ms · worst ${sorted.at(-1)?.toFixed(0)} ms · hitches >33 ms: ${hitches.length} · >100 ms: ${hitches.filter((x) => x.gap > 100).length}`)
const ev = (kind: string) => W.events.filter((e) => e.kind === kind && e.t >= after)
console.log(`after playable: in-frame node builds ${ev("sync-node-build").length} (${Math.round(ev("sync-node-build").reduce((a, e) => a + e.ms, 0))} ms) · sync pipelines ${ev("sync-pipeline").length} · texture uploads ${ev("texture-upload").length} (${Math.round(ev("texture-upload").reduce((a, e) => a + e.ms, 0))} ms) · buffer uploads ${ev("buffer-upload").length} · audio decodes ${ev("audio-decode").length} · pop-ins in view ${pops.length}`)
console.log(`final position: ${pos.map((v) => v.toFixed(1)).join(", ")}`)
console.log(`\nhitches (ms from navigation):`)
for (const x of hitches.slice(0, 60)) console.log(`${String(x.at).padStart(7)}  ${String(x.gap).padStart(5)} ms  ${x.why}`)
if (pops.length) console.log(`\npop-ins in view: ${pops.slice(0, 30).map((p) => `${Math.round(p.t)} ${p.name.slice(4)}`).join(" · ")}`)
console.log(`\nmodule marks: ${data.marks.filter((m) => /^mod:.*:(first|shown)$|^boot:/.test(m.name)).map((m) => `${m.name} ${Math.round(m.t)}`).join(" · ")}`)
if (errors.length) console.log(`\nerrors: ${errors.slice(0, 6).join("\n")}`)
console.log(`\nvideo: ${video}`)
writeFileSync(`${outDir}/boot-walk-${tag}.json`, JSON.stringify({ playable, end, hitches, data, errors }, null, 1))
process.exit(0)
