import * as THREE from "three/webgpu"
import { pass } from "three/tsl"
import { bloom } from "three/addons/tsl/display/BloomNode.js"
import type { WorldContext } from "../world/context"

// Placeholder post chain: scene pass + bloom. Replaced by the full pipeline (SSR, AO, in-scattering, TRAA, grain).

export function createPost(ctx: WorldContext) {
  const pipeline = new THREE.RenderPipeline(ctx.renderer)
  const scene = pass(ctx.scene, ctx.camera)
  const color = scene.getTextureNode("output")
  pipeline.outputNode = color.add(bloom(color, 0.6, 0.4, 0.8))
  return {
    render() {
      pipeline.render()
    },
  }
}
