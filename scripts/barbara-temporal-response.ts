// GPU regression fixture, executed in the production game's page on its WebGPU device.
// Uses the actual Temporal constructor and shader, not a CPU copy of the algorithm.
export async function temporalResponseProbe() {
  const renderer = (window as any).woods.view.forest.renderer
  const source = renderer.temporal
  const device: GPUDevice = renderer.passContext.device
  const temporal = new source.constructor(device, "rgba16float", 1)
  const W = 32, H = 16, row = 256
  temporal.resize(W, H, W, H)
  const input = device.createTexture({ size: [W, H], format: "rgba32float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
  const depth = device.createTexture({ size: [W, H], format: "depth32float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT })
  const buffer = device.createBuffer({ size: row * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
  const iv = input.createView(), dv = depth.createView()
  const frame = new Float32Array(20)
  frame[0] = frame[5] = frame[10] = frame[15] = 1
  const settings = { ...renderer.getTemporal(), mode: "taa", renderScale: 1, sharpen: 0 }
  const half = (x: number) => {
    const sign = x & 0x8000 ? -1 : 1, exponent = (x >> 10) & 31, mantissa = x & 1023
    return sign * (exponent ? (1 + mantissa / 1024) * 2 ** (exponent - 15) : mantissa * 2 ** -24)
  }
  const draw = async (color: (x: number) => number, alpha = -2, rejectDepth = false) => {
    const pixels = new Float32Array(W * H * 4)
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4, v = color(x)
      pixels.set([v, v * 0.7, v * 0.3, alpha], i)
    }
    device.queue.writeTexture({ texture: input }, pixels, { bytesPerRow: W * 16 }, [W, H])
    temporal.begin(frame, settings, false)
    const enc = device.createCommandEncoder()
    enc.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view: dv, depthLoadOp: "clear", depthStoreOp: "store", depthClearValue: 0.5 } }).end()
    if (rejectDepth) enc.beginRenderPass({ colorAttachments: [{ view: temporal.prevLinView, loadOp: "clear", storeOp: "store", clearValue: [999, 0, 0, 1] }] }).end()
    temporal.encode(enc, iv, dv, false)
    enc.copyTextureToBuffer({ texture: temporal.output }, { buffer, bytesPerRow: row }, [W, H])
    device.queue.submit([enc.finish()])
    await buffer.mapAsync(GPUMapMode.READ)
    const result = Array.from(new Uint16Array(buffer.getMappedRange()), half)
    buffer.unmap()
    return result
  }
  const maxError = (pixels: number[], color: number, alpha: number, from = 2, to = W - 2) => {
    let rgb = 0, a = 0
    for (let y = 2; y < H - 2; y++) for (let x = from; x < to; x++) {
      const i = y * row / 2 + x * 4
      rgb = Math.max(rgb, Math.abs(pixels[i]! - color), Math.abs(pixels[i + 1]! - color * 0.7), Math.abs(pixels[i + 2]! - color * 0.3))
      a = Math.max(a, Math.abs(pixels[i + 3]! - alpha))
    }
    return { rgb, alpha: a }
  }
  const require = (ok: boolean, message: string) => { if (!ok) throw new Error(message) }
  try {
    for (let i = 0; i < 24; i++) await draw(() => 4)
    const off = maxError(await draw(() => 0.01), 0.01, -2)
    const on = maxError(await draw(() => 4, 5), 4, 5)
    require(off.rgb < 0.001 && off.alpha === 0, "light off left stale history or lost signed alpha")
    require(on.rgb < 0.01 && on.alpha === 0, "light on retained darkness or clamped tagged alpha")
    for (let i = 0; i < 24; i++) await draw(x => x === 8 ? 4 : 0.01)
    const shifted = await draw(x => x === 24 ? 4 : 0.01)
    const trail = maxError(shifted, 0.01, -2, 3, 20)
    require(trail.rgb < 0.001, "moving edge left history outside the current 3×3 neighborhood")
    // The old bright side is within the new neighborhood's range: only depth
    // rejection should remove it. Compare against a cold resolve at the same jitter.
    const phase = temporal.frameIndex
    const pattern = (x: number) => x % 2 ? 4 : 0.01
    const rejected = await draw(pattern, -2, true)
    temporal.reset(); temporal.frameIndex = phase
    const cold = await draw(pattern)
    const depthError = Math.max(...cold.map((v, i) => Math.abs(v - rejected[i]!)))
    require(depthError < 0.001, "depth-rejected history differs from a cold resolve")
    return { fixture: "production Temporal, 32×16 HDR, 24 settling frames; errors in linear HDR", offFirstFrame: off, onFirstFrame: on, shiftedEdgeOutsideNeighborhood: trail, depthRejectVsCold: depthError }
  } finally {
    input.destroy(); depth.destroy(); buffer.destroy()
    for (const t of [...temporal.history, temporal.output, temporal.prevLin, temporal.reactive]) t.destroy()
    temporal.uniformBuf.destroy()
  }
}
