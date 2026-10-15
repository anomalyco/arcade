import { describe, expect, test } from "bun:test"
import { ROSTER } from "../shared/characters"
import { LabSession } from "../src/dev/lab-session"

describe("brawl lab scenes", () => {
  for (const c of ROSTER) {
    test(`${c.id} loops every ability at the dummies without the round ending`, () => {
      const s = new LabSession("gallery", { char: c.id, slots: [0, 1, 2, 3], bots: 0, seed: 3 })
      const cast = new Set<number>()
      for (let i = 0; i < 40 * 30; i++) {
        s.update(1 / 30)
        if (s.brain!.active >= 0) cast.add(s.brain!.active)
      }
      expect([...cast].sort()).toEqual([0, 1, 2, 3])
      expect(s.world.phase).toBe("play")
      expect(s.world.actors.map((f) => f.char)[0]).toBe(c.id)
      expect(s.drainEvents().some((e) => e.k === "hit")).toBe(true)
    })
  }

  test("the prop playground has you and a prop-throwing Slab", () => {
    const s = new LabSession("props", { char: "chef", slots: [], bots: 0, seed: 3 })
    expect(s.myId).toBe("you")
    expect(s.world.actors.map((f) => f.char)).toEqual(["chef", "slab"])
    let grabs = 0
    for (let i = 0; i < 20 * 30; i++) {
      s.update(1 / 30)
      grabs += s.drainEvents().filter((e) => e.k === "grab").length
    }
    expect(grabs).toBeGreaterThan(0)
  })
})
