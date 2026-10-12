// Plays bot-only matches and prints round lengths and how they ended, to tune pacing.
import { World } from "../shared/sim/world"

for (const seed of [1, 2, 3, 4]) {
  const w = new World(seed)
  w.start(seed % 2 ? "tdm" : "ffa", 5)
  let roundStart = 0
  const rows: string[] = []
  let kills = 0
  let rings = 0
  for (let i = 0; i < 30 * 60 * 25 && w.phase !== "match"; i++) {
    const before = w.phase
    w.step()
    for (const e of w.takeEvents()) {
      if (e.k === "kill") kills++
      if (e.k === "ring") rings++
      if (e.k === "round") rows.push(`r${e.round} ${(w.time - roundStart).toFixed(0)}s ${e.label} kills=${kills} rings=${rings}`)
    }
    if (before !== "live" && w.phase === "live") {
      roundStart = w.time
      kills = 0
      rings = 0
    }
  }
  console.log(`seed ${seed} ${w.mode}: ${rows.join(" | ")}`)
}
