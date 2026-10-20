import { expect, test } from "bun:test"
import { SPRITE_FLOATS } from "@arcade/kit/gpu/renderer"
import { SPECIAL_BLOATER, SPECIAL_RULES, specialKindOf } from "../shared/specials/kinds"
import { spawnSpecial, specialsOf } from "../shared/specials/specials"
import { gasOnWire } from "../shared/specials/net"
import { GasClouds } from "../src/specials/gas"
import { featureRoom } from "./coop-feature-room"

for (const seat of [0, 1]) for (const rule of SPECIAL_RULES) test(`seat ${seat}: ${rule.id} seed, health and response survive full/delta snapshots and late join`, () => {
  const r = featureRoom()
  try {
    const actor = r.clients[seat]!
    r.place(actor, 30, 46)
    const z = spawnSpecial(r.core.sim, rule.kind, 33, 46, Math.PI)!
    r.tick(12)
    const check = () => {
      r.flush()
      for (const c of r.clients) {
        const remote = c.snapHistory.get(c.lastServerTick)!.zombies.find((a) => a.id === z.id)!
        expect(remote).toBeDefined()
        expect(specialKindOf(remote.seed)).toBe(rule.kind)
        expect(remote.hp).toBe(Math.round(z.hp))
        expect(remote.state).toBe(z.state)
        const drawn = c.view.zombies.find((a) => a.id === z.id)!
        expect(drawn.seed).toBe(z.seed)
        expect(drawn.hp).toBe(remote.hp)
      }
    }
    check()
    const hp = z.hp
    r.act(actor, { fire: true })
    r.tick(12)
    expect(z.hp).toBeLessThan(hp)
    check()
    r.join()
    r.tick(12)
    check()
  } finally { r.close() }
})

test("host and teammate kills: active and late clients receive the room's damaging gas", () => {
  const r = featureRoom()
  try {
    for (const actor of [r.a, r.b]) {
      r.place(actor, 30, 46)
      const z = spawnSpecial(r.core.sim, SPECIAL_BLOATER, 33, 46)!
      // One pistol hit kills; seed/kind and authoritative death rules remain real.
      z.hp = 1
      z.speedScale = 0
      r.tick(12)
      r.act(actor, { fire: true })
      r.tick(12)
      expect(z.state).toBe("dead")
      expect(specialsOf(r.core.sim).clouds.length).toBeGreaterThan(0)
      r.flush()
      for (const c of r.clients) expect(specialsOf(c.sim).clouds).toEqual(specialsOf(r.core.sim).clouds.map(gasOnWire))
    }
    r.join()
    r.tick(12)
    r.flush()
    const clouds = specialsOf(r.core.sim).clouds.map(gasOnWire)
    const draw = (source: typeof clouds) => {
      const gas = new GasClouds()
      gas.sync(source, r.core.sim.time)
      const sprites = new Float32Array(64 * SPRITE_FLOATS)
      const count = gas.draw(sprites, 0, r.core.sim.time, () => 0)
      expect(count).toBeGreaterThan(0)
      return sprites.slice(0, count * SPRITE_FLOATS)
    }
    const expectedSprites = draw(clouds)
    for (const c of r.clients) {
      expect(specialsOf(c.sim).clouds).toEqual(clouds)
      expect(draw(specialsOf(c.sim).clouds)).toEqual(expectedSprites)
    }
  } finally { r.close() }
})
