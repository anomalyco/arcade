import { expect, test } from "bun:test"
import { SmokeTrail, SMOKE_CAPACITY, type SmokeSource } from "@arcade/kit/fx/smoke-trail"

// Exact shipped main source, also used by the Metal pixel-parity proof. Keep the
// reference independent of the shared implementation so algorithm drift fails.
const source = await Bun.file(new URL("../../../perf/fx-baseline/trail.txt", import.meta.url)).text()
const javascript = new Bun.Transpiler({ loader: "ts" }).transformSync(source)
const baseline = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`)

test("shared tyre simulation matches shipped main through drift, burnout, teleport, expiry and reset", () => {
  for (const hz of [30, 60, 144]) {
    const shared = new SmokeTrail()
    const shipped: SmokeTrail = new baseline.SmokeTrail()
    const wheel = (): SmokeSource => ({ smokeDistance: 0, smokeX: 0, smokeZ: 0, smokeActive: false, idle: 0 })
    const actual = wheel(), expected = wheel()
    const compare = () => {
      shared.prepare(); shipped.prepare()
      expect([shared.count, shared.drawn, shared.time]).toEqual([shipped.count, shipped.drawn, shipped.time])
      expect(shared.particles.subarray(0, shared.count * 8)).toEqual(shipped.particles.subarray(0, shipped.count * 8))
      expect(shared.instances.subarray(0, shared.drawn * 8)).toEqual(shipped.instances.subarray(0, shipped.drawn * 8))
      expect(actual).toEqual(expected)
    }
    shared.seedWind(317); shipped.seedWind(317)
    for (let frame = 0; frame < hz * 8; frame++) {
      const t = frame / hz, moving = t < 2 || t >= 4
      const x = moving ? t * 12 : 24, z = Math.sin(t) * (moving ? 3 : 0) + (t >= 5 ? 100 : 0)
      const strength = t >= 6 ? 0 : .3 + .2 * Math.sin(t)
      shared.follow(actual, x, z, moving ? 12 : 0, 2, 1 / hz, strength)
      shipped.follow(expected, x, z, moving ? 12 : 0, 2, 1 / hz, strength)
      shared.update(1 / hz); shipped.update(1 / hz)
      compare()
    }
    shared.update(10); shipped.update(10); compare()
    expect(shared.count).toBe(0)
    for (let i = 0; i < SMOKE_CAPACITY + 10; i++) {
      shared.spawn(i / 10, .3, 0, 5, 2)
      shipped.spawn(i / 10, .3, 0, 5, 2)
    }
    compare(); expect(shared.count).toBe(SMOKE_CAPACITY)
    shared.reset(); shipped.reset(); compare()
    shared.spawn(1, .3, 2, 3, 4); shipped.spawn(1, .3, 2, 3, 4)
    shared.update(.1); shipped.update(.1); compare()
  }
})
