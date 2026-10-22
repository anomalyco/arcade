// Lot motion.ts's depth-reprojected four-texel range test, reduced to a 60-frame forest walk.
// Read back the presented colour and temporal linear depth in the SAME task as drawTo.
export async function motionProbe() {
  const w = (window as any).woods
  const renderer = w.view.forest.renderer, device: GPUDevice = renderer.passContext.device
  const canvas = document.querySelector<HTMLCanvasElement>("#view")!, ctx = canvas.getContext("webgpu")!
  const W = canvas.width, H = canvas.height, N = W * H, row = Math.ceil(W * 4 / 256) * 256
  const lin: GPUTexture = renderer.temporal.prevLin
  if (!lin || lin.width !== W || lin.height !== H) throw new Error("motion requires matching temporal depth")
  const colour = device.createBuffer({ size: row * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
  const depth = device.createBuffer({ size: row * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
  const L = [new Float32Array(N), new Float32Array(N)], D = [new Float32Array(N), new Float32Array(N)]
  const VP = [new Float64Array(16), new Float64Array(16)]
  const inverse = (m: Float64Array) => {
    const a = Array.from({ length: 4 }, (_, r) => Array.from({ length: 8 }, (_, c) => c < 4 ? m[c * 4 + r]! : +(c - 4 === r)))
    for (let i = 0; i < 4; i++) {
      let pivot = i
      for (let j = i + 1; j < 4; j++) if (Math.abs(a[j]![i]!) > Math.abs(a[pivot]![i]!)) pivot = j
      ;[a[i], a[pivot]] = [a[pivot]!, a[i]!]
      const v = a[i]![i]!
      for (let c = 0; c < 8; c++) a[i]![c]! /= v
      for (let r = 0; r < 4; r++) if (r !== i) { const f = a[r]![i]!; for (let c = 0; c < 8; c++) a[r]![c]! -= f * a[i]![c]! }
    }
    return Float64Array.from({ length: 16 }, (_, i) => a[i % 4]![4 + Math.floor(i / 4)]!)
  }
  const c = w.world.camp, start = { x: c.x + 8, z: c.z - 48 }
  w.debug.dark = w.state.players.slice(1).map((p: any) => p.id)
  w.camera.flashlight = true; w.state.players[0].light = true
  w.setPose(start.x, start.z, 0.15, -0.32)
  renderer.temporal.frameIndex = 0
  for (let i = 0; i < 120; i++) { w.__putTime(12); w.step(1000 / 60); await device.queue.onSubmittedWorkDone() }
  const frames: { pops: number; valid: number; flicker: number }[] = []
  try {
    for (let f = 0; f <= 60; f++) {
      // Continuous movement must not invoke setPose's camera-cut/exposure reset on every sample.
      w.session.teleport(start.x, start.z - 2.1 * f / 60)
      w.__putTime(12 + f / 60); w.step(1000 / 60)
      const tex = ctx.getCurrentTexture(), enc = device.createCommandEncoder()
      enc.copyTextureToBuffer({ texture: tex }, { buffer: colour, bytesPerRow: row }, [W, H])
      enc.copyTextureToBuffer({ texture: lin }, { buffer: depth, bytesPerRow: row }, [W, H])
      device.queue.submit([enc.finish()])
      await Promise.all([colour.mapAsync(GPUMapMode.READ), depth.mapAsync(GPUMapMode.READ)])
      const bytes = new Uint8Array(colour.getMappedRange()), dep = new Float32Array(depth.getMappedRange())
      const k = f % 2, cur = L[k]!, prev = L[1 - k]!, dc = D[k]!, dp = D[1 - k]!
      const bgra = tex.format.startsWith("bgra")
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x, b = y * row + 4 * x
        cur[i] = 0.2126 * bytes[b + (bgra ? 2 : 0)]! + 0.7152 * bytes[b + 1]! + 0.0722 * bytes[b + (bgra ? 0 : 2)]!
        dc[i] = dep[y * row / 4 + x]!
      }
      colour.unmap(); depth.unmap()
      VP[k]!.set(w.__input.viewProj)
      if (!f) continue
      const v = VP[k]!, iv = inverse(v), pv = VP[1 - k]!, eye = w.__input.eye
      let pops = 0, valid = 0, sum = 0
      for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
        const i = y * W + x, z = dc[i]!
        if (!(z > 0) || z > 1000) continue
        const nx = (x + 0.5) / W * 2 - 1, ny = 1 - (y + 0.5) / H * 2
        const hw = iv[3]! * nx + iv[7]! * ny + iv[11]! * 0.5 + iv[15]!
        const rx = (iv[0]! * nx + iv[4]! * ny + iv[8]! * 0.5 + iv[12]!) / hw - eye[0]
        const ry = (iv[1]! * nx + iv[5]! * ny + iv[9]! * 0.5 + iv[13]!) / hw - eye[1]
        const rz = (iv[2]! * nx + iv[6]! * ny + iv[10]! * 0.5 + iv[14]!) / hw - eye[2]
        const t = z / (v[3]! * rx + v[7]! * ry + v[11]! * rz)
        const wx = eye[0] + rx * t, wy = eye[1] + ry * t, wz = eye[2] + rz * t
        const pw = pv[3]! * wx + pv[7]! * wy + pv[11]! * wz + pv[15]!
        const qx = ((pv[0]! * wx + pv[4]! * wy + pv[8]! * wz + pv[12]!) / pw * 0.5 + 0.5) * W - 0.5
        const qy = (0.5 - (pv[1]! * wx + pv[5]! * wy + pv[9]! * wz + pv[13]!) / pw * 0.5) * H - 0.5
        if (qx < 1 || qy < 1 || qx >= W - 2 || qy >= H - 2 || pw <= 0) continue
        const old = dp[Math.round(qy) * W + Math.round(qx)]!
        if (!(old > 0) || Math.abs(old - pw) > 0.03 * pw + 0.05) continue
        const a = Math.floor(qy) * W + Math.floor(qx)
        const lo = Math.min(prev[a]!, prev[a + 1]!, prev[a + W]!, prev[a + W + 1]!)
        const hi = Math.max(prev[a]!, prev[a + 1]!, prev[a + W]!, prev[a + W + 1]!)
        const diff = Math.max(0, cur[i]! - hi, lo - cur[i]!)
        valid++; sum += diff; if (diff >= 12) pops++
      }
      if (valid < N * 0.4) throw new Error(`insufficient reprojection coverage: ${valid / N}`)
      frames.push({ pops, valid: valid / N, flicker: sum / valid })
    }
  } finally { colour.destroy(); depth.destroy() }
  return { frames, popsPerFrame: frames.reduce((s, f) => s + f.pops, 0) / frames.length, flicker: frames.reduce((s, f) => s + f.flicker, 0) / frames.length }
}
