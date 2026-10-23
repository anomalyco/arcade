import { makeWorld, type WoodsWorld, type WorldParams } from "../../shared/world"
import { drawCompassAtlas } from "./compass-face"
import { printSheet } from "./print"

/**
 * The held map's offscreen drawing: the printed sheet, the compass markings atlas and the paper fibre normal map,
 * each returned as an ImageBitmap (level 0; the page uploads it and builds mips on the GPU) or, for automation, as a
 * PNG. Runs in `print.worker.ts`, or on the main thread if the worker dies.
 */

export type PrintRequest =
  | { id: number; kind: "print"; params: WorldParams; longSide: number; wear: ImageBitmap | null; png?: boolean }
  | { id: number; kind: "face"; scale: number; png?: boolean }
  | { id: number; kind: "fibre"; image: ImageBitmap; size: number }

export type PrintReply = {
  id: number
  bitmap?: ImageBitmap
  png?: Blob
  ms: number
  phases?: Record<string, number>
  error?: string
  /** The job never ran (the worker was stopped or died); the caller may ask again. */
  cancelled?: boolean
}

let world: { key: string; world: WoodsWorld } | null = null
const worldFor = (params: WorldParams) => {
  const key = JSON.stringify(params)
  if (world?.key !== key) world = { key, world: makeWorld(params) }
  return world.world
}

/** Paper fibre as a tangent-space normal map from the fibre photo's luminance. */
function fibreNormals(img: ImageBitmap, size: number): OffscreenCanvas {
  const c = new OffscreenCanvas(size, size)
  const g = c.getContext("2d")!
  g.drawImage(img, 0, 0, size, size)
  const src = g.getImageData(0, 0, size, size), out = g.createImageData(size, size)
  const lum = new Float32Array(size * size)
  for (let i = 0; i < lum.length; i++) lum[i] = (src.data[i * 4]! * 0.3 + src.data[i * 4 + 1]! * 0.59 + src.data[i * 4 + 2]! * 0.11) / 255
  const at = (x: number, y: number) => lum[((y + size) % size) * size + ((x + size) % size)]!
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = (at(x + 1, y) - at(x - 1, y)) * 6, dy = (at(x, y + 1) - at(x, y - 1)) * 6
    const l = Math.hypot(dx, dy, 1), o = (y * size + x) * 4
    out.data[o] = Math.round((-dx / l * 0.5 + 0.5) * 255); out.data[o + 1] = Math.round((-dy / l * 0.5 + 0.5) * 255); out.data[o + 2] = Math.round((1 / l * 0.5 + 0.5) * 255); out.data[o + 3] = 255
  }
  g.putImageData(out, 0, 0)
  return c
}

/** Runs one job; the reply's bitmap is transferable. */
export async function runJob(q: PrintRequest): Promise<PrintReply> {
  const t0 = performance.now()
  let canvas: OffscreenCanvas
  let phases: Record<string, number> | undefined
  if (q.kind === "print") {
    const r = printSheet(worldFor(q.params), q.longSide, { wear: q.wear })
    canvas = r.canvas
    phases = r.phases
    q.wear?.close()
  } else if (q.kind === "face") canvas = drawCompassAtlas(q.scale)
  else { canvas = fibreNormals(q.image, q.size); q.image.close() }
  const ms = performance.now() - t0
  if ("png" in q && q.png) {
    return { id: q.id, png: await canvas.convertToBlob({ type: "image/png" }), ms }
  }
  return { id: q.id, bitmap: canvas.transferToImageBitmap(), ms, ...(phases ? { phases } : {}) }
}
