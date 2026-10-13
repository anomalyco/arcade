import { expect, test } from "bun:test"
import { SMOKE_CAPACITY, SmokeTrail, type SmokeSource } from "../src/game/smoke-trail"

const source = (): SmokeSource => ({ smokeDistance: 0, smokeX: 0, smokeZ: 0, smokeActive: false })

test("distance emission covers fast frame steps and carries sub-step distance", () => {
  const run = (step: number) => {
    const trail = new SmokeTrail(), s = source()
    trail.follow(s, 0, 0, 0, 1, 60, 0, step / 60, true)
    for (let x = step; x <= 12; x += step) trail.follow(s, x, 0, 0, 1, 60, 0, step / 60, true)
    return trail
  }
  const slow = run(6), fast = run(0.25)
  expect(slow.count).toBe(fast.count)
  for (let i = 1; i < slow.count; i++) {
    expect(slow.particles[i * 8]).toBeCloseTo(fast.particles[i * 8]!, 4)
    if (i > 2) expect(slow.particles[i * 8]! - slow.particles[(i - 2) * 8]!).toBeLessThan(0.421)
  }
})

test("a sharp turn stays connected and a teleport or inactive gap does not bridge", () => {
  const t = new SmokeTrail(), s = source()
  t.follow(s,0,0,0,0,0,0,1/30,true)
  t.follow(s,6,0,0,0,0,0,1/30,true)
  t.follow(s,6,6,0,0,0,0,1/30,true)
  for(let i=1;i<t.count;i++) expect(Math.hypot(t.particles[i*8]!-t.particles[(i-1)*8]!,t.particles[i*8+2]!-t.particles[(i-1)*8+2]!)).toBeLessThan(0.421)
  const count=t.count
  t.follow(s,100,100,0,0,0,0,1/30,true)
  expect(t.count).toBe(count+1)
  t.follow(s,101,100,0,0,0,0,1/30,false)
  t.follow(s,104,100,0,0,0,0,1/30,true)
  expect(t.count).toBe(count+2)
})

test("storage is bounded and reused while smoke disperses to zero", () => {
  const t=new SmokeTrail(), particles=t.particles, instances=t.instances, field=t.field
  for(let i=0;i<SMOKE_CAPACITY+10;i++) t.spawn(i*0.05,0.65,0,20,0)
  expect(t.count).toBe(SMOKE_CAPACITY)
  t.update(0.1); t.prepare(8)
  expect(t.field.some(x=>x>0)).toBe(true)
  for(let i=0;i<160;i++) t.update(1/60)
  t.prepare(8)
  expect(t.count).toBe(0); expect(t.drawn).toBe(0)
  expect(t.particles).toBe(particles); expect(t.instances).toBe(instances); expect(t.field).toBe(field)
})
