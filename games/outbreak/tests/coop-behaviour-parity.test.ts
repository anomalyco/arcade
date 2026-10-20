import { expect, test } from "bun:test"
import { ACT_NONE, ACT_REST_SIT, ACT_REST_SLUMP } from "../shared/behaviour/activities"
import { behaviourOf, freshMind } from "../shared/behaviour/mind"
import { featureRoom } from "./coop-feature-room"

test("zombie activities replicate to both clients through full and delta snapshots, clear, and reach a late joiner", () => {
  const r = featureRoom()
  try {
    r.place(r.a, 30, 46)
    const sim = r.core.sim
    const st = behaviourOf(sim)!
    const zs = [0, 1, 2].map((k) => sim.ai.spawnZombie(sim.town, 40 + k * 2, 50, "wander", Math.PI))
    zs.forEach((z, k) => {
      z.seed = (0x1234567 * (k + 1)) >>> 0
      const m = (st.minds[z.id] = freshMind(z))
      m.act = k === 1 ? ACT_REST_SLUMP : ACT_REST_SIT
      m.until = sim.time + 1e6
    })
    r.tick(12)
    const check = () => {
      r.flush()
      const want = zs.map((z) => st.minds[z.id]?.act ?? ACT_NONE)
      for (const c of r.clients) {
        const cs = behaviourOf(c.sim)!
        expect(zs.map((z) => cs.minds[z.id]?.act ?? ACT_NONE)).toEqual(want)
      }
      return want
    }
    // At night the resting dead rouse at once: what matters is that the clients see whatever the host decided.
    const first = check()
    expect(first.every((act) => act !== ACT_NONE)).toBe(true)

    // Deltas carry changes and clears as the activities play out.
    const seen = new Set(first.join())
    for (let i = 0; i < 10; i++) {
      r.tick(30)
      seen.add(check().join())
    }
    expect(seen.size).toBeGreaterThan(1)

    r.join()
    r.tick(12)
    check()
  } finally {
    r.close()
  }
})
