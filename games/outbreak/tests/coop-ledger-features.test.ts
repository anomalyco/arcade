import { expect, test } from "bun:test"
import { bodySites, DEFAULT_BODIES_TUNING } from "../shared/bodies/bodies"
import type { BodiesState } from "../shared/bodies/runtime"
import { dogSites } from "../shared/dogs/dogs"
import { lampHeads, lampStoreId, porchSwitch } from "../shared/lights-out/lights"
import { radioStoreId } from "../shared/radios/radios"
import { featureRoom } from "./coop-feature-room"

for (const seat of [0, 1]) {
  for (const [item, prefixes] of [
    ["flamethrower", ["flamer:", "burn:", "fire:", "scorch:"]],
    ["dynamite", ["dyn:", "scorch:"]],
    ["molotov", ["fire:", "scorch:"]],
    ["firecrackers", ["crack:"]],
    ["flare-gun", ["flare:", "burn:"]],
    ["flare", ["flare:"]],
    ["bear-trap", ["trap:"]],
    // Throwables (AR-96): wound up on the button, thrown on release; the drop lies where it stops.
    ["baseball", ["toss:", "drop:t:"]],
    ["bottle", ["toss:", "glass:"]],
  ] as const) test(`seat ${seat}: ${item} reaches both peers and late join`, () => {
    const r = featureRoom()
    try {
      const actor = r.clients[seat]!
      r.place(actor, 30, 46)
      r.hold(actor, item)
      const z = r.core.sim.ai.spawnZombie(r.core.sim.town, item === "bear-trap" ? 30.6 : 33, 46, "wander")
      z.speedScale = 0
      r.act(actor, { fire: true, fireHeld: true })
      if (item === "baseball" || item === "bottle") r.act(actor, { fireHeld: true }, 20)
      r.act(actor, { fireHeld: item === "flamethrower" }, 30)
      r.ledgerParity(prefixes)
      if (item === "flamethrower" || item === "flare-gun") expect([...r.core.sim.progression.ledger.stores.keys()].some((id) => id.startsWith("burn:"))).toBe(true)
      if (item === "bear-trap") expect([...r.core.sim.progression.ledger.stores.values()].find((s) => s.id.startsWith("trap:"))?.counts.z).toBe(z.id + 1)
      r.join()
      r.tick(12)
      r.ledgerParity(prefixes)
      // Cross the fuse/expiry boundary too, not just initial creation.
      r.tick(item === "dynamite" ? 180 : 36)
      r.ledgerParity(prefixes)
      if (item === "dynamite") expect([...r.core.sim.progression.ledger.stores.values()].find((s) => s.id.startsWith("dyn:"))?.counts.done).toBe(1)
    } finally { r.close() }
  })

  test(`seat ${seat}: radios, fed dogs, broken lamps and recipe knowledge are shared`, () => {
    const r = featureRoom()
    try {
      const actor = r.clients[seat]!
      r.place(actor, 24.5, 34.5, -Math.PI / 2)
      r.act(actor, { interact: true })
      r.tick(12)
      expect(r.core.sim.progression.ledger.store(radioStoreId("ash"))?.counts.on).toBe(1)
      r.ledgerParity(["radio:"])
      const porch = r.core.sim.town.lamps.filter((l) => l.kind === "porch").sort((a, b) => Math.hypot(a.x - 28, a.y - 35) - Math.hypot(b.x - 28, b.y - 35))[0]!
      const sw = porchSwitch(porch)
      r.place(actor, sw.x - 0.1, sw.y + 0.7, -Math.PI / 2)
      r.act(actor, { interact: true })
      r.tick(12)
      expect(r.core.sim.progression.ledger.store(lampStoreId(porch))?.counts.off).toBe(1)
      r.ledgerParity(["lamp:"])
      const dog = dogSites(r.core.sim.town).find((d) => d.buildingId === "elm")!
      r.core.sim.progression.ledger.apply({ kind: "grant", actor: actor.id, item: "food", count: 1 })
      r.place(actor, dog.x + dog.chain + 0.6, dog.y + 0.4, Math.PI)
      r.act(actor, { interact: true })
      r.tick(12)
      expect(r.core.sim.progression.ledger.store(dog.id)?.counts.fed).toBe(1)
      r.ledgerParity(["dog:"])
      const lamp = r.core.sim.town.lamps.find((l) => l.kind === "street")!
      const h = lampHeads(lamp)[0]!
      r.hold(actor, "pistol", 0)
      r.place(actor, h.x - 3, h.y + 3, -Math.PI / 4)
      r.act(actor, { fire: true })
      r.tick(12)
      expect(r.core.sim.progression.ledger.store(lampStoreId(lamp))?.counts.broken).toBe(1)
      r.ledgerParity(["lamp:", "glass:"])
      for (const item of ["bottle", "chem"]) r.core.sim.progression.ledger.apply({ kind: "grant", actor: actor.id, item, count: 2 })
      r.tick(12)
      r.ledgerParity(["team/known", "pin:"])
      for (const c of r.clients) expect(c.sim.progression.board.corkboard()).toEqual(r.core.sim.progression.board.corkboard())
      r.join()
      r.tick(12)
      r.ledgerParity(["radio:", "dog:", "lamp:", "glass:", "team/known", "pin:"])
    } finally { r.close() }
  })

  for (const rise of [false, true]) test(`seat ${seat}: body ${rise ? "reanimates" : "searches"} on both peers and late join`, () => {
    const r = featureRoom()
    try {
      const actor = r.clients[seat]!
      const body = bodySites(r.core.sim.town).find((b) => b.key === "porch:ash")!
      expect(body).toBeDefined()
      r.place(actor, body.x - 0.4, body.y + 0.8, Math.atan2(-0.8, 0.4))
      // Pin the body's hidden random roll; all search/reanimation actions still run in the room.
      r.core.sim.getFeatureState<BodiesState>("bodies")!.sites.find((b) => b.id === body.id)!.riseRoll = rise ? 0 : 1
      expect(r.core.sim.slot(actor.id)!.prompt?.kind).toBe("body")
      r.act(actor, { interact: true })
      r.tick(Math.ceil(60 * (rise ? DEFAULT_BODIES_TUNING.bodyRiseDelay : DEFAULT_BODIES_TUNING.bodySearchTime)) + 12)
      const store = r.core.sim.progression.ledger.store(body.id)!
      expect(rise ? store.counts.risen : store.revealed).toBe(rise ? 1 : true)
      r.ledgerParity([body.id, `drop:body:${body.key}`])
      if (rise) expect(r.core.sim.ai.agents.some((z) => z.state !== "dead")).toBe(true)
      r.join()
      r.tick(12)
      r.ledgerParity([body.id, `drop:body:${body.key}`])
    } finally { r.close() }
  })

  test(`seat ${seat}: dragged and braced furniture reaches both peers and late join (AR-96)`, () => {
    const r = featureRoom()
    try {
      const actor = r.clients[seat]!
      const door = r.core.sim.town.doors.find((d) => d.id === "ash-front")!
      const cx = (door.rect[0] + door.rect[2]) / 2
      const st = [...r.core.sim.progression.ledger.stores.values()].find((s) => s.id.startsWith("furn:ash:"))!
      st.at = { x: cx, y: door.rect[1] - 1.5 }
      st.counts = { k: 2, yaw: 0 }
      st.rev = ++r.core.sim.progression.ledger.rev
      r.place(actor, cx, door.rect[1] - 2.3, Math.PI / 2)
      r.act(actor, { interact: true, aim: Math.PI / 2 })
      r.tick(6)
      expect(st.counts.drag).toBe(1)
      r.act(actor, { my: 1, aim: Math.PI / 2 }, 30)
      r.act(actor, { interact: true, aim: Math.PI / 2 })
      r.tick(12)
      expect(st.counts.br).toBe(1)
      r.ledgerParity(["furn:ash:"])
      r.join()
      r.tick(12)
      r.ledgerParity(["furn:ash:"])
    } finally { r.close() }
  })
}
