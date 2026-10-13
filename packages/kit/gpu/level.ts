export type LevelChunk = { data: ArrayBuffer; box: readonly [number, number, number, number]; cutBox?: readonly number[] }
export type BakedMap = { data: Uint8Array<ArrayBuffer>; w: number; h: number }
export type FloorMap = BakedMap & { linear?: Float32Array; moon?: BakedMap }
export type FloorLighting = FloorMap & { moon: BakedMap }
export type LevelData = { chunks: LevelChunk[]; glass: LevelChunk[]; floor: FloorMap; bounce: FloorMap }
