/**
 * Zombie behaviour trace (AR-91): bot-played headless games, logging per game hour how many of the dead are in each
 * behaviour activity and how many activities started, so you can see the day rest, night herds, followers and
 * searches happen without a browser, and what the activities cost on the wire (every zombie in town, so an upper bound
 * on one client's bubble; snapshots at 20 Hz against the previous one). CPU only.
 *
 *   bun scripts/behaviour-trace.ts [--seed=101] [--preset=Skilled] [--nights=2] [--today]
 */
import { ACTIVITY_NAMES } from "../shared/behaviour/activities"
import { behaviourOf } from "../shared/behaviour/mind"
import { diffPairs } from "../shared/behaviour/net"
import { runHeadlessBotGame } from "../shared/bot-runner"
import { dayCycle } from "../shared/day-cycle"
import { secondsToDawn } from "../shared/difficulty-ramp"
import type { BotSkillPresetId } from "../shared/survivor-bot"

const arg = (name: string, fallback: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback
const seed = Number(arg("seed", "101"))
const preset = arg("preset", "Skilled") as BotSkillPresetId
const nights = Number(arg("nights", "2"))
const today = process.argv.includes("--today")

let bucket = -1
let samples = 0
const acts = new Map<string, number>()
const states = new Map<string, number>()
let lastStarted: Record<string, number> = {}
const t0 = performance.now()
let prevPairs: number[] = []
let deltaBytes = 0
let deltas = 0
let maxDelta = 0
let maxFull = 0
const uvarLen = (n: number) => (n < 128 ? 1 : n < 16384 ? 2 : 3)

const res = runHeadlessBotGame({
  seed,
  preset,
  maxDurationSeconds: secondsToDawn(nights) + 10,
  sessionTuning: today ? ({ behaviour: { zbMode: 0 } } as never) : undefined,
  observe: (sim) => {
    const b = Math.floor(sim.time / 15)
    if (b !== bucket) {
      if (bucket >= 0 && samples > 0) flush(sim.hour, dayCycle(sim.hour).darkness)
      bucket = b
    }
    samples++
    const st = behaviourOf(sim)
    for (const a of sim.ai.agents) {
      if (a.state === "dead") continue
      states.set(a.state, (states.get(a.state) ?? 0) + 1)
      const act = st?.minds[a.id]?.act ?? 0
      if (act) acts.set(ACTIVITY_NAMES[act]!, (acts.get(ACTIVITY_NAMES[act]!) ?? 0) + 1)
    }
    if (st) lastStarted = st.started
    if (st) {
      const pairs: number[] = []
      for (const a of [...sim.ai.agents].sort((x, y) => x.id - y.id)) {
        const act = a.state === "dead" ? 0 : (st.minds[a.id]?.act ?? 0)
        if (act) pairs.push(a.id, act)
      }
      const changes = diffPairs(prevPairs, pairs)
      const bytes = changes.length ? uvarLen(changes.length / 2) + (changes.length / 2) * 3 : 0
      deltaBytes += bytes
      deltas++
      maxDelta = Math.max(maxDelta, bytes)
      maxFull = Math.max(maxFull, pairs.length ? uvarLen(pairs.length / 2) + (pairs.length / 2) * 3 : 0)
      prevPairs = pairs
    }
  },
})

function flush(hour: number, darkness: number) {
  const fmt = (m: Map<string, number>) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${(v / samples).toFixed(1)}`)
      .join(", ")
  console.log(`${hour.toFixed(1).padStart(5)}h dark ${darkness.toFixed(2)} | ${fmt(states)} | ${fmt(acts) || "-"}`)
  acts.clear()
  states.clear()
  samples = 0
}

console.log(`\n${preset} seed ${seed}: ${res.survived ? "survived" : `died at ${res.survivalTime.toFixed(0)} s (${res.causeOfDeath})`}, ${res.killsByWeapon.total} kills, ${res.damageTaken.toFixed(0)} damage`)
console.log("started:", JSON.stringify(lastStarted))
console.log(
  `wire: ${(deltaBytes / Math.max(1, deltas)).toFixed(2)} B per 20 Hz delta on average (${((deltaBytes / Math.max(1, deltas)) * 20 * 8 / 1000).toFixed(2)} kbit/s), max delta ${maxDelta} B, max full ${maxFull} B`,
)
console.log(`wall ${(performance.now() - t0).toFixed(0)} ms`)
