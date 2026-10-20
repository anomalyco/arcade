import type { OutbreakNetSectionCodec } from "../feature-registry"
import type { Town } from "../map"
import type { BreachSnapshot, BreachWire } from "./net-types"
import { freshWear, type BreachState, type PortalWear } from "./rules"

export type { BreachSnapshot, BreachWire }

export const SEC_BREACH = 8192


export const F_BROKEN = 1
export const F_GIVING = 2
export const F_HOLED = 4
export const F_WEDGED = 8
export const F_DEBRIS = 16
export const F_GRABBING = 32
export const F_GIVING_BOARDS = 64
export const F_BREACHED = 128

export function portalIds(town: Pick<Town, "doors" | "windows">): string[] {
  return [...town.doors.map((d) => d.id), ...town.windows.map((w) => w.id)]
}

export function wearToWire(portal: number, integrity: number, w: PortalWear): BreachWire | null {
  const flags =
    (w.broken ? F_BROKEN : 0) |
    (w.givingAt >= 0 ? F_GIVING : 0) |
    (w.holed ? F_HOLED : 0) |
    (w.wedged ? F_WEDGED : 0) |
    (w.debris ? F_DEBRIS : 0) |
    (w.grabbing ? F_GRABBING : 0) |
    (w.givingAt >= 0 && w.giving === 1 ? F_GIVING_BOARDS : 0) |
    (w.breachAt >= 0 ? F_BREACHED : 0)
  const pushers = Math.min(7, w.pushers)
  const braced = Math.min(3, w.braced)
  const hp = Math.max(0, Math.min(100, Math.round(integrity)))
  if (!flags && !pushers && !braced && hp >= 100) return null
  return {
    portal,
    integrity: hp,
    flags,
    kind: w.kind & 7,
    doorKind: w.doorKind & 7,
    pushers,
    braced,
    outside: w.outside > 0 ? 1 : w.outside < 0 ? -1 : 0,
    givingAt: w.givingAt >= 0 ? Math.fround(w.givingAt) : -1,
    breachAt: w.breachAt >= 0 ? Math.fround(w.breachAt) : -1,
    debrisX: w.debris ? Math.round(w.debris.x * 100) / 100 : 0,
    debrisY: w.debris ? Math.round(w.debris.y * 100) / 100 : 0,
  }
}

/**
 * Door and barricade wear (AR-97, bit 8192): every damaged opening in the room's town, so a late joiner sees the same
 * cracked doors, hanging boards and fallen slabs. Only written when something changed against the acked base; an
 * empty list clears it. About 5 bytes an opening, plus 4 for a warning beat or breach time and 8 for a slab.
 */
export const breachNetSection: OutbreakNetSectionCodec<BreachState, BreachSnapshot> = {
  bit: SEC_BREACH,
  key: "breach",
  collect: ({ sim, isDelta, baseSnap, state }) => {
    const portals: BreachWire[] = []
    if (state?.on) {
      const ids = portalIds(sim.town)
      ids.forEach((id, i) => {
        const w = state.portals[id]
        if (!w) return
        const wire = wearToWire(i, sim.ai.portalStates.get(id)?.integrity ?? 100, w)
        if (wire) portals.push(wire)
      })
    }
    const value = portals.length ? { portals } : undefined
    const base = isDelta ? baseSnap?.breach : undefined
    return { snapshotValue: value, shouldWrite: JSON.stringify(value) !== JSON.stringify(base), writePayload: value ?? { portals: [] } }
  },
  encode: (w, s) => {
    w.uvar(s.portals.length)
    for (const p of s.portals) {
      w.uvar(p.portal).u8(p.integrity).u8(p.flags).u8(p.kind | (p.pushers << 3) | (p.braced << 6)).u8((p.outside + 1) | (p.doorKind << 2))
      if (p.flags & F_GIVING) w.f32(p.givingAt)
      if (p.flags & F_BREACHED) w.f32(p.breachAt)
      if (p.flags & F_DEBRIS) w.i32(Math.round(p.debrisX * 100)).i32(Math.round(p.debrisY * 100))
    }
  },
  decode: (r) => {
    const portals: BreachWire[] = []
    for (let n = r.uvar(), i = 0; i < n; i++) {
      const portal = r.uvar()
      const integrity = r.u8()
      const flags = r.u8()
      const packed = r.u8()
      const side = r.u8()
      const outside = (side & 3) - 1
      const doorKind = (side >> 2) & 7
      const givingAt = flags & F_GIVING ? r.f32() : -1
      const breachAt = flags & F_BREACHED ? r.f32() : -1
      const debrisX = flags & F_DEBRIS ? r.i32() / 100 : 0
      const debrisY = flags & F_DEBRIS ? r.i32() / 100 : 0
      portals.push({ portal, integrity, flags, kind: packed & 7, doorKind, pushers: (packed >> 3) & 7, braced: packed >> 6, outside, givingAt, breachAt, debrisX, debrisY })
    }
    return portals.length ? { portals } : undefined
  },
  decodeOmitted: ({ isDelta, baseSnap }) => (isDelta ? baseSnap?.breach : undefined),
}

/** Writes a decoded section into a client's copy of the sim: the wear by portal id and each door's integrity. */
export function applyBreachSnapshot(
  state: BreachState,
  town: Pick<Town, "doors" | "windows">,
  portalStates: Map<string, { integrity: number }>,
  snap: BreachSnapshot | undefined,
): void {
  const ids = portalIds(town)
  const seen = new Set<string>()
  state.on = true
  for (const p of snap?.portals ?? []) {
    const id = ids[p.portal]
    if (!id) continue
    seen.add(id)
    const w = (state.portals[id] ??= freshWear())
    w.pushers = p.pushers
    w.braced = p.braced
    w.outside = p.outside
    w.grabbing = Boolean(p.flags & F_GRABBING)
    w.givingAt = p.flags & F_GIVING ? p.givingAt : -1
    w.giving = p.flags & F_GIVING_BOARDS ? 1 : 0
    w.broken = Boolean(p.flags & F_BROKEN)
    w.holed = Boolean(p.flags & F_HOLED)
    w.wedged = Boolean(p.flags & F_WEDGED)
    w.kind = p.kind
    w.doorKind = p.doorKind
    w.breachAt = p.flags & F_BREACHED ? p.breachAt : -1
    w.debris = p.flags & F_DEBRIS ? { x: p.debrisX, y: p.debrisY } : null
    const st = portalStates.get(id)
    if (st) st.integrity = p.integrity
  }
  for (const id in state.portals) {
    if (seen.has(id)) continue
    delete state.portals[id]
    const st = portalStates.get(id)
    if (st) st.integrity = 100
  }
}
