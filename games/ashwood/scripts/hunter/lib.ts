// Shared helpers for the hunter's headless scripts (one browser, ≤ 1280×720, muted, Metal). Expects the dev server on
// :5196. Swallows Vite's HMR socket so other agents' saves don't reload the page mid-run.
import { chromium, type Page } from "playwright-core"
import { existsSync, readdirSync } from "node:fs"

export const OUT = `${import.meta.dir}/../../captures/hunter`

export async function launch(query: string, size = { width: 1280, height: 720 }) {
  const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
  const chrome = readdirSync(cache)
    .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
    .sort()
    .reverse()
    .map((n) => `${cache}/${n}/chrome-headless-shell-mac-arm64/chrome-headless-shell`)
    .find(existsSync)
  const browser = await chromium.launch({
    executablePath: chrome,
    headless: true,
    args: ["--enable-unsafe-webgpu", "--mute-audio", "--use-angle=metal", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"],
  })
  const context = await browser.newContext({ viewport: size, recordVideo: process.env.HUNTER_VIDEO ? { dir: process.env.HUNTER_VIDEO, size } : undefined })
  const page = await context.newPage()
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text())
    if (m.text().startsWith("hunter:")) console.log("  [page]", m.text())
  })
  await page.routeWebSocket(/.*/, () => {})
  const t0 = Date.now()
  await page.goto(`http://localhost:5196/?${query}`)
  await page.waitForFunction(() => {
    const s = (globalThis as { __ashwood?: { ready: boolean; complete: boolean } }).__ashwood
    return !!s?.complete && s.ready && !!(globalThis as { __ashwoodHunter?: unknown }).__ashwoodHunter
  }, null, { timeout: 300_000 })
  /** Seconds from the page opening (the start of a recorded video) to the world being ready. */
  const readyS = (Date.now() - t0) / 1000
  return { browser, context, page, errors, readyS }
}

/** Runs `fn(api, arg)` in the page with api = { H (hunter handle bag), P (player), A (audio) }. */
export function inPage<T, R>(page: Page, fn: (api: Api, arg: T) => R, arg?: T): Promise<R> {
  return page.evaluate(
    ({ src, arg }) => {
      const g = globalThis as unknown as { __ashwoodHunter: unknown; __ashwoodPlayer: unknown; __ashwoodAudio: unknown; __ashwoodDoors: unknown }
      const api = { H: g.__ashwoodHunter, P: g.__ashwoodPlayer, A: g.__ashwoodAudio, D: g.__ashwoodDoors }
      return new Function("api", "arg", `return (${src})(api, arg)`)(api, arg)
    },
    { src: fn.toString(), arg },
  ) as Promise<R>
}

// Loose page-side types (the scripts only read and poke).
/* eslint-disable @typescript-eslint/no-explicit-any */
export type Api = { H: any; P: any; A: any; D: any }

export async function frames(page: Page, n: number) {
  await page.evaluate(
    (n) =>
      new Promise<void>((res) => {
        let k = 0
        const f = () => (++k >= n ? res() : requestAnimationFrame(f))
        requestAnimationFrame(f)
      }),
    n,
  )
}

/** Puts the player's feet at (x, y, z) facing yaw. */
export function place(page: Page, x: number, y: number, z: number, yaw = 0, pitch = 0) {
  return inPage(
    page,
    ({ P }, a: number[]) => {
      P.pos.x = a[0]
      P.pos.y = a[1]
      P.pos.z = a[2]
      P.yaw = a[3]
      P.pitch = a[4]
      P.fly = false
      P.resetMotion()
    },
    [x, y, z, yaw, pitch],
  )
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function hunterState(page: Page) {
  return inPage(page, ({ H, P }) => ({
    mode: H.hunter.mode as string,
    x: +H.hunter.pos.x.toFixed(2),
    y: +H.hunter.pos.y.toFixed(2),
    z: +H.hunter.pos.z.toFixed(2),
    s: H.hunter.s as number,
    aware: +H.hunter.awareness.toFixed(2),
    seeing: H.hunter.seeing as boolean,
    catches: H.hunter.catches as number,
    player: { x: +P.pos.x.toFixed(2), y: +P.pos.y.toFixed(2), z: +P.pos.z.toFixed(2) },
  }))
}
