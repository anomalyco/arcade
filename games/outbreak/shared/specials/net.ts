import type { OutbreakNetSectionCodec } from "../feature-registry"
import type { SpecialsState } from "./specials"
import type { GasCloud, SpecialsSnapshot } from "./net-types"

export const SEC_SPECIALS = 1024
const cm = (v: number) => Math.round(v * 100)
export const gasOnWire = (c: GasCloud): GasCloud => ({
  id: c.id, x: cm(c.x) / 100, y: cm(c.y) / 100,
  born: Math.fround(c.born), until: Math.fround(c.until), radius: cm(c.radius) / 100,
})

/** Send persistent hazards, not inferred deaths: a corpse can stream out before its gas expires. */
export const specialsNetSection: OutbreakNetSectionCodec<SpecialsState, SpecialsSnapshot> = {
  bit: SEC_SPECIALS,
  key: "specials",
  collect: ({ sim, state, viewerCenter, bubbleCx, bubbleCy, interest, isDelta, baseSnap }) => {
    const clouds = state.clouds.filter((c) => c.until > sim.time && (!viewerCenter ||
      (Math.abs(c.x - bubbleCx) <= interest.bubbleHalfExtent + c.radius &&
       Math.abs(c.y - bubbleCy) <= interest.bubbleHalfExtent + c.radius))).map(gasOnWire)
    const value = clouds.length ? { clouds } : undefined
    const base = isDelta ? baseSnap?.specials : undefined
    return { snapshotValue: value, shouldWrite: JSON.stringify(value) !== JSON.stringify(base), writePayload: value ?? { clouds: [] } }
  },
  encode: (w, value) => {
    w.uvar(value.clouds.length)
    for (const c of value.clouds) w.uvar(c.id).i32(cm(c.x)).i32(cm(c.y)).f32(c.born).f32(c.until).u16(cm(c.radius))
  },
  decode: (r) => {
    const clouds: GasCloud[] = []
    for (let n = r.uvar(), i = 0; i < n; i++) clouds.push({ id: r.uvar(), x: r.i32() / 100, y: r.i32() / 100, born: r.f32(), until: r.f32(), radius: r.u16() / 100 })
    return clouds.length ? { clouds } : undefined
  },
  decodeOmitted: ({ isDelta, baseSnap }) => isDelta ? baseSnap?.specials : undefined,
}
