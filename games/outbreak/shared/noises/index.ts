import { registerOutbreakSharedFeature } from "../feature-registry"
import { noisesNetSection, type NetNoise, type NoisesSnapshot } from "./net"

/** The crowd's noise bus on the wire (`net.ts`), so co-op clients see the noises the room's dead hear. */
export const outbreakNoisesSharedFeature = registerOutbreakSharedFeature<undefined, NoisesSnapshot, Record<string, unknown>, NetNoise[]>({
  id: "noises",
  order: 45,
  netSection: noisesNetSection,
})
