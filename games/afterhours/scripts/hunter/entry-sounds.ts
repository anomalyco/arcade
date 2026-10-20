// Every sound event from the 3-08 reveal through the hunter's entry and its first 60 s inside, headless, with where it
// came from, and a check that each one traces to the creature, the scripted entry, or the room the player is in.
//   - wraps the engine's `sfx.play` (every shipped sample: positional or not), and the door system's procedural voice
//     (release, latch, bump, rattle, tick, creak: the non-positional ones);
//   - adds the creature voice's own procedural sounds (claws, breath, shatter) from `voice.log`, and the horror layer's
//     and the outdoor night's logs;
//   - classifies each: creature (within 2.5 m of the creature at that moment), entry (scream / car / glass), door
//     (which door, whether the creature moved it), room (the player's own surroundings: 3-08's rack, lamps, CRTs),
//     player (footsteps, flashlight), ambience (thunder, night), or UNEXPLAINED; flags anything above the roof slab and
//     any horror-layer event.
//
//   bun scripts/hunter/entry-sounds.ts [--sprint]   # --sprint: the player sprints on storey 3 after the spawn
import { writeFileSync } from "node:fs"
import { OUT, inPage, launch, place, sleep } from "./lib"

const sprint = process.argv.includes("--sprint")
const { browser, page, errors } = await launch("view=corridor&hunterSeed=5")
await page.mouse.click(640, 360)
await place(page, 9.6, 0.15 + 3 * 3.8 + 0.01, -10.5, -Math.PI / 2)
await sleep(1500)

// Instrument.
await inPage(page, ({ H, A, D }) => {
  type Ev = { t: number; src: string; id: string; pos: { x: number; y: number; z: number } | null; gain: number; note?: string; hunter: { x: number; y: number; z: number; mode: string } }
  const g = globalThis as unknown as { __snd: Ev[]; __t0: number }
  g.__snd = []
  g.__t0 = performance.now()
  const h = H.hunter
  const now = () => +((performance.now() - g.__t0) / 1000).toFixed(2)
  const hp = () => ({ x: +h.pos.x.toFixed(1), y: +h.pos.y.toFixed(2), z: +h.pos.z.toFixed(1), mode: h.mode })
  const sfx = A.sfx
  const play = sfx.play.bind(sfx)
  sfx.play = (id: string, o: { pos?: { x: number; y: number; z: number }; gain?: number; bus: string }) => {
    const r = play(id, o)
    if (r) g.__snd.push({ t: now(), src: `sfx:${o.bus}`, id, pos: o.pos ? { x: +o.pos.x.toFixed(1), y: +o.pos.y.toFixed(2), z: +o.pos.z.toFixed(1) } : null, gain: o.gain ?? 1, hunter: hp() })
    return r
  }
  const da = (D as { audio: Record<string, (...a: unknown[]) => unknown> }).audio
  for (const m of ["release", "latch", "bump", "rattle", "tick", "motion", "moveStart", "control"]) {
    const f = da[m]!.bind(da)
    let lastMotion = -1
    da[m] = (...a: unknown[]) => {
      const voice = a.find((x) => x && typeof x === "object" && "x" in (x as object)) as { x: number; y: number; z: number } | undefined
      const t = now()
      if (m !== "motion" || t - lastMotion > 0.5) g.__snd.push({ t, src: "door-proc", id: `${m}:${typeof a[0] === "string" ? a[0] : ""}`, pos: voice ? { x: +voice.x.toFixed(1), y: +voice.y.toFixed(2), z: +voice.z.toFixed(1) } : null, gain: 0, note: m === "motion" ? `door ${a[0]}` : undefined, hunter: hp() })
      if (m === "motion") lastMotion = t
      return f(...a)
    }
  }
  h.voice.log.length = 0
})

type Tx = { phase: string; switchOn(): void; transmit(): void; reveal(): void }
const tx = <R>(fn: (t: Tx) => R) => inPage(page, (_a, src: string) => new Function("t", `return (${src})(t)`)((globalThis as unknown as { __ashwoodTransmitter: Tx }).__ashwoodTransmitter), fn.toString()) as Promise<R>
const waitPhase = async (p: string, s = 90) => {
  for (let i = 0; i < s * 4 && (await tx((t) => t.phase)) !== p; i++) await sleep(250)
}
await tx((t) => t.switchOn())
await waitPhase("on")
await tx((t) => t.transmit())
await waitPhase("transmitted")
const revealAt = await inPage(page, () => +((performance.now() - (globalThis as unknown as { __t0: number }).__t0) / 1000).toFixed(2))
await tx((t) => t.reveal())
// Until the spawn, then 60 s.
let spawnAt = -1
for (let i = 0; i < 400; i++) {
  await sleep(250)
  const m = await inPage(page, ({ H }) => H.hunter.mode as string)
  if (m !== "dormant") {
    spawnAt = await inPage(page, () => +((performance.now() - (globalThis as unknown as { __t0: number }).__t0) / 1000).toFixed(2))
    break
  }
}
if (sprint) {
  await sleep(3000)
  // Sprint up and down the storey-3 spine.
  for (const [x, yaw] of [[-20, Math.PI / 2], [10, -Math.PI / 2]] as const) {
    await place(page, x === -20 ? 8 : -20, 0.15 + 3 * 3.8 + 0.01, 0, yaw)
    await inPage(page, () => ["KeyW", "ShiftLeft"].forEach((code) => dispatchEvent(new KeyboardEvent("keydown", { code }))))
    await sleep(5000)
    await inPage(page, () => ["KeyW", "ShiftLeft"].forEach((code) => dispatchEvent(new KeyboardEvent("keyup", { code }))))
  }
}
await sleep(60_000)
const data = await inPage(page, ({ H, A }) => {
  const g = globalThis as unknown as { __snd: unknown[]; __t0: number }
  return {
    snd: g.__snd,
    voice: H.hunter.voice.log,
    trail: H.hunter.trail,
    horror: A.horror.log,
    horrorLevel: A.horror.level,
    night: A.ambience.night?.log ?? [],
    t0: g.__t0,
    hunterT0: performance.now() / 1000 - H.hunter.time,
  }
})
await browser.close()

