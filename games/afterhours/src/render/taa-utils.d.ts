// three r186 ships these TAA helpers without type declarations (@types/three 0.185 predates them).
declare module "three/addons/tsl/utils/TAAUtils.js" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type N = any
  export const clipAABB: N
  export const flickerReduction: N
  export const sampleCurrentDepth: N
  export const samplePreviousDepth: N
  export function computeHaltonOffsets(length: number): [number, number][]
}
