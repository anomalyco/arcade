import { expect, test } from "bun:test"
import { SandboxSession } from "../src/game/game"

test("peaceful dummies stay at their seeded spawn for five minutes", () => {
  const session = new SandboxSession("you", "rifle", "frag", 1)
  const other = new SandboxSession("you", "rifle", "frag", 1)
  expect(session.latest().snap.players).toEqual(other.latest().snap.players)
  const initial = session.latest().snap.players
  for (let i = 0; i < 18000; i++) session.update(1 / 60)
  expect(session.latest().snap.players).toEqual(initial)
  expect(session.world.phase).toBe("play")
  expect(session.drainEvents().some((e) => e.k === "shot")).toBe(false)
})

test("a killed dummy respawns at exactly the same position and aim", () => {
  const session = new SandboxSession("you", "rifle", "frag", 1)
  const dummy = [...session.world.players.values()].find((p) => !p.human)!
  const spawn = { x: dummy.x, y: dummy.y, aim: dummy.aim }
  session.world.kill(dummy, session.world.players.get("you")!)
  expect(dummy.alive).toBe(false)
  for (let i = 0; i < 150; i++) session.update(1 / 60)
  expect(dummy.alive).toBe(true)
  expect({ x: dummy.x, y: dummy.y, aim: dummy.aim }).toEqual(spawn)
  expect(dummy.vx).toBe(0)
  expect(dummy.vy).toBe(0)
})
