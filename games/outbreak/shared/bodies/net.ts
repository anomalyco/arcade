import type { OutbreakNetSectionCodec } from "../feature-registry"
import type { BodiesSnapshot } from "./net-types"
import type { BodiesState } from "./runtime"

export const SEC_BODIES = 2048

export const bodiesNetSection: OutbreakNetSectionCodec<BodiesState, BodiesSnapshot> = {
  bit: SEC_BODIES,
  key: "bodies",
  collect: ({ sim, isDelta, baseSnap, viewerCenter, bubbleCx, bubbleCy, interest }) => {
    const rising = [...sim.progression.ledger.stores.values()]
      .filter((s) => s.id.startsWith("body:") && s.counts.rise && (!viewerCenter || !s.at ||
        (Math.abs(s.at.x - bubbleCx) <= interest.bubbleHalfExtent && Math.abs(s.at.y - bubbleCy) <= interest.bubbleHalfExtent)))
      .map((s) => ({ id: s.id, rise: s.counts.rise!, risen: Boolean(s.counts.risen) }))
      .sort((a, b) => a.id.localeCompare(b.id))
    const value = rising.length ? { rising } : undefined
    const base = isDelta ? baseSnap?.bodies : undefined
    return { snapshotValue: value, shouldWrite: JSON.stringify(value) !== JSON.stringify(base), writePayload: value ?? { rising: [] } }
  },
  encode: (w, s) => {
    w.uvar(s.rising.length)
    for (const b of s.rising) w.str(b.id).uvar(b.rise).u8(b.risen ? 1 : 0)
  },
  decode: (r) => {
    const rising: BodiesSnapshot["rising"] = []
    for (let n = r.uvar(), i = 0; i < n; i++) rising.push({ id: r.str(), rise: r.uvar(), risen: Boolean(r.u8()) })
    return rising.length ? { rising } : undefined
  },
  decodeOmitted: ({ isDelta, baseSnap }) => isDelta ? baseSnap?.bodies : undefined,
}
