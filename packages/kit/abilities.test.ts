import { describe, expect, test } from "bun:test"
import { Abilities, type AbilityActor, type AbilityDef, type AbilityHost, abilityState, abilityView, movement } from "./sim/abilities"
import type { Rect } from "./sim/geom"
import { Props } from "./sim/props"

type Actor = AbilityActor & { hp: number; knocks: number[] }

const DT = 1 / 30
const KINDS = { crate: { hl: 0.4, hw: 0.4, height: 0.8, mass: 30, friction: 6, hp: 30 }, barrel: { hl: 0.3, hw: 0.3, height: 0.9, mass: 40, friction: 5, hp: 10, explode: { radius: 2.5, impulse: 12 } } }

function world(defs: AbilityDef[], walls: Rect[] = []) {
  const actors: Actor[] = []
  const props = new Props(KINDS)
  const host: AbilityHost<Actor> & { time: number } = {
    time: 0,
    dt: DT,
    solids: walls,
    actors,
    props,
    abilities: () => defs,
    hit(t, h, _by, fx, fy, scale) {
      t.hp -= h.damage * scale
      const d = Math.hypot(t.x - fx, t.y - fy) || 1
      t.vx += ((t.x - fx) / d) * h.knock
      t.vy += ((t.y - fy) / d) * h.knock
      t.knocks.push(h.knock)
    },
  }
  const ab = new Abilities(host)
  const add = (id: string, x: number, y: number): Actor => {
    const a: Actor = { id, x, y, vx: 0, vy: 0, aim: 0, alive: true, radius: 0.35, ab: abilityState(defs.length), hp: 100, knocks: [] }
    actors.push(a)
    return a
  }
  const tick = (n = 1) => {
    for (let i = 0; i < n; i++) {
      host.time += DT
      for (const a of actors) ab.stepActor(a)
      ab.step()
      props.step(DT, walls, actors, [])
    }
  }
  return { host, ab, add, tick, props }
}

