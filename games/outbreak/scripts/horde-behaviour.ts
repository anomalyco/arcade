// How well a crowd gets somewhere, A* against flow fields: a horde re-sent to a goal every second (as a horde
// directive does) splits around the hardware store or funnels through its front door. Reports arrivals over time,
// wall crossings outside the doorway and the crowd step cost.
//
// Usage (via the fleet): hivemind run --kind browser -- bun scripts/horde-behaviour.ts [--sizes=60,400]
import { inRect } from "@arcade/kit/sim/geom"
import { Rng } from "@arcade/kit/sim/rng"
import { createAIAgent, type AIAgent } from "../shared/ai"
import { TICK_DT } from "../shared/clock"
import { CoopSim } from "../shared/coop-sim"

const HARDWARE = [53, 23, 73, 38] as const
const arg = (name: string, fallback: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback
const sizes = arg("sizes", "60,400").split(",").map(Number)

type Scenario = "split" | "funnel"

function scenario(kind: Scenario, n: number, flowFields: number) {
  const sim = new CoopSim(7, 7, 0.22, { zombieCount: 0, directorPacing: 0, startHour: 23, flowFields })
  sim.addSurvivor("player", 0)
  Object.assign(sim.slots[0]!.survivor, { x: 28, y: 57, flashlightOn: false })
  sim.ai.agents.length = 0
  if (kind === "funnel") {
    sim.town.doors.find((d) => d.id === "hardware-front")!.open = true
    sim.rebuildCollision()
  }
  const goal = kind === "split" ? ([80, 30.5] as const) : ([63, 33] as const)
  const box = kind === "split" ? [40, 22, 50, 52] : [44, 41, 76, 54]
  const rng = new Rng(0x40de)
  const horde: AIAgent[] = []
  for (let id = 1; horde.length < n; id++) {
    const x = rng.range(box[0]!, box[2]!)
    const y = rng.range(box[1]!, box[3]!)
    if (!sim.ai.nav.walkable({ x, y })) continue
    const a = createAIAgent(id, sim.town.seed, x, y)
    sim.ai.agents.push(a)
    horde.push(a)
  }
  const arrived = (a: AIAgent) =>
    kind === "split" ? a.x > HARDWARE[2] && Math.hypot(a.x - goal[0], a.y - goal[1]) < 16 : inRect(a.x, a.y, HARDWARE)
  const lastY = new Map(horde.map((a) => [a.id, a.y]))
  let badCrossings = 0
  const curve: Record<string, number> = {}
  const stepMs: number[] = []
  const slot = sim.slots[0]!
  for (let t = 0; t <= 90 * 60; t++) {
    if (t % 60 === 0) {
      for (const a of horde) {
        if (a.state !== "wander" && a.state !== "investigate" && a.state !== "search") continue
        if (Math.hypot(a.x - goal[0], a.y - goal[1]) < 2.5) continue
        Object.assign(a, { state: "investigate", targetX: goal[0], targetY: goal[1], targetKind: "noise" })
        a.awareness = Math.max(a.awareness, 0.6)
      }
    }
    slot.survivor.health = slot.survivor.maxHealth
    sim.stepSurvivor(slot, { mx: 0, my: 0, aim: 0, interact: false }, TICK_DT)
    const t0 = performance.now()
    sim.stepWorld(TICK_DT, 240)
    stepMs.push(performance.now() - t0)
    for (const a of horde) {
      const prev = lastY.get(a.id)!
      if (kind === "funnel" && prev > HARDWARE[3] && a.y <= HARDWARE[3] && (a.x < 57.4 || a.x > 60)) badCrossings++
      lastY.set(a.id, a.y)
    }
    if (t > 0 && t % (15 * 60) === 0) curve[`${t / 60}s`] = +(horde.filter(arrived).length / n).toFixed(3)
  }
  stepMs.sort((a, b) => a - b)
  return {
    scenario: kind,
    zombies: n,
    nav: flowFields ? "flow" : "astar",
    arrived: curve,
    badCrossings,
    stepMs: { p50: +stepMs[stepMs.length >> 1]!.toFixed(3), p95: +stepMs[Math.floor(stepMs.length * 0.95)]!.toFixed(3) },
  }
}

const rows = []
for (const kind of ["split", "funnel"] as const) {
  for (const n of sizes) {
    for (const flow of [0, 2]) rows.push(scenario(kind, n, flow))
  }
}
console.log(JSON.stringify(rows, null, 1))
