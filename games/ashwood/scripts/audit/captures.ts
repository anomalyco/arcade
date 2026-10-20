// Evidence captures for the integration audit: icam views of each finding on the frozen build.
//   bun scripts/audit/captures.ts [names...]
import { mkdirSync } from "node:fs"
import { launch, AUDIT, OUT } from "./lib"

const SHOTS: Record<string, string> = {
  "roof-well": "-41.2,20.81,17.3,180,-40",
  "roof-lift-wall": "-37.9,20.81,17.6,180,-3",
  "roof-lift-inside": "-37.9,20.81,20.6,180,-70",
  "dock-bay-steps": "-23.95,1.81,-11.2,0,-8",
  "dock-leveller": "-33.9,2.9,-22.9,180,-25",
  "fire-flight": "-55.35,17.0,-0.2,0,-35",
  "west-door-10": "-52.3,1.81,-10,-90,0",
  "s4-lino-double": "-31,17.2,0,90,-35",
  "s0-north-tile": "-44.6,1.81,-18.5,0,0",
}
const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SHOTS)
mkdirSync(`${OUT}/shots`, { recursive: true })
const browser = await launch()
for (const n of names) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.goto(`${AUDIT}?shot=1&view=corridor&icam=${SHOTS[n]}`)
  await page.waitForFunction(() => ((globalThis as any).__afterhours?.frames ?? 0) >= 40, null, { timeout: 240_000 })
  await page.screenshot({ path: `${OUT}/shots/${n}.png` })
  console.log(`${OUT}/shots/${n}.png`)
  await page.close()
}
await browser.close()
