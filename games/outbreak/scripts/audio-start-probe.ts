// What sounds at a fresh solo start, without playing any audio: runs the offline LocalSession with the shipped default
// settings, feeds every frame to the SoundDirector exactly as the game does, and logs each one-shot, each held loop
// and each AI noise (alarms, cans, gunshots) with its distance from the survivor.
//
//   bun scripts/audio-start-probe.ts [--seed 7] [--seconds 60] [--walk]   (--walk: after 3 s, head down to the street and
//   sprint east into streamed lots, then south)
import { TICK_DT } from "../shared/clock"
import { LocalSession } from "../shared/session"
import { SoundDirector } from "../src/audio/director"
import { soundWorld } from "../src/audio/world"
import { createOutbreakSettings, resolveWorldMode } from "../src/settings"

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? Number(process.argv[i + 1]) : fallback
}
const seed = arg("seed", 7)
const seconds = arg("seconds", 60)
const settings = createOutbreakSettings(new URLSearchParams())
const session = new LocalSession(seed, settings.world.houseSeed, settings.world.terrain, settings.ai, settings.progression, resolveWorldMode(settings.world.worldMode))
const director = new SoundDirector()
const p = session.view.player
const idle = { mx: 0, my: 0, aim: 0, interact: false }
const walk = process.argv.includes("--walk")
const command = (t: number) => {
  if (!walk || t < 3) return idle
  if (p.y < 44.5 && p.x < 40) return { ...idle, my: 1 }
  return p.x < 200 ? { ...idle, mx: 1, sprint: true } : { ...idle, my: 1, sprint: true }
}
const log: { t: number; kind: string; id: string; dist: number }[] = []
const heldSince = new Map<string, number>()
const noises = new Set<number>()
const dist = (x: number, y: number) => Math.round(Math.hypot(x - p.x, y - p.y) * 10) / 10

console.log(`seed ${seed}: spawn (${p.x.toFixed(1)}, ${p.y.toFixed(1)}) hour ${session.view.hour.toFixed(2)} time ${session.view.time.toFixed(2)}`)
const frames = Math.round(seconds / TICK_DT)
for (let f = 0; f <= frames; f++) {
  if (f > 0) session.update(TICK_DT, command(f * TICK_DT), settings.dayCycle.timeScale, settings)
  const t = Math.round(f * TICK_DT * 100) / 100
  for (const e of director.observe(soundWorld(session.sim), p)) log.push({ t, kind: "play", id: `${e.id}${e.gain ? ` ×${e.gain}` : ""}`, dist: dist(e.x, e.y) })
  const wanted = new Set<string>()
  for (const h of director.holds) {
    wanted.add(h.key)
    if (!heldSince.has(h.key)) heldSince.set(h.key, t), log.push({ t, kind: "hold+", id: `${h.id} (${h.key})`, dist: dist(h.x, h.y) })
  }
  for (const [key, since] of heldSince) if (!wanted.has(key)) heldSince.delete(key), log.push({ t, kind: "hold-", id: `${key} after ${(t - since).toFixed(2)} s`, dist: 0 })
  for (const n of session.sim.ai.noiseBus.events) {
    if (noises.has(n.id)) continue
    noises.add(n.id)
    log.push({ t, kind: "noise", id: `${n.kind} r${n.radius} from ${n.sourceId}`, dist: dist(n.x, n.y) })
  }
  for (const v of session.view.vehicles) if (v.horn || v.engineOn) log.push({ t, kind: "vehicle", id: `${v.id} horn=${v.horn} engine=${v.engineOn}`, dist: dist(v.x, v.y) })
}
for (const e of log) console.log(`${e.t.toFixed(2).padStart(6)} s  ${e.kind.padEnd(7)} ${e.id.padEnd(48)} ${e.dist} m`)
console.log(`${log.length} entries`)
