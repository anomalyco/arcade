import type { Placement } from "./types"

/** Place a cached, metre-scale static prop; textures and materials remain shared between every instance. */
export function placeVertices(vertices: ArrayBuffer, p: Placement): ArrayBuffer {
  const result = vertices.slice(0), d = new DataView(result)
  const c = Math.cos(p.yaw ?? 0), s = Math.sin(p.yaw ?? 0), scale = p.scale ?? 1
  for (let i=0;i<result.byteLength;i+=32) {
    const x=d.getFloat32(i,true),y=d.getFloat32(i+4,true),z=d.getFloat32(i+8,true)
    d.setFloat32(i,p.position[0]+scale*(x*c+z*s),true)
    d.setFloat32(i+4,p.position[1]+scale*y,true)
    d.setFloat32(i+8,p.position[2]+scale*(-x*s+z*c),true)
    const nx=d.getInt8(i+12),nz=d.getInt8(i+14)
    d.setInt8(i+12,Math.max(-127,Math.min(127,Math.round(nx*c+nz*s))))
    d.setInt8(i+14,Math.max(-127,Math.min(127,Math.round(-nx*s+nz*c))))
  }
  return result
}
