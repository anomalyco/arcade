import * as THREE from "three/webgpu"
import { attribute, cameraPosition, float, length, max, positionLocal, uniform } from "three/tsl"
import { materialFor } from "../../render/materials"

// Overhead wires as thin tubes that never go sub-pixel: the vertex shader pushes each ring out from its centre line so
// the wire stays at least `MIN_PX` pixels wide however far away it is, which keeps the crisp dark silhouettes against
// the fog glow of the concept art instead of shimmering dashes. One mesh, one extra shader for the whole network.

const MIN_PX = 1.6
const SIDES = 4
const Y = new THREE.Vector3(0, 1, 0)

export class Wires {
  private pos: number[] = []
  private centre: number[] = []
  private uv: number[] = []
  private idx: number[] = []

  add(pts: readonly THREE.Vector3[], r: number) {
    const t = new THREE.Vector3()
    const side = new THREE.Vector3()
    const up = new THREE.Vector3()
    let along = 0
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]!
      t.subVectors(pts[Math.min(i + 1, pts.length - 1)]!, pts[Math.max(i - 1, 0)]!).normalize()
      side.crossVectors(t, Y)
      if (side.lengthSq() < 1e-6) side.set(1, 0, 0)
      side.normalize()
      up.crossVectors(side, t).normalize()
      if (i > 0) along += p.distanceTo(pts[i - 1]!)
      const base = this.pos.length / 3
      for (let k = 0; k < SIDES; k++) {
        const a = (k / SIDES) * Math.PI * 2
        const c = Math.cos(a) * r
        const s = Math.sin(a) * r
        this.pos.push(p.x + side.x * c + up.x * s, p.y + side.y * c + up.y * s, p.z + side.z * c + up.z * s)
        this.centre.push(p.x, p.y, p.z)
        this.uv.push(k / SIDES, along)
      }
      if (i > 0) {
        const prev = base - SIDES
        for (let k = 0; k < SIDES; k++) {
          const k1 = (k + 1) % SIDES
          this.idx.push(prev + k, base + k, prev + k1, prev + k1, base + k, base + k1)
        }
      }
    }
  }

  /** Builds the mesh; returns a per-frame update that keeps the pixel scale in step with the camera and canvas. */
  build(parent: THREE.Object3D, renderer: THREE.WebGPURenderer) {
    const g = new THREE.BufferGeometry()
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3))
    g.setAttribute("wireCentre", new THREE.Float32BufferAttribute(this.centre, 3))
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2))
    g.setIndex(this.idx)
    g.computeVertexNormals()
    g.computeBoundingSphere()

    // World radius of MIN_PX / 2 pixels at 1 m: tan(fov / 2) * MIN_PX / canvasHeight.
    const pxScale = uniform(0.001)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const centre = attribute("wireCentre", "vec3") as any
    const off = positionLocal.sub(centre)
    const grow = max(float(1), length(centre.sub(cameraPosition)).mul(pxScale).div(length(off)))
    const mat = materialFor("flat", { color: 0x050505, roughness: 0.55, metalness: 0.2 }).clone()
    mat.positionNode = centre.add(off.mul(grow))
    mat.name = "overhead_wire"

    const mesh = new THREE.Mesh(g, mat)
    mesh.name = "roads:wires"
    mesh.matrixAutoUpdate = false
    mesh.frustumCulled = false
    parent.add(mesh)

    const size = new THREE.Vector2()
    return (camera: THREE.PerspectiveCamera) => {
      renderer.getDrawingBufferSize(size)
      pxScale.value = (Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * MIN_PX) / Math.max(1, size.y)
    }
  }
}
