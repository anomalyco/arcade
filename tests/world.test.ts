import { describe, expect, test } from "bun:test"
import { FILL_TO, GUNS, HEALTH, MATCH_SECONDS, RESPAWN_SECONDS } from "../shared/config"
import { type Rect, RectGrid, pushOut, rayRect } from "../shared/geom"
import { generateOffice } from "../shared/maps/office"
import { Rng } from "../shared/rng"
import { buildSnapshot } from "../shared/sim/view"
import { World } from "../shared/sim/world"
import { place, run, world } from "./helpers"

const east = 0

describe("shooting", () => {
  test("four hits kill and the killer scores", () => {
    const w = world()
    place(w, "a", 15, 10)
    place(w, "b", 20, 10)
    run(w, 1, (id) => (id === "a" ? { aim: east, fire: true } : {}))
    const b = w.players.get("b")!
    expect(b.alive).toBe(false)
    expect(w.players.get("a")!.kills).toBe(1)
    expect(Math.ceil(HEALTH / GUNS.rifle.damage)).toBe(4)
  })

  test("the sniper kills in one shot and the shotgun in one pump up close", () => {
    for (const gun of ["sniper", "shotgun"] as const) {
      const w = world()
      w.pickGun("a", gun)
      w.spawn(w.players.get("a")!)
      place(w, "a", 15, 10)
      place(w, "b", 18, 10)
      w.players.get("a")!.cooldownUntil = 0
      run(w, 0.1, (id) => (id === "a" ? { aim: east, fire: true } : {}))
      expect(w.players.get("b")!.alive).toBe(false)
    }
  })

  test("semi-automatic guns need a fresh trigger press", () => {
    const w = world(["a"])
    w.pickGun("a", "sniper")
    w.spawn(w.players.get("a")!)
    place(w, "a", 15, 10)
    w.players.get("a")!.cooldownUntil = 0
    run(w, 3, () => ({ aim: east, fire: true }))
    expect(w.players.get("a")!.mag).toBe(GUNS.sniper.mag - 1)
  })

  test("walls stop bullets", () => {
    const w = world()
    place(w, "a", 8, 4)
    place(w, "b", 12, 4)
    run(w, 1, (id) => (id === "a" ? { aim: east, fire: true } : {}))
    expect(w.players.get("b")!.health).toBe(HEALTH)
  })

  test("the magazine empties and reloads", () => {
    const w = world(["a"])
    place(w, "a", 15, 10)
    run(w, 4, () => ({ aim: east, fire: true }))
    const a = w.players.get("a")!
    expect(a.mag).toBeLessThan(GUNS.rifle.mag)
    expect(w.takeEvents().some((e) => e.k === "reload")).toBe(true)
  })

  test("health regenerates out of combat", () => {
    const w = world()
    place(w, "a", 15, 10)
    place(w, "b", 20, 10)
    w.players.get("a")!.cooldownUntil = 0
    run(w, 0.1, (id) => (id === "a" ? { aim: east, fire: true } : {}))
    const b = w.players.get("b")!
    expect(b.health).toBeLessThan(HEALTH)
    run(w, 7)
    expect(b.health).toBe(HEALTH)
  })
})

describe("deathmatch", () => {
  test("the dead respawn", () => {
    const w = world()
    const a = w.players.get("a")!
    const b = w.players.get("b")!
    w.kill(b, a)
    run(w, RESPAWN_SECONDS + 0.2)
    expect(b.alive).toBe(true)
    expect(b.health).toBe(HEALTH)
  })

  test("everyone is in every snapshot", () => {
    const w = world(["a", "b", "c"])
    expect(buildSnapshot(w, "a").players.map((p) => p.id).sort()).toEqual(["a", "b", "c"])
  })

  test("bots keep the room full and leave as humans join", () => {
    const w = new World(1)
    w.addHuman("h1", "one")
    expect(w.players.size).toBe(FILL_TO)
    for (let i = 2; i <= FILL_TO + 1; i++) w.addHuman(`h${i}`, "x")
    expect([...w.players.values()].every((p) => p.human)).toBe(true)
  })

  test("the match ends on time, then a new floor starts with scores reset", () => {
    const w = new World(5)
    w.addHuman("h", "h")
    const first = w.map.seed
    w.players.get("h")!.kills = 3
    for (let i = 0; i < 30 * (MATCH_SECONDS + 1) && w.phase === "play"; i++) w.step()
    expect(w.phase).toBe("end")
    for (let i = 0; i < 30 * 15 && w.phase === "end"; i++) w.step()
    expect(w.phase).toBe("play")
    expect(w.map.seed).not.toBe(first)
    expect(w.players.get("h")!.kills).toBe(0)
  })

  test("bots hunt and kill each other without getting stuck in walls", () => {
    const w = new World(42)
    w.fill()
    let kills = 0
    for (let i = 0; i < 30 * 90; i++) {
      w.step()
      kills += w.takeEvents().filter((e) => e.k === "kill").length
      for (const p of w.players.values()) {
        if (!p.alive) continue
        expect(w.solids.some((r) => p.x > r[0] + 0.02 && p.x < r[2] - 0.02 && p.y > r[1] + 0.02 && p.y < r[3] - 0.02)).toBe(false)
      }
    }
    expect(kills).toBeGreaterThan(3)
  })
})

describe("broadphase", () => {
  const m = generateOffice(5)
  const rects: Rect[] = [...m.walls.map((w) => w.rect), ...m.windows, ...m.glass, ...m.props.filter((p) => p.solid).map((p) => p.rect)]
  const r = new Rng(3)

  test("grid raycasts match a linear scan", () => {
    const grid = new RectGrid(rects)
    for (let i = 0; i < 20000; i++) {
      const ox = r.range(-5, m.size[0] + 5)
      const oy = r.range(-5, m.size[1] + 5)
      const a = r.next() < 0.1 ? (r.int(4) * Math.PI) / 2 : r.range(0, 7)
      const dx = Math.cos(a)
      const dy = Math.sin(a)
      const maxT = r.range(0, 60)
      let best = maxT
      let hit = false
      for (const rc of rects) {
        const t = rayRect(ox, oy, dx, dy, rc, best)
        if (t < best || (t === best && !hit && t !== Infinity)) {
          best = t
          hit = true
        }
      }
      expect(grid.raycast(ox, oy, dx, dy, maxT)).toBe(hit ? best : Infinity)
    }
  })

  test("pushOut through the grid matches a linear scan", () => {
    const R = 0.32
    for (let i = 0; i < 20000; i++) {
      const p = { x: r.range(0, m.size[0]), y: r.range(0, m.size[1]) }
      const q = { ...p }
      pushOut(p, R, rects)
      for (let pass = 0; pass < 2; pass++)
        for (const rc of rects) {
          const dx = q.x - Math.max(rc[0], Math.min(q.x, rc[2]))
          const dy = q.y - Math.max(rc[1], Math.min(q.y, rc[3]))
          const d2 = dx * dx + dy * dy
          if (d2 >= R * R) continue
          if (d2 > 1e-12) {
            const d = Math.sqrt(d2)
            q.x += (dx / d) * (R - d)
            q.y += (dy / d) * (R - d)
            continue
          }
          const k = Math.min(q.x - rc[0], rc[2] - q.x, q.y - rc[1], rc[3] - q.y)
          if (k === q.x - rc[0]) q.x = rc[0] - R
          else if (k === rc[2] - q.x) q.x = rc[2] + R
          else if (k === q.y - rc[1]) q.y = rc[1] - R
          else q.y = rc[3] + R
        }
      expect(p).toEqual(q)
    }
  })
})
