export type LevelChunk = { data: ArrayBuffer; box: readonly [number, number, number, number]; cutBox?: readonly number[] }
export type FloorMap = { data: Uint8Array<ArrayBuffer>; w: number; h: number; linear?: Float32Array }
export type LevelData = { chunks: LevelChunk[]; glass: LevelChunk[]; floor: FloorMap; bounce: FloorMap }