describe("abilities", () => {
  test("wind-up delays the release and the cooldown gates recasts", () => {
    const swing: AbilityDef = { id: "swing", name: "Swing", blurb: "", windup: 0.2, cooldown: 1, effects: [{ kind: "melee", range: 1.5, arc: 1.5, hit: { damage: 10, knock: 5 } }] }
    const w = world([swing])
    const a = w.add("a", 0, 0)
    const b = w.add("b", 1, 0)
    expect(w.ab.cast(a, 0, 1, 0)).toBe(true)
    w.tick(3)
    expect(b.hp).toBe(100)
    w.tick(4)
    expect(b.hp).toBe(90)
    expect(w.ab.cast(a, 0, 1, 0)).toBe(false)
    w.tick(30)
    expect(w.ab.cast(a, 0, 1, 0)).toBe(true)
  })

  test("projectiles fly, hit the first foe and run onHit (swap)", () => {
    const swap: AbilityDef = { id: "swap", name: "Swap", blurb: "", windup: 0, cooldown: 1, effects: [{ kind: "projectile", look: "card", speed: 15, radius: 0.3, range: 12, hit: { damage: 5, knock: 0 }, onHit: [{ kind: "swap" }] }] }
    const w = world([swap])
    const a = w.add("a", 0, 0)
    const b = w.add("b", 6, 0.2)
    w.ab.cast(a, 0, 10, 0)
    w.tick(20)
    expect(b.hp).toBe(95)
    expect(a.x).toBeCloseTo(6, 3)
    expect(b.x).toBeCloseTo(0, 3)
    expect(w.ab.projectiles.length).toBe(0)
  })

  test("walls stop projectiles and lobs land at the aim point", () => {
    const pan: AbilityDef = { id: "pan", name: "Pan", blurb: "", windup: 0, cooldown: 0, range: 8, effects: [{ kind: "projectile", look: "pan", speed: 12, radius: 0.3, range: 20, hit: { damage: 5, knock: 5 }, onEnd: [{ kind: "zone", look: "grease", at: "here", radius: 1.5, life: 3, status: [{ kind: "slide", time: 0.3 }] }] }] }
    const lob: AbilityDef = { ...pan, id: "lob", effects: [{ ...(pan.effects[0] as Extract<AbilityDef["effects"][number], { kind: "projectile" }>), lob: true }] }
    const w = world([pan, lob], [[4, -5, 4.5, 5]])
    const a = w.add("a", 0, 0)
    w.ab.cast(a, 0, 8, 0)
    w.tick(30)
    expect(w.ab.zones[0]!.x).toBeLessThan(4)
    w.ab.cast(a, 1, 0, 6)
    w.tick(40)
    expect(w.ab.zones[1]!.y).toBeCloseTo(6, 1)
  })

  test("a swarm chases a foe, stings it and smoke scatters it", () => {
    const bees: AbilityDef = { id: "bees", name: "Bees", blurb: "", windup: 0, cooldown: 0, effects: [{ kind: "swarm", look: "bees", count: 10, speed: 5, turn: 6, life: 8, radius: 1, seek: 10, hit: { damage: 2, knock: 1 }, every: 0.3 }] }
    const smoke: AbilityDef = { id: "smoke", name: "Smoke", blurb: "", windup: 0, cooldown: 0, effects: [{ kind: "zone", look: "smoke", at: "self", radius: 2.5, life: 5, smoke: true }] }
    const w = world([bees, smoke])
    const a = w.add("a", 0, 0)
    const b = w.add("b", 0, 6)
    w.ab.cast(a, 0, 5, 0)
    w.tick(60)
    expect(b.hp).toBeLessThan(100)
    w.ab.cast(b, 1, b.x, b.y)
    w.tick(60)
    expect(w.ab.swarms.length).toBe(0)
    expect(w.ab.events.some((e) => e.k === "scatter")).toBe(true)
  })

  test("dash moves, strikes once, leaves a slippery trail and statuses change movement", () => {
    const skate: AbilityDef = { id: "skate", name: "Skate", blurb: "", windup: 0, cooldown: 0, effects: [{ kind: "dash", speed: 15, time: 0.3, hit: { damage: 8, knock: 10 }, trail: { look: "ice", radius: 0.8, life: 4, every: 0.06, status: [{ kind: "slide", time: 0.3 }] } }] }
    const w = world([skate])
    const a = w.add("a", 0, 0)
    const b = w.add("b", 2, 0)
    w.ab.cast(a, 0, 10, 0)
    w.tick(12)
    expect(a.x).toBeGreaterThan(3.5)
    expect(b.knocks).toEqual([10])
    expect(w.ab.zones.length).toBeGreaterThan(2)
    const c = w.add("c", 1.5, 0.3)
    w.tick(1)
    expect(movement(c, [skate], w.host.time).accel).toBeLessThan(1)
  })

  test("grab carries a crate and throws it into a foe; barrels explode", () => {
    const grab: AbilityDef = { id: "grab", name: "Grab", blurb: "", windup: 0, cooldown: 0, effects: [{ kind: "grab", range: 1.4, arc: 1.6, hold: 0.3, throwSpeed: 16, hit: { damage: 10, knock: 15 } }] }
    const w = world([grab])
    const a = w.add("a", 0, 0)
    const crate = w.props.add("crate", 0.9, 0)
    const b = w.add("b", 5, 0)
    w.ab.cast(a, 0, 3, 0)
    w.tick(1)
    expect(crate.held).toBe("a")
    w.tick(30)
    expect(crate.held).toBe("")
    expect(b.hp).toBeLessThan(100)
    const barrel = w.props.add("barrel", 8, 8)
    const events: Parameters<Props["damage"]>[3] = []
    w.props.damage(barrel, 20, "a", events)
    expect(events.map((e) => e.k)).toEqual(["prop-break", "prop-boom"])
  })

  test("replicates compactly and deterministically", () => {
    const bees: AbilityDef = { id: "bees", name: "Bees", blurb: "", windup: 0.1, cooldown: 0, effects: [{ kind: "swarm", look: "bees", count: 10, speed: 5, turn: 6, life: 8, radius: 1, seek: 10, hit: { damage: 2, knock: 1 }, every: 0.3 }, { kind: "decoy", life: 3 }] }
    const run = () => {
      const w = world([bees])
      const a = w.add("a", 0, 0)
      w.add("b", 3, 4)
      w.ab.cast(a, 0, 5, 0)
      w.tick(45)
      return JSON.stringify(abilityView(w.ab, w.host.time))
    }
    const one = run()
    expect(one).toBe(run())
    expect(one.length).toBeLessThan(120)
  })
})
