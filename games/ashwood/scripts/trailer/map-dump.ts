// Dumps the clipboard map's drawn sheets (the game's own page renderer, `__ashwoodMap.dump`) as PNGs for the trailer's
// map shot: captures/trailer/map/page-<n>.png. Story chapter `--story` sets what's marked (default after-call).
//   bun scripts/trailer/map-dump.ts [--story after-call]
import { mkdirSync, writeFileSync } from "node:fs"
import { ROOT, launch, open, run, waitWorld, type Any } from "./lib"

const si = process.argv.indexOf("--story")
const story = si > 0 ? process.argv[si + 1] : "after-call"
const out = `${ROOT}/map`
mkdirSync(out, { recursive: true })
const browser = await launch()
try {
  const { page, errors } = await open(browser, `http://localhost:5196/?view=corridor&story=${story}&map=1`, (p) => waitWorld(p, "__ashwoodMap"))
  await page.waitForTimeout(6000)
  await page.waitForFunction(() => (globalThis as Any).__ashwoodMap.ready(), null, { timeout: 120_000 })
  const titles = (await run(page, () => (globalThis as Any).__ashwoodMap.titles)) as string[]
  console.log("titles", titles)
  for (let p = 0; p <= titles.length; p++) {
    const url = (await run(page, (p: number) => (globalThis as Any).__ashwoodMap.dump(p), p)) as string | null
    if (!url) continue
    writeFileSync(`${out}/page-${p}.png`, Buffer.from(url.split(",")[1]!, "base64"))
    console.log("page", p)
  }
  if (errors.length) console.log(errors.slice(0, 4))
} finally {
  await browser.close()
}
