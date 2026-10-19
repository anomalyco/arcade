// Boots the debug page with the hunter started in the lobby and its overlay on; prints the nav graph's stats, a few
// seconds of the hunter's state, and saves the overlay for each storey (captures/hunter/nav-s<n>.png).
//
//   bun scripts/hunter/probe.ts
import { mkdirSync, writeFileSync } from "node:fs"
import { OUT, frames, hunterState, inPage, launch, place } from "./lib"

mkdirSync(OUT, { recursive: true })
const { browser, page, errors } = await launch("hunter&hunterDebug&hunterSeed=7&view=corridor")
const stats = await inPage(page, ({ H }) => {
  const nav = H.nav
  return {
    buildMs: Math.round(nav.buildMs),
    doors: nav.doors.length,
    rooms: nav.rooms.length,
    perStorey: nav.grids.map((g: { walk: Uint8Array; comp: Int32Array; main: number; s: number }) => {
      let walk = 0
      let main = 0
      for (let i = 0; i < g.walk.length; i++) {
        if (g.walk[i]) walk++
        if (g.comp[i] === g.main) main++
      }
      return { s: g.s, walk, main, rooms: nav.rooms.filter((r: { s: number }) => r.s === g.s).length, doors: nav.doors.filter((d: { s: number }) => d.s === g.s).length }
    }),
    stairs: nav.stairs.map((f: { x: number; z: number; s: number }[]) => f.map((p) => `${p.s}:${p.x.toFixed(2)},${p.z.toFixed(2)}`).join(" → ")),
  }
})
console.log(JSON.stringify(stats, null, 1))
// Route checks: lobby → 3-08 and storey 4 → storey 0.
const routes = await inPage(page, ({ H }) => {
  const nav = H.nav
  const t0 = performance.now()
  const a = nav.route({ x: 0, z: 19, s: 0 }, { x: 6, z: -8, s: 3 })
  const t1 = performance.now()
  const b = nav.route({ x: 20, z: 0, s: 4 }, { x: -50, z: 0, s: 0 })
  const t2 = performance.now()
  return {
    lobbyTo308: a ? { length: +a.length.toFixed(1), pts: a.pts.length, doors: a.doors.map((d: { door: number }) => nav.doors[d.door].id), ms: +(t1 - t0).toFixed(1) } : null,
    s4ToS0: b ? { length: +b.length.toFixed(1), pts: b.pts.length, doors: b.doors.length, ms: +(t2 - t1).toFixed(1) } : null,
  }
})
console.log(JSON.stringify(routes))
for (let i = 0; i < 6; i++) {
  await frames(page, 60)
  console.log(JSON.stringify(await hunterState(page)))
}
for (let s = 0; s < 5; s++) {
  const url = await inPage(page, ({ H }, s: number) => H.trace(s, 8), s)
  writeFileSync(`${OUT}/nav-s${s}.png`, Buffer.from(url.split(",")[1]!, "base64"))
}
await place(page, 0, 0.16, 15, 0)
await frames(page, 30)
await page.screenshot({ path: `${OUT}/probe.png` })
console.log("errors:", errors.slice(0, 5))
await browser.close()
