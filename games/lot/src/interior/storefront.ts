/** Migrate the exterior export's dark entrance backing to real glass. Other facade bays stay backed.
 * Only the exact backing colour within the authored storefront is eligible; frames and door hardware stay opaque.
 * Newer exterior exports can supply transparent panes directly, in which case this is a no-op.
 */
export function splitStorefront(data: ArrayBuffer) {
  const bytes = new Uint8Array(data), view = new DataView(data)
  const solid = new Uint8Array(data.byteLength), glass = new Uint8Array(data.byteLength / 24 * 32)
  let ns = 0, ng = 0
  for (let offset = 0; offset < bytes.length; offset += 72) {
    const pane = [0, 24, 48].every(k => {
      const i = offset + k, x = view.getFloat32(i, true), y = view.getFloat32(i + 4, true), z = view.getFloat32(i + 8, true)
      return Math.abs(x) < 9 && y >= 0.15 && y <= 3.11 && z > 21 && z < 22.6 && bytes[i + 16] === 5 && bytes[i + 17] === 8 && bytes[i + 18] === 7
    })
    if (!pane) { solid.set(bytes.subarray(offset, offset + 72), ns); ns += 72; continue }
    for (const k of [0, 24, 48]) {
      glass.set(bytes.subarray(offset + k, offset + k + 24), ng)
      glass.set([145, 174, 164, 255], ng + 16)
      ng += 32
    }
  }
  return { solid: solid.buffer.slice(0, ns), glass: glass.buffer.slice(0, ng) }
}
