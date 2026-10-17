// Shared helpers for the integration audit scripts: a frozen build served on AH_BASE (default :5231, started by
// `bun scripts/audit/serve.ts <dir>`), the headless Metal browser (muted), and page helpers over the game's globals.
import { chromium, type Browser, type Page } from "playwright-core"
import { existsSync, readdirSync } from "node:fs"

export const BASE = process.env.AH_BASE ?? "http://localhost:5231/"
export const AUDIT = `${BASE}scripts/audit/audit.html`
export const OUT = process.env.AH_OUT ?? "$TMPDIR/ah-audit/out"

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

export type Logged = { page: string[]; console: string[] }

/** Opens the audit page (game + registry) and waits for the complete world. */
export async function open(browser: Browser, q: string, size: [number, number] = [960, 640], dpr = 1) {
  const page = await browser.newPage({ viewport: { width: size[0], height: size[1] }, deviceScaleFactor: dpr })
  const log: Logged = { page: [], console: [] }
  page.on("pageerror", (e) => log.page.push(e.message))
  page.on("console", (m) => (m.type() === "error" || m.type() === "warning") && log.console.push(`${m.type()}: ${m.text()}`))
  await page.goto(`${AUDIT}?${q}`)
  await page.waitForFunction(() => {
    const s = (globalThis as { __afterhours?: { ready: boolean; complete: boolean } }).__afterhours
    return !!s?.complete && s.ready
  }, null, { timeout: 300_000 })
  return { page, log }
}

/** Runs `fn(player, arg)` in the page with the player, ctx and doors. */
export const inPage = <T, R = unknown>(page: Page, fn: (g: any, arg: T) => R, arg: T): Promise<R> =>
  page.evaluate(({ src, arg }) => {
    const g = globalThis as any
    return new Function("g", "arg", `return (${src})(g, arg)`)({ p: g.__afterhoursPlayer, ctx: g.__afterhoursPlayer.ctx, doors: g.__afterhoursDoors, reg: g.__ahRegistry, interior: g.__interior, debug: g.__afterhoursDebug }, arg)
  }, { src: fn.toString(), arg }) as Promise<R>
