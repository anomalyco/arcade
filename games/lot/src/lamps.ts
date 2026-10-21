import { armFromPoles, pushLens, streetFluxGain, type LensShape, type StreetLampSettings } from "@arcade/kit/gpu/lights/street"
import { packVerts } from "@arcade/kit/gpu/mesh"
import type { SourceLamp, SourceScene } from "./world"

/** Vertex material of the street lamp lenses: emissive in `shaders.ts`, discarded when the lamps are Today. */
export const LENS_MAT = 41

export type StreetLamp = { arm: readonly [number, number]; a: number; b: number; lens: LensShape }

/**
 * Ashwood's pole lamps as lens emitters. The arm comes from the pole's collider; the lens from the fixture Ashwood
 * builds (`world/compound/lamps.ts`): the booth's cobra head has a 0.30 × 0.14 m sag bowl centred 5 cm above the light
 * (its source bowl is a quarter-wedge, `phiLength` π/2, so it renders as a ragged blob; this bowl covers it), the lot's
 * shoeboxes a flat 0.56 × 0.34 m glass 9 cm up; road davits get the cobra bowl. Lamps without a pole collider beside
 * them (mast arms on wooden poles) stay point spots.
 */
export function streetLamps(scene: SourceScene): Map<SourceLamp, StreetLamp> {
  const out = new Map<SourceLamp, StreetLamp>()
  for (const l of scene.lamps) {
    if (l.kind !== "sodium" || !l.angle) continue
    const arm = armFromPoles(l.position, scene.colliders)
    if (!arm) continue
    const [x, y, z] = l.position
    // Ashwood's lot shoeboxes sit 1.8 m out on a 0.6 m pier; cobra heads (booth, road davits) reach further or stand on
    // a slimmer shaft.
    const centre = (c: SourceScene["colliders"][number]) => [(c.min[0]! + c.max[0]!) / 2, (c.min[2]! + c.max[2]!) / 2] as const
    const width = (c: SourceScene["colliders"][number]) => Math.max(c.max[0]! - c.min[0]!, c.max[2]! - c.min[2]!)
    const pole = scene.colliders.filter(c => width(c) <= 0.9 && c.max[1]! >= y - 3).map(c => ({ c, d: Math.hypot(centre(c)[0] - x, centre(c)[1] - z) })).sort((p, q) => p.d - q.d)[0]
    const reach = pole?.d ?? 0
    const shoebox = !!pole && reach < 2.1 && width(pole.c) >= 0.5
    const lens: LensShape = shoebox
      ? { center: [x, y + 0.075, z], arm, a: 0.29, b: 0.175, depth: 0 }
      : { center: [x, y + 0.05, z], arm, a: 0.315, b: 0.148, depth: 0.08, tilt: 0.06 }
    out.set(l, { arm, a: lens.a, b: lens.b, lens })
  }
  return out
}

/** The lens bowls as one level chunk (sodium colour; aux carries the core-to-rim radiance weight). */
export function lensChunk(lamps: Map<SourceLamp, StreetLamp>): ArrayBuffer {
  const v: number[] = []
  for (const s of lamps.values()) pushLens(v, s.lens, [1, 0.55, 0.18], LENS_MAT)
  return packVerts(v)
}

/** Nadir intensity multiplier that keeps a lamp's flux when its round spot becomes the street profile. */
export const fluxGain = (l: SourceLamp, s: StreetLampSettings) => streetFluxGain(s, Math.cos(l.angle!), Math.cos(l.angle! * (1 - (l.penumbra ?? 0.55))))
