/**
 * Bot nights across seeds (NIGHT.md tuning): you step out of camp and wait, torch off; three bots work the leads.
 * Prints each night's place, result, minutes and finds (clue@minute), then the win rate and median time.
 * CPU only: `hivemind run --kind cargo -- bun games/barbara/scripts/night-sweep.ts [nights] [first seed]`.
 */
import { createWoods, FEEL, stepWoods, type PlayerInput } from "../shared/sim"
import { makeWorld } from "../shared/world"

const world = makeWorld()
const nights = Number(process.argv[2] ?? 16), first = Number(process.argv[3] ?? 1), trace = process.argv.includes("--trace")
const rows: { won: boolean; minutes: number }[] = []
for (let seed = first; seed < first + nights; seed++) {
  const state = createWoods(world, 3, seed)
  const you = state.players[0]!
  you.x = world.camp.x; you.z = world.camp.z - world.camp.radius - 8
  const wait = new Map<number, PlayerInput>([[0, { yaw: 0, pitch: 0, light: false, tie: false, map: false, mx: 0, mz: 0 }]])
  let spares = 0
  for (let i = 0; i < 25 * 3600 && (state.night.phase === "camp" || state.night.phase === "search"); i++) {
    stepWoods(state, world, wait, 1 / 60, FEEL)
    for (const e of state.events) if (e.kind === "spare-taken") spares++
    if (trace && i % 1800 === 0) {
      const n = state.night
      console.log(`  t ${(state.t / 60).toFixed(1)} ` + state.brains.map((b) => {
        const p = state.players.find((q) => q.id === b.id)!, lead = n.bots[b.id], c = lead ? n.layout.clues[lead.clue]! : null
        return `[${b.id} ${b.mode} lead ${lead ? `${lead.clue}/${lead.step}` : "-"} at ${p.x.toFixed(0)},${p.z.toFixed(0)} to clue ${c ? Math.hypot(c.x - p.x, c.z - p.z).toFixed(0) : "-"} knows ${p.map.clues.join("")} ${p.light ? "lit" : "off"} ${p.charge.toFixed(2)}]`
      }).join(" "))
    }
  }
  const n = state.night
  const minutes = (n.end - n.start) / 60
  rows.push({ won: n.phase === "won", minutes })
  const charge = state.players.filter((p) => p.bot).map((p) => p.charge.toFixed(2) + (p.spare ? "+" : "")).join(" ")
  console.log(`seed ${seed} calls ${n.calls} ${n.phase.padEnd(4)} ${n.reason.padEnd(5)} ${minutes.toFixed(1).padStart(5)} min  finds ${n.finds.map((f) => `${f.clue}@${((f.at - n.start) / 60).toFixed(1)}`).join(" ")}  spares ${spares}  bots ${charge}`)
}
const won = rows.filter((r) => r.won).map((r) => r.minutes).sort((a, b) => a - b)
console.log(`won ${won.length}/${rows.length}, median ${won.length ? won[won.length >> 1]!.toFixed(1) : "-"} min`)
