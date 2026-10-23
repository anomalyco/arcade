import type { ForestFrameInput, ForestView } from "../../../packages/kit/forest/view"

declare const woods: { view: { forest: ForestView }; __input: ForestFrameInput }

/** Sample visible trunk cores and a deeper neighbour; depth rejects occluded trees and ground/near-branch edges. */
export async function depthProbe() {
  const f = woods.view.forest, renderer = f.renderer as unknown as { temporal: { prevLin: GPUTexture } }
  const device = f.renderer.passContext.device, tex = renderer.temporal.prevLin
  const row = Math.ceil(tex.width * 4 / 256) * 256
  const buffer = device.createBuffer({ size: row * tex.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
  const points: { x: number; y: number; bx: number; distance: number; depth: number; backgroundDepth: number }[] = []
  try {
    const enc = device.createCommandEncoder()
    enc.copyTextureToBuffer({ texture: tex }, { buffer, bytesPerRow: row }, [tex.width, tex.height])
    device.queue.submit([enc.finish()]); await buffer.mapAsync(GPUMapMode.READ)
    const depth = new Float32Array(buffer.getMappedRange()), vp = woods.__input.viewProj, eye = woods.__input.eye
    const project = (x: number, y: number, z: number) => {
      const c = [0, 1, 3].map(r => vp[r]! * x + vp[r + 4]! * y + vp[r + 8]! * z + vp[r + 12]!)
      return { x: Math.round((c[0]! / c[2]! * 0.5 + 0.5) * tex.width), y: Math.round((0.5 - c[1]! / c[2]! * 0.5) * tex.height), z: c[2]! }
    }
    const trunks = f.build.trunks
    for (let i = 0; i < trunks.length; i += 4) {
      const x = trunks[i]!, z = trunks[i + 1]!, radius = trunks[i + 2]!, top = trunks[i + 3]!
      const distance = Math.hypot(x - eye[0], z - eye[2])
      if (distance < 8 || distance > 100 || radius < 0.12) continue
      for (const h of [0, 1, 2, 4, 6]) {
        const y = eye[1] + h
        if (y > top - 3) continue
        const p = project(x, y, z)
        if (p.z <= 0 || p.x < 20 || p.x >= tex.width - 20 || p.y < 30 || p.y >= tex.height - 30) continue
        const centre = depth[p.y * row / 4 + p.x]!
        if (Math.abs(centre - p.z) > Math.max(0.6, radius * 2)) continue
        const dx = Math.max(3, Math.ceil(radius / p.z * tex.height / Math.tan(woods.__input.fovY / 2) * 1.7))
        for (const bx of [p.x - dx, p.x + dx]) {
          if (bx < 5 || bx >= tex.width - 5) continue
          const behind = depth[p.y * row / 4 + bx]!
          if (behind < centre + 3) continue
          points.push({ x: p.x, y: p.y, bx, distance, depth: centre, backgroundDepth: behind })
        }
      }
    }
    return { width: tex.width, height: tex.height, points }
  } finally { buffer.destroy() }
}
