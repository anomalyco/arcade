import { describe, expect, test } from "bun:test"
import { INTENT_OPS, NO_INTENT, type Intent } from "../shared/sim/world"

const at = (i: Partial<Intent>): Intent => ({ ...NO_INTENT, ...i })

describe("Blackout input edges (room jitter buffer)", () => {
  test("a tap released by the next tick still fires when the two are merged", () => {
    const m = INTENT_OPS.merge(at({ fire: true, firePressed: true }), at({ mx: 1 }))
    expect(m.fire).toBe(true)
    expect(m.firePressed).toBe(true)
    expect(m.mx).toBe(1)
  })

  test("every one-shot press survives a merge; held state comes from the later input", () => {
    const cast = { spell: "moon" as const, quality: 1, x: 3, y: 4 }
    const m = INTENT_OPS.merge(at({ reload: true, equip: true, melee: true, enter: true, seat: true, cast, sprint: true }), at({ aim: 2, use: true }))
    expect([m.reload, m.equip, m.melee, m.enter, m.seat]).toEqual([true, true, true, true, true])
    expect(m.cast).toEqual(cast)
    expect(m.sprint).toBe(false)
    expect(m.aim).toBe(2)
    expect(m.use).toBe(true)
  })

  test("a stand-in repeats held movement and trigger without repeating presses", () => {
    const s = INTENT_OPS.standIn(at({ mx: 1, fire: true, firePressed: true, reload: true, equip: true, enter: true, sprint: true }))
    expect(s.mx).toBe(1)
    expect(s.fire).toBe(true)
    expect(s.sprint).toBe(true)
    expect(INTENT_OPS.hasEdges(s)).toBe(false)
  })
})
