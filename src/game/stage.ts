import { GADGETS, LOADOUT } from "../../shared/config"
import { newGadgets } from "../../shared/sim/gadgets"
import type { World } from "../../shared/sim/world"

/**
 * Dev-only staged moments for screenshot comparisons against the concept art (`?stage=<name>`, add `&freeze`
 * to stop the simulation). Positions are around the intersection at (228, 152).
 */
export function applyStage(w: World, name: string, viewer = "me") {
  const r = w.robber()
  if (!r) return
  w.phase = "chase"
  w.phaseT = 30
  w.t = 45
  const cops = w.cops()
  const park = (i: number) => Object.assign(cops[i]!.body, { x: -200, z: -200, vx: 0, vz: 0 })
  cops.forEach((_, i) => park(i))
  const put = (b: { x: number; z: number; h: number; vx: number; vz: number }, x: number, z: number, h: number, vx: number, vz: number) => Object.assign(b, { x, z, h, vx, vz })
  const strip = (x: number, z: number, owner: number) => {
    const s = GADGETS.spike
    w.props.push({ id: 900 + w.props.length, kind: "spike", x, z, h: 0, r: s.radius, life: s.ttl, ttl: s.ttl, owner, team: "cop", revealed: true, hits: [] })
  }
  if (name === "spike") {
    // The driver heading up the x=228 avenue toward a spike strip (freeze under ~0.7 s to see it ahead, ~1.6 s for the flat).
    put(r.body, 227, 128, 0, 0, 16)
    strip(228, 146, cops[0]!.id)
    strip(228, 186, cops[1]!.id)
  } else if (name === "spikecop") {
    // You are a cop tailing the driver, who is about to run over a strip; one charge left and on cooldown.
    const me = w.carOf(viewer)!
    const rob = cops.find((c) => c.ownerId !== viewer)!
    const copVehicle = rob.vehicle
    rob.role = "robber"
    rob.vehicle = me.vehicle
    me.role = "cop"
    me.vehicle = copVehicle
    w.robberId = rob.ownerId
    put(me.body, 228, 126, 0, 0, 12)
    put(rob.body, 228, 148, 0, 0, 14)
    strip(228, 162, me.id)
    strip(228, 138, me.id)
    me.gadgets = newGadgets(LOADOUT.cop)
    rob.gadgets = newGadgets(LOADOUT.robber)
    Object.assign(me.gadgets[0]!, { charges: 1, cooldown: 6 })
  } else if (name === "chase") {
    // dir-d-lowpoly-1: robber drifting up the x=228 avenue (screen up-right), three cruisers strung out behind
    // toward the screen's lower left, heli off to the upper left with its beam on the road ahead.
    put(r.body, 226, 150, 0.1, 2, 21)
    const trail = [
      [222, 128, 0.25],
      [231, 112, -0.1],
      [225, 96, 0.05],
    ] as const
    trail.forEach(([x, z, h], i) => cops[i] && put(cops[i]!.body, x, z, h, 0, 18))
    Object.assign(w.heli, { active: true, x: 250, y: 16, z: 160, h: -1.6, sx: 238, sz: 186 })
  } else if (name === "copview" || name === "copping") {
    // You are a cop far from the action. copview: another cop has the driver on screen 250 m away.
    // copping: nobody sees the driver, so you get the last-seen ping.
    const me = w.carOf(viewer)!
    const rob = cops.find((c) => c.ownerId !== viewer)!
    const copVehicle = rob.vehicle
    rob.role = "robber"
    rob.vehicle = me.vehicle
    me.role = "cop"
    me.vehicle = copVehicle
    w.robberId = rob.ownerId
    put(me.body, 228, 100, 0, 0, 0)
    put(rob.body, name === "copview" ? 428 : 290, name === "copview" ? 260 : 150, 0.5, 4, 14)
    const other = w.cops().find((c) => c !== me)
    if (other) put(other.body, name === "copview" ? 423 : -150, name === "copview" ? 245 : -150, 0.4, 4, 14)
    w.lastSeen = { x: 270, z: 130, t: w.t }
  } else if (name === "roadblock") {
    // dir-d-lowpoly-2: suspect pinned by the spotlight, cruisers converging.
    put(r.body, 236, 156, 1.2, 9, 3)
    const ring = [
      [216, 140, 0.9],
      [222, 170, 2.3],
      [252, 168, -2.4],
    ] as const
    ring.forEach(([x, z, h], i) => cops[i] && put(cops[i]!.body, x, z, h, 4, 0))
    Object.assign(w.heli, { active: true, x: 252, y: 30, z: 128, h: 2.6, sx: 236, sz: 156 })
  }
}
