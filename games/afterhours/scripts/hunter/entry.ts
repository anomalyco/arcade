// The hunter's entry after the 3-08 radio beat, headless: the player stands in 3-08 and does the beat's three
// interactions (`__ashwoodTransmitter.switchOn()`, `.transmit()`, `.reveal()`); prints when each sound lands (scream,
// the car, glass, spawn), checks the horror layer is held off, and times the Wendigo from the lobby to storey 3 and 3-08.
//
//   bun scripts/hunter/entry.ts
import { writeFileSync } from "node:fs"
import { OUT, inPage, launch, place, sleep } from "./lib"

const { browser, page, errors } = await launch("view=corridor&hunterSeed=5")
await page.mouse.click(640, 360)
// In 3-08, by the rack, keeping still (the player's own noises would steer it).
await place(page, 9.6, 0.15 + 3 * 3.8 + 0.01, -10.5, -Math.PI / 2)
await sleep(1500)
type Tx = { phase: string; switchOn(): void; transmit(): void; reveal(): void }
const tx = <R>(fn: (t: Tx) => R) => inPage(page, (_a, src: string) => new Function("t", `return (${src})(t)`)((globalThis as unknown as { __ashwoodTransmitter: Tx }).__ashwoodTransmitter), fn.toString()) as Promise<R>
const waitPhase = async (p: string, s = 60) => {
  for (let i = 0; i < s * 4 && (await tx((t) => t.phase)) !== p; i++) await sleep(250)
  return tx((t) => t.phase)
}
await tx((t) => t.switchOn())
console.log("phase", await waitPhase("on"))
await tx((t) => t.transmit())
console.log("phase", await waitPhase("transmitted", 90))
const t0 = Date.now()
await tx((t) => t.reveal())
let spawnAt = -1
let s3At = -1
let roomAt = -1
let last = ""
while (Date.now() - t0 < 200_000) {
  const st = await inPage(page, ({ H }) => {
    const h = H.hunter
    return { mode: h.mode, s: h.s, x: h.pos.x, z: h.pos.z, horror: h.ctx.settings["audio.horrorLayer"], log: h.voice.log.filter((l: { id: string }) => /scream|bang|glass|shatter/.test(l.id)).map((l: { id: string }) => l.id) }
  })
  const t = (Date.now() - t0) / 1000
  const key = `${st.mode}|${st.s}|${st.log.join(",")}`
  if (key !== last) {
    console.log(`${t.toFixed(1).padStart(6)} s  mode ${st.mode}  storey ${st.s}  pos ${st.x.toFixed(1)},${st.z.toFixed(1)}  horrorLayer ${st.horror}  sounds [${st.log.join(", ")}]`)
    last = key
  }
  if (spawnAt < 0 && st.mode !== "dormant") spawnAt = t
  if (s3At < 0 && st.s === 3) s3At = t
  if (roomAt < 0 && st.s === 3 && st.x > 0.8 && st.x < 11.6 && st.z < -1.75) {
    roomAt = t
    break
  }
  await sleep(250)
}
console.log(`spawned ${spawnAt.toFixed(1)} s after the reveal; storey 3 ${(s3At - spawnAt).toFixed(1)} s after spawning; in 3-08 ${(roomAt - spawnAt).toFixed(1)} s after spawning`)
const url = await inPage(page, ({ H }) => H.trace(3, 10, 0))
writeFileSync(`${OUT}/entry-s3.png`, Buffer.from(url.split(",")[1]!, "base64"))
const url0 = await inPage(page, ({ H }) => H.trace(0, 10, 0))
writeFileSync(`${OUT}/entry-s0.png`, Buffer.from(url0.split(",")[1]!, "base64"))
console.log(`errors: ${errors.slice(0, 3).join(" | ") || "none"}`)
await browser.close()
