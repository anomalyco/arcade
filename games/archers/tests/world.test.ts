import { describe, expect, test } from "bun:test"
import { botButtons } from "../shared/bots"
import { DT } from "../shared/config"
import { BTN, type Buttons } from "../shared/input"
import { navGraph } from "../shared/nav"
import { type Archer, HH, type SimEvent, World } from "../shared/world"

/** A two-archer world stepped past the countdown, with both archers' inputs scripted per test. */
function setup(): { w: World; a: Archer; b: Archer; input: Record<string, Buttons>; step: (n?: number) => SimEvent[] } {
  const w = World.create(5)
  w.add("a", "A", false)
  w.add("b", "B", false)
  const input: Record<string, Buttons> = { a: 0, b: 0 }
  const events: SimEvent[] = []
  const step = (n = 1) => {
    events.length = 0
    for (let i = 0; i < n; i++) {
      w.step((x) => input[x.id] ?? 0)
      events.push(...w.takeEvents())
    }
    return [...events]
  }
  while (w.s.phase !== "play") step()
  const a = w.archer("a")!, b = w.archer("b")!
  // Park B out of the way on the right floor.
  Object.assign(b, { x: 26, y: 4, vx: 0, vy: 0 })
  return { w, a, b, input, step }
}

const place = (a: Archer, x: number, y: number, vx = 0, vy = 0) => Object.assign(a, { x, y, vx, vy, ground: false, hang: 0, dodge: 0, dodgeCd: 0, coyote: 0, jumpBuf: 0, prev: 0 })

describe("platforming", () => {
  test("a buffered jump fires on landing", () => {
    const { a, input, step } = setup()
    place(a, 4, 4.25, 0, -6)
    input.a = BTN.jump
    const ev = step(6)
    expect(ev.some((e) => e.k === "jump" && e.id === "a")).toBe(true)
    expect(a.vy).toBeGreaterThan(0)
  })

  test("coyote time allows a jump just after running off a ledge", () => {
    const { a, input, step } = setup()
    place(a, 11.4, 4, 7.2, 0)
    a.ground = true
    input.a = BTN.right
    let left = 0
    for (let i = 0; i < 30 && !left; i++) {
      step()
      if (!a.ground && a.vy <= 0) left = i
    }
    expect(left).toBeGreaterThan(0)
    input.a = BTN.right | BTN.jump
    step()
    expect(a.vy).toBeGreaterThan(10)
  })

  test("wall slide caps the fall and a wall jump kicks away from the wall", () => {
    const { w, a, input, step } = setup()
    place(a, 12.32, 1.5, 0, -10)
    input.a = BTN.left
    step(6)
    expect(a.wall).toBe(-1)
    expect(a.sliding).toBe(true)
    expect(a.vy).toBeGreaterThanOrEqual(-w.t.wallSlide - 1e-9)
    input.a = BTN.left | BTN.jump
    const ev = step()
    expect(ev.some((e) => e.k === "jump" && e.kind === "wall")).toBe(true)
    expect(a.vx).toBeGreaterThan(0)
    expect(a.vy).toBeGreaterThan(0)
  })

  test("falling past a lip while holding toward it grabs the ledge, and jump climbs", () => {
    const { a, input, step } = setup()
    place(a, 12.33, 4 - HH + 0.25, 0, -2)
    input.a = BTN.left
    const ev = step(8)
    expect(ev.some((e) => e.k === "grab")).toBe(true)
    expect(a.hang).toBe(-1)
    input.a = BTN.left | BTN.jump
    step()
    expect(a.hang).toBe(0)
    expect(a.vy).toBeGreaterThan(0)
  })

  test("leaving one edge brings you in at the other", () => {
    const { a, input, step } = setup()
    place(a, 31.8, 4, 7.2, 0)
    input.a = BTN.right
    step(4)
    expect(a.x).toBeLessThan(2)
  })
})

