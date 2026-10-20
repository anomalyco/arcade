import { expect, test } from "bun:test"
import { featureRoom } from "./coop-feature-room"

test("a fifth viewer gets a clear room-full response and leaving frees the seat", () => {
  const r = featureRoom()
  try {
    r.join(); r.join(); r.tick(24)
    expect(r.clients.slice(0, 4).every((c) => c.connected)).toBe(true)
    const fifth = r.join()
    r.tick(24)
    expect(fifth.connected).toBe(false)
    expect(fifth.status).toContain("full (4 survivors)")
    expect(r.core.sim.slots).toHaveLength(4)
    r.b.leave()
    r.tick(12)
    const replacement = r.join()
    r.tick(24)
    expect(replacement.connected).toBe(true)
    expect(r.core.sim.slots).toHaveLength(4)
  } finally { r.close() }
})
