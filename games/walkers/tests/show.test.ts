import { expect, test } from "bun:test"
import { Episode } from "../shared/episode"
import { Show } from "../src/show"

test("a generation show ends once its runners stall; the pre-trained runner never holds it up", () => {
  const still = { ep: new Episode("biped", "room", null), role: "best" as const, label: "", expected: null }
  const gold = { ep: new Episode("worm", "room", null), role: "pretrained" as const, label: "", expected: null }
  const show = new Show("generation", [gold, still], 0)
  show.advance(60)
  expect(show.done).toBe(false)
  show.advance(100)
  expect(show.done).toBe(true)
  expect(still.ep.done).toBe(false)
  const replay = new Show("replay", [{ ...still, ep: new Episode("biped", "room", null) }], 0)
  replay.advance(200)
  expect(replay.done).toBe(false)
})
