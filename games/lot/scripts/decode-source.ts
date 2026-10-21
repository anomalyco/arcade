import { createRequire } from "node:module"

/** Build-time decoding of the source's CC0 KTX2 assets with its Apache-2.0 transcoder. */
export async function sourceDecoder(source: string) {
  const path = `${source}/public/textures/basis/`
  const module = { exports: {} as any }
  new Function("module", "exports", "require", "__dirname", await Bun.file(path + "basis_transcoder.js").text())(
    module, module.exports, createRequire(import.meta.url), path,
  )
  const basis = await module.exports({ wasmBinary: await Bun.file(path + "basis_transcoder.wasm").arrayBuffer() })
  basis.initializeBasis()
  return (bytes: Uint8Array) => {
    const file = new basis.KTX2File(bytes)
    try {
      if (!file.isValid() || !file.startTranscoding()) throw new Error("Invalid source KTX2")
      const width = file.getWidth(), height = file.getHeight()
      const data = new Uint8Array(file.getImageTranscodedSizeInBytes(0, 0, 0, 13))
      if (!file.transcodeImage(data, 0, 0, 0, 13, 0, -1, -1)) throw new Error("KTX2 RGBA decode failed")
      return { width, height, data }
    } finally { file.close(); file.delete() }
  }
}

export async function png(data: Uint8Array, width: number, height: number) {
  const process = Bun.spawn(["magick", "-size", `${width}x${height}`, "-depth", "8", "rgba:-", "png:-"], { stdin: data, stdout: "pipe", stderr: "pipe" })
  const bytes = await new Response(process.stdout).arrayBuffer()
  if (await process.exited) throw new Error(await new Response(process.stderr).text())
  return new Uint8Array(bytes)
}
