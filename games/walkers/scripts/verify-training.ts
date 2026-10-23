// Opt-in learning checks. Run on Pro through HiveMind; never part of bun test.
import assert from "node:assert/strict"
import { DEFAULT_REWARD } from "../shared/episode"
import { envFor } from "../shared/tasks"
import { inlineEvaluator, Trainer } from "../shared/trainer"

const deterministicRun = async () => {
  const t = new Trainer({ creature: "worm", env: envFor("room"), hidden: 8, seed: 5, es: { pairs: 4, sigma: 0.05, lr: 0.03, weightDecay: 0.005 } }, inlineEvaluator)
  for (let g = 0; g < 3; g++) await t.generation()
  return Array.from(t.es.theta)
}
assert.deepEqual(await deterministicRun(), await deterministicRun(), "seeded training must be bit-identical")

const room = new Trainer({ creature: "quadruped", env: envFor("room"), hidden: 8, seed: 1, es: { pairs: 12, sigma: 0.06, lr: 0.03, weightDecay: 0.005 }, reward: { ...DEFAULT_REWARD, seconds: 4 } }, inlineEvaluator)
const firstRoom = await room.generation()
for (let g = 0; g < 20; g++) await room.generation()
assert(room.best!.fitness > firstRoom.best + 0.5, "quadruped best fitness must improve")
assert(room.history.at(-1)!.mean > firstRoom.mean, "quadruped mean fitness must improve")
console.log("PASS quadruped learns forward movement")

const heist = new Trainer({ creature: "quadruped", env: envFor("heist", { stage: 1 }), curriculum: false, hidden: 8, seed: 3, es: { pairs: 10, sigma: 0.06, lr: 0.04, weightDecay: 0.005 }, reward: { ...DEFAULT_REWARD, heistSeconds: 4 } }, inlineEvaluator)
const firstHeist = await heist.generation()
for (let g = 0; g < 14; g++) await heist.generation()
assert(heist.best!.fitness > firstHeist.best + 0.3, "heist best fitness must improve")
assert.equal(heist.env.stage, 1)
console.log("PASS quadruped learns a short heist stage")

const human = new Trainer({ creature: "human", env: envFor("heist"), hidden: 8, seed: 7, curriculum: false,
  es: { pairs: 12, sigma: .06, lr: .02, weightDecay: .005 }, reward: { ...DEFAULT_REWARD, heistSeconds: 3 } }, inlineEvaluator)
const firstHuman = await human.generation()
for (let i = 0; i < 25; i++) await human.generation()
assert(human.best!.fitness > firstHuman.best + .5, "human best fitness must improve")
assert(human.history.at(-1)!.mean > firstHuman.mean, "human mean fitness must improve")
console.log("PASS human learns a short balance lesson")
