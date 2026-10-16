import * as THREE from "three/webgpu"
import type { WorldContext, WorldModule } from "./context"
import { heightAt } from "./height"
import { material } from "../render/materials"

export function build(ctx: WorldContext): WorldModule | void {
  const geo = new THREE.PlaneGeometry(1400, 1400, 256, 256)
  geo.rotateX(-Math.PI / 2)
  const p = geo.attributes.position!
  for (let i = 0; i < p.count; i++) p.setY(i, heightAt(p.getX(i), p.getZ(i)))
  geo.computeVertexNormals()
  const mesh = new THREE.Mesh(geo, material("forest_floor"))
  mesh.receiveShadow = true
  ctx.scene.add(mesh)
}
