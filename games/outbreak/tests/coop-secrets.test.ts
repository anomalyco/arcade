import { describe, expect, test } from "bun:test"
import { DEFAULT_DEATH_TUNING } from "../shared/death/rules"
import { forceLife } from "../shared/death/runtime"
import { CELLAR_STASH, CELLAR_STORE, cellarLock, type SecretsState } from "../shared/secrets/cellar"
import { secretSitesIn } from "../shared/secrets/places"
import { featureRoom } from "./coop-feature-room"

const PREFIXES = ["secret:"]

/** The room's run (seed 7 has the cellar) and, once its house has streamed in round `actor`, the hatch. */
function cellarOf(r: ReturnType<typeof featureRoom>, actor: ReturnType<typeof featureRoom>["a"]) {
  const state = r.core.sim.getFeatureState<SecretsState>("secrets")!
  const host = state.hosts.get("cellar")!
  expect(host).toBeDefined()
  r.place(actor, (host.rect[0] + host.rect[2]) / 2, host.rect[3] + 3)
  const hatch = state.hatch!
  expect(hatch).not.toBeNull()
  r.place(actor, hatch.x, hatch.y + 0.95, -Math.PI / 2)
  return { state, hatch }
}

describe("secrets in co-op", () => {
  test("every client and a late joiner plan the same run, hosts and pieces as the room", () => {
    const r = featureRoom()
    try {
      const want = r.core.sim.getFeatureState<SecretsState>("secrets")!
      expect(want.run.picked.has("cellar")).toBe(true)
      const late = r.join()
      r.tick(24)
      for (const c of [...r.clients, late]) {
        const got = c.sim.getFeatureState<SecretsState>("secrets")!
        expect([...got.run.picked]).toEqual([...want.run.picked])
        expect(got.run.code).toEqual(want.run.code)
        expect([...got.hosts.entries()]).toEqual([...want.hosts.entries()])
        for (const b of r.core.sim.town.buildings) {
          if (!c.sim.town.buildings.some((x) => x.id === b.id)) continue
          expect(secretSitesIn(c.sim.town, b, got.run, got.hosts)).toEqual(secretSitesIn(r.core.sim.town, b, want.run, want.hosts))
        }
      }
    } finally {
      r.close()
    }
  })

  for (const seat of [0, 1]) {
    test(`seat ${seat}: turning the padlock's dials reaches everyone and a late joiner; the code opens it; the stash is taken once`, () => {
      const r = featureRoom()
      try {
        const actor = r.clients[seat]!
        const { state } = cellarOf(r, actor)
        const [a, b, c] = state.run.code
        // A tap turns the dial; a hold moves to the next one.
        r.act(actor, { interact: true, interactHeld: true })
        r.act(actor, { interactHeld: false }, 2)
        expect(cellarLock(r.core.sim.progression.ledger.store(CELLAR_STORE)).dials).toEqual([1, 0, 0])
        r.ledgerParity(PREFIXES)
        r.act(actor, { interact: true, interactHeld: true })
        r.act(actor, { interactHeld: true }, 40)
        r.act(actor, { interactHeld: false }, 2)
        expect(cellarLock(r.core.sim.progression.ledger.store(CELLAR_STORE)).dial).toBe(1)
        r.ledgerParity(PREFIXES)
        // A late joiner arrives to the same half-set lock.
        r.join()
        r.tick(24)
        r.ledgerParity(PREFIXES)
        // Dial 1 back round to the hour, then the day and the number, by explicit actions.
        const turn = (n: number) => {
          for (let i = 0; i < n; i++) {
            r.act(actor, { interact: true, interactAction: "board" })
            r.tick(2)
          }
        }
        const next = () => {
          r.act(actor, { interact: true, interactAction: "install" })
          r.tick(2)
        }
        next()
        next()
        turn((a - 1 + 10) % 10)
        next()
        turn(b)
        next()
        turn(c)
        r.tick(6)
        const lock = cellarLock(r.core.sim.progression.ledger.store(CELLAR_STORE))
        expect(lock.dials).toEqual([a, b, c])
        expect(lock.open).toBe(true)
        r.ledgerParity(PREFIXES)
        r.act(actor, { interact: true, interactAction: "take" })
        r.tick(6)
        expect(r.core.sim.progression.contents(CELLAR_STASH)).toEqual([])
        expect(r.core.sim.progression.hotbar(actor.id)!.slots.some((s) => s?.item === "flamethrower")).toBe(true)
        r.ledgerParity(PREFIXES)
        for (const cl of r.clients) expect(cellarLock(cl.sim.progression.ledger.store(CELLAR_STORE)).open).toBe(true)
      } finally {
        r.close()
      }
    })
  }

  test("Restart shuts the cellar again for everyone", () => {
    const r = featureRoom()
    try {
      const actor = r.clients[0]!
      cellarOf(r, actor)
      r.act(actor, { interact: true, interactAction: "board" })
      r.tick(6)
      expect(r.core.sim.progression.ledger.store(CELLAR_STORE)).toBeDefined()
      for (const s of r.core.sim.slots) forceLife(r.core.sim, s, "dead", DEFAULT_DEATH_TUNING)
      r.tick(12)
      const storage = [...r.stores]
      actor.restart()
      r.tick(6)
      for (const c of r.clients) c.close()
      r.clients.length = 0
      for (const s of storage) r.join(s)
      r.tick(24)
      r.flush()
      for (const sim of [r.core.sim, ...r.clients.map((c) => c.sim)]) {
        expect(sim.progression.ledger.store(CELLAR_STORE)).toBeUndefined()
        expect(sim.progression.ledger.store(CELLAR_STASH)).toBeUndefined()
      }
    } finally {
      r.close()
    }
  })
})
