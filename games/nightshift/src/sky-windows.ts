import { Mesh, hex } from "@arcade/kit/gpu/mesh"
import { box } from "./world"

/** Opt-in geometry openings leave Today's shader and uploaded world byte-identical. */
export function skyWindowGeometry(data: ArrayBuffer): ArrayBuffer {
  const input = new Uint8Array(data), view = new DataView(data), kept: Uint8Array[] = []
  for (let offset = 0; offset < data.byteLength; offset += 72) {
    let wall = true, glass = true
    for (let v = 0; v < 3; v++) {
      const p = offset + v * 24, x = view.getFloat32(p, true), kind = view.getUint16(p + 22, true)
      wall &&= Math.abs(x + 4) < .1 && kind === 0
      glass &&= x < -3.8 && kind === 0x4a80 // IEEE binary16 surface tag 13.
    }
    if (!wall && !glass) kept.push(input.subarray(offset, offset + 72))
  }
  const m = new Mesh(), colour = hex(0x6b766c)
  // Continuous sill/header, then the piers between the four existing blind bays.
  box(m, -4, 0, 0, .18, .87, 18, colour)
  box(m, -4, 2.65, 0, .18, .35, 18, colour)
  let end = -9
  for (const z of [-7, -4, 0, 4]) {
    const start = z - 1.2
    box(m, -4, .87, (end + start) / 2, .18, 1.78, start - end, colour)
    end = z + 1.2
  }
  box(m, -4, .87, (end + 9) / 2, .18, 1.78, 9 - end, colour)
  const piers = new Uint8Array(m.pack()), result = new Uint8Array(kept.length * 72 + piers.length)
  kept.forEach((triangle, i) => result.set(triangle, i * 72))
  result.set(piers, kept.length * 72)
  return result.buffer
}
