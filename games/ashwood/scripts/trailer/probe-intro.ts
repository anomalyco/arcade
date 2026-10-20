// Stills of the intro drive at chosen cutscene seconds (stepped clock), to pick the trailer's opening segment.
//   bun scripts/trailer/probe-intro.ts 10 20 30
import { ROOT, Recorder, launch, open, run, waitWorld, type Any } from "./lib"

const times = process.argv.slice(2).map(Number)
const browser = await launch()
try {
  const { page, errors, cdp } = await open(browser, "http://localhost:5196/?intro", async (p) => {
    await waitWorld(p, "__ashwoodIntro")
  })
  const total = await run(page, () => (globalThis as Any).__ashwoodIntro.total)
  console.log("intro total", total)
  const rec = new Recorder(page, cdp, `${ROOT}/probe-intro`)
  await rec.start()
  for (const t of times) {
    await run(page, (t: number) => (globalThis as Any).__ashwoodIntro.seek(t), t)
    await rec.advance(20)
    await rec.record(1)
    console.log("t", t, "->", rec.n - 1)
  }
  if (errors.length) console.log(errors.slice(0, 5))
} finally {
  await browser.close()
}
