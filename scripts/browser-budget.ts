import { chromium as playwrightChromium, type Browser, type BrowserContext } from "playwright-core"
import { Worker } from "node:worker_threads"

/** One deadline for the whole script, including repeated/concurrent launches. */
export function browserBudget() {
  const seconds = Number(process.env.ARCADE_BROWSER_BUDGET_S ?? 180)
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 300) {
    throw new Error("ARCADE_BROWSER_BUDGET_S must be greater than 0 and at most 300")
  }
  console.log(`[browser-budget] ${seconds}s wall-clock budget (+3s shutdown grace)`)
  const browsers = new Set<Browser | BrowserContext>()
  const launching = new Set<Promise<Browser | BrowserContext>>()
  let disposed = false
  let closing: Promise<void> | undefined
  let finishing: Promise<void> | undefined
  let expired = false

  async function close() {
    if (closing) return closing
    disposed = true
    closing = (async () => {
      // Also cover scripts that forgot their own finally or failed before reaching it.
      try {
        // A failed member of Promise.all may leave another launch still in flight.
        await Promise.allSettled([...launching])
        await Promise.allSettled([...browsers].map(browser => browser.close()))
      } finally {
        browsers.clear()
      }
    })()
    return closing
  }

  async function exit(code: number = 0): Promise<never> {
    // Playwright's exit hook force-kills its Chromium process groups if graceful close stalls.
    const kill = setTimeout(() => process.exit(expired ? 124 : code), 3_000)
    try {
      await close()
    } finally {
      clearTimeout(kill)
      process.exit(expired ? 124 : code)
    }
  }

  const expire = () => {
    if (expired) return
    expired = true
    console.error(`[browser-budget] exceeded ${seconds}s; closing Chromium`)
    void exit(124)
  }
  process.on("SIGUSR2", expire)
  const watchdog = new Worker(new URL("./browser-budget-watchdog.mjs", import.meta.url), {
    workerData: { pid: process.pid, milliseconds: seconds * 1_000 },
  })
  watchdog.unref()
  const deadline = setTimeout(expire, seconds * 1_000)
  deadline.unref()

  async function track<T extends Browser | BrowserContext>(launch: () => Promise<T>): Promise<T> {
    if (disposed) throw new Error("Browser budget already closed")
    const pending = launch().then(browser => {
      browsers.add(browser)
      return browser
    })
    launching.add(pending)
    try {
      const browser = await pending
      if (disposed) throw new Error("Browser launched after its budget closed")
      return browser
    } finally {
      launching.delete(pending)
    }
  }

  const chromium = new Proxy(playwrightChromium, {
    get(target, key) {
      if (key === "launch") return (options: Parameters<typeof target.launch>[0]) => track(() => target.launch({
        ...options, headless: true, args: [...(options?.args ?? []), "--mute-audio"],
      }))
      if (key === "launchPersistentContext") return (dir: string, options: Parameters<typeof target.launchPersistentContext>[1]) => track(() => target.launchPersistentContext(dir, {
        ...options, headless: true, args: [...(options?.args ?? []), "--mute-audio"],
      }))
      const value = Reflect.get(target, key)
      return typeof value === "function" ? value.bind(target) : value
    },
  })

  function finish(): Promise<void> {
    return finishing ??= (async () => {
      const kill = setTimeout(() => {
        console.error("[browser-budget] Chromium close stalled; terminating")
        process.exit(expired ? 124 : 1)
      }, 3_000)
      try {
        await close()
      } finally {
        clearTimeout(kill)
        clearTimeout(deadline)
        await watchdog.terminate()
        process.off("SIGUSR2", expire)
      }
    })()
  }

  return {
    chromium,
    exit,
    // Close all browsers and retire the deadline before browser-free encoding.
    // This is final: the disposed budget cannot launch again.
    finish,
    [Symbol.asyncDispose]: finish,
  }
}