type Ev = { t: number; src: string; id: string; pos: { x: number; y: number; z: number } | null; gain: number; note?: string; hunter: { x: number; y: number; z: number; mode: string } }
const ROOF = 0.15 + 5 * 3.8
const PLAYER = { x: 9.6, z: -10.5 }
const classify = (e: Ev): string => {
  const p = e.pos
  if (/^foot-/.test(e.id) && !p) return "player: footstep"
  if (e.id === "int-flashlight" || e.id === "ui-notify") return "player: interface"
  if (e.id === "amb-thunder" || e.src === "sfx:ambience" && !p) return "ambience: weather"
  if (e.id === "wen2-huge-scream" && p && p.z > 30) return "entry: far scream (outside, by the car)"
  if ((e.id === "hor-metal-bang" || e.id === "story-car-alarm") && p && p.z > 30) return "entry: the car destroyed (audio/story.ts)"
  if (p && Math.hypot(p.x - 0, p.z - 21.8) < 1.5 && Math.abs(p.y - 1.3) < 0.5) return "entry: lobby glass"
  if (e.hunter.mode !== "dormant" && p && Math.hypot(p.x - e.hunter.x, p.z - e.hunter.z) < 2.5 && Math.abs(p.y - e.hunter.y) < 3) return "creature"
  if (e.id === "light-fluoro-flicker" && p && e.src === "sfx:horror") return "creature: lamp flickering near it"
  if (p && Math.hypot(p.x - PLAYER.x, p.z - PLAYER.z) < 8 && Math.abs(p.y - 13.2) < 3) return "room: 3-08 (player's surroundings)"
  if (e.src === "sfx:ambience" && p) return "ambience: positional (lamps, CRTs, night)"
  if (e.src === "sfx:doors" && p) return "door: positional"
  if (e.src === "door-proc") return p ? "door: procedural at a door" : "door: procedural NON-POSITIONAL"
  return "UNEXPLAINED"
}
const rows = (data.snd as Ev[]).map((e) => ({ ...e, cls: classify(e) }))
// The creature voice's procedural sounds (not through sfx.play): claws, breath, shatter.
const vlog = (data.voice as { t: number; id: string; x: number; y: number; z: number; heard: number }[]).filter((v) => !/^(foot-|wen|door-|hor-|int-|light-)/.test(v.id))
const lines = rows.map((r) => `${(r.t - revealAt).toFixed(1).padStart(6)}  ${r.cls.padEnd(42)} ${r.id.padEnd(22)} ${r.pos ? `${r.pos.x},${r.pos.y},${r.pos.z}` : "(no position)"}   creature ${r.hunter.mode} ${r.hunter.x},${r.hunter.y},${r.hunter.z}`)
writeFileSync(`${OUT}/entry-sounds${sprint ? "-sprint" : ""}.log`, `t after reveal (s), class, id, position, creature at the time\n${lines.join("\n")}\n\ncreature procedural (voice.log, t on page clock): ${vlog.length}\n${vlog.map((v) => `${v.id} ${v.x},${v.y},${v.z} heard ${v.heard}`).join("\n")}\n`)
const count: Record<string, number> = {}
for (const r of rows) count[r.cls] = (count[r.cls] ?? 0) + 1
console.log(`reveal at ${revealAt} s, spawn ${(spawnAt - revealAt).toFixed(1)} s after it; ${rows.length} sample/door events + ${vlog.length} creature procedural`)
console.log(JSON.stringify(count, null, 1))
const bad = rows.filter((r) => r.cls === "UNEXPLAINED" || r.cls.includes("NON-POSITIONAL") || (r.pos && r.pos.y > ROOF - 0.5) || /^hor-/.test(r.id) && !r.cls.startsWith("entry") && !r.cls.startsWith("creature"))
console.log(`flagged (unexplained, non-positional doors, above the roof, stray horror): ${bad.length}`)
for (const b of bad.slice(0, 30)) console.log(`  ${(b.t - revealAt).toFixed(1)} ${b.cls} ${b.id} ${b.pos ? `${b.pos.x},${b.pos.y},${b.pos.z}` : "-"} ${b.note ?? ""}`)
console.log(`horror layer: level ${data.horrorLevel}, events ${JSON.stringify(data.horror)}; night one-shots ${JSON.stringify(data.night.slice(-6))}`)
console.log(`errors: ${errors.slice(0, 3).join(" | ") || "none"}`)
