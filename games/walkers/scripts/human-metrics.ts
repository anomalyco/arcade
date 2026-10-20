// Contact-derived gait metrics. Not a mocap comparison: this is a force-driven 2D model, not the kit's 3D rig.
// bun games/walkers/scripts/human-metrics.ts policy.json [output.json]
import { Episode, policyShape } from "../shared/episode"
import { Policy } from "../shared/policy"
import { parsePolicy } from "../shared/trainer"
import { worldHash } from "../shared/physics"

const file = process.argv[2]
const saved = file ? parsePolicy(await Bun.file(file).json()) : null
if (file && (!saved || saved.creature !== "human")) throw new Error("Expected a human policy")
const ep = new Episode("human", saved?.env ?? "heist", saved ? new Policy(policyShape("human", saved.hidden), Float64Array.from(saved.params)) : null, saved?.reward)
const zero = new Float64Array(12)
while (!ep.done) ep.step(saved ? undefined : zero)
const report = { ...ep.result(), hash: worldHash(ep.world.bodies), lastViolation: ep.realism?.reason, trainedSeconds: saved?.trainedSeconds, stage: ep.env.stage,
  metricDefinition: "Cadence: debounced foot landings; stride: same-foot landing distance; duty: loaded stance samples; CoT: absolute mechanical joint work / (75 kg × g × net forward distance), not metabolic cost." }
console.log(JSON.stringify(report, null, 2))
if (process.argv[3]) await Bun.write(process.argv[3], JSON.stringify(report, null, 2) + "\n")
