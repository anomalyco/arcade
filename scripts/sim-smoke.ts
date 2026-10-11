// Bots-only balance runner: `bun scripts/sim-smoke.ts [seeds=8] [rounds=6] [-v] [--no-heli]`.
import { DT, HEAD_START_SECONDS, INTRO_SECONDS } from "../shared/config"
import { BOT_NAMES } from "../shared/names"
import { World, type Participant } from "../shared/sim/world"

const args = process.argv.slice(2).filter((a) => !a.startsWith("-"))
const verbose = process.argv.includes("-v")
const noHeli = process.argv.includes("--no-heli")
const seeds = Number(args[0] ?? 8)
const rounds = Number(args[1] ?? 6)

type Row = { seed: number; round: number; escaped: boolean; t: number; seen: number; heli: number; stars: number; backup: number; gadgets: number; flats: number; spins: number; how: string }
const rows: Row[] = []

for (let seed = 1; seed <= seeds; seed++) {
  const ps: Participant[] = []
  for (let k = 0; k < 5; k++) ps.push({ id: `bot${k}`, name: BOT_NAMES[k]!, human: false, picks: { robber: ["muscle", "compact", "muscle", "compact", "muscle"][k]!, cop: k % 2 ? "interceptor" : "cruiser" } })
  const w = new World(seed * 7919, ps)
  if (noHeli) w.heliDelay = Infinity
  let row: Row | null = null
  for (let i = 0; i < 30 * 400 * rounds && w.round < rounds; i++) {
    if (w.phase === "chase" && !row) row = { seed, round: w.round, escaped: false, t: 0, seen: 0, heli: 0, stars: 1, backup: 0, gadgets: 0, flats: 0, spins: 0, how: "" }
    w.step(DT)
    if (row && w.phase === "chase") {
      if (w.seen) row.seen += DT
      if (w.heli.lock > 0) row.heli += DT
      row.stars = Math.max(row.stars, w.stars)
    }
    for (const e of w.drainEvents()) {
      if (verbose && e.kind !== "near") console.log(`  ${seed}/${w.round} ${w.t.toFixed(1)} ${e.kind}: ${e.text}`)
      if (!row) continue
      if (e.kind === "gadget") row.gadgets++
      if (e.kind === "flat") row.flats++
      if (e.kind === "spinout") row.spins++
      if (e.kind === "dispatch" && e.text.startsWith("Backup")) row.backup++
      if (e.kind === "end") row.how = e.text
    }
    if (row && w.phase === "end") {
      row.escaped = w.escaped
      row.t = w.t - INTRO_SECONDS - HEAD_START_SECONDS
      rows.push(row)
      row = null
    }
  }
}

const pct = (n: number) => `${Math.round((100 * n) / Math.max(1, rows.length))}%`
const avg = (f: (r: Row) => number, rs = rows) => rs.reduce((a, r) => a + f(r), 0) / Math.max(1, rs.length)
for (const r of rows)
  console.log(
    `seed ${r.seed} round ${r.round}: ${r.escaped ? "ESCAPE" : "BUST  "} chase ${r.t.toFixed(0).padStart(3)} s  seen ${r.seen.toFixed(0).padStart(3)} s  heli ${r.heli.toFixed(0).padStart(3)} s  stars ${r.stars}  backup ${r.backup}  gadgets ${r.gadgets}  flats ${r.flats}  spins ${r.spins}  ${r.how}`,
  )
const esc = rows.filter((r) => r.escaped)
console.log(
  `\n${rows.length} rounds: escapes ${pct(esc.length)}, timeouts ${pct(rows.filter((r) => r.how.includes("TIME")).length)}, avg chase ${avg((r) => r.t).toFixed(1)} s (escape ${avg((r) => r.t, esc).toFixed(1)} s), seen ${avg((r) => r.seen).toFixed(1)} s, heli lock ${avg((r) => r.heli).toFixed(1)} s, max stars ${avg((r) => r.stars).toFixed(2)}, backups ${avg((r) => r.backup).toFixed(2)}, gadgets ${avg((r) => r.gadgets).toFixed(1)}, flats ${avg((r) => r.flats).toFixed(2)}, spinouts ${avg((r) => r.spins).toFixed(2)}`,
)
