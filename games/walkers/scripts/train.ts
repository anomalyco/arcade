// Headless trainer: the same sim, policy and ES as the page, on Bun Workers. Writes the best policy as JSON (the page
// ships these as the pre-trained walkers).
//   bun scripts/train.ts --creature biped --task room --gens 300 --workers 4 [--out src/pretrained/biped-room.json]
//   [--hidden 16] [--pairs 32] [--sigma 0.06] [--lr 0.03] [--seed 1] [--minutes 20] [--init <policy.json>]
//   [--course-seed 1] [--stage 0] [--no-curriculum] [--laser-speed 1] [--until-stage 4]

import { parseArgs } from "node:util"
import { cpus } from "node:os"
import { CREATURE_IDS, type CreatureId } from "../shared/creatures"
import { DEFAULT_REWARD } from "../shared/episode"
import { DEFAULT_ES } from "../shared/es"
import { envFor, TASK_IDS, type TaskId } from "../shared/tasks"
import { parsePolicy, Trainer, WorkerPool } from "../shared/trainer"

const { values } = parseArgs({
  options: {
    creature: { type: "string", default: "biped" },
    task: { type: "string", default: "room" },
    gens: { type: "string", default: "300" },
    minutes: { type: "string" },
    workers: { type: "string", default: String(Math.min(4, Math.max(1, cpus().length - 2))) },
    hidden: { type: "string", default: "16" },
    pairs: { type: "string", default: String(DEFAULT_ES.pairs) },
    sigma: { type: "string", default: String(DEFAULT_ES.sigma) },
    lr: { type: "string", default: String(DEFAULT_ES.lr) },
    seed: { type: "string", default: "1" },
    every: { type: "string", default: "10" },
    init: { type: "string" },
    out: { type: "string" },
    "course-seed": { type: "string", default: "1" },
    stage: { type: "string", default: "0" },
    "until-stage": { type: "string" },
    "no-curriculum": { type: "boolean", default: false },
    "laser-speed": { type: "string", default: "1" },
  },
})

const creature = values.creature as CreatureId
const task = values.task as TaskId
if (!CREATURE_IDS.includes(creature)) throw new Error(`--creature must be one of ${CREATURE_IDS.join(", ")}`)
if (!TASK_IDS.includes(task)) throw new Error(`--task must be one of ${TASK_IDS.join(", ")}`)
const gens = Number(values.gens)
const deadline = values.minutes ? performance.now() + Number(values.minutes) * 60_000 : Infinity
const workers = Number(values.workers)

const init = values.init ? parsePolicy(await Bun.file(values.init).json()) : null
if (values.init && !init) throw new Error(`${values.init} is not a walkers policy`)
const pool = new WorkerPool(() => new Worker(new URL("../shared/eval-worker.ts", import.meta.url).href), workers)
const trainer = new Trainer(
  {
    creature,
    env: envFor(task, { seed: Number(values["course-seed"]), stage: Number(values.stage), laserSpeed: Number(values["laser-speed"]) }),
    curriculum: !values["no-curriculum"],
    hidden: init?.hidden ?? Number(values.hidden),
    seed: Number(values.seed),
    es: { ...DEFAULT_ES, pairs: Number(values.pairs), sigma: Number(values.sigma), lr: Number(values.lr) },
    reward: DEFAULT_REWARD,
    init: init ? Float64Array.from(init.params) : undefined,
  },
  pool.evaluate,
)

console.log(`training ${creature} on ${task}: ${trainer.paramSize} params, population ${trainer.es.population}, ${workers} workers`)
const t0 = performance.now()
const every = Number(values.every)
for (let g = 0; g < gens && performance.now() < deadline; g++) {
  const s = await trainer.generation()
  if (values.out && trainer.env.stage > s.stage) {
    const checkpoint = values.out.replace(/\.json$/, `-stage${s.stage}.json`)
    await Bun.write(checkpoint, JSON.stringify({ ...trainer.best!, trainedSeconds: Math.round((performance.now() - t0) / 1000) }) + "\n")
    console.log(`curriculum checkpoint ${checkpoint}`)
  }
  if (values["until-stage"] && s.stage >= Number(values["until-stage"]) && s.finished >= Math.ceil(trainer.es.population * 0.5)) {
    console.log(`gen ${s.gen}: half the population escapes at stage ${s.stage}`)
    break
  }
  if (s.gen % every === 0 || g === gens - 1) {
    if (values.out) await Bun.write(values.out, JSON.stringify({ ...trainer.best!, trainedSeconds: Math.round((performance.now() - t0) / 1000) }) + "\n")
    const secs = (performance.now() - t0) / 1000
    console.log(
      `gen ${String(s.gen).padStart(4)}  best ${s.best.toFixed(2).padStart(6)}  mean ${s.mean.toFixed(2).padStart(6)}  mean-policy ${s.center.toFixed(2).padStart(6)} (${s.centerDistance.toFixed(1)} m)` +
        `  best-ever ${s.bestEver.toFixed(2)}  finished ${s.finished}/${trainer.es.population}${task === "heist" ? `  stage ${s.stage} gems ${s.gems} clean ${s.clean} alarms ${s.alarms}` : ""}  steps ${(s.totalSteps / 1e6).toFixed(2)}M  ${secs.toFixed(0)} s`,
    )
  }
}
pool.terminate()
const best = trainer.best!
console.log(`best: fitness ${best.fitness.toFixed(3)}, ${best.distance.toFixed(2)} m, gen ${best.generation}, after ${(best.steps / 1e6).toFixed(2)}M steps, ${((performance.now() - t0) / 1000).toFixed(0)} s`)
if (values.out) {
  await Bun.write(values.out, JSON.stringify({ ...best, trainedSeconds: Math.round((performance.now() - t0) / 1000) }) + "\n")
  console.log(`wrote ${values.out}`)
}
