/** Fetch already decodes Content-Encoding. Static hosts may instead send the .gz file verbatim. */
export async function meshBytes(response: Response): Promise<ArrayBuffer> {
  if (!response.ok) throw new Error(`${response.url}: ${response.status}`)
  const bytes = await response.arrayBuffer()
  const magic = new Uint8Array(bytes, 0, Math.min(3, bytes.byteLength))
  if (magic[0] !== 0x1f || magic[1] !== 0x8b || magic[2] !== 8) return bytes
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer()
}
