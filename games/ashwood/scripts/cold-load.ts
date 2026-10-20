// True cold load of ASHWOOD as an outside tester gets it: installed Chrome (new headless, WebGPU), a fresh profile and
// empty cache, CPU throttled, network throttled. Records time to the menu (home screen up) and to playable (the world is
// warm: #shell[data-world=ready]), bytes per asset type (on the wire vs decoded, and the Content-Encoding served),
// requests that failed, main-thread long tasks, and peak JS heap.
//
//   bun scripts/cold-load.ts                                  # live URL, 50 Mbps, 4× CPU
//   bun scripts/cold-load.ts --mbps 10 --tag live-10
//   bun scripts/cold-load.ts --url http://localhost:5198/arcade/ashwood/ --tag local   # e.g. a `vite preview` of dist
//   bun scripts/cold-load.ts --block models/npc/       # abort every request whose URL contains this (hang hunting)
//   bun scripts/cold-load.ts --stall characters/anims.glb # a request that never completes
//   bun scripts/cold-load.ts --lose-device-at 6000     # crash the GPU process mid-boot (device-lost handling)
//
// One browser, 1280×720, muted, closed at the end. Writes captures/cold-load-<tag>.json.
import { chromium } from "playwright-core"
import { mkdirSync, writeFileSync } from "node:fs"

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`)
  if (i < 0) return undefined
  const v = args[i + 1]
  args.splice(i, 2)
  return v
}
const url = flag("url") ?? "https://anoma.ly/arcade/ashwood/"
const mbps = Number(flag("mbps") ?? 50)
const cpu = Number(flag("cpu") ?? 4)
const tag = flag("tag") ?? `live-${mbps}`
const block = flag("block")
const loseAt = flag("lose-device-at")
const stallUrl = flag("stall")
const timeoutS = Number(flag("timeout") ?? 300)
const outDir = `${import.meta.dir}/../captures`
mkdirSync(outDir, { recursive: true })

const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist"],
})
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
const page = await context.newPage()
const errors: string[] = []
page.on("pageerror", (e) => errors.push(e.message.slice(0, 300)))
page.on("console", (m) => (m.type() === "error" || m.type() === "warning") && errors.push(`${m.type()}: ${m.text().slice(0, 300)}`))
const cdp = await context.newCDPSession(page)
await cdp.send("Network.enable")
await cdp.send("Network.setCacheDisabled", { cacheDisabled: true })
await cdp.send("Network.emulateNetworkConditions", {
  offline: false,
  latency: 40,
  downloadThroughput: (mbps * 1e6) / 8,
  uploadThroughput: (10 * 1e6) / 8,
})
if (cpu > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu })
await cdp.send("Performance.enable")
if (block) await page.route((u) => u.href.includes(block), (r) => r.abort())
// A request that never answers (the handler never continues it): a stalled download.
if (stallUrl) await page.route((u) => u.href.includes(stallUrl), () => {})

type Req = { url: string; type: string; enc: string; status: number; wire: number; decoded: number; start: number; end: number; failed?: string }
const reqs = new Map<string, Req>()
let t0 = 0
cdp.on("Network.requestWillBeSent", (e: { requestId: string; request: { url: string }; timestamp: number }) => {
  t0 ||= e.timestamp
  reqs.set(e.requestId, { url: e.request.url, type: "", enc: "", status: 0, wire: 0, decoded: 0, start: e.timestamp - t0, end: 0 })
})
cdp.on("Network.responseReceived", (e: { requestId: string; response: { status: number; mimeType: string; headers: Record<string, string> } }) => {
  const r = reqs.get(e.requestId)
  if (!r) return
  const h = Object.fromEntries(Object.entries(e.response.headers).map(([k, v]) => [k.toLowerCase(), v]))
  r.status = e.response.status
  r.enc = h["content-encoding"] ?? "none"
  r.type = e.response.mimeType
})
cdp.on("Network.dataReceived", (e: { requestId: string; dataLength: number }) => {
  const r = reqs.get(e.requestId)
  if (r) r.decoded += e.dataLength
})
cdp.on("Network.loadingFinished", (e: { requestId: string; encodedDataLength: number; timestamp: number }) => {
  const r = reqs.get(e.requestId)
  if (!r) return
  r.wire = e.encodedDataLength
  r.end = e.timestamp - t0
})
cdp.on("Network.loadingFailed", (e: { requestId: string; errorText: string; timestamp: number }) => {
  const r = reqs.get(e.requestId)
  if (!r) return
  r.failed = e.errorText
  r.end = e.timestamp - t0
})

await page.addInitScript(() => {
  const g = globalThis as unknown as { __cold: { long: { start: number; dur: number }[] } }
  g.__cold = { long: [] }
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) g.__cold.long.push({ start: e.startTime, dur: e.duration })
  }).observe({ type: "longtask", buffered: true })
})

let peakHeap = 0
const heapTimer = setInterval(async () => {
  try {
    const { metrics } = (await cdp.send("Performance.getMetrics")) as { metrics: { name: string; value: number }[] }
    peakHeap = Math.max(peakHeap, metrics.find((m) => m.name === "JSHeapUsedSize")?.value ?? 0)
  } catch {}
}, 500)

const started = Date.now()
await page.goto(url, { waitUntil: "commit" })
// Device loss for real: crash the GPU process (CDP Browser.crashGpuProcess; device.destroy() would be reported as an intentional "destroyed").
if (loseAt)
  setTimeout(() => {
    void browser
      .newBrowserCDPSession()
      .then((b) => b.send("Browser.crashGpuProcess"))
      .then(() => console.log(`GPU process crashed at ${loseAt} ms`))
      .catch((e: Error) => console.log(`GPU crash failed: ${e.message}`))
  }, Number(loseAt))
const menu = await page
  .waitForFunction(() => (document.querySelector("#shell") ? performance.now() : null), undefined, { timeout: 60_000, polling: 100 })
  .then((h) => h.jsonValue() as Promise<number>)
  .catch(() => NaN)
const playable = await page
  .waitForFunction(
    () => {
      const s = document.querySelector<HTMLElement>("#shell")
      return s && (s.dataset.world === "ready" || s.dataset.world === "failed") ? { t: performance.now(), state: s.dataset.world } : null
    },
    undefined,
    { timeout: timeoutS * 1000, polling: 250 },
  )
  .then((h) => h.jsonValue() as Promise<{ t: number; state: string }>)
  .catch(() => ({ t: NaN, state: "timeout" }))
const page2 = await page.evaluate(() => {
  const g = globalThis as unknown as { __cold: { long: { start: number; dur: number }[] }; __ashwood?: { errors: string[] }; __ashwoodDebug?: { renderer: { info: { memory: Record<string, number> } } } }
  const label = document.querySelector(".shell-load span")?.textContent ?? ""
  return { long: g.__cold.long, errors: g.__ashwood?.errors ?? [], label, memory: g.__ashwoodDebug?.renderer.info.memory ?? null }
})
clearInterval(heapTimer)
await context.close()
await browser.close()

// ---------------------------------------------------------------------------------------------- summary
const ext = (u: string) => {
  const p = new URL(u).pathname
  const m = /\.([a-z0-9]+)$/.exec(p)
  return m ? m[1]! : p.endsWith("/") ? "html" : "other"
}
const byExt = new Map<string, { n: number; wire: number; decoded: number; enc: Set<string> }>()
const list = [...reqs.values()].filter((r) => !r.url.startsWith("data:") && !r.url.startsWith("blob:"))
for (const r of list) {
  const k = ext(r.url)
  const v = byExt.get(k) ?? { n: 0, wire: 0, decoded: 0, enc: new Set() }
  v.n++
  v.wire += r.wire
  v.decoded += r.decoded
  v.enc.add(r.enc)
  byExt.set(k, v)
}
const mb = (b: number) => (b / 1e6).toFixed(1)
const totalWire = list.reduce((a, r) => a + r.wire, 0)
const totalDecoded = list.reduce((a, r) => a + r.decoded, 0)
const failed = list.filter((r) => r.failed || r.status >= 400)
const lastByte = Math.max(...list.map((r) => r.end)) * 1000
const longSum = page2.long.reduce((a, t) => a + t.dur, 0)
console.log(`\ncold-load ${tag} · ${url} · ${mbps} Mbps · cpu ${cpu}× · 1280×720`)
console.log(`menu: ${Math.round(menu)} ms · playable: ${Math.round(playable.t)} ms (${playable.state}) · last byte ${Math.round(lastByte)} ms · wall ${((Date.now() - started) / 1000).toFixed(0)} s`)
console.log(`requests ${list.length} · on the wire ${mb(totalWire)} MB · decoded ${mb(totalDecoded)} MB · failed ${failed.length}`)
console.log(`long tasks: ${page2.long.length} · total ${Math.round(longSum)} ms · longest ${Math.round(Math.max(0, ...page2.long.map((t) => t.dur)))} ms · peak JS heap ${mb(peakHeap)} MB · renderer memory ${JSON.stringify(page2.memory)}`)
console.log(`loading label at the end: "${page2.label}"`)
console.log(`\n${"type".padEnd(6)} ${"n".padStart(4)} ${"wire MB".padStart(8)} ${"decoded".padStart(8)}  encoding`)
for (const [k, v] of [...byExt].sort((a, b) => b[1].wire - a[1].wire)) console.log(`${k.padEnd(6)} ${String(v.n).padStart(4)} ${mb(v.wire).padStart(8)} ${mb(v.decoded).padStart(8)}  ${[...v.enc].join(",")}`)
if (failed.length) console.log(`\nfailed:\n${failed.slice(0, 15).map((r) => `  ${r.status || ""} ${r.failed ?? ""} ${r.url}`).join("\n")}`)
const big = [...list].sort((a, b) => b.wire - a.wire).slice(0, 12)
console.log(`\nbiggest: ${big.map((r) => `${new URL(r.url).pathname.split("/").slice(-2).join("/")} ${mb(r.wire)}`).join(" · ")}`)
if (errors.length || page2.errors.length) console.log(`\npage errors/warnings:\n${[...page2.errors, ...errors].slice(0, 12).join("\n")}`)
writeFileSync(`${outDir}/cold-load-${tag}.json`, JSON.stringify({ menu, playable, lastByte, reqs: list, long: page2.long, peakHeap, errors, status: page2 }, null, 1))
process.exit(0)
