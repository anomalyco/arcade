import { describe, expect, test } from "bun:test"
import { CLAYMORE, END_SECONDS, EQUIPS, FRAG, GUNS, HEALTH, MATCH_SECONDS, RESPAWN_SECONDS, SPRINT_TO_FIRE } from "../shared/config"
import { type Rect, RectGrid, pushOut, rayRect } from "../shared/geom"
import { generateOffice } from "../shared/maps/office"
import { Builder } from "../shared/maps/builder"
import { Rng } from "../shared/rng"
import { type Grenade, PROP_TOP, launch, obstaclesOf, stepGrenade } from "../shared/sim/gear"
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

describe("sprint", () => {
  test("sprinting moves faster than walking", () => {
    const w = world(["a", "b"])
    const a = place(w, "a", 12, 12)
    const b = place(w, "b", 12, 16)
    run(w, 1, (id) => ({ mx: 1, sprint: id === "a" }))
    expect(a.x - 12).toBeGreaterThan((b.x - 12) * 1.4)
  })

  test("pulling the trigger cancels the sprint, and the first shot waits for the gun to come up", () => {
    const w = world(["a"])
    const a = place(w, "a", 12, 12)
    a.cooldownUntil = 0
    run(w, 0.5, () => ({ mx: 1, sprint: true }))
    w.takeEvents()
    const start = w.time
    let first = -1
    for (let i = 0; i < 20 && first < 0; i++) {
      run(w, 1 / 30, () => ({ mx: 1, sprint: true, fire: true }))
      if (w.takeEvents().some((e) => e.k === "shot")) first = w.time - start
    }
    expect(first).toBeGreaterThan(SPRINT_TO_FIRE - 0.04)
    expect(first).toBeLessThan(SPRINT_TO_FIRE + 0.1)
  })

  test("a semi-automatic press during the delay still fires once the gun is up", () => {
    const w = world(["a"])
    w.pickGun("a", "sniper")
    w.spawn(w.players.get("a")!)
    const a = place(w, "a", 12, 12)
    a.cooldownUntil = 0
    run(w, 0.5, () => ({ mx: 1, sprint: true }))
    run(w, 0.5, () => ({ mx: 1, sprint: true, fire: true }))
    expect(a.mag).toBe(GUNS.sniper.mag - 1)
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

  test("rooms have no bots unless asked; bots leave as humans join", () => {
    const w = new World(1)
    w.addHuman("h1", "one")
    expect(w.players.size).toBe(1)
    w.botFill = 4
    w.fill()
    expect(w.players.size).toBe(4)
    for (let i = 2; i <= 5; i++) w.addHuman(`h${i}`, "x")
    expect([...w.players.values()].every((p) => p.human)).toBe(true)
  })

  test("the match ends on time, then a new floor starts with scores reset", () => {
    const w = new World(5)
    w.addHuman("h", "h")
    const first = w.map.seed
    w.players.get("h")!.kills = 3
    for (let i = 0; i < 30 * (MATCH_SECONDS + 1) && w.phase === "play"; i++) w.step()
    expect(w.phase).toBe("end")
    for (let i = 0; i < 30 * (END_SECONDS + 1) && w.phase === "end"; i++) w.step()
    expect(w.phase).toBe("play")
    expect(w.map.seed).not.toBe(first)
    expect(w.players.get("h")!.kills).toBe(0)
  })

  test("bots hunt and kill each other without getting stuck in walls", () => {
    const w = new World(42)
    w.fill(4)
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
      // Bodies move a fraction of a radius per step, so they're never buried deeper than that in a solid.
      if (rects.some((rc) => p.x > rc[0] + R && p.x < rc[2] - R && p.y > rc[1] + R && p.y < rc[3] - R)) continue
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

describe("equipment", () => {
  const frag = (w: World, id: string, tx: number, ty: number) => {
    const p = w.players.get(id)!
    run(w, 1 / 30, (q) => (q === id ? { aim: Math.atan2(ty - p.y, tx - p.x), equip: true, tx, ty } : {}))
  }

  test("a frag kills a player near where it lands once the fuse burns down, and only then", () => {
    const w = world()
    place(w, "a", 14, 12)
    place(w, "b", 20, 12)
    frag(w, "a", 20, 12)
    expect(w.grenades.length).toBe(1)
    run(w, FRAG.fuse - 0.3)
    expect(w.players.get("b")!.alive).toBe(true)
    run(w, 0.4)
    expect(w.grenades.length).toBe(0)
    expect(w.players.get("b")!.alive).toBe(false)
    expect(w.players.get("a")!.kills).toBe(1)
    expect(w.takeEvents().some((e) => e.k === "kill" && e.how === "frag")).toBe(true)
  })

  test("walls stop the blast", () => {
    const w = world()
    place(w, "a", 5, 4)
    place(w, "b", 11, 4)
    frag(w, "a", 9.2, 4)
    run(w, FRAG.fuse - 0.2)
    expect(w.grenades[0]!.x).toBeLessThan(10)
    run(w, 0.4)
    const g = w.players.get("b")!
    expect(g.alive).toBe(true)
    expect(g.health).toBe(HEALTH)
  })

  test("a frag hurts its thrower, and dying to your own scores nothing", () => {
    const w = world()
    const a = place(w, "a", 14, 12)
    frag(w, "a", 16, 12)
    run(w, FRAG.fuse + 0.2)
    expect(a.alive).toBe(true)
    expect(a.health).toBeLessThan(HEALTH)
    run(w, 6)
    a.equipLeft = 1
    frag(w, "a", 16, 12)
    run(w, 1)
    place(w, "a", w.grenades[0]!.x, w.grenades[0]!.y)
    run(w, FRAG.fuse)
    expect(a.alive).toBe(false)
    expect(a.kills).toBe(0)
  })

  test("one piece of equipment per life", () => {
    const w = world(["a"])
    place(w, "a", 14, 12)
    expect(w.players.get("a")!.equipLeft).toBe(EQUIPS.frag.count)
    for (let i = 0; i < 4; i++) {
      frag(w, "a", 25, 12)
      run(w, 0.1)
    }
    expect(w.takeEvents().filter((e) => e.k === "throw").length).toBe(EQUIPS.frag.count)
  })

  test("the equipment pick applies on respawn", () => {
    const w = world()
    const a = w.players.get("a")!
    w.pickEquip("a", "claymore")
    expect(a.equip).toBe("frag")
    w.kill(a, w.players.get("b")!)
    run(w, RESPAWN_SECONDS + 0.2)
    expect(a.alive).toBe(true)
    expect(a.equip).toBe("claymore")
    expect(a.equipLeft).toBe(EQUIPS.claymore.count)
    expect(buildSnapshot(w, "a").you?.equip).toBe("claymore")
  })

  const plant = (names: string[] = ["a", "b"]) => {
    const w = world(names)
    const a = w.players.get("a")!
    w.pickEquip("a", "claymore")
    w.spawn(a)
    place(w, "a", 14, 12)
    for (const id of names.slice(1)) place(w, id, 30, 17)
    run(w, 1 / 30, (id) => (id === "a" ? { aim: east, equip: true } : {}))
    expect(w.claymores.length).toBe(1)
    return w
  }

  test("a claymore arms, then trips on someone walking into its cone and kills them", () => {
    const w = plant()
    run(w, CLAYMORE.arm + 0.1)
    // The owner walks around in front of it freely.
    place(w, "a", 16, 12)
    run(w, 0.5)
    expect(w.claymores[0]!.blowAt).toBe(0)
    place(w, "a", 10, 12)
    place(w, "b", 16.5, 12.2)
    run(w, 1 / 30)
    expect(w.takeEvents().some((e) => e.k === "beep")).toBe(true)
    run(w, CLAYMORE.delay + 0.1)
    expect(w.claymores.length).toBe(0)
    expect(w.players.get("b")!.alive).toBe(false)
    expect(w.players.get("a")!.alive).toBe(true)
    expect(w.players.get("a")!.kills).toBe(1)
  })

  test("a claymore does nothing before it arms, or to someone beside or behind it", () => {
    const w = plant()
    place(w, "b", 16, 12)
    run(w, 0.5)
    expect(w.claymores[0]!.blowAt).toBe(0)
    place(w, "b", 13, 12)
    run(w, CLAYMORE.arm)
    place(w, "b", 14.4, 15)
    run(w, 0.3)
    expect(w.claymores[0]!.blowAt).toBe(0)
    expect(w.players.get("b")!.alive).toBe(true)
  })

  test("shooting a claymore sets it off", () => {
    const w = plant(["a", "b"])
    run(w, CLAYMORE.arm + 0.1)
    const c = w.claymores[0]!
    const b = place(w, "b", c.x, c.y + 6)
    b.cooldownUntil = 0
    w.takeEvents()
    run(w, 0.2, (id) => (id === "b" ? { aim: -Math.PI / 2, fire: true } : {}))
    expect(w.claymores.length).toBe(0)
    expect(w.takeEvents().some((e) => e.k === "explode" && e.kind === "claymore")).toBe(true)
  })

  test("a frag sets off claymores in its blast", () => {
    const w = plant(["a", "b"])
    run(w, CLAYMORE.arm + 0.1)
    const c = w.claymores[0]!
    place(w, "b", c.x - 8, c.y + 5)
    frag(w, "b", c.x - 1, c.y + 1)
    run(w, FRAG.fuse + 0.2)
    expect(w.claymores.length).toBe(0)
  })

  test("a new claymore replaces your last one, and it outlives you", () => {
    const w = plant()
    const a = w.players.get("a")!
    w.kill(a, w.players.get("b")!)
    run(w, 0.5)
    expect(w.claymores.length).toBe(1)
    run(w, RESPAWN_SECONDS)
    place(w, "a", 20, 12)
    run(w, 1 / 30, (id) => (id === "a" ? { aim: east, equip: true } : {}))
    expect(w.claymores.length).toBe(1)
    expect(w.claymores[0]!.x).toBeGreaterThan(19)
  })
})

describe("frag flight", () => {
  const obstacles = (low: boolean) => {
    const b = new Builder()
    b.floor("carpet", 0, 0, 30, 10)
    b.wall(15, 0, 15.1, 10, low ? 1.3 : 2.7, low ? "partition" : "wall")
    b.prop("desk", 19, 3, 21, 7)
    return obstaclesOf(b.build({ id: "t", seed: 0, name: "t", size: [30, 10] }))
  }
  const fly = (o: ReturnType<typeof obstacles>, x: number, d: number) => {
    const g: Grenade = { id: 1, by: "a", at: 0, ...launch(x, 5, 0, d) }
    for (let i = 0; i < 60; i++) stepGrenade(g, o)
    return g
  }

  test("it comes to rest about where you aimed", () => {
    for (const d of [3, 6, 10]) expect(Math.abs(fly({ rects: [], h: [] }, 0, d).x - d)).toBeLessThan(1)
  })

  test("it sails over low partitions but bounces off walls", () => {
    expect(fly(obstacles(true), 11, 9).x).toBeGreaterThan(15.1)
    expect(fly(obstacles(false), 11, 9).x).toBeLessThan(15)
  })

  test("it can land on a desk and rest on top", () => {
    const g = fly(obstacles(false), 17, 4)
    expect(g.x).toBeGreaterThan(19)
    expect(g.x).toBeLessThan(21)
    expect(g.z).toBeCloseTo(PROP_TOP + FRAG.size, 2)
  })
})
