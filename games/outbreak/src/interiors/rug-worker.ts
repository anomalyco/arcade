import { bakeInteriorTiles } from "@arcade/kit/textures/interior-tiles"
import { bakeRug, buildRugMips, type RugSpec } from "@arcade/kit/textures/rug"

export type RugWorkerRequest =
  | { id: number; kind: "rug"; spec: RugSpec; size: number }
  | { id: number; kind: "tiles"; size: number }
  /** A hand-painted texture from the material manifest, resized to the rug layer. */
  | { id: number; kind: "image"; url: string; size: number }

export type RugWorkerResponse = { id: number; mips: ArrayBuffer[]; ms: number; error?: string }

const ctx = self as unknown as {
  onmessage: ((ev: MessageEvent<RugWorkerRequest>) => void) | null
  postMessage: (message: RugWorkerResponse, transfer: Transferable[]) => void
}

async function bakeImage(url: string, size: number): Promise<Uint8Array[]> {
  const res = await fetch(url)
  const bitmap = await createImageBitmap(await res.blob(), { resizeWidth: size, resizeHeight: size, resizeQuality: "high" })
  const canvas = new OffscreenCanvas(size, size)
  const g = canvas.getContext("2d")!
  g.drawImage(bitmap, 0, 0)
  const data = new Uint8Array(g.getImageData(0, 0, size, size).data.buffer)
  // Hand-painted rugs have no pile map: use a flat, slightly noisy height so the shader keeps them opaque.
  for (let i = 3; i < data.length; i += 4) data[i] = 190 + ((i * 2654435761) >>> 28)
  return buildRugMips(data, size)
}

ctx.onmessage = ev => {
  const req = ev.data
  const t0 = performance.now()
  const done = (mips: Uint8Array[]) => {
    const buffers = mips.map(m => (m.byteOffset === 0 && m.byteLength === m.buffer.byteLength ? m.buffer : m.slice().buffer) as ArrayBuffer)
    ctx.postMessage({ id: req.id, mips: buffers, ms: performance.now() - t0 }, buffers)
  }
  try {
    if (req.kind === "rug") done(bakeRug(req.spec, req.size).mips)
    else if (req.kind === "tiles") done(bakeInteriorTiles(req.size))
    else void bakeImage(req.url, req.size).then(done, e => ctx.postMessage({ id: req.id, mips: [], ms: 0, error: String(e) }, []))
  } catch (e) {
    ctx.postMessage({ id: req.id, mips: [], ms: 0, error: String(e) }, [])
  }
}
