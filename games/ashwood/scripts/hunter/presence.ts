// The hunter's presence soundscape, headless: it roams the ground floor (biased to the key trail there) while the
// player stands still on storey 1 above. Records every sound it makes (voice.log, wrapped to add where the creature
// was at that instant), then checks each traces to it: within 2.5 m of it, or at what it caused (the duct grille the
// breath came out of, a door within 2.5 m of it, a lamp within 7 m of it). Prints rate, variety and level at the ear.
//
//   bun scripts/hunter/presence.ts [seconds=120]
import { writeFileSync } from "node:fs"
import { OUT, inPage, launch, place, sleep } from "./lib"

const secs = Number(process.argv[2] ?? 120)
const { browser, page, errors } = await launch("hunter=-30,0,0&hunterSeed=21&view=corridor")
await page.mouse.click(640, 360)
await place(page, -30, 0.15 + 3.8 + 0.01, 0, 0)
await inPage(page, ({ H }) => {
  const h = H.hunter
  h.grace = 9999 // it doesn't react to the player: this is about what it sounds like going about
  h.release()
  const v = h.voice
  const rec = v.record.bind(v)
  const g = globalThis as unknown as { __pres: unknown[] }
  g.__pres = []
  v.record = (id: string, p: { x: number; y: number; z: number }, gain: number, walls: number, heard: number) => {
    g.__pres.push({ t: +h.time.toFixed(2), id, x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2), walls, heard: +heard.toFixed(4), hx: +h.pos.x.toFixed(2), hy: +h.pos.y.toFixed(2), hz: +h.pos.z.toFixed(2), mode: h.mode })
    return rec(id, p, gain, walls, heard)
  }
})
await sleep(secs * 1000)
const out = await inPage(page, () => (globalThis as unknown as { __pres: { t: number; id: string; x: number; y: number; z: number; walls: number; heard: number; hx: number; hy: number; hz: number; mode: string }[] }).__pres)
await browser.close()

const classify = (e: (typeof out)[number]) => {
  const d = Math.hypot(e.x - e.hx, e.z - e.hz)
  const dy = Math.abs(e.y - e.hy)
  if (e.id === "duct-breath") return Math.abs(e.z) < 0.01 ? "grille the duct carries its breath to" : "?"
  if (e.id === "creak" || /^door-/.test(e.id)) return d < 2.6 ? "door beside it" : "?"
  if (e.id === "light-fluoro-flicker" || e.id === "tube-buzz") return d < 7.2 ? "lamp over it" : "?"
  return d < 2.5 && dy < 3.2 ? "at the creature" : "?"
}
const kinds: Record<string, number> = {}
const traced: Record<string, number> = {}
let bad = 0
const lines = out.map((e) => {
  const c = classify(e)
  if (c === "?") bad++
  traced[c] = (traced[c] ?? 0) + 1
  const k = e.id.replace(/^foot-.*/, "footstep")
  kinds[k] = (kinds[k] ?? 0) + 1
  return `${e.t.toFixed(1).padStart(6)}  ${e.id.padEnd(22)} at ${e.x},${e.y},${e.z}  creature ${e.mode} ${e.hx},${e.hy},${e.hz}  walls ${e.walls}  ear level ${e.heard}  → ${c}`
})
writeFileSync(`${OUT}/presence.log`, lines.join("\n") + "\n")
const presence = out.filter((e) => !/^foot-|^claws$|^thud$/.test(e.id))
const audible = presence.filter((e) => e.heard >= 0.002)
console.log(`${out.length} sounds in ${secs} s (${presence.length} presence events besides footsteps/claws/thuds: one every ${(secs / Math.max(1, presence.length)).toFixed(1)} s; ${audible.length} loud enough to play at the ear on storey 1)`)
console.log("by kind:", JSON.stringify(kinds))
console.log("traced to:", JSON.stringify(traced), `untraced: ${bad}`)
let repeats = 0
for (let i = 1; i < presence.length; i++) if (presence[i]!.id === presence[i - 1]!.id) repeats++
console.log(`back-to-back repeats among presence events: ${repeats}/${Math.max(0, presence.length - 1)}`)
console.log(`errors: ${errors.slice(0, 3).join(" | ") || "none"}`)
