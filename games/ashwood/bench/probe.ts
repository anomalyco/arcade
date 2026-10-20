// Ad-hoc in-page probe on a frozen build: boots a route URL, then evaluates a JS file's default function in the page
// once the world is up and prints what it returns. For investigating per-frame behaviour (who calls what, how often).
//
//   bun bench/probe.ts --dir $TMP/ash-base --q "?play&start=arrival" --phase explore --script bench/probes/x.js [--wait 5000]
import { arg, launch, serve, TMP } from "./lib"

const args = process.argv.slice(2)
const dir = arg(args, "dir", `${TMP}/ash-base`)!
const q = arg(args, "q", "?play&start=arrival")!
const phase = arg(args, "phase", "explore")!
const script = arg(args, "script")!
const wait = Number(arg(args, "wait", "5000"))
const cpu = Number(arg(args, "cpu", "1"))
const server = serve(dir, 5227, { prefix: "/arcade/ashwood/", isolate: false })
const browser = await launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
const errors: string[] = []
page.on("pageerror", (e) => errors.push(e.message))
await page.goto(`http://localhost:5227/arcade/ashwood/${q}`)
await page.waitForFunction((p) => (globalThis as any).__static?.flow?.phase === p || (p === "any" && (globalThis as any).__ashwood?.complete), phase, { timeout: 300_000, polling: 250 })
await page.waitForTimeout(wait)
if (cpu > 1) await (await page.context().newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate: cpu })
const src = await Bun.file(script).text()
const out = await page.evaluate(`(${src})()`)
console.log(JSON.stringify(out, null, 1))
if (errors.length) console.error(errors.slice(0, 5))
await browser.close()
server.stop(true)
process.exit(0)