describe("combat", () => {
  test("an arrow loosed into the floor sticks, and walking over it puts it back in the quiver", () => {
    const { w, a, input, step } = setup()
    place(a, 15, 9.5, 0, -1)
    input.a = BTN.down | BTN.shoot
    step(2)
    input.a = BTN.down
    let stuck = false
    for (let i = 0; i < 30 && !stuck; i++) {
      const ev = step()
      stuck = ev.some((e) => e.k === "stick" && e.into === "floor")
    }
    expect(stuck).toBe(true)
    expect(a.quiver.length).toBe(2)
    expect(w.s.arrows.filter((r) => r.state === "stuck").length).toBe(1)
    // The archer drops onto the platform where the arrow stuck and picks it up.
    const ev = step(40)
    expect(ev.some((e) => e.k === "pickup" && e.id === "a")).toBe(true)
    expect(a.quiver.length).toBe(3)
    expect(w.s.arrows.length).toBe(0)
  })

  test("letting go of the direction and the bow on the same tick keeps the aim; a draw left alone aims ahead", () => {
    const { a, input, step } = setup()
    place(a, 4, 4)
    step(5)
    input.a = BTN.up | BTN.shoot
    step(10)
    input.a = 0
    const ev = step()
    const shot = ev.find((e) => e.k === "shoot")
    expect(shot && shot.k === "shoot" && shot.dy).toBe(1)
    // Draw up, let go of up, keep drawing: after the grace the aim is straight ahead again.
    input.a = BTN.up | BTN.shoot
    step(5)
    input.a = BTN.shoot
    step(10)
    input.a = 0
    const again = step().find((e) => e.k === "shoot")
    expect(again && again.k === "shoot" && again.dy).toBe(0)
  })

  test("an arrow kills in one hit and spills the victim's quiver", () => {
    const { w, a, b, step } = setup()
    place(b, 8, 4, 0, 0)
    w.s.arrows.push({ id: 99, by: a.id, kind: "normal", x: 6, y: 4.7, vx: 24, vy: 0, state: "fly", age: 1, drilled: 0, drilling: false })
    const ev = step(10)
    const kill = ev.find((e) => e.k === "kill")
    expect(kill && kill.k === "kill" && kill.victim).toBe("b")
    expect(b.alive).toBe(false)
    expect(w.s.arrows.filter((r) => r.state !== "fly").length).toBeGreaterThanOrEqual(3)
    expect(w.s.phase).toBe("over")
  })

  test("dodging into an arrow at the right moment catches it", () => {
    const { w, a, b, input, step } = setup()
    place(b, 8, 4, 0, 0)
    w.s.arrows.push({ id: 99, by: a.id, kind: "normal", x: 7.1, y: 4.7, vx: 24, vy: 0, state: "fly", age: 1, drilled: 0, drilling: false })
    input.b = BTN.dodge
    const ev = step(4)
    expect(ev.some((e) => e.k === "catch" && e.by === "b")).toBe(true)
    expect(b.alive).toBe(true)
    expect(b.quiver.length).toBe(4)
  })

  test("landing on a head is a stomp kill and bounces the stomper", () => {
    const { a, b, step } = setup()
    place(b, 15, 6, 0, 0)
    b.ground = true
    place(a, 15.1, 6 + HH + 0.1, 0, -8)
    const ev = step(3)
    expect(ev.some((e) => e.k === "kill" && e.cause === "stomp" && e.by === "a")).toBe(true)
    expect(a.vy).toBeGreaterThan(0)
  })
})

describe("matches", () => {
  const botWorld = (seed: number, arena = "belltower") => {
    const w = World.create(seed, arena)
    for (let i = 0; i < 4; i++) w.add(`b${i}`, `B${i}`, true)
    return w
  }

  test("is deterministic, and a cloned state replays identically (rollback)", () => {
    const a = botWorld(11), b = botWorld(11)
    for (let i = 0; i < 600; i++) {
      a.step((x) => botButtons(a, x))
      b.step((x) => botButtons(b, x))
    }
    expect(JSON.stringify(a.s)).toBe(JSON.stringify(b.s))
    const snap = structuredClone(a.s)
    for (let i = 0; i < 300; i++) a.step((x) => botButtons(a, x))
    const c = new World(snap, a.t)
    for (let i = 0; i < 300; i++) c.step((x) => botButtons(c, x))
    expect(JSON.stringify(c.s)).toBe(JSON.stringify(a.s))
  })

  for (const arena of ["belltower", "cloister"]) {
    test(`bots play fast rounds with the full move set (${arena})`, () => {
      const w = botWorld(3, arena)
      expect(navGraph(w.arena, w.t).edges.size).toBeGreaterThan(40)
      const seen: Record<string, number> = {}
      for (let i = 0; i < 120 / DT; i++) {
        w.step((x) => botButtons(w, x))
        for (const e of w.takeEvents()) seen[e.k === "jump" ? `jump.${e.kind}` : e.k] = (seen[`${e.k === "jump" ? `jump.${e.kind}` : e.k}`] ?? 0) + 1
      }
      expect(w.s.round).toBeGreaterThanOrEqual(4)
      expect(seen.kill ?? 0).toBeGreaterThanOrEqual(8)
      expect(seen.shoot ?? 0).toBeGreaterThan(20)
      expect(seen.stick ?? 0).toBeGreaterThan(5)
      expect(seen["jump.ground"] ?? 0).toBeGreaterThan(20)
      expect(seen.dodge ?? 0).toBeGreaterThan(3)
      expect(seen.chest ?? 0).toBeGreaterThan(0)
    })
  }
})
