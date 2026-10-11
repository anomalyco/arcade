// STUB — owned by the World agent. Signatures are the contract; replace implementations.
import { Group, type Object3D, type Scene, type Vector3, type WebGLRenderer } from "three"
import type { Quality } from "../sim/types"

export interface WorldView {
  /** Add to the scene once. Contains terrain, water, sky, runways, base props, safe-zone domes, lights. */
  root: Object3D
  /** Stream LODs around the camera. Budgeted (≤ ~2 ms CPU per call). time in seconds. */
  update(cameraPosition: Vector3, dt: number, time: number): void
  setQuality(quality: Quality): void
  /** Show/hide a team's safe-zone dome (e.g. highlight own base). */
  setHighlightTeam(team: number | null): void
  /** True once terrain near the last camera position is generated. */
  ready(): boolean
  /** Camera far plane recommended for this quality. */
  far: number
  dispose(): void
}

export function createWorldView(renderer: WebGLRenderer, scene: Scene, quality: Quality): WorldView {
  const root = new Group()
  return { root, update() {}, setQuality() {}, setHighlightTeam() {}, ready: () => true, far: 20_000, dispose() {} }
}
