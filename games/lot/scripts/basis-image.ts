import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"

/** Offline only: the source textures pack colour/roughness and normal/AO into Basis images. */
export async function basisDecoder(source: string) {
  const dir = `${source}/public/textures/basis`
  const module = { exports: undefined as any }
  new Function("module", "exports", "require", "__dirname", await readFile(`${dir}/basis_transcoder.js`, "utf8"))(module, {}, createRequire(import.meta.url), dir)
  const basis = await module.exports({ wasmBinary: await readFile(`${dir}/basis_transcoder.wasm`) })
  basis.initializeBasis()
  return (bytes: Uint8Array) => {
    const f = new basis.KTX2File(bytes)
    try {
      if (!f.isValid() || !f.startTranscoding()) throw Error("Invalid KTX2")
      const width = f.getWidth(), height = f.getHeight()
      const data = new Uint8Array(f.getImageTranscodedSizeInBytes(0, 0, 0, 13))
      if (!f.transcodeImage(data, 0, 0, 0, 13, 0, -1, -1)) throw Error("Basis RGBA decode failed")
      return { data, width, height }
    } finally { f.close(); f.delete() }
  }
}

export async function png(data: Uint8Array, width: number, height: number) {
  const p = Bun.spawn(["magick", "-size", `${width}x${height}`, "-depth", "8", "rgba:-", "png:-"], { stdin: data, stdout: "pipe", stderr: "pipe" })
  const bytes = new Uint8Array(await new Response(p.stdout).arrayBuffer())
  if (await p.exited) throw Error(await new Response(p.stderr).text())
  return bytes
}
