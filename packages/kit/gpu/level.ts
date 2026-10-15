export type LevelChunk = {
  data: ArrayBuffer
  /** Optional active byte count when `data` is a pooled ArrayBuffer with larger capacity. */
  byteLength?: number
  /** Optional toroidal streaming slot (0..24) and cache key so unchanged chunks stay resident on the GPU. */
  streamSlot?: number
  streamKey?: string
  box: readonly [number, number, number, number]
  cutBox?: readonly number[]
  /**
   * true: uses the discard entry point while the player is inside cutBox (and opaque outside).
   * "outside": drawn with the opaque entry point only while the player is outside cutBox (100% discarded inside).
   * "a2c": drawn with the alpha-to-coverage pipeline after opaque chunks so main opaque geometry retains TBDR HSR.
   * "fade": drawn with the discard entry point while a late-arriving chunk fades in over 0.28s.
   */
  customCutaway?: boolean | "outside" | "a2c" | "fade"
}
export type BakedMap = { data: Uint8Array<ArrayBuffer>; w: number; h: number }
export type FloorMap = BakedMap & { linear?: Float32Array; moon?: BakedMap }
export type FloorLighting = FloorMap & { moon: BakedMap }
export type LevelData = { chunks: LevelChunk[]; glass: LevelChunk[]; floor: FloorMap; bounce: FloorMap; geometryOnly?: boolean }

/** Older level writers pack directional/sky coverage in green; Blackout supplies its finer mask separately. */
export function directionalMask(floor: FloorMap): BakedMap {
  if (floor.moon) return floor.moon
  const data = new Uint8Array(floor.w * floor.h)
  for (let i = 0; i < data.length; i++) data[i] = floor.data[i * 2 + 1]!
  return { data, w: floor.w, h: floor.h }
}
