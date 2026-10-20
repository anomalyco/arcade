import { expect, test } from "bun:test"
import { featureRoom } from "./coop-feature-room"

test("a seventh viewer gets a clear room-full response and leaving frees the seat", () => {
  const r = featureRoom()
  try {
    r.join(); r.join(); r.join(); r.join(); r.tick(24)
    expect(r.clients.slice(0, 6).every((c) => c.connected)).toBe(true)
    const seventh = r.join()
    r.tick(24)
    expect(seventh.connected).toBe(false)
    expect(seventh.status).toContain("full (6 survivors)")
    expect(r.core.sim.slots).toHaveLength(6)
    r.b.leave()
    r.tick(12)
    const replacement = r.join()
    r.tick(24)
    expect(replacement.connected).toBe(true)
    expect(r.core.sim.slots).toHaveLength(6)
  } finally { r.close() }
})
