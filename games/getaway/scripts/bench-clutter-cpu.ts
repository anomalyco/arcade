import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { body, PropPhysics } from "../src/game/props/physics"
import { PropParticles } from "../src/game/props/particles"
import { StreetProps } from "../src/game/props"
import { generateCity } from "../shared/sim/city"

const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!
const runs = []
for (let run = -1; run < 7; run++) {
  const city = generateCity(7), ground = () => 0
  const props = new StreetProps(city, { addModel: () => 0 }, ground)
  const asleep: number[] = [], awake: number[] = [], particle: number[] = [], counts: number[] = []
  const physics = new PropPhysics(ground, city.boxes), particles = new PropParticles()
  for (let i = 0; i < 512; i++) {
    const b = body(i, 310 + (i % 32) * .75, 5 + (i % 5), 400 + Math.floor(i / 32) * .75, .2, .2, .2, 1)
    physics.add(b); physics.impulse(b, Math.sin(i) * 6, 8, Math.cos(i) * 6)
  }
  particles.emit(10, 314, 6, 405, 2400)
  for (let frame = 0; frame < 90; frame++) {
    let t = performance.now()
    props.update([], 1 / 60, { x: 314, z: 400 }, true, () => false)
    asleep.push(performance.now() - t)
    t = performance.now(); physics.update(1 / 60); awake.push(performance.now() - t); counts.push(physics.active.size)
    t = performance.now(); particles.update(1 / 60, ground); particle.push(performance.now() - t)
  }
  runs.push({ run, warmup: run < 0, props: props.props.length, asleep, awake, particle, counts })
}
writeFileSync(join(import.meta.dir, "../../../perf/clutter/cpu.json"), JSON.stringify({ metric: "CPU ms per 60Hz frame, 512 thrown bodies, 2400 flutter particles, seven runs plus warmup", runs }, null, 2))
for (const key of ["asleep", "awake", "particle"] as const) console.log(key, runs.filter(r => !r.warmup).map(r => median(r[key])))
