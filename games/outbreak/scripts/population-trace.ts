// Zombie population over a played day: a survivor walks round town, then drives across it and out, through day 1,
// night 1 and day 2 at the game's own time scale and settings. Logs, each game hour, the living dead (all, near the
// survivor, in the active chunks), the director's wanted population and cap, spawns and the night ramp.
//
// Usage: bun scripts/population-trace.ts [--hours=30] [--seed=7] [--json=out.json]
import { writeFileSync } from "node:fs"
import { TICK_DT } from "../shared/clock"
import { LocalSession } from "../shared/session"
import type { Command } from "../shared/sim-types"
import { createOutbreakSettings, resolveWorldMode } from "../src/settings"

const arg = (name: string, fallback: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback
const hours = Number(arg("hours", "30"))
const seed = Number(arg("seed", "7"))
const jsonOut = arg("json", "")

const settings = createOutbreakSettings()
const session = new LocalSession(seed, settings.world.houseSeed, settings.world.terrain, settings.ai, settings.progression, resolveWorldMode(settings.world.worldMode))
const sim = session.sim
const me = session.slot
const timeScale = settings.dayCycle.timeScale

/** Roads run through the middle of every 96 m block; crossroads at 44 + 96k. */
const road = (k: number) => 44 + 96 * k
const walkLoop = [
  [road(0), road(0) + 30],
  [road(0), road(0) - 30],
  [road(0) + 30, road(0)],
  [road(0) - 30, road(0)],
] as const
const driveLoop = [
  [road(3), road(0)],
  [road(3), road(2)],
  [road(-1), road(2)],
  [road(-1), road(-1)],
  [road(5), road(-1)],
  [road(5), road(0)],
  [road(0), road(0)],
] as const

let wp = 0
let driving = false
const steerTo = (x: number, y: number): Command => {
  const p = me.survivor
  if (!driving) {
    const d = Math.hypot(x - p.x, y - p.y) || 1
    return { mx: (x - p.x) / d, my: (y - p.y) / d, aim: Math.atan2(y - p.y, x - p.x), interact: false }
  }
  // Points the car down the road each tick (the route is all straight road), then floors it.
  const v = sim.vehicles.byId(p.vehicleId ?? -1)!
  v.h = Math.atan2(y - v.y, x - v.x)
  const s = Math.hypot(v.vx, v.vy)
  v.vx = Math.cos(v.h) * s
  v.vy = Math.sin(v.h) * s
  return { mx: 0, my: -1, aim: v.h, interact: false }
}

type Row = Record<string, number | string>
const rows: Row[] = []
const t0 = performance.now()
let lastHour = -1
let spawnedBefore = 0
let ticks = 0
for (; sim.elapsedHours < hours; ticks++) {
  const p = me.survivor
  p.health = p.maxHealth
  const route = driving ? driveLoop : walkLoop
  const [tx, ty] = route[wp % route.length]!
  if (driving && !sim.vehicles.byId(p.vehicleId ?? -1)) driving = false
  const here = driving ? sim.vehicles.byId(p.vehicleId ?? -1)! : p
  if (Math.hypot(tx - here.x, ty - here.y) < (driving ? 8 : 2)) wp++
  // After the first game hour and a half on foot, get in a ready car and drive the loop.
  if (!driving && sim.elapsedHours > 1.5) {
    if (p.vehicleId) sim.vehicles.leaveSeat(me.id, p)
    Object.assign(p, { x: road(0) + 3, y: road(0) + 4, vehicleId: null })
    const v = sim.vehicles.spawnVehicle("sedan", road(0), road(0) + 4, 0, { fuel: 100, hasKeys: true, hasBattery: true, hp: 1e6 })
    if (sim.vehicles.enter(me, v, sim.progression, sim.ai, sim.time)) {
      driving = true
      wp = 0
    }
  }
  if (driving) {
    const v = sim.vehicles.byId(p.vehicleId ?? -1)
    if (v) v.fuel = v.maxFuel
  }
  session.update(TICK_DT, steerTo(tx, ty), timeScale, settings)
  const hourMark = Math.floor(sim.elapsedHours * 2)
  if (hourMark !== lastHour) {
    lastHour = hourMark
    const tel = sim.ai.pacing.telemetry
    let living = 0
    let near60 = 0
    let near120 = 0
    let inActive = 0
    for (const a of sim.ai.agents) {
      if (a.state === "dead") continue
      living++
      const d = Math.hypot(a.x - p.x, a.y - p.y)
      if (d < 60) near60++
      if (d < 120) near120++
      const key = `${Math.floor(a.x / 32)},${Math.floor(a.y / 32)}`
      if (sim.worldStream.activeChunks.has(key)) inActive++
    }
    const spawned = (sim.ai as unknown as { nextAgentId: number }).nextAgentId
    const row: Row = {
      h: Number(sim.elapsedHours.toFixed(1)),
      hour: Number(sim.hour.toFixed(1)),
      x: Math.round(p.x),
      y: Math.round(p.y),
      drv: driving ? 1 : 0,
      living,
      inActive,
      near60,
      near120,
      dead: sim.ai.agents.length - living,
      want: tel.desiredPopulation,
      cap: tel.effectiveMaxActive,
      ramp: Number(tel.ramp.toFixed(2)),
      threat: Number(tel.threat.toFixed(2)),
      newIds: spawned - spawnedBefore,
      chunks: sim.worldStream.activeChunks.size,
      esc: JSON.stringify(sim.ai.pacing.escalation),
    }
    spawnedBefore = spawned
    rows.push(row)
    console.log(Object.entries(row).map(([k, v]) => `${k}=${v}`).join(" "))
  }
}
console.log(`ticks=${ticks} wall=${((performance.now() - t0) / 1000).toFixed(1)}s`)
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(rows, null, 2))
