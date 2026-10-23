import { batchHooks } from "@arcade/kit/forest/shaders"
import { loadGltf } from "@arcade/kit/gpu/gltf"
import type { Renderer } from "@arcade/kit/gpu/renderer"
import { TexturedMeshPass } from "@arcade/kit/gpu/textured-mesh"
import { groundHeight, type WoodsWorld } from "../shared/world"

/** Small camp dressing on the production forest light/fog/exposure path. */
export class CampProps {
  private readonly data = new Float32Array(12)
  private constructor(private readonly renderer: Renderer, private readonly pass: TexturedMeshPass,
    private readonly asset: Awaited<ReturnType<typeof loadGltf>>) {}

  static async create(renderer: Renderer): Promise<CampProps> {
    const asset = await loadGltf(renderer.passContext.device, `${import.meta.env.BASE_URL}props/camp-cooler.glb`)
    try {
      const pass = new TexturedMeshPass(renderer.passContext,
        asset.primitives.map(p => ({ ...p, instances: new Float32Array(0) })), batchHooks)
      renderer.addPass("opaque", pass)
      return new CampProps(renderer, pass, asset)
    } catch (error) { asset.dispose(); throw error }
  }

  place(world: WoodsWorld, enabled: boolean) {
    // Beside the picnic table, away from the flare and battery pickup surface.
    const table = world.buildings.find(b => b.kind === "table")
    const x = table ? table.rect[2] + 0.55 : world.camp.x + 2
    const z = table ? (table.rect[1] + table.rect[3]) / 2 : world.camp.z + 2
    this.data.set([x, groundHeight(world, x, z), z, 0.25, 1, 1, 1, 1, 0, 0, 1, 0])
    this.pass.setAllInstances(this.data, enabled ? 1 : 0)
  }

  casters() { return this.pass.shadowCasters() }

  dispose() {
    this.renderer.removePass(this.pass)
    this.pass.dispose()
    this.asset.dispose()
  }
}
