import type { Mesh } from "@arcade/kit/gpu/mesh"
import type { Parts } from "./figure"

/**
 * How a character looks: its re-dressed rig parts, an overall scale (the rig animates at 1 and the whole pose is
 * scaled, so feet stay planted), and what it holds in its right hand, modelled in the forearm's frame (hand at
 * y ≈ -0.28, +x forward).
 */
export type Look = {
  id: string
  scale: number
  parts: () => Parts
  prop?: () => Mesh
}
