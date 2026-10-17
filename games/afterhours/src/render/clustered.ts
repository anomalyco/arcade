import { DataTexture, FloatType, RGBAFormat, type Light } from "three/webgpu"
import { Break, Fn, If, Loop, directPointLight, dot, int, ivec2, smoothstep, textureLoad, vec4, positionView } from "three/tsl"
import { ClusteredLighting } from "three/addons/lighting/ClusteredLighting.js"
import ClusteredLightsNode from "three/addons/tsl/lighting/ClusteredLightsNode.js"

// Forward+ clustered lighting with a spot cone per light. three's ClusteredLightsNode only shades omni point lights;
// sodium heads, fluorescent panels and window spills are directional, so every point light may carry
// `userData.cone = { dir: [x, y, z] (world, unit), cosOuter, cosInner }` and the shading loop applies the cone.
// Two extra rows in the light data texture hold it (row 2: dir + cos outer, row 3: cos inner).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any

export type Cone = { dir: readonly [number, number, number]; cosOuter: number; cosInner: number }

const Base = ClusteredLightsNode as unknown as new (...args: number[]) => N

class ConeClusteredLightsNode extends Base {
  constructor(maxLights: number, tileSize: number, zSlices: number, maxLightsPerCluster: number) {
    super(maxLights, tileSize, zSlices, maxLightsPerCluster)
    const self = this as N
    self._lightsTexture.dispose()
    self._lightsTexture = new DataTexture(new Float32Array(maxLights * 4 * 4), maxLights, 4, RGBAFormat, FloatType)
  }

  create(width: number, height: number) {
    const self = this as N
    super.create(width, height)
    // three r186 passes the Int32Array itself as the storage node's element count, and every shader build then
    // evaluates `bufferCount > 0`, coercing the ~1.7 M-int light-index array to a string: ~0.6 s of the first frame.
    // The node only needs a number here (it is never sized into WGSL for storage buffers).
    const idx = self._lightIndexes
    if (idx && typeof idx.bufferCount !== "number") idx.bufferCount = idx.value.count
  }

  updateLightsTexture(camera: N) {
    const self = this as N
    super.updateLightsTexture(camera)
    const data = self._lightsTexture.image.data as Float32Array
    const line = self._lightsTexture.image.width * 4
    const order = self._lightSortOrder as number[]
    const lights = self.clusteredLights as Light[]
    for (let i = 0; i < lights.length; i++) {
      const cone = lights[order[i]!]!.userData.cone as Cone | undefined
      const o = i * 4
      data[line * 2 + o] = cone?.dir[0] ?? 0
      data[line * 2 + o + 1] = cone?.dir[1] ?? -1
      data[line * 2 + o + 2] = cone?.dir[2] ?? 0
      data[line * 2 + o + 3] = cone ? cone.cosOuter : -3
      data[line * 3 + o] = cone ? cone.cosInner : -2
    }
  }

  setupLights(builder: N, lightNodes: N) {
    const self = this as N
    self.updateProgram(builder.renderer)
    const lightingModel = builder.context.reflectedLight
    lightingModel.directDiffuse.toStack()
    lightingModel.directSpecular.toStack()
    // LightsNode.setupLights (skipping ClusteredLightsNode's own loop, which we replace).
    Object.getPrototypeOf(ClusteredLightsNode.prototype).setupLights.call(this, builder, lightNodes)

    ;(Fn as N)(() => {
      ;(Loop as N)(self.maxLightsPerCluster, ({ i }: N) => {
        const lightIndex = self.getTile(i)
        ;(If as N)(lightIndex.equal(int(0)), () => {
          Break()
        })
        const idx = int(lightIndex.sub(1))
        const { color, decay, viewPosition, distance } = self.getLightData(idx)
        const lightVector = viewPosition.sub(positionView)
        ;(If as N)(dot(lightVector, lightVector).lessThanEqual(distance.mul(distance)), () => {
          const c = textureLoad(self._lightsTexture, ivec2(idx, 2)) as N
          const ci = (textureLoad(self._lightsTexture, ivec2(idx, 3)) as N).x
          const dirView = self._cameraViewMatrix.mul(vec4(c.xyz, 0)).xyz
          const cosA = dot(lightVector.normalize().negate(), dirView)
          const cone = (smoothstep as N)(c.w, ci, cosA)
          builder.lightsNode.setupDirectLight(
            builder,
            this,
            directPointLight({ color: color.mul(cone), lightVector, cutoffDistance: distance, decayExponent: decay } as N),
          )
        })
      })
    }, "void")()
  }
}

export class ConeClusteredLighting extends ClusteredLighting {
  override createNode(lights: Light[] = []) {
    const self = this as N
    return new ConeClusteredLightsNode(self.maxLights, self.tileSize, self.zSlices, self.maxLightsPerCluster).setLights(lights)
  }
}
