// Deterministic offline capture for the trailer. The page's clocks are virtualised by an init script: once `manual`
// starts, performance.now/Date.now return a virtual time, requestAnimationFrame callbacks and timers (> 0 ms) are
// queued and only run when `step()` advances the clock by exactly one frame, and Math.random is seeded. Each step waits
// for the GPU queue to drain, then the frame is grabbed with a CDP screenshot (DOM overlays included, so HUD is hidden
// by CSS). Same approach as bench/pixel (virtual clocks, seeded random) but with the real page, TAA and grain on.
// One headless browser, muted, Metal. Expects the dev server on :5196.
import { chromium, type Browser, type CDPSession, type Page } from "playwright-core"
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"

export const W = 1920
export const H = 1080
export const ROOT = `${import.meta.dir}/../../captures/trailer`
export type Any = any // eslint-disable-line @typescript-eslint/no-explicit-any

const INIT = `(() => {
  const realNow = performance.now.bind(performance)
  const realDate = Date.now.bind(Date)
  const realRAF = window.requestAnimationFrame.bind(window)
  const realCAF = window.cancelAnimationFrame.bind(window)
  const realST = window.setTimeout.bind(window)
  const realCT = window.clearTimeout.bind(window)
  const realSI = window.setInterval.bind(window)
  const realCI = window.clearInterval.bind(window)
  const T = (window.__trailer = { manual: false, v: 0, d0: 0, q: new Map(), timers: new Map(), id: 1, frames: 0 })
  performance.now = () => (T.manual ? T.v : realNow())
  Date.now = () => (T.manual ? T.d0 + T.v : realDate())
  window.requestAnimationFrame = (cb) => {
    const id = T.id++
    if (T.manual) T.q.set(id, cb)
    else {
      const rid = realRAF((t) => {
        if (T.manual) T.q.set(id, cb)
        else { T.q.delete(id); cb(t) }
      })
      T.q.set(id, { real: rid })
    }
    return id
  }
  window.cancelAnimationFrame = (id) => {
    const e = T.q.get(id)
    if (e && e.real) realCAF(e.real)
    T.q.delete(id)
  }
  const mkTimer = (repeat) => (fn, ms, ...a) => {
    ms = Number(ms) || 0
    if (!T.manual || ms <= 0) return repeat ? realSI(fn, ms, ...a) : realST(fn, ms, ...a)
    const id = 1e9 + T.id++
    T.timers.set(id, { fn: typeof fn === "function" ? fn : () => eval(fn), at: T.v + ms, ms, repeat, a })
    return id
  }
  window.setTimeout = mkTimer(false)
  window.setInterval = mkTimer(true)
  window.clearTimeout = (id) => (id >= 1e9 ? T.timers.delete(id) : realCT(id))
  window.clearInterval = (id) => (id >= 1e9 ? T.timers.delete(id) : realCI(id))
  const seed = (s) => {
    let a = s >>> 0
    Math.random = () => {
      a = (a + 0x6d2b79f5) >>> 0
      let x = a
      x = Math.imul(x ^ (x >>> 15), x | 1)
      x ^= x + Math.imul(x ^ (x >>> 7), x | 61)
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296
    }
  }
  T.seed = seed
  T.start = (s) => {
    T.v = Math.ceil(realNow())
    T.d0 = realDate() - T.v
    seed(s ?? 12345)
    T.manual = true
  }
  T.hooks = []
  // Advance one frame: due timers, then frame hooks (camera paths), then the queued rAF callbacks.
  T.step = async (dt) => {
    T.v += dt * 1000
    for (;;) {
      let next = null
      for (const [id, t] of T.timers) if (t.at <= T.v && (!next || t.at < next[1].at)) next = [id, t]
      if (!next) break
      const [id, t] = next
      if (t.repeat) t.at += Math.max(1, t.ms)
      else T.timers.delete(id)
      try { t.fn(...t.a) } catch (e) { console.error(e) }
      await Promise.resolve()
    }
    for (const h of T.hooks) h(dt, T.v)
    const q = [...T.q].filter(([, cb]) => typeof cb === "function")
    for (const [id] of q) T.q.delete(id)
    for (const [, cb] of q) cb(T.v)
    T.frames++
    const dev = window.__ashwoodDebug?.renderer?.backend?.device
    if (dev) await dev.queue.onSubmittedWorkDone()
  }
  // Hide every overlay for the trailer (HUD, hints, objective, loader).
  const css = document.createElement("style")
  css.textContent = "body.trailer * { visibility: hidden !important } body.trailer canvas#view { visibility: visible !important }"
  document.addEventListener("DOMContentLoaded", () => document.head.appendChild(css))
})()`

