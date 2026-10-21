import { imageTexture } from "../gltf"
import { ROOM_ATLAS } from "./rooms-atlas"

export { ROOM_ATLAS }

/**
 * The interior-mapping room atlas: 8 rooms of a 1980s research facility at night (2 variants each), painted by
 * `scripts/textures/paint-rooms.ts` (our own CPU ray tracer, so the image set is licence-clean). Bind it as the base
 * texture of an `interiorWindowHooks` pass. Kinds index `ROOM_ATLAS.kinds`.
 */
export type RoomKind = (typeof ROOM_ATLAS.kinds)[number]

export const roomKindIndex = (kind: RoomKind): number => ROOM_ATLAS.kinds.indexOf(kind)

/** Vertex aux for a window pane: room kind and brightness (< 4) in one f16-safe number. */
export const windowAux = (kind: RoomKind, brightness: number): number => roomKindIndex(kind) * 4 + Math.max(0, Math.min(3.99, brightness))

export const roomAtlasUrl = (): string => new URL("./rooms.webp", import.meta.url).href

export async function loadRoomAtlas(device: GPUDevice, url = roomAtlasUrl()): Promise<GPUTexture> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Room atlas: ${response.status}`)
  return imageTexture(device, new Uint8Array(await response.arrayBuffer()), true, "image/webp")
}
