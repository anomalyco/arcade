// Re-trains every shipped policy (src/pretrained/<creature>-<task>.json) with the headless trainer, one at a time.
//   bun scripts/pretrain.ts [--workers 4] [--only biped] [--task wall]
// Any change to the sim, the creatures, the observation or the reward changes what a policy does, so retrain then
// (tests/es.test.ts fails until you do: each file must replay to exactly its recorded score).

import { parseArgs } from "node:util"
import { CREATURE_IDS } from "../shared/creatures"
import { fits, TASK_IDS } from "../shared/tasks"

const { values } = parseArgs({ options: { workers: { type: "string", default: "4" }, only: { type: "string" }, task: { type: "string" } } })
const GENS: Record<string, number> = { biped: 2500, quadruped: 1000, worm: 1000 }
/** Seeds that differ from 1 (ES varies a lot by seed: seed 1 stalled the biped room run at 14 m and the quadruped
 *  course run at 7 m, seed 2 crosses it). */
const SEEDS: Record<string, number> = { "biped-room": 8, "quadruped-course": 2 }
for (const creature of CREATURE_IDS) {
  if (values.only && values.only !== creature) continue
  for (const task of TASK_IDS) {
    if (values.task && values.task !== task) continue
    // The heist thief is trained separately (scripts/train.ts --task heist --until-stage 4; see AGENTS.md).
    if (!fits(creature, task) || task === "heist") continue
    const out = `src/pretrained/${creature}-${task}.json`
    const args = ["scripts/train.ts", "--creature", creature, "--task", task, "--gens", String(GENS[creature]), "--workers", values.workers, "--seed", String(SEEDS[`${creature}-${task}`] ?? 1), "--every", "500", "--out", out]
    console.log(`\n== ${creature} / ${task}`)
    const proc = Bun.spawn(["bun", ...args], { cwd: `${import.meta.dir}/..`, stdout: "inherit", stderr: "inherit" })
    if ((await proc.exited) !== 0) process.exit(1)
  }
}
