/** Browser regression for canvas-only captures hidden behind a DOM shell menu/loading screen. */
import { createServer } from "vite"
import { browserBudget } from "../browser-budget"

const server = await createServer({ configFile: false, server: { host: "127.0.0.1", port: 0 }, logLevel: "warn" })
server.middlewares.use("/__shell-proof", (_req, res) => { res.setHeader("Content-Type", "text/html"); res.end("<!doctype html><title>Shell capture proof</title>") })
try {
  await server.listen()
  const address = server.httpServer!.address()
  if (!address || typeof address === "string") throw new Error("No Vite address")
  await using budget = browserBudget()
  const browser = await budget.chromium.launch({ headless: true, args: ["--mute-audio"] })
  const page = await browser.newPage()
  await page.goto(`http://127.0.0.1:${address.port}/__shell-proof`)
  const cases = await page.evaluate(async () => {
    const path = "/packages/kit/proof/look.ts"
    const { captureCanvas } = await import(path)
    document.body.innerHTML = '<canvas width="100" height="100"></canvas><div class="arcade-shell"><div class="as-overlay" hidden></div><div class="as-loading" hidden></div></div>'
    const canvas = document.querySelector("canvas")!, shell = document.querySelector<HTMLElement>(".arcade-shell")!
    const menu = shell.querySelector<HTMLElement>(".as-overlay")!, loading = shell.querySelector<HTMLElement>(".as-loading")!
    for (const el of [menu, loading]) el.style.cssText = "position:fixed;inset:0;background:black"
    const check = (name: string, blocked: boolean) => {
      let error = ""
      try { captureCanvas(canvas, () => canvas.getContext("2d")!.fillRect(0, 0, 100, 100), () => ({ exposure: 1, time: 0 })) }
      catch (e) { error = String(e) }
      if (blocked ? !error.includes("shell-overlay:") : !!error) throw new Error(`${name}: ${error || "capture unexpectedly passed"}`)
      return name
    }
    const results = [check("hidden shell passes", false)]
    menu.hidden = false; results.push(check("visible menu fails", true))
    shell.style.opacity = "0"; results.push(check("transparent ancestor passes", false)); shell.style.opacity = "1"
    menu.hidden = true; loading.hidden = false; results.push(check("visible loading screen fails", true))
    loading.style.left = "2000px"; results.push(check("off-canvas loading screen passes", false))
    return results
  })
  console.log(`PASS shell-overlay: ${cases.join(", ")}`)
} finally { await server.close() }
