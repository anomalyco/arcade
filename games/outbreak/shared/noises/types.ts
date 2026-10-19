import type { NoiseKind } from "../ai"

/**
 * A noise as the wire carries it: cm position and radius, ms age, loudness and ttl in 1/50ths. A survivor's noise
 * names their seat (`seat`), so each client can say whose it is; anything else keeps its source id (`zombie-12`,
 * `radio`, a dog's id).
 */
export type NetNoise = {
  id: number
  time: number
  kind: NoiseKind
  x: number
  y: number
  radius: number
  loudness: number
  ttl: number
  seat: number
  sourceId: string
}

/** `upTo`: the room's newest noise id when the snapshot was taken, so a delta sends only what came after its base. */
export type NoisesSnapshot = { upTo: number; events: NetNoise[] }
