// The Wendigo's antlers against the ceiling, headless: upright and on all fours in a storey-1 corridor, in the storey-1
// lift lobby, and climbing the core stair from the ground floor. An in-page sampler records, every frame, the antler
// tips' height (animator.antlerTop + root y) against the ceiling the hunter passes (`hunter.ceiling`); prints the
// lowest clearance per place and saves a capture of each (captures/hunter/ceiling-*.png).
//
//   bun scripts/hunter/ceiling.ts
import { OUT, inPage, launch, place, sleep } from "./lib"

const { browser, page, errors } = await launch("hunter=-50,0,4&hunterSeed=3&view=corridor")
const Y = (s: number) => 0.15 + s * 3.8 + 0.01
await inPage(page, () => {
  dispatchEvent(new KeyboardEvent("keydown", { code: "KeyF" }))
  dispatchEvent(new KeyboardEvent("keyup", { code: "KeyF" }))
  const hud = document.querySelector<HTMLElement>("#hud")
  if (hud) hud.style.display = "none"
})

/** Starts sampling clearance (ceiling − antler tips) under `label`. */
const sample = (label: string) =>
  inPage(page, ({ H }, label: string) => {
    type Rec = { min: number; n: number; over: number; ceil: number; top: number; at: number; overs: string[] }
    const g = globalThis as unknown as { __clear: Record<string, Rec>; __clearLabel: string; __clearOn: boolean }
    g.__clear ??= {}
    // (The first 1.6 s after a reposition is skipped: after a teleport the body's smoothed hips lag behind the root.)
    g.__clear[label] = { min: Infinity, n: 0, over: 0, ceil: 0, top: 0, at: performance.now() + 1600, overs: [] }
    g.__clearLabel = label
    if (g.__clearOn) return
    g.__clearOn = true
    const f = () => {
      const h = H.hunter
      const a = h.creature?.animator
      const rec = g.__clear[g.__clearLabel]
      if (a && rec && performance.now() > rec.at && Number.isFinite(h.ceiling) && a.antlerTop > 0) {
        const top = a.antlerTop + h.creature.root.position.y
        const c = h.ceiling - top
        rec.n++
        if (c < rec.min) {
          rec.min = c
          rec.ceil = h.ceiling
          rec.top = top
        }
        if (c < 0) {
          rec.over++
          if (rec.overs.length < 12) rec.overs.push(`t+${((performance.now() - rec.at) / 1000 + 1.6).toFixed(2)} ${h.stance} c=${c.toFixed(2)} at ${h.pos.x.toFixed(1)},${h.pos.y.toFixed(2)},${h.pos.z.toFixed(1)} v=${Math.hypot(h.vel.x, h.vel.z).toFixed(1)}`)
        }
      }
      requestAnimationFrame(f)
    }
    requestAnimationFrame(f)
  }, label)
const results = () => inPage(page, () => (globalThis as unknown as { __clear: Record<string, unknown> }).__clear)
/** Creature at (x, z, s), held, `stance` pinned, facing `heading`; not reacting to the player. */
const pose = (x: number, z: number, s: number, heading: number, stance: "biped" | "quad") =>
  inPage(page, ({ H }, a: { x: number; z: number; s: number; heading: number; stance: string }) => {
    const h = H.hunter
    h.spawn(a.x, a.z, a.s)
    h.hold(9999)
    h.grace = 9999
    h.heading = a.heading
    h.stance = a.stance
    h.stanceAt = h.time + 9999
  }, { x, z, s, heading, stance })

// Corridor, storey 1: upright, then on all fours, walking toward the camera.
await place(page, -12, Y(1), 0.4, Math.PI / 2, 0.12)
await pose(-24, 0, 1, Math.PI / 2, "biped")
await inPage(page, ({ H }) => H.hunter.creature && H.hunter.prepare())
await sleep(2500)
await sample("corridor upright (walking)")
await inPage(page, ({ H }) => {
  const h = H.hunter
  h.tasks = []
  h.task = { x: -16, z: 0, s: 1, look: 9999, kind: "go" }
  h.goTo(h.task)
})
await sleep(4500)
await page.screenshot({ path: `${OUT}/ceiling-corridor-upright.png` })
await sample("corridor all fours")
await pose(-19, 0, 1, Math.PI / 2, "quad")
await sleep(3000)
await page.screenshot({ path: `${OUT}/ceiling-corridor-quad.png` })

// Lift lobby, storey 1: upright, then on all fours (seen from the hall).
await place(page, -40.3, Y(1), 11.5, Math.PI, 0.18)
await sample("(teleport)")
await pose(-37.9, 18.2, 1, Math.PI, "quad")
await sleep(2500)
// Rising from all fours to upright under the lobby ceiling (sampling from the rise).
await inPage(page, ({ H }) => {
  const h = H.hunter
  h.stance = "biped"
  h.stanceAt = h.time
})
await sample("lift lobby upright (rising from all fours)")
await inPage(page, () => {
  const g = globalThis as unknown as { __clear: Record<string, { at: number }>; __clearLabel: string }
  g.__clear[g.__clearLabel]!.at = performance.now()
})
await sleep(3500)
await page.screenshot({ path: `${OUT}/ceiling-liftlobby-upright.png` })
await sample("lift lobby all fours")
await pose(-37.9, 18.2, 1, Math.PI, "quad")
await sleep(3000)
await page.screenshot({ path: `${OUT}/ceiling-liftlobby-quad.png` })

// The stair: up from the ground floor to storey 1 (on all fours, as it always takes the stair); watched from the landing.
await place(page, -42.4, Y(0), 16.9, Math.PI, 0.35)
await sample("stair, ground → storey 1")
await pose(-40.2, 8, 0, Math.PI, "quad")
await inPage(page, ({ H }) => {
  const h = H.hunter
  h.stanceAt = -9999
  h.tasks = []
  h.task = { x: -40.2, z: 8, s: 1, look: 9999, kind: "go" }
  h.goTo(h.task)
})
let shot = false
for (let i = 0; i < 160; i++) {
  await sleep(250)
  const st = await inPage(page, ({ H }) => ({ x: H.hunter.pos.x, y: H.hunter.pos.y, z: H.hunter.pos.z, s: H.hunter.s }))
  if (!shot && st.z > 19.6 && st.y > 0.9) {
    await page.screenshot({ path: `${OUT}/ceiling-stair.png` })
    shot = true
  }
  if (st.s === 1 && st.z < 16) break
}
// And from storey 1's landing, looking down the east flight as it arrives.
const r = await results()
console.log(JSON.stringify(r, (_k, v) => (typeof v === "number" ? +v.toFixed(3) : v), 1))
console.log(`errors: ${errors.slice(0, 3).join(" | ") || "none"}`)
await browser.close()