export async function launch(): Promise<Browser> {
  const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
  const chrome = readdirSync(cache)
    .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
    .sort()
    .reverse()
    .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
    .find(existsSync)
  return chromium.launch({ executablePath: chrome, headless: true, args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist"] })
}

export async function open(browser: Browser, url: string, ready: (p: Page) => Promise<unknown>, hideDom = true) {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text())
    if (m.text().startsWith("trailer:")) console.log("  [page]", m.text())
  })
  await page.routeWebSocket(/.*/, () => {})
  await page.addInitScript(INIT)
  await page.goto(url)
  await ready(page)
  if (hideDom) await page.evaluate(() => document.body.classList.add("trailer"))
  const cdp = await page.context().newCDPSession(page)
  return { page, errors, cdp }
}

export const waitWorld = (page: Page, extra = "") =>
  page.waitForFunction(
    (extra) => {
      const s = (globalThis as Any).__ashwood
      return !!s?.complete && s.frames > 30 && (!extra || !!(globalThis as Any)[extra])
    },
    extra,
    { timeout: 400_000, polling: 500 },
  )

export class Recorder {
  n = 0
  constructor(
    readonly page: Page,
    readonly cdp: CDPSession,
    readonly dir: string,
    readonly fps = 30,
    readonly sub = 2,
  ) {
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
  }
  start(seed = 12345) {
    return this.page.evaluate((s) => (globalThis as Any).__trailer.start(s), seed)
  }
  /** Advance without recording (warm-up, TAA settle). */
  async advance(frames: number) {
    const dt = 1 / (this.fps * this.sub)
    await this.page.evaluate(
      async ({ n, dt }) => {
        for (let i = 0; i < n; i++) await (globalThis as Any).__trailer.step(dt)
      },
      { n: frames * this.sub, dt },
    )
  }
  /** Record `frames` output frames (each = `sub` simulation steps). `each(i)` runs before each output frame. */
  async record(frames: number, each?: (i: number) => Promise<void>) {
    const dt = 1 / (this.fps * this.sub)
    for (let i = 0; i < frames; i++) {
      if (each) await each(i)
      await this.page.evaluate(
        async ({ n, dt }) => {
          for (let k = 0; k < n; k++) await (globalThis as Any).__trailer.step(dt)
        },
        { n: this.sub, dt },
      )
      const shot = (await this.cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 94 })) as { data: string }
      writeFileSync(`${this.dir}/${String(this.n++).padStart(5, "0")}.jpg`, Buffer.from(shot.data, "base64"))
    }
  }
  encode(out: string) {
    const r = Bun.spawnSync(["ffmpeg", "-y", "-loglevel", "error", "-framerate", String(this.fps), "-i", `${this.dir}/%05d.jpg`, "-c:v", "libx264", "-crf", "14", "-pix_fmt", "yuv420p", out])
    if (r.exitCode !== 0) console.error(r.stderr.toString())
    return out
  }
}

/** Runs `fn(arg)` in the page with the debug globals handy. */
export function run<T, R>(page: Page, fn: (arg: T) => R, arg?: T): Promise<R> {
  return page.evaluate(({ src, arg }) => new Function("arg", `return (${src})(arg)`)(arg), { src: fn.toString(), arg }) as Promise<R>
}
