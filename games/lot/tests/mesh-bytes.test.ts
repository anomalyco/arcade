import { expect, test } from "bun:test"
import { meshBytes } from "../src/mesh-bytes"

test("loads the same mesh from verbatim gzip and HTTP-decoded gzip responses", async () => {
  const mesh = new Float32Array([1.25, -10, 128, 0, 1, 0])
  const gz = Bun.gzipSync(new Uint8Array(mesh.buffer))
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req => new Response(gz, {
    headers: new URL(req.url).pathname === "/encoded" ? { "Content-Encoding": "gzip" } : {},
  }) })
  try {
    for (const path of ["/verbatim", "/encoded"]) {
      const response = await fetch(`http://127.0.0.1:${server.port}${path}`)
      expect(new Float32Array(await meshBytes(response))).toEqual(mesh)
    }
    await expect(meshBytes(new Response("missing", { status: 404 }))).rejects.toThrow("404")
    await expect(meshBytes(new Response(gz.slice(0, 10)))).rejects.toThrow()
  } finally { server.stop(true) }
})
