import { DataTexture, FloatType, RGBAFormat, type Light } from "three/webgpu"
import { Break, Fn, If, Loop, clamp, directPointLight, dot, float, int, ivec2, log, positionView, positionWorld, screenCoordinate, smoothstep, textureLoad, uniform, vec4 } from "three/tsl"
import { Vector2 } from "three/webgpu"
import { insideNode } from "./volumes"
import { ClusteredLighting } from "three/addons/lighting/ClusteredLighting.js"
import ClusteredLightsNode from "three/addons/tsl/lighting/ClusteredLightsNode.js"

// Forward+ clustered lighting with a spot cone per light. three's ClusteredLightsNode only shades omni point lights;
// sodium heads, fluorescent panels and window spills are directional, so every point light may carry
// `userData.cone = { dir: [x, y, z] (world, unit), cosOuter, cosInner }` and the shading loop applies the cone.
// Extra rows in the light data texture hold it (row 2: dir + cos outer, row 3: cos inner + mask, row 4: spill).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any

export type Cone = { dir: readonly [number, number, number]; cosOuter: number; cosInner: number }
/**
 * Where a light may shade (`userData.mask`): mode 0 anywhere, 1 only inside interior volumes, 2 only outside them,
 * clipped to world heights [y0, y1] (an interior lamp's own storey, so it can't light the floor above or below).
 */
export type LightMask = { mode: 0 | 1 | 2; y0: number; y1: number }

const Base = ClusteredLightsNode as unknown as new (...args: number[]) => N

class ConeClusteredLightsNode extends Base {
  constructor(maxLights: number, tileSize: number, zSlices: number, maxLightsPerCluster: number) {
    super(maxLights, tileSize, zSlices, maxLightsPerCluster)
    const self = this as N
    self._lightsTexture.dispose()
    self._lightsTexture = new DataTexture(new Float32Array(maxLights * 4 * 5), maxLights, 5, RGBAFormat, FloatType)
  }

  create(width: number, height: number) {
    const self = this as N
    super.create(width, height)
    // three r186 passes the Int32Array itself as the storage node's element count, and every shader build then
    // evaluates `bufferCount > 0`, coercing the ~1.7 M-int light-index array to a string: ~0.6 s of the first frame.
    // The node only needs a number here (it is never sized into WGSL for storage buffers).
    const idx = self._lightIndexes
    if (idx && typeof idx.bufferCount !== "number") idx.bufferCount = idx.value.count
    // The cluster grid spans the drawing buffer, but the scene pass renders at a reduced internal resolution
    // (TAAU), and fragments index the grid with `screenCoordinate` in render-target pixels. Unscaled, every pixel
    // read a cluster covering a different part of the frustum and lamps dropped out in hard, tile-aligned
    // rectangles (the "dark translucent slab"). Map fragment coordinates into drawing-buffer pixels first.
    const NX = Math.floor(self.getBufferFitSize(width) / self.tileSize)
    const NY = Math.floor(self.getBufferFitSize(height) / self.tileSize)
    const NZ = self.zSlices
    const tile = (screenCoordinate as N).mul(this._toGrid).div(self.tileSize).floor()
    const viewDepth = (positionView as N).z.negate()
    const slice = log(viewDepth.div(self._cameraNear)).mul(float(1).div(log(self._cameraFar.div(self._cameraNear)))).mul(NZ)
    const z = (clamp as N)(slice.floor(), 0, NZ - 1)
    const tx = (clamp as N)(tile.x, 0, NX - 1)
    const ty = (clamp as N)(tile.y, 0, NY - 1)
    self._screenClusterIndex = int(tx).add(int(ty).mul(NX)).add(int(z).mul(NX * NY)).toVar()
  }

  /** Drawing-buffer pixels per render-target pixel of the pass being shaded. */
  _toGrid = uniform(new Vector2(1, 1))
  private _db = new Vector2()

  updateBefore(frame: N) {
    super.updateBefore(frame)
    const r = frame.renderer
    const rt = r.getRenderTarget()
    r.getDrawingBufferSize(this._db)
    if (rt && rt.width > 0 && rt.height > 0) this._toGrid.value.set(this._db.x / rt.width, this._db.y / rt.height)
    else this._toGrid.value.set(1, 1)
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
      const mask = lights[order[i]!]!.userData.mask as LightMask | undefined
      data[line * 3 + o + 1] = mask?.mode ?? 0
      data[line * 3 + o + 2] = mask?.y0 ?? -1e5
      data[line * 3 + o + 3] = mask?.y1 ?? 1e5
      data[line * 4 + o] = (lights[order[i]!]!.userData.spill as number | undefined) ?? 0
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
      // Per-fragment interior membership, shared by every light: walls are hard boundaries for lamp light.
      const pw = positionWorld as N
      const ins = insideNode(pw, 0.1).toVar()
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
          const row3 = textureLoad(self._lightsTexture, ivec2(idx, 3)) as N
          const ci = row3.x
          const mode = row3.y
          const zoneW = mode.greaterThan(1.5).select(ins.oneMinus(), mode.greaterThan(0.5).select(ins, 1))
          const yW = (smoothstep as N)(row3.z.sub(0.08), row3.z.add(0.02), pw.y).mul((smoothstep as N)(row3.w.add(0.08), row3.w.sub(0.02), pw.y))
          const dirView = self._cameraViewMatrix.mul(vec4(c.xyz, 0)).xyz
          const cosA = dot(lightVector.normalize().negate(), dirView)
          // Spill: real fixtures throw some light outside their cone, and in a room the pool bounces off the floor
          // onto the walls; a small per-light floor on the cone stands in for both.
          const spill = (textureLoad(self._lightsTexture, ivec2(idx, 4)) as N).x
          const cone = (smoothstep as N)(c.w, ci, cosA).mul(spill.oneMinus()).add(spill).mul(zoneW).mul(yW)
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
