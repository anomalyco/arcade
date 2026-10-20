import type * as THREE from "three/webgpu"
import type { Builder } from "../kit"

/**
 * A storey's content module (src/world/interior/storeys/sN.ts). The interior entry point creates one `Builder` per
 * storey (already lifted to that storey: author everything in ground-floor coordinates, FLOOR_Y = 0.16), calls `build`,
 * then flushes the builder and bakes its placed models. The shared structure — slabs, stair core with its halls and
 * lift lobbies, the lift — is built elsewhere and never depends on these files.
 *
 * What a storey owns: everything inside the shell (x −54.65…34.65, z −21.65…21.65) on its level except the core
 * (CORE.stair / CORE.lift / CORE.liftLobby / CORE.hall in layout.ts): corridors, rooms, their walls, ceilings,
 * lights, doors, furniture, window linings. It must leave the core hall's opening in its corridor's south wall
 * (x HALL.x0 − 0.15 … HALL.x1 + 0.15 at z = 1.6…1.75) and, on storeys 1–4, the fire-escape door opening at
 * x = −54.65, z = 0 (the facility owns that leaf).
 */
export type StoreyContext = {
  /** Storey index 0..4. */
  storey: number
  /** Yields to the browser; call between rooms so no build chunk blocks a frame for long. */
  pause: () => Promise<void>
}

export type StoreyHandle = {
  /** Per-frame work (flickering panels etc.). */
  update?: (time: number) => void
  /** Cheap far-view stand-ins (child of the builder's group), shown while the storey's furniture is culled. */
  proxy?: THREE.Object3D | null
}

export type StoreyModule = { build(b: Builder, sc: StoreyContext): Promise<StoreyHandle> }
